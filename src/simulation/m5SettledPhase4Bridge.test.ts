import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { createM5SettledPhase4Bridge } from "./m5SettledPhase4Bridge";
import type { M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import { executeM5CanonicalIntakeTradeTick } from "./m5LiveQuotedTradeTick";
import { derivePhase7PostProcurementIntents } from "./phase7PostProcurementIntents";
import { marketPriceKey } from "./phase6MarketPriceFormation";
import type { PhaseHandler } from "./tickOrchestrator";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

function fixture() {
  const initial = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
  );
  const region = [...initial.regions.values()].find(candidate =>
    [...initial.markets.values()].some(market => market.seed.regionKey === candidate.seed.key),
  )!;
  const market = [...initial.markets.values()].find(m => m.seed.regionKey === region.seed.key)!;
  const [seller, buyer] = [...initial.productionUnits.values()];
  const currency = region.settlementCurrencyId;
  const world: WorldState = {
    ...initial,
    regions: new Map([[region.regionId, region]]),
    markets: new Map([[market.marketId, {
      ...market,
      priceByGood: new Map(market.priceByGood).set(GOOD, 2),
    }]]),
    productionUnits: new Map([
      [seller!.productionUnitId, {
        ...seller!, seed: { ...seller!.seed, regionKey: region.seed.key },
        inputInventory: new Map(seller!.inputInventory),
        outputInventory: new Map(seller!.outputInventory).set(GOOD, 3),
        wallet: new Map(seller!.wallet).set(currency, 5),
      }],
      [buyer!.productionUnitId, {
        ...buyer!, seed: { ...buyer!.seed, regionKey: region.seed.key },
        inputInventory: new Map(buyer!.inputInventory).set(GOOD, 0),
        wallet: new Map(buyer!.wallet).set(currency, 30),
      }],
    ]),
  };

  const buy: MarketIntent = {
    id: createMarketIntentId("mi:m5:real-phase4:buy"),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: buyer!.productionUnitId },
    regionId: region.regionId, goodId: GOOD, side: "BUY", purpose: "INPUT",
    desiredQuantity: 5, maxSpend: 30, inventoryBucket: "INPUT",
    sourcePlanId: "plan:m5:real-phase4:buy",
  };
  const sell: MarketIntent = {
    id: createMarketIntentId("mi:m5:real-phase4:sell"),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: seller!.productionUnitId },
    regionId: region.regionId, goodId: GOOD, side: "SELL",
    purpose: "INVENTORY_REBALANCE", desiredQuantity: 2,
    minimumReserveQuantity: 0, inventoryBucket: "OUTPUT",
    sourcePlanId: "plan:m5:real-phase4:sell",
  };
  const phase5Offer: MarketIntent = {
    ...sell, id: createMarketIntentId("mi:m5:real-phase4:phase5-offer"),
    desiredQuantity: 1, sourcePlanId: "plan:m5:real-phase4:phase5-offer",
  };
  const markets = world.simulationConfig.markets;
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
      shortageSignalWeight: markets.shortageSignalWeight!,
      inventorySignalWeight: markets.inventorySignalWeight!,
      basePriceAdjustmentSpeed: markets.basePriceAdjustmentSpeed!,
      maxAbsoluteLogPriceMovePerTick: markets.maxAbsoluteLogPriceMovePerTick!,
      targetInventoryCoverageTicks: markets.targetInventoryCoverageTicks!,
      minimumPrice: 0.001, maximumPrice: 1_000_000,
    },
  };
  return { world, region, market, currency, seller, buyer, buy, sell, phase5Offer, options };
}

