/**
 * REQ-CONFIG-005 (Issue #508): a `RecipeDefinition.inputsPerBatch` key that names a Good the
 * `DefinitionPack` does not declare must fail configuration validation before any world
 * construction.
 *
 * Handoff/03 section 21 fails configuration validation fast on "unknown Good/Recipe/Event/
 * Metric IDs", and section 19 step 1 runs that validation before genesis constructs anything.
 * `validateDefinitionPack()` enforced the membership rule for the sibling good-keyed map
 * `investmentGoodsPerCapitalUnit` but not for `inputsPerBatch`, so before the repair the call
 * below succeeded: an undeclared input Good passed the only check on that map (a finite,
 * strictly positive coefficient) and reached world construction. Accepting the invalid
 * reference past step 1 is itself the contract violation; no production tick is needed to
 * observe it.
 */
import { describe, expect, it } from "vitest";

import { buildInitialWorld } from "./worldState";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { DefinitionPack, RecipeDefinition } from "../config/definitionPack";
import type { GoodId } from "../domain/id";

/** The baseline pack with `recipe:tools-craft`'s material inputs replaced. */
function baselinePackWithCraftInputs(inputs: Record<string, number>): DefinitionPack {
  const toolsCraft = baselineDefinitionPack.recipes["recipe:tools-craft"];
  expect(toolsCraft).toBeDefined();

  const patched: RecipeDefinition = {
    ...(toolsCraft as RecipeDefinition),
    inputsPerBatch: inputs as unknown as Record<GoodId, number>,
  };

  return {
    ...baselineDefinitionPack,
    recipes: { ...baselineDefinitionPack.recipes, "recipe:tools-craft": patched },
  };
}

describe("buildInitialWorld input good reference validation (REQ-CONFIG-005)", () => {
  it("accepts the unmodified baseline definition pack", () => {
    expect(() =>
      buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it("throws before world construction for an input keyed by an undeclared good", () => {
    const pack = baselinePackWithCraftInputs({
      "good:iron": 10,
      "good:wood": 5,
      "good:unobtainium": 1,
    });

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).toThrow(
      /RecipeDefinition "recipe:tools-craft": inputsPerBatch\["good:unobtainium"\] references a Good the DefinitionPack does not declare/,
    );
  });

  it("still accepts the baseline inputs when every key names a declared good", () => {
    const pack = baselinePackWithCraftInputs({ "good:iron": 10, "good:wood": 5 });

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it("still accepts an empty inputs map — a real 'no material input' declaration", () => {
    const pack = baselinePackWithCraftInputs({});

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });
});
