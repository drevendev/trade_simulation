/**
 * Atomic local market settlement with transaction schemas (REQ-MARKET-004).
 *
 * Implements preflighted atomic settlement of MarketAllocation bundles,
 * with explicit goods endpoints, seller-net payment and consumption-tax ledger transfer.
 *
 * Transaction types:
 * - MARKET_SALE: buyer -> seller goods transfer with payment
 * - CONSUMPTION_TAX: buyer -> state treasury collected-tax transfer (paired with MARKET_SALE)
 *
 * See section 12 of docs/spec/mirror/06 - Handoff/04 — MARKETS_TRADE_FX_CONTRACTS.md
 */

import type {
  CurrencyId,
  RegionId,
  StateId,
} from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { assertFiniteCanonicalNumber } from "../domain/numeric";
import type { MarketAllocation } from "./marketClearing";
import type {
  EconomicTransaction,
  TransactionId,
  TransactionBundleId,
} from "./tickOrchestrator";
import {
  createTransactionId,
  createTransactionBundleId,
} from "./tickOrchestrator";

/**
 * Tax policy provider: immutable read-only interface for consumption tax rates.
 * In M3, this is injected with fixture values; M6 replaces it with effective FiscalPolicyState.
 */
export interface TaxPolicyProvider {
  getConsumptionTaxRate(stateId: StateId | null, goodId: string): number;
  getCollectionEfficiency(stateId: StateId | null): number;
}

/**
 * Bundle of related transactions for one atomic market settlement.
 * Contains MARKET_SALE and optional CONSUMPTION_TAX transaction pair.
 */
export interface MarketSettlementBundle {
  readonly bundleId: TransactionBundleId;
  readonly marketSaleTransaction: EconomicTransaction;
  readonly consumptionTaxTransaction?: EconomicTransaction | null;
}

/** A counter is the next unused ordinal, not an approximate floating-point quantity. */
function assertTransactionCapacity(
  counter: { value: number },
  count: number,
  tick: number,
  phase: number,
): void {
  if (!Number.isSafeInteger(tick) || tick < 0 ||
      !Number.isSafeInteger(phase) || phase < 0 || phase > 15) {
    throw new Error("Market settlement requires a nonnegative safe-integer tick and phase 0..15");
  }
  if (!Number.isSafeInteger(counter.value) || counter.value < 0 ||
      counter.value > Number.MAX_SAFE_INTEGER - count) {
    throw new Error(`Market settlement transaction counter cannot reserve ${count} safe ordinal(s)`);
  }
}

/**
 * Compute consumption tax details for a buyer purchase.
 * Returns assessed tax rate, collection efficiency, and resulting collected tax.
 * Only collected tax is debited/credited; assessed-but-uncollected tax remains with buyer as telemetry.
 */
export function computeConsumptionTax(
  destinationStateId: StateId | null,
  goodId: string,
  sellerNetValue: number,
  taxPolicy: TaxPolicyProvider,
): {
  assessedTaxRate: number;
  collectionEfficiency: number;
  assessedTaxPerUnit: number;
  collectedTaxAmount: number;
} {
  assertFiniteCanonicalNumber(sellerNetValue, "sellerNetValue in computeConsumptionTax");
  if (sellerNetValue < 0) {
    throw new Error(`sellerNetValue must be >= 0, got ${sellerNetValue}`);
  }

  const assessedTaxRate = taxPolicy.getConsumptionTaxRate(destinationStateId, goodId);
  const collectionEfficiency = taxPolicy.getCollectionEfficiency(destinationStateId);

  assertFiniteCanonicalNumber(assessedTaxRate, "assessedTaxRate");
  if (assessedTaxRate < 0 || assessedTaxRate > 1) {
    throw new Error(`assessedTaxRate must be in [0, 1], got ${assessedTaxRate}`);
  }

  assertFiniteCanonicalNumber(collectionEfficiency, "collectionEfficiency");
  if (collectionEfficiency < 0 || collectionEfficiency > 1) {
    throw new Error(`collectionEfficiency must be in [0, 1], got ${collectionEfficiency}`);
  }

  const assessedTaxPerUnit = sellerNetValue * assessedTaxRate;
  const collectedTaxAmount = assessedTaxPerUnit * collectionEfficiency;

  return {
    assessedTaxRate,
    collectionEfficiency,
    assessedTaxPerUnit,
    collectedTaxAmount,
  };
}

/**
 * Preflight validation for market settlement: check that all stock/budget mutations are legal.
 * Returns null if valid, error message if preflight fails.
 * If preflight fails, no mutation is applied.
 */
