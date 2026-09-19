/** M4 Phase-15 tick-scoped wage-update extension of canonical TickContext. */
import type { WageOfferUpdate } from "./wageOfferUpdate";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly wageOfferUpdates?: readonly WageOfferUpdate[];
  }
}

export {};
