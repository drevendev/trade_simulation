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
  const units = [...initial.productionUnits.values()];
  const seller = units[0]!;
  const buyer = units[1]!;
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
  it("settles two regional procurement markets in separate currencies before Phase-6/7", () => {
    const f = fixture();
    const initial = buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
    );
    const otherRegion = [...initial.regions.values()].find(region =>
      region.settlementCurrencyId !== f.currency &&
      [...initial.markets.values()].some(m => m.seed.regionKey === region.seed.key),
    )!;
    const otherMarket = [...initial.markets.values()].find(
      m => m.seed.regionKey === otherRegion.seed.key,
    )!;
    const otherUnits = [...initial.productionUnits.values()].filter(unit =>
      unit.productionUnitId !== f.seller.productionUnitId &&
      unit.productionUnitId !== f.buyer.productionUnitId,
    );
    const sellerB = {
      ...otherUnits[0]!,
      seed: { ...otherUnits[0]!.seed, regionKey: otherRegion.seed.key },
      outputInventory: new Map(otherUnits[0]!.outputInventory).set(GOOD, 4),
      wallet: new Map(otherUnits[0]!.wallet).set(otherRegion.settlementCurrencyId, 5),
    };
    const buyerB = {
      ...otherUnits[1]!,
      seed: { ...otherUnits[1]!.seed, regionKey: otherRegion.seed.key },
      inputInventory: new Map(otherUnits[1]!.inputInventory).set(GOOD, 0),
      wallet: new Map(otherUnits[1]!.wallet).set(otherRegion.settlementCurrencyId, 30),
    };
    const world: WorldState = {
      ...f.world,
      regions: new Map([
        [otherRegion.regionId, otherRegion],
        [f.region.regionId, f.region],
      ]),
      markets: new Map([
        [otherMarket.marketId, {
          ...otherMarket, priceByGood: new Map(otherMarket.priceByGood).set(GOOD, 3),
        }],
        ...f.world.markets,
      ]),
      productionUnits: new Map([
        ...f.world.productionUnits,
        [sellerB.productionUnitId, sellerB],
        [buyerB.productionUnitId, buyerB],
      ]),
    };
    const buyB: MarketIntent = {
      ...f.buy, id: createMarketIntentId("mi:m5:multiregion:buy-b"),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: buyerB.productionUnitId },
      regionId: otherRegion.regionId, desiredQuantity: 2, maxSpend: 30,
      sourcePlanId: "plan:m5:multiregion:buy-b",
    };
    const sellB: MarketIntent = {
      ...f.sell, id: createMarketIntentId("mi:m5:multiregion:sell-b"),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: sellerB.productionUnitId },
      regionId: otherRegion.regionId, desiredQuantity: 1,
      sourcePlanId: "plan:m5:multiregion:sell-b",
    };
    const execute = (
      productionIntents: MarketIntent[],
      candidateWorld: WorldState = world,
    ) => {
      const planning: PhaseHandler = (_world, context) => context.phase === 2
        ? { ...context, productionMarketIntents: productionIntents, householdMarketIntents: [] }
        : context.phase === 5
          ? { ...context, productionMarketIntents: [...context.productionMarketIntents!, f.phase5Offer] }
          : context;
      const bridge = createM5SettledPhase4Bridge(
        planning, (_phase, current) => current, f.options, "MULTI_REGION",
      );
      return executeM5CanonicalIntakeTradeTick(
        candidateWorld, 7, bridge.handler, bridge.applyPhaseTransition,
        () => null,
        undefined, undefined, undefined, undefined, f.options.priceConfig,
      );
    };
    const first = execute([f.buy, sellB, buyB, f.sell]);
    const shuffled = execute([sellB, f.sell, f.buy, buyB]);
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    expect(first.reconciliationErrors).toBeNull();
    expect(first.context.phase4MarketAllocations).toHaveLength(2);
    expect(new Set(first.context.phase4MarketAllocations!.map(a => a.id)).size).toBe(2);
    expect(new Set(first.context.phase4MarketAllocations!.map(a => a.marketCurrencyId)))
      .toEqual(new Set([f.currency, otherRegion.settlementCurrencyId]));
    expect(first.world.productionUnits.get(f.buyer.productionUnitId)!.inputInventory.get(GOOD)).toBe(2);
    expect(first.world.productionUnits.get(f.seller.productionUnitId)!.outputInventory.get(GOOD)).toBe(1);
    expect(first.world.productionUnits.get(buyerB.productionUnitId)!.inputInventory.get(GOOD)).toBe(1);
    expect(first.world.productionUnits.get(sellerB.productionUnitId)!.outputInventory.get(GOOD)).toBe(3);
    expect(first.world.productionUnits.get(buyerB.productionUnitId)!.wallet.get(otherRegion.settlementCurrencyId)).toBe(27);
    expect(first.world.productionUnits.get(sellerB.productionUnitId)!.wallet.get(otherRegion.settlementCurrencyId)).toBe(8);
    expect(first.world.productionUnits.get(f.buyer.productionUnitId)!.wallet.get(f.currency)).toBe(26);
    expect(first.world.productionUnits.get(f.seller.productionUnitId)!.wallet.get(f.currency)).toBe(9);
    expect(first.context.phase4MarketAllocations).toEqual(shuffled.context.phase4MarketAllocations);
    expect(first.world.productionUnits).toEqual(shuffled.world.productionUnits);
    expect(first.context.marketPrices).toEqual(shuffled.context.marketPrices);
    expect(world.productionUnits.get(buyerB.productionUnitId)!.inputInventory.get(GOOD)).toBe(0);
    expect(world.productionUnits.get(sellerB.productionUnitId)!.outputInventory.get(GOOD)).toBe(4);

    // Two distinct markets cannot spoof actor location or reuse one intent ID.
    expect(() => execute([f.buy, f.sell, { ...buyB, regionId: f.region.regionId }, sellB]))
      .toThrow(/ownership\/Region mismatch/);
    expect(() => execute([f.buy, f.sell, { ...buyB, id: f.buy.id }, sellB]))
      .toThrow(/duplicate MarketIntent ID/);
    // The second market's unfunded transaction refuses the entire tick;
    // the original world and the first region's stocks are still unchanged.
    const insolvent = {
      ...world, productionUnits: new Map(world.productionUnits).set(
        buyerB.productionUnitId, {
          ...buyerB, wallet: new Map(buyerB.wallet).set(otherRegion.settlementCurrencyId, 1),
        },
      ),
    };
    expect(() => execute([f.buy, f.sell, buyB, sellB], insolvent))
      .toThrow(/executeAllocation:|preflight failed/);
    expect(insolvent.productionUnits.get(f.seller.productionUnitId)!.outputInventory.get(GOOD)).toBe(3);
    expect(insolvent.productionUnits.get(buyerB.productionUnitId)!.inputInventory.get(GOOD)).toBe(0);
  });

});
