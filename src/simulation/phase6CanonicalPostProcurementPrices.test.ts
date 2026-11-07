import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { computeEffectiveDemand, createMarketAllocationId, type MarketAllocation } from "./marketClearing";
import { repriceGoodInPhase6 } from "./marketPricing";
import {
  createPhase6CanonicalPostProcurementPriceHandler,
} from "./phase6CanonicalPostProcurementPrices";
import {
  marketPriceKey, ZERO_EXPECTATION, type Phase6PriceConfig,
} from "./phase6MarketPriceFormation";
import { executeM5CanonicalIntakeTradeTick } from "./m5LiveQuotedTradeTick";
import { derivePhase7PostProcurementIntents } from "./phase7PostProcurementIntents";
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
    const epsilon = f.world.simulationConfig.numeric.quantityEpsilon;
    if (epsilon === undefined) throw new Error("Canonical numeric epsilon missing");
    const expected = repriceGoodInPhase6(
      originalPrice,
      computeEffectiveDemand(
        f.buyer, originalPrice, epsilon,
      ),
      f.seller.desiredQuantity, f.seller.desiredQuantity,
      f.market.expectationsByGood.get(f.goodId) ?? ZERO_EXPECTATION,
      epsilon, priceConfig,
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

  it("prices residual Phase-4 INPUT procurement alongside a Phase-5 OUTPUT offer in one full tick", () => {
    const f = fixture();
    const state = [...f.world.states.values()][0]!;
    const inputBuyer: MarketIntent = {
      ...f.buyer, id: createMarketIntentId("mi:m5:phase6:input"),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: f.unit.productionUnitId },
      purpose: "INPUT", inventoryBucket: "INPUT",
      desiredQuantity: 5, maxSpend: 30,
    };
    const preProductionSeller: MarketIntent = {
      ...f.seller, id: createMarketIntentId("mi:m5:phase6:pre-seller"),
      actor: { type: "STATE", stateId: state.stateId },
      inventoryBucket: "GENERAL", desiredQuantity: 6, minimumReserveQuantity: 0,
    };
    const allocation: MarketAllocation = {
      id: createMarketAllocationId("ma:m5:phase6:realized"),
      marketId: f.market.marketId, regionId: f.region.regionId, goodId: f.goodId,
      pass: "PRE_PRODUCTION", buyerIntentId: inputBuyer.id,
      sellerIntentId: preProductionSeller.id,
      buyer: inputBuyer.actor, seller: preProductionSeller.actor,
      quantity: 2, sellerNetUnitPrice: 2, buyerGrossUnitPrice: 2,
      marketCurrencyId: f.region.settlementCurrencyId,
      consumptionTaxAmount: 0, destinationStateId: f.region.controllerStateId,
      buyerInventoryBucket: "INPUT", sellerInventoryBucket: "GENERAL",
    };
    const plans: PhaseHandler = (_world, context) => {
      if (context.phase === 2) {
        return {
          ...context, productionMarketIntents: [inputBuyer, preProductionSeller],
          householdMarketIntents: [f.buyer],
        };
      }
      if (context.phase === 4) {
        return { ...context, phase4MarketAllocations: [allocation] };
      }
      if (context.phase === 5) {
        return {
          ...context, productionMarketIntents: [
            ...context.productionMarketIntents!, f.seller,
          ],
        };
      }
      return context;
    };
    const priorPrice = f.market.priceByGood.get(f.goodId)!;
    const epsilon = f.world.simulationConfig.numeric.quantityEpsilon;
    if (epsilon === undefined) throw new Error("Canonical numeric epsilon missing");
    // Two units were actually procured at gross cost 4. Price formation
    // must use the remaining INPUT 3 / budget 26, not the opening 5 / 30.
    const remainingInput = { ...inputBuyer, desiredQuantity: 3, maxSpend: 26 };
    const expected = repriceGoodInPhase6(
      priorPrice,
      computeEffectiveDemand(f.buyer, priorPrice, epsilon) +
        computeEffectiveDemand(remainingInput, priorPrice, epsilon),
      6, 6, // Residual PRE_PRODUCTION stock 4 + new Phase-5 OUTPUT offer 2.
      f.market.expectationsByGood.get(f.goodId) ?? ZERO_EXPECTATION,
      epsilon, priceConfig,
    );
    const run = () => executeM5CanonicalIntakeTradeTick(
      f.world, 7,
      composePhaseHandlers(
        plans, createPhase6CanonicalPostProcurementPriceHandler(priceConfig),
      ),
      (_phase, world) => world,
      (world, context) => {
        const remaining = derivePhase7PostProcurementIntents(world, context);
        const byId = new Map(remaining.phase8MainIntents.map(intent => [intent.id, intent]));
        expect(byId.get(inputBuyer.id)?.desiredQuantity).toBe(3);
        expect(byId.get(inputBuyer.id)?.maxSpend).toBe(26);
        expect(byId.get(preProductionSeller.id)?.desiredQuantity).toBe(4);
        expect(byId.get(f.seller.id)?.desiredQuantity).toBe(2);
        return null; // No Phase-7 trade offer, no invented shipment.
      },
    );
    const first = run();
    const second = run();
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    expect(first.phaseBoundaryError).toBeUndefined();
    expect(first.reconciliationErrors).toBeNull();
    expect(first.context.phase4MarketAllocations).toEqual([allocation]);
    expect(first.context.marketPrices.get(marketPriceKey(f.market.marketId, f.goodId)))
      .toBe(expected);
    expect(second.context.marketPrices).toEqual(first.context.marketPrices);
    expect(f.market.priceByGood.get(f.goodId)).toBe(priorPrice);
    expect(inputBuyer.desiredQuantity).toBe(5);
    expect(inputBuyer.maxSpend).toBe(30);
    expect(preProductionSeller.desiredQuantity).toBe(6);
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
