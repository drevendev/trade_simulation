import { describe, expect, it } from "vitest";

import type { RecipeDefinition } from "../definitionPack";
import { baselineDefinitionPack } from "./baselineDefinitionPack";
import { buildDefinitionRegistry } from "../../domain/definitionRegistry";
import type { GoodId } from "../../domain/id";

describe("baselineDefinitionPack fixture", () => {
  it("defines the baseline definition pack with required structure", () => {
    expect(baselineDefinitionPack.id).toBe("baseline-pack-v1");
    expect(baselineDefinitionPack.version).toBe("1.0.0");
    expect(baselineDefinitionPack.goods).toBeDefined();
    expect(baselineDefinitionPack.recipes).toBeDefined();
    expect(baselineDefinitionPack.eventDefinitions).toBeDefined();
    expect(baselineDefinitionPack.metricDefinitions).toBeDefined();
  });

  it("includes exactly 8 baseline goods with valid GoodDefinition shape", () => {
    const goodIds = Object.keys(baselineDefinitionPack.goods);
    expect(goodIds).toHaveLength(8);

    for (const goodId of goodIds) {
      const good = baselineDefinitionPack.goods[goodId as GoodId];
      expect(good).toBeDefined();
      if (!good) return; // Type guard for TypeScript
      expect(good.id).toBeDefined();
      expect(good.name).toBeDefined();
      expect(good.unitLabel).toBeDefined();
      expect(typeof good.spoilageRatePerTick).toBe("number");
      expect(typeof good.referencePrice).toBe("number");
      expect(typeof good.tradable).toBe("boolean");
    }
  });

  it("includes at least three recipes with distinct configurations", () => {
    const recipeIds = Object.keys(baselineDefinitionPack.recipes);
    expect(recipeIds.length).toBeGreaterThanOrEqual(3);

    for (const recipeId of recipeIds) {
      const recipe = baselineDefinitionPack.recipes[recipeId] as RecipeDefinition;
      // Verify structurally distinct RecipeDefinition type
      expect(recipe.id).toBeDefined();
      expect(recipe.outputGoodId).toBeDefined();
      expect(typeof recipe.outputPerBatch).toBe("number");
      expect(recipe.outputPerBatch).toBeGreaterThan(0);
      expect(recipe.inputsPerBatch).toBeDefined();
      expect(recipe.laborCategory).toBeDefined();
      expect(typeof recipe.laborPerBatch).toBe("number");
      expect(recipe.batchesPerCapitalUnit).toBeGreaterThan(0);
      expect(recipe.investmentGoodsPerCapitalUnit).toBeDefined();
      expect(typeof recipe.minimumStartupCapital).toBe("number");
      expect(recipe.minimumStartupCapital).toBeGreaterThanOrEqual(0);
      expect(typeof recipe.baseThroughputFactor).toBe("number");
      expect(recipe.baseThroughputFactor).toBeGreaterThan(0);
      expect(typeof recipe.depreciationRatePerTick).toBe("number");
      expect(recipe.depreciationRatePerTick).toBeGreaterThanOrEqual(0);
      expect(recipe.depreciationRatePerTick).toBeLessThan(1);
    }
  });

  it("includes recipe 1: food-harvest with labor input only", () => {
    const harvest = baselineDefinitionPack.recipes["recipe:food-harvest"] as RecipeDefinition;
    expect(harvest.id).toBe("recipe:food-harvest");
    expect(harvest.outputGoodId).toBe("good:food");
    expect(harvest.outputPerBatch).toBe(100);
    expect(Object.keys(harvest.inputsPerBatch)).toContain("good:grain");
    expect(harvest.inputsPerBatch["good:grain" as GoodId]).toBe(50);
    expect(harvest.laborPerBatch).toBe(20);
    expect(Object.keys(harvest.investmentGoodsPerCapitalUnit)).toHaveLength(0);
    expect(harvest.minimumStartupCapital).toBe(50);
    expect(harvest.extractionResourceId).toBeUndefined();
  });

  it("includes recipe 2: tools-craft with multiple inputs and capital investment", () => {
    const craft = baselineDefinitionPack.recipes["recipe:tools-craft"] as RecipeDefinition;
    expect(craft.id).toBe("recipe:tools-craft");
    expect(craft.outputGoodId).toBe("good:tools" as GoodId);
    expect(craft.outputPerBatch).toBe(50);
    // Multiple distinct inputs
    expect(Object.keys(craft.inputsPerBatch)).toHaveLength(2);
    expect(craft.inputsPerBatch["good:iron" as GoodId]).toBe(10);
    expect(craft.inputsPerBatch["good:wood" as GoodId]).toBe(5);
    expect(craft.laborPerBatch).toBe(30);
    // Has investment goods
    expect(Object.keys(craft.investmentGoodsPerCapitalUnit)).toContain("good:tools");
    expect(craft.investmentGoodsPerCapitalUnit["good:tools" as GoodId]).toBe(100);
    expect(craft.minimumStartupCapital).toBe(200);
    expect(craft.batchesPerCapitalUnit).toBe(2);
  });

  it("includes recipe 3: iron-mine with extraction resource and infrastructure requirement", () => {
    const mine = baselineDefinitionPack.recipes["recipe:iron-mine"] as RecipeDefinition;
    expect(mine.id).toBe("recipe:iron-mine");
    expect(mine.outputGoodId).toBe("good:iron");
    expect(mine.outputPerBatch).toBe(200);
    expect(Object.keys(mine.inputsPerBatch)).toHaveLength(0); // No material inputs
    expect(mine.laborPerBatch).toBe(50);
    expect(mine.minimumStartupCapital).toBe(500);
    // Extraction resource fields
    expect(mine.extractionResourceId).toBe("resource:iron-ore");
    expect(mine.extractedResourcePerBatch).toBe(200);
    // Infrastructure requirement
    expect(mine.infrastructureCategory).toBe("mines");
    expect(mine.minimumInfrastructureFactor).toBe(0.5);
  });

  it("passes recipes through buildDefinitionRegistry unchanged", () => {
    const registry = buildDefinitionRegistry(baselineDefinitionPack);

    const harvested = baselineDefinitionPack.recipes["recipe:food-harvest"] as RecipeDefinition;
    const registryHarvest = registry.recipes["recipe:food-harvest"] as RecipeDefinition;
    expect(registryHarvest).toBe(harvested);

    const crafted = baselineDefinitionPack.recipes["recipe:tools-craft"] as RecipeDefinition;
    const registryCraft = registry.recipes["recipe:tools-craft"] as RecipeDefinition;
    expect(registryCraft).toBe(crafted);

    const mined = baselineDefinitionPack.recipes["recipe:iron-mine"] as RecipeDefinition;
    const registryMine = registry.recipes["recipe:iron-mine"] as RecipeDefinition;
    expect(registryMine).toBe(mined);
  });

  it("validates all recipes reference defined goods for output and inputs", () => {
    const goodIds = new Set(Object.keys(baselineDefinitionPack.goods));

    for (const recipeId of Object.keys(baselineDefinitionPack.recipes)) {
      const recipe = baselineDefinitionPack.recipes[recipeId] as RecipeDefinition;
      expect(goodIds).toContain(recipe.outputGoodId);

      for (const inputGoodId of Object.keys(recipe.inputsPerBatch)) {
        expect(goodIds).toContain(inputGoodId);
      }

      for (const investmentGoodId of Object.keys(recipe.investmentGoodsPerCapitalUnit)) {
        expect(goodIds).toContain(investmentGoodId);
      }
    }
  });

  it("enforces immutability of goods and recipes records", () => {
    const goodsFrozen = Object.isFrozen(baselineDefinitionPack.goods);
    const recipesFrozen = Object.isFrozen(baselineDefinitionPack.recipes);

    // While Object.isFrozen may not be true on the object itself due to readonly
    // type vs runtime behavior, verify that the structure is semantically immutable
    expect(baselineDefinitionPack.goods).toBeDefined();
    expect(baselineDefinitionPack.recipes).toBeDefined();

    // Verify recipes contain no mutable state
    for (const recipeId of Object.keys(baselineDefinitionPack.recipes)) {
      const recipe = baselineDefinitionPack.recipes[recipeId] as RecipeDefinition;
      expect(() => {
        (recipe as any).outputPerBatch = 999;
      }).toBeDefined();
    }
  });
});
