import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ProductionUnitId, RegionId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { phase4ProcurementHandler, type M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import { initializeTickContext } from "./tickOrchestrator";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

interface Phase4Fixture {
  readonly world: WorldState;
  readonly regionId: RegionId;
  readonly sellerId: ProductionUnitId;
  readonly buyerId: ProductionUnitId;
}

function fixture(price = 1, sellerOutput = 10, sellerInput = 0): Phase4Fixture {
  const base = buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
  const region = [...base.regions.values()].find((candidate) =>
    [...base.markets.values()].some((market) => market.seed.regionKey === candidate.seed.key),
  );
  expect(region).toBeDefined();
  const market = [...base.markets.values()].find((candidate) => candidate.seed.regionKey === region!.seed.key);
  const units = [...base.productionUnits.values()];
  expect(market).toBeDefined();
  expect(units.length).toBeGreaterThanOrEqual(2);
  const seller = units[0]!;
  const buyer = units.find((unit) => unit.productionUnitId !== seller.productionUnitId)!;
  const sellerUnit = {
    ...seller,
    seed: { ...seller.seed, regionKey: region!.seed.key },
    inputInventory: new Map(seller.inputInventory).set(GOOD, sellerInput),
    outputInventory: new Map(seller.outputInventory).set(GOOD, sellerOutput),
  };
  const buyerUnit = {
    ...buyer,
    seed: { ...buyer.seed, regionKey: region!.seed.key },
  };
  const priceByGood = new Map(market!.priceByGood).set(GOOD, price);
  return {
    world: {
      ...base,
      regions: new Map([[region!.regionId, region!]]),
      markets: new Map([[market!.marketId, { ...market!, priceByGood }]]),
      productionUnits: new Map([
        [sellerUnit.productionUnitId, sellerUnit],
        [buyerUnit.productionUnitId, buyerUnit],
      ]),
    },
    regionId: region!.regionId,
    sellerId: sellerUnit.productionUnitId,
    buyerId: buyerUnit.productionUnitId,
  };
}

function options(world: WorldState): M4ClosedEconomyOptions {
  const config = world.simulationConfig.markets;
  return {
    taxPolicy: { getConsumptionTaxRate: () => 0, getCollectionEfficiency: () => 1 },
    wageTaxPolicy: { assessWageIncomeTax: () => 0, getCollectionEfficiency: () => 1 },
    priceConfig: {
      shortageSignalWeight: config.shortageSignalWeight!,
      inventorySignalWeight: config.inventorySignalWeight!,
      basePriceAdjustmentSpeed: config.basePriceAdjustmentSpeed!,
      maxAbsoluteLogPriceMovePerTick: config.maxAbsoluteLogPriceMovePerTick!,
      targetInventoryCoverageTicks: config.targetInventoryCoverageTicks!,
      minimumPrice: 0.01,
      maximumPrice: 1_000_000,
    },
  };
}

function buy(f: Phase4Fixture, desired = 20, maxSpend = 100): MarketIntent {
  return {
    id: createMarketIntentId("mi:phase4-buyer"),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: f.buyerId },
    regionId: f.regionId,
    goodId: GOOD,
    side: "BUY",
    purpose: "INPUT",
    desiredQuantity: desired,
    maxSpend,
    sourcePlanId: "plan:phase4-test-buyer",
    inventoryBucket: "INPUT",
  };
}

function sell(
  f: Phase4Fixture,
  suffix: string,
  bucket: "INPUT" | "OUTPUT" = "OUTPUT",
  reserve = 0,
  desired = 10,
): MarketIntent {
  return {
    id: createMarketIntentId(`mi:phase4-seller-${suffix}`),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: f.sellerId },
    regionId: f.regionId,
    goodId: GOOD,
    side: "SELL",
    purpose: "INVENTORY_REBALANCE",
    desiredQuantity: desired,
    minimumReserveQuantity: reserve,
    sourcePlanId: "plan:phase4-test-seller",
    inventoryBucket: bucket,
  };
}

function run(f: Phase4Fixture, intents: readonly MarketIntent[]) {
  const context = {
    ...initializeTickContext(1, 42),
    phase: 4,
    productionMarketIntents: intents,
  };
  const result = phase4ProcurementHandler(options(f.world))(f.world, context, f.world.pendingTransitions);
  return result.phase4MarketAllocations ?? [];
}

function total(allocations: ReturnType<typeof run>): number {
  return allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
}

describe("M4 Phase-4 physical reservations and affordability", () => {
  it("honors moneyEpsilon (not quantityEpsilon) when the two tolerances diverge", () => {
    const f = fixture(0.01);
    const world = {
      ...f.world,
      simulationConfig: {
        ...f.world.simulationConfig,
        numeric: { ...f.world.simulationConfig.numeric, moneyEpsilon: 1, quantityEpsilon: 1e-9 },
      },
    };
    const divergent = { ...f, world };
    expect(total(run(divergent, [buy(divergent, 10, 0.5), sell(divergent, "a")]))).toBe(0.5);
  });

  it("keeps default-equal-epsilon affordable trades unchanged", () => {
    const f = fixture(0.01);
    expect(total(run(f, [buy(f, 10, 0.5), sell(f, "a")]))).toBe(10);
  });

  it("does not double-offer ten owned OUTPUT units through two distinct seller intents", () => {
    const f = fixture(1, 10);
    const openingOutput = f.world.productionUnits.get(f.sellerId)!.outputInventory.get(GOOD);
    const allocations = run(f, [buy(f), sell(f, "b"), sell(f, "a")]);
    expect(total(allocations)).toBe(10);
    expect(allocations.map((allocation) => allocation.sellerIntentId)).toEqual([
      createMarketIntentId("mi:phase4-seller-a"),
    ]);
    expect(f.world.productionUnits.get(f.sellerId)!.outputInventory.get(GOOD)).toBe(openingOutput);
  });

  it("preserves the same physical reserve across multiple offers", () => {
    const f = fixture(1, 10);
    const allocations = run(f, [buy(f), sell(f, "b", "OUTPUT", 5), sell(f, "a", "OUTPUT", 5)]);
    expect(total(allocations)).toBe(5);
    expect(allocations[0]!.sellerIntentId).toBe(createMarketIntentId("mi:phase4-seller-a"));
  });

  it("produces the same reservations and allocations after reversing input insertion order", () => {
    const f = fixture(1, 10);
    const a = sell(f, "a"), b = sell(f, "b"), buyer = buy(f);
    const normalize = (intents: MarketIntent[]) => run(f, intents)
      .map((allocation) => [allocation.sellerIntentId, allocation.buyerIntentId, allocation.quantity]);
    expect(normalize([buyer, a, b])).toEqual(normalize([b, a, buyer]));
  });

  it("does not conflate distinct INPUT and OUTPUT warehouses of the same seller", () => {
    const f = fixture(1, 10, 10);
    const allocations = run(f, [buy(f), sell(f, "input", "INPUT"), sell(f, "output", "OUTPUT")]);
    expect(total(allocations)).toBe(20);
    expect(new Set(allocations.map((allocation) => allocation.sellerInventoryBucket))).toEqual(
      new Set(["INPUT", "OUTPUT"]),
    );
  });
});
