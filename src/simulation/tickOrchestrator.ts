/**
 * Canonical tick orchestrator and 16-phase framework (REQ-CORE-004).
 *
 * Implements WorldState immutability during a tick, TickContext for ephemeral state,
 * PendingTransitions for deterministic causality, and the 16-phase execution pipeline
 * with no-op handlers in M2.
 *
 * Phase order (0–15) is documented in CORE_SCHEMA_AND_LIFECYCLES.md section 10.
 */

import type { RegionId, StateId, CurrencyId, CohortId, ProductionUnitId, MonetaryAuthorityId, GoodId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import type { WorldState, PendingTransitions } from "./worldState";
import type { TickLedger } from "./ledger";
import { createEmptyTickLedger, validateZeroFlowReconciliation } from "./ledger";
import type { BudgetCommitmentLedger } from "./marketIntent";
import { createEmptyBudgetCommitmentLedger } from "./marketIntent";
import type { LocalMarketTelemetry } from "./marketTelemetry";
import { createHash } from "crypto";

/**
 * Ephemeral per-tick state, reset every phase-0 tick start.
 * Plans are immutable intent created in Phase 2; transaction records accumulate.
 * M2: currentLedger accumulates typed MONEY/GOOD/PHYSICAL_LOSS flow records across phases.
 * M3+: budgetLedger tracks actor+currency+envelope commitments for market planning.
 * M3+: marketTelemetry accumulates LocalMarketTelemetry from Phase-8 clearing/settlement.
 */
export interface TickContext {
  readonly tick: number;
  readonly phase: number;
  readonly effectiveJurisdictionByRegion: ReadonlyMap<RegionId, StateId | null>;
  readonly rngSeed: number;
  readonly transactions: ReadonlyArray<EconomicTransaction>;
  readonly currentLedger: TickLedger;
  readonly budgetLedger: BudgetCommitmentLedger;
  readonly marketTelemetry: LocalMarketTelemetry[];
}

/** Opaque transaction ID (tx:...) */
export type TransactionId = string & { readonly __brand: "TransactionId" };

export function createTransactionId(value: string): TransactionId {
  if (!value.startsWith("tx:")) {
    throw new Error(`TransactionId must start with "tx:", got ${value}`);
  }
  return value as TransactionId;
}

/** Opaque transaction bundle ID (tb:...) */
export type TransactionBundleId = string & { readonly __brand: "TransactionBundleId" };

export function createTransactionBundleId(value: string): TransactionBundleId {
  if (!value.startsWith("tb:")) {
    throw new Error(`TransactionBundleId must start with "tb:", got ${value}`);
  }
  return value as TransactionBundleId;
}

/** Opaque FX settlement ID (fxs:...) */
export type FxSettlementId = string & { readonly __brand: "FxSettlementId" };

export function createFxSettlementId(value: string): FxSettlementId {
  if (!value.startsWith("fxs:")) {
    throw new Error(`FxSettlementId must start with "fxs:", got ${value}`);
  }
  return value as FxSettlementId;
}

/**
 * M2 minimum accounting ledger contract.
 * Normalized projection of committed stock mutations with tick/phase/reason attribution.
 *
 * Extended for M3+ with transaction IDs, bundling, and actor/good endpoints.
 * Supports MARKET_SALE and CONSUMPTION_TAX transaction types for local market settlement.
 */
export interface EconomicTransaction {
  readonly tick: number;
  readonly phase: number;
  readonly type: string;
  readonly transactionId: TransactionId;
  readonly bundleId?: TransactionBundleId;
  readonly originatingTransactionId?: TransactionId;
  readonly fxSettlementId?: FxSettlementId;
  readonly source?: ActorRef;
  readonly destination?: ActorRef;
  readonly currencyId?: CurrencyId;
  readonly goodId?: GoodId;
  readonly quantity?: number;
  readonly unitPrice?: number;
  readonly moneyAmount?: number;
  readonly taxAmount?: number;
  readonly sourceRegionId?: RegionId;
  readonly destinationRegionId?: RegionId;
  readonly amount: number;
  readonly reason?: string;
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
 * M2: currentLedger is initialized empty and accumulates records across phases.
 * M3+: budgetLedger is initialized empty for market planning phase handlers.
 * M3+: marketTelemetry is initialized empty for Phase-8 clearing telemetry.
 */
export function initializeTickContext(tick: number, seed: number): TickContext {
  return {
    tick,
    phase: 0,
    effectiveJurisdictionByRegion: new Map(),
    rngSeed: seed ^ tick, // Deterministic per-tick seed
    transactions: [],
    currentLedger: createEmptyTickLedger(tick),
    budgetLedger: createEmptyBudgetCommitmentLedger(),
    marketTelemetry: [],
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
 * Validate phase-level invariants after tick completion.
 * M2: Checks zero-flow reconciliation for the accumulated ledger.
 * Returns validation result: null if passes, array of unmatched flows (keyed) if fails.
 */
export function validateTickInvariants(
  context: TickContext,
  tolerance: number = 1e-9,
): { category: string; key: string; residual: number }[] | null {
  return validateZeroFlowReconciliation(context.currentLedger, tolerance);
}

export interface PhaseBoundaryValidationError {
  readonly phase: number;
  readonly errors: { category: string; key: string; residual: number }[];
}

/**
 * Execute one complete tick (phases 0–15) with phase-boundary validation.
 * Returns trace of phase execution for determinism proof.
 * WorldState remains immutable; TickContext carries tick-scoped mutations.
 * M2: Validates zero-flow reconciliation after each phase boundary (fail-fast).
 * If a phase-boundary validation fails, returns error details and stops before next phase.
 */
export function executeTick(
  world: WorldState,
  tickNumber: number,
  pendingTransitions: PendingTransitions,
  noOpHandler: PhaseHandler,
): { context: TickContext; phaseTrace: number[]; phaseBoundaryError?: PhaseBoundaryValidationError; reconciliationErrors: { category: string; key: string; residual: number }[] | null } {
  let context = initializeTickContext(tickNumber, world.seed);
  const phaseTrace: number[] = [];
  const tolerance = world.simulationConfig.numeric.reconciliationRelativeTolerance;

  for (let phase = 0; phase < TOTAL_PHASES; phase++) {
    context = executePhase(phase, noOpHandler, world, context, pendingTransitions);
    phaseTrace.push(phase);

    // Validate phase-boundary invariants before proceeding to next phase
    const boundaryErrors = validateTickInvariants(context, tolerance);
    if (boundaryErrors !== null) {
      // Phase-boundary validation failed: report error and stop
      return {
        context,
        phaseTrace,
        phaseBoundaryError: {
          phase,
          errors: boundaryErrors,
        },
        reconciliationErrors: boundaryErrors,
      };
    }
  }

  // All phases passed: tick invariants are satisfied
  return { context, phaseTrace, reconciliationErrors: null };
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
