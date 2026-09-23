/** Ephemeral M4 orchestration evidence carried only inside one TickContext. */

import type { MarketAllocation } from "./marketClearing";

declare module "./tickOrchestrator" {
  interface TickContext {
    /** Realized Phase-4 PRE_PRODUCTION allocations; never mixed with Phase-8 MAIN allocations. */
    readonly phase4MarketAllocations?: readonly MarketAllocation[];
  }
}

export {};
