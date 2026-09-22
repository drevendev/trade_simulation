/** M4 Phase-14 lifecycle extension of the canonical ephemeral tick context. */
import type { ProductionUnitLifecycleReview } from "./productionUnitLifecycle";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly productionUnitLifecycleReviews?: readonly ProductionUnitLifecycleReview[];
  }
}

export {};
