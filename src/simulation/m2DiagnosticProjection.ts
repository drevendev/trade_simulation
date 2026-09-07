/**
 * M2 diagnostic projection for Milestone Preview visualization (REQ-CORE-006).
 *
 * Normalized read-only view of MONEY/GOOD/PHYSICAL_LOSS flows with tick/phase/owner attribution.
 * One-way export: does not mutate WorldState or affect replay hash.
 * Used by Milestone Preview on GitHub Pages.
 */

import type { TickLedger, MoneyFlowRecord, GoodFlowRecord, PhysicalLossRecord } from "./ledger";
import type { CurrencyId } from "../domain/id";

/**
 * Aggregated flow summary per stock key and phase.
 */
export interface FlowSummary {
  readonly tick: number;
  readonly phase: number;
  readonly category: "MONEY" | "GOOD" | "PHYSICAL_LOSS";
  readonly key: string; // e.g., "USD:state:STATE_1" or "WHEAT:cohort:COHORT_42:household"
  readonly ownerType: string;
  readonly ownerKey: string;
  readonly totalDelta: number; // Sum of all deltas for this key in this phase
  readonly recordCount: number; // Number of individual records contributing to this summary
}

/**
 * M2 diagnostic projection summary for a single tick's ledger.
 */
export interface M2DiagnosticTickProjection {
  readonly tick: number;
  readonly ledgerRecordCount: number;
  readonly flowSummaries: ReadonlyArray<FlowSummary>;
  readonly reconciliationStatus: {
    readonly passed: boolean;
    readonly unmatched: ReadonlyArray<{
      readonly category: string;
      readonly residual: number;
    }>;
  };
}

/**
 * Aggregate ledger records by tick/phase/key into flow summaries for visualization.
 * Groups all deltas for a given stock key and phase to simplify preview rendering.
 */
export function projectM2DiagnosticTick(
  ledger: TickLedger,
  reconciliationErrors: { category: string; residual: number }[] | null,
): M2DiagnosticTickProjection {
  const summaryMap = new Map<string, FlowSummary>();

  for (const record of ledger.records) {
    let key: string;
    let ownerType: string;
    let ownerKey: string;
    let delta: number;

    if (record.type === "MONEY") {
      const r = record as MoneyFlowRecord;
      key = `${r.currencyId}:${r.ownerType}:${r.ownerKey}`;
      ownerType = r.ownerType;
      ownerKey = r.ownerKey;
      delta = r.delta;
    } else if (record.type === "GOOD") {
      const r = record as GoodFlowRecord;
      key = `${r.goodId}:${r.holderType}:${r.holderKey}:${r.bucket}`;
      ownerType = r.holderType;
      ownerKey = r.holderKey;
      delta = r.delta;
    } else {
      const r = record as PhysicalLossRecord;
      key = `${r.resourceId}:${r.locationKey}`;
      ownerType = `${r.cause}_loss`;
      ownerKey = r.locationKey;
      delta = r.amount; // Always non-positive for losses
    }

    // Aggregate by category + key + phase
    const summaryKey = `${record.type}:${key}:${record.phase}`;
    const existing = summaryMap.get(summaryKey);

    if (existing) {
      summaryMap.set(summaryKey, {
        ...existing,
        totalDelta: existing.totalDelta + delta,
        recordCount: existing.recordCount + 1,
      });
    } else {
      summaryMap.set(summaryKey, {
        tick: ledger.tick,
        phase: record.phase,
        category: record.type as "MONEY" | "GOOD" | "PHYSICAL_LOSS",
        key,
        ownerType,
        ownerKey,
        totalDelta: delta,
        recordCount: 1,
      });
    }
  }

  return {
    tick: ledger.tick,
    ledgerRecordCount: ledger.records.length,
    flowSummaries: Array.from(summaryMap.values()).sort((a, b) => {
      // Stable sort: by category, then phase, then key
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      if (a.phase !== b.phase) return a.phase - b.phase;
      return a.key.localeCompare(b.key);
    }),
    reconciliationStatus: {
      passed: reconciliationErrors === null,
      unmatched: reconciliationErrors ?? [],
    },
  };
}

/**
 * Aggregate multiple tick projections into a summary for the Milestone Preview.
 * Shows tick range, phase coverage and reconciliation health.
 */
export interface M2DiagnosticRunProjection {
  readonly firstTick: number;
  readonly lastTick: number;
  readonly tickCount: number;
  readonly totalRecordCount: number;
  readonly reconciliationPassCount: number;
  readonly reconciliationFailCount: number;
  readonly failedTicks: ReadonlyArray<{
    readonly tick: number;
    readonly errors: ReadonlyArray<{
      readonly category: string;
      readonly residual: number;
    }>;
  }>;
}

/**
 * Aggregate tick projections into run summary for Milestone Preview display.
 */
export function aggregateM2DiagnosticRun(
  tickProjections: ReadonlyArray<M2DiagnosticTickProjection>,
): M2DiagnosticRunProjection {
  let totalRecordCount = 0;
  let reconciliationPassCount = 0;
  let reconciliationFailCount = 0;
  const failedTicks: {
    readonly tick: number;
    readonly errors: ReadonlyArray<{
      readonly category: string;
      readonly residual: number;
    }>;
  }[] = [];

  for (const proj of tickProjections) {
    totalRecordCount += proj.ledgerRecordCount;
    if (proj.reconciliationStatus.passed) {
      reconciliationPassCount++;
    } else {
      reconciliationFailCount++;
      failedTicks.push({
        tick: proj.tick,
        errors: proj.reconciliationStatus.unmatched,
      });
    }
  }

  const firstTick = tickProjections.length > 0 ? tickProjections[0]!.tick : 0;
  const lastTick = tickProjections.length > 0 ? tickProjections[tickProjections.length - 1]!.tick : 0;

  return {
    firstTick,
    lastTick,
    tickCount: tickProjections.length,
    totalRecordCount,
    reconciliationPassCount,
    reconciliationFailCount,
    failedTicks,
  };
}
