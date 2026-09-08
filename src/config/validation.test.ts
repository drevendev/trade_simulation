import { describe, expect, it } from "vitest";

import type { GoodDefinition } from "./definitionPack";
import type { GoodId } from "../domain/id";
import type {
  ClanSeed,
  CohortSeed,
  CurrencyRegimeSeed,
  CurrencySeed,
  MarketSeed,
  MonetaryAuthoritySeed,
  ProductionUnitSeed,
  RegionSeed,
  ScenarioDefinition,
  ScenarioVariationConfig,
  StateSeed,
  TransportLinkSeed,
} from "./scenarioDefinition";
import { assertNoBehavioralOverrides, validateScenarioContent, validateDefinitionPack } from "./validation";
import type { DefinitionPack, RecipeDefinition } from "./definitionPack";

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

    const state: StateSeed = {
      key: "state-1",
      name: "Rivercountry",
      treasury: { "currency-1": 10000 },
      publicInventory: { food: 500 },
      policy: {},
      effectiveCurrencyRegime: currencyRegime,
    };

    const currency: CurrencySeed = {
      key: "currency-1",
      code: "RVB",
      issuerAuthorityKey: "state-1",
    };

    const monetaryAuthority: MonetaryAuthoritySeed = {
      key: "cb-1",
      currencyKey: "currency-1",
      memberStateKeys: ["state-1"],
      wallet: { "currency-1": 50000 },
      policyRateAnnual: 0.03,
      fxPools: [],
    };

    const clan: ClanSeed = {
      key: "clan-1",
      name: "Merchant House",
      treasury: { "currency-1": 5000 },
      preferences: {},
      initialRelations: {},
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
      states: [state],
      currencies: [currency],
      monetaryAuthorities: [monetaryAuthority],
      clans: [clan],
      cohorts: [cohort],
      productionUnits: [productionUnit],
      markets: [market],
      variation,
    };

    expect(() => assertNoBehavioralOverrides(scenario)).not.toThrow();
    // The fixture exercises every new type's concrete fields, including the
    // standalone CurrencyRegimeSeed and the new StateSeed, MonetaryAuthoritySeed,
    // and ClanSeed types. GoodDefinition (part of DefinitionPack, not
    // ScenarioDefinition) is also exercised.
    expect(currencyRegime.regimeType).toBe("INDEPENDENT_FLOAT");
    expect(state.key).toBe("state-1");
    expect(monetaryAuthority.memberStateKeys).toContain("state-1");
    expect(clan.name).toBe("Merchant House");
    expect(goodDefinition.tradable).toBe(true);
  });
});

