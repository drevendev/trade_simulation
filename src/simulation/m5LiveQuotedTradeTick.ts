/**
 * M5 / #673: opt-in live-quoted Phase-7 settlement inside the canonical tick.
 *
 * The caller owns Phase-1 policy snapshots, eligible routes, residual intents,
 * explicit FX reservations (or opts into canonical auto-reservation) and capacity. It does NOT own
 * the tick, market prices, jurisdiction, transaction journal or settlement
 * prices: all of those are rebound from the live post-Phase-6 TickContext.
 *
 * This is a phase-close integration seam, not an autonomous Phase-2/4 market
 * planner. Opt-in auto-reservation requires full FX funding; scarcity shrink
 * still belongs upstream before any stock or cash mutation.
 */
import type { WorldState } from "./worldState";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import {
  executeStatefulTick,
  type PhaseWorldTransition,
  type PhaseWorldTransitionObserver,
  type StatefulTickExecutionResult,
} from "./statefulTickOrchestrator";
import {
  executePhase7LiveQuotedMixedTradePlan,
  type Phase7LiveQuotedExecutionState,
} from "./phase7LiveQuotedExecution";
import type {
  Phase7LivePricingContext, Phase7LiveWorldPlanInput,
} from "./phase7LiveWorldPlan";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";
import { quotePhase7ActualMatchedLots } from "./phase7ActualLotQuote";
import { reservePhase7QuotedFxLots, assessPhase7QuotedFxScarcity } from "./phase7AutoFxReservations";
import { reducePhase7LiveFxBudgetCaps } from "./phase7FxScarcityReplan";
import type { FxReservation } from "./fxQuoteReservation";

/** Explicit frozen policy-owner facts; the live tick supplies all other context. */
export type Phase7LiveTickPolicy = Pick<
  Phase7LivePricingContext,
  "phase1ImportTariffs" | "phase1ConsumptionTaxes" | "transportFeeCostPolicy"
>;

/** A caller may supply its OWN tick-local FX promises, or explicitly opt in
 * to read-only canonical reservation generation for fully fundable matched lots.
 * Missing promises do NOT silently select automatic mode. */
export type Phase7LiveTickDispatch = Pick<
  Phase7LiveQuotedExecutionState, "remainingCargoWeightByLink" | "phase8MainIntents"
> & (
  | { readonly fxReservationByLotOrdinal: ReadonlyMap<number, FxReservation>;
      readonly autoReserveFx?: never }
  | { readonly autoReserveFx: true; readonly fxReservationByLotOrdinal?: never }
);

export interface Phase7LiveTickRequest {
  readonly policy: Phase7LiveTickPolicy;
  readonly plan: Phase7LiveWorldPlanInput;
  readonly dispatch: Phase7LiveTickDispatch;
}

/** Null means no Phase-7 opportunity; never infer a policy or FX reservation. */
export type Phase7LiveTickRequestBuilder = (
  world: WorldState,
  context: TickContext,
) => Phase7LiveTickRequest | null;

/**
 * Run canonical phases 0..15. Exactly at Phase-7 close, quote the actual
 * matched quantities from live Phase-1/6 evidence and commit the existing
 * fail-atomic trade bundle. Publish the resulting WorldState, journal and
 * Phase-8 residual intents together. Phase-1 and zero-travel Phase-7 arrivals
 * share the same delivery owner as the already-supported prepared tick.
 */
export function executeM5LiveQuotedTradeTick(
  openingWorld: WorldState,
  tickNumber: number,
  handler: PhaseHandler,
  applyPhaseTransition: PhaseWorldTransition,
  buildPhase7Request: Phase7LiveTickRequestBuilder,
  observePhaseTransition?: PhaseWorldTransitionObserver,
): StatefulTickExecutionResult {
  return executeStatefulTick(
    openingWorld,
    tickNumber,
    handler,
    applyPhaseTransition,
    observePhaseTransition,
    (phase, transitionedWorld, context) => {
      let world = transitionedWorld;
      let nextContext = context;
      if (phase === 7) {
        const request = buildPhase7Request(world, context);
        if (request !== null) {
          // Explicit field selection is intentional. Even an object with extra
          // runtime properties cannot override the authoritative tick/phase,
          // Phase-6 market prices, Phase-1 jurisdiction, or committed journal.
          const pricing: Phase7LivePricingContext = {
            tick: context.tick,
            phase: context.phase,
            marketPrices: context.marketPrices,
            effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
            phase1ImportTariffs: request.policy.phase1ImportTariffs,
            phase1ConsumptionTaxes: request.policy.phase1ConsumptionTaxes,
            transportFeeCostPolicy: request.policy.transportFeeCostPolicy,
          };
          let effectivePlan = request.plan;
          let fxReservationByLotOrdinal: ReadonlyMap<number, FxReservation> | undefined;
          if (request.dispatch.autoReserveFx === true) {
            if ("fxReservationByLotOrdinal" in request.dispatch) {
              throw new Error("Phase-7 auto FX mode cannot accept external reservations");
            }
            // Pure preflight only: shrink the tick-local FX output ceilings,
            // re-match actor intents and re-quote every fee/tax/FX leg from the
            // same Phase-1/6 authorities. A partial promise is NEVER dispatched.
            // The bounded retry fails before any stock or cash is committed.
            const MAX_SCARCITY_PASSES = 4;
            for (let pass = 0; pass < MAX_SCARCITY_PASSES; pass++) {
              const actual = quotePhase7ActualMatchedLots(world, pricing, effectivePlan);
              const scarcity = assessPhase7QuotedFxScarcity(
                world, context.tick, actual.quotes,
              );
              if (!scarcity.requiresShrink) {
                fxReservationByLotOrdinal = reservePhase7QuotedFxLots(
                  world, context.tick, actual.quotes,
                );
                break;
              }
              if (pass === MAX_SCARCITY_PASSES - 1) {
                throw new Error("Phase-7 FX scarcity replan exhausted bounded attempts");
              }
              effectivePlan = reducePhase7LiveFxBudgetCaps(effectivePlan, scarcity);
            }
          } else {
            if (!(request.dispatch.fxReservationByLotOrdinal instanceof Map)) {
              throw new Error("Phase-7 dispatch requires explicit FX reservations or auto mode");
            }
            fxReservationByLotOrdinal = request.dispatch.fxReservationByLotOrdinal;
          }
          if (fxReservationByLotOrdinal === undefined) {
            throw new Error("Phase-7 FX scarcity replan has no strict reservations");
          }
          const state: Phase7LiveQuotedExecutionState = {
            fxReservationByLotOrdinal,
            remainingCargoWeightByLink: request.dispatch.remainingCargoWeightByLink,
            phase8MainIntents: request.dispatch.phase8MainIntents,
            effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
            priorTransactions: context.transactions,
          };
          const committed = executePhase7LiveQuotedMixedTradePlan(
            world, pricing, effectivePlan, state,
          );
          world = committed.world;
          nextContext = {
            ...context,
            transactions: committed.transactions,
            phase7MainIntents: committed.phase8MainIntents,
          };
        }
      }
      if (phase === 1 || phase === 7) {
        const delivered = deliverDueTradeShipments(world, {
          tick: nextContext.tick,
          phase,
          priorTransactions: nextContext.transactions,
        });
        world = delivered.world;
        nextContext = { ...nextContext, transactions: delivered.transactions };
      }
      return { world, context: nextContext };
    },
  );
}
