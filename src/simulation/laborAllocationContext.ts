/**
 * M4 Phase-3 labor-allocation extension of canonical TickContext.
 *
 * LaborAllocation is tick-scoped intent only. It does not create persistent employer
 * links or perform Phase-5 payroll settlement.
 */
import type { LaborAllocation } from "./laborAllocation";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly laborAllocations?: readonly LaborAllocation[];
  }
}

export {};
