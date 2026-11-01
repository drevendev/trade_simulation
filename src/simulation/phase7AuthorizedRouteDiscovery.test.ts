import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import type { Phase7ActorResidualIntent } from "./phase7IntentMatching";
import { effectiveTransportLinkCapacity } from "./transportCapacity";
import type { TickContext } from "./tickOrchestrator";
import { buildInitialWorld } from "./worldState";
import {
  discoverPhase7DirectedTradeOpportunities,
  type Phase7FrozenDirectedTradePermissions,
} from "./phase7AuthorizedRouteDiscovery";

const WOOD = "good:wood" as GoodId;
const FOOD = "good:food" as GoodId;

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 71,
  );
  const links = [...world.transportLinks.values()].sort((a, b) =>
    a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);
  const link = links.find(candidate => {
    const source = world.regions.get(candidate.fromRegionId);
    const target = world.regions.get(candidate.toRegionId);
    return source !== undefined && target !== undefined &&
      source.controllerStateId !== null && target.controllerStateId !== null &&
      [...world.cohorts.values()].some(c => c.seed.regionKey === source.seed.key) &&
      [...world.cohorts.values()].some(c => c.seed.regionKey === target.seed.key) &&
      candidate.seed.baseCapacity > 1 && candidate.seed.condition > 0.05;
  });
  if (!link) throw new Error("baseline must have one usable directed cohort-to-cohort link");
  const origin = world.regions.get(link.fromRegionId)!;
  const destination = world.regions.get(link.toRegionId)!;
  const sellerCohort = [...world.cohorts.values()]
    .find(c => c.seed.regionKey === origin.seed.key)!;
  const buyerCohort = [...world.cohorts.values()]
    .find(c => c.seed.regionKey === destination.seed.key)!;
  const seller: MarketIntent = {
    id: createMarketIntentId("mi:m5:discovery:seller"),
    actor: { type: "COHORT", cohortId: sellerCohort.cohortId },
    regionId: origin.regionId, goodId: WOOD, side: "SELL",
    purpose: "INVENTORY_REBALANCE", desiredQuantity: 6,
    minimumReserveQuantity: 0, sourcePlanId: "m5:discovery:seller",
  };
  const buyer: MarketIntent = {
    id: createMarketIntentId("mi:m5:discovery:buyer"),
    actor: { type: "COHORT", cohortId: buyerCohort.cohortId },
    regionId: destination.regionId, goodId: WOOD, side: "BUY",
    purpose: "CONSUMPTION", desiredQuantity: 5, maxSpend: 100,
    sourcePlanId: "m5:discovery:buyer",
  };
  const residuals: readonly Phase7ActorResidualIntent[] = [
    { intent: seller, residualQuantity: 6 },
    { intent: buyer, residualQuantity: 5, remainingBuyerSpend: 80 },
  ];
  const context: Pick<TickContext, "tick" | "phase" | "effectiveJurisdictionByRegion"> = {
    tick: 17, phase: 7,
    effectiveJurisdictionByRegion: new Map([...world.regions].map(
      ([id, region]) => [id, region.controllerStateId] as const)),
  };
  const permissions: Phase7FrozenDirectedTradePermissions = {
    tick: 17,
    permittedGoodsByDirectedLink: new Map<TransportLinkId, ReadonlyMap<GoodId, number | null>>([
      [link.linkId, new Map<GoodId, number | null>([[WOOD, null]])],
    ]),
  };
  const factors = new Map<TransportLinkId, number>([[link.linkId, 1]]);
  const discover = (
    entries = residuals, permit = permissions, factor = factors,
    current = context, currentWorld = world,
  ) => discoverPhase7DirectedTradeOpportunities(
    currentWorld, current, entries, permit, factor,
  );
  return { world, link, origin, destination, seller, buyer, residuals,
    context, permissions, factors, discover };
}

