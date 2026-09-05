/**
 * Definitions registry (REQ-CORE-003).
 *
 * See `docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md`
 * section 6: `DefinitionRegistry` holds immutable, scenario-versioned
 * content/reference definitions distinct from live world-entity instances —
 * `goods`, `recipes`, `eventDefinitions`, `metricDefinitions`. `DefinitionPack`
 * (`REQ-CONFIG-001`, `../config/definitionPack.ts`) already declares exactly
 * these four fields with matching key/value shapes, so this registry is a
 * typed, read-only view over a `DefinitionPack` rather than new storage.
 */
import type { DefinitionPack } from "../config/definitionPack";

export type DefinitionRegistry = Pick<
  DefinitionPack,
  "goods" | "recipes" | "eventDefinitions" | "metricDefinitions"
>;

/** Builds the definitions registry from `definitionPack`, unchanged. */
export function buildDefinitionRegistry(definitionPack: DefinitionPack): DefinitionRegistry {
  return {
    goods: definitionPack.goods,
    recipes: definitionPack.recipes,
    eventDefinitions: definitionPack.eventDefinitions,
    metricDefinitions: definitionPack.metricDefinitions,
  };
}