describe("validateScenarioContent", () => {
  function createScenario(overrides: Record<string, unknown>): ScenarioDefinition {
    return {
      id: "test-scenario",
      version: "1.0.0",
      name: "Test",
      description: "Test",
      definitionPackId: "test-pack",
      geography: [],
      transportLinks: [],
      states: [],
      currencies: [],
      monetaryAuthorities: [],
      clans: [],
      cohorts: [],
      productionUnits: [],
      ...overrides,
    } as unknown as ScenarioDefinition;
  }

  it("accepts a minimal well-formed scenario", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
    });
    expect(() => validateScenarioContent(scenario)).not.toThrow();
  });

  it("rejects a region with invalid controllerStateKey", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: "nonexistent",
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/controllerStateKey.*non-existent State/);
  });

  it("rejects a region with invalid settlementCurrencyKey", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "nonexistent",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/settlementCurrencyKey.*non-existent Currency/);
  });

  it("rejects a region with non-finite settlementLevel", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: Number.NaN,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/settlementLevel.*NaN/);
  });

  it("rejects a transport link with invalid region references", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      transportLinks: [
        {
          key: "link-1",
          fromRegionKey: "r-1",
          toRegionKey: "nonexistent",
          distance: 100,
          baseCapacity: 50,
          condition: 0.9,
          baseTransportCost: 1,
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/toRegionKey.*non-existent Region/);
  });

  it("rejects a transport link with condition out of [0,1]", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
        {
          key: "r-2",
          name: "Region 2",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      transportLinks: [
        {
          key: "link-1",
          fromRegionKey: "r-1",
          toRegionKey: "r-2",
          distance: 100,
          baseCapacity: 50,
          condition: 1.5,
          baseTransportCost: 1,
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/condition.*\[0,1\]/);
  });

  it("rejects a cohort with invalid regionKey", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
      clans: [{ key: "clan-1" } as unknown as CohortSeed],
      cohorts: [
        {
          key: "cohort-1",
          regionKey: "nonexistent",
          clanKey: "clan-1",
          ageBand: "WORKING",
          stratum: "WORKING_MIDDLE",
          laborCategory: "GENERAL",
          population: 100,
          wallet: { "c-1": 1000 },
          householdInventory: {},
          healthIndex: 0.8,
          prosperityEma: 0.5,
          essentialSatisfactionEma: 0.7,
          realIncomePerCapitaEma: 10,
          employmentRateEma: 0.9,
          migrationPressureEma: 0,
          mobilityAccumulator: 0,
          wageSignal: 2,
        } as unknown as CohortSeed,
      ],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/regionKey.*non-existent Region/);
  });

  it("rejects a cohort with negative population", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
      clans: [{ key: "clan-1" } as unknown as CohortSeed],
      cohorts: [
        {
          key: "cohort-1",
          regionKey: "r-1",
          clanKey: "clan-1",
          ageBand: "WORKING",
          stratum: "WORKING_MIDDLE",
          laborCategory: "GENERAL",
          population: -100,
          wallet: { "c-1": 1000 },
          householdInventory: {},
          healthIndex: 0.8,
          prosperityEma: 0.5,
          essentialSatisfactionEma: 0.7,
          realIncomePerCapitaEma: 10,
          employmentRateEma: 0.9,
          migrationPressureEma: 0,
          mobilityAccumulator: 0,
          wageSignal: 2,
        } as unknown as CohortSeed,
      ],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/population.*positive/);
  });

  it("rejects a cohort with out-of-range healthIndex", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
      clans: [{ key: "clan-1" } as unknown as CohortSeed],
      cohorts: [
        {
          key: "cohort-1",
          regionKey: "r-1",
          clanKey: "clan-1",
          ageBand: "WORKING",
          stratum: "WORKING_MIDDLE",
          laborCategory: "GENERAL",
          population: 100,
          wallet: { "c-1": 1000 },
          householdInventory: {},
          healthIndex: 1.5,
          prosperityEma: 0.5,
          essentialSatisfactionEma: 0.7,
          realIncomePerCapitaEma: 10,
          employmentRateEma: 0.9,
          migrationPressureEma: 0,
          mobilityAccumulator: 0,
          wageSignal: 2,
        } as unknown as CohortSeed,
      ],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/healthIndex.*\[0,1\]/);
  });

  it("rejects a production unit with invalid owner reference", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
      clans: [{ key: "clan-1" } as unknown as CohortSeed],
      productionUnits: [
        {
          key: "unit-1",
          regionKey: "r-1",
          owner: { type: "CLAN", key: "nonexistent-clan" },
          recipeId: "recipe-1",
          status: "ACTIVE",
          wallet: {},
          inputInventory: {},
          outputInventory: {},
          installedCapital: 10,
          condition: 0.9,
        } as unknown as ProductionUnitSeed,
      ],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/owner Clan key.*non-existent Clan/);
  });

  it("rejects a market with zero or negative price", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
      markets: [
        {
          regionKey: "r-1",
          initialPriceByGood: { food: 0 },
        } as unknown as MarketSeed,
      ],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/initialPriceByGood\["food"\].*positive/);
  });

  it("rejects non-finite values in numeric fields", () => {
    const scenario = createScenario({
      geography: [
        {
          key: "r-1",
          name: "Region 1",
          controllerStateKey: null,
          settlementCurrencyKey: "c-1",
          settlementLevel: 1,
          infrastructure: {},
          climateHabitabilityInputs: {},
          deposits: [],
        },
      ],
      currencies: [{ key: "c-1", code: "CUR", issuerAuthorityKey: null }],
      clans: [{ key: "clan-1" } as unknown as CohortSeed],
      cohorts: [
        {
          key: "cohort-1",
          regionKey: "r-1",
          clanKey: "clan-1",
          ageBand: "WORKING",
          stratum: "WORKING_MIDDLE",
          laborCategory: "GENERAL",
          population: 100,
          wallet: { "c-1": Number.POSITIVE_INFINITY },
          householdInventory: {},
          healthIndex: 0.8,
          prosperityEma: 0.5,
          essentialSatisfactionEma: 0.7,
          realIncomePerCapitaEma: 10,
          employmentRateEma: 0.9,
          migrationPressureEma: 0,
          mobilityAccumulator: 0,
          wageSignal: 2,
        } as unknown as CohortSeed,
      ],
    });
    expect(() => validateScenarioContent(scenario)).toThrow(/wallet\["c-1"\].*Infinity/);
  });
});

