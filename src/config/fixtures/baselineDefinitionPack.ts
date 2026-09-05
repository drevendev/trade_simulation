/**
 * Baseline definition pack fixture (REQ-CONFIG-003a).
 *
 * Provides the baseline good and recipe definitions for the canonical
 * baseline-multistate-v1 scenario. This fixture demonstrates RecipeDefinition
 * schema compliance and includes at least three distinct production recipes
 * with different input/output configurations, as required by REQ-CONFIG-003a
 * acceptance criteria.
 */
import type { DefinitionPack, GoodDefinition, RecipeDefinition } from "../definitionPack";
import type { GoodId } from "../../domain/id";

// Good definitions with proper typing
const food: GoodDefinition = {
  id: "good:food" as GoodId,
  name: "Food",
  unitLabel: "units",
  spoilageRatePerTick: 0.05,
  consumerNeedCategory: "subsistence",
  necessityWeight: 0.4,
  substitutionGroup: "staple",
  referencePrice: 10,
  tradable: true,
};

const wood: GoodDefinition = {
  id: "good:wood" as GoodId,
  name: "Wood",
  unitLabel: "units",
  spoilageRatePerTick: 0.01,
  consumerNeedCategory: "material",
  necessityWeight: 0.2,
  substitutionGroup: "construction",
  referencePrice: 8,
  tradable: true,
};

const iron: GoodDefinition = {
  id: "good:iron" as GoodId,
  name: "Iron",
  unitLabel: "units",
  spoilageRatePerTick: 0.0,
  consumerNeedCategory: null,
  referencePrice: 15,
  tradable: true,
};

const tools: GoodDefinition = {
  id: "good:tools" as GoodId,
  name: "Tools",
  unitLabel: "units",
  spoilageRatePerTick: 0.02,
  consumerNeedCategory: null,
  referencePrice: 50,
  tradable: true,
  capitalInfrastructureEligibilityTags: ["capital"],
};

const cloth: GoodDefinition = {
  id: "good:cloth" as GoodId,
  name: "Cloth",
  unitLabel: "units",
  spoilageRatePerTick: 0.02,
  consumerNeedCategory: "clothing",
  necessityWeight: 0.15,
  substitutionGroup: "textile",
  referencePrice: 12,
  tradable: true,
};

const stone: GoodDefinition = {
  id: "good:stone" as GoodId,
  name: "Stone",
  unitLabel: "units",
  spoilageRatePerTick: 0.0,
  consumerNeedCategory: null,
  referencePrice: 5,
  tradable: true,
  capitalInfrastructureEligibilityTags: ["infrastructure"],
};

const copper: GoodDefinition = {
  id: "good:copper" as GoodId,
  name: "Copper",
  unitLabel: "units",
  spoilageRatePerTick: 0.0,
  consumerNeedCategory: null,
  referencePrice: 12,
  tradable: true,
};

const grain: GoodDefinition = {
  id: "good:grain" as GoodId,
  name: "Grain",
  unitLabel: "units",
  spoilageRatePerTick: 0.03,
  consumerNeedCategory: "subsistence",
  necessityWeight: 0.3,
  substitutionGroup: "staple",
  referencePrice: 8,
  tradable: true,
};

/**
 * Baseline recipes: three distinct production processes demonstrating
 * different input/output configurations as required by REQ-CONFIG-003a.
 * M1 does not implement production, labor allocation, investment, or
 * depreciation behavior — only schema and immutable data validation.
 */

// Recipe 1: Harvest — agricultural primary production with labor, no capital
const harvestInputs: Record<string, number> = { "good:grain": 50 };
const foodHarvest: RecipeDefinition = {
  id: "recipe:food-harvest",
  outputGoodId: "good:food" as GoodId,
  outputPerBatch: 100,
  inputsPerBatch: harvestInputs as Record<GoodId, number>,
  laborCategory: "GENERAL",
  laborPerBatch: 20,
  batchesPerCapitalUnit: 1,
  investmentGoodsPerCapitalUnit: {},
  minimumStartupCapital: 50,
  baseThroughputFactor: 1.0,
  depreciationRatePerTick: 0.01,
};

// Recipe 2: Tool-Craft — secondary production with multiple inputs and capital investment
const craftInputs: Record<string, number> = { "good:iron": 10, "good:wood": 5 };
const craftInvestment: Record<string, number> = { "good:tools": 100 };
const toolsCraft: RecipeDefinition = {
  id: "recipe:tools-craft",
  outputGoodId: "good:tools" as GoodId,
  outputPerBatch: 50,
  inputsPerBatch: craftInputs as Record<GoodId, number>,
  laborCategory: "GENERAL",
  laborPerBatch: 30,
  batchesPerCapitalUnit: 2,
  investmentGoodsPerCapitalUnit: craftInvestment as Record<GoodId, number>,
  minimumStartupCapital: 200,
  baseThroughputFactor: 0.9,
  depreciationRatePerTick: 0.02,
};

// Recipe 3: Iron-Mining — extraction with resource depletion and infrastructure requirement
const mineInvestment: Record<string, number> = { "good:tools": 50 };
const ironMine: RecipeDefinition = {
  id: "recipe:iron-mine",
  outputGoodId: "good:iron" as GoodId,
  outputPerBatch: 200,
  inputsPerBatch: {} as Record<GoodId, number>,
  laborCategory: "GENERAL",
  laborPerBatch: 50,
  batchesPerCapitalUnit: 1,
  investmentGoodsPerCapitalUnit: mineInvestment as Record<GoodId, number>,
  minimumStartupCapital: 500,
  infrastructureCategory: "mines",
  minimumInfrastructureFactor: 0.5,
  extractionResourceId: "resource:iron-ore",
  extractedResourcePerBatch: 200,
  baseThroughputFactor: 1.0,
  depreciationRatePerTick: 0.03,
};

/**
 * Baseline definition pack combining goods and recipes for M1 world genesis.
 * Assembles the complete immutable reference data needed to construct
 * baseline-multistate-v1 scenario without later-milestone dynamic behavior.
 */
export const baselineDefinitionPack: DefinitionPack = {
  id: "baseline-pack-v1",
  version: "1.0.0",
  goods: {
    "good:food": food,
    "good:wood": wood,
    "good:iron": iron,
    "good:tools": tools,
    "good:cloth": cloth,
    "good:stone": stone,
    "good:copper": copper,
    "good:grain": grain,
  } as Record<GoodId, GoodDefinition>,
  recipes: {
    "recipe:food-harvest": foodHarvest,
    "recipe:tools-craft": toolsCraft,
    "recipe:iron-mine": ironMine,
  },
  eventDefinitions: {},
  metricDefinitions: {},
};
