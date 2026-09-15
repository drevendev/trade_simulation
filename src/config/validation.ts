/**
 * Configuration validation (REQ-CONFIG-001 behavioral-override rejection;
 * REQ-CONFIG-005 content validation).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "Scenario-specific behavioral overrides are forbidden in core v1."
 * This module is the mechanical proof: it inspects a scenario-shaped candidate
 * object and throws before a smuggled `SimulationConfig`-owned key, or any key
 * `ScenarioDefinition` does not declare, can reach world construction.
 *
 * Section 21 "Validation rules" defines the content validation that must fail
 * fast: invalid cross-references, non-finite values, out-of-range configuration,
 * and useful diagnostics for all failures.
 */
import { isFiniteCanonicalNumber } from "../domain/numeric";
import type { CohortSeed, MarketSeed, ProductionUnitSeed, RegionSeed, ScenarioDefinition, TransportLinkSeed } from "./scenarioDefinition";
import type { DefinitionPack, NeedCategoryDefinition } from "./definitionPack";
import { BASELINE_NEED_CATEGORY_IDS } from "./definitionPack";
import { SIMULATION_CONFIG_BEHAVIORAL_KEYS } from "./simulationConfig";
import type { LaborConfig, PopulationConfig, ProductionConfig } from "./simulationConfig";
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

/**
 * Throws unless the scenario content is valid: all cross-references resolve,
 * all numeric values are finite and in-range, and scenarios do not carry
 * unknown IDs. Does not check top-level shape (see `shapeValidation.ts`) or
 * behavioral-override keys (see `assertNoBehavioralOverrides` above).
 *
 * Produces useful diagnostics identifying the field, value and reason for
 * every validation failure. Does not silently coerce or substitute defaults.
 */
export function validateScenarioContent(scenario: ScenarioDefinition): void {
  const regionKeySet = new Set(scenario.geography.map((r) => r.key));
  const stateKeySet = new Set(scenario.states.map((s) => s.key));
  const currencyKeySet = new Set(scenario.currencies.map((c) => c.key));
  const authorityKeySet = new Set(scenario.monetaryAuthorities.map((a) => a.key));
  const clanKeySet = new Set(scenario.clans.map((cl) => cl.key));

  for (const region of scenario.geography) {
    validateRegionSeed(region, stateKeySet, currencyKeySet);
  }

  for (const link of scenario.transportLinks) {
    validateTransportLinkSeed(link, regionKeySet, stateKeySet);
  }

  for (const cohort of scenario.cohorts) {
    validateCohortSeed(cohort, regionKeySet, clanKeySet);
  }

  for (const unit of scenario.productionUnits) {
    validateProductionUnitSeed(unit, regionKeySet, stateKeySet, clanKeySet);
  }

  if (scenario.markets) {
    for (const market of scenario.markets) {
      validateMarketSeed(market, regionKeySet);
    }
  }

  validateScenarioVariation(scenario.variation);
}

/**
 * Throws unless the DefinitionPack recipes satisfy REQ-CONFIG-003 bounds validation
 * (section 16A of CANONICAL_CONFIG_AND_WORLD_GENERATION.md):
 * - outputGoodId must name a good the pack declares (REQ-CONFIG-005, Issue #509)
 * - outputPerBatch must be positive
 * - every declared inputsPerBatch coefficient must be strictly positive and keyed by a
 *   good the pack declares (REQ-CONFIG-005, Issue #508)
 * - laborPerBatch must be non-negative
 * - batchesPerCapitalUnit must be positive
 * - minimumStartupCapital must be non-negative
 * - infrastructureMinimumFactor (if present) must be in [0,1]
 * - extractedResourcePerBatch (if present) must be positive
 * - baseThroughputFactor must be positive
 * - depreciationRatePerTick must be in [0,1)
 * - every declared investmentGoodsPerCapitalUnit coefficient must be strictly
 *   positive and keyed by a good the pack declares (REQ-CONFIG-005, Issue #465)
 *
 * and, when the pack declares `needCategories` (REQ-CONFIG-007), the rules in
 * `validateNeedCategories` below.
 *
 * Produces useful diagnostics identifying the recipe, field, value and reason for
 * every validation failure. Does not silently coerce or substitute defaults.
 */
