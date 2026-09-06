/**
 * Phase-level invariant hooks (REQ-CORE-006).
 *
 * Hooks are registered per phase and executed after the phase completes.
 * They verify accounting invariants and fail-fast on violations.
 * In M2, hooks validate zero-flow conservation; later phases add economic constraints.
 */

import type { WorldState } from "./worldState";
import type { TickContext } from "./tickOrchestrator";
import type { RuntimeLedger } from "./ledgerFlow";
import type { SimulationConfig } from "../config/simulationConfig";
import { reconcileTickFlows, buildDiagnosticProjection } from "./reconciliation";

/**
 * Invariant hook: receives world state, tick context, and ledger.
 * Returns error message if invariant is violated; null if OK.
 */
export type InvariantHook = (
  world: WorldState,
  context: TickContext,
  ledger: RuntimeLedger,
  config: SimulationConfig,
) => string | null;

/**
 * Phase-level invariant registry.
 * Each phase can have multiple hooks; all must pass.
 */
export interface InvariantRegistry {
  readonly hooksByPhase: Map<number, InvariantHook[]>;
}

/**
 * Create an empty invariant registry.
 */
export function createEmptyInvariantRegistry(): InvariantRegistry {
  return {
    hooksByPhase: new Map(),
  };
}

/**
 * Register an invariant hook for a specific phase.
 */
export function registerPhaseInvariant(
  registry: InvariantRegistry,
  phase: number,
  hook: InvariantHook,
): InvariantRegistry {
  const hooksForPhase = registry.hooksByPhase.get(phase) ?? [];
  return {
    hooksByPhase: new Map(registry.hooksByPhase).set(phase, [...hooksForPhase, hook]),
  };
}

/**
 * Execute all invariant hooks for a phase.
 * Throws if any hook returns an error message.
 */
export function executePhaseInvariants(
  registry: InvariantRegistry,
  phase: number,
  world: WorldState,
  context: TickContext,
  ledger: RuntimeLedger,
  config: SimulationConfig,
): void {
  const hooks = registry.hooksByPhase.get(phase) ?? [];

  hooks.forEach((hook) => {
    const error = hook(world, context, ledger, config);
    if (error) {
      throw new Error(
        `Phase ${phase} invariant violation: ${error}`,
      );
    }
  });
}

/**
 * M2 stock conservation invariant hook.
 * Verifies that flows reconcile within configured tolerance.
 */
export function createConservationInvariant(): InvariantHook {
  return (world: WorldState, context: TickContext, ledger: RuntimeLedger, config: SimulationConfig) => {
    const result = reconcileTickFlows(ledger, config);
    if (!result.success) {
      return result.errorMessage ?? "Conservation check failed";
    }
    return null;
  };
}

/**
 * M2 finite-value invariant hook.
 * Verifies all accumulated state remains finite.
 */
export function createFiniteValueInvariant(): InvariantHook {
  return (world: WorldState, context: TickContext, ledger: RuntimeLedger, config: SimulationConfig) => {
    for (const flow of ledger.flows) {
      if ("delta" in flow && !Number.isFinite(flow.delta)) {
        return `Non-finite delta in flow: ${flow}`;
      }
      if ("loss" in flow && !Number.isFinite(flow.loss)) {
        return `Non-finite loss in flow: ${flow}`;
      }
    }
    return null;
  };
}

/**
 * M2 default invariant registry with conservation and finite-value hooks.
 */
export function createDefaultInvariantRegistry(): InvariantRegistry {
  let registry = createEmptyInvariantRegistry();
  const conservationHook = createConservationInvariant();
  const finiteHook = createFiniteValueInvariant();

  // Register hooks for all phases (M2 is no-op, so hooks run at any phase)
  for (let phase = 0; phase < 16; phase++) {
    registry = registerPhaseInvariant(registry, phase, conservationHook);
    registry = registerPhaseInvariant(registry, phase, finiteHook);
  }

  return registry;
}