describe("validateDefinitionPack", () => {
  function minimalRecipe(overrides?: Partial<RecipeDefinition>): RecipeDefinition {
    return {
      id: "test-recipe",
      outputGoodId: "good-1" as any,
      outputPerBatch: 10,
      inputsPerBatch: { "good-2": 2 } as any,
      laborCategory: "GENERAL",
      laborPerBatch: 5,
      batchesPerCapitalUnit: 2,
      investmentGoodsPerCapitalUnit: {},
      minimumStartupCapital: 100,
      baseThroughputFactor: 1,
      depreciationRatePerTick: 0.1,
      ...overrides,
    };
  }

  function minimalPack(recipes?: Record<string, RecipeDefinition>): DefinitionPack {
    return {
      id: "test-pack",
      version: "1.0.0",
      goods: {},
      recipes: recipes ?? { "recipe-1": minimalRecipe() },
      eventDefinitions: {},
      metricDefinitions: {},
    };
  }

  it("accepts a well-formed DefinitionPack with valid recipes", () => {
    const pack = minimalPack();
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("rejects outputPerBatch <= 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ outputPerBatch: 0 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/outputPerBatch.*positive/);
  });

  it("rejects outputPerBatch that is non-finite", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ outputPerBatch: Number.NaN }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/outputPerBatch/);
  });

  it("rejects inputsPerBatch coefficient <= 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({
        inputsPerBatch: { "good-2": 0 } as any,
      }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/inputsPerBatch\["good-2"\].*strictly positive/);
  });

  it("rejects inputsPerBatch coefficient that is non-finite", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({
        inputsPerBatch: { "good-2": Number.POSITIVE_INFINITY } as any,
      }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/inputsPerBatch\["good-2"\]/);
  });

  it("accepts empty inputsPerBatch map", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ inputsPerBatch: {} }),
    });
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("rejects laborPerBatch < 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ laborPerBatch: -1 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/laborPerBatch.*non-negative/);
  });

  it("accepts laborPerBatch = 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ laborPerBatch: 0 }),
    });
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("rejects batchesPerCapitalUnit <= 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ batchesPerCapitalUnit: 0 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/batchesPerCapitalUnit.*positive/);
  });

  it("rejects minimumStartupCapital < 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ minimumStartupCapital: -1 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/minimumStartupCapital.*non-negative/);
  });

  it("accepts minimumStartupCapital = 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ minimumStartupCapital: 0 }),
    });
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("rejects minimumInfrastructureFactor < 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ minimumInfrastructureFactor: -0.1 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/minimumInfrastructureFactor.*\[0,1\]/);
  });

  it("rejects minimumInfrastructureFactor > 1", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ minimumInfrastructureFactor: 1.1 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/minimumInfrastructureFactor.*\[0,1\]/);
  });

  it("accepts minimumInfrastructureFactor in [0,1]", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ minimumInfrastructureFactor: 0.5 }),
    });
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("rejects extractedResourcePerBatch <= 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({
        extractionResourceId: "iron-ore",
        extractedResourcePerBatch: 0,
      }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/extractedResourcePerBatch.*positive/);
  });

  it("accepts omitted extractedResourcePerBatch", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe() as any,
    });
    // Explicitly delete the extractedResourcePerBatch to test the optional path
    const recipe = pack.recipes["recipe-1"];
    if (recipe) {
      delete (recipe as any).extractedResourcePerBatch;
    }
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("rejects extractionResourceId without extractedResourcePerBatch", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({
        extractionResourceId: "iron-ore",
      } as any),
    });
    const recipe = pack.recipes["recipe-1"];
    if (recipe) {
      delete (recipe as any).extractedResourcePerBatch;
    }
    expect(() => validateDefinitionPack(pack)).toThrow(
      /extractionResourceId.*extractedResourcePerBatch.*both must be present together/,
    );
  });

  it("rejects extractedResourcePerBatch without extractionResourceId", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({
        extractedResourcePerBatch: 5,
      } as any),
    });
    const recipe = pack.recipes["recipe-1"];
    if (recipe) {
      delete (recipe as any).extractionResourceId;
    }
    expect(() => validateDefinitionPack(pack)).toThrow(
      /extractedResourcePerBatch.*extractionResourceId.*both must be present together/,
    );
  });

  it("accepts a valid extraction recipe with both extractionResourceId and extractedResourcePerBatch", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({
        extractionResourceId: "iron-ore",
        extractedResourcePerBatch: 5,
      }),
    });
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("rejects baseThroughputFactor <= 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ baseThroughputFactor: 0 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/baseThroughputFactor.*positive/);
  });

  it("rejects depreciationRatePerTick >= 1", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ depreciationRatePerTick: 1 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/depreciationRatePerTick.*\[0,1\)/);
  });

  it("rejects depreciationRatePerTick < 0", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ depreciationRatePerTick: -0.1 }),
    });
    expect(() => validateDefinitionPack(pack)).toThrow(/depreciationRatePerTick.*\[0,1\)/);
  });

  it("accepts depreciationRatePerTick in [0,1)", () => {
    const pack = minimalPack({
      "recipe-1": minimalRecipe({ depreciationRatePerTick: 0.99 }),
    });
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });

  it("accepts empty recipes map", () => {
    const pack = minimalPack({});
    expect(() => validateDefinitionPack(pack)).not.toThrow();
  });
});