export function validateDefinitionPack(definitionPack: DefinitionPack): void {
  const declaredGoodKeys = new Set(Object.keys(definitionPack.goods ?? {}));

  validateNeedCategories(definitionPack.needCategories, declaredGoodKeys);

  Object.entries(definitionPack.recipes ?? {}).forEach(([recipeId, recipe]) => {
    // outputGoodId: a good the pack declares. Section 21 fails configuration validation
    // fast on unknown Good IDs and invariant 24.3 requires every ID to be
    // reference-valid, but this reference was checked nowhere: unlike the two good-keyed
    // maps below, no canonical reader consumes `outputGoodId` yet — production is M4 — so
    // an undeclared output Good survived step 1 and reached the constructed world with
    // nothing downstream to reject it (Issue #509).
    if (!declaredGoodKeys.has(recipe.outputGoodId as unknown as string)) {
      throw new Error(
        `RecipeDefinition "${recipeId}": outputGoodId "${recipe.outputGoodId}" references a Good the DefinitionPack does not declare`,
      );
    }

    // outputPerBatch: positive (> 0)
    if (!isFiniteCanonicalNumber(recipe.outputPerBatch) || recipe.outputPerBatch <= 0) {
      throw new Error(
        `RecipeDefinition "${recipeId}": outputPerBatch must be a positive finite number, got ${describeValue(recipe.outputPerBatch)}`,
      );
    }

    // inputsPerBatch: every key a declared good, every coefficient strictly positive
    // (> 0). An empty map is a real "no material input" declaration and stays valid.
    // Section 21 fails configuration validation fast on unknown Good IDs, and the
    // sibling investmentGoodsPerCapitalUnit check below already enforced that for the
    // other good-keyed recipe map (Issue #508).
    if (recipe.inputsPerBatch) {
      Object.entries(recipe.inputsPerBatch).forEach(([goodKey, coefficient]) => {
        if (!declaredGoodKeys.has(goodKey)) {
          throw new Error(
            `RecipeDefinition "${recipeId}": inputsPerBatch["${goodKey}"] references a Good the DefinitionPack does not declare`,
          );
        }

        if (!isFiniteCanonicalNumber(coefficient) || coefficient <= 0) {
          throw new Error(
            `RecipeDefinition "${recipeId}": inputsPerBatch["${goodKey}"] must be a strictly positive finite number, got ${describeValue(coefficient)}`,
          );
        }
      });
    }

    // laborPerBatch: non-negative (>= 0)
    if (!isFiniteCanonicalNumber(recipe.laborPerBatch) || recipe.laborPerBatch < 0) {
      throw new Error(
        `RecipeDefinition "${recipeId}": laborPerBatch must be a non-negative finite number, got ${describeValue(recipe.laborPerBatch)}`,
      );
    }

    // batchesPerCapitalUnit: positive (> 0)
    if (!isFiniteCanonicalNumber(recipe.batchesPerCapitalUnit) || recipe.batchesPerCapitalUnit <= 0) {
      throw new Error(
        `RecipeDefinition "${recipeId}": batchesPerCapitalUnit must be a positive finite number, got ${describeValue(recipe.batchesPerCapitalUnit)}`,
      );
    }

    // minimumStartupCapital: non-negative (>= 0)
    if (!isFiniteCanonicalNumber(recipe.minimumStartupCapital) || recipe.minimumStartupCapital < 0) {
      throw new Error(
        `RecipeDefinition "${recipeId}": minimumStartupCapital must be a non-negative finite number, got ${describeValue(recipe.minimumStartupCapital)}`,
      );
    }

    // infrastructureMinimumFactor (if present): [0,1]
    if (recipe.minimumInfrastructureFactor !== undefined) {
      if (!isFiniteCanonicalNumber(recipe.minimumInfrastructureFactor) || recipe.minimumInfrastructureFactor < 0 || recipe.minimumInfrastructureFactor > 1) {
        throw new Error(
          `RecipeDefinition "${recipeId}": minimumInfrastructureFactor must be a finite number in [0,1] when present, got ${describeValue(recipe.minimumInfrastructureFactor)}`,
        );
      }
    }

    // Extraction resource/amount coupling: both present or both absent
    const hasExtractionResource = recipe.extractionResourceId !== undefined;
    const hasExtractedAmount = recipe.extractedResourcePerBatch !== undefined;

    if (hasExtractionResource && !hasExtractedAmount) {
      throw new Error(
        `RecipeDefinition "${recipeId}": extractionResourceId "${recipe.extractionResourceId}" is present but extractedResourcePerBatch is missing — both must be present together`,
      );
    }

    if (hasExtractedAmount && !hasExtractionResource) {
      throw new Error(
        `RecipeDefinition "${recipeId}": extractedResourcePerBatch is present but extractionResourceId is missing — both must be present together`,
      );
    }

    // extractedResourcePerBatch (if present): positive (> 0)
    if (recipe.extractedResourcePerBatch !== undefined) {
      if (!isFiniteCanonicalNumber(recipe.extractedResourcePerBatch) || recipe.extractedResourcePerBatch <= 0) {
        throw new Error(
          `RecipeDefinition "${recipeId}": extractedResourcePerBatch must be a positive finite number when present, got ${describeValue(recipe.extractedResourcePerBatch)}`,
        );
      }
    }

    // baseThroughputFactor: positive (> 0)
    if (!isFiniteCanonicalNumber(recipe.baseThroughputFactor) || recipe.baseThroughputFactor <= 0) {
      throw new Error(
        `RecipeDefinition "${recipeId}": baseThroughputFactor must be a positive finite number, got ${describeValue(recipe.baseThroughputFactor)}`,
      );
    }

    // depreciationRatePerTick: in [0,1)
    if (!isFiniteCanonicalNumber(recipe.depreciationRatePerTick) || recipe.depreciationRatePerTick < 0 || recipe.depreciationRatePerTick >= 1) {
      throw new Error(
        `RecipeDefinition "${recipeId}": depreciationRatePerTick must be a finite number in [0,1), got ${describeValue(recipe.depreciationRatePerTick)}`,
      );
    }

    // investmentGoodsPerCapitalUnit: every key a declared good, every coefficient
    // strictly positive. An empty map is a real "no investment good" declaration and
    // stays valid; without this check an invalid entry is instead dropped downstream by
    // resolveCapitalGoodsPerCapitalUnit() and becomes indistinguishable from that
    // declaration on both the emitting and the reconciling side (Issue #465).
    if (recipe.investmentGoodsPerCapitalUnit) {
      Object.entries(recipe.investmentGoodsPerCapitalUnit).forEach(([goodKey, coefficient]) => {
        if (!declaredGoodKeys.has(goodKey)) {
          throw new Error(
            `RecipeDefinition "${recipeId}": investmentGoodsPerCapitalUnit["${goodKey}"] references a Good the DefinitionPack does not declare`,
          );
        }

        if (!isFiniteCanonicalNumber(coefficient) || coefficient <= 0) {
          throw new Error(
            `RecipeDefinition "${recipeId}": investmentGoodsPerCapitalUnit["${goodKey}"] must be a strictly positive finite number, got ${describeValue(coefficient)}`,
          );
        }
      });
    }
  });
}

