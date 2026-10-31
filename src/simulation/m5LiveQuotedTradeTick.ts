/**
 * M5 / #673: opt-in live-quoted Phase-7 settlement inside the canonical tick.
 *
 * The caller owns Phase-1 policy snapshots, eligible routes, residual intents,
 * tick-local FX reservations and remaining transport capacity. It does NOT own
 * the tick, market prices, jurisdiction, transaction journal or settlement
 * prices: all of those are rebound from the live post-Phase-6 TickContext.
 *
 * This is a phase-close integration seam, not an autonomous Phase-2/4 market
 * planner or a creator of FX reservations.
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

/** Explicit frozen policy-owner facts; the live tick supplies all other context. */
export type Phase7LiveTickPolicy = Pick<
  Phase7LivePricingContext,
  "phase1ImportTariffs" | "phase1ConsumptionTaxes" | "transportFeeCostPolicy"
>;

/** Only reservations and Phase-8 intents cross this external commit boundary. */
export type Phase7LiveTickDispatch = Pick<
  Phase7LiveQuotedExecutionState,
  "fxReservationByLotOrdinal" | "remainingCargoWeightByLink" | "phase8MainIntents"
>;

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
          const state: Phase7LiveQuotedExecutionState = {
            fxReservationByLotOrdinal: request.dispatch.fxReservationByLotOrdinal,
            remainingCargoWeightByLink: request.dispatch.remainingCargoWeightByLink,
            phase8MainIntents: request.dispatch.phase8MainIntents,
            effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
            priorTransactions: context.transactions,
          };
          const committed = executePhase7LiveQuotedMixedTradePlan(
            world, pricing, request.plan, state,
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