describe("M5 #673 Phase-1 authorized direct route opportunity discovery", () => {
  it("discovers a real directed link/good from Phase-4 residuals without spending or moving stock", () => {
    const f = fixture();
    const initialShipments = f.world.shipments;
    const discovered = f.discover();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      planId: JSON.stringify(["m5:route", f.link.linkId, WOOD]),
      linkId: f.link.linkId, originRegionId: f.origin.regionId,
      destinationRegionId: f.destination.regionId, goodId: WOOD,
      sourceResidualQuantity: 6, destinationResidualQuantity: 5,
      destinationRemainingBuyerSpend: 80,
      shortageRateDestination: 1,
      cargoWeightPerUnit: f.world.definitionRegistry.goods[WOOD]!.cargoWeightPerUnit,
    });
    expect(discovered[0]!.physicalQuantityCap).toBe(Math.min(
      6, 5, effectiveTransportLinkCapacity(f.link, 1) /
        f.world.definitionRegistry.goods[WOOD]!.cargoWeightPerUnit,
    ));
    expect(f.world.shipments).toBe(initialShipments);
    expect(f.seller.desiredQuantity).toBe(6);
    expect(f.buyer.maxSpend).toBe(100);
    expect(f.residuals[1]!.remainingBuyerSpend).toBe(80);
  });

  it("projects same-tick local shortfall without misreporting Phase-8 realized telemetry", () => {
    const f = fixture();
    const localSeller: MarketIntent = {
      ...f.seller, id: createMarketIntentId("mi:m5:local:seller"),
      actor: f.buyer.actor, regionId: f.destination.regionId,
      desiredQuantity: 3, sourcePlanId: "m5:local:seller",
    };
    const withLocalOffer: Phase7ActorResidualIntent[] = [
      ...f.residuals, { intent: localSeller, residualQuantity: 3 },
    ];
    const openingWorld = f.world;
    expect(f.discover()).toHaveLength(1);
    expect(f.discover()[0]!.shortageRateDestination).toBe(1);
    expect(f.discover(withLocalOffer)[0]!.shortageRateDestination).toBeCloseTo(0.4);
    expect(f.discover([
      ...f.residuals, { intent: { ...localSeller, desiredQuantity: 7 }, residualQuantity: 7 },
    ])[0]!.shortageRateDestination).toBe(0);
    expect(f.discover([...withLocalOffer].reverse())).toEqual(f.discover(withLocalOffer));
    expect(f.world).toBe(openingWorld);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("is deterministic across intent order and frozen legal Map insertion order", () => {
    const f = fixture();
    const secondSeller: MarketIntent = {
      ...f.seller, id: createMarketIntentId("mi:m5:discovery:food:seller"),
      goodId: FOOD, desiredQuantity: 3,
    };
    const secondBuyer: MarketIntent = {
      ...f.buyer, id: createMarketIntentId("mi:m5:discovery:food:buyer"),
      goodId: FOOD, desiredQuantity: 2, maxSpend: 40,
    };
    const entries: Phase7ActorResidualIntent[] = [
      ...f.residuals,
      { intent: secondSeller, residualQuantity: 3 },
      { intent: secondBuyer, residualQuantity: 2, remainingBuyerSpend: 40 },
    ];
    const permit = (goods: readonly GoodId[]): Phase7FrozenDirectedTradePermissions => ({
      tick: f.context.tick,
      permittedGoodsByDirectedLink: new Map([
        [f.link.linkId, new Map<GoodId, number | null>(goods.map(g => [g, null]))],
      ]),
    });
    const first = f.discover(entries, permit([WOOD, FOOD]));
    const reversed = f.discover([...entries].reverse(), permit([FOOD, WOOD]));
    expect(first).toEqual(reversed);
    expect(first.map(p => p.goodId)).toEqual([FOOD, WOOD]);
    expect(new Set(first.map(p => p.planId)).size).toBe(2);
  });

  it("fails closed for absent, stale, or forged Phase-1 route/good authorization", () => {
    const f = fixture();
    const empty: Phase7FrozenDirectedTradePermissions = {
      tick: 17, permittedGoodsByDirectedLink: new Map(),
    };
    expect(f.discover(f.residuals, empty)).toEqual([]);
    expect(() => f.discover(f.residuals, { ...f.permissions, tick: 16 }))
      .toThrow("current frozen Phase-1");
    const stale = {
      ...f.context, effectiveJurisdictionByRegion: new Map(
        f.context.effectiveJurisdictionByRegion),
    };
    stale.effectiveJurisdictionByRegion.set(f.origin.regionId, null);
    expect(() => f.discover(f.residuals, f.permissions, f.factors, stale))
      .toThrow("stale/invalid Phase-1 jurisdiction");
    expect(() => f.discover(f.residuals, f.permissions, new Map()))
      .toThrow("infrastructure factor");
  });

  it("obeys the explicit legal quantity cap, physical link condition and tradability", () => {
    const f = fixture();
    const withCap = (cap: number | null): Phase7FrozenDirectedTradePermissions => ({
      tick: 17, permittedGoodsByDirectedLink: new Map([
        [f.link.linkId, new Map<GoodId, number | null>([[WOOD, cap]])],
      ]),
    });
    expect(f.discover(f.residuals, withCap(0))).toEqual([]);
    const allowed = f.discover(f.residuals, withCap(0.001));
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.physicalQuantityCap).toBe(0.001);
    expect(allowed[0]!.legalQuantityCap).toBe(0.001);
    expect(() => f.discover(f.residuals, withCap(Number.NaN))).toThrow("legal quantity cap");
    expect(f.discover(f.residuals, f.permissions,
      new Map<TransportLinkId, number>([[f.link.linkId, 0]]))).toEqual([]);

    const def = f.world.definitionRegistry.goods[WOOD]!;
    const nontradable = {
      ...f.world, definitionRegistry: {
        ...f.world.definitionRegistry,
        goods: { ...f.world.definitionRegistry.goods, [WOOD]: { ...def, tradable: false } },
      },
    };
    expect(f.discover(f.residuals, f.permissions, f.factors, f.context, nontradable))
      .toEqual([]);
    const invalidWeight = {
      ...f.world, definitionRegistry: {
        ...f.world.definitionRegistry,
        goods: { ...f.world.definitionRegistry.goods, [WOOD]: { ...def, cargoWeightPerUnit: 0 } },
      },
    };
    expect(() => f.discover(f.residuals, f.permissions, f.factors, f.context, invalidWeight))
      .toThrow("positive canonical cargo weight");
  });

  it("excludes exhausted supply/demand/budget and rejects altered owner or residual accounting", () => {
    const f = fixture();
    expect(f.discover([{ ...f.residuals[0]!, residualQuantity: 0 }, f.residuals[1]!]))
      .toEqual([]);
    expect(f.discover([f.residuals[0]!, { ...f.residuals[1]!, remainingBuyerSpend: 0 }]))
      .toEqual([]);
    expect(() => f.discover([f.residuals[0]!, f.residuals[0]!, f.residuals[1]!]))
      .toThrow("duplicate residual intent ID");
    expect(() => f.discover([f.residuals[0]!,
      { ...f.residuals[1]!, remainingBuyerSpend: 101 }]))
      .toThrow("exceeds original BUY budget");
    expect(() => f.discover([f.residuals[0]!,
      { ...f.residuals[1]!, residualQuantity: 6 }]))
      .toThrow("exceeds original intent");
    expect(() => f.discover([f.residuals[0]!, {
      ...f.residuals[1]!,
      intent: { ...f.buyer, regionId: f.origin.regionId },
    }])).toThrow("Cohort/Region ownership mismatch");
  });

  it("refuses large binary64 sums that silently erase an additional real seller quantity", () => {
    const f = fixture();
    const enormous = {
      ...f.residuals[0]!,
      intent: { ...f.seller, desiredQuantity: 1e16 },
      residualQuantity: 1e16,
    };
    const additional = {
      ...f.residuals[0]!,
      intent: { ...f.seller, id: createMarketIntentId("mi:m5:discovery:z-extra"),
        desiredQuantity: 1 },
      residualQuantity: 1,
    };
    expect(() => f.discover([enormous, additional, f.residuals[1]!]))
      .toThrow("lost numeric precision");
  });
});
