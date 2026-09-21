/**
 * Completeness boundary for authoritative Phase-3 labor-allocation evidence.
 *
 * The Phase-3 handler always writes `TickContext.laborAllocations`, including an empty
 * array when the canonical allocation result is genuinely empty. Before Phase 3 the
 * field is absent. Phase-5 persistence must therefore bind to the completed tick
 * context rather than treating a caller-provided empty array as proof of zero payroll.
 */

import type { LaborAllocation } from "./laborAllocation";
import type { TickContext } from "./tickOrchestrator";

export function requireCompletePhase3LaborAllocationAuthority(
  context: TickContext,
  currentTick: number,
): readonly LaborAllocation[] {
  if (context.tick !== currentTick) {
    throw new Error(
      `Phase-3 labor-allocation authority is for tick ${context.tick}, expected authoritative Phase-5 tick ${currentTick}`,
    );
  }
  if (context.laborAllocations === undefined) {
    throw new Error(
      `Phase-5 wage persistence requires completed Phase-3 labor-allocation authority for tick ${currentTick}`,
    );
  }
  if (!Number.isInteger(context.phase) || context.phase < 3) {
    throw new Error(
      `Phase-3 labor-allocation authority for tick ${currentTick} is incomplete before Phase 3`,
    );
  }
  return context.laborAllocations;
}
