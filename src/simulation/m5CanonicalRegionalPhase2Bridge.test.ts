import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { createM5CanonicalRegionalPhase2Bridge } from "./m5SettledPhase4Bridge";
import type { M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import { executeM5CanonicalIntakeTradeTick } from "./m5LiveQuotedTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import {
  buildInitialWorld,
  type ProductionUnitState,
  type RegionState,
  type WorldState,
} from "./worldState";

const IRON = "good:iron" as GoodId;

/**
 * No Phase-2 MarketIntent fixtures: both buyers' demand and CLOSING sellers'
 * liquidation offers must be generated from the opening production units.
 */
function fixture() {
  const initial = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
  );
  const regionalMarkets = [...initial.markets.values()];
  const regionA = [...initial.regions.values()].find(region =>
    regionalMarkets.some(market => market.seed.regionKey === region.seed.key),
  )!;
  const regionB = [...initial.regions.values()].find(region =>
    region.settlementCurrencyId !== regionA.settlementCurrencyId &&
    regionalMarkets.some(market => market.seed.regionKey === region.seed.key),
  )!;
  const templates = [...initial.productionUnits.values()].slice(0, 4);
  expect(templates).toHaveLength(4);

  const makeUnit = (
    template: ProductionUnitState,
    region: RegionState,
    closing: boolean,
  ): ProductionUnitState => ({
    ...template,
    seed: { ...template.seed, regionKey: region.seed.key, recipeId: "recipe:tools-craft" },
    status: closing ? "CLOSING" : "ACTIVE",
    installedCapital: closing ? 0 : 5,
    wallet: new Map([[region.settlementCurrencyId, closing ? 5 : 1_000_000]]),
    inputInventory: closing ? new Map([[IRON, 2]]) : new Map(),
    outputInventory: new Map(),
    investmentInventory: new Map(),
  });
  const buyerA = makeUnit(templates[0]!, regionA, false);
  const sellerA = makeUnit(templates[1]!, regionA, true);
  const buyerB = makeUnit(templates[2]!, regionB, false);
  const sellerB = makeUnit(templates[3]!, regionB, true);

  const markets = new Map(
    [...initial.markets.entries()]
      .filter(([, market]) =>
        market.seed.regionKey === regionA.seed.key ||
        market.seed.regionKey === regionB.seed.key)
      .map(([id, market]) => {
        const priorClose = new Map(market.priceByGood);
        for (const [goodId, good] of Object.entries(initial.definitionRegistry.goods)) {
          priorClose.set(goodId as GoodId, good.referencePrice);
        }
        priorClose.set(IRON, market.seed.regionKey === regionA.seed.key ? 2 : 3);
        return [id, { ...market, priceByGood: priorClose }] as const;
      }),
  );
  const world: WorldState = {
    ...initial,
    regions: new Map([[regionA.regionId, regionA], [regionB.regionId, regionB]]),
    markets,
    productionUnits: new Map([
      [buyerA.productionUnitId, buyerA], [sellerA.productionUnitId, sellerA],
      [buyerB.productionUnitId, buyerB], [sellerB.productionUnitId, sellerB],
    ]),
  };
  const marketConfig = world.simulationConfig.markets;
  const options: M4ClosedEconomyOptions = {
    taxPolicy: {
      getConsumptionTaxRate: () => 0,
      getCollectionEfficiency: () => 1,
    },
    wageTaxPolicy: {
      assessWageIncomeTax: () => 0,
      getCollectionEfficiency: () => 1,
    },
    priceConfig: {
      shortageSignalWeight: marketConfig.shortageSignalWeight!,
      inventorySignalWeight: marketConfig.inventorySignalWeight!,
      basePriceAdjustmentSpeed: marketConfig.basePriceAdjustmentSpeed!,
      maxAbsoluteLogPriceMovePerTick: marketConfig.maxAbsoluteLogPriceMovePerTick!,
      targetInventoryCoverageTicks: marketConfig.targetInventoryCoverageTicks!,
      minimumPrice: 0.001,
      maximumPrice: 1_000_000,
    },
  };
  return { world, options, regionA, regionB, buyerA, buyerB, sellerA, sellerB };
}

const emptyHouseholds: PhaseHandler = (_world, context) =>
  context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;

function run(f: ReturnType<typeof fixture>, upstream: PhaseHandler = emptyHouseholds) {
  const bridge = createM5CanonicalRegionalPhase2Bridge(
    upstream, (_phase, world) => world, f.options,
  );
  return executeM5CanonicalIntakeTradeTick(
    f.world, 7, bridge.handler, bridge.applyPhaseTransition,
    () => null, // No fabricated route or FX; Phase 7 remains independently owned.
    undefined, undefined, undefined, undefined, f.options.priceConfig,
  );
}

