/**
 * Canonical tick orchestrator and 16-phase framework (REQ-CORE-004).
 *
 * Implements WorldState immutability during a tick, TickContext for ephemeral state,
 * PendingTransitions for deterministic causality, and the 16-phase execution pipeline
 * with no-op handlers in M2.
 *
 * Phase order (0–15) is documented in CORE_SCHEMA_AND_LIFECYCLES.md section 10.
 */

import type { RegionId, StateId, CurrencyId, CohortId, ProductionUnitId, MonetaryAuthorityId } from "../domain/id";
import type { WorldState } from "./worldState";
import type { LedgerRecord } from "./ledgerReconciliation";
import { createHash } from "crypto";

/**
 * Ephemeral per-tick state, reset every phase-0 tick start.
 * Plans are immutable intent created in Phase 2; transaction records accumulate.
 */
export interface TickContext {
  readonly tick: number;
  readonly phase: number;
  readonly effectiveJurisdictionByRegion: ReadonlyMap<RegionId, StateId | null>;
  readonly rngSeed: number;
  readonly transactions: ReadonlyArray<EconomicTransaction>;
  readonly ledgerRecords: ReadonlyArray<LedgerRecord>;
}

/**
 * M2 minimum accounting ledger contract.
 * Normalized projection of committed stock mutations with tick/phase/reason attribution.
 */
export interface EconomicTransaction {
  readonly tick: number;
  readonly phase: number;
  readonly type: string;
  readonly currencyId?: CurrencyId;
  readonly goodId?: string;
  readonly amount: number;
  readonly reason: string;
}

/**
 * Pending regime/policy changes queued for phase N+1 and later activation.
 * Deterministic causality: Phase-14 decisions cannot affect Phase N effective jurisdiction.
 */
export interface PendingTransitions {
  readonly jurisdictionChanges: ReadonlyArray<{
    readonly regionId: RegionId;
    readonly nextControllerStateId: StateId | null;
    readonly activateTick: number;
  }>;
  readonly policyChanges: ReadonlyArray<{
    readonly stateId: StateId;
    readonly patch: unknown;
    readonly activateTick: number;
  }>;
  readonly monetaryPolicyChanges: ReadonlyArray<{
    readonly authorityId: MonetaryAuthorityId;
    readonly patch: unknown;
    readonly activateTick: number;
  }>;
}

export const PHASE_NAMES = [
  "BeginTick",
  "Activate carried regime and scheduled operations",
  "Expectations and planning",
  "Labor allocation",
  "Pre-production procurement",
  "Production/extraction and wage settlement",
  "Main-market offer/price formation",
  "Interregional/international shipment planning and settlement",
  "Residual local main-market clearing",
  "Realized consumption and needs",
  "Fiscal settlement and income distribution",
  "Monetary bookkeeping/reconciliation",
  "Depreciation, spoilage, investment and settlement construction",
  "Demography, social mobility and migration",
  "Slow territorial/lifecycle review",
  "Accounting, metrics, policy review and snapshot",
] as const;

export const TOTAL_PHASES = 16 as const;

/**
 * Phase handler function type. Receives immutable WorldState + TickContext,
 * returns new TickContext with accumulated transactions and mutations.
 * In M2, handlers are no-op and WorldState is not modified until snapshot.
 */
export type PhaseHandler = (
  world: WorldState,
  context: TickContext,
  pendingTransitions: PendingTransitions,
) => TickContext;

/**
 * Initialize TickContext for tick N.
 * Phase-0 resets flow telemetry and derives deterministic RNG substreams.
 */
export function initializeTickContext(tick: number, seed: number): TickContext {
  return {
    tick,
    phase: 0,
    effectiveJurisdictionByRegion: new Map(),
    rngSeed: seed ^ tick, // Deterministic per-tick seed
    transactions: [],
    ledgerRecords: [],
  };
}

/**
 * Execute one phase within a tick.
 * Handler receives immutable state and returns updated context with new transactions.
 * No-op handlers in M2 return context unchanged.
 */
export function executePhase(
  phaseNumber: number,
  handler: PhaseHandler,
  world: WorldState,
  context: TickContext,
  pendingTransitions: PendingTransitions,
): TickContext {
  if (phaseNumber < 0 || phaseNumber >= TOTAL_PHASES) {
    throw new Error(
      `Invalid phase ${phaseNumber}: must be 0–${TOTAL_PHASES - 1}`,
    );
  }

  const newContext: TickContext = {
    ...context,
    phase: phaseNumber,
  };

  return handler(world, newContext, pendingTransitions);
}

/**
 * Execute one complete tick (phases 0–15) with no-op handlers.
 * Returns trace of phase execution for determinism proof.
 * WorldState remains immutable; TickContext carries tick-scoped mutations.
 */
export function executeTick(
  world: WorldState,
  tickNumber: number,
  pendingTransitions: PendingTransitions,
  noOpHandler: PhaseHandler,
): { context: TickContext; phaseTrace: number[] } {
  let context = initializeTickContext(tickNumber, world.seed);
  const phaseTrace: number[] = [];

  for (let phase = 0; phase < TOTAL_PHASES; phase++) {
    context = executePhase(phase, noOpHandler, world, context, pendingTransitions);
    phaseTrace.push(phase);
  }

  return { context, phaseTrace };
}

/**
 * Compute deterministic replay hash for a tick.
 * Used to prove determinism across identical seed/config/scenario inputs.
 * M2 no-op scenario produces stable hash independent of unrelated iteration order.
 */
export function computeTickHash(
  world: WorldState,
  context: TickContext,
): string {
  const hash = createHash("sha256");

  hash.update(JSON.stringify({
    tick: context.tick,
    configVersion: world.configVersion,
    scenarioId: world.scenarioId,
    seed: world.seed,
    phaseTrace: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    transactionCount: context.transactions.length,
  }));

  return hash.digest("hex");
}

/**
 * Default no-op phase handler for M2: returns context unchanged.
 * Proves phase order and determinism without implementing economic behavior.
 */
export const noOpPhaseHandler: PhaseHandler = (
  _world: WorldState,
  context: TickContext,
  _pendingTransitions: PendingTransitions,
): TickContext => {
  return context;
};
