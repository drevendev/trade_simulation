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
  type MarketExpectationState,
  type MonetaryAuthorityState,
  type ProductionUnitState,
  type RegionState,
  type StateState,
  type TransportLinkState,
  type WorldState,
  type PendingTransitions,
} from "./worldState";

export {
  TOTAL_PHASES,
  PHASE_NAMES,
  initializeTickContext,
  executePhase,
  executeTick,
  computeTickHash,
  noOpPhaseHandler,
  validateTickInvariants,
  createTransactionId,
  createTransactionBundleId,
  createFxSettlementId,
  type TickContext,
  type EconomicTransaction,
  type TransactionId,
  type TransactionBundleId,
  type FxSettlementId,
  type PhaseHandler,
} from "./tickOrchestrator";

export {
  createEmptyTickLedger,
  addLedgerRecord,
  computeNetFlow,
  validateZeroFlowReconciliation,
  type BaseLedgerRecord,
  type MoneyFlowRecord,
  type GoodFlowRecord,
  type PhysicalLossRecord,
  type LedgerRecord,
  type TickLedger,
  type StockReconciliation,
} from "./ledger";

export {
  projectM2DiagnosticTick,
  aggregateM2DiagnosticRun,
  type FlowSummary,
  type M2DiagnosticTickProjection,
  type M2DiagnosticRunProjection,
} from "./m2DiagnosticProjection";

export {
  calculateMarketPressure,
  calculateLogPriceChange,
  applyLogPriceChange,
  repriceGoodInPhase6,
  updateMarketExpectations,
} from "./marketPricing";

export {
  computeConsumptionTax,
  preflightMarketSettlement,
  createMarketSaleTransaction,
  createConsumptionTaxTransaction,
  executeMarketSettlement,
  type TaxPolicyProvider,
  type MarketSettlementBundle,
} from "./marketSettlement";
