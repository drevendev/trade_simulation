/**
 * REQ-CONFIG-005 (Issue #509): a `RecipeDefinition.outputGoodId` that names a Good the
 * `DefinitionPack` does not declare must fail configuration validation before any world
 * construction.
 *
 * Handoff/03 section 21 fails configuration validation fast on "unknown Good/Recipe/Event/
 * Metric IDs", section 24 invariant 3 requires every ID to be reference-valid, and section
 * 19 step 1 runs that validation before genesis constructs anything.
 *
 * The two good-keyed recipe maps were already covered — `investmentGoodsPerCapitalUnit` by
 * PR #502 and `inputsPerBatch` by #508 — but the recipe's one scalar Good reference was
 * checked nowhere. It is checked nowhere downstream either: no canonical reader consumes
 * `outputGoodId` yet, because production is M4, so unlike an undeclared investment good
 * there was no later resolver that would even drop it. Before the repair the call below
 * therefore succeeded and the invalid reference reached the constructed world. Accepting it
 * past step 1 is itself the contract violation; no production tick is needed to observe it.
 */
import { describe, expect, it } from "vitest";

import { buildInitialWorld } from "./worldState";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { DefinitionPack, RecipeDefinition } from "../config/definitionPack";
import type { GoodId } from "../domain/id";

/** The baseline pack with `recipe:tools-craft`'s output good replaced. */
function baselinePackWithCraftOutput(outputGoodId: string): DefinitionPack {
  const toolsCraft = baselineDefinitionPack.recipes["recipe:tools-craft"];
  expect(toolsCraft).toBeDefined();

  const patched: RecipeDefinition = {
    ...(toolsCraft as RecipeDefinition),
    outputGoodId: outputGoodId as unknown as GoodId,
  };

  return {
    ...baselineDefinitionPack,
    recipes: { ...baselineDefinitionPack.recipes, "recipe:tools-craft": patched },
  };
}

describe("buildInitialWorld output good reference validation (REQ-CONFIG-005)", () => {
  it("accepts the unmodified baseline definition pack", () => {
    expect(() =>
      buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });

  it("throws before world construction for an output naming an undeclared good", () => {
    const pack = baselinePackWithCraftOutput("good:unobtainium");

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).toThrow(
      /RecipeDefinition "recipe:tools-craft": outputGoodId "good:unobtainium" references a Good the DefinitionPack does not declare/,
    );
  });

  it("still accepts the recipe when its output names a different declared good", () => {
    const pack = baselinePackWithCraftOutput("good:iron");

    expect(() =>
      buildInitialWorld(baselineScenario, pack, createDefaultSimulationConfig(), 42),
    ).not.toThrow();
  });
});
