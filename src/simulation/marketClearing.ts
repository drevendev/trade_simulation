/**
 * Deterministic local clearing primitive and MarketAllocation construction (REQ-MARKET-003).
 *
 * Implements deterministic proportional local clearing with stable residual correction
 * and two-pointer concrete matching to produce MarketAllocation bundles for each matched lot.
 *
 * See sections 7, 10 and 11 of docs/spec/mirror/06 - Handoff/04 — MARKETS_TRADE_FX_CONTRACTS.md
 */

import type {
  CurrencyId,
  GoodId,
  MarketId,
  RegionId,
  StateId,
} from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { assertFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { MarketIntent, MarketIntentId } from "./marketIntent";
import { exactBinary64QuantityWithinEpsilon } from "./marketClearing.exactBinary64Quantity";
import { buildExactMatchPlan, exactPlanWithinCapacities } from "./marketClearing.exactMatchPlan";

/** Opaque market allocation ID (ma:...) */
export type MarketAllocationId = string & { readonly __brand: "MarketAllocationId" };

export function createMarketAllocationId(value: string): MarketAllocationId {
  if (!value.startsWith("ma:")) {
    throw new Error(`MarketAllocationId must start with "ma:", got ${value}`);
  }
  return value as MarketAllocationId;
}

/**
 * Ephemeral allocation of goods and money for one matched lot in a local market clearing.
 * Becomes persistent truth only after settlement executes all transaction mutations.
 * Inventory endpoint rule: settlement debits sellerInventoryBucket and credits buyerInventoryBucket.
 */
export interface MarketAllocation {
  readonly id: MarketAllocationId;
  readonly marketId: MarketId;
  readonly regionId: RegionId;
  readonly goodId: GoodId;
  readonly pass: "PRE_PRODUCTION" | "MAIN";
  readonly sellerIntentId: MarketIntentId;
  readonly buyerIntentId: MarketIntentId;
  readonly seller: ActorRef;
  readonly buyer: ActorRef;
  readonly quantity: number;
  readonly sellerNetUnitPrice: number;
  readonly buyerGrossUnitPrice: number;
  readonly marketCurrencyId: CurrencyId;
  readonly consumptionTaxAmount: number;
  readonly destinationStateId: StateId | null;
  readonly sellerInventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
  readonly buyerInventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
}

/**
 * Input to deterministic local clearing: aggregated demand and supply for one market/good/pass.
 */
export interface LocalClearingInput {
  readonly marketId: MarketId;
  readonly regionId: RegionId;
  readonly goodId: GoodId;
  readonly pass: "PRE_PRODUCTION" | "MAIN";
  readonly marketCurrencyId: CurrencyId;
  readonly buyerIntents: ReadonlyArray<MarketIntent>;
  readonly sellerIntents: ReadonlyArray<MarketIntent>;
  readonly computeEffectiveDemand: (intent: MarketIntent, marketPrice: number) => number;
  readonly computeSellableQuantity: (intent: MarketIntent, commitmentLedger: Map<string, number>) => number;
  readonly computeGrossUnitPrice: (intent: MarketIntent, sellerNetPrice: number) => number;
  readonly getTaxationInfo: (buyer: MarketIntent, regionId: RegionId, good: GoodId) => {
    destinationStateId: StateId | null;
    assessedTaxRate: number;
    collectionEfficiency: number;
  };
}

/**
 * Compute canonical sellable quantity for a SELL intent.
 * sellable_i = min(desiredQuantity, max(0, owned - reserve - alreadyCommitted))
 *
 * Note: This function does NOT include commitmentLedger handling for now;
 * that belongs in Phase-4/Phase-8 orchestration. This is the core formula.
 */
export function computeSellableQuantity(
  intent: MarketIntent,
  ownedQuantity: number,
  minimumReserveQuantity: number = 0,
  alreadyCommitted: number = 0,
): number {
  if (intent.side !== "SELL") {
    throw new Error("computeSellableQuantity only applies to SELL intents");
  }

  const reserve = minimumReserveQuantity;
  const available = Math.max(0, ownedQuantity - reserve - alreadyCommitted);
  return Math.min(intent.desiredQuantity, available);
}

/**
 * Compute canonical effective demand for a BUY intent.
 * effectiveDemand_j = min(desiredQuantity, maxSpend / max(grossUnitPrice, moneyEpsilon))
 *
 * Price must not be zero or negative (except explicit free-scenario fixtures).
 */
export function computeEffectiveDemand(
  intent: MarketIntent,
  grossUnitPrice: number,
  moneyEpsilon: number = 1e-8,
): number {
  if (intent.side !== "BUY") {
    throw new Error("computeEffectiveDemand only applies to BUY intents");
  }
  if (typeof intent.maxSpend !== "number") {
    throw new Error("BUY intent must have maxSpend");
  }

  const effectivePrice = Math.max(grossUnitPrice, moneyEpsilon);
  return Math.min(intent.desiredQuantity, intent.maxSpend / effectivePrice);
}

/**
 * Deterministic proportional local clearing for one region + good + pass.
 *
 * Steps:
 * 1. Compute Q = min(Σ sellable, Σ effectiveDemand)
 * 2. Provisional allocations: sellerFill_i = Q × sellable_i / Σ sellable
 * 3. Stable residual correction to handle floating-point rounding
 * 4. Two-pointer concrete matching to produce atomic transaction bundles
 *
 * Seller fills and buyer fills must sum to the same cleared quantity within epsilon.
 * No fill exceeds sellable stock, reserve, effective demand or maxSpend.
 * Residual correction and concrete matching are stable-ID ordered.
 * Shuffled intent insertion produces identical normalized allocations.
 */
export function computeLocalClearing(
  input: LocalClearingInput,
  commitmentLedger: Map<string, number>,
  marketPrice: number,
  quantityEpsilon: number = 1e-8,
  allocationIdCounter: { value: number },
): MarketAllocation[] {
  // Canonicalize before callbacks and floating-point reductions, not only before
  // residual correction: addition order is observable for mixed-magnitude stocks.
  const intentKey = (intent: MarketIntent): string => `${actorRefKey(intent.actor)}|${intent.id}`;
  const buyerIntents = stableOrderBy(input.buyerIntents, intentKey);
  const sellerIntents = stableOrderBy(input.sellerIntents, intentKey);

  if (buyerIntents.length === 0 || sellerIntents.length === 0) {
    return [];
  }

  const buyerData = buyerIntents.map((intent) => {
    const grossPrice = input.computeGrossUnitPrice(intent, marketPrice);
    const effectiveDemand = input.computeEffectiveDemand(intent, grossPrice);
    assertFiniteCanonicalNumber(effectiveDemand, `effectiveDemand for buyer ${intent.id}`);
    return { intent, effectiveDemand, grossPrice };
  });

  const sellerData = sellerIntents.map((intent) => {
    const sellable = input.computeSellableQuantity(intent, commitmentLedger);
    assertFiniteCanonicalNumber(sellable, `sellable for seller ${intent.id}`);
    return { intent, sellable };
  });

  const totalDemand = buyerData.reduce((sum, d) => sum + d.effectiveDemand, 0);
  const totalSupply = sellerData.reduce((sum, s) => sum + s.sellable, 0);

  // Epsilon measures reconciliation error; it is never a minimum tradable lot.
  // A positive feasible market must reach the matcher and exact capacity checks,
  // even when its entire aggregate quantity is at or below quantityEpsilon.
  if (totalDemand <= 0 || totalSupply <= 0) {
    return [];
  }

  const clearedQuantity = Math.min(totalDemand, totalSupply);

  const provisionalSellerAllocations = sellerData.map((data) => ({
    ...data,
    provisionalFill: clearedQuantity === totalSupply
      ? data.sellable
      : (clearedQuantity * data.sellable) / totalSupply,
  }));

  const provisionalBuyerAllocations = buyerData.map((data) => ({
    ...data,
    provisionalFill: clearedQuantity === totalDemand
      ? data.effectiveDemand
      : (clearedQuantity * data.effectiveDemand) / totalDemand,
  }));

  const correctedSellerAllocations = applyResidualCorrection(
    provisionalSellerAllocations,
    clearedQuantity,
    quantityEpsilon,
    (entry) => entry.sellable,
  );
  const correctedBuyerAllocations = applyResidualCorrection(
    provisionalBuyerAllocations,
    clearedQuantity,
    quantityEpsilon,
    (entry) => entry.effectiveDemand,
  );

  // Retain physical capacity independently of the proportional target. Validate
  // the emitted plan before taxation callbacks or allocation IDs are consumed.
  const matchPlan = selectStableMatchPlan(
    correctedSellerAllocations.map((entry) => ({ ...entry, capacity: entry.sellable })),
    correctedBuyerAllocations.map((entry) => ({ ...entry, capacity: entry.effectiveDemand })),
    clearedQuantity,
    quantityEpsilon,
  );

  return materializeMatchPlan(input, matchPlan, marketPrice, allocationIdCounter);
}

/**
 * Apply stable residual correction to provisional allocations.
 * Correction order is persistent actor ID then intent ID.
 * This ensures floating-point rounding errors do not create/destroy quantity.
 */
function applyResidualCorrection<T extends { intent: MarketIntent; provisionalFill: number }>(
  data: T[],
  targetTotal: number,
  quantityEpsilon: number,
  capacityOf: (entry: T) => number,
): (T & { correctedFill: number })[] {
  const sorted = stableOrderBy(data, (d) => `${actorRefKey(d.intent.actor)}|${d.intent.id}`);
  const corrected = sorted.map((d) => ({ ...d, correctedFill: d.provisionalFill }));
  const currentTotal = corrected.reduce((sum, d) => sum + d.correctedFill, 0);
  const residualError = targetTotal - currentTotal;

  if (Math.abs(residualError) > quantityEpsilon) {
    let remaining = residualError;
    for (let i = 0; i < corrected.length && Math.abs(remaining) > quantityEpsilon; i++) {
      const curr = corrected[i]!;
      const capacity = capacityOf(curr);
      assertFiniteCanonicalNumber(capacity, `residual-correction capacity for ${curr.intent.id}`);
      if (capacity < 0) {
        throw new Error(`Residual-correction capacity must be >= 0 for ${curr.intent.id}, got ${capacity}`);
      }

      const toAdd = remaining > 0
        ? Math.min(remaining, Math.max(0, capacity - curr.correctedFill))
        : Math.max(remaining, -curr.correctedFill);
      curr.correctedFill += toAdd;
      remaining -= toAdd;
    }
    if (Math.abs(remaining) > quantityEpsilon) {
      throw new Error(`Residual correction could not reconcile target total within epsilon: remaining=${remaining}`);
    }
  }
  return corrected;
}

interface PlannedMatch {
  readonly seller: MarketIntent;
  readonly buyer: MarketIntent;
  readonly quantity: number;
}

interface CorrectedIntentFill {
  readonly intent: MarketIntent;
  readonly correctedFill: number;
  readonly capacity: number;
}

/** Pure two-pointer planning: speculative plans consume no callbacks or allocation IDs. */
function buildMatchPlan(
  sellerAllocations: ReadonlyArray<CorrectedIntentFill>,
  buyerAllocations: ReadonlyArray<CorrectedIntentFill>,
): PlannedMatch[] {
  const plan: PlannedMatch[] = [];
  let sellerIdx = 0;
  let buyerIdx = 0;
  let sellerRemaining = sellerAllocations[0]?.correctedFill ?? 0;
  let buyerRemaining = buyerAllocations[0]?.correctedFill ?? 0;

  while (sellerIdx < sellerAllocations.length && buyerIdx < buyerAllocations.length) {
    const sellerData = sellerAllocations[sellerIdx]!;
    const buyerData = buyerAllocations[buyerIdx]!;
    const matched = Math.min(sellerRemaining, buyerRemaining);
    // Epsilon is a reconciliation tolerance, not a minimum tradable lot.
    if (matched > 0) {
      plan.push({ seller: sellerData.intent, buyer: buyerData.intent, quantity: matched });
    }
    sellerRemaining -= matched;
    buyerRemaining -= matched;
    if (sellerRemaining <= 0) {
      sellerIdx++;
      sellerRemaining = sellerAllocations[sellerIdx]?.correctedFill ?? 0;
    }
    if (buyerRemaining <= 0) {
      buyerIdx++;
      buyerRemaining = buyerAllocations[buyerIdx]?.correctedFill ?? 0;
    }
  }
  return plan;
}

/** Validate actual emitted quantities, then repair only an invalid Number plan. */
function selectStableMatchPlan(
  sellers: ReadonlyArray<CorrectedIntentFill>,
  buyers: ReadonlyArray<CorrectedIntentFill>,
  clearedQuantity: number,
  quantityEpsilon: number,
): PlannedMatch[] {
  if (!(Number.isFinite(clearedQuantity) && clearedQuantity > 0) ||
      !(Number.isFinite(quantityEpsilon) && quantityEpsilon >= 0)) {
    throw new Error("Local clearing requires finite positive quantity and finite nonnegative epsilon");
  }
  const acceptable = (plan: ReadonlyArray<PlannedMatch>): boolean =>
    exactBinary64QuantityWithinEpsilon(plan.map((match) => match.quantity), clearedQuantity, quantityEpsilon) &&
    exactPlanWithinCapacities(plan, sellers, buyers, clearedQuantity, quantityEpsilon);
  const baseline = buildMatchPlan(sellers, buyers);
  if (acceptable(baseline)) return baseline;

  // Exact remaining balances avoid cumulative subtraction error. A nonrepresentable
  // matched amount is split into bounded positive binary64 lots rather than discarded.
  const corrected = buildExactMatchPlan(sellers, buyers, clearedQuantity, quantityEpsilon);
  if (acceptable(corrected)) return corrected;
  throw new Error("Local clearing cannot safely materialize match plan within physical capacities and epsilon");
}

/**
 * Materialize exactly one already-selected plan. This is the only stage allowed to invoke
 * taxation callbacks or consume allocation IDs, so rejected numerical trials cannot leak
 * externally observable effects.
 */
function materializeMatchPlan(
  input: LocalClearingInput,
  plan: ReadonlyArray<PlannedMatch>,
  marketPrice: number,
  allocationIdCounter: { value: number },
): MarketAllocation[] {
  // The caller's allocation counter is durable tick state. Validate the *whole*
  // plan before spending an ordinal: a bad late taxation callback must not leave
  // earlier IDs consumed when the clearing attempt throws and is retried.
  const firstOrdinal = allocationIdCounter.value;
  if (!Number.isSafeInteger(firstOrdinal) || firstOrdinal < 0 ||
      plan.length > Number.MAX_SAFE_INTEGER - firstOrdinal) {
    throw new Error("Local clearing allocation counter cannot reserve safe ordinals for the whole match plan");
  }
  assertFiniteCanonicalNumber(marketPrice, "marketPrice for local allocation materialization");
  if (marketPrice < 0) {
    throw new Error("Local clearing marketPrice must be >= 0");
  }

  const prepared = plan.map((match) => {
    const taxInfo = input.getTaxationInfo(match.buyer, match.buyer.regionId, input.goodId);
    assertFiniteCanonicalNumber(taxInfo.assessedTaxRate, "assessedTaxRate for local allocation");
    assertFiniteCanonicalNumber(taxInfo.collectionEfficiency, "collectionEfficiency for local allocation");
    if (taxInfo.assessedTaxRate < 0 || taxInfo.assessedTaxRate > 1 ||
        taxInfo.collectionEfficiency < 0 || taxInfo.collectionEfficiency > 1) {
      throw new Error("Local clearing taxation rate and collection efficiency must be in [0, 1]");
    }

    const collectedTaxPerUnit = marketPrice * taxInfo.assessedTaxRate * taxInfo.collectionEfficiency;
    const grossUnitPrice = marketPrice + collectedTaxPerUnit;
    const consumptionTaxAmount = match.quantity * collectedTaxPerUnit;
    const sellerReceipt = match.quantity * marketPrice;
    const buyerDebit = match.quantity * grossUnitPrice;
    if (![collectedTaxPerUnit, grossUnitPrice, consumptionTaxAmount, sellerReceipt, buyerDebit]
      .every(Number.isFinite)) {
      throw new Error("Local clearing taxation/money products must be finite before allocation");
    }
    if (match.quantity > 0 &&
        ((marketPrice > 0 && sellerReceipt === 0) ||
         (grossUnitPrice > 0 && buyerDebit === 0))) {
      throw new Error("Local clearing positive quantity/price underflows to a zero transfer");
    }
    if (consumptionTaxAmount > 0 &&
        (typeof taxInfo.destinationStateId !== "string" || taxInfo.destinationStateId.trim() === "")) {
      throw new Error("Local clearing collected consumption tax has no State treasury destination");
    }
    return { match, grossUnitPrice, consumptionTaxAmount, destinationStateId: taxInfo.destinationStateId };
  });

  // All callback/numeric checks succeeded. Build the deterministic contiguous ID
  // sequence locally; publish the caller counter only after every record exists.
  const allocations: MarketAllocation[] = prepared.map(({ match, grossUnitPrice, consumptionTaxAmount, destinationStateId }, index) => ({

      id: createMarketAllocationId(`ma:${input.marketId}/${input.goodId}/${input.pass}/${firstOrdinal + index + 1}`),
      marketId: input.marketId,
      regionId: input.regionId,
      goodId: input.goodId,
      pass: input.pass,
      sellerIntentId: match.seller.id,
      buyerIntentId: match.buyer.id,
      seller: match.seller.actor,
      buyer: match.buyer.actor,
      quantity: match.quantity,
      sellerNetUnitPrice: marketPrice,
      buyerGrossUnitPrice: grossUnitPrice,
      marketCurrencyId: input.marketCurrencyId,
      consumptionTaxAmount,
      destinationStateId,
      sellerInventoryBucket: (match.seller.inventoryBucket ?? "GENERAL") as
        | "GENERAL"
        | "INPUT"
        | "OUTPUT"
        | "INVESTMENT",
      buyerInventoryBucket: (match.buyer.inventoryBucket ?? "GENERAL") as
        | "GENERAL"
        | "INPUT"
        | "OUTPUT"
        | "INVESTMENT",
    }));
  allocationIdCounter.value = firstOrdinal + allocations.length;
  return allocations;
}

/** Validate a MarketAllocation against specification constraints. */
export function validateMarketAllocation(allocation: MarketAllocation, quantityEpsilon: number = 1e-8): void {
  if (!allocation.id || !allocation.id.startsWith("ma:")) {
    throw new Error("MarketAllocation must have valid id starting with 'ma:'");
  }
  if (allocation.pass !== "PRE_PRODUCTION" && allocation.pass !== "MAIN") {
    throw new Error(`MarketAllocation pass must be PRE_PRODUCTION or MAIN, got ${allocation.pass}`);
  }
  if (allocation.quantity < 0) {
    throw new Error(`MarketAllocation quantity must be >= 0, got ${allocation.quantity}`);
  }
  assertFiniteCanonicalNumber(allocation.quantity, "MarketAllocation quantity");

  if (allocation.sellerNetUnitPrice < 0) {
    throw new Error(`MarketAllocation sellerNetUnitPrice must be >= 0, got ${allocation.sellerNetUnitPrice}`);
  }
  assertFiniteCanonicalNumber(allocation.sellerNetUnitPrice, "MarketAllocation sellerNetUnitPrice");

  if (allocation.buyerGrossUnitPrice < 0) {
    throw new Error(`MarketAllocation buyerGrossUnitPrice must be >= 0, got ${allocation.buyerGrossUnitPrice}`);
  }
  assertFiniteCanonicalNumber(allocation.buyerGrossUnitPrice, "MarketAllocation buyerGrossUnitPrice");

  if (allocation.consumptionTaxAmount < 0) {
    throw new Error(`MarketAllocation consumptionTaxAmount must be >= 0, got ${allocation.consumptionTaxAmount}`);
  }
  assertFiniteCanonicalNumber(allocation.consumptionTaxAmount, "MarketAllocation consumptionTaxAmount");

  const grossPayment = allocation.quantity * allocation.buyerGrossUnitPrice;
  if (allocation.consumptionTaxAmount > grossPayment + quantityEpsilon) {
    throw new Error(`MarketAllocation consumptionTaxAmount ${allocation.consumptionTaxAmount} exceeds gross payment ${grossPayment}`);
  }
}
