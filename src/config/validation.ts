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
  const stateKeySet = new Set(scenario.states.map((s) => (s as Record<string, unknown>)?.key).filter((k) => typeof k === "string"));
  const currencyKeySet = new Set(scenario.currencies.map((c) => c.key));
  const authorityKeySet = new Set(scenario.monetaryAuthorities.map((a) => (a as Record<string, unknown>)?.key).filter((k) => typeof k === "string"));
  const clanKeySet = new Set(scenario.clans.map((cl) => (cl as Record<string, unknown>)?.key).filter((k) => typeof k === "string"));

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

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (typeof value === "number" && !Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (typeof value === "object") return "an object";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
