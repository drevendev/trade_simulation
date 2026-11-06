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
import {
  capturePhase7DirectedTradePermissionsAtPhase1,
  type Phase7FrozenDirectedTradePermissions,
  type Phase7Phase1TradeLawProvider,
} from "./phase7AuthorizedRouteDiscovery";
import { derivePhase7CanonicalCargoResiduals } from "./phase7CanonicalCargoResiduals";
import {
  capturePhase7ImportTariffsAtPhase1,
  type Phase7Phase1TariffLawProvider,
} from "./phase7Phase1TariffCapture";
import type { Phase7FrozenImportTariffSnapshot } from "./phase7LiveWorldPlan";
import {
  derivePhase7CanonicalFxOutputBudgets,
  derivePhase7UnambiguousCanonicalFxPairs,
} from "./phase7CanonicalFxPairDiscovery";

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

/** Protect the captured policy against replacement by later tick handlers. */
function matchesCapturedTariffs(
  captured: Phase7FrozenImportTariffSnapshot | undefined,
  observed: Phase7FrozenImportTariffSnapshot | undefined,
  tick: number,
): boolean {
  return captured !== undefined && observed !== undefined &&
    captured.tick === tick && observed.tick === tick &&
    observed.ratesByDestinationStateGood instanceof Map &&
    captured.ratesByDestinationStateGood.size === observed.ratesByDestinationStateGood.size &&
    [...captured.ratesByDestinationStateGood].every(([key, rate]) =>
      observed.ratesByDestinationStateGood.get(key) === rate);
}

/** Deep-copy Map values; a handler or request builder must not own the law source. */
function copyTradeLaw(source: Phase7FrozenDirectedTradePermissions): Phase7FrozenDirectedTradePermissions {
  return {
    tick: source.tick,
    permittedGoodsByDirectedLink: new Map(
      [...source.permittedGoodsByDirectedLink].map(([link, goods]) =>
        [link, new Map(goods)] as const),
    ),
  };
}

function sameTradeLaw(
  source: Phase7FrozenDirectedTradePermissions | undefined,
  shown: Phase7FrozenDirectedTradePermissions | undefined,
  tick: number,
): boolean {
  return source !== undefined && shown !== undefined &&
    source.tick === tick && shown.tick === tick &&
    shown.permittedGoodsByDirectedLink instanceof Map &&
    source.permittedGoodsByDirectedLink.size === shown.permittedGoodsByDirectedLink.size &&
    [...source.permittedGoodsByDirectedLink].every(([link, goods]) => {
      const visible = shown.permittedGoodsByDirectedLink.get(link);
      return visible instanceof Map && visible.size === goods.size &&
        [...goods].every(([good, cap]) => visible.has(good) && visible.get(good) === cap);
    });
}

/** Protect raw live-quote callers too: captured permission cannot be bypassed. */
function assertTradeQuotesAllowed(
  request: Phase7LiveTickRequest,
  law: Phase7FrozenDirectedTradePermissions,
): void {
  if (!Array.isArray(request.plan.opportunityQuotes)) {
    throw new Error("Phase-7 captured trade law requires explicit route quotes");
  }
  for (const quote of request.plan.opportunityQuotes) {
    const goods = law.permittedGoodsByDirectedLink.get(quote.linkId);
    if (!(goods instanceof Map) || !goods.has(quote.goodId)) {
      throw new Error("Phase-7 quote lacks captured Phase-1 directed trade permission");
    }
    const cap = goods.get(quote.goodId);
    if (quote.legalQuantityCap !== (cap === null ? undefined : cap)) {
      throw new Error("Phase-7 quote cannot override captured Phase-1 legal quantity cap");
    }
  }
}

/** An untrusted Phase-7 builder must not rewrite live Phase-6 price evidence,
 * even if it returns null (no trade). Keep the check independent of quote input. */
function samePhase6Prices(
  captured: ReadonlyMap<string, number>,
  observed: ReadonlyMap<string, number>,
): boolean {
  return observed instanceof Map && captured.size === observed.size &&
    [...captured].every(([key, value]) =>
      observed.has(key) && Object.is(observed.get(key), value));
}

/** The Phase-1 jurisdiction map is another economic-law authority, not mutable
 * builder input. Check its detached view even when the builder requests no trade. */
