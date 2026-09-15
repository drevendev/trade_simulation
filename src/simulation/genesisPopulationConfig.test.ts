/**
 * REQ-CONFIG-007 (Issue #531): the M4 population configuration surface is enforced at
 * world genesis, not at the first tick that reads it.
 *
 * Handoff/03 section 19 step 1 validates "finite values and config bounds" before genesis
 * instantiates anything, and section 21 fails configuration validation fast on
 * out-of-range configuration. `validateWorldGenesis()` already ran
 * `validateProductionConfig()` and `validateLaborConfig()` there for REQ-CONFIG-006; this
 * is the same wiring for `validatePopulationConfig()`.
 *
 * Nothing downstream would catch it: household demand, participation and welfare are M4
 * behavior that REQ-POPULATION-001..003 own and no canonical reader consumes these
 * controls yet. An out-of-range control would reach the constructed world untouched, and
 * accepting it past step 1 is itself the contract violation — no tick is needed to
 * observe it.
 */
import { describe, expect, it } from "vitest";

import { buildInitialWorld } from "./worldState";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { PopulationConfig, SimulationConfig } from "../config/simulationConfig";

function configWithPopulation(population: PopulationConfig): SimulationConfig {
  const config = createDefaultSimulationConfig();
  return { ...config, population: { ...config.population, ...population } };
}

describe("world genesis validates the population config surface (REQ-CONFIG-007)", () => {
  it("accepts the canonical defaults", () => {
    expect(() =>
      buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it("rejects a non-finite control before constructing anything", () => {
    expect(() =>
      buildInitialWorld(
        baselineScenario,
        baselineDefinitionPack,
        configWithPopulation({ healthRecoveryRate: Number.NaN }),
        42,
      ),
    ).toThrow(/PopulationConfig.healthRecoveryRate must be a non-negative finite number, got NaN/);
  });

  it("rejects a control outside its declared range before constructing anything", () => {
    expect(() =>
      buildInitialWorld(baselineScenario, baselineDefinitionPack, configWithPopulation({ incomeAlpha: 1.4 }), 42),
    ).toThrow(/PopulationConfig.incomeAlpha must be a finite number in \[0, 1\], got 1.4/);
  });

  it("rejects an inverted participation clamp before constructing anything", () => {
    expect(() =>
      buildInitialWorld(
        baselineScenario,
        baselineDefinitionPack,
        configWithPopulation({ minParticipation: 0.8, maxParticipation: 0.3 }),
        42,
      ),
    ).toThrow(/PopulationConfig.minParticipation \(0.8\) must not exceed maxParticipation \(0.3\)/);
  });

  it("rejects an out-of-range per-stratum participation rate before constructing anything", () => {
    expect(() =>
      buildInitialWorld(
        baselineScenario,
        baselineDefinitionPack,
        configWithPopulation({ baseParticipationByStratum: { AFFLUENT: -0.2 } }),
        42,
      ),
    ).toThrow(/baseParticipationByStratum\["AFFLUENT"\] must be a finite number in \[0, 1\], got -0.2/);
  });

  /**
   * The baseline pack declares no `needCategories`, which is valid — household demand is
   * REQ-POPULATION-001's to run. This pins that the optional key is genuinely optional, so
   * the surface landing here does not silently require every pack to author four
   * categories whose quantities the specification does not state (Q-002).
   */
  it("accepts a definition pack that declares no need categories", () => {
    expect(baselineDefinitionPack.needCategories).toBeUndefined();
    expect(() =>
      buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it("rejects a need category naming a good the pack does not declare", () => {
    const pack = {
      ...baselineDefinitionPack,
      needCategories: {
        ESSENTIAL_FOOD: {
          id: "ESSENTIAL_FOOD",
          perCapitaTarget: 1,
          priority: 1,
          substitutionGoods: [{ goodId: "good:unobtainium" as never, basePreference: 1, qualityFactor: 1 }],
          priceSensitivity: 0.6,
          inventoryCarryoverTicks: 1,
        },
      },
    };
    expect(() => buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42)).toThrow(
      /substitutionGoods goodId "good:unobtainium" references a Good the DefinitionPack does not declare/,
    );
  });
});
