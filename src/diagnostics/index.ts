/**
 * Diagnostics module area (REQ-MIGRATION-003 scaffolding).
 *
 * Owns accounting ledgers, invariant reports and benchmark snapshots from
 * Milestone 1 onward. Deliberately empty of behavior in M0 — see AGENTS.md
 * and ADR 0002.
 */
export const DIAGNOSTICS_MODULE_AREA = "diagnostics" as const;

export { generateM1Preview, type M1Preview } from "./m1Preview";
export { generateM2Preview, type M2Preview } from "./m2Preview";