function validateRegionSeed(region: RegionSeed, stateKeySet: Set<string>, currencyKeySet: Set<string>): void {
  if (region.controllerStateKey !== null && !stateKeySet.has(region.controllerStateKey)) {
    throw new Error(
      `RegionSeed "${region.key}": controllerStateKey "${region.controllerStateKey}" references a non-existent State`,
    );
  }

  if (!currencyKeySet.has(region.settlementCurrencyKey)) {
    throw new Error(
      `RegionSeed "${region.key}": settlementCurrencyKey "${region.settlementCurrencyKey}" references a non-existent Currency`,
    );
  }

  if (!isFiniteCanonicalNumber(region.settlementLevel)) {
    throw new Error(
      `RegionSeed "${region.key}": settlementLevel must be a finite number, got ${describeValue(region.settlementLevel)}`,
    );
  }

  for (const [infrastructureKey, infrastructureValue] of Object.entries(region.infrastructure)) {
    if (!isFiniteCanonicalNumber(infrastructureValue)) {
      throw new Error(
        `RegionSeed "${region.key}": infrastructure["${infrastructureKey}"] must be a finite number, got ${describeValue(infrastructureValue)}`,
      );
    }
  }

  for (const [climateKey, climateValue] of Object.entries(region.climateHabitabilityInputs)) {
    if (!isFiniteCanonicalNumber(climateValue)) {
      throw new Error(
        `RegionSeed "${region.key}": climateHabitabilityInputs["${climateKey}"] must be a finite number, got ${describeValue(climateValue)}`,
      );
    }
  }

  for (const deposit of region.deposits) {
    if (!isFiniteCanonicalNumber(deposit.initialQuantity) || deposit.initialQuantity < 0) {
      throw new Error(
        `RegionSeed "${region.key}": deposit "${deposit.resourceId}" initialQuantity must be a non-negative finite number, got ${describeValue(deposit.initialQuantity)}`,
      );
    }
  }
}

function validateTransportLinkSeed(link: TransportLinkSeed, regionKeySet: Set<string>, stateKeySet: Set<string>): void {
  if (!regionKeySet.has(link.fromRegionKey)) {
    throw new Error(
      `TransportLinkSeed "${link.key}": fromRegionKey "${link.fromRegionKey}" references a non-existent Region`,
    );
  }

  if (!regionKeySet.has(link.toRegionKey)) {
    throw new Error(
      `TransportLinkSeed "${link.key}": toRegionKey "${link.toRegionKey}" references a non-existent Region`,
    );
  }

  if (link.feeReceiverStateKey !== null && link.feeReceiverStateKey !== undefined && !stateKeySet.has(link.feeReceiverStateKey)) {
    throw new Error(
      `TransportLinkSeed "${link.key}": feeReceiverStateKey "${link.feeReceiverStateKey}" references a non-existent State`,
    );
  }

  if (!isFiniteCanonicalNumber(link.distance) || link.distance < 0) {
    throw new Error(
      `TransportLinkSeed "${link.key}": distance must be a non-negative finite number, got ${describeValue(link.distance)}`,
    );
  }

  if (!isFiniteCanonicalNumber(link.baseCapacity) || link.baseCapacity < 0) {
    throw new Error(
      `TransportLinkSeed "${link.key}": baseCapacity must be a non-negative finite number, got ${describeValue(link.baseCapacity)}`,
    );
  }

  if (!isFiniteCanonicalNumber(link.condition) || link.condition < 0 || link.condition > 1) {
    throw new Error(
      `TransportLinkSeed "${link.key}": condition must be a finite number in [0,1], got ${describeValue(link.condition)}`,
    );
  }

  if (!isFiniteCanonicalNumber(link.baseTransportCost)) {
    throw new Error(
      `TransportLinkSeed "${link.key}": baseTransportCost must be a finite number, got ${describeValue(link.baseTransportCost)}`,
    );
  }

  if (link.transitTicks !== undefined && (!isFiniteCanonicalNumber(link.transitTicks) || link.transitTicks < 0)) {
    throw new Error(
      `TransportLinkSeed "${link.key}": transitTicks must be a non-negative finite number when present, got ${describeValue(link.transitTicks)}`,
    );
  }
}

