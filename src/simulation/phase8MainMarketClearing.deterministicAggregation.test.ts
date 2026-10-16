import { describe, expect, it } from "vitest";
import type { GoodId } from "../domain/id";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { buildInitialWorld, type WorldState } from "./worldState";
import { executeTick } from "./tickOrchestrator";
import { createPhase8Handler } from "./phase8MainMarketClearing";
import { applyMarketSettlementTransition } from "./marketSettlementTransition";
import { applyMarketStateTransition } from "./marketStateTransition";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import type { TaxPolicyProvider } from "./marketSettlement";

const FOOD = "good:food" as GoodId;
const zeroTax: TaxPolicyProvider = {
  getConsumptionTaxRate: () => 0,
  getCollectionEfficiency: () => 0,
};

function fixture() {
  const initial = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
  for (const region of initial.regions.values()) {
    if (region.controllerStateId === null) continue;
    const seller = Array.from(initial.productionUnits.values()).find((unit) =>
      unit.seed.regionKey === region.seed.key && (unit.outputInventory.get(FOOD) ?? 0) >= 1,
    );
    const buyer = Array.from(initial.cohorts.values()).find((cohort) =>
      cohort.seed.regionKey === region.seed.key && (cohort.wallet.get(region.settlementCurrencyId) ?? 0) >= 1,
    );
    const market = Array.from(initial.markets.values()).find((candidate) => candidate.seed.regionKey === region.seed.key);
    if (!seller || !buyer || !market) continue;
    const world: WorldState = {
      ...initial,
      markets: new Map(initial.markets).set(market.marketId, {
        ...market,
        priceByGood: new Map(market.priceByGood).set(FOOD, 1),
      }),
    };
    const sell: MarketIntent = {
      id: createMarketIntentId("mi:slp78702-seller"),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: seller.productionUnitId },
      regionId: region.regionId, goodId: FOOD, side: "SELL",
      purpose: "INVENTORY_REBALANCE", desiredQuantity: 1,
      minimumReserveQuantity: 0, inventoryBucket: "OUTPUT", sourcePlanId: "plan:slp78702-supply",
    };
    const amounts = [0.5, 5e-17, 5e-17, 5e-15];
    const buys: MarketIntent[] = amounts.map((desiredQuantity, index) => ({
      id: createMarketIntentId(`mi:slp78702-buyer-${index}`),
      actor: { type: "COHORT", cohortId: buyer.cohortId },
      regionId: region.regionId, goodId: FOOD, side: "BUY", purpose: "CONSUMPTION",
      desiredQuantity, maxSpend: desiredQuantity, sourcePlanId: `plan:slp78702-demand-${index}`,
    }));
    return { world, region, market, sell, buys, amounts };
  }
  throw new Error("Baseline fixture has no funded local buyer and stocked seller");
}

function permutations<T>(entries: T[]): T[][] {
  return entries.length === 0 ? [[]] : entries.flatMap((head, index) =>
    permutations(entries.filter((_, other) => index !== other)).map((tail) => [head, ...tail]),
  );
}

describe("SLP-787-02 deterministic Phase-8 aggregates", () => {
  it("settles every funded permutation and persists identical expectations with telemetry on or off", () => {
    const { world, region, market, sell, buys, amounts } = fixture();
    const allOrders = permutations(buys);
    const original = JSON.stringify(buys);
    expect(allOrders).toHaveLength(24);
    // Sensitivity control: this is an actual floating-order witness, not four
    // exactly summable amounts or a fixture with no affordable allocations.
    expect(new Set(allOrders.map((order) => order.reduce((sum, intent) => sum + intent.desiredQuantity, 0))).size).toBe(2);
    const expectedDemand = amounts.reduce((sum, quantity) => sum + quantity, 0);
    const run = (order: MarketIntent[], collectTelemetry: boolean) => {
      const result = executeTick(world, 1, world.pendingTransitions, createPhase8Handler({
        getFixtureIntents: () => [sell, ...order],
        getFixtureMarketIds: () => new Map([[region.regionId, market.marketId]]),
        collectTelemetry, taxPolicy: zeroTax,
      }));
      expect(result.reconciliationErrors).toBeNull();
      expect(result.phaseBoundaryError).toBeUndefined();
      const settled = applyMarketSettlementTransition(world, result.context);
      const persisted = applyMarketStateTransition(settled, result.context);
      expect(persisted.markets.get(market.marketId)!.expectationsByGood.get(FOOD)!.observationCount).toBeGreaterThan(0);
      return {
        allocations: result.context.marketAllocations,
        aggregates: Array.from(result.context.marketClearingAggregates.entries()),
        telemetry: result.context.marketTelemetry,
        expectations: Array.from(persisted.markets.get(market.marketId)!.expectationsByGood.entries()),
        sellerInventory: Array.from(settled.productionUnits.values()).map((unit) => [unit.productionUnitId, Array.from(unit.outputInventory.entries())]),
        buyerWallets: Array.from(settled.cohorts.values()).map((cohort) => [cohort.cohortId, Array.from(cohort.wallet.entries())]),
      };
    };
    const reference = run(buys, true);
    expect(reference.allocations.length).toBeGreaterThan(0);
    expect(reference.allocations.reduce((sum, lot) => sum + lot.quantity, 0)).toBeGreaterThan(0);
    expect(reference.telemetry).toHaveLength(1);
    expect(reference.aggregates).toHaveLength(1);
    expect(reference.aggregates[0]![1].effectiveDemandQuantity).toBe(expectedDemand);
    for (const order of allOrders) {
      expect(run(order, true)).toEqual(reference);
      expect(run(order, false)).toEqual({ ...reference, telemetry: [] });
    }
    expect(JSON.stringify(buys)).toBe(original);
  });
});
