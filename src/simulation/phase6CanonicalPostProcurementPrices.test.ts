import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { computeEffectiveDemand } from "./marketClearing";
import { repriceGoodInPhase6 } from "./marketPricing";
import {
  createPhase6CanonicalPostProcurementPriceHandler,
} from "./phase6CanonicalPostProcurementPrices";
import {
  marketPriceKey, ZERO_EXPECTATION, type Phase6PriceConfig,
} from "./phase6MarketPriceFormation";
import { executeM5CanonicalIntakeTradeTick } from "./m5LiveQuotedTradeTick";
import { composePhaseHandlers, type PhaseHandler } from "./tickOrchestrator";
import { buildInitialWorld } from "./worldState";

const priceConfig: Phase6PriceConfig = {
  shortageSignalWeight: 0.65,
  inventorySignalWeight: 0.35,
  basePriceAdjustmentSpeed: 0.12,
  maxAbsoluteLogPriceMovePerTick: 0.18,
  targetInventoryCoverageTicks: 1,
  minimumPrice: 0.001,
  maximumPrice: 1_000_000,
};

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const unit = [...world.productionUnits.values()].find(candidate => {
    const region = [...world.regions.values()].find(r => r.seed.key === candidate.seed.regionKey);
    const market = [...world.markets.values()].find(m => m.seed.regionKey === region?.seed.key);
    return region !== undefined && market !== undefined &&
      [...market.priceByGood.values()].some(price => Number.isFinite(price) && price > 0) &&
      [...world.cohorts.values()].some(c => c.seed.regionKey === region.seed.key);
  })!;
  const region = [...world.regions.values()].find(r => r.seed.key === unit.seed.regionKey)!;
  const market = [...world.markets.values()].find(m => m.seed.regionKey === region.seed.key)!;
  const goodId = [...market.priceByGood].find(([, price]) =>
    Number.isFinite(price) && price > 0)![0] as GoodId;
  const cohort = [...world.cohorts.values()].find(c => c.seed.regionKey === region.seed.key)!;
  const seller: MarketIntent = {
    id: createMarketIntentId("mi:m5:canonical-phase6:offer"),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId },
    regionId: region.regionId, goodId,
    side: "SELL", purpose: "INVENTORY_REBALANCE",
    desiredQuantity: 2, minimumReserveQuantity: 0,
    inventoryBucket: "OUTPUT", sourcePlanId: "plan:m5:canonical-phase6:offer",
  };
  const buyer: MarketIntent = {
    id: createMarketIntentId("mi:m5:canonical-phase6:demand"),
    actor: { type: "COHORT", cohortId: cohort.cohortId },
    regionId: region.regionId, goodId,
    side: "BUY", purpose: "CONSUMPTION",
    desiredQuantity: 3, maxSpend: 1000,
    sourcePlanId: "plan:m5:canonical-phase6:demand",
  };
  const plans: PhaseHandler = (_world, context) => {
    if (context.phase === 2) {
      return { ...context, productionMarketIntents: [seller], householdMarketIntents: [buyer] };
    }
    if (context.phase === 4) return { ...context, phase4MarketAllocations: [] };
    return context;
  };
  return { world, unit, region, market, goodId, seller, buyer, plans };
}

describe("M5 #673 Phase-6 owner-authoritative post-procurement price formation", () => {
  it("reprices from the same current-tick Phase-2/4/5 residuals used by Phase-7", () => {
    const f = fixture();
    const originalPrice = f.market.priceByGood.get(f.goodId)!;
    const expected = repriceGoodInPhase6(
      originalPrice,
      computeEffectiveDemand(
        f.buyer, originalPrice, f.world.simulationConfig.numeric.quantityEpsilon,
      ),
      f.seller.desiredQuantity, f.seller.desiredQuantity,
      f.market.expectationsByGood.get(f.goodId) ?? ZERO_EXPECTATION,
      f.world.simulationConfig.numeric.quantityEpsilon, priceConfig,
    );
    const run = () => executeM5CanonicalIntakeTradeTick(
      f.world, 7,
      composePhaseHandlers(
        f.plans, createPhase6CanonicalPostProcurementPriceHandler(priceConfig),
      ),
      (_phase, world) => world,
      () => null,
    );
    const result = run();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.context.marketPrices.get(marketPriceKey(f.market.marketId, f.goodId)))
      .toBe(expected);
    expect(run().context.marketPrices).toEqual(result.context.marketPrices);
    expect(f.market.priceByGood.get(f.goodId)).toBe(originalPrice);
    expect(f.world.shipments?.size ?? 0).toBe(0);
  });

  it("refuses to reprice when current-tick Phase-4 allocation evidence is missing", () => {
    const f = fixture();
    const noPhase4: PhaseHandler = (_world, context) => context.phase === 2
      ? { ...context, productionMarketIntents: [f.seller], householdMarketIntents: [f.buyer] }
      : context;
    expect(() => executeM5CanonicalIntakeTradeTick(
      f.world, 7,
      composePhaseHandlers(
        noPhase4, createPhase6CanonicalPostProcurementPriceHandler(priceConfig),
      ),
      (_phase, world) => world,
      () => null,
    )).toThrow("Phase-6 intake requires complete same-tick Phase-2/4/5 evidence");
    expect(f.world.shipments?.size ?? 0).toBe(0);
  });

  it("refuses a missing persisted prior-close price rather than using synthetic 10", () => {
    const f = fixture();
    const prices = new Map(f.market.priceByGood);
    prices.delete(f.goodId);
    const world = {
      ...f.world,
      markets: new Map(f.world.markets).set(f.market.marketId, {
        ...f.market, priceByGood: prices,
      }),
    };
    expect(() => executeM5CanonicalIntakeTradeTick(
      world, 7,
      composePhaseHandlers(
        f.plans, createPhase6CanonicalPostProcurementPriceHandler(priceConfig),
      ),
      (_phase, current) => current,
      () => null,
    )).toThrow("Phase-6 canonical intake requires a finite positive prior-close net price");
    expect(world.shipments?.size ?? 0).toBe(0);
  });
});