function validateCohortSeed(cohort: CohortSeed, regionKeySet: Set<string>, clanKeySet: Set<string>): void {
  if (!regionKeySet.has(cohort.regionKey)) {
    throw new Error(
      `CohortSeed "${cohort.key}": regionKey "${cohort.regionKey}" references a non-existent Region`,
    );
  }

  if (!clanKeySet.has(cohort.clanKey)) {
    throw new Error(
      `CohortSeed "${cohort.key}": clanKey "${cohort.clanKey}" references a non-existent Clan`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.population) || cohort.population <= 0) {
    throw new Error(
      `CohortSeed "${cohort.key}": population must be a positive finite number, got ${describeValue(cohort.population)}`,
    );
  }

  for (const [currencyKey, walletAmount] of Object.entries(cohort.wallet)) {
    if (!isFiniteCanonicalNumber(walletAmount) || walletAmount < 0) {
      throw new Error(
        `CohortSeed "${cohort.key}": wallet["${currencyKey}"] must be a non-negative finite number, got ${describeValue(walletAmount)}`,
      );
    }
  }

  for (const [goodKey, inventoryAmount] of Object.entries(cohort.householdInventory)) {
    if (!isFiniteCanonicalNumber(inventoryAmount) || inventoryAmount < 0) {
      throw new Error(
        `CohortSeed "${cohort.key}": householdInventory["${goodKey}"] must be a non-negative finite number, got ${describeValue(inventoryAmount)}`,
      );
    }
  }

  if (!isFiniteCanonicalNumber(cohort.healthIndex) || cohort.healthIndex < 0 || cohort.healthIndex > 1) {
    throw new Error(
      `CohortSeed "${cohort.key}": healthIndex must be a finite number in [0,1], got ${describeValue(cohort.healthIndex)}`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.prosperityEma) || cohort.prosperityEma < 0 || cohort.prosperityEma > 1) {
    throw new Error(
      `CohortSeed "${cohort.key}": prosperityEma must be a finite number in [0,1], got ${describeValue(cohort.prosperityEma)}`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.essentialSatisfactionEma) || cohort.essentialSatisfactionEma < 0 || cohort.essentialSatisfactionEma > 1) {
    throw new Error(
      `CohortSeed "${cohort.key}": essentialSatisfactionEma must be a finite number in [0,1], got ${describeValue(cohort.essentialSatisfactionEma)}`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.realIncomePerCapitaEma) || cohort.realIncomePerCapitaEma < 0) {
    throw new Error(
      `CohortSeed "${cohort.key}": realIncomePerCapitaEma must be a non-negative finite number, got ${describeValue(cohort.realIncomePerCapitaEma)}`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.employmentRateEma) || cohort.employmentRateEma < 0 || cohort.employmentRateEma > 1) {
    throw new Error(
      `CohortSeed "${cohort.key}": employmentRateEma must be a finite number in [0,1], got ${describeValue(cohort.employmentRateEma)}`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.migrationPressureEma) || cohort.migrationPressureEma < -1 || cohort.migrationPressureEma > 1) {
    throw new Error(
      `CohortSeed "${cohort.key}": migrationPressureEma must be a finite number in [-1,1], got ${describeValue(cohort.migrationPressureEma)}`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.mobilityAccumulator) || cohort.mobilityAccumulator < -1 || cohort.mobilityAccumulator > 1) {
    throw new Error(
      `CohortSeed "${cohort.key}": mobilityAccumulator must be a finite number in [-1,1], got ${describeValue(cohort.mobilityAccumulator)}`,
    );
  }

  if (!isFiniteCanonicalNumber(cohort.wageSignal) || cohort.wageSignal < 0) {
    throw new Error(
      `CohortSeed "${cohort.key}": wageSignal must be a non-negative finite number, got ${describeValue(cohort.wageSignal)}`,
    );
  }
}

function validateProductionUnitSeed(unit: ProductionUnitSeed, regionKeySet: Set<string>, stateKeySet: Set<string>, clanKeySet: Set<string>): void {
  if (!regionKeySet.has(unit.regionKey)) {
    throw new Error(
      `ProductionUnitSeed "${unit.key}": regionKey "${unit.regionKey}" references a non-existent Region`,
    );
  }

  if (unit.owner.type === "STATE") {
    if (!stateKeySet.has(unit.owner.key)) {
      throw new Error(
        `ProductionUnitSeed "${unit.key}": owner State key "${unit.owner.key}" references a non-existent State`,
      );
    }
  } else if (unit.owner.type === "CLAN") {
    if (!clanKeySet.has(unit.owner.key)) {
      throw new Error(
        `ProductionUnitSeed "${unit.key}": owner Clan key "${unit.owner.key}" references a non-existent Clan`,
      );
    }
  }

  for (const [currencyKey, walletAmount] of Object.entries(unit.wallet)) {
    if (!isFiniteCanonicalNumber(walletAmount) || walletAmount < 0) {
      throw new Error(
        `ProductionUnitSeed "${unit.key}": wallet["${currencyKey}"] must be a non-negative finite number, got ${describeValue(walletAmount)}`,
      );
    }
  }

  for (const [goodKey, inventoryAmount] of Object.entries(unit.inputInventory)) {
    if (!isFiniteCanonicalNumber(inventoryAmount) || inventoryAmount < 0) {
      throw new Error(
        `ProductionUnitSeed "${unit.key}": inputInventory["${goodKey}"] must be a non-negative finite number, got ${describeValue(inventoryAmount)}`,
      );
    }
  }

  for (const [goodKey, inventoryAmount] of Object.entries(unit.outputInventory)) {
    if (!isFiniteCanonicalNumber(inventoryAmount) || inventoryAmount < 0) {
      throw new Error(
        `ProductionUnitSeed "${unit.key}": outputInventory["${goodKey}"] must be a non-negative finite number, got ${describeValue(inventoryAmount)}`,
      );
    }
  }

  if (unit.investmentInventory) {
    for (const [goodKey, inventoryAmount] of Object.entries(unit.investmentInventory)) {
      if (!isFiniteCanonicalNumber(inventoryAmount) || inventoryAmount < 0) {
        throw new Error(
          `ProductionUnitSeed "${unit.key}": investmentInventory["${goodKey}"] must be a non-negative finite number, got ${describeValue(inventoryAmount)}`,
        );
      }
    }
  }

  if (!isFiniteCanonicalNumber(unit.installedCapital) || unit.installedCapital < 0) {
    throw new Error(
      `ProductionUnitSeed "${unit.key}": installedCapital must be a non-negative finite number, got ${describeValue(unit.installedCapital)}`,
    );
  }

  if (!isFiniteCanonicalNumber(unit.condition) || unit.condition < 0 || unit.condition > 1) {
    throw new Error(
      `ProductionUnitSeed "${unit.key}": condition must be a finite number in [0,1], got ${describeValue(unit.condition)}`,
    );
  }

  if (unit.wageOffer !== undefined && (!isFiniteCanonicalNumber(unit.wageOffer) || unit.wageOffer < 0)) {
    throw new Error(
      `ProductionUnitSeed "${unit.key}": wageOffer must be a non-negative finite number when present, got ${describeValue(unit.wageOffer)}`,
    );
  }
}

