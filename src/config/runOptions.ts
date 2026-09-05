/**
 * RunOptions layer (REQ-CONFIG-001).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "RunOptions chooses a run." It never carries behavioral tuning or
 * starting-world data — those belong to `SimulationConfig` and
 * `ScenarioDefinition` respectively.
 */
export interface RunOptions {
  readonly scenarioId: string;
  readonly seed: number;
  readonly maxTicks?: number;
  readonly diagnosticsLevel: "OFF" | "SUMMARY" | "DEBUG";
}
