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

/** Build from the LIVE post-Phase-6 world/context; null means no trade this tick. */
export type Phase7LiveTradeInputBuilder = (
  world: WorldState,
  context: TickContext,
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
        const input = buildPhase7Input(world, context);
        if (input !== null) {
          verifyLivePhase7Input(input, context);
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
      return { world, context: nextContext };
    },
  );
}
