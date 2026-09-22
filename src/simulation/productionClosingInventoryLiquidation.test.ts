import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId } from "../domain/id";
import { createMarketAllocationId, type MarketAllocation } from "./marketClearing";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { executeAllocation } from "./marketSettlementTransition";
import { planProductionUnitPhase2 } from "./productionPlanning";
import { isProductionUnitSafeForRetirement } from "./productionUnitLifecycle";
import { initializeTickContext } from "./tickOrchestrator";
import { buildInitialWorld, type ProductionUnitState, type WorldState } from "./worldState";

const TICK = 31;
const IRON = "good:iron" as GoodId;
const WOOD = "good:wood" as GoodId;
const STONE = "good:stone" as GoodId;
const TOOLS = "good:tools" as GoodId;

type SeedStatus = ProductionUnitState["seed"]["status"];

function baselineWorld(): WorldState {
  return buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
}

function toolsUnit(world: WorldState): ProductionUnitState {
  const unit = [...world.productionUnits.values()].find(
    (candidate) => candidate.seed.recipeId === "recipe:tools-craft",
  );
  expect(unit).toBeDefined();
  return unit!;
}

function zeroMap<K>(source: ReadonlyMap<K, number>): Map<K, number> {
  return new Map([...source.keys()].map((key) => [key, 0] as const));
}

function closingUnit(
  original: ProductionUnitState,
  seedStatus: SeedStatus,
  inputEntries: readonly (readonly [GoodId, number])[],
  investmentEntries: readonly (readonly [GoodId, number])[],
): ProductionUnitState {
  return {
    ...original,
    seed: { ...original.seed, status: seedStatus },
    status: "CLOSING",
    wallet: zeroMap(original.wallet),
    inputInventory: new Map(inputEntries),
    outputInventory: zeroMap(original.outputInventory),
    investmentInventory: new Map(investmentEntries),
    installedCapital: 0,
  };
}

function worldWithUnit(world: WorldState, unit: ProductionUnitState): WorldState {
  const productionUnits = new Map(world.productionUnits);
  productionUnits.set(unit.productionUnitId, unit);
  return {
    ...world,
    productionUnits,
    pendingTransitions: {
      ...world.pendingTransitions,
      productionUnitLifecycleChanges: [],
    },
  };
}

function planClosing(world: WorldState, unit: ProductionUnitState) {
  const region = [...world.regions.values()].find(
    (candidate) => candidate.seed.key === unit.seed.regionKey,
  );
  expect(region).toBeDefined();
  const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
  expect(recipe).toBeDefined();

  return {
    region: region!,
    result: planProductionUnitPhase2({
      tick: TICK,
      unit,
      regionId: region!.regionId,
      settlementCurrencyId: region!.settlementCurrencyId,
      recipe: recipe!,
      config: world.simulationConfig,
    }),
  };
}

function liquidationShape(intents: readonly MarketIntent[]) {
  return intents.map((intent) => ({
    id: intent.id,
    side: intent.side,
    purpose: intent.purpose,
    goodId: intent.goodId,
    desiredQuantity: intent.desiredQuantity,
    minimumReserveQuantity: intent.minimumReserveQuantity,
    inventoryBucket: intent.inventoryBucket,
    sourcePlanId: intent.sourcePlanId,
  }));
}

function freeFullFillAllocation(
  intent: MarketIntent,
  world: WorldState,
  buyerCohortId: CohortId,
  currencyId: MarketAllocation["marketCurrencyId"],
  sequence: number,
): MarketAllocation {
  if (intent.actor.type !== "PRODUCTION_UNIT") {
    throw new Error("test liquidation seller must be a ProductionUnit");
  }
  if (intent.inventoryBucket !== "INPUT" && intent.inventoryBucket !== "INVESTMENT") {
    throw new Error(`unexpected liquidation bucket ${String(intent.inventoryBucket)}`);
  }
  return {
    id: createMarketAllocationId(`ma:closing-liquidation:${sequence}`),
    marketId: [...world.markets.values()][0]!.marketId,
    regionId: intent.regionId,
    goodId: intent.goodId,
    pass: "PRE_PRODUCTION",
    sellerIntentId: intent.id,
    buyerIntentId: createMarketIntentId(`mi:closing-liquidation-buyer:${sequence}`),
    seller: intent.actor,
    buyer: { type: "COHORT", cohortId: buyerCohortId },
    quantity: intent.desiredQuantity,
    sellerNetUnitPrice: 0,
    buyerGrossUnitPrice: 0,
    marketCurrencyId: currencyId,
    consumptionTaxAmount: 0,
    destinationStateId: null,
    sellerInventoryBucket: intent.inventoryBucket,
    buyerInventoryBucket: "GENERAL",
  };
}