function validateMarketSeed(market: MarketSeed, regionKeySet: Set<string>): void {
  if (!regionKeySet.has(market.regionKey)) {
    throw new Error(
      `MarketSeed for region "${market.regionKey}": references a non-existent Region`,
    );
  }

  for (const [goodKey, price] of Object.entries(market.initialPriceByGood)) {
    if (!isFiniteCanonicalNumber(price) || price <= 0) {
      throw new Error(
        `MarketSeed for region "${market.regionKey}": initialPriceByGood["${goodKey}"] must be a positive finite number, got ${describeValue(price)}`,
      );
    }
  }
}

function validateScenarioVariation(variation: unknown): void {
  if (variation === null || variation === undefined) {
    return;
  }

  if (typeof variation !== "object" || Array.isArray(variation)) {
    throw new Error(
      `ScenarioVariationConfig must be a plain object when present, got ${describeValue(variation)}`,
    );
  }

  const config = variation as Record<string, unknown>;

  if (typeof config.enabled !== "boolean") {
    throw new Error(
      `ScenarioVariationConfig.enabled must be a boolean, got ${describeValue(config.enabled)}`,
    );
  }

  for (const field of ["populationFactorRange", "depositQuantityFactorRange", "startingInventoryFactorRange", "startingCashFactorRange", "infrastructureFactorRange"]) {
    const range = config[field];
    if (range !== undefined) {
      if (!Array.isArray(range) || range.length !== 2) {
        throw new Error(
          `ScenarioVariationConfig.${field} must be a [min, max] range when present, got ${describeValue(range)}`,
        );
      }

      const [min, max] = range as unknown[];
      if (!isFiniteCanonicalNumber(min) || !isFiniteCanonicalNumber(max)) {
        throw new Error(
          `ScenarioVariationConfig.${field} must contain finite numbers, got [${describeValue(min)}, ${describeValue(max)}]`,
        );
      }

      if (min > max) {
        throw new Error(
          `ScenarioVariationConfig.${field} must have min <= max, got [${min}, ${max}]`,
        );
      }
    }
  }
}

/**
 * Maximum labor categories a v1 definition pack may declare. Handoff/03 section 7:
 * "Core baseline has exactly one labor category GENERAL. Definition packs may add at
 * most three broad categories in v1; adding recipe-specific professions requires a
 * later design change."
 */
const MAX_LABOR_CATEGORIES = 3;

/**
 * The numeric controls of a config block. `LaborConfig.allowedLaborCategories` is the
 * one non-numeric field, and it has its own validator, so this keeps the scalar-range
 * field lists below from naming it by mistake.
 */
type NumericControl<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends number ? K : never;
}[keyof T];

/**
 * Throws unless every `ProductionConfig` control present is finite and inside its
 * declared range (REQ-CONFIG-006).
 *
 * The field list is section 37 of `06 - Handoff/05 — PRODUCTION_CAPITAL_LABOR_CONTRACTS.md`.
 * Ranges are structural — what the quantity is, not what a good value would be: a
 * utilization or a share is a fraction in [0,1], a cadence in ticks or a review count
 * is a positive integer, a coverage in ticks is non-negative. Controls whose sign is
 * genuinely open, such as a margin threshold, are checked for finiteness only.
 *
 * Every field is optional, so absence is never an error here: section 6 of Handoff/03
 * states no value for eleven of them and `createDefaultSimulationConfig` does not
 * invent one. Presence is what gets checked.
 *
 * Produces useful diagnostics identifying the field, value and reason for every
 * validation failure. Does not silently coerce or substitute defaults.
 */
