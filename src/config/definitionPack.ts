/**
 * DefinitionPack layer (REQ-CONFIG-001; `GoodDefinition` shape REQ-CONFIG-003).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "DefinitionPack owns immutable type definitions and recipes."
 * `RecipeDefinition` (section 15, named only in prose with no formal field list)
 * and the types owned by later requirements remain empty placeholders below.
 */
import type { GoodId } from "../domain/id";

/**
 * Section 15's bullet list, field for field. `consumerNeedCategory` has no
 * enumerated vocabulary in this anchor document, so it is a nullable string
 * rather than an invented literal union. `necessityWeight` and
 * `substitutionGroup` are optional per the same section's "where consumed by
 * households" qualifier; `capitalInfrastructureEligibilityTags` is optional
 * per its own "where relevant" qualifier.
 */
export interface GoodDefinition {
  readonly id: GoodId;
  readonly name: string;
  readonly unitLabel: string;
  readonly spoilageRatePerTick: number;
  readonly consumerNeedCategory: string | null;
  readonly necessityWeight?: number;
  readonly substitutionGroup?: string;
  /** Initialization/diagnostics only — never an equilibrium anchor. */
  readonly referencePrice: number;
  readonly tradable: boolean;
  readonly capitalInfrastructureEligibilityTags?: readonly string[];
}

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
