/**
 * M4 Phase-2 Population extension of canonical TickContext.
 *
 * LaborSupplyPlan is tick-scoped intent only. The module augmentation deliberately adds
 * no persistent employer link or second authoritative labor-market state.
 */
import type { LaborSupplyPlan } from "./laborSupplyPlanning";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly laborSupplyPlans?: readonly LaborSupplyPlan[];
  }
}

export {};
