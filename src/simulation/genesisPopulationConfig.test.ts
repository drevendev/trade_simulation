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
import { BASELINE_NEED_CATEGORY_IDS } from "../config/definitionPack";
import type { DefinitionPack, NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { PopulationConfig, SimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";

function configWithPopulation(population: PopulationConfig): SimulationConfig {
  const config = createDefaultSimulationConfig();
  return { ...config, population: { ...config.population, ...population } };
}

/**
 * A valid, non-empty set of exactly the four baseline categories, every
 * `substitutionGoods` entry naming a Good `baselineDefinitionPack` declares so the
 * REQ-CONFIG-005 cross-reference passes and genesis is reached.
 *
 * The quantities are fixture values, not specification values: no document reachable
 * from REQ-CONFIG-007 states a `perCapitaTarget`, `priceSensitivity` or
 * `inventoryCarryoverTicks` (Q-002). They exist to be carried, not to be believed.
 */
function packWithBaselineNeedCategories(): DefinitionPack {
  const needCategories: Record<string, NeedCategoryDefinition> = {};
  for (const [index, id] of BASELINE_NEED_CATEGORY_IDS.entries()) {
    needCategories[id] = {
      id,
      perCapitaTarget: 1 + index,
      priority: index + 1,
      substitutionGoods: [{ goodId: "good:food" as GoodId, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 0.6,
      inventoryCarryoverTicks: 1,
    };
  }
  return { ...baselineDefinitionPack, needCategories };
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

/**
 * Validating a definition is worth nothing if genesis then throws it away.
 *
 * `DefinitionPack` is not reachable from `WorldState`: the only canonical route from
 * pack data to a simulation reader is `buildDefinitionRegistry()` into
 * `WorldState.definitionRegistry`. While that projection copied four fields,
 * `needCategories` validated successfully at genesis and was then dropped, so
 * REQ-POPULATION-001..003 would have had no canonical source for the categories this
 * requirement declares. These pin the whole path, not the projection function alone —
 * a unit test on `buildDefinitionRegistry()` would stay green if genesis stopped
 * calling it or rebuilt the registry some other way.
 */
describe("world genesis carries need categories into canonical WorldState (REQ-CONFIG-007)", () => {
  it("survives buildInitialWorld() unchanged into world.definitionRegistry", () => {
    const pack = packWithBaselineNeedCategories();

    const world = buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42);

    expect(world.definitionRegistry.needCategories).toEqual(pack.needCategories);
    expect(Object.keys(world.definitionRegistry.needCategories ?? {}).sort()).toEqual(
      [...BASELINE_NEED_CATEGORY_IDS].sort(),
    );
  });

  it("preserves every field of every category, not just the ids", () => {
    const pack = packWithBaselineNeedCategories();

    const world = buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42);

    for (const id of BASELINE_NEED_CATEGORY_IDS) {
      const declared = pack.needCategories?.[id] as NeedCategoryDefinition;
      expect(world.definitionRegistry.needCategories?.[id]).toEqual(declared);
    }
  });

  it("leaves needCategories undefined when the pack declares none", () => {
    const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);

    expect(world.definitionRegistry.needCategories).toBeUndefined();
  });
});
