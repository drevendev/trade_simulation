/**
 * DefinitionPack layer (REQ-CONFIG-001; `GoodDefinition` and `RecipeDefinition` shapes REQ-CONFIG-003).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "DefinitionPack owns immutable type definitions and recipes."
 * Section 16A gives the RecipeDefinition shape; it mirrors the contract from
 * PRODUCTION_CAPITAL_LABOR_CONTRACTS.md. Types owned by later requirements remain
 * empty placeholders below.
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

/**
 * Section 16A: M1 executable initialization boundary (REQ-CONFIG-003).
 * RecipeDefinition is immutable DefinitionPack data. Its M1 field shape is
 * the same definition-data contract owned by PRODUCTION_CAPITAL_LABOR_CONTRACTS.
 * Validation requires: positive output and batches-per-capital-unit, non-negative
 * input/labor/startup-capital quantities, [0,1] infrastructure factor where
 * present, positive extraction amount when an extraction resource is named,
 * positive baseThroughputFactor, and depreciationRatePerTick in [0,1).
 */
export interface RecipeDefinition {
  readonly id: string;
  readonly outputGoodId: GoodId;
  readonly outputPerBatch: number;
  readonly inputsPerBatch: Readonly<Record<GoodId, number>>;
  readonly laborCategory: string;
  readonly laborPerBatch: number;
  readonly batchesPerCapitalUnit: number;
  readonly investmentGoodsPerCapitalUnit: Readonly<Record<GoodId, number>>;
  readonly minimumStartupCapital: number;
  readonly infrastructureCategory?: string;
  readonly minimumInfrastructureFactor?: number;
  readonly extractionResourceId?: string;
  readonly extractedResourcePerBatch?: number;
  readonly baseThroughputFactor: number;
  readonly depreciationRatePerTick: number;
}

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