function samePhase1Jurisdictions(
  captured: TickContext["effectiveJurisdictionByRegion"],
  observed: TickContext["effectiveJurisdictionByRegion"],
): boolean {
  return observed instanceof Map && captured.size === observed.size &&
    [...captured].every(([region, state]) =>
      observed.has(region) && Object.is(observed.get(region), state));
}

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
  phase1TariffLawProvider?: Phase7Phase1TariffLawProvider,
  phase1TradeLawProvider?: Phase7Phase1TradeLawProvider,
): StatefulTickExecutionResult {
  // Phase-1 captures the only authoritative law rates. The context exposes a
  // separate read-only copy for handlers, never the private settlement source.
  let capturedPhase1Tariffs: Phase7FrozenImportTariffSnapshot | undefined;
  let capturedPhase1TradeLaw: Phase7FrozenDirectedTradePermissions | undefined;
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
        if (phase1TradeLawProvider !== undefined && !sameTradeLaw(
          capturedPhase1TradeLaw, context.phase1DirectedTradePermissions, context.tick,
        )) {
          throw new Error("Phase-7 requires unmodified current-tick Phase-1 trade permissions");
        }
        if (phase1TariffLawProvider !== undefined && !matchesCapturedTariffs(
          capturedPhase1Tariffs, context.phase1ImportTariffs, context.tick,
        )) {
          throw new Error("M5 Phase-7 requires unmodified current-tick Phase-1 tariff evidence");
        }
        // Never expose the actual phase-6 price Map to a request builder.
        // A malicious/no-trade builder must not poison Phase-8 clearing, nor
        // influence the current tick's invoice through a forged price.
        const capturedPhase6Prices = new Map(context.marketPrices);
        const capturedPhase1Jurisdictions = new Map(context.effectiveJurisdictionByRegion);
        const builderContext: TickContext = {
          ...context,
          marketPrices: new Map(capturedPhase6Prices),
          effectiveJurisdictionByRegion: new Map(capturedPhase1Jurisdictions),
        };
        const request = buildPhase7Request(world, builderContext);
        if (!samePhase6Prices(capturedPhase6Prices, builderContext.marketPrices) ||
            !samePhase6Prices(capturedPhase6Prices, context.marketPrices)) {
          throw new Error("M5 Phase-7 request builder cannot modify Phase-6 market prices");
        }
        if (!samePhase1Jurisdictions(
          capturedPhase1Jurisdictions, builderContext.effectiveJurisdictionByRegion,
        ) || !samePhase1Jurisdictions(
          capturedPhase1Jurisdictions, context.effectiveJurisdictionByRegion,
        )) {
          throw new Error("M5 Phase-7 request builder cannot modify Phase-1 jurisdictions");
        }
        if (request !== null) {
          if (phase1TradeLawProvider !== undefined) {
            assertTradeQuotesAllowed(request, capturedPhase1TradeLaw!);
          }
          if (phase1TariffLawProvider !== undefined &&
              request.policy.phase1ImportTariffs !== undefined) {
            throw new Error("M5 Phase-7 cannot override captured Phase-1 tariffs with caller policy");
          }
          // Explicit field selection is intentional. Even an object with extra
          // runtime properties cannot override the authoritative tick/phase,
          // Phase-6 market prices, Phase-1 jurisdiction, or committed journal.
          const pricing: Phase7LivePricingContext = {
            tick: context.tick,
            phase: context.phase,
            marketPrices: capturedPhase6Prices,
            effectiveJurisdictionByRegion: capturedPhase1Jurisdictions,
            phase1ImportTariffs: phase1TariffLawProvider === undefined
              ? request.policy.phase1ImportTariffs : capturedPhase1Tariffs,
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
            effectiveJurisdictionByRegion: capturedPhase1Jurisdictions,
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
      if (phase === 1 && phase1TariffLawProvider !== undefined) {
        // Capture only after jurisdiction activation and Phase-1 deliveries.
        capturedPhase1Tariffs = capturePhase7ImportTariffsAtPhase1(
          world, nextContext, phase1TariffLawProvider,
        );
        nextContext = {
          ...nextContext,
          phase1ImportTariffs: {
            tick: capturedPhase1Tariffs.tick,
            ratesByDestinationStateGood: new Map(
              capturedPhase1Tariffs.ratesByDestinationStateGood,
            ),
          },
        };
      }
      if (phase === 1 && phase1TradeLawProvider !== undefined) {
        // Phase-1 law sees the activated jurisdictions after due deliveries.
        capturedPhase1TradeLaw = capturePhase7DirectedTradePermissionsAtPhase1(
          world, nextContext, phase1TradeLawProvider,
        );
        nextContext = {
          ...nextContext,
          phase1DirectedTradePermissions: copyTradeLaw(capturedPhase1TradeLaw),
        };
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
export type Phase7CanonicalIntakeTickDispatch = {
  /** Optional only with explicit canonical fresh-tick capacity derivation. */
  readonly remainingCargoWeightByLink?: Phase7LiveTickDispatch["remainingCargoWeightByLink"];
} & (
  | { readonly fxReservationByLotOrdinal: ReadonlyMap<number, FxReservation>;
      readonly autoReserveFx?: never }
  | { readonly autoReserveFx: true; readonly fxReservationByLotOrdinal?: never }
);

export interface Phase7CanonicalIntakeTickRequest {
  readonly policy: Phase7LiveTickPolicy;
  readonly plan: Omit<
    Phase7LiveWorldPlanInput,
    "residualIntents" | "fxPairIdByTradePlanId" | "fxOutputByPairCurrency"
  > & {
    /** Optional only in the canonical auto-resolution path. */
    readonly fxPairIdByTradePlanId?: Phase7LiveWorldPlanInput["fxPairIdByTradePlanId"];
    /** Optional only when autoDeriveCanonicalFxOutputBudgets is selected. */
    readonly fxOutputByPairCurrency?: Phase7LiveWorldPlanInput["fxOutputByPairCurrency"];
  };
  readonly dispatch: Phase7CanonicalIntakeTickDispatch;
  /** Opt-in: derive eligible route/good set and legal/physical caps from
   * frozen Phase-1 permissions and the SAME post-Phase-4 canonical residuals.
   * Without this, the legacy explicit-route request stays backward-compatible. */
  readonly authorizedRouteDiscovery?: {
    /** Omit only when the current tick captures law via phase1TradeLawProvider. */
    readonly permissions?: Phase7FrozenDirectedTradePermissions;
    /** Construct route scoring templates solely from frozen legal discovery and
     * live residual intents. Must supply NO external opportunityQuotes. Prices,
     * fees, taxes and FX are hydrated later from their canonical owners. */
    readonly autoGenerateCanonicalRouteQuotes?: true;
    /** Resolve FX pair identities from live issuer-owned pools only when a
     * unique pool exists for each cross-currency opportunity. Missing or
     * multiple reverse-oriented pools fail closed: do not guess a preference.
     * The separate Phase-7 FX output budget remains externally owned. */
    readonly autoResolveCanonicalFxPairs?: true;
    /** Use only persisted pool liquidity, not a caller-provided FX budget.
     * Requires canonical pair discovery plus strict automatic reservations;
     * no other tick-local uncommitted FX promises may be supplied. */
    readonly autoDeriveCanonicalFxOutputBudgets?: true;
    /** Derive full fresh-tick physical cargo capacity from the live directed
     * links, never from externally asserted residuals. Reject any earlier
     * same-tick dispatch, whose booked cargo cannot safely be reconstructed
     * from surviving in-transit goods or a zero-travel delivery. */
    readonly autoDeriveCanonicalCargoCapacity?: true;
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
  phase1TariffLawProvider?: Phase7Phase1TariffLawProvider,
  phase1TradeLawProvider?: Phase7Phase1TradeLawProvider,
): StatefulTickExecutionResult {
  return executeM5LiveQuotedTradeTick(
    openingWorld, tickNumber, handler, applyPhaseTransition,
    (world, context) => {
      // Copy BEFORE calling the untrusted builder; it can mutate its context.
      const trustedLaw = phase1TradeLawProvider === undefined ||
        context.phase1DirectedTradePermissions === undefined
        ? undefined : copyTradeLaw(context.phase1DirectedTradePermissions);
      const request = buildPhase7RouteRequest(world, context);
      if (request === null) return null;
      if (phase1TradeLawProvider !== undefined) {
        if (request.authorizedRouteDiscovery === undefined) {
          throw new Error("Captured Phase-1 trade law requires canonical route discovery");
        }
        if (request.authorizedRouteDiscovery.permissions !== undefined) {
          throw new Error("Caller cannot replace captured Phase-1 trade permissions");
        }
      } else if (request.authorizedRouteDiscovery !== undefined &&
          request.authorizedRouteDiscovery.permissions === undefined) {
        throw new Error("Route discovery requires explicit Phase-1 law without provider");
      }
      const intake = derivePhase7PostProcurementIntents(world, context);
      const autoRoutes =
        request.authorizedRouteDiscovery?.autoGenerateCanonicalRouteQuotes === true;
      if (autoRoutes && (!Array.isArray(request.plan.opportunityQuotes) ||
          request.plan.opportunityQuotes.length !== 0)) {
        throw new Error("Phase-7 canonical quote generation cannot accept external route quotes");
      }
      const discovered = request.authorizedRouteDiscovery === undefined
        ? undefined
        : bindPhase7DiscoveredRouteQuotes(
          world, context, intake.residualIntents,
          trustedLaw ?? request.authorizedRouteDiscovery.permissions!,
          request.plan.infrastructureFactors,
          autoRoutes ? null : request.plan.opportunityQuotes,
        );
      const discoverFx = request.authorizedRouteDiscovery?.autoResolveCanonicalFxPairs === true;
      const discoverFxBudgets =
        request.authorizedRouteDiscovery?.autoDeriveCanonicalFxOutputBudgets === true;
      if (discoverFx && request.plan.fxPairIdByTradePlanId !== undefined) {
        throw new Error("Phase-7 canonical FX discovery cannot accept a caller FX pair map");
      }
      if (discoverFxBudgets) {
        if (!discoverFx || request.dispatch.autoReserveFx !== true) {
          throw new Error("Phase-7 canonical FX output discovery requires canonical pairs and auto reservations");
        }
        if (request.plan.fxOutputByPairCurrency !== undefined) {
          throw new Error("Phase-7 canonical FX output discovery cannot accept a caller FX budget");
        }
      }
      const discoveredFxPairs = discoverFx
        ? derivePhase7UnambiguousCanonicalFxPairs(world, discovered!.opportunityQuotes)
        : undefined;
      const fxPairIdByTradePlanId = discoveredFxPairs ?? request.plan.fxPairIdByTradePlanId;
      if (fxPairIdByTradePlanId === undefined) {
        throw new Error("Phase-7 canonical intake requires explicit or discovered FX pair identity");
      }
      const fxOutputByPairCurrency = discoverFxBudgets
        ? derivePhase7CanonicalFxOutputBudgets(
          world, discovered!.opportunityQuotes, fxPairIdByTradePlanId,
        )
        : request.plan.fxOutputByPairCurrency;
      if (!(fxOutputByPairCurrency instanceof Map)) {
        throw new Error("Phase-7 canonical intake requires explicit or discovered FX output budgets");
      }
      const autoCargo = request.authorizedRouteDiscovery?.autoDeriveCanonicalCargoCapacity === true;
      if (autoCargo && request.dispatch.remainingCargoWeightByLink !== undefined) {
        throw new Error("Phase-7 canonical cargo discovery cannot accept caller cargo residuals");
      }
      if (!autoCargo && !(request.dispatch.remainingCargoWeightByLink instanceof Map)) {
        throw new Error("Phase-7 canonical intake requires explicit cargo residuals or canonical cargo discovery");
      }
      const remainingCargoWeightByLink = autoCargo
        ? derivePhase7CanonicalCargoResiduals(
          world, context, request.plan.infrastructureFactors,
          discovered!.eligibleDirectedLinkIdsAtPhase1,
        )
        : discovered === undefined
          ? request.dispatch.remainingCargoWeightByLink!
          : bindPhase7DiscoveredCargoCapacity(
            world, request.plan.infrastructureFactors,
            discovered.eligibleDirectedLinkIdsAtPhase1,
            request.dispatch.remainingCargoWeightByLink!,
          );
      return {
        policy: request.policy,
        plan: {
          ...request.plan,
          ...(discovered === undefined ? {} : discovered),
          fxPairIdByTradePlanId,
          fxOutputByPairCurrency,
          residualIntents: intake.residualIntents,
        },
        dispatch: {
          ...request.dispatch, remainingCargoWeightByLink,
          phase8MainIntents: intake.phase8MainIntents,
        },
      };
    },
    observePhaseTransition,
    phase1TariffLawProvider,
    phase1TradeLawProvider,
  );
}