describe("M5/#673 canonical regional Phase-2 -> paid Phase-4 procurement", () => {
  it("derives own-country INPUT and liquidation offers then settles both currencies", () => {
    const f = fixture();
    const result = run(f);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);

    const input = result.context.productionMarketIntents!.filter(
      intent => intent.side === "BUY" && intent.purpose === "INPUT" && intent.goodId === IRON,
    );
    expect(new Set(input.map(intent => intent.regionId)))
      .toEqual(new Set([f.regionA.regionId, f.regionB.regionId]));
    expect(input.every(intent => intent.sourcePlanId?.startsWith("production-plan:7:")))
      .toBe(true);
    expect(result.context.productionPlans).toHaveLength(4);
    expect(result.context.laborDemandPlans).toHaveLength(4);

    const iron = result.context.phase4MarketAllocations!.filter(
      allocation => allocation.goodId === IRON,
    );
    expect(iron).toHaveLength(2);
    expect(new Set(iron.map(allocation => allocation.marketCurrencyId)))
      .toEqual(new Set([f.regionA.settlementCurrencyId, f.regionB.settlementCurrencyId]));
    expect(iron.map(allocation => allocation.quantity)).toEqual([2, 2]);
    expect(new Set(iron.map(allocation => allocation.id)).size).toBe(2);

    for (const [buyer, seller, region, price] of [
      [f.buyerA, f.sellerA, f.regionA, 2],
      [f.buyerB, f.sellerB, f.regionB, 3],
    ] as const) {
      expect(result.world.productionUnits.get(buyer.productionUnitId)!.inputInventory.get(IRON))
        .toBe(2);
      expect(result.world.productionUnits.get(seller.productionUnitId)!.inputInventory.get(IRON))
        .toBe(0);
      expect(result.world.productionUnits.get(buyer.productionUnitId)!.wallet.get(region.settlementCurrencyId))
        .toBe(1_000_000 - 2 * price);
      expect(result.world.productionUnits.get(seller.productionUnitId)!.wallet.get(region.settlementCurrencyId))
        .toBe(5 + 2 * price);
      expect(
        result.world.productionUnits.get(buyer.productionUnitId)!.wallet.get(region.settlementCurrencyId)! +
        result.world.productionUnits.get(seller.productionUnitId)!.wallet.get(region.settlementCurrencyId)!,
      ).toBe(1_000_005);
      expect(f.world.productionUnits.get(seller.productionUnitId)!.inputInventory.get(IRON)).toBe(2);
    }
    expect(result.world.shipments?.size ?? 0).toBe(0);
    expect(result.context.transactions.filter(tx => tx.phase === 4 && tx.type === "MARKET_SALE"))
      .toHaveLength(2);
  });

  it("replays identically regardless of Region/Market/ProductionUnit insertion order", () => {
    const f = fixture();
    const reordered: ReturnType<typeof fixture> = {
      ...f,
      world: {
        ...f.world,
        regions: new Map([...f.world.regions].reverse()),
        markets: new Map([...f.world.markets].reverse()),
        productionUnits: new Map([...f.world.productionUnits].reverse()),
      },
    };
    const a = run(f);
    const b = run(reordered);
    expect(a.context.productionMarketIntents).toEqual(b.context.productionMarketIntents);
    expect(a.context.phase4MarketAllocations).toEqual(b.context.phase4MarketAllocations);
    expect(a.context.marketPrices).toEqual(b.context.marketPrices);
    expect(a.world.productionUnits).toEqual(b.world.productionUnits);
  });

  it("rejects caller-supplied Phase-2 production evidence instead of using forged orders", () => {
    const f = fixture();
    const forged: PhaseHandler = (_world, context) => context.phase === 2
      ? { ...context, productionMarketIntents: [], householdMarketIntents: [] }
      : context;
    expect(() => run(f, forged)).toThrow(
      /forbids externally supplied production plans\/intents/,
    );
    expect(f.world.productionUnits.get(f.sellerA.productionUnitId)!.inputInventory.get(IRON))
      .toBe(2);
  });

  it("fails closed without a region's authentic prior-close price", () => {
    const f = fixture();
    const market = [...f.world.markets.values()].find(
      candidate => candidate.seed.regionKey === f.regionB.seed.key,
    )!;
    const prices = new Map(market.priceByGood);
    prices.delete(IRON);
    const bad: ReturnType<typeof fixture> = {
      ...f,
      world: {
        ...f.world,
        markets: new Map(f.world.markets).set(market.marketId, {
          ...market, priceByGood: prices,
        }),
      },
    };
    expect(() => run(bad)).toThrow(/missing prior-close local price/);
    expect(bad.world.productionUnits.get(f.sellerB.productionUnitId)!.inputInventory.get(IRON))
      .toBe(2);
  });
});
