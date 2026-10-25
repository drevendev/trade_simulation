import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "./fixtures/baselineDefinitionPack";
import { baselineScenario } from "./fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "./simulationConfig";
import type { FxPoolSeed, ScenarioDefinition } from "./scenarioDefinition";
import { buildInitialWorld } from "../simulation/worldState";
import { validateFxPoolGenesis } from "./fxPoolGenesisValidation";

/** Change a single declared pool, preserving the other pools and currencies. */
function withFirstPool(patch: Partial<FxPoolSeed>): ScenarioDefinition {
  return {
    ...baselineScenario,
    monetaryAuthorities: baselineScenario.monetaryAuthorities.map((authority, index) =>
      index !== 0 ? authority : {
        ...authority,
        fxPools: authority.fxPools.map((pool, poolIndex) =>
          poolIndex !== 0 ? pool : { ...pool, ...patch },
        ),
      },
    ),
  };
}

describe("M5 FX pool genesis preflight (#669, Handoff/04 §§17–18)", () => {
  it("accepts the canonical multi-currency baseline, including explicit reciprocal pools", () => {
    expect(() => validateFxPoolGenesis(baselineScenario)).not.toThrow();
    expect(() => buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 7,
    )).not.toThrow();
  });

  it("rejects unknown base and quote currencies before opening FX stock is counted", () => {
    for (const patch of [
      { baseCurrencyKey: "currency:absent" },
      { quoteCurrencyKey: "currency:absent" },
    ]) {
      const scenario = withFirstPool(patch);
      expect(() => validateFxPoolGenesis(scenario)).toThrow(/unknown Currency/);
      expect(() => buildInitialWorld(
        scenario, baselineDefinitionPack, createDefaultSimulationConfig(), 7,
      )).toThrow(/unknown Currency/);
    }
  });

  it("rejects same-currency exchanges and a pool under the wrong base-currency issuer", () => {
    expect(() => validateFxPoolGenesis(withFirstPool({
      quoteCurrencyKey: "currency:alpha",
    }))).toThrow(/must be distinct/);

    expect(() => validateFxPoolGenesis(withFirstPool({
      baseCurrencyKey: "currency:beta",
      quoteCurrencyKey: "currency:gamma",
    }))).toThrow(/issuing authority/);
  });

  it("does not silently collapse duplicate oriented pairs or duplicate pool keys", () => {
    const [authority, ...others] = baselineScenario.monetaryAuthorities;
    const first = authority!.fxPools[0]!;
    expect(() => validateFxPoolGenesis({
      ...baselineScenario,
      monetaryAuthorities: [{
        ...authority!,
        fxPools: [...authority!.fxPools, { ...first, key: "fxpool:duplicate" }],
      }, ...others],
    })).toThrow(/duplicate oriented FX pair/);

    expect(() => validateFxPoolGenesis({
      ...baselineScenario,
      monetaryAuthorities: [{
        ...authority!,
        fxPools: [...authority!.fxPools, { ...first, quoteCurrencyKey: "currency:gamma" }],
      }, ...others],
    })).toThrow(/declared more than once/);
  });

  it("rejects non-finite, negative and non-positive conversion rates", () => {
    for (const spotRateQuotePerBase of [0, -1, NaN, Infinity]) {
      expect(() => validateFxPoolGenesis(withFirstPool({ spotRateQuotePerBase })))
        .toThrow(/spotRateQuotePerBase/);
    }
  });

  it("rejects invalid spreads, reserve shares, rate bounds and pressure telemetry", () => {
    for (const transactionSpread of [-0.01, 1, Infinity, NaN]) {
      expect(() => validateFxPoolGenesis(withFirstPool({ transactionSpread })))
        .toThrow(/transactionSpread/);
    }
    for (const targetBaseReserveShare of [-0.01, 1.01, NaN]) {
      expect(() => validateFxPoolGenesis(withFirstPool({ targetBaseReserveShare })))
        .toThrow(/targetBaseReserveShare/);
    }
    for (const field of ["minOperationalReserveBase", "minOperationalReserveQuote", "maxRateMovePerTick"] as const) {
      for (const value of [-1, NaN, Infinity]) {
        expect(() => validateFxPoolGenesis(withFirstPool({ [field]: value })))
          .toThrow(new RegExp(field));
      }
    }
    for (const flowPressureEma of [NaN, Infinity, -Infinity]) {
      expect(() => validateFxPoolGenesis(withFirstPool({ flowPressureEma })))
        .toThrow(/flowPressureEma/);
    }
  });

  it("requires an explicit two-currency wallet with finite nonnegative stocks", () => {
    const base = "currency:alpha";
    const quote = "currency:beta";
    for (const cash of [
      { [base]: 100 },
      { [base]: 100, [quote]: 50, "currency:gamma": 1 },
    ]) {
      expect(() => validateFxPoolGenesis(withFirstPool({ cash })))
        .toThrow(/exactly baseCurrencyKey and quoteCurrencyKey/);
    }
    for (const amount of [-1, NaN, Infinity]) {
      expect(() => validateFxPoolGenesis(withFirstPool({
        cash: { [base]: amount, [quote]: 50 },
      }))).toThrow(/cash\[/);
    }
  });

  it("allows a zero spread and temporarily dry pool without inventing money or an exchange rate", () => {
    const scenario = withFirstPool({
      transactionSpread: 0,
      flowPressureEma: -0.5,
      cash: { "currency:alpha": 0, "currency:beta": 0 },
    });
    expect(() => validateFxPoolGenesis(scenario)).not.toThrow();
  });
});
