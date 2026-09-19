/** Tick-scoped REQ-POPULATION-001 evidence carried only inside Phase-2 TickContext. */
import type { MarketIntent } from "./marketIntent";
import type { HouseholdConsumptionPlan } from "./householdConsumptionPlanning";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly householdConsumptionPlans?: readonly HouseholdConsumptionPlan[];
    readonly householdMarketIntents?: readonly MarketIntent[];
  }
}

export {};
