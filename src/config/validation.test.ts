import { describe, expect, it } from "vitest";

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
      clans: [
        {
          key: "c-1",
          name: "Clan One",
          treasury: {},
          preferences: {},
        },
      ],
    };
    expect(() => assertNoBehavioralOverrides(scenario)).not.toThrow();
  });

  it("accepts a well-formed scenario with concrete StateSeed, MonetaryAuthoritySeed, and ClanSeed", () => {
    const scenario = {
      ...minimalScenario(),
      states: [
        {
          key: "s-1",
          name: "State One",
          treasury: {},
          publicInventory: {},
          policy: {},
          effectiveCurrencyRegime: {
            currencyKey: "curr-1",
            regimeType: "INDEPENDENT_FLOAT" as const,
            policyAuthorityKey: null,
          },
        },
      ],
      monetaryAuthorities: [
        {
          key: "ma-1",
          currencyKey: "curr-1",
          memberStateKeys: ["s-1"],
          wallet: {},
          fxPools: [],
        },
      ],
      clans: [
        {
          key: "c-1",
          name: "Clan One",
          treasury: {},
          preferences: {},
        },
      ],
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
});
