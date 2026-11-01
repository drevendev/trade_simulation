/**
 * M5 / #673: opt-in canonical Phase-7 prepared mixed trade execution.
 *
 * The main 0..15 tick runner remains authoritative. A caller supplies the
 * current-tick, Phase-1-authorized trade evidence only when Phase 7 is reached.
 * Both the settled WorldState and its journal/Phase-8 residuals are published
 * at one phase-close boundary. Phase-1 and zero-travel Phase-7 arrivals reuse
 * the same shipment-delivery owner; dispatch is never replayed on arrival.
 *
 * This is a composition seam, not a substitute for Phase-2/4/6 market planning
 * or a claim that the entire M5 multiregion orchestrator is complete.
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
  executePreparedMixedCurrencyTradePlan,
  type Phase7PreparedMixedExecutionInput,
} from "./phase7PreparedFxExecution";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";
import {
  capturePhase7DirectedTradePermissionsAtPhase1,
  type Phase7FrozenDirectedTradePermissions,
  type Phase7Phase1TradeLawProvider,
} from "./phase7AuthorizedRouteDiscovery";

/**
 * Build from live post-Phase-6 evidence; null means no trade.
 * The optional THIRD argument is an independent, tick-frozen Phase-1 law
 * decision snapshot. Two-argument legacy builders remain compatible.
 */
export type Phase7LiveTradeInputBuilder = (
  world: WorldState,
  context: TickContext,
  phase1Permissions?: Phase7FrozenDirectedTradePermissions,
) => Phase7PreparedMixedExecutionInput | null;

function verifyLivePhase7Input(
  input: Phase7PreparedMixedExecutionInput,
  context: TickContext,
): void {
  if (input.tick !== context.tick) {
    throw new Error("M5 Phase-7 tick input must match the current canonical tick");
  }
  if (!Array.isArray(input.priorTransactions) ||
      input.priorTransactions.length !== context.transactions.length ||
      input.priorTransactions.some((tx, index) => tx !== context.transactions[index])) {
    throw new Error("M5 Phase-7 trade must use the live committed tick journal");
  }
  const current = context.effectiveJurisdictionByRegion;
  const supplied = input.effectiveJurisdictionByRegion;
  if (!(supplied instanceof Map) || supplied.size !== current.size ||
      [...current].some(([regionId, controller]) =>
        !supplied.has(regionId) || supplied.get(regionId) !== controller)) {
    throw new Error("M5 Phase-7 trade must use current Phase-1 jurisdiction evidence");
  }
}

/**
 * The opt-in Phase-1 law path binds the *captured* directed link/good decisions
 * to the prepared Phase-7 execution input before any goods or cash move.
 * Passing a clone to the builder prevents that callback from editing the
 * coordinator's authoritative permission evidence.
 */
function copyPhase1Permissions(
  frozen: Phase7FrozenDirectedTradePermissions,
): Phase7FrozenDirectedTradePermissions {
  return {
    tick: frozen.tick,
    permittedGoodsByDirectedLink: new Map(
      [...frozen.permittedGoodsByDirectedLink].map(([linkId, goods]) =>
        [linkId, new Map(goods)] as const),
    ),
  };
}

function verifyFrozenPhase1Law(
  input: Phase7PreparedMixedExecutionInput,
  frozen: Phase7FrozenDirectedTradePermissions,
): void {
  const plan = input.planInput;
  if (frozen.tick !== input.tick || !(frozen.permittedGoodsByDirectedLink instanceof Map) ||
      !plan || !(plan.eligibleDirectedLinkIdsAtPhase1 instanceof Set) ||
      !Array.isArray(plan.opportunities)) {
    throw new Error("M5 Phase-7 requires frozen Phase-1 law evidence for this tick");
  }
  for (const linkId of plan.eligibleDirectedLinkIdsAtPhase1) {
    if (!frozen.permittedGoodsByDirectedLink.has(linkId)) {
      throw new Error("M5 Phase-7 eligible link lacks frozen Phase-1 permission");
    }
  }
  for (const quote of plan.opportunities) {
    const goods = frozen.permittedGoodsByDirectedLink.get(quote.linkId);
    if (!(goods instanceof Map) ||
        !goods.has(quote.goodId) ||
        quote.authorizedAtPhase1 !== true ||
        !plan.eligibleDirectedLinkIdsAtPhase1.has(quote.linkId)) {
      throw new Error("M5 Phase-7 opportunity lacks frozen Phase-1 link/good permission");
    }
    const legalCap = goods.get(quote.goodId);
    if (legalCap === undefined ||
        (legalCap === null
          ? quote.legalQuantityCap !== undefined
          : quote.legalQuantityCap !== legalCap)) {
      throw new Error("M5 Phase-7 opportunity disagrees with frozen Phase-1 legal quantity cap");
    }
  }
}

/**
 * Run one M5-capable canonical tick with prepared mixed-currency dispatch.
 * A Phase-8 handler consumes context.phase7MainIntents (the committed residuals)
 * rather than the unexecuted planning intentions. Neither input WorldState nor
 * caller-owned reservations/journal/capacity is mutated.
 */
export function executeM5PreparedTradeTick(
  openingWorld: WorldState,
  tickNumber: number,
  handler: PhaseHandler,
  applyPhaseTransition: PhaseWorldTransition,
  buildPhase7Input: Phase7LiveTradeInputBuilder,
  observePhaseTransition?: PhaseWorldTransitionObserver,
  phase1TradeLawProvider?: Phase7Phase1TradeLawProvider,
): StatefulTickExecutionResult {
  // Tick-local closure, never WorldState or a persistent law cache.
  let frozenPhase1Permissions: Phase7FrozenDirectedTradePermissions | undefined;
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
        if (phase1TradeLawProvider !== undefined &&
            frozenPhase1Permissions?.tick !== context.tick) {
          throw new Error("M5 Phase-7 requires current-tick captured Phase-1 law");
        }
        const input = buildPhase7Input(
          world, context,
          frozenPhase1Permissions === undefined
            ? undefined : copyPhase1Permissions(frozenPhase1Permissions),
        );
        if (input !== null) {
          verifyLivePhase7Input(input, context);
          if (phase1TradeLawProvider !== undefined) {
            if (frozenPhase1Permissions === undefined) {
              throw new Error("M5 Phase-7 requires captured Phase-1 law");
            }
            verifyFrozenPhase1Law(input, frozenPhase1Permissions);
          }
          const committed = executePreparedMixedCurrencyTradePlan(world, input);
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
      if (phase === 1 && phase1TradeLawProvider !== undefined) {
        // Phase-1 jurisdiction transitions and arrivals are already applied.
        // No Phase-7 policy recomputation, no implicit permission default.
        frozenPhase1Permissions = capturePhase7DirectedTradePermissionsAtPhase1(
          world, nextContext, phase1TradeLawProvider,
        );
      }
      return { world, context: nextContext };
    },
  );
}
