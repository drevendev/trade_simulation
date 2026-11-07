/**
 * M5 / #673 — opt-in physically settled Phase-4 bridge for one-region ticks.
 *
 * Reuse the existing M4 canonical pre-production clearing and settlement
 * authorities, instead of treating caller-provided Phase-4 allocations as paid
 * purchases. This narrow bridge does NOT implement multiregion Phase-4 clearing
 * or autonomous Phase-2 planning; both remain future M5 work.
 *
 * Phase 4 is exclusively owned here. The caller's world-transition function
 * is invoked for every OTHER phase, never for Phase 4, to prevent accidentally
 * settling the same purchase twice.
 */
import {
  phase4ProcurementHandler,
  type M4ClosedEconomyOptions,
} from "./m4ClosedEconomyOrchestrator";
import { executeAllocation } from "./marketSettlementTransition";
import type { PhaseWorldTransition } from "./statefulTickOrchestrator";
import type { PhaseHandler } from "./tickOrchestrator";

export interface M5SettledPhase4Bridge {
  readonly handler: PhaseHandler;
  readonly applyPhaseTransition: PhaseWorldTransition;
}

/**
 * Compose before executeM5CanonicalIntakeTradeTick.
 *
 * Phase-2 intents are provided by the preceding real planning handler.
 * Phase-4 allocations are computed from persisted market prices and physical
 * seller inventories (with the M4 market's canonical quantity/budget rules).
 * The accepted allocations create journal transactions in Phase 4 and
 * atomically transfer inventory, wallet balances and taxes before Phase 5.
 * Downstream Phase-6/7/8 residuals therefore share paid, real stock evidence.
 *
 * The one-region limit is deliberate: M4's existing phase-4 procurement
 * authority refuses a multiregion world. Do not silently split/clone a world.
 */
export function createM5SettledPhase4Bridge(
  upstreamHandler: PhaseHandler,
  applyOtherPhaseTransition: PhaseWorldTransition,
  options: M4ClosedEconomyOptions,
): M5SettledPhase4Bridge {
  const procurement = phase4ProcurementHandler(options);
  return {
    handler: (world, context, pending) => {
      const next = upstreamHandler(world, context, pending);
      if (context.phase !== 4) return next;
      if (next.phase4MarketAllocations !== undefined) {
        throw new Error("M5 settled Phase-4 forbids caller-provided allocations");
      }
      return procurement(world, next, pending);
    },
    applyPhaseTransition: (phase, world, context) => {
      if (phase !== 4) return applyOtherPhaseTransition(phase, world, context);
      if (!Array.isArray(context.phase4MarketAllocations)) {
        throw new Error("M5 settled Phase-4 requires canonical allocation evidence");
      }
      // Each transition is immutable. If any preflight refuses, no successor
      // WorldState is published by executeStatefulTick (including earlier lots).
      let candidate = world;
      for (const allocation of context.phase4MarketAllocations) {
        candidate = executeAllocation(candidate, context, allocation);
      }
      return candidate;
    },
  };
}
