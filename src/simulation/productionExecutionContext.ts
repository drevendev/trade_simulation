/**
 * M4 Phase-5 production/extraction extension of canonical TickContext.
 *
 * ProductionExecution and post-production OUTPUT intents are tick-scoped evidence.
 * Authoritative inventories and regional finite-resource balances move only through
 * applyProductionExecutionTransition().
 */
import type { MarketIntent } from "./marketIntent";
import type { ProductionExecution } from "./productionExecution";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly productionExecutions?: readonly ProductionExecution[];
    readonly productionOutputIntents?: readonly MarketIntent[];
  }
}

export {};
