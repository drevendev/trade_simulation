/**
 * M2 Typed ledger/flow records for money, goods, and physical losses (REQ-CORE-006).
 *
 * Normalized accounting projection over committed stock mutations with tick/phase attribution,
 * authoritative owner/location, finite delta, stable reason and causal linkage.
 */

import type { CurrencyId, CohortId, ProductionUnitId, RegionId, StateId } from "../domain/id";

/**
 * Base ledger record type with common fields for all flows.
 */
export interface BaseLedgerRecord {
  readonly tick: number;
  readonly phase: number;
  readonly reason: string;
  readonly causalPhase?: number;
}

/**
 * Money flow record: signed currency delta with owner/location.
 */
export interface MoneyFlowRecord extends BaseLedgerRecord {
  readonly type: "MONEY";
  readonly currencyId: CurrencyId;
  readonly ownerType: "state" | "clan" | "cohort" | "productionUnit" | "authority" | "fxPool";
  readonly ownerKey: StateId | string;
  readonly delta: number;
}

/**
 * Good flow record: signed commodity delta with bucket/location.
 */
export interface GoodFlowRecord extends BaseLedgerRecord {
  readonly type: "GOOD";
  readonly goodId: string;
  readonly holderType: "state" | "cohort" | "productionUnit" | "market" | "transit";
  readonly holderKey: RegionId | CohortId | ProductionUnitId | string;
  readonly bucket: "public" | "household" | "input" | "output" | "investment" | "reserves";
  readonly delta: number;
}

/**
 * Physical loss record: attributed destruction of goods/capital/population.
 */
export interface PhysicalLossRecord extends BaseLedgerRecord {
  readonly type: "PHYSICAL_LOSS";
  readonly resourceType: "good" | "capital" | "population" | "deposit";
  readonly resourceId: string;
  readonly locationKey: RegionId | ProductionUnitId | CohortId;
  readonly amount: number;
  readonly cause: "spoilage" | "depreciation" | "event" | "consumption" | "extraction";
}

export type LedgerRecord = MoneyFlowRecord | GoodFlowRecord | PhysicalLossRecord;

/**
 * Tick-level ledger accumulating all flow records during orchestration.
 * Immutable after tick completion.
 */
export interface TickLedger {
  readonly tick: number;
  readonly records: ReadonlyArray<LedgerRecord>;
}

/**
 * Reconciliation result for a single stock category.
 */
export interface StockReconciliation {
  readonly category: "MONEY" | "GOOD" | "POPULATION" | "CAPITAL" | "RESOURCE";
  readonly key: string;
  readonly expected: number;
  readonly actual: number;
  readonly delta: number;
  readonly withinTolerance: boolean;
}

/**
 * Create an empty tick ledger.
 */
export function createEmptyTickLedger(tick: number): TickLedger {
  return { tick, records: [] };
}

/**
 * Add a record to a tick ledger (returns a new ledger instance).
 * Validates PHYSICAL_LOSS records to reject non-finite or invalid amounts.
 */
export function addLedgerRecord(
  ledger: TickLedger,
  record: LedgerRecord
): TickLedger {
  // Validate PHYSICAL_LOSS records: amount must be finite and positive
  if (record.type === "PHYSICAL_LOSS") {
    const r = record as PhysicalLossRecord;
    if (!Number.isFinite(r.amount)) {
      throw new Error(
        `PHYSICAL_LOSS amount must be finite; got ${r.amount}`
      );
    }
    if (r.amount < 0) {
      throw new Error(
        `PHYSICAL_LOSS amount must be non-negative (loss magnitude >= 0); got ${r.amount}`
      );
    }
  }

  return {
    tick: ledger.tick,
    records: [...ledger.records, record],
  };
}

/**
 * Compute net flow for a given stock key across all records of a category.
 * MONEY flows are keyed by currencyId only (conserved asset, independent of owner).
 * GOOD flows are keyed by goodId only (conserved asset, independent of holder/bucket).
 * PHYSICAL_LOSS flows are keyed by resourceId:locationKey for tracking loss source.
 */
export function computeNetFlow(
  ledger: TickLedger,
  category: "MONEY" | "GOOD" | "PHYSICAL_LOSS"
): Map<string, number> {
  const flows = new Map<string, number>();

  for (const record of ledger.records) {
    if (record.type !== category) continue;

    let key: string;
    let delta: number;

    if (record.type === "MONEY") {
      const r = record as MoneyFlowRecord;
      key = r.currencyId;
      delta = r.delta;
    } else if (record.type === "GOOD") {
      const r = record as GoodFlowRecord;
      key = r.goodId;
      delta = r.delta;
    } else {
      const r = record as PhysicalLossRecord;
      key = `${r.resourceId}:${r.locationKey}`;
      delta = r.amount;
    }

    const current = flows.get(key) ?? 0;
    flows.set(key, current + delta);
  }

  return flows;
}

/**
 * Validate zero-flow reconciliation for a ledger.
 * Checks that transfer flows (MONEY and GOOD) sum to zero per stock key (conservation law).
 * Physical loss is a one-sided sink and is not subject to zero-sum validation.
 * Returns null if reconciliation passes, or a list of unmatched flows by category/key.
 */
export function validateZeroFlowReconciliation(
  ledger: TickLedger,
  tolerance: number = 1e-9
): { category: string; key: string; residual: number }[] | null {
  const unmatched: { category: string; key: string; residual: number }[] = [];

  // Compute net flows keyed by stock identifier
  const moneyFlows = computeNetFlow(ledger, "MONEY");
  const goodFlows = computeNetFlow(ledger, "GOOD");

  // Check MONEY flows: each key must sum to zero
  for (const [key, residual] of moneyFlows.entries()) {
    if (Math.abs(residual) > tolerance) {
      unmatched.push({ category: "MONEY", key, residual });
    }
  }

  // Check GOOD flows: each key must sum to zero
  for (const [key, residual] of goodFlows.entries()) {
    if (Math.abs(residual) > tolerance) {
      unmatched.push({ category: "GOOD", key, residual });
    }
  }

  // PHYSICAL_LOSS is not subject to zero-sum validation:
  // it represents one-sided destruction, not transfers.
  // Its validity is enforced by the owning contract (finite, proper sign, attribution).

  return unmatched.length > 0 ? unmatched : null;
}
