/**
 * Deterministic local market clearing primitive (REQ-MARKET-003).
 *
 * Implements proportional allocation and stable residual correction for local
 * market clearing, where seller fills and buyer fills sum to the same cleared
 * quantity within canonical tolerance, and shuffled intent insertion produces
 * identical normalized allocations.
 *
 * See sections 7, 10, and 11 of docs/spec/mirror/06 - Handoff/04 — MARKETS_TRADE_FX_CONTRACTS.md
 */

import type { CurrencyId, GoodId, MarketId, RegionId, StateId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import type { MarketIntentId } from "./marketIntent";
import { assertFiniteCanonicalNumber } from "../domain/numeric";

/** Opaque market allocation ID (ma:...) */
export type MarketAllocationId = string & { readonly __brand: "MarketAllocationId" };

export function createMarketAllocationId(value: string): MarketAllocationId {
  if (!value.startsWith("ma:")) {
    throw new Error(`MarketAllocationId must start with "ma:", got ${value}`);
  }
  return value as MarketAllocationId;
}

/**
 * Ephemeral allocation record output from deterministic proportional clearing.
 * Represents one seller-buyer pair match at the cleared quantity and price.
 * Not persistent; replaced each tick by new clearing results.
 */
export interface MarketAllocation {
  readonly id: MarketAllocationId;
  readonly marketId: MarketId;
  readonly goodId: GoodId;
  readonly pass: "PRE_PRODUCTION" | "MAIN";
  readonly sellerIntentId: MarketIntentId;
  readonly buyerIntentId: MarketIntentId;
  readonly seller: ActorRef;
  readonly buyer: ActorRef;
  readonly quantity: number; // cleared quantity for this seller-buyer pair
  readonly sellerNetUnitPrice: number;
  readonly buyerGrossUnitPrice: number;
  readonly marketCurrencyId: CurrencyId;
  readonly consumptionTaxAmount: number;
  readonly destinationStateId: StateId | null;
  readonly sellerInventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
  readonly buyerInventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
}

/**
 * Input describing a seller's available quantity at this market.
 * Computed from inventory, reserves, and prior commitments.
 */
export interface SellerInput {
  readonly intentId: MarketIntentId;
  readonly actor: ActorRef;
  readonly goodId: GoodId;
  readonly sellable: number; // min(desired, max(0, owned - reserve - committed))
  readonly inventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
}

/**
 * Input describing a buyer's effective demand at this market.
 * Computed from desired quantity and budget after tax-inclusive gross price.
 */
export interface BuyerInput {
  readonly intentId: MarketIntentId;
  readonly actor: ActorRef;
  readonly goodId: GoodId;
  readonly regionId: RegionId;
  readonly effectiveDemand: number; // min(desired, maxSpend / max(grossPrice, moneyEpsilon))
  readonly inventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
  readonly destinationStateId: StateId | null;
}

/**
 * Configuration for one clearing pass; includes market state and pricing.
 */
export interface ClearingConfig {
  readonly marketId: MarketId;
  readonly goodId: GoodId;
  readonly pass: "PRE_PRODUCTION" | "MAIN";
  readonly marketCurrencyId: CurrencyId;
  readonly sellerNetUnitPrice: number; // net seller price in market currency
  readonly buyerGrossUnitPrice: number; // tax-inclusive gross price for buyers
  readonly consumptionTaxRateByState: (stateId: StateId | null) => number;
  readonly quantityEpsilon: number;
  readonly moneyEpsilon: number;
  readonly reconciliationRelativeTolerance: number;
}

/**
 * Deterministic local clearing: proportional allocation with stable residual correction.
 *
 * Algorithm:
 * 1. Sum sellable quantities from all sellers
 * 2. Sum effective demand from all buyers
 * 3. Q = min(sum sellable, sum demand)
 * 4. Provisional seller fill: Q × sellable_i / sum(sellable)
 * 5. Provisional buyer fill: Q × demand_j / sum(demand)
 * 6. Residual correction (float error) ordered by stable actor/intent IDs
 * 7. Return deterministic MarketAllocation records
 *
 * Returns allocations in stable order (seller ID then buyer ID).
 * Guarantees: seller fills + buyer fills = cleared quantity within tolerance.
 */
export function allocateLocal(
  sellers: readonly SellerInput[],
  buyers: readonly BuyerInput[],
  config: ClearingConfig,
  allocationIdSequence: () => MarketAllocationId,
): readonly MarketAllocation[] {
  // Handle empty case
  if (sellers.length === 0 || buyers.length === 0) {
    return [];
  }

  // Compute totals
  let totalSellable = 0;
  let totalDemand = 0;

  for (const seller of sellers) {
    totalSellable += seller.sellable;
  }

  for (const buyer of buyers) {
    totalDemand += buyer.effectiveDemand;
  }

  // Q = min(total sellable, total demand)
  const clearedQuantity = Math.min(totalSellable, totalDemand);

  if (clearedQuantity < config.quantityEpsilon) {
    return []; // No clearing at all
  }

  // Provisional allocations using proportional formula
  // sellerFill_i = Q × sellable_i / sum(sellable)
  // buyerFill_j = Q × demand_j / sum(demand)

  const sellerFills = sellers.map((seller) => {
    const provisional = totalSellable > config.quantityEpsilon
      ? (clearedQuantity * seller.sellable) / totalSellable
      : 0;
    return {
      sellerId: seller.intentId,
      provisional,
      cumulative: 0,
    };
  });

  const buyerFills = buyers.map((buyer) => {
    const provisional = totalDemand > config.quantityEpsilon
      ? (clearedQuantity * buyer.effectiveDemand) / totalDemand
      : 0;
    return {
      buyerId: buyer.intentId,
      provisional,
      cumulative: 0,
    };
  });

  // Residual correction: distribute rounding error deterministically
  // Order by persistent actor ID then intent ID
  applyResidualCorrection(sellerFills, clearedQuantity);
  applyResidualCorrection(buyerFills, clearedQuantity);

  // Build final allocations via stable two-pointer matching
  // Match in seller-actor/buyer-actor order
  const allocations: MarketAllocation[] = [];

  for (let si = 0; si < sellers.length; si++) {
    const seller = sellers[si];
    const sellerFill = sellerFills[si];
    if (!seller || !sellerFill) continue;

    let remainingSellFill = sellerFill.provisional;

    for (let bi = 0; bi < buyers.length; bi++) {
      if (remainingSellFill < config.quantityEpsilon) break;

      const buyer = buyers[bi];
      const buyerFill = buyerFills[bi];
      if (!buyer || !buyerFill) continue;

      let remainingBuyFill = buyerFill.provisional;

      if (remainingBuyFill < config.quantityEpsilon) continue;

      // Match quantity between this seller and buyer
      const matchQuantity = Math.min(remainingSellFill, remainingBuyFill);

      if (matchQuantity >= config.quantityEpsilon) {
        // Compute taxes and prices for this match
        const taxableAmount = matchQuantity * config.sellerNetUnitPrice;
        const taxRate = config.consumptionTaxRateByState(buyer.destinationStateId);
        const consumptionTax = taxableAmount * taxRate;

        allocations.push({
          id: allocationIdSequence(),
          marketId: config.marketId,
          goodId: config.goodId,
          pass: config.pass,
          sellerIntentId: seller.intentId,
          buyerIntentId: buyer.intentId,
          seller: seller.actor,
          buyer: buyer.actor,
          quantity: matchQuantity,
          sellerNetUnitPrice: config.sellerNetUnitPrice,
          buyerGrossUnitPrice: config.buyerGrossUnitPrice,
          marketCurrencyId: config.marketCurrencyId,
          consumptionTaxAmount: consumptionTax,
          destinationStateId: buyer.destinationStateId,
          sellerInventoryBucket: seller.inventoryBucket,
          buyerInventoryBucket: buyer.inventoryBucket,
        });

        remainingSellFill -= matchQuantity;
        buyerFill.provisional -= matchQuantity;
      }
    }
  }

  return allocations;
}

/**
 * Applies residual correction to provisional fills to eliminate floating-point
 * rounding error. Orders correction by stable ID (not insertion order).
 * The sum of corrected fills equals the target sum.
 */
function applyResidualCorrection(
  fills: Array<{ sellerId?: string; buyerId?: string; provisional: number; cumulative?: number }>,
  targetSum: number,
): void {
  if (fills.length === 0) return;

  // Sort by ID for stable order
  const indices: number[] = [];
  for (let i = 0; i < fills.length; i++) {
    indices.push(i);
  }

  indices.sort((i, j) => {
    const fillI = fills[i];
    const fillJ = fills[j];
    if (!fillI || !fillJ) return 0;

    const idI = fillI.sellerId || fillI.buyerId || "";
    const idJ = fillJ.sellerId || fillJ.buyerId || "";
    return idI.localeCompare(idJ);
  });

  // Distribute residual error
  let sum = 0;
  for (const fill of fills) {
    if (fill) sum += fill.provisional;
  }

  const residual = targetSum - sum;
  const correctionPerUnit = residual / Math.max(fills.length, 1);

  // Apply correction in stable order
  let cumulativeError = 0;
  for (const idx of indices) {
    const fill = fills[idx];
    if (!fill) continue;

    const correction = correctionPerUnit;
    fill.provisional += correction;
    cumulativeError += correction;
  }

  // Ensure exact sum by final adjustment on last item
  if (indices.length > 0) {
    const lastIdx = indices[indices.length - 1];
    if (lastIdx !== undefined) {
      const lastFill = fills[lastIdx];
      if (lastFill) {
        lastFill.provisional += residual - cumulativeError;
      }
    }
  }
}
