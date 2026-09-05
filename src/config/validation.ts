/**
 * Behavioral-override rejection (REQ-CONFIG-001).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "Scenario-specific behavioral overrides are forbidden in core v1.
 * If a scenario needs different rules, it must select a named config
 * profile/version rather than patch arbitrary fields." This module is the
 * mechanical proof of that sentence: it inspects a scenario-shaped candidate
 * object and throws before a smuggled `SimulationConfig`-owned key, or any key
 * `ScenarioDefinition` does not declare, can reach world construction.
 *
 * This is a shape/key check only — full field-level content validation
 * (bounds, cross-references, uniqueness) is `REQ-CONFIG-005`, not this
 * requirement.
 */
import { SIMULATION_CONFIG_BEHAVIORAL_KEYS } from "./simulationConfig";
import { SCENARIO_DEFINITION_KEYS } from "./scenarioDefinition";

const BEHAVIORAL_KEY_SET: ReadonlySet<string> = new Set(SIMULATION_CONFIG_BEHAVIORAL_KEYS);
const SCENARIO_KEY_SET: ReadonlySet<string> = new Set(SCENARIO_DEFINITION_KEYS);

/**
 * `markets` and `clans` are declared by both hierarchies (a `MarketSeed[]`/
 * `ClanSeed[]` list on `ScenarioDefinition`, a `MarketConfig`/`ClanConfig`
 * object on `SimulationConfig`). An array value is the legitimate scenario
 * seed list; anything else at that key name is a smuggled behavioral patch.
 */
function isLegitimateScenarioArrayField(key: string, value: unknown): boolean {
  return SCENARIO_KEY_SET.has(key) && Array.isArray(value);
}

/**
 * Throws unless `candidate` is a plain, non-array object whose own keys are
 * all declared by `ScenarioDefinition`, carrying no `SimulationConfig`-owned
 * behavioral key. Does not check that required `ScenarioDefinition` fields are
 * present, nor validate field content — see the module doc comment.
 */
export function assertNoBehavioralOverrides(
  candidate: unknown,
): asserts candidate is Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(
      `scenario definition candidate must be a plain object, got ${describeShape(candidate)}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    const value = (candidate as Record<string, unknown>)[key];

    if (BEHAVIORAL_KEY_SET.has(key) && !isLegitimateScenarioArrayField(key, value)) {
      throw new Error(
        `scenario definition carries SimulationConfig-owned behavioral key "${key}": ` +
          "scenario-specific behavioral overrides are forbidden in core v1 — select a " +
          "named config profile/version instead of patching arbitrary fields",
      );
    }

    if (!SCENARIO_KEY_SET.has(key)) {
      throw new Error(
        `scenario definition carries an unknown key "${key}" not declared by ScenarioDefinition`,
      );
    }
  }
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
