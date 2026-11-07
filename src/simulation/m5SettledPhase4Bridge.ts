/**
 * M5 / #673 — opt-in physically settled Phase-4 bridge for regional ticks.
 *
 * Reuse the existing M4 canonical pre-production clearing and settlement
 * authorities, instead of treating caller-provided Phase-4 allocations as paid
 * purchases. MULTI_REGION is an explicit opt-in; autonomous Phase-2 planning
 * and cross-region Phase-4 purchases remain future M5 work.
 *
 * Phase 4 is exclusively owned here. The caller's world-transition function
 * is invoked for every OTHER phase, never for Phase 4, to prevent accidentally
 * settling the same purchase twice.
 */
import {
  phase4ProcurementHandler,
  type M4ClosedEconomyOptions,
} from "./m4ClosedEconomyOrchestrator";
import { createCanonicalPhase2ProductionPlanningHandler } from "./productionPlanning";
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
 * MULTI_REGION clears each local market against one shared authoritative world,
 * with stable region order. It does NOT turn local procurement into cross-border
 * trade; Phase-7 remains the sole owner of shipments and FX.
 */
export function createM5SettledPhase4Bridge(
  upstreamHandler: PhaseHandler,
  applyOtherPhaseTransition: PhaseWorldTransition,
  options: M4ClosedEconomyOptions,
  scope: "SINGLE_REGION" | "MULTI_REGION" = "SINGLE_REGION",
): M5SettledPhase4Bridge {
  const procurement = phase4ProcurementHandler(options, scope);
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

/**
 * M5/#673 opt-in regional Phase-2 production procurement from the live
 * opening WorldState. The existing canonical planner alone computes INPUT
 * quantities, gross prior-close budgets, and payroll authority for every
 * ProductionUnit, independently of Region traversal/insertion order.
 *
 * The upstream handler may still provide household plans, labor supply and
 * Phase-5 offers, but cannot replace production Phase-2 decisions. Local
 * settlements remain Phase-4-owned; FX and cross-border cargo stay Phase 7.
 * This deliberately does not enable any later-milestone policy behavior.
 */
export function createM5CanonicalRegionalPhase2Bridge(
  upstreamHandler: PhaseHandler,
  applyOtherPhaseTransition: PhaseWorldTransition,
  options: M4ClosedEconomyOptions,
): M5SettledPhase4Bridge {
  const canonicalPhase2 = createCanonicalPhase2ProductionPlanningHandler();
  const phase2Owner: PhaseHandler = (world, context, pending) => {
    const upstream = upstreamHandler(world, context, pending);
    if (context.phase !== 2) return upstream;
    if (context.productionPlans !== undefined ||
        context.laborDemandPlans !== undefined ||
        context.productionMarketIntents !== undefined ||
        upstream.productionPlans !== undefined ||
        upstream.laborDemandPlans !== undefined ||
        upstream.productionMarketIntents !== undefined) {
      throw new Error("M5 canonical regional Phase-2 forbids externally supplied production plans/intents");
    }
    return canonicalPhase2(world, upstream, pending);
  };
  return createM5SettledPhase4Bridge(
    phase2Owner, applyOtherPhaseTransition, options, "MULTI_REGION",
  );
}