describe("M5 #673 physically settled Phase-4 pre-production bridge", () => {
  function run(
    f: ReturnType<typeof fixture>,
    upstreamOverride?: PhaseHandler,
  ) {
    const planning: PhaseHandler = (_world, context) => {
      if (context.phase === 2) {
        return { ...context, productionMarketIntents: [f.buy, f.sell], householdMarketIntents: [] };
      }
      if (context.phase === 5) {
        return {
          ...context,
          productionMarketIntents: [...context.productionMarketIntents!, f.phase5Offer],
        };
      }
      return context;
    };
    const bridge = createM5SettledPhase4Bridge(
      upstreamOverride ?? planning,
      (_phase, world) => world,
      f.options,
    );
    return executeM5CanonicalIntakeTradeTick(
      f.world, 7, bridge.handler, bridge.applyPhaseTransition,
      (world, context) => {
        const postProcurement = derivePhase7PostProcurementIntents(world, context);
        const byId = new Map(postProcurement.phase8MainIntents.map(intent => [intent.id, intent]));
        expect(byId.get(f.buy.id)?.desiredQuantity).toBe(3);
        expect(byId.get(f.buy.id)?.maxSpend).toBe(26);
        expect(byId.has(f.sell.id)).toBe(false);
        expect(byId.get(f.phase5Offer.id)?.desiredQuantity).toBe(1);
        expect(world.productionUnits.get(f.seller.productionUnitId)!.outputInventory.get(GOOD)).toBe(1);
        expect(world.productionUnits.get(f.buyer.productionUnitId)!.inputInventory.get(GOOD)).toBe(2);
        return null; // A real procurement does not invent a cross-region shipment.
      },
      undefined, undefined, undefined, undefined, f.options.priceConfig,
    );
  }

  it("commits real inventory and money BEFORE pricing and Phase-7 residuals", () => {
    const f = fixture();
    const originalSeller = f.world.productionUnits.get(f.seller.productionUnitId)!;
    const originalBuyer = f.world.productionUnits.get(f.buyer.productionUnitId)!;
    const first = run(f);
    const again = run(f);
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    expect(first.phaseBoundaryError).toBeUndefined();
    expect(first.reconciliationErrors).toBeNull();
    expect(first.context.phase4MarketAllocations).toHaveLength(1);
    const allocation = first.context.phase4MarketAllocations![0]!;
    expect(allocation.pass).toBe("PRE_PRODUCTION");
    expect(allocation.quantity).toBe(2);
    expect(allocation.sellerNetUnitPrice).toBe(2);
    expect(allocation.buyerGrossUnitPrice).toBe(2);
    expect(first.context.transactions.some(tx => tx.phase === 4 && tx.type === "MARKET_SALE"))
      .toBe(true);

    const settledSeller = first.world.productionUnits.get(f.seller.productionUnitId)!;
    const settledBuyer = first.world.productionUnits.get(f.buyer.productionUnitId)!;
    expect(settledSeller.outputInventory.get(GOOD)).toBe(1);
    expect(settledBuyer.inputInventory.get(GOOD)).toBe(2);
    expect(settledSeller.wallet.get(f.currency)).toBe(9);
    expect(settledBuyer.wallet.get(f.currency)).toBe(26);
    expect(
      settledSeller.outputInventory.get(GOOD)! + settledBuyer.inputInventory.get(GOOD)!,
    ).toBe(3);
    expect(settledSeller.wallet.get(f.currency)! + settledBuyer.wallet.get(f.currency)!)
      .toBe(35);

    const price = first.context.marketPrices.get(marketPriceKey(f.market.marketId, GOOD));
    expect(price).toBeDefined();
    expect(Number.isFinite(price)).toBe(true);
    expect(again.context.marketPrices).toEqual(first.context.marketPrices);
    expect(again.world.productionUnits).toEqual(first.world.productionUnits);
    expect(first.world.shipments?.size ?? 0).toBe(0);
    expect(originalSeller.outputInventory.get(GOOD)).toBe(3);
    expect(originalBuyer.inputInventory.get(GOOD)).toBe(0);
    expect(originalSeller.wallet.get(f.currency)).toBe(5);
    expect(originalBuyer.wallet.get(f.currency)).toBe(30);
  });

  it("rejects an underfunded physical buyer without publishing any successor", () => {
    const f = fixture();
    const initialBuyer = f.world.productionUnits.get(f.buyer.productionUnitId)!;
    const underfunded: ReturnType<typeof fixture> = {
      ...f,
      world: {
        ...f.world,
        productionUnits: new Map(f.world.productionUnits).set(f.buyer.productionUnitId, {
          ...initialBuyer, wallet: new Map(initialBuyer.wallet).set(f.currency, 1),
        }),
      },
    };
    expect(() => run(underfunded)).toThrow(/executeAllocation:|preflight failed/);
    expect(underfunded.world.productionUnits.get(f.seller.productionUnitId)!.outputInventory.get(GOOD))
      .toBe(3);
    expect(underfunded.world.productionUnits.get(f.buyer.productionUnitId)!.inputInventory.get(GOOD))
      .toBe(0);
    expect(underfunded.world.shipments?.size ?? 0).toBe(0);
  });

  it("refuses caller-forged Phase-4 allocations instead of treating them as payment evidence", () => {
    const f = fixture();
    const invalid: PhaseHandler = (_world, context) => context.phase === 4
      ? { ...context, phase4MarketAllocations: [] }
      : context.phase === 2
        ? { ...context, productionMarketIntents: [f.buy, f.sell], householdMarketIntents: [] }
        : context;
    expect(() => run(f, invalid)).toThrow("M5 settled Phase-4 forbids caller-provided allocations");
    expect(f.world.productionUnits.get(f.seller.productionUnitId)!.outputInventory.get(GOOD))
      .toBe(3);
  });

  it("fails closed when the existing one-region procurement owner sees multiple regions", () => {
    const f = fixture();
    const additional = [...buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
    ).regions].find(([id]) => id !== f.region.regionId)!;
    const invalid = {
      ...f,
      world: { ...f.world, regions: new Map([...f.world.regions, additional]) },
    };
    expect(() => run(invalid)).toThrow(/requires exactly one live Region/);
  });
});
