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
import type { M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import { createM5CanonicalRegionalPhase2Bridge } from "./m5SettledPhase4Bridge";
import { executeM5CanonicalIntakeTradeTick } from "./m5LiveQuotedTradeTick";
import { createPhase8Handler } from "./phase8MainMarketClearing";
import { executeMarketSettlement } from "./marketSettlement";
import { applyMarketSettlementTransition } from "./marketSettlementTransition";
import { applyMarketStateTransition } from "./marketStateTransition";

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
  const bridge = createM5CanonicalRegionalPhase2Bridge(
    upstreamHandler, applyOtherPhaseTransition, options.procurement,
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
      collectTelemetry: options.procurement.collectMarketTelemetry,
    })
    : null;
  const handler: PhaseHandler = (world, context, pending) => {
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
