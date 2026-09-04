/**
 * DefinitionPack layer (REQ-CONFIG-001).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "DefinitionPack owns immutable type definitions and recipes."
 * The definition types below (sections 15, 21) are named placeholders — their
 * concrete fields land with the baseline-definition-pack requirement
 * (`REQ-CONFIG-003`) that owns them, not with this scaffolding requirement.
 */
import type { GoodId } from "../domain/id";

/** Concrete fields land with the baseline definition pack requirement (section 15). */
export interface GoodDefinition {}

/** Concrete fields land with the baseline definition pack requirement (section 15). */
export interface RecipeDefinition {}

/** Concrete fields land with the events requirement that owns event definitions (section 13). */
export interface EventDefinition {}

/** Concrete fields land with whichever requirement first defines a derived diagnostic metric. */
export interface MetricDefinition {}

export interface DefinitionPack {
  readonly id: string;
  readonly version: string;
  readonly goods: Readonly<Record<GoodId, GoodDefinition>>;
  readonly recipes: Readonly<Record<string, RecipeDefinition>>;
  readonly eventDefinitions: Readonly<Record<string, EventDefinition>>;
  readonly metricDefinitions: Readonly<Record<string, MetricDefinition>>;
}
