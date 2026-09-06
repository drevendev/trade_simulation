/**
 * Simulation module area (REQ-MIGRATION-003 scaffolding).
 *
 * Owns WorldState, TickContext, the phase orchestrator, reconciliation and
 * the keyed deterministic RNG service from Milestone 1 onward. Deliberately
 * empty of behavior in M0 — see AGENTS.md and ADR 0002.
 */
export const SIMULATION_MODULE_AREA = "simulation" as const;

export {
  buildInitialWorld,
  type ClanState,
  type CohortState,
  type CurrencyState,
  type LocalMarketState,
  type MonetaryAuthorityState,
  type ProductionUnitState,
  type RegionState,
  type StateState,
  type TransportLinkState,
  type WorldState,
} from "./worldState";

export {
  TOTAL_PHASES,
  PHASE_NAMES,
  initializeTickContext,
  executePhase,
  executeTick,
  computeTickHash,
  noOpPhaseHandler,
  type TickContext,
  type EconomicTransaction,
  type PendingTransitions,
  type PhaseHandler,
} from "./tickOrchestrator";

export {
  createEmptyRuntimeLedger,
  addMoneyFlow,
  addGoodFlow,
  addPhysicalLoss,
  createMoneyFlow,
  createGoodFlow,
  createPhysicalLoss,
  validateLedgerFlow,
  type LedgerFlow,
  type MoneyFlow,
  type GoodFlow,
  type PhysicalLoss,
  type RuntimeLedger,
  type StockOwner,
} from "./ledgerFlow";

export {
  reconcileTickFlows,
  buildDiagnosticProjection,
  type ReconciliationResult,
  type UnmatchedDelta,
  type ReconciliationDiagnostics,
} from "./reconciliation";

export {
  createEmptyInvariantRegistry,
  registerPhaseInvariant,
  executePhaseInvariants,
  createConservationInvariant,
  createFiniteValueInvariant,
  createDefaultInvariantRegistry,
  type InvariantRegistry,
  type InvariantHook,
} from "./invariantHooks";
