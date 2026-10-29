/**
 * Immutable WorldState threading for milestone integrations that need an earlier phase's
 * explicit state transition to become visible to a later phase in the same canonical tick.
 *
 * `tickOrchestrator.ts` remains the sole owner of the 0..15 phase order, phase dispatch and
 * phase-boundary reconciliation rules. This seam carries accepted WorldState and TickContext
 * transitions together without mutating either caller-owned opening value.
 */

import type { WorldState } from "./worldState";
import {
  TOTAL_PHASES,
  executePhase,
  initializeTickContext,
  validateTickInvariants,
  type PhaseBoundaryValidationError,
  type PhaseHandler,
  type TickContext,
} from "./tickOrchestrator";

export type PhaseWorldTransition = (
  phase: number,
  world: WorldState,
  context: TickContext,
) => WorldState;

/**
 * Optional atomic phase-close extension for transitions that must publish BOTH
 * physical stocks and their journal receipts, such as M5 shipment arrivals.
 * Called after the ordinary phase transition, before the next phase or observer.
 * Older M4 callers retain exactly their existing behavior when this is omitted.
 */
export type PhaseWorldAndContextCommit = (
  phase: number,
  transitionedWorld: WorldState,
  context: TickContext,
) => { readonly world: WorldState; readonly context: TickContext };

/**
 * Read-only diagnostic seam invoked only after an accepted phase transition.
 * It observes the exact authoritative before/after WorldState pair.
 */
export type PhaseWorldTransitionObserver = (
  phase: number,
  beforeWorld: WorldState,
  afterWorld: WorldState,
  context: TickContext,
) => void;

export interface StatefulTickExecutionResult {
  readonly world: WorldState;
  readonly context: TickContext;
  readonly phaseTrace: readonly number[];
  readonly phaseBoundaryError?: PhaseBoundaryValidationError;
  readonly reconciliationErrors: readonly {
    category: string;
    key: string;
    residual: number;
  }[] | null;
}

/**
 * Execute the canonical phase sequence while threading immutable WorldState transitions.
 * The optional phase-close commit keeps its WorldState and journal together. Reconciliation
 * runs both before and after that commit; a failed check cannot publish the candidate WorldState.
 * A throwing commit is likewise never published to the caller.
 */
export function executeStatefulTick(
  openingWorld: WorldState,
  tickNumber: number,
  handler: PhaseHandler,
  applyPhaseTransition: PhaseWorldTransition,
  observePhaseTransition?: PhaseWorldTransitionObserver,
  commitPhase?: PhaseWorldAndContextCommit,
): StatefulTickExecutionResult {
  let world = openingWorld;
  let context = initializeTickContext(tickNumber, openingWorld.seed);
  const phaseTrace: number[] = [];
  const tolerance = openingWorld.simulationConfig.numeric.reconciliationRelativeTolerance;

  for (let phase = 0; phase < TOTAL_PHASES; phase += 1) {
    context = executePhase(
      phase,
      handler,
      world,
      context,
      world.pendingTransitions,
    );
    phaseTrace.push(phase);

    const boundaryErrors = validateTickInvariants(context, tolerance);
    if (boundaryErrors !== null) {
      return {
        world,
        context,
        phaseTrace,
        phaseBoundaryError: { phase, errors: boundaryErrors },
        reconciliationErrors: boundaryErrors,
      };
    }

    const beforeWorld = world;
    const transitionedWorld = applyPhaseTransition(phase, beforeWorld, context);
    const committed = commitPhase === undefined
      ? { world: transitionedWorld, context }
      : commitPhase(phase, transitionedWorld, context);
    if (committed.context.tick !== tickNumber || committed.context.phase !== phase) {
      throw new Error("Phase close cannot change the canonical tick or phase");
    }
    const closeErrors = validateTickInvariants(committed.context, tolerance);
    if (closeErrors !== null) {
      return {
        world: beforeWorld,
        context,
        phaseTrace,
        phaseBoundaryError: { phase, errors: closeErrors },
        reconciliationErrors: closeErrors,
      };
    }
    world = committed.world;
    context = committed.context;
    observePhaseTransition?.(phase, beforeWorld, world, context);
  }

  return { world, context, phaseTrace, reconciliationErrors: null };
}
