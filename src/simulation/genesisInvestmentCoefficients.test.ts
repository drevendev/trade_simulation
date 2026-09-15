/**
 * REQ-CONFIG-005 (Issue #465): an invalid `investmentGoodsPerCapitalUnit` coefficient must
 * fail configuration validation before any world construction, rather than being filtered
 * out downstream and becoming indistinguishable from a recipe that declares no investment
 * good.
 *
 * The reproduction this file pins is the one the finding reported: take the otherwise-valid
 * baseline pack and scenario, set `recipe:tools-craft`'s coefficient to an invalid value, and
 * call `buildInitialWorld()`. Before the repair that call succeeded — `buildInitialWorld()`
 * emitted good-less `UNCONVERTED` capital and `reconcileGenesisStocks()` agreed with it,
 * because both sides resolve the coefficient through the same silently-dropping filter in
 * `resolveCapitalGoodsPerCapitalUnit()`. Two sides sharing one reinterpretation reconcile
 * cleanly, which is exactly why no existing conservation test caught this.
 */
import { describe, expect, it } from "vitest";

import { buildInitialWorld } from "./worldState";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { DefinitionPack, RecipeDefinition } from "../config/definitionPack";
import type { GoodId } from "../domain/id";

/** The baseline pack with `recipe:tools-craft`'s investment coefficients replaced. */
function baselinePackWithCraftInvestment(investment: Record<string, number>): DefinitionPack {
  const toolsCraft = baselineDefinitionPack.recipes["recipe:tools-craft"];
  expect(toolsCraft).toBeDefined();

  const patched: RecipeDefinition = {
    ...(toolsCraft as RecipeDefinition),
    investmentGoodsPerCapitalUnit: investment as unknown as Record<GoodId, number>,
  };

  return {
    ...baselineDefinitionPack,
    recipes: { ...baselineDefinitionPack.recipes, "recipe:tools-craft": patched },
  };
}

describe("buildInitialWorld investment coefficient validation (REQ-CONFIG-005)", () => {
  it("accepts the unmodified baseline definition pack", () => {
    expect(() =>
      buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["negative", -100],
  ])(
    "throws a configuration error instead of emitting reconciling UNCONVERTED capital for a %s coefficient",
    (_label, coefficient) => {
      const pack = baselinePackWithCraftInvestment({ "good:tools": coefficient });

      expect(() =>
        buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
      ).toThrow(
        /RecipeDefinition "recipe:tools-craft": investmentGoodsPerCapitalUnit\["good:tools"\].*strictly positive/,
      );
    },
  );

  it("throws for a coefficient keyed by a good the baseline pack does not declare", () => {
    const pack = baselinePackWithCraftInvestment({ "good:unobtainium": 100 });

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).toThrow(
      /RecipeDefinition "recipe:tools-craft": investmentGoodsPerCapitalUnit\["good:unobtainium"\] references a Good the DefinitionPack does not declare/,
    );
  });

  it("still accepts an empty investment map — a real 'no investment good' declaration", () => {
    const pack = baselinePackWithCraftInvestment({});

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });
});
