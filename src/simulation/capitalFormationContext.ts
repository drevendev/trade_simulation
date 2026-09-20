/**
 * M4 Phase-12 capital-formation extension of canonical TickContext.
 *
 * CapitalFormationExecution is tick-scoped evidence. Authoritative INVESTMENT inventory
 * and installed capital move only through applyCapitalFormationTransition().
 */
import type { CapitalFormationExecution } from "./capitalFormation";

declare module "./tickOrchestrator" {
  interface TickContext {
    readonly capitalFormationExecutions?: readonly CapitalFormationExecution[];
  }
}

export {};
