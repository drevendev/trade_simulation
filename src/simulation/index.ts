/**
 * Simulation module area (REQ-MIGRATION-003 scaffolding).
 *
 * Owns WorldState, TickContext, the phase orchestrator, reconciliation and
 * the keyed deterministic RNG service from Milestone 1 onward. Deliberately
 * empty of behavior in M0 — see AGENTS.md and ADR 0002.
 */
export const SIMULATION_MODULE_AREA = "simulation" as const;

export {
  buildInitialWorld,
  type ClanState,
  type CohortState,
  type CurrencyState,
  type LocalMarketState,
  type MonetaryAuthorityState,
  type ProductionUnitState,
  type RegionState,
  type StateState,
  type TransportLinkState,
  type WorldState,
} from "./worldState";
