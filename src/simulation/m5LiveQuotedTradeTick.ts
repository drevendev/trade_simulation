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
import { reservePhase7QuotedFxLots } from "./phase7AutoFxReservations";
import type { FxReservation } from "./fxQuoteReservation";
import { derivePhase7PostProcurementIntents } from "./phase7PostProcurementIntents";
import {
  bindPhase7DiscoveredCargoCapacity, bindPhase7DiscoveredRouteQuotes,
} from "./phase7CanonicalRouteBridge";
import type { Phase7FrozenDirectedTradePermissions } from "./phase7AuthorizedRouteDiscovery";

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
          let fxReservationByLotOrdinal: ReadonlyMap<number, FxReservation>;
          if (request.dispatch.autoReserveFx === true) {
            if ("fxReservationByLotOrdinal" in request.dispatch) {
              throw new Error("Phase-7 auto FX mode cannot accept external reservations");
            }
            // The live planning path already caps FX output by canonical pool
            // liquidity BEFORE matching. Re-quote those reduced lots once and
            // reserve them strictly. A second scarcity retry after this point
            // would be dead code without a demonstrated independent shortage.
            const actual = quotePhase7ActualMatchedLots(world, pricing, request.plan);
            fxReservationByLotOrdinal = reservePhase7QuotedFxLots(
              world, context.tick, actual.quotes,
            );
          } else {
            if (!(request.dispatch.fxReservationByLotOrdinal instanceof Map)) {
              throw new Error("Phase-7 dispatch requires explicit FX reservations or auto mode");
            }
            fxReservationByLotOrdinal = request.dispatch.fxReservationByLotOrdinal;
          }
          const state: Phase7LiveQuotedExecutionState = {
            fxReservationByLotOrdinal,
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

/**
 * M5/#673: Phase-7/8 integration of the SAME authoritative post-procurement
 * intent projection. Route eligibility, price policy, FX promises and capacity
 * remain owned by their separate, explicit Phase-1/6/7 sources.
 *
 * Neither Phase-7 residuals nor Phase-8 MAIN budgets are caller-controlled:
 * even JavaScript callers passing extra forged fields cannot replace the
 * Phase-2/4/5 realized evidence from the current post-transition tick.
 */
export type Phase7CanonicalIntakeTickDispatch = Pick<
  Phase7LiveTickDispatch, "remainingCargoWeightByLink"
> & (
  | { readonly fxReservationByLotOrdinal: ReadonlyMap<number, FxReservation>;
      readonly autoReserveFx?: never }
  | { readonly autoReserveFx: true; readonly fxReservationByLotOrdinal?: never }
);

export interface Phase7CanonicalIntakeTickRequest {
  readonly policy: Phase7LiveTickPolicy;
  readonly plan: Omit<Phase7LiveWorldPlanInput, "residualIntents">;
  readonly dispatch: Phase7CanonicalIntakeTickDispatch;
  /** Opt-in: derive eligible route/good set and legal/physical caps from
   * frozen Phase-1 permissions and the SAME post-Phase-4 canonical residuals.
   * Without this, the legacy explicit-route request stays backward-compatible. */
  readonly authorizedRouteDiscovery?: {
    readonly permissions: Phase7FrozenDirectedTradePermissions;
  };
}

export type Phase7CanonicalIntakeTickRequestBuilder = (
  world: WorldState,
  context: TickContext,
) => Phase7CanonicalIntakeTickRequest | null;

/**
 * Bind authentic Phase-2/4/5 intent and realized Phase-4 allocation evidence
 * immediately before planning and dispatch. The resulting intent set serves
 * BOTH interregional matching and subsequent local Phase-8 clearing.
 *
 * Opt-in until the Phase-1 directed route/goods legality builder is wired:
 * callers must still supply legal opportunity quotes, policy, FX/capacity and
 * explicit no-trade decisions. Missing canonical intake data fails closed;
 * a null route request means no Phase-7 dispatch and leaves the normal
 * Phase-8 handler responsible for its own no-trade local intents.
 */
export function executeM5CanonicalIntakeTradeTick(
  openingWorld: WorldState,
  tickNumber: number,
  handler: PhaseHandler,
  applyPhaseTransition: PhaseWorldTransition,
  buildPhase7RouteRequest: Phase7CanonicalIntakeTickRequestBuilder,
  observePhaseTransition?: PhaseWorldTransitionObserver,
): StatefulTickExecutionResult {
  return executeM5LiveQuotedTradeTick(
    openingWorld, tickNumber, handler, applyPhaseTransition,
    (world, context) => {
      const request = buildPhase7RouteRequest(world, context);
      if (request === null) return null;
      const intake = derivePhase7PostProcurementIntents(world, context);
      const discovered = request.authorizedRouteDiscovery === undefined
        ? undefined
        : bindPhase7DiscoveredRouteQuotes(
          world, context, intake.residualIntents,
          request.authorizedRouteDiscovery.permissions,
          request.plan.infrastructureFactors, request.plan.opportunityQuotes,
        );
      const remainingCargoWeightByLink = discovered === undefined
        ? request.dispatch.remainingCargoWeightByLink
        : bindPhase7DiscoveredCargoCapacity(
          world, request.plan.infrastructureFactors,
          discovered.eligibleDirectedLinkIdsAtPhase1,
          request.dispatch.remainingCargoWeightByLink,
        );
      return {
        policy: request.policy,
        plan: {
          ...request.plan,
          ...(discovered === undefined ? {} : discovered),
          residualIntents: intake.residualIntents,
        },
        dispatch: {
          ...request.dispatch, remainingCargoWeightByLink,
          phase8MainIntents: intake.phase8MainIntents,
        },
      };
    },
    observePhaseTransition,
  );
}