export function validateProductionConfig(production: ProductionConfig): void {
  const unitInterval: readonly NumericControl<ProductionConfig>[] = [
    "baseTargetUtilization",
    "minTargetUtilization",
    "maxTargetUtilization",
    "targetSellThrough",
    "liquidityBufferShare",
    "investmentUtilizationThreshold",
    "investmentPropensity",
    "maxInvestmentShareOfExcessCash",
    "productionSignalAlpha",
    "mothballUtilizationThreshold",
  ];
  for (const field of unitInterval) {
    assertInClosedUnitInterval("ProductionConfig", field, production[field]);
  }

  const nonNegative: readonly NumericControl<ProductionConfig>[] = [
    "marginResponse",
    "sellThroughResponse",
    "inventoryResponse",
    "outputCoverageTicks",
    "inputCoverageTicks",
    "inputSafetyCoverageTicks",
    "minOperatingCash",
    "maxCapitalGrowthPerReview",
  ];
  for (const field of nonNegative) {
    assertNonNegative("ProductionConfig", field, production[field]);
  }

  const positive: readonly NumericControl<ProductionConfig>[] = ["maxInputCriticality", "minimumLifecycleScale"];
  for (const field of positive) {
    assertPositive("ProductionConfig", field, production[field]);
  }

  // A cadence of zero ticks has no meaning: the review would never be scheduled.
  const positiveInteger: readonly NumericControl<ProductionConfig>[] = [
    "investmentReviewCadenceTicks",
    "lifecycleReviewCadenceTicks",
    "mothballAfterReviews",
    "reactivateAfterReviews",
    "closeAfterReviews",
  ];
  for (const field of positiveInteger) {
    assertPositiveInteger("ProductionConfig", field, production[field]);
  }

  // A grace period of zero reviews is meaningful: close on the next review.
  assertNonNegativeInteger("ProductionConfig", "closingGraceReviews", production.closingGraceReviews);

  // A unit may plan against a negative margin, so only finiteness is structural here.
  const finiteOnly: readonly NumericControl<ProductionConfig>[] = [
    "minimumInvestmentMargin",
    "mothballMarginThreshold",
    "reactivateMarginThreshold",
  ];
  for (const field of finiteOnly) {
    assertFiniteControl("ProductionConfig", field, production[field]);
  }

  assertOrderedBounds(
    "ProductionConfig",
    "minTargetUtilization",
    production.minTargetUtilization,
    "maxTargetUtilization",
    production.maxTargetUtilization,
  );

  if (
    isFiniteCanonicalNumber(production.mothballMarginThreshold) &&
    isFiniteCanonicalNumber(production.reactivateMarginThreshold) &&
    production.mothballMarginThreshold > production.reactivateMarginThreshold
  ) {
    throw new Error(
      `ProductionConfig.mothballMarginThreshold (${production.mothballMarginThreshold}) must not exceed ` +
        `reactivateMarginThreshold (${production.reactivateMarginThreshold}), or a unit would mothball and ` +
        `reactivate on the same margin`,
    );
  }
}

/**
 * Throws unless every `LaborConfig` control present is finite and inside its declared
 * range (REQ-CONFIG-006).
 *
 * Field list from section 37 of Handoff/05, ranges structural as in
 * `validateProductionConfig`. `laborEpsilon` is absent by decision: labor is a
 * quantity and `NumericConfig.quantityEpsilon` owns that tolerance.
 *
 * Produces useful diagnostics identifying the field, value and reason for every
 * validation failure. Does not silently coerce or substitute defaults.
 */
export function validateLaborConfig(labor: LaborConfig): void {
  const unitInterval: readonly NumericControl<LaborConfig>[] = ["baselineParticipationRate", "wageAdjustmentSpeed"];
  for (const field of unitInterval) {
    assertInClosedUnitInterval("LaborConfig", field, labor[field]);
  }

  const nonNegative: readonly NumericControl<LaborConfig>[] = [
    "laborWageAttractivenessElasticity",
    "unemploymentWagePressure",
    "vacancyWagePressure",
    "unitVacancyResponse",
    "minimumWorkingHealthFactor",
    "maximumWorkingHealthFactor",
  ];
  for (const field of nonNegative) {
    assertNonNegative("LaborConfig", field, labor[field]);
  }

  const positive: readonly NumericControl<LaborConfig>[] = [
    "minWageWeight",
    "maxWageWeight",
    "startingReferenceWage",
    "maxLogWageStep",
    "maxTightnessSignal",
  ];
  for (const field of positive) {
    assertPositive("LaborConfig", field, labor[field]);
  }

  assertOrderedBounds("LaborConfig", "minWageWeight", labor.minWageWeight, "maxWageWeight", labor.maxWageWeight);
  assertOrderedBounds(
    "LaborConfig",
    "minimumWorkingHealthFactor",
    labor.minimumWorkingHealthFactor,
    "maximumWorkingHealthFactor",
    labor.maximumWorkingHealthFactor,
  );

  validateAllowedLaborCategories(labor.allowedLaborCategories);
}

function validateAllowedLaborCategories(categories: readonly string[] | undefined): void {
  if (categories === undefined) {
    return;
  }

  if (!Array.isArray(categories)) {
    throw new Error(
      `LaborConfig.allowedLaborCategories must be an array of category names when present, got ${describeValue(categories)}`,
    );
  }

  if (categories.length === 0) {
    throw new Error("LaborConfig.allowedLaborCategories must declare at least one category, got an empty array");
  }

  if (categories.length > MAX_LABOR_CATEGORIES) {
    throw new Error(
      `LaborConfig.allowedLaborCategories must declare at most ${MAX_LABOR_CATEGORIES} categories in v1, got ${categories.length}`,
    );
  }

  const seen = new Set<string>();
  for (const category of categories) {
    if (typeof category !== "string" || category.length === 0) {
      throw new Error(
        `LaborConfig.allowedLaborCategories must contain non-empty category names, got ${describeValue(category)}`,
      );
    }
    if (seen.has(category)) {
      throw new Error(`LaborConfig.allowedLaborCategories declares "${category}" more than once`);
    }
    seen.add(category);
  }
}

