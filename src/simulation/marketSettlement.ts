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

  // Preflight math check: buyer debit must equal seller net receipt + tax (MTFX-I2)
  const sellerNetReceipt = allocation.quantity * allocation.sellerNetUnitPrice;
  const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;
  const expectedBuyerDebit = sellerNetReceipt + allocation.consumptionTaxAmount;

  // Use epsilon for floating-point comparison
  const epsilon = 1e-8;
  if (Math.abs(buyerGrossDebit - expectedBuyerDebit) > epsilon) {
    return `Buyer debit (${buyerGrossDebit}) must equal seller net (${sellerNetReceipt}) + tax (${allocation.consumptionTaxAmount}), got difference of ${Math.abs(buyerGrossDebit - expectedBuyerDebit)}`;
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
  const sellerNetValue = allocation.quantity * allocation.sellerNetUnitPrice;
  assertFiniteCanonicalNumber(sellerNetValue, "sellerNetValue");

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
  // Only create tax transaction if tax amount > 0
  if (allocation.consumptionTaxAmount <= 0) {
    return null;
  }

  assertFiniteCanonicalNumber(allocation.consumptionTaxAmount, "allocation.consumptionTaxAmount");

  if (!allocation.destinationStateId) {
    // No tax without destination state
    return null;
  }

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

  // Create bundle ID from stable semantic inputs
  const bundleId = createTransactionBundleId(
    `tb:${tick}:${phase}:${allocation.marketId}:${allocation.goodId}:${allocation.sellerIntentId}:${allocation.buyerIntentId}`,
  );

  // Create MARKET_SALE transaction
  const marketSaleTransaction = createMarketSaleTransaction(
    allocation,
    bundleId,
    tick,
    phase,
    transactionIdCounter,
  );

  // Create CONSUMPTION_TAX transaction (if applicable)
  const consumptionTaxTransaction = createConsumptionTaxTransaction(
    allocation,
    marketSaleTransaction.transactionId,
    bundleId,
    tick,
    phase,
    transactionIdCounter,
  );

  return {
    bundleId,
    marketSaleTransaction,
    consumptionTaxTransaction,
  };
}
