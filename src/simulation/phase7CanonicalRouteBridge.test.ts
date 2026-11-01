import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { buildInitialWorld } from "./worldState";
import { bindPhase7DiscoveredRouteQuotes } from "./phase7CanonicalRouteBridge";
import type { Phase7FrozenDirectedTradePermissions } from "./phase7AuthorizedRouteDiscovery";
import type { Phase7LiveQuoteWithoutMarketNetPrices } from "./phase7LiveWorldPlan";
import type { Phase7ActorResidualIntent } from "./phase7IntentMatching";
import type { TickContext } from "./tickOrchestrator";

const WOOD = "good:wood" as GoodId;

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 71,
  );
  const link = [...world.transportLinks.values()].find(candidate => {
    const source = world.regions.get(candidate.fromRegionId);
    const target = world.regions.get(candidate.toRegionId);
    return source && target && source.controllerStateId && target.controllerStateId &&
      [...world.cohorts.values()].some(c => c.seed.regionKey === source.seed.key) &&
      [...world.cohorts.values()].some(c => c.seed.regionKey === target.seed.key) &&
      candidate.seed.baseCapacity > 1 && candidate.seed.condition > 0.05;
  });
  if (!link) throw new Error("baseline requires directed cohort-to-cohort route");
  const source = world.regions.get(link.fromRegionId)!;
  const dest = world.regions.get(link.toRegionId)!;
  const seller = [...world.cohorts.values()].find(c => c.seed.regionKey === source.seed.key)!;
  const buyer = [...world.cohorts.values()].find(c => c.seed.regionKey === dest.seed.key)!;
  const sell: MarketIntent = {
    id: createMarketIntentId("mi:bridge:s"), actor: { type: "COHORT", cohortId: seller.cohortId },
    regionId: source.regionId, goodId: WOOD, side: "SELL",
    purpose: "INVENTORY_REBALANCE", desiredQuantity: 6,
    minimumReserveQuantity: 0, sourcePlanId: "bridge:s",
  };
  const buy: MarketIntent = {
    id: createMarketIntentId("mi:bridge:b"), actor: { type: "COHORT", cohortId: buyer.cohortId },
    regionId: dest.regionId, goodId: WOOD, side: "BUY",
    purpose: "CONSUMPTION", desiredQuantity: 5, maxSpend: 100,
    sourcePlanId: "bridge:b",
  };
  const residual: readonly Phase7ActorResidualIntent[] = [
    { intent: sell, residualQuantity: 6 },
    { intent: buy, residualQuantity: 5, remainingBuyerSpend: 80 },
  ];
  const context: Pick<TickContext, "tick" | "phase" | "effectiveJurisdictionByRegion"> = {
    tick: 17, phase: 7,
    effectiveJurisdictionByRegion: new Map([...world.regions].map(
      ([id, region]) => [id, region.controllerStateId] as const)),
  };
  const permissions = (cap: number | null): Phase7FrozenDirectedTradePermissions => ({
    tick: 17, permittedGoodsByDirectedLink: new Map([
      [link.linkId, new Map<GoodId, number | null>([[WOOD, cap]])],
    ]),
  });
  const factors = new Map<TransportLinkId, number>([[link.linkId, 1]]);
  const quote: Phase7LiveQuoteWithoutMarketNetPrices = {
    planId: JSON.stringify(["m5:route", link.linkId, WOOD]),
    linkId: link.linkId, originRegionId: source.regionId,
    destinationRegionId: dest.regionId, goodId: WOOD,
    authorizedAtPhase1: false, cargoWeightPerUnit: 0.001,
    legalQuantityCap: 1000, destinationReferenceGrossUnitPrice: 0.0001,
    landedGrossUnitCostDest: 0.0001, estimatedTransportUnitCostDest: 0,
    estimatedTariffRate: 0, estimatedFxInputPerSourceCurrency: 0.001,
    shortageRateDestination: 0.4,
  };
  const bind = (
    proposed: readonly Phase7LiveQuoteWithoutMarketNetPrices[] = [quote],
    legal = permissions(2), ctx = context,
  ) => bindPhase7DiscoveredRouteQuotes(
    world, ctx, residual, legal, factors, proposed,
  );
  return { world, link, quote, residual, context, permissions, factors, bind };
}

describe("M5 #673 canonical Phase-1 route discovery binds live Phase-7 intake", () => {
  it("overwrites forged legal flags, cargo mass and caps with current-tick owner evidence", () => {
    const f = fixture();
    const before = f.world.shipments;
    const result = f.bind();
    expect(result.opportunityQuotes).toHaveLength(1);
    expect(result.opportunityQuotes[0]).toMatchObject({
      ...f.quote,
      shortageRateDestination: 1,
      authorizedAtPhase1: true,
      legalQuantityCap: 2,
      cargoWeightPerUnit: f.world.definitionRegistry.goods[WOOD]!.cargoWeightPerUnit,
    });
    expect([...result.eligibleDirectedLinkIdsAtPhase1]).toEqual([f.link.linkId]);
    expect(f.world.shipments).toBe(before);
    expect(f.quote.authorizedAtPhase1).toBe(false);
    expect(f.quote.legalQuantityCap).toBe(1000);
    expect(f.residual[0]!.residualQuantity).toBe(6);
  });

  it("removes a stale caller cap when frozen Phase-1 policy has no quantity ceiling", () => {
    const f = fixture();
    const out = f.bind([f.quote], f.permissions(null));
    expect(out.opportunityQuotes[0]).not.toHaveProperty("legalQuantityCap");
    expect(out.opportunityQuotes[0]!.authorizedAtPhase1).toBe(true);
  });

  it("rejects an omitted, duplicate, mismatched or unauthorized candidate before spending", () => {
    const f = fixture();
    expect(() => f.bind([])).toThrow("complete discovered route/good");
    expect(() => f.bind([f.quote, f.quote])).toThrow("duplicate");
    expect(() => f.bind([{ ...f.quote, originRegionId: f.quote.destinationRegionId }]))
      .toThrow("does not match authorized");
    expect(() => f.bind([f.quote], {
      tick: 17, permittedGoodsByDirectedLink: new Map(),
    })).toThrow("complete discovered route/good");
    expect(f.world.shipments?.size).toBe(0);
  });

  it("refuses stale permissions and overwrites forged shortage scoring evidence", () => {
    const f = fixture();
    expect(() => f.bind([f.quote], { ...f.permissions(2), tick: 16 }))
      .toThrow("current frozen Phase-1");
    for (const forged of [Number.NaN, -1, 2, Number.POSITIVE_INFINITY]) {
      expect(f.bind([{ ...f.quote, shortageRateDestination: forged }])
        .opportunityQuotes[0]!.shortageRateDestination).toBe(1);
    }
    expect(f.quote.shortageRateDestination).toBe(0.4);
    expect(f.world.shipments?.size).toBe(0);
  });
});
