/**
 * M4 Phase-2 planning extension of the canonical per-tick context.
 *
 * Kept as a type-only module augmentation so `tickOrchestrator.ts` does not gain a
 * runtime dependency on the production subsystem. The values are ephemeral plans/intents
 * and are populated only by the Phase-2 production-planning handler.
 */
import type { MarketIntent } from "./marketIntent";
import type { LaborDemandPlan, ProductionPlan } from "./productionPlanning";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly productionPlans?: readonly ProductionPlan[];
    readonly laborDemandPlans?: readonly LaborDemandPlan[];
    readonly productionMarketIntents?: readonly MarketIntent[];
  }
}

export {};