/**
 * Throws unless every `PopulationConfig` control present is finite and inside its
 * declared range (REQ-CONFIG-007).
 *
 * The field list is the M4 subset of section 33 of
 * `06 - Handoff/06 — POPULATION_DEMOGRAPHY_CLANS_CONTRACTS.md`. Ranges are
 * structural, as in `validateProductionConfig`: a share or a coverage is a fraction
 * in [0,1], an EMA alpha is a fraction in [0,1], a multiplicative clamp is
 * non-negative, a normalization scale and a log-step bound are positive because
 * zero divides or freezes.
 *
 * Every field is optional: section 8 of Handoff/03 states its population baseline in
 * a different vocabulary, so sixteen of the twenty controls have no reachable
 * value and `createDefaultSimulationConfig` does not invent one. Presence is what
 * gets checked.
 *
 * Produces useful diagnostics identifying the field, value and reason for every
 * validation failure. Does not silently coerce or substitute defaults.
 */
export function validatePopulationConfig(population: PopulationConfig): void {
  const unitInterval: readonly NumericControl<PopulationConfig>[] = [
    "liquidityFloorShare",
    "minParticipation",
    "maxParticipation",
    "wageSignalAdjustmentSpeed",
    "prosperityAlpha",
    "essentialAlpha",
    "incomeAlpha",
    "employmentAlpha",
    "healthMaintenanceThreshold",
    "serviceBaseline",
  ];
  for (const field of unitInterval) {
    assertInClosedUnitInterval("PopulationConfig", field, population[field]);
  }

  const nonNegative: readonly NumericControl<PopulationConfig>[] = [
    "minHouseholdCashPerCapita",
    "minHealthParticipationFactor",
    "maxHealthParticipationFactor",
    "minWeakOpportunityFactor",
    "maxWeakOpportunityFactor",
    "healthRecoveryRate",
    "serviceHealthRate",
  ];
  for (const field of nonNegative) {
    assertNonNegative("PopulationConfig", field, population[field]);
  }

  // `scenarioRealIncomeScale` divides in saturatingNormalize; `maxWageSignalStep`
  // at zero would pin the wage signal to its seed forever.
  const positive: readonly NumericControl<PopulationConfig>[] = ["scenarioRealIncomeScale", "maxWageSignalStep"];
  for (const field of positive) {
    assertPositive("PopulationConfig", field, population[field]);
  }

  assertOrderedBounds("PopulationConfig", "minParticipation", population.minParticipation, "maxParticipation", population.maxParticipation);
  assertOrderedBounds(
    "PopulationConfig",
    "minHealthParticipationFactor",
    population.minHealthParticipationFactor,
    "maxHealthParticipationFactor",
    population.maxHealthParticipationFactor,
  );
  assertOrderedBounds(
    "PopulationConfig",
    "minWeakOpportunityFactor",
    population.minWeakOpportunityFactor,
    "maxWeakOpportunityFactor",
    population.maxWeakOpportunityFactor,
  );

  validateBaseParticipationByStratum(population.baseParticipationByStratum);
}

function validateBaseParticipationByStratum(byStratum: Readonly<Record<string, number>> | undefined): void {
  if (byStratum === undefined) {
    return;
  }

  if (typeof byStratum !== "object" || byStratum === null || Array.isArray(byStratum)) {
    throw new Error(
      `PopulationConfig.baseParticipationByStratum must be a plain object keyed by stratum when present, got ${describeValue(byStratum)}`,
    );
  }

  for (const [stratum, rate] of Object.entries(byStratum)) {
    assertInClosedUnitInterval("PopulationConfig", `baseParticipationByStratum["${stratum}"]`, rate);
  }
}

/**
 * Throws unless the pack's need categories satisfy section 4 of
 * `06 - Handoff/06 — POPULATION_DEMOGRAPHY_CLANS_CONTRACTS.md` (REQ-CONFIG-007):
 *
 * - the registry declares exactly the four baseline categories, no more and no
 *   fewer — section 4: "must support exactly four baseline categories";
 * - each entry's `id` equals the key it is filed under, so one category cannot be
 *   reached under two names, and no `id` repeats across keys;
 * - `perCapitaTarget`, `priceSensitivity` and `inventoryCarryoverTicks` are
 *   non-negative and finite; a zero `priceSensitivity` (price-insensitive) and a
 *   zero `inventoryCarryoverTicks` (fully perishable) are both meaningful;
 * - `minimumBudgetShare`, when present, is a share in [0,1];
 * - `substitutionGoods` is non-empty, because section 5 normalizes
 *   `share_g = weight_g / Σ weight` and an empty candidate list makes every share
 *   0/0 — a category no purchase can ever satisfy;
 * - every `goodId` names a good the pack declares, and names it once; a repeated
 *   good would double-count its own weight in that same normalization. This is the
 *   REQ-CONFIG-005 negative control (#512, #516) applied to the new reference;
 * - `basePreference` and `qualityFactor` are strictly positive, which is what makes
 *   `Σ weight > 0` structural rather than accidental. A zero-weight candidate is
 *   indistinguishable from one that was never listed.
 *
 * A pack that declares no `needCategories` at all is valid and unchecked: household
 * demand is REQ-POPULATION-001's to run, not this surface's to require.
 */
