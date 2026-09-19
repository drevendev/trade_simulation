/**
 * Persistent M4 ProductionUnit state helpers (REQ-PRODUCTION-001).
 *
 * Handoff/05 section 3 makes installed capital the authoritative capacity stock,
 * keeps INPUT/OUTPUT/INVESTMENT inventories physically distinct, and adds a small
 * persistent production-signal state. Nameplate capacity is always derived; this
 * module deliberately exposes no mutable/serialized `capacity` field.
 */
import type { RecipeDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig, type LaborConfig, type ProductionConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";

export interface ProductionSignalState {
  readonly utilizationEma: number;
  readonly sellThroughEma: number;
  readonly marginSignalEma: number;
  readonly outputSalesEma: number;
  readonly inputUseEma: Readonly<Record<GoodId, number>>;
  readonly consecutiveNonviableReviews: number;
  readonly consecutiveViableReviews: number;
}

/** `-1` means no lifecycle review has occurred yet; lifecycle behavior lands later. */
export const INITIAL_LIFECYCLE_REVIEW_TICK = -1;

/** Resolve the canonical live opening wage from scenario seed or the LaborConfig default owner. */
export function resolveInitialWageOffer(seedWageOffer: number | undefined, labor: LaborConfig): number {
  const canonicalDefault = createDefaultSimulationConfig().labor.startingReferenceWage;
  const wageOffer = seedWageOffer ?? labor.startingReferenceWage ?? canonicalDefault;
  if (wageOffer === undefined) {
    throw new Error("canonical LaborConfig defaults must define startingReferenceWage");
  }
  requireNonNegativeFinite("ProductionUnitState.wageOffer", wageOffer);
  return wageOffer;
}

export interface ProductionUnitPersistentStateView {
  readonly wageOffer: number;
  readonly installedCapital: number;
  readonly inputInventory: ReadonlyMap<GoodId, number>;
  readonly outputInventory: ReadonlyMap<GoodId, number>;
  readonly investmentInventory: ReadonlyMap<GoodId, number>;
  readonly signals: ProductionSignalState;
  readonly lastLifecycleReviewTick: number;
}

function requireFiniteInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!isFiniteCanonicalNumber(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number in [${minimum},${maximum}], got ${String(value)}`);
  }
}

function requireNonNegativeFinite(name: string, value: number): void {
  if (!isFiniteCanonicalNumber(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number, got ${String(value)}`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

function requireInventory(name: string, inventory: ReadonlyMap<GoodId, number>): void {
  for (const [goodId, quantity] of inventory) {
    requireNonNegativeFinite(`${name}[${String(goodId)}]`, quantity);
  }
}

/**
 * Deterministic scenario-neutral M4 signal state. The two bounded planning EMAs use
 * their canonical configured neutral targets rather than inventing another baseline;
 * realized-flow EMAs and lifecycle counters start at zero.
 */
export function createInitialProductionSignalState(production: ProductionConfig): ProductionSignalState {
  // ProductionConfig controls are optional at the type boundary so older/minimal valid
  // scenarios remain constructible. When a caller omits the M4 planning targets, seed
  // these observer signals from the canonical default owner rather than duplicating a
  // numeric default here or rejecting an otherwise valid partial configuration.
  const canonicalProductionDefaults = createDefaultSimulationConfig().production;
  const utilizationEma = production.baseTargetUtilization ?? canonicalProductionDefaults.baseTargetUtilization;
  const sellThroughEma = production.targetSellThrough ?? canonicalProductionDefaults.targetSellThrough;

  if (utilizationEma === undefined || sellThroughEma === undefined) {
    throw new Error("canonical ProductionConfig defaults must define M4 production-signal targets");
  }

  requireFiniteInRange("ProductionSignalState.utilizationEma", utilizationEma, 0, 1);
  requireFiniteInRange("ProductionSignalState.sellThroughEma", sellThroughEma, 0, 1);

  return {
    utilizationEma,
    sellThroughEma,
    marginSignalEma: 0,
    outputSalesEma: 0,
    inputUseEma: {},
    consecutiveNonviableReviews: 0,
    consecutiveViableReviews: 0,
  };
}

/**
 * Canonical nameplate capacity, in recipe batches per tick. Installed capital is the
 * sole mutable authority; the recipe coefficient is immutable definition data.
 */
export function deriveNameplateCapacity(
  unit: Pick<ProductionUnitPersistentStateView, "installedCapital">,
  recipe: Pick<RecipeDefinition, "batchesPerCapitalUnit">,
): number {
  requireNonNegativeFinite("ProductionUnitState.installedCapital", unit.installedCapital);
  if (!isFiniteCanonicalNumber(recipe.batchesPerCapitalUnit) || recipe.batchesPerCapitalUnit <= 0) {
    throw new Error(
      `RecipeDefinition.batchesPerCapitalUnit must be a positive finite number, got ${String(recipe.batchesPerCapitalUnit)}`,
    );
  }

  const capacity = unit.installedCapital * recipe.batchesPerCapitalUnit;
  if (!isFiniteCanonicalNumber(capacity)) {
    throw new Error(`derived nameplate capacity must be finite, got ${String(capacity)}`);
  }
  return capacity;
}

/**
 * Fail-fast validation for the persistent state introduced/used by REQ-PRODUCTION-001.
 * Later requirements add behavioral validation at their own execution boundaries.
 */
export function validateProductionUnitPersistentState(unit: ProductionUnitPersistentStateView): void {
  requireNonNegativeFinite("ProductionUnitState.wageOffer", unit.wageOffer);
  requireNonNegativeFinite("ProductionUnitState.installedCapital", unit.installedCapital);

  if (
    unit.inputInventory === unit.outputInventory ||
    unit.inputInventory === unit.investmentInventory ||
    unit.outputInventory === unit.investmentInventory
  ) {
    throw new Error("ProductionUnitState INPUT, OUTPUT and INVESTMENT inventories must be distinct physical stocks");
  }

  requireInventory("ProductionUnitState.inputInventory", unit.inputInventory);
  requireInventory("ProductionUnitState.outputInventory", unit.outputInventory);
  requireInventory("ProductionUnitState.investmentInventory", unit.investmentInventory);

  requireFiniteInRange("ProductionSignalState.utilizationEma", unit.signals.utilizationEma, 0, 1);
  requireFiniteInRange("ProductionSignalState.sellThroughEma", unit.signals.sellThroughEma, 0, 1);
  requireFiniteInRange("ProductionSignalState.marginSignalEma", unit.signals.marginSignalEma, -1, 1);
  requireNonNegativeFinite("ProductionSignalState.outputSalesEma", unit.signals.outputSalesEma);
  for (const [goodId, value] of Object.entries(unit.signals.inputUseEma)) {
    requireNonNegativeFinite(`ProductionSignalState.inputUseEma[${goodId}]`, value);
  }
  requireNonNegativeInteger(
    "ProductionSignalState.consecutiveNonviableReviews",
    unit.signals.consecutiveNonviableReviews,
  );
  requireNonNegativeInteger(
    "ProductionSignalState.consecutiveViableReviews",
    unit.signals.consecutiveViableReviews,
  );

  if (!Number.isInteger(unit.lastLifecycleReviewTick) || unit.lastLifecycleReviewTick < INITIAL_LIFECYCLE_REVIEW_TICK) {
    throw new Error(
      `ProductionUnitState.lastLifecycleReviewTick must be an integer >= ${INITIAL_LIFECYCLE_REVIEW_TICK}, got ${String(unit.lastLifecycleReviewTick)}`,
    );
  }
}
