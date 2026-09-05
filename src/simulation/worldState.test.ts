import { describe, expect, it } from "vitest";

import { buildInitialWorld, type WorldState } from "./worldState";
import { createIdAllocator } from "../domain/id";
import type { DefinitionPack } from "../config/definitionPack";
import type { ScenarioDefinition } from "../config/scenarioDefinition";
import type { SimulationConfig } from "../config/simulationConfig";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";

function minimalScenario(): ScenarioDefinition {
  return {
    id: "test-minimal",
    version: "1.0.0",
    name: "Minimal Test",
    description: "Minimal scenario for testing",
    definitionPackId: "baseline-pack-v1",
    geography: [
      {
        key: "region-1",
        name: "Region 1",
        controllerStateKey: "state-1",
        settlementCurrencyKey: "currency-1",
        settlementLevel: 1,
        infrastructure: {},
        climateHabitabilityInputs: {},
        deposits: [],
      },
    ],
    transportLinks: [],
    states: [
      {
        key: "state-1",
        name: "State 1",
        treasury: { currency1: 1000 },
        publicInventory: {},
        policy: {},
        effectiveCurrencyRegime: {
          currencyKey: "currency-1",
          regimeType: "INDEPENDENT_FLOAT",
          policyAuthorityKey: "authority-1",
        },
      },
    ],
    currencies: [
      {
        key: "currency-1",
        code: "C1",
        issuerAuthorityKey: "authority-1",
      },
    ],
    monetaryAuthorities: [
      {
        key: "authority-1",
        currencyKey: "currency-1",
        memberStateKeys: ["state-1"],
        wallet: { good1: 10000 },
      },
    ],
    clans: [],
    cohorts: [],
    productionUnits: [],
  };
}

function minimalConfig(): SimulationConfig {
  return {
    configVersion: "1.0.0",
    numeric: {
      moneyEpsilon: 1e-9,
      quantityEpsilon: 1e-9,
      populationEpsilon: 1e-6,
      rateEpsilon: 1e-12,
      reconciliationRelativeTolerance: 1e-9,
      maxFiniteMagnitude: 1e15,
    },
    cadence: {
      productionLifecycleReviewEveryTicks: 3,
      investmentReviewEveryTicks: 3,
      clanDistributionEveryTicks: 3,
      fiscalPolicyReviewEveryTicks: 3,
      monetaryPolicyReviewEveryTicks: 1,
      expansionReviewEveryTicks: 3,
      stateFormationReviewEveryTicks: 6,
    },
    markets: {
      shortageSignalWeight: 0.5,
      inventorySignalWeight: 0.5,
      basePriceAdjustmentSpeed: 0.1,
      maxAbsoluteLogPriceMovePerTick: 0.1,
      minimumPrice: 0.01,
      maximumPrice: 1000,
      targetInventoryCoverageTicks: 1.0,
      expectationAlpha: 0.1,
    },
    trade: {},
    production: {},
    labor: {},
    population: {},
    clans: {},
    fiscal: {},
    monetary: {},
    expansion: {},
    events: {},
    performance: {},
  };
}

