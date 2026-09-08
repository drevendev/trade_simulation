/**
 * Transaction schemas for local market settlement with tax integration (REQ-MARKET-004).
 *
 * Implements MARKET_SALE and CONSUMPTION_TAX transaction types from section 12 of
 * docs/spec/mirror/06 - Handoff/04 — MARKETS_TRADE_FX_CONTRACTS.md
 *
 * These are ephemeral records created during clearing and settlement, not persistent
 * entities. They define the definitive record of buyer/seller obligations and tax
 * collections for deterministic reconciliation.
 */

import type {
  CurrencyId,
  GoodId,
  RegionId,
  StateId,
  TransactionId,
  TransactionBundleId,
} from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import type { EconomicTransaction } from "./tickOrchestrator";

/**
 * Factory for creating a MARKET_SALE transaction.
 * Records the sale of goods at net seller price from buyer to seller.
 *
 * Per spec section 12:
 * - source = buyer; destination = seller
 * - goodId, quantity (as amount)
 * - currencyId = market settlement currency
 * - unitPrice = seller net unit price
 * - moneyAmount (stored as amount) = seller net value
 * - sourceRegionId = destinationRegionId = market region
 */
export function createMarketSaleTransaction(args: {
  readonly transactionId: TransactionId;
  readonly bundleId: TransactionBundleId;
  readonly tick: number;
  readonly phase: number;
  readonly buyer: ActorRef;
  readonly seller: ActorRef;
  readonly goodId: GoodId;
  readonly quantity: number;
  readonly sellerNetUnitPrice: number;
  readonly marketCurrencyId: CurrencyId;
  readonly marketRegionId: RegionId;
}): EconomicTransaction {
  const moneyAmount = args.quantity * args.sellerNetUnitPrice;

  return {
    transactionId: args.transactionId,
    bundleId: args.bundleId,
    tick: args.tick,
    phase: args.phase,
    type: "MARKET_SALE",
    source: args.buyer,
    destination: args.seller,
    goodId: args.goodId,
    currencyId: args.marketCurrencyId,
    amount: moneyAmount,
    unitPrice: args.sellerNetUnitPrice,
    reason: `Local market sale: ${args.quantity} units of good at net price ${args.sellerNetUnitPrice}`,
  };
}

/**
 * Factory for creating a CONSUMPTION_TAX transaction.
 * Records the collection of consumption tax from buyer to destination State treasury.
 * Only the collected tax (after applying collectionEfficiency) creates a transaction;
 * assessed-but-uncollected tax remains telemetry only with the buyer.
 *
 * Per spec section 12:
 * - type = 'CONSUMPTION_TAX'
 * - source = buyer; destination = {type:'STATE', id: destinationStateId}
 * - currencyId = market currency
 * - moneyAmount (stored as amount) = collected tax
 * - taxAmount = collected tax
 * - originatingTransactionId = MARKET_SALE transactionId
 * - same bundleId as paired MARKET_SALE
 */
export function createConsumptionTaxTransaction(args: {
  readonly transactionId: TransactionId;
  readonly bundleId: TransactionBundleId;
  readonly tick: number;
  readonly phase: number;
  readonly buyer: ActorRef;
  readonly destinationStateId: StateId | null;
  readonly marketCurrencyId: CurrencyId;
  readonly collectedTaxAmount: number;
  readonly originatingMarketSaleId: TransactionId;
}): EconomicTransaction | null {
  // If no destination state or no tax collected, no transaction is created.
  // This aligns with spec: uncontrolled regions collect zero tax.
  if (args.destinationStateId === null || args.collectedTaxAmount <= 0) {
    return null;
  }

  return {
    transactionId: args.transactionId,
    bundleId: args.bundleId,
    tick: args.tick,
    phase: args.phase,
    type: "CONSUMPTION_TAX",
    source: args.buyer,
    destination: { type: "STATE", id: args.destinationStateId },
    currencyId: args.marketCurrencyId,
    amount: args.collectedTaxAmount,
    taxAmount: args.collectedTaxAmount,
    originatingTransactionId: args.originatingMarketSaleId,
    reason: `Consumption tax on market sale: ${args.collectedTaxAmount} collected to State treasury`,
  };
}

/**
 * Validate that a MARKET_SALE transaction satisfies all required fields.
 * Used for testing and preflight validation before mutation.
 */
export function validateMarketSaleTransaction(tx: EconomicTransaction): string[] {
  const errors: string[] = [];

  if (tx.type !== "MARKET_SALE") {
    errors.push(`Expected type MARKET_SALE, got ${tx.type}`);
  }
  if (!tx.transactionId) {
    errors.push("Missing transactionId");
  }
  if (!tx.bundleId) {
    errors.push("Missing bundleId");
  }
  if (!tx.source) {
    errors.push("Missing source (buyer)");
  }
  if (!tx.destination) {
    errors.push("Missing destination (seller)");
  }
  if (!tx.goodId) {
    errors.push("Missing goodId");
  }
  if (!tx.currencyId) {
    errors.push("Missing currencyId");
  }
  if (tx.amount <= 0) {
    errors.push(`moneyAmount must be positive, got ${tx.amount}`);
  }
  if (!Number.isFinite(tx.amount)) {
    errors.push(`moneyAmount must be finite, got ${tx.amount}`);
  }
  if (tx.unitPrice === undefined || !Number.isFinite(tx.unitPrice)) {
    errors.push(`unitPrice must be finite, got ${tx.unitPrice}`);
  }

  return errors;
}

/**
 * Validate that a CONSUMPTION_TAX transaction satisfies all required fields.
 * Used for testing and preflight validation before mutation.
 */
export function validateConsumptionTaxTransaction(tx: EconomicTransaction): string[] {
  const errors: string[] = [];

  if (tx.type !== "CONSUMPTION_TAX") {
    errors.push(`Expected type CONSUMPTION_TAX, got ${tx.type}`);
  }
  if (!tx.transactionId) {
    errors.push("Missing transactionId");
  }
  if (!tx.bundleId) {
    errors.push("Missing bundleId");
  }
  if (!tx.source) {
    errors.push("Missing source (buyer)");
  }
  if (!tx.destination) {
    errors.push("Missing destination");
  } else if (typeof tx.destination !== "object" || !("type" in tx.destination) || (tx.destination as any).type !== "STATE") {
    errors.push("Destination must be {type:'STATE', id: StateId}");
  } else if (!("id" in tx.destination)) {
    errors.push("Destination must have an id field");
  }
  if (!tx.currencyId) {
    errors.push("Missing currencyId");
  }
  if (tx.amount <= 0) {
    errors.push(`collected tax must be positive, got ${tx.amount}`);
  }
  if (!Number.isFinite(tx.amount)) {
    errors.push(`collected tax must be finite, got ${tx.amount}`);
  }
  if (tx.taxAmount !== tx.amount) {
    errors.push(`taxAmount must equal amount (collected tax), got ${tx.taxAmount} vs ${tx.amount}`);
  }
  if (!tx.originatingTransactionId) {
    errors.push("Missing originatingTransactionId");
  }

  return errors;
}
