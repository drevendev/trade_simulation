/** M4 Phase-9 population evidence extension of canonical TickContext. */
import type { HouseholdConsumptionExecution } from "./householdConsumptionExecution";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly householdConsumptionExecutions?: readonly HouseholdConsumptionExecution[];
  }
}

export {};
