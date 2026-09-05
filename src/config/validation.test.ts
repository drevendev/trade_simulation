import { describe, expect, it } from "vitest";

import type { GoodDefinition } from "./definitionPack";
import type { GoodId } from "../domain/id";
import type {
  CohortSeed,
  CurrencyRegimeSeed,
  CurrencySeed,
  MarketSeed,
  ProductionUnitSeed,
  RegionSeed,
  ScenarioVariationConfig,
  TransportLinkSeed,
} from "./scenarioDefinition";
import { assertNoBehavioralOverrides } from "./validation";

/** A minimal, well-formed `ScenarioDefinition`-shaped object (required keys only). */
function minimalScenario(): Record<string, unknown> {
  return {
    id: "baseline-multistate-v1",
    version: "1.0.0",
    name: "Baseline multistate",
    description: "Canonical baseline scenario",
    definitionPackId: "baseline-pack-v1",
    geography: [],
    transportLinks: [],
    states: [],
    currencies: [],
    monetaryAuthorities: [],
    clans: [],
    cohorts: [],
    productionUnits: [],
  };
}

describe("assertNoBehavioralOverrides", () => {
  it("accepts a minimal well-formed ScenarioDefinition-shaped object", () => {
    expect(() => assertNoBehavioralOverrides(minimalScenario())).not.toThrow();
  });

  it("accepts the legitimate markets and clans seed-array fields", () => {
    const scenario = {
      ...minimalScenario(),
      markets: [{ regionKey: "r-1", initialPriceByGood: {} }],
      clans: [{ key: "c-1" }],
    };
    expect(() => assertNoBehavioralOverrides(scenario)).not.toThrow();
  });

  it("rejects a scenario patched with a SimulationConfig-owned numeric key", () => {
    const scenario = { ...minimalScenario(), numeric: { moneyEpsilon: 1e-9 } };
    expect(() => assertNoBehavioralOverrides(scenario)).toThrow(
      /SimulationConfig-owned behavioral key "numeric"/,
    );
  });

  it("rejects a scenario patched with an object-shaped markets behavioral override", () => {
    const scenario = { ...minimalScenario(), markets: { basePriceAdjustmentSpeed: 0.12 } };
    expect(() => assertNoBehavioralOverrides(scenario)).toThrow(
      /SimulationConfig-owned behavioral key "markets"/,
    );
  });

  it("rejects a scenario patched with an object-shaped clans behavioral override", () => {
    const scenario = { ...minimalScenario(), clans: { loyaltyAdjustmentSpeed: 0.05 } };
    expect(() => assertNoBehavioralOverrides(scenario)).toThrow(
      /SimulationConfig-owned behavioral key "clans"/,
    );
  });

  it("rejects a scenario carrying an arbitrary unknown key", () => {
    const scenario = { ...minimalScenario(), notARealField: true };
    expect(() => assertNoBehavioralOverrides(scenario)).toThrow(
      /unknown key "notARealField"/,
    );
  });

  it("rejects a non-object candidate", () => {
    expect(() => assertNoBehavioralOverrides(null)).toThrow(/must be a plain object/);
    expect(() => assertNoBehavioralOverrides([])).toThrow(/must be a plain object/);
    expect(() => assertNoBehavioralOverrides("scenario")).toThrow(/must be a plain object/);
  });

  // REQ-CONFIG-003: giving the seed/GoodDefinition placeholders concrete field
  // shapes must not disturb this REQ-CONFIG-001 key-membership check, since it
  // only inspects ScenarioDefinition's own top-level keys.
  it("accepts a fixture combining one instance of every newly-shaped seed and GoodDefinition type", () => {
    const region: RegionSeed = {
      key: "region-1",
      name: "Riverbend",
      controllerStateKey: "state-1",
      settlementCurrencyKey: "currency-1",
      settlementLevel: 3,
      infrastructure: { road: 0.6 },
      climateHabitabilityInputs: { rainfall: 0.5 },
      deposits: [{ resourceId: "iron-ore", initialQuantity: 1000, initiallyKnown: true }],
    };

    const transportLink: TransportLinkSeed = {
      key: "link-1",
      fromRegionKey: "region-1",
      toRegionKey: "region-2",
      distance: 120,
      baseCapacity: 50,
      condition: 0.9,
      baseTransportCost: 1.5,
    };

    const currencyRegime: CurrencyRegimeSeed = {
      currencyKey: "currency-1",
      regimeType: "INDEPENDENT_FLOAT",
      policyAuthorityKey: "state-1",
    };

    const currency: CurrencySeed = {
      key: "currency-1",
      code: "RVB",
      issuerAuthorityKey: "state-1",
    };

    const cohort: CohortSeed = {
      key: "cohort-1",
      regionKey: "region-1",
      clanKey: "clan-1",
      ageBand: "WORKING",
      stratum: "WORKING_MIDDLE",
      laborCategory: "GENERAL",
      population: 400,
      wallet: { "currency-1": 500 },
      householdInventory: { food: 20 },
      healthIndex: 0.8,
      prosperityEma: 0.5,
      essentialSatisfactionEma: 0.7,
      realIncomePerCapitaEma: 12,
      employmentRateEma: 0.9,
      migrationPressureEma: 0,
      mobilityAccumulator: 0,
      wageSignal: 2.5,
    };

    const productionUnit: ProductionUnitSeed = {
      key: "unit-1",
      regionKey: "region-1",
      owner: { type: "CLAN", key: "clan-1" },
      recipeId: "recipe-1",
      status: "ACTIVE",
      wallet: { "currency-1": 1000 },
      inputInventory: { "iron-ore": 50 },
      outputInventory: { tools: 5 },
      installedCapital: 10,
      condition: 0.95,
    };

    const market: MarketSeed = {
      regionKey: "region-1",
      initialPriceByGood: { food: 2 },
    };

    const variation: ScenarioVariationConfig = {
      enabled: true,
      populationFactorRange: [0.9, 1.1],
    };

    const goodDefinition: GoodDefinition = {
      id: "good:1" as unknown as GoodId,
      name: "Food",
      unitLabel: "unit",
      spoilageRatePerTick: 0.02,
      consumerNeedCategory: "SUBSISTENCE",
      necessityWeight: 1,
      substitutionGroup: "staple-food",
      referencePrice: 2,
      tradable: true,
    };

    const scenario = {
      ...minimalScenario(),
      geography: [region],
      transportLinks: [transportLink],
      currencies: [currency],
      cohorts: [cohort],
      productionUnits: [productionUnit],
      markets: [market],
      variation,
    };

    expect(() => assertNoBehavioralOverrides(scenario)).not.toThrow();
    // The fixture exercises every new type's concrete fields, including the
    // standalone CurrencyRegimeSeed (not yet embedded via the still-placeholder
    // StateSeed) and GoodDefinition (part of DefinitionPack, not ScenarioDefinition).
    expect(currencyRegime.regimeType).toBe("INDEPENDENT_FLOAT");
    expect(goodDefinition.tradable).toBe(true);
  });
});
