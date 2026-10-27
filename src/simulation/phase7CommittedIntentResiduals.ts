/**
 * M5/#670: Phase-7 committed-dispatch -> Phase-8 local-intent residual projection.
 *
 * This is intentionally NOT a reservation/settlement primitive. Only feed lots
 * already authenticated against successful atomic shipment + cash/FX posting,
 * NEVER proposed Phase-7 candidate/aggregate/actor allocations. The caller
 * owns authoritative shipment/ledger verification and WorldState mutation;
 * this pure boundary prevents an already-dispatched quantity (and its actual
 * destination-currency buyer debit) from being offered again in Phase 8.
 *
 * No stock, wallet, shipment, transaction or MarketIntent input is mutated.
 */
import type { NumericConfig } from "../config/simulationConfig";
import type { GoodId, RegionId } from "../domain/id";
import { stableOrderBy } from "../domain/ordering";
import { validateMarketIntent, type MarketIntent, type MarketIntentId } from "./marketIntent";

export interface CommittedPhase7ShipmentLot {
  /** Persistent shipment identity verified by the upstream atomic dispatcher. */
  readonly shipmentId: string;
  readonly sellerIntentId: MarketIntentId;
  readonly buyerIntentId: MarketIntentId;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly goodId: GoodId;
  /** Quantity removed from the seller's local stock at committed dispatch. */
  readonly dispatchedQuantity: number;
  /** Realized total buyer cash debit, denominated in destination currency. */
  readonly buyerTotalDebitDest: number;
}

function positiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Phase-7 committed residual ${field} must be finite and positive`);
  }
}

type ResidualPrecision = Readonly<Required<Pick<NumericConfig, "quantityEpsilon" | "moneyEpsilon">>>;

function subtractExactObservable(
  before: number, debit: number, label: string, precisionTolerance: number,
): number {
  if (debit > before) {
    throw new Error(`Phase-7 committed residual ${label} exceeds remaining intent budget`);
  }
  const after = before - debit;
  // A changed binary64 value is not enough: 1e16 - 3 changes the stored
  // balance by FOUR, silently consuming one unit that never shipped/settled.
  // Compare the actually representable decrement to the authenticated debit
  // using its explicit quantity/money tolerance, not a magnitude-scaled ULP.
  const observedDebit = before - after;
  if (!Number.isFinite(after) || after < 0 || after >= before ||
      !Number.isFinite(observedDebit) ||
      Math.abs(observedDebit - debit) > precisionTolerance) {
    throw new Error(`Phase-7 committed residual ${label} loses binary64 debit precision`);
  }
  return after;
}

/**
 * Accumulate authenticated debits by intent with Neumaier compensation:
 * many individually admissible binary64 decrements may otherwise disguise
 * a material cumulative loss at a large initial balance.
 */
interface CommittedTotal {
  readonly sum: number;
  readonly correction: number;
}

function addCommitted(
  totals: Map<MarketIntentId, CommittedTotal>,
  id: MarketIntentId,
  debit: number,
): void {
  const previous = totals.get(id) ?? { sum: 0, correction: 0 };
  const sum = previous.sum + debit;
  const rounding = Math.abs(previous.sum) >= Math.abs(debit)
    ? (previous.sum - sum) + debit
    : (debit - sum) + previous.sum;
  const correction = previous.correction + rounding;
  if (!Number.isFinite(sum) || !Number.isFinite(correction)) {
    throw new Error("Phase-7 committed residual cumulative receipt debit is nonfinite");
  }
  totals.set(id, { sum, correction });
}

function assertCumulativeDebit(
  initial: number,
  final: number,
  committed: CommittedTotal,
  epsilon: number,
  label: string,
): void {
  const observed = initial - final;
  const expected = committed.sum + committed.correction;
  if (!Number.isFinite(observed) || !Number.isFinite(expected) ||
      Math.abs(observed - expected) > epsilon) {
    throw new Error(`Phase-7 committed residual ${label} cumulative binary64 debit precision`);
  }
}

/**
 * Canonical Phase-8 MAIN intents after REALIZED Phase-7 dispatch.
 *
 * All input intents are from the same tick after Phase-4 consumption. This
 * function does not establish that the supplied receipts were actually
 * committed; callers MUST use authoritative shipment/transaction readback
 * before passing receipts to this boundary. Malformed/overlapping receipts
 * throw without publishing any partial residual state. Absent committed
 * receipts means unchanged local demand/supply, not speculative reservation.
 */
export function projectPhase8CommittedTradeResiduals(
  mainIntents: readonly MarketIntent[],
  committedLots: readonly CommittedPhase7ShipmentLot[],
  numeric: ResidualPrecision,
): MarketIntent[] {
  if (!numeric || !Number.isFinite(numeric.quantityEpsilon) || numeric.quantityEpsilon < 0 ||
      !Number.isFinite(numeric.moneyEpsilon) || numeric.moneyEpsilon < 0) {
    throw new Error("Phase-7 committed residual requires finite nonnegative quantity and money precision");
  }
  const remaining = new Map<MarketIntentId, MarketIntent>();
  for (const intent of mainIntents) {
    validateMarketIntent(intent);
    if (remaining.has(intent.id)) {
      throw new Error(`Phase-7 committed residual duplicate MarketIntent ${intent.id}`);
    }
    remaining.set(intent.id, { ...intent });
  }

  // Preserve the post-Phase-4 starting intents: final residuals must agree
  // with the complete set of committed receipts, not just each individual lot.
  const initial = new Map(remaining);
  const committedQuantities = new Map<MarketIntentId, CommittedTotal>();
  const committedBuyerSpend = new Map<MarketIntentId, CommittedTotal>();
  const seenShipmentIds = new Set<string>();
  for (const lot of stableOrderBy(committedLots, (item) => item.shipmentId)) {
    if (typeof lot.shipmentId !== "string" || !lot.shipmentId.startsWith("sh:") ||
        seenShipmentIds.has(lot.shipmentId)) {
      throw new Error("Phase-7 committed residual requires unique persistent shipment IDs");
    }
    seenShipmentIds.add(lot.shipmentId);
    positiveFinite(lot.dispatchedQuantity, "dispatchedQuantity");
    positiveFinite(lot.buyerTotalDebitDest, "buyerTotalDebitDest");

    const seller = remaining.get(lot.sellerIntentId);
    const buyer = remaining.get(lot.buyerIntentId);
    if (!seller || !buyer || seller.side !== "SELL" || buyer.side !== "BUY" ||
        seller.goodId !== lot.goodId || buyer.goodId !== lot.goodId ||
        seller.regionId !== lot.originRegionId ||
        buyer.regionId !== lot.destinationRegionId ||
        lot.originRegionId === lot.destinationRegionId) {
      throw new Error(`Phase-7 committed residual shipment ${lot.shipmentId} has stale intent, good or region evidence`);
    }
    if (buyer.maxSpend === undefined) {
      throw new Error("Phase-7 committed residual BUY intent is missing maxSpend");
    }

    const sellerRemaining = subtractExactObservable(
      seller.desiredQuantity, lot.dispatchedQuantity, "seller quantity", numeric.quantityEpsilon,
    );
    const buyerRemaining = subtractExactObservable(
      buyer.desiredQuantity, lot.dispatchedQuantity, "buyer quantity", numeric.quantityEpsilon,
    );
    const buyerCashRemaining = subtractExactObservable(
      buyer.maxSpend, lot.buyerTotalDebitDest, "buyer destination-currency spend", numeric.moneyEpsilon,
    );
    remaining.set(seller.id, { ...seller, desiredQuantity: sellerRemaining });
    remaining.set(buyer.id, {
      ...buyer, desiredQuantity: buyerRemaining, maxSpend: buyerCashRemaining,
    });
    addCommitted(committedQuantities, seller.id, lot.dispatchedQuantity);
    addCommitted(committedQuantities, buyer.id, lot.dispatchedQuantity);
    addCommitted(committedBuyerSpend, buyer.id, lot.buyerTotalDebitDest);
  }

  // A fixed absolute tolerance is a TOTAL conservation budget per intent,
  // not a fresh permission to lose up to epsilon on each shipment. In
  // particular, 10_000_000 - 0.3 - 0.3 over-debits by >1e-9 although each
  // of the two individual binary64 subtractions is within 1e-9.
  for (const [id, total] of committedQuantities) {
    const first = initial.get(id);
    const last = remaining.get(id);
    if (!first || !last) {
      throw new Error("Phase-7 committed residual lost intent during reconciliation");
    }
    assertCumulativeDebit(
      first.desiredQuantity, last.desiredQuantity, total,
      numeric.quantityEpsilon, first.side === "SELL" ? "seller quantity" : "buyer quantity",
    );
  }
  for (const [id, total] of committedBuyerSpend) {
    const first = initial.get(id);
    const last = remaining.get(id);
    if (!first || !last || first.maxSpend === undefined || last.maxSpend === undefined) {
      throw new Error("Phase-7 committed residual lost BUY cash during reconciliation");
    }
    assertCumulativeDebit(
      first.maxSpend, last.maxSpend, total, numeric.moneyEpsilon,
      "buyer destination-currency spend",
    );
  }

  return stableOrderBy(remaining.values(), (intent) => intent.id);
}
