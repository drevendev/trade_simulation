/**
 * Phase-level invariant hooks for M2 (REQ-CORE-006).
 *
 * Provides fail-fast diagnostic mode and reconciliation gates
 * after each phase or tick completion.
 */

import type { WorldState } from "./worldState";
import type { TickContext } from "./tickOrchestrator";
import type { SimulationConfig } from "../config/simulationConfig";
import { reconcileTickLedger, type ReconciliationFailure } from "./ledgerReconciliation";

/**
 * Invariant check result.
 */
export interface InvariantCheckResult {
  readonly passed: boolean;
  readonly failures: readonly InvariantFailure[];
}

/**
 * Single invariant failure.
 */
export interface InvariantFailure {
  readonly invariantId: string;
  readonly description: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Check ledger reconciliation after phase 15 (full tick completion).
 * M2 zero-flow ticks should have all ledger records balanced.
 */
export function checkLedgerReconciliation(
  world: WorldState,
  context: TickContext,
): InvariantCheckResult {
  const failure = reconcileTickLedger(context.ledgerRecords, world.simulationConfig);

  if (!failure) {
    return { passed: true, failures: [] };
  }

  return {
    passed: false,
    failures: [
      {
        invariantId: "LEDGER_RECONCILIATION",
        description: failure.reason,
        details: {
          category: failure.category,
          key: failure.key,
          residual: failure.residual,
          tolerance: failure.tolerance,
        },
      },
    ],
  };
}

/**
 * Check that all numbers in the tick ledger are finite.
 */
export function checkFiniteNumbers(
  context: TickContext,
): InvariantFailure[] {
  const failures: InvariantFailure[] = [];

  for (const record of context.ledgerRecords) {
    if (!Number.isFinite(record.delta)) {
      failures.push({
        invariantId: "FINITE_LEDGER_DELTAS",
        description: `Non-finite delta in ledger record: ${record.type} tick=${record.tick} phase=${record.phase} delta=${record.delta}`,
        details: {
          recordType: record.type,
          tick: record.tick,
          phase: record.phase,
          delta: record.delta,
        },
      });
    }
  }

  return failures;
}

/**
 * Comprehensive invariant suite for phase-15 completion.
 */
export function checkPhase15Invariants(
  world: WorldState,
  context: TickContext,
): InvariantCheckResult {
  const allFailures: InvariantFailure[] = [];

  // Check finite numbers
  allFailures.push(...checkFiniteNumbers(context));

  // Check ledger reconciliation
  const reconResult = checkLedgerReconciliation(world, context);
  allFailures.push(...reconResult.failures);

  return {
    passed: allFailures.length === 0,
    failures: allFailures,
  };
}
