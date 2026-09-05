import { describe, expect, it } from "vitest";

import type { DefinitionPack, RecipeDefinition } from "../config/definitionPack";
import type { GoodId } from "./id";
import { buildDefinitionRegistry } from "./definitionRegistry";

describe("buildDefinitionRegistry", () => {
  it("carries every DefinitionPack definitions field through unchanged", () => {
    const recipe: RecipeDefinition = {
      id: "recipe-food-harvest",
      outputGoodId: "good:food" as GoodId,
      outputPerBatch: 100,
      inputsPerBatch: {},
      laborCategory: "GENERAL",
      laborPerBatch: 10,
      batchesPerCapitalUnit: 1,
      investmentGoodsPerCapitalUnit: {},
      minimumStartupCapital: 50,
      baseThroughputFactor: 1,
      depreciationRatePerTick: 0.01,
    };

    const definitionPack: DefinitionPack = {
      id: "fixture-pack",
      version: "1",
      goods: { "good:1": {} } as DefinitionPack["goods"],
      recipes: { "recipe-a": recipe },
      eventDefinitions: { "event-a": {} },
      metricDefinitions: { "metric-a": {} },
    };

    const registry = buildDefinitionRegistry(definitionPack);

    expect(registry.goods).toBe(definitionPack.goods);
    expect(registry.recipes).toBe(definitionPack.recipes);
    expect(registry.recipes["recipe-a"]).toBe(recipe);
    expect(registry.eventDefinitions).toBe(definitionPack.eventDefinitions);
    expect(registry.metricDefinitions).toBe(definitionPack.metricDefinitions);
  });

  it("leaves an empty definition pack as an empty registry, not an error", () => {
    const definitionPack: DefinitionPack = {
      id: "empty-pack",
      version: "1",
      goods: {},
      recipes: {},
      eventDefinitions: {},
      metricDefinitions: {},
    };

    const registry = buildDefinitionRegistry(definitionPack);

    expect(Object.keys(registry.goods)).toHaveLength(0);
    expect(Object.keys(registry.recipes)).toHaveLength(0);
  });

  it("preserves recipes with multiple inputs and investment goods", () => {
    const inputsData: Record<string, number> = {
      "good:iron": 10,
      "good:wood": 5,
    };
    const investmentData: Record<string, number> = {
      "good:tools": 100,
    };
    const recipe: RecipeDefinition = {
      id: "recipe-tools-craft",
      outputGoodId: "good:tools" as GoodId,
      outputPerBatch: 50,
      inputsPerBatch: inputsData as Record<GoodId, number>,
      laborCategory: "GENERAL",
      laborPerBatch: 20,
      batchesPerCapitalUnit: 2,
      investmentGoodsPerCapitalUnit: investmentData as Record<GoodId, number>,
      minimumStartupCapital: 200,
      baseThroughputFactor: 0.9,
      depreciationRatePerTick: 0.02,
    };

    const definitionPack: DefinitionPack = {
      id: "tools-pack",
      version: "1",
      goods: {},
      recipes: { "recipe-tools": recipe },
      eventDefinitions: {},
      metricDefinitions: {},
    };

    const registry = buildDefinitionRegistry(definitionPack);
    const retrievedRecipe = registry.recipes["recipe-tools"] as RecipeDefinition;

    expect(retrievedRecipe.id).toBe("recipe-tools-craft");
    expect(Object.keys(retrievedRecipe.inputsPerBatch).sort()).toEqual(["good:iron", "good:wood"]);
    expect(retrievedRecipe.inputsPerBatch["good:iron" as GoodId]).toBe(10);
    expect(retrievedRecipe.inputsPerBatch["good:wood" as GoodId]).toBe(5);
    expect(retrievedRecipe.investmentGoodsPerCapitalUnit["good:tools" as GoodId]).toBe(100);
  });

  it("preserves recipes with optional extraction resource fields", () => {
    const recipe: RecipeDefinition = {
      id: "recipe-iron-mine",
      outputGoodId: "good:iron" as GoodId,
      outputPerBatch: 200,
      inputsPerBatch: {},
      laborCategory: "GENERAL",
      laborPerBatch: 50,
      batchesPerCapitalUnit: 1,
      investmentGoodsPerCapitalUnit: {},
      minimumStartupCapital: 500,
      extractionResourceId: "resource:iron-ore",
      extractedResourcePerBatch: 200,
      baseThroughputFactor: 1,
      depreciationRatePerTick: 0.03,
    };

    const definitionPack: DefinitionPack = {
      id: "mining-pack",
      version: "1",
      goods: {},
      recipes: { "recipe-mining": recipe },
      eventDefinitions: {},
      metricDefinitions: {},
    };

    const registry = buildDefinitionRegistry(definitionPack);
    const retrievedRecipe = registry.recipes["recipe-mining"] as RecipeDefinition;

    expect(retrievedRecipe.extractionResourceId).toBe("resource:iron-ore");
    expect(retrievedRecipe.extractedResourcePerBatch).toBe(200);
  });
});
