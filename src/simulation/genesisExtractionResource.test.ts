/**
 * REQ-CONFIG-005 (Issue #514): a `RecipeDefinition.extractionResourceId` naming a resource
 * that no Region in the scenario deposits must fail world-genesis validation before any
 * construction, when the scenario expects that recipe to operate.
 *
 * Handoff/03 section 21 fails configuration validation fast on "recipe extraction referring
 * to a resource absent from all eligible regions when the baseline expects that recipe to
 * operate", and section 19 step 1 runs reference validation before genesis instantiates
 * anything.
 *
 * Unlike the three earlier REQ-CONFIG-005 slices (PRs #502, #510, #512) this one cannot live
 * in `validateDefinitionPack()`: the recipe is a pack fact and the deposits are a scenario
 * fact, and that function never sees the scenario. `validateWorldGenesis()` holds both.
 *
 * Nothing downstream would catch it either — extraction is M4 work, so no canonical reader
 * consumes `extractionResourceId` yet. Before the repair the invalid reference reached the
 * constructed world; accepting it past step 1 is itself the contract violation, and no
 * production tick is needed to observe it.
 */
import { describe, expect, it } from "vitest";

import { buildInitialWorld } from "./worldState";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { DefinitionPack, RecipeDefinition } from "../config/definitionPack";
import type { ScenarioDefinition } from "../config/scenarioDefinition";

/** The baseline pack with `recipe:iron-mine`'s extraction resource replaced. */
function baselinePackWithMineResource(extractionResourceId: string): DefinitionPack {
  const ironMine = baselineDefinitionPack.recipes["recipe:iron-mine"];
  expect(ironMine).toBeDefined();

  const patched: RecipeDefinition = {
    ...(ironMine as RecipeDefinition),
    extractionResourceId,
  };

  return {
    ...baselineDefinitionPack,
    recipes: { ...baselineDefinitionPack.recipes, "recipe:iron-mine": patched },
  };
}

/** The baseline scenario with every `recipe:iron-mine` unit moved off ACTIVE. */
function baselineScenarioWithMinesMothballed(): ScenarioDefinition {
  return {
    ...baselineScenario,
    productionUnits: baselineScenario.productionUnits.map((unit) =>
      unit.recipeId === "recipe:iron-mine" ? { ...unit, status: "MOTHBALLED" as const } : unit,
    ),
  };
}

describe("buildInitialWorld extraction resource presence validation (REQ-CONFIG-005)", () => {
  it("accepts the unmodified baseline definition pack and scenario", () => {
    expect(() =>
      buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it("throws before world construction when the extracted resource is in no Region", () => {
    const pack = baselinePackWithMineResource("resource:not-defined");

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).toThrow(
      /RecipeDefinition "recipe:iron-mine": extractionResourceId "resource:not-defined" is absent from every Region deposit in scenario "baseline-multistate-v1", but the scenario starts at least one ACTIVE ProductionUnit on that recipe/,
    );
  });

  it("accepts a resource deposited in some other Region than the mines' own", () => {
    // resource:copper-ore is deposited in a5-copper-mine, b6-mineral and d3-mountain. Two of
    // the five iron-mine Regions (a1-capital, b1-capital, c6-mine) still hold no copper at
    // all. Acceptance criterion 3: "eligible regions" is undefined in the governing document,
    // so the rule must not be tightened into a per-Region requirement.
    const pack = baselinePackWithMineResource("resource:copper-ore");

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it("guards the same direction the shipped baseline relies on", () => {
    // The shipped baseline already exercises the non-per-Region reading: recipe:iron-mine is
    // ACTIVE in region:b6-mineral and region:d3-mountain, neither of which deposits
    // resource:iron-ore. A per-Region rule would reject the unmodified baseline.
    const ironMineRegions = new Set(
      baselineScenario.productionUnits
        .filter((unit) => unit.recipeId === "recipe:iron-mine")
        .map((unit) => unit.regionKey),
    );
    const ironOreRegions = new Set(
      baselineScenario.geography
        .filter((region) => region.deposits.some((d) => d.resourceId === "resource:iron-ore"))
        .map((region) => region.key),
    );

    const minesWithoutLocalOre = Array.from(ironMineRegions).filter((key) => !ironOreRegions.has(key));
    expect(minesWithoutLocalOre.sort()).toEqual(["region:b6-mineral", "region:d3-mountain"]);
  });

  it("does not reject a missing resource when no unit on the recipe starts ACTIVE", () => {
    // "when the baseline expects that recipe to operate" — a scenario whose iron mines are all
    // MOTHBALLED at tick 0 expects nothing to extract, so the absent resource is not a genesis
    // error. This is the boundary that keeps the check from firing on an unused definition.
    const pack = baselinePackWithMineResource("resource:not-defined");

    expect(() =>
      buildInitialWorld(
        baselineScenarioWithMinesMothballed(),
        pack,
        createDefaultSimulationConfig(),
        42,
      ),
    ).not.toThrow();
  });
});
