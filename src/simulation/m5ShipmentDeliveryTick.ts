/**
 * M5 / Issue #674: wire authoritative in-transit goods into the canonical 16-phase
 * tick without duplicating the tick runner or modifying the M4 closed-economy path.
 *
 * Phase 1 delivers earlier-tick arrivals before Phase-2 plans are evaluated.
 * Phase-7 close delivers same-tick zero-travel shipments after the caller's atomic
 * dispatch transition and before Phase 8. Neither path repeats the sale or FX legs.
 *
 * The supplied phase handler and world transition remain the single source of other
 * economic behavior. Shipment delivery is an opt-in atomic phase-close extension.
 */
import type { WorldState } from "./worldState";
import {
  executeStatefulTick,
  type PhaseWorldTransition,
  type PhaseWorldTransitionObserver,
  type StatefulTickExecutionResult,
} from "./statefulTickOrchestrator";
import type { PhaseHandler } from "./tickOrchestrator";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";

/** Run one M5-capable tick; always publish goods stocks and delivery journal together. */
export function executeM5ShipmentDeliveryTick(
  openingWorld: WorldState,
  tickNumber: number,
  handler: PhaseHandler,
  applyPhaseTransition: PhaseWorldTransition,
  observePhaseTransition?: PhaseWorldTransitionObserver,
): StatefulTickExecutionResult {
  return executeStatefulTick(
    openingWorld,
    tickNumber,
    handler,
    applyPhaseTransition,
    observePhaseTransition,
    (phase, transitionedWorld, context) => {
      if (phase !== 1 && phase !== 7) return { world: transitionedWorld, context };
      const delivery = deliverDueTradeShipments(transitionedWorld, {
        tick: context.tick,
        phase,
        priorTransactions: context.transactions,
      });
      return {
        world: delivery.world,
        context: { ...context, transactions: delivery.transactions },
      };
    },
  );
}