describe("buildInitialWorld", () => {
  it("accepts RunOptions, ScenarioDefinition, DefinitionPack, config and seed", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    expect(worldState).toBeDefined();
    expect(worldState.scenarioId).toBe("test-minimal");
    expect(worldState.seed).toBe(42);
    expect(worldState.configVersion).toBe("1.0.0");
  });

  it("returns a frozen WorldState object", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    expect(() => {
      (worldState as any).scenarioId = "changed";
    }).toThrow();
  });

  it("constructs all required registries", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    expect(worldState.regions).toBeDefined();
    expect(worldState.regions.size).toBe(1);
    expect(worldState.states).toBeDefined();
    expect(worldState.states.size).toBe(1);
    expect(worldState.currencies).toBeDefined();
    expect(worldState.currencies.size).toBe(1);
    expect(worldState.monetaryAuthorities).toBeDefined();
    expect(worldState.monetaryAuthorities.size).toBe(1);
  });

  it("produces deterministic output for the same scenario/config/seed", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const world1 = buildInitialWorld(scenario, pack, config, 42);
    const world2 = buildInitialWorld(scenario, pack, config, 42);

    expect(world1.scenarioId).toBe(world2.scenarioId);
    expect(world1.seed).toBe(world2.seed);
    expect(world1.configVersion).toBe(world2.configVersion);
    expect(world1.regions.size).toBe(world2.regions.size);
    expect(world1.states.size).toBe(world2.states.size);
    expect(world1.currencies.size).toBe(world2.currencies.size);
  });

  it("produces different output for different seeds", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const world1 = buildInitialWorld(scenario, pack, config, 42);
    const world2 = buildInitialWorld(scenario, pack, config, 43);

    expect(world1.seed).toBe(42);
    expect(world2.seed).toBe(43);
  });

  it("rejects scenario missing required fields", () => {
    const scenario = minimalScenario();
    (scenario as any).id = undefined;
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    expect(() => buildInitialWorld(scenario, pack, config, 42)).toThrow("Scenario must have id");
  });

  it("rejects duplicate region keys", () => {
    const scenario = minimalScenario();
    scenario.geography = [
      scenario.geography[0],
      { ...scenario.geography[0], key: "region-1", name: "Duplicate" },
    ];
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    expect(() => buildInitialWorld(scenario, pack, config, 42)).toThrow("Duplicate key");
  });

  it("rejects region referencing non-existent currency", () => {
    const scenario = minimalScenario();
    (scenario.geography[0] as any).settlementCurrencyKey = "nonexistent-currency";
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    expect(() => buildInitialWorld(scenario, pack, config, 42)).toThrow("missing currency");
  });

  it("rejects state referencing non-existent currency", () => {
    const scenario = minimalScenario();
    (scenario.states[0] as any).effectiveCurrencyRegime.currencyKey = "nonexistent-currency";
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    expect(() => buildInitialWorld(scenario, pack, config, 42)).toThrow("missing currency");
  });

  it("resolves region controller state correctly", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    const region = Array.from(worldState.regions.values())[0];
    expect(region.controllerStateId).toBeDefined();
  });

  it("handles scenario with no transport links", () => {
    const scenario = minimalScenario();
    scenario.transportLinks = [];
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    expect(worldState.transportLinks.size).toBe(0);
  });

  it("resolves definition registry", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    expect(worldState.definitionRegistry).toBeDefined();
    expect(worldState.definitionRegistry.goods).toBeDefined();
    expect(worldState.definitionRegistry.recipes).toBeDefined();
  });

  it("freezes simulation config immutably", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    expect(() => {
      (worldState.simulationConfig as any).configVersion = "changed";
    }).toThrow();
  });

  it("instantiates all currencies with correct references", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    scenario.currencies.forEach((currencySeed) => {
      const found = Array.from(worldState.currencies.values()).find(
        (c) => c.seed.key === currencySeed.key,
      );
      expect(found).toBeDefined();
    });
  });

  it("instantiates all states with correct currency references", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const worldState = buildInitialWorld(scenario, pack, config, 42);

    scenario.states.forEach((stateSeed) => {
      const found = Array.from(worldState.states.values()).find((s) => s.seed.key === stateSeed.key);
      expect(found).toBeDefined();
      expect(found!.effectiveCurrencyId).toBeDefined();
      expect(worldState.currencies.has(found!.effectiveCurrencyId)).toBe(true);
    });
  });

  it("allocates stable IDs independent of input order", () => {
    const scenario = minimalScenario();
    const config = minimalConfig();
    const pack = baselineDefinitionPack;

    const world1 = buildInitialWorld(scenario, pack, config, 42);

    const scenario2 = {
      ...scenario,
      currencies: [...scenario.currencies].reverse(),
    };
    const world2 = buildInitialWorld(scenario2, pack, config, 42);

    const ids1 = Array.from(world1.currencies.keys()).sort();
    const ids2 = Array.from(world2.currencies.keys()).sort();

    expect(ids1.length).toBe(ids2.length);
  });
});