function validateNeedCategories(
  needCategories: Readonly<Record<string, NeedCategoryDefinition>> | undefined,
  declaredGoodKeys: ReadonlySet<string>,
): void {
  if (needCategories === undefined) {
    return;
  }

  if (typeof needCategories !== "object" || needCategories === null || Array.isArray(needCategories)) {
    throw new Error(
      `DefinitionPack.needCategories must be a plain object keyed by category id when present, got ${describeValue(needCategories)}`,
    );
  }

  const seenIds = new Set<string>();

  for (const [key, category] of Object.entries(needCategories)) {
    const owner = `NeedCategoryDefinition "${key}"`;

    if (typeof category !== "object" || category === null || Array.isArray(category)) {
      throw new Error(`${owner}: must be a plain object, got ${describeValue(category)}`);
    }

    if (category.id !== key) {
      throw new Error(`${owner}: id "${category.id}" does not match the key it is declared under`);
    }

    if (seenIds.has(category.id)) {
      throw new Error(`${owner}: id "${category.id}" is declared more than once`);
    }
    seenIds.add(category.id);

    assertNonNegative(owner, "perCapitaTarget", category.perCapitaTarget);
    assertNonNegative(owner, "priceSensitivity", category.priceSensitivity);
    assertNonNegative(owner, "inventoryCarryoverTicks", category.inventoryCarryoverTicks);
    assertFiniteControl(owner, "priority", category.priority);
    assertInClosedUnitInterval(owner, "minimumBudgetShare", category.minimumBudgetShare);

    if (!Array.isArray(category.substitutionGoods)) {
      throw new Error(`${owner}: substitutionGoods must be an array, got ${describeValue(category.substitutionGoods)}`);
    }

    if (category.substitutionGoods.length === 0) {
      throw new Error(
        `${owner}: substitutionGoods must declare at least one candidate good, got an empty array — ` +
          "section 5 normalizes demand shares over this list, so a category with no candidate can never be satisfied",
      );
    }

    const seenGoods = new Set<string>();
    for (const candidate of category.substitutionGoods) {
      const goodKey = candidate.goodId as unknown as string;

      if (!declaredGoodKeys.has(goodKey)) {
        throw new Error(`${owner}: substitutionGoods goodId "${goodKey}" references a Good the DefinitionPack does not declare`);
      }

      if (seenGoods.has(goodKey)) {
        throw new Error(`${owner}: substitutionGoods declares goodId "${goodKey}" more than once`);
      }
      seenGoods.add(goodKey);

      assertPositive(owner, `substitutionGoods["${goodKey}"].basePreference`, candidate.basePreference);
      assertPositive(owner, `substitutionGoods["${goodKey}"].qualityFactor`, candidate.qualityFactor);
    }
  }

  for (const baselineId of BASELINE_NEED_CATEGORY_IDS) {
    if (!seenIds.has(baselineId)) {
      throw new Error(
        `DefinitionPack.needCategories must declare the baseline category "${baselineId}": ` +
          `section 4 requires exactly ${BASELINE_NEED_CATEGORY_IDS.join(", ")}`,
      );
    }
  }

  const baselineIdSet: ReadonlySet<string> = new Set(BASELINE_NEED_CATEGORY_IDS);
  for (const id of seenIds) {
    if (!baselineIdSet.has(id)) {
      throw new Error(
        `DefinitionPack.needCategories declares "${id}", which is not one of the four baseline categories ` +
          `${BASELINE_NEED_CATEGORY_IDS.join(", ")}`,
      );
    }
  }
}

function assertFiniteControl(owner: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!isFiniteCanonicalNumber(value)) {
    throw new Error(`${owner}.${field} must be a finite number, got ${describeValue(value)}`);
  }
}

function assertInClosedUnitInterval(owner: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!isFiniteCanonicalNumber(value) || value < 0 || value > 1) {
    throw new Error(`${owner}.${field} must be a finite number in [0, 1], got ${describeValue(value)}`);
  }
}

function assertNonNegative(owner: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!isFiniteCanonicalNumber(value) || value < 0) {
    throw new Error(`${owner}.${field} must be a non-negative finite number, got ${describeValue(value)}`);
  }
}

function assertPositive(owner: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!isFiniteCanonicalNumber(value) || value <= 0) {
    throw new Error(`${owner}.${field} must be a positive finite number, got ${describeValue(value)}`);
  }
}

function assertPositiveInteger(owner: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!isFiniteCanonicalNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${owner}.${field} must be a positive integer, got ${describeValue(value)}`);
  }
}

function assertNonNegativeInteger(owner: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!isFiniteCanonicalNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${owner}.${field} must be a non-negative integer, got ${describeValue(value)}`);
  }
}

function assertOrderedBounds(
  owner: string,
  lowerField: string,
  lower: number | undefined,
  upperField: string,
  upper: number | undefined,
): void {
  if (!isFiniteCanonicalNumber(lower) || !isFiniteCanonicalNumber(upper)) {
    return;
  }
  if (lower > upper) {
    throw new Error(`${owner}.${lowerField} (${lower}) must not exceed ${upperField} (${upper})`);
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (typeof value === "number" && !Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (typeof value === "object") return "an object";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
