/**
 * M5 / Issue #673: opt-in end-to-end composition of existing canonical owners.
 *
 * This deliberately adds NO trading formula or policy default. The actual
 * Phase-2 production planner, paid regional Phase-4 settlements, Phase-6 prices,
 * Phase-1 trade law/tax/tariff snapshots and Phase-7 route/FX/cargo authorities
 * already exist. This seam makes the route-request decision automatic instead
 * of requiring a caller to construct a fresh set of maps every tick.
 *
 * Phase-5 production, Phase-8 local clearing and other phase transitions stay
 * with the supplied upstream handler/transition. Cross-border goods still
 * dispatch in Phase 7 only, and M5 is NOT complete merely by using this seam.
 */
import type { TransportLinkId } from "../domain/id";
import type { WorldState } from "./worldState";
import type { PhaseHandler } from "./tickOrchestrator";
import type {
  PhaseWorldTransition, PhaseWorldTransitionObserver,
  StatefulTickExecutionResult,
} from "./statefulTickOrchestrator";
import type { Phase7CandidateScorePolicy } from "./tradeCandidateSelection";
import type { TransportFeeCostPolicy } from "./transportFeeQuote";
import type { Phase7Phase1TradeLawProvider } from "./phase7AuthorizedRouteDiscovery";
import type { Phase7Phase1TariffLawProvider } from "./phase7Phase1TariffCapture";
import { phase9HouseholdHandler, type M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import { applyHouseholdConsumptionTransition } from "./householdConsumptionExecution";
import { createPhase2HouseholdConsumptionPlanningHandler } from "./householdConsumptionPlanning";
import { createPhase2LaborSupplyPlanningHandler } from "./laborSupplyPlanning";
import { createPhase3LaborAllocationHandler } from "./laborAllocation";
import { createPhase5WageSettlementHandler, applyWageSettlementTransition } from "./wageSettlement";
import { createPhase5ProductionExecutionHandler, applyProductionExecutionTransition } from "./productionExecution";
import { createM5CanonicalRegionalPhase2Bridge } from "./m5SettledPhase4Bridge";
import { executeM5CanonicalIntakeTradeTick } from "./m5LiveQuotedTradeTick";
import { createPhase8Handler } from "./phase8MainMarketClearing";
import { executeMarketSettlement } from "./marketSettlement";
import { applyMarketSettlementTransition } from "./marketSettlementTransition";
import { applyMarketStateTransition } from "./marketStateTransition";
import {
  captureFxCloseOpening, reconcileAndPlanFxClose, publishFxClose,
  type FxClosePolicy, type FxMonetaryClose,
} from "./fxMonetaryClose";

export interface M5AutonomousRegionalTradeOptions {
  /** Same source of consumption-tax authority in Phase 4 and frozen Phase 1. */
  readonly procurement: M4ClosedEconomyOptions;
  /** No implicit scoring weights or thresholds. */
  readonly scorePolicy: Phase7CandidateScorePolicy;
  /** No implicit transport-fee condition bounds. */
  readonly transportFeeCostPolicy: TransportFeeCostPolicy;
  /** Explicit current infrastructure factors, not an assumed 1. */
  readonly infrastructureFactors: ReadonlyMap<TransportLinkId, number>;
  readonly phase1TradeLawProvider: Phase7Phase1TradeLawProvider;
  readonly phase1TariffLawProvider: Phase7Phase1TariffLawProvider;
  /** Explicit opt-in: Phase-8 local MAIN clearing and paid physical settlement
   * from Phase-7 committed residuals, replacing caller-owned Phase-8 hooks.
   * Omit to retain backward-compatible upstream Phase-8 authority. */
  readonly settleMainMarketInPhase8?: true;
  /** Explicit opt-in: derive Phase-2 household budgets and local BUY intents from
   * the canonical live CohortState and prior-close prices. Replaces any
   * upstream household plans/intents; duplicate owners fail closed. */
  readonly planHouseholdNeedsInPhase2?: true;
  /** Explicit opt-in: own complete Phase-2 labor supply, Phase-3 matching and
   * Phase-5 wage plus physical production settlement from canonical M4 handlers.
   * Phase-2 production demand already comes from the M5 regional bridge.
   * Competing upstream labor/production evidence is rejected. Omit to retain
   * caller-owned Phase-3/5 behavior. */
  readonly settleLaborAndProductionInPhase5?: true;
  /** Explicit opt-in: realize the already-settled Phase-8 household inventories
   * at Phase 9, including physical consumption/spoilage and loss receipts.
   * Replaces upstream Phase-9 handler/transition to prevent double realization.
   * Requires canonical need categories; no fallback needs are invented. */
  readonly realizeHouseholdConsumptionInPhase9?: true;
  /** Own Phase-11 reconciliation and publish N+1 quote metadata at Phase-15 close.
   * Explicit coefficients; no implied M7 policy or hidden numerical defaults. */
  readonly closeFxAtPhase11?: FxClosePolicy;
}

/**
 * Complete the existing regional Phase-2 -> paid Phase-4 -> Phase-6 -> Phase-7
 * pipeline without externally supplied production/route/FX/cargo intentions.
 * The only policy inputs are explicit independent authorities. All trade
 * quantities and reservations are rederived from THIS tick's WorldState.
 * A missing or ambiguous FX pool, policy, price or capacity fails closed.
 */
export function executeM5AutonomousRegionalTradeTick(
  openingWorld: WorldState,
  tickNumber: number,
  upstreamHandler: PhaseHandler,
  applyOtherPhaseTransition: PhaseWorldTransition,
  options: M5AutonomousRegionalTradeOptions,
  observePhaseTransition?: PhaseWorldTransitionObserver,
): StatefulTickExecutionResult {
  if (!(options.infrastructureFactors instanceof Map)) {
    throw new Error("M5 autonomous regional trade requires explicit infrastructure factors");
  }
  // Detach caller-owned objects before any phase handler executes.
  const infrastructureFactors = new Map(options.infrastructureFactors);
  const scorePolicy = { ...options.scorePolicy };
  const transportFeeCostPolicy = { ...options.transportFeeCostPolicy };
  const fxPolicy = options.closeFxAtPhase11 === undefined ? undefined : { ...options.closeFxAtPhase11 };
  const fxOpening = fxPolicy === undefined ? undefined : captureFxCloseOpening(openingWorld, tickNumber);
  let fxClose: FxMonetaryClose | undefined;
  const householdPhase2 = options.planHouseholdNeedsInPhase2 === true
    ? createPhase2HouseholdConsumptionPlanningHandler({ taxPolicy: options.procurement.taxPolicy })
    : null;
  const regionalUpstream: PhaseHandler = (world, context, pending) => {
    const upstream = upstreamHandler(world, context, pending);
    if (context.phase !== 2 || householdPhase2 === null) return upstream;
    if (context.householdMarketIntents !== undefined ||
        context.householdConsumptionPlans !== undefined ||
        upstream.householdMarketIntents !== undefined ||
        upstream.householdConsumptionPlans !== undefined) {
      throw new Error("M5 canonical household Phase-2 forbids externally supplied household plans/intents");
    }
    return householdPhase2(world, upstream, pending);
  };
  const canonicalLabor = options.settleLaborAndProductionInPhase5 === true
    ? {
      phase2: createPhase2LaborSupplyPlanningHandler(),
      phase3: createPhase3LaborAllocationHandler(),
      wage: createPhase5WageSettlementHandler({ taxPolicy: options.procurement.wageTaxPolicy }),
      production: createPhase5ProductionExecutionHandler(),
    } : null;
  const laborUpstream: PhaseHandler = (world, context, pending) => {
    const upstream = regionalUpstream(world, context, pending);
    if (canonicalLabor === null) return upstream;
    if (context.phase === 2) {
      if (context.laborSupplyPlans !== undefined || upstream.laborSupplyPlans !== undefined) {
        throw new Error("M5 autonomous labor forbids externally supplied Phase-2 labor supply");
      }
      return canonicalLabor.phase2(world, upstream, pending);
    }
    if (context.phase === 3) {
      if (context.laborAllocations !== undefined || upstream.laborAllocations !== undefined) {
        throw new Error("M5 autonomous labor forbids externally supplied Phase-3 labor allocations");
      }
      return canonicalLabor.phase3(world, upstream, pending);
    }
    if (context.phase === 5) {
      if (context.wageSettlements !== undefined || upstream.wageSettlements !== undefined ||
          context.productionExecutions !== undefined || upstream.productionExecutions !== undefined ||
          upstream.productionOutputIntents !== undefined) {
        throw new Error("M5 autonomous labor forbids externally supplied Phase-5 settlement/production");
      }
      const afterWages = canonicalLabor.wage(world, upstream, pending);
      return canonicalLabor.production(world, afterWages, pending);
    }
    return upstream;
  };
  const bridge = createM5CanonicalRegionalPhase2Bridge(
    laborUpstream, applyOtherPhaseTransition, options.procurement,
  );
  // Never re-create a main-market budget from opening plans: the committed
  // Phase-7 residuals already exclude actual Phase-4 purchases and dispatch.
  const phase8 = options.settleMainMarketInPhase8 === true
    ? createPhase8Handler({
      getFixtureIntents: (_world, context) => {
        if (!Array.isArray(context.phase7MainIntents)) {
          throw new Error("M5 autonomous Phase-8 requires committed Phase-7 residual intents");
        }
        return [...context.phase7MainIntents];
      },
      taxPolicy: options.procurement.taxPolicy,
      enforceLiveWalletBudgets: true,
      ...(options.procurement.collectMarketTelemetry === undefined
        ? {}
        : { collectTelemetry: options.procurement.collectMarketTelemetry }),
    })
    : null;
  const phase9 = options.realizeHouseholdConsumptionInPhase9 === true
    ? phase9HouseholdHandler()
    : null;
  const handler: PhaseHandler = (world, context, pending) => {
    if (context.phase === 11 && fxPolicy !== undefined && fxOpening !== undefined) {
      if (context.fxMonetaryClose !== undefined) {
        throw new Error("M5 FX close forbids externally supplied monetary close evidence");
      }
      // Single-owned Phase 11; all tick-N settlement consumers have finished.
      fxClose = reconcileAndPlanFxClose(fxOpening, world, context, fxPolicy);
      return { ...context, fxMonetaryClose: fxClose };
    }
    // Phase-9 reads stocks *after* the Phase-8 transition. The shared M4
    // handler intentionally projects no second purchase from allocations.
    if (context.phase === 9 && phase9 !== null) return phase9(world, context, pending);
    if (context.phase !== 8 || phase8 === null) return bridge.handler(world, context, pending);
    // Opt-in Phase 8 is single-owned. Do not invoke upstream clearing/receipts.
    const cleared = phase8(world, context, pending);
    const counter = { value: 0 };
    const postings = cleared.marketAllocations.flatMap(allocation => {
      const bundle = executeMarketSettlement(allocation, context.tick, 8, counter);
      return bundle.consumptionTaxTransaction === null ||
        bundle.consumptionTaxTransaction === undefined
        ? [bundle.marketSaleTransaction]
        : [bundle.marketSaleTransaction, bundle.consumptionTaxTransaction];
    });
    return { ...cleared, transactions: [...cleared.transactions, ...postings] };
  };
  const applyTransition: PhaseWorldTransition = (phase, world, context) => {
    if (fxOpening !== undefined && phase === 11) return world;
    if (fxOpening !== undefined && phase === 15) {
      if (fxClose === undefined || context.fxMonetaryClose !== fxClose) {
        throw new Error("M5 FX close requires its own Phase-11 evidence at publication");
      }
      const afterOtherClose = bridge.applyPhaseTransition(phase, world, context);
      return publishFxClose(fxOpening, afterOtherClose, context, fxClose);
    }
    if (phase === 5 && canonicalLabor !== null) {
      if (!Array.isArray(context.wageSettlements) ||
          !Array.isArray(context.productionExecutions) ||
          !Array.isArray(context.laborAllocations) ||
          !Array.isArray(context.productionPlans)) {
        throw new Error("M5 autonomous labor requires canonical Phase-5 settlement/production evidence");
      }
      const paid = applyWageSettlementTransition(
        world, context.wageSettlements, context.tick, context,
      );
      return applyProductionExecutionTransition(
        paid, context.productionExecutions, context.tick,
        { productionPlans: context.productionPlans, laborAllocations: context.laborAllocations },
      );
    }
    if (phase === 9 && phase9 !== null) {
      if (!Array.isArray(context.householdConsumptionExecutions)) {
        throw new Error("M5 autonomous Phase-9 requires canonical household execution evidence");
      }
      return applyHouseholdConsumptionTransition(world, context.householdConsumptionExecutions, context.tick);
    }
    if (phase !== 8 || phase8 === null) return bridge.applyPhaseTransition(phase, world, context);
    // Publish the same Phase-8 physical purchase and market state exactly once.
    return applyMarketStateTransition(applyMarketSettlementTransition(world, context), context);
  };
  return executeM5CanonicalIntakeTradeTick(
    openingWorld,
    tickNumber,
    handler,
    applyTransition,
    () => ({
      policy: { transportFeeCostPolicy },
      plan: {
        opportunityQuotes: [],
        eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>(),
        infrastructureFactors,
        scorePolicy,
      },
      dispatch: { autoReserveFx: true },
      authorizedRouteDiscovery: {
        autoGenerateCanonicalRouteQuotes: true,
        autoResolveCanonicalFxPairs: true,
        autoDeriveCanonicalFxOutputBudgets: true,
        autoDeriveCanonicalCargoCapacity: true,
      },
    }),
    observePhaseTransition,
    options.phase1TariffLawProvider,
    options.phase1TradeLawProvider,
    options.procurement.taxPolicy,
    options.procurement.priceConfig,
  );
}
