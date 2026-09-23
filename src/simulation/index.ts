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
  INITIAL_LIFECYCLE_REVIEW_TICK,
  createInitialProductionSignalState,
  deriveNameplateCapacity,
  validateProductionUnitPersistentState,
  type ProductionSignalState,
  type ProductionUnitLifecycleStatus,
  type ProductionUnitPersistentStateView,
} from "./productionUnitState";

export {
  createPhase2ProductionPlanningHandler,
  planProductionUnitPhase2,
  type LaborDemandPlan,
  type ProductionPlan,
  type ProductionPlanningEvidence,
  type ProductionPlanningResult,
} from "./productionPlanning";

export {
  createPhase2LaborSupplyPlanningHandler,
  generateLaborSupplyPlansPhase2,
  planCohortLaborSupplyPhase2,
  type LaborSupplyPlan,
} from "./laborSupplyPlanning";

export {
  createPhase2HouseholdConsumptionPlanningHandler,
  getHouseholdBudgetEnvelopeName,
  planHouseholdConsumptionPhase2,
  type HouseholdCategoryBudget,
  type HouseholdConsumptionPlan,
  type HouseholdConsumptionPlanningOptions,
  type HouseholdConsumptionPlanningResult,
  type HouseholdSubstitutionShare,
} from "./householdConsumptionPlanning";

export {
  applyHouseholdConsumptionTransition,
  createPhase9HouseholdConsumptionHandler,
  planHouseholdConsumptionPhase9,
  type HouseholdConsumptionExecution,
  type HouseholdConsumptionExecutionResult,
  type HouseholdConsumptionPhase9Input,
  type HouseholdEconomicEvidence,
  type HouseholdNeedRealization,
} from "./householdConsumptionExecution";

export {
  allocateLaborPhase3,
  createPhase3LaborAllocationHandler,
  type LaborAllocation,
} from "./laborAllocation";

export {
  applyWageOfferStateTransition,
  createPhase15WageOfferUpdateHandler,
  planWageOfferUpdatesPhase15,
  type WageOfferUpdate,
} from "./wageOfferUpdate";

export {
  applyWageSettlementTransition,
  createPhase5WageSettlementHandler,
  getPostWageSpendableBalance,
  planWageSettlementsPhase5,
  type WagePaymentTransaction,
  type WageSettlement,
  type WageTaxPolicyProvider,
  type WageTaxWithheldTransaction,
} from "./wageSettlement";

export {
  applyProductionExecutionTransition,
  buildProductionOutputSellIntentsPhase5,
  createPhase5ProductionExecutionHandler,
  planProductionExecutionsPhase5,
  resolveRegionResourceDeposits,
  type ProductionExecution,
  type ProductionExecutionPlanResult,
} from "./productionExecution";

export {
  applyCapitalFormationTransition,
  createPhase12CapitalFormationHandler,
  planCapitalFormationPhase12,
  type CapitalFormationExecution,
  type CapitalFormationPlanResult,
} from "./capitalFormation";

export {
  applyProductionUnitLifecycleReviewTransition,
  applyProductionUnitLifecycleTransitionsAtPhase1,
  applyProductionUnitOwnerFundingTransition,
  createPhase14ProductionUnitLifecycleHandler,
  isProductionUnitSafeForRetirement,
  planProductionUnitLifecyclePhase14,
  type ProductionUnitLifecyclePlanResult,
  type ProductionUnitLifecycleReadiness,
  type ProductionUnitLifecycleReview,
  type ProductionUnitOwnerFundingRequest,
} from "./productionUnitLifecycle";

export {
  planPlannedStartupInvestmentPhase2,
  type PlannedStartupInvestmentResult,
  type PlannedStartupPlanningEvidence,
} from "./productionStartupPlanning";

export {
  TOTAL_PHASES,
  PHASE_NAMES,
  initializeTickContext,
  executePhase,
  executeTick,
  computeTickHash,
  noOpPhaseHandler,
  composePhaseHandlers,
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

export {
  executeStatefulTick,
  type PhaseWorldTransition,
  type StatefulTickExecutionResult,
} from "./statefulTickOrchestrator";

export {
  executeM4ClosedEconomyTick,
  type M4ClosedEconomyOptions,
} from "./m4ClosedEconomyOrchestrator";
