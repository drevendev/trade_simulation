/**
 * Config module area (REQ-MIGRATION-003 scaffolding; REQ-CONFIG-001).
 *
 * Owns the four canonical configuration layers — `RunOptions`,
 * `SimulationConfig`, `ScenarioDefinition`, `DefinitionPack` — the validator
 * that mechanically rejects scenario-specific behavioral overrides, the
 * fail-fast `RunOptions`/`ScenarioDefinition` top-level shape validators
 * (REQ-CONFIG-005), and the keyed deterministic RNG service.
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2 and `docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`
 * Milestone 1.
 */
export const CONFIG_MODULE_AREA = "config" as const;

export type { RunOptions } from "./runOptions";

export {
  SIMULATION_CONFIG_BEHAVIORAL_KEYS,
  type CadenceConfig,
  type ClanConfig,
  type EventConfig,
  type ExpansionConfig,
  type FiscalConfig,
  type LaborConfig,
  type MarketConfig,
  type MonetaryConfig,
  type NumericConfig,
  type PerformanceConfig,
  type PopulationConfig,
  type ProductionConfig,
  type SimulationConfig,
  type TradeConfig,
} from "./simulationConfig";

export {
  SCENARIO_DEFINITION_KEYS,
  type BondSeed,
  type ClanSeed,
  type CohortSeed,
  type CurrencySeed,
  type InitialEventSeed,
  type MarketSeed,
  type MonetaryAuthoritySeed,
  type ProductionUnitSeed,
  type RegionSeed,
  type ScenarioDefinition,
  type ScenarioVariationConfig,
  type StateSeed,
  type TransportLinkSeed,
} from "./scenarioDefinition";

export {
  type DefinitionPack,
  type EventDefinition,
  type GoodDefinition,
  type MetricDefinition,
  type RecipeDefinition,
} from "./definitionPack";

export { assertNoBehavioralOverrides } from "./validation";

export {
  assertValidRunOptions,
  assertValidScenarioDefinitionShape,
} from "./shapeValidation";

export { deriveKeyedRandom, type RngKey } from "./rng";