export function preflightMarketSettlement(
  allocation: MarketAllocation,
  tick: number,
  phase: number,
): string | null {
  // Validation: quantity must be non-negative and finite
  if (allocation.quantity < 0) {
    return `Allocation quantity must be >= 0, got ${allocation.quantity}`;
  }
  assertFiniteCanonicalNumber(allocation.quantity, "allocation.quantity");

  // Validation: prices must be finite and non-negative
  if (allocation.sellerNetUnitPrice < 0) {
    return `sellerNetUnitPrice must be >= 0, got ${allocation.sellerNetUnitPrice}`;
  }
  assertFiniteCanonicalNumber(allocation.sellerNetUnitPrice, "sellerNetUnitPrice");

  if (allocation.buyerGrossUnitPrice < 0) {
    return `buyerGrossUnitPrice must be >= 0, got ${allocation.buyerGrossUnitPrice}`;
  }
  assertFiniteCanonicalNumber(allocation.buyerGrossUnitPrice, "buyerGrossUnitPrice");

  // Validation: consumption tax amount must be finite and non-negative
  if (allocation.consumptionTaxAmount < 0) {
    return `consumptionTaxAmount must be >= 0, got ${allocation.consumptionTaxAmount}`;
  }
  assertFiniteCanonicalNumber(allocation.consumptionTaxAmount, "consumptionTaxAmount");

  if (!Number.isSafeInteger(tick) || tick < 0 ||
      !Number.isSafeInteger(phase) || phase < 0 || phase > 15) {
    return "Market settlement requires a nonnegative safe-integer tick and phase 0..15";
  }

  if (allocation.consumptionTaxAmount > 0 &&
      (typeof allocation.destinationStateId !== "string" || allocation.destinationStateId.trim() === "")) {
    return "Collected consumption tax has no destinationStateId; it must reach a State treasury";
  }

  // Finite operands do not imply finite products/sums. Infinity - Infinity is NaN,
  // whose comparison with epsilon would otherwise admit an invalid money bundle.
  const sellerNetReceipt = allocation.quantity * allocation.sellerNetUnitPrice;
  const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;
  const expectedBuyerDebit = sellerNetReceipt + allocation.consumptionTaxAmount;
  if (!Number.isFinite(sellerNetReceipt) || !Number.isFinite(buyerGrossDebit) ||
      !Number.isFinite(expectedBuyerDebit)) {
    return "Derived seller receipt, buyer debit and receipt plus tax must be finite";
  }
  if (allocation.quantity > 0 &&
      ((allocation.sellerNetUnitPrice > 0 && sellerNetReceipt === 0) ||
       (allocation.buyerGrossUnitPrice > 0 && buyerGrossDebit === 0))) {
    return "Positive quantity and positive price underflow to a zero money transfer";
  }

  // Preserve the existing comparison tolerance; this repair adds no economic rounding rule.
  const epsilon = 1e-8;
  if (Math.abs(buyerGrossDebit - expectedBuyerDebit) > epsilon) {
    return `Buyer debit (${buyerGrossDebit}) must equal seller net (${sellerNetReceipt}) + tax (${allocation.consumptionTaxAmount}), got difference of ${Math.abs(buyerGrossDebit - expectedBuyerDebit)}`;
  }

  // The tax is a separate treasury credit: it must be funded by a separately
  // materialized buyer debit even when buyerGross and sellerNet are huge.
  // This guard supplements (does not replace) the existing tolerance contract.
  const separatelyPostedResidual = (buyerGrossDebit - sellerNetReceipt) - allocation.consumptionTaxAmount;
  if ((allocation.consumptionTaxAmount > 0 && buyerGrossDebit === sellerNetReceipt) ||
      Math.abs(separatelyPostedResidual) > epsilon) {
    return "Buyer debit cannot fund the separately posted seller receipt and collected tax";
  }

  return null;
}

/**
 * Create a MARKET_SALE transaction for one atomic local market settlement.
 * Recording: buyer -> seller goods transfer with payment at seller net unit price.
 *
 * Fields:
 * - transactionId, bundleId, tick, phase
 * - type = 'MARKET_SALE'
 * - source = buyer; destination = seller
 * - goodId, quantity
 * - currencyId = market settlement currency
 * - unitPrice = seller net unit price
 * - moneyAmount = seller net value (quantity × unitPrice)
 * - sourceRegionId = destinationRegionId = market region
 * - reason for audit trail
 */
export function createMarketSaleTransaction(
  allocation: MarketAllocation,
  bundleId: TransactionBundleId,
  tick: number,
  phase: number,
  transactionIdCounter: { value: number },
): EconomicTransaction {
  assertFiniteCanonicalNumber(allocation.quantity, "allocation.quantity");
  assertFiniteCanonicalNumber(allocation.sellerNetUnitPrice, "sellerNetUnitPrice");
  if (allocation.quantity < 0 || allocation.sellerNetUnitPrice < 0) {
    throw new Error("Market sale quantity and sellerNetUnitPrice must be >= 0");
  }
  const sellerNetValue = allocation.quantity * allocation.sellerNetUnitPrice;
  assertFiniteCanonicalNumber(sellerNetValue, "sellerNetValue");
  if (allocation.quantity > 0 && allocation.sellerNetUnitPrice > 0 && sellerNetValue === 0) {
    throw new Error("Positive market sale quantity and price underflow to zero");
  }
  assertTransactionCapacity(transactionIdCounter, 1, tick, phase);

  const transactionId = createTransactionId(`tx:${tick}:${phase}:market-sale:${transactionIdCounter.value++}`);

  return {
    tick,
    phase,
    type: "MARKET_SALE",
    transactionId,
    bundleId,
    source: allocation.buyer,
    destination: allocation.seller,
    goodId: allocation.goodId,
    quantity: allocation.quantity,
    currencyId: allocation.marketCurrencyId,
    unitPrice: allocation.sellerNetUnitPrice,
    moneyAmount: sellerNetValue,
    sourceRegionId: allocation.regionId,
    destinationRegionId: allocation.regionId,
    amount: sellerNetValue,
  };
}