describe("Issue #644 CLOSING INPUT/INVESTMENT liquidation", () => {
  it("emits full ordinary SELL intents in stable bucket/good order from live CLOSING state", () => {
    const world = baselineWorld();
    const original = toolsUnit(world);
    const first = closingUnit(
      original,
      "ACTIVE",
      [[WOOD, 3], [IRON, 4]],
      [[TOOLS, 5], [STONE, 6]],
    );
    const shuffled = closingUnit(
      original,
      "MOTHBALLED",
      [[IRON, 4], [WOOD, 3]],
      [[STONE, 6], [TOOLS, 5]],
    );

    const firstPlan = planClosing(world, first).result;
    const shuffledPlan = planClosing(world, shuffled).result;

    expect(firstPlan.inputIntents).toEqual([]);
    expect(firstPlan.investmentIntents).toEqual([]);
    expect(liquidationShape(firstPlan.liquidationIntents)).toEqual(
      liquidationShape(shuffledPlan.liquidationIntents),
    );
    expect(liquidationShape(firstPlan.liquidationIntents)).toEqual([
      {
        id: createMarketIntentId(`mi:${TICK}:${String(first.productionUnitId)}:CLOSING-LIQUIDATION:INPUT:${String(IRON)}`),
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        goodId: IRON,
        desiredQuantity: 4,
        minimumReserveQuantity: 0,
        inventoryBucket: "INPUT",
        sourcePlanId: `production-plan:${TICK}:${String(first.productionUnitId)}`,
      },
      {
        id: createMarketIntentId(`mi:${TICK}:${String(first.productionUnitId)}:CLOSING-LIQUIDATION:INPUT:${String(WOOD)}`),
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        goodId: WOOD,
        desiredQuantity: 3,
        minimumReserveQuantity: 0,
        inventoryBucket: "INPUT",
        sourcePlanId: `production-plan:${TICK}:${String(first.productionUnitId)}`,
      },
      {
        id: createMarketIntentId(`mi:${TICK}:${String(first.productionUnitId)}:CLOSING-LIQUIDATION:INVESTMENT:${String(STONE)}`),
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        goodId: STONE,
        desiredQuantity: 6,
        minimumReserveQuantity: 0,
        inventoryBucket: "INVESTMENT",
        sourcePlanId: `production-plan:${TICK}:${String(first.productionUnitId)}`,
      },
      {
        id: createMarketIntentId(`mi:${TICK}:${String(first.productionUnitId)}:CLOSING-LIQUIDATION:INVESTMENT:${String(TOOLS)}`),
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        goodId: TOOLS,
        desiredQuantity: 5,
        minimumReserveQuantity: 0,
        inventoryBucket: "INVESTMENT",
        sourcePlanId: `production-plan:${TICK}:${String(first.productionUnitId)}`,
      },
    ]);
  });

  it("uses canonical settlement to drain the exact buckets and can reach safe retirement", () => {
    let world = baselineWorld();
    const original = toolsUnit(world);
    const unit = closingUnit(original, "ACTIVE", [[IRON, 4]], [[TOOLS, 5]]);
    world = worldWithUnit(world, unit);
    const { region, result } = planClosing(world, unit);
    const buyer = [...world.cohorts.values()].find(
      (candidate) => candidate.seed.regionKey === unit.seed.regionKey,
    );
    expect(buyer).toBeDefined();

    expect(isProductionUnitSafeForRetirement(world, unit.productionUnitId)).toBe(false);
    expect(world.productionUnits.get(unit.productionUnitId)!.inputInventory.get(IRON)).toBe(4);
    expect(world.productionUnits.get(unit.productionUnitId)!.investmentInventory.get(TOOLS)).toBe(5);

    let settled = world;
    result.liquidationIntents.forEach((intent, index) => {
      settled = executeAllocation(
        settled,
        { ...initializeTickContext(TICK, 42), phase: 4 },
        freeFullFillAllocation(intent, settled, buyer!.cohortId, region.settlementCurrencyId, index),
      );
    });

    const settledUnit = settled.productionUnits.get(unit.productionUnitId)!;
    expect(settledUnit.inputInventory.get(IRON)).toBe(0);
    expect(settledUnit.investmentInventory.get(TOOLS)).toBe(0);
    expect(settledUnit.outputInventory).toEqual(unit.outputInventory);
    expect(settledUnit.wallet).toEqual(unit.wallet);
    expect(isProductionUnitSafeForRetirement(settled, unit.productionUnitId)).toBe(true);
  });

  it("does not delete residual stock merely because liquidation was planned", () => {
    const world = baselineWorld();
    const original = toolsUnit(world);
    const unit = closingUnit(original, "ACTIVE", [[IRON, 4]], [[TOOLS, 5]]);
    const liveWorld = worldWithUnit(world, unit);

    const { result } = planClosing(liveWorld, unit);

    expect(result.liquidationIntents).toHaveLength(2);
    expect(liveWorld.productionUnits.get(unit.productionUnitId)!.inputInventory.get(IRON)).toBe(4);
    expect(liveWorld.productionUnits.get(unit.productionUnitId)!.investmentInventory.get(TOOLS)).toBe(5);
    expect(isProductionUnitSafeForRetirement(liveWorld, unit.productionUnitId)).toBe(false);
  });
});