/**
 * Create a CONSUMPTION_TAX transaction paired with MARKET_SALE.
 * Only created if consumptionTaxAmount > 0.
 *
 * Fields:
 * - type = 'CONSUMPTION_TAX'
 * - source = buyer; destination = {type:'STATE', id: destinationStateId}
 * - currencyId = market currency
 * - moneyAmount = collected tax only (assessed-but-uncollected remains with buyer as telemetry)
 * - taxAmount = collected tax
 * - originatingTransactionId = MARKET_SALE transactionId
 * - same bundleId
 */
export function createConsumptionTaxTransaction(
  allocation: MarketAllocation,
  marketSaleTransactionId: TransactionId,
  bundleId: TransactionBundleId,
  tick: number,
  phase: number,
  transactionIdCounter: { value: number },
): EconomicTransaction | null {
  assertFiniteCanonicalNumber(allocation.consumptionTaxAmount, "allocation.consumptionTaxAmount");
  if (allocation.consumptionTaxAmount < 0) {
    throw new Error("consumptionTaxAmount must be >= 0");
  }
  if (allocation.consumptionTaxAmount === 0) return null;

  if (typeof allocation.destinationStateId !== "string" || allocation.destinationStateId.trim() === "") {
    throw new Error("Collected consumption tax has no destinationStateId; it must reach a State treasury");
  }
  assertTransactionCapacity(transactionIdCounter, 1, tick, phase);

  const transactionId = createTransactionId(`tx:${tick}:${phase}:consumption-tax:${transactionIdCounter.value++}`);

  const stateDestination: ActorRef = {
    type: "STATE",
    stateId: allocation.destinationStateId,
  };

  return {
    tick,
    phase,
    type: "CONSUMPTION_TAX",
    transactionId,
    bundleId,
    originatingTransactionId: marketSaleTransactionId,
    source: allocation.buyer,
    destination: stateDestination,
    currencyId: allocation.marketCurrencyId,
    taxAmount: allocation.consumptionTaxAmount,
    moneyAmount: allocation.consumptionTaxAmount,
    amount: allocation.consumptionTaxAmount,
  };
}

/**
 * Execute atomic settlement of one MarketAllocation.
 * Returns a transaction bundle with MARKET_SALE and optional CONSUMPTION_TAX transactions.
 *
 * Precondition: allocation must pass preflightMarketSettlement validation.
 * If preflight fails, this function throws an error.
 *
 * The bundle contains paired transactions with identical bundleId for reconciliation.
 * CONSUMPTION_TAX originatingTransactionId points back to MARKET_SALE for causal linkage.
 */
export function executeMarketSettlement(
  allocation: MarketAllocation,
  tick: number,
  phase: number,
  transactionIdCounter: { value: number },
): MarketSettlementBundle {
  // Preflight validation
  const preflightError = preflightMarketSettlement(allocation, tick, phase);
  if (preflightError) {
    throw new Error(`Market settlement preflight failed: ${preflightError}`);
  }

  const transactionCount = allocation.consumptionTaxAmount > 0 ? 2 : 1;
  assertTransactionCapacity(transactionIdCounter, transactionCount, tick, phase);
  // Publish the caller's counter only after both records exist. A refused bundle must
  // not consume even its first ordinal, including exhaustion before the tax leg.
  const stagedCounter = { value: transactionIdCounter.value };

  // Allocation identity distinguishes split lots for the same two intents. Tuple
  // encoding is injective for string IDs, unlike concatenating colon-delimited keys.
  const bundleId = createTransactionBundleId(`tb:${JSON.stringify([
    tick, phase, allocation.pass, allocation.marketId, allocation.regionId,
    allocation.goodId, allocation.marketCurrencyId, allocation.sellerIntentId,
    allocation.buyerIntentId, allocation.id,
  ])}`);

  // Create MARKET_SALE transaction
  const marketSaleTransaction = createMarketSaleTransaction(
    allocation,
    bundleId,
    tick,
    phase,
    stagedCounter,
  );

  // Create CONSUMPTION_TAX transaction (if applicable)
  const consumptionTaxTransaction = createConsumptionTaxTransaction(
    allocation,
    marketSaleTransaction.transactionId,
    bundleId,
    tick,
    phase,
    stagedCounter,
  );

  transactionIdCounter.value = stagedCounter.value;
  return {
    bundleId,
    marketSaleTransaction,
    consumptionTaxTransaction,
  };
}
