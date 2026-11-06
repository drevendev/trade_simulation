import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { buildInitialWorld, type WorldState } from "./worldState";
import type { PhaseHandler } from "./tickOrchestrator";
import type { Phase7FrozenDirectedTradePermissions } from "./phase7AuthorizedRouteDiscovery";
import {
  executeM5CanonicalIntakeTradeTick, executeM5LiveQuotedTradeTick,
  type Phase7CanonicalIntakeTickRequest, type Phase7LiveTickRequest,
} from "./m5LiveQuotedTradeTick";

const FOOD = "good:food" as GoodId;
const unchanged = (_phase: number, world: WorldState) => world;
function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 79,
  );
  const jurisdiction = new Map([...world.regions].map(
    ([id, region]) => [id, region.controllerStateId] as const));
  const link = [...world.transportLinks.values()].find(l =>
    world.regions.get(l.fromRegionId)?.controllerStateId !==
    world.regions.get(l.toRegionId)?.controllerStateId);
  if (!link || !world.definitionRegistry.goods[FOOD]?.tradable)
    throw new Error("baseline must have a border and tradable food");
  const phase1: PhaseHandler = (_world, context) => context.phase === 1
    ? { ...context, effectiveJurisdictionByRegion: jurisdiction }
    : context;
  return { world, link, phase1 };
}
function request(permissions?: Phase7FrozenDirectedTradePermissions): Phase7CanonicalIntakeTickRequest {
  return {
    policy: {},
    plan: {
      opportunityQuotes: [], eligibleDirectedLinkIdsAtPhase1: new Set(),
      infrastructureFactors: new Map(), scorePolicy: {
        tradeProfitWeight: 1, shortageWeight: 1,
        minimumTradeScore: 0, maximumShortagePremiumShare: 0,
      },
    },
    dispatch: { autoReserveFx: true },
    authorizedRouteDiscovery: {
      autoGenerateCanonicalRouteQuotes: true,
      ...(permissions === undefined ? {} : { permissions }),
    },
  };
}
describe("M5 #673 captured directed trade law through the 16-phase tick", () => {
  it("carries deterministic after-activation permission evidence without creating goods or money", () => {
    const f = fixture();
    const calls: string[] = [];
    const run = () => executeM5CanonicalIntakeTradeTick(
      f.world, 12, f.phase1, unchanged,
      (_world, context) => {
        expect(context.phase).toBe(7);
        expect(context.phase1DirectedTradePermissions?.tick).toBe(12);
        expect(context.phase1DirectedTradePermissions?.permittedGoodsByDirectedLink
          .get(f.link.linkId)?.get(FOOD)).toBeNull();
        return null;
      },
      undefined, undefined,
      query => {
        calls.push(JSON.stringify([query.linkId, query.goodId]));
        expect(query.tick).toBe(12);
        expect(query.originRegionId).toBe(f.world.transportLinks.get(query.linkId)!.fromRegionId);
        return query.goodId === FOOD ? null : undefined;
      },
    );
    const first = run();
    const firstCalls = [...calls];
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    expect(first.reconciliationErrors).toBeNull();
    expect(first.world).toBe(f.world);
    expect(first.context.transactions).toEqual([]);
    expect(new Set(firstCalls).size).toBe(firstCalls.length);
    const replay = run();
    expect(replay.context.phase1DirectedTradePermissions)
      .toEqual(first.context.phase1DirectedTradePermissions);
    expect(calls.slice(firstCalls.length)).toEqual(firstCalls);
  });

  it("preserves absent legal permission as absent, not an implicit grant", () => {
    const f = fixture();
    const result = executeM5CanonicalIntakeTradeTick(
      f.world, 12, f.phase1, unchanged,
      (_world, context) => {
        expect(context.phase1DirectedTradePermissions?.permittedGoodsByDirectedLink.size).toBe(0);
        return null;
      },
      undefined, undefined, () => undefined,
    );
    expect(result.world.shipments?.size).toBe(0);
  });

  it("rejects caller law substitution and discovery bypass before route preparation", () => {
    const f = fixture();
    const forged = request({
      tick: 12,
      permittedGoodsByDirectedLink: new Map([
        [f.link.linkId, new Map([[FOOD, 100000]])],
      ]),
    });
    expect(() => executeM5CanonicalIntakeTradeTick(
      f.world, 12, f.phase1, unchanged,
      () => forged, undefined, undefined, () => null,
    )).toThrow("Caller cannot replace captured Phase-1 trade permissions");
    expect(() => executeM5CanonicalIntakeTradeTick(
      f.world, 12, f.phase1, unchanged,
      () => ({ ...request(), authorizedRouteDiscovery: undefined }),
      undefined, undefined, () => null,
    )).toThrow("requires canonical route discovery");
  });

  it("rejects later handler tampering with a nested permission Map before Phase-7 request", () => {
    const f = fixture();
    const forgedHandler: PhaseHandler = (world, context, pending) => {
      const activated = f.phase1(world, context, pending);
      if (context.phase !== 2 || !activated.phase1DirectedTradePermissions) return activated;
      const copy = new Map(activated.phase1DirectedTradePermissions.permittedGoodsByDirectedLink);
      copy.set(f.link.linkId, new Map([[FOOD, 999]]));
      return { ...activated, phase1DirectedTradePermissions: {
        tick: context.tick, permittedGoodsByDirectedLink: copy,
      }};
    };
    let reached = false;
    expect(() => executeM5CanonicalIntakeTradeTick(
      f.world, 12, forgedHandler, unchanged,
      () => { reached = true; return null; },
      undefined, undefined, () => null,
    )).toThrow("unmodified current-tick Phase-1 trade permissions");
    expect(reached).toBe(false);
  });

  it("fails in Phase 1 for invalid legal caps, even without any trade request", () => {
    const f = fixture();
    let reached = false;
    expect(() => executeM5CanonicalIntakeTradeTick(
      f.world, 12, f.phase1, unchanged,
      () => { reached = true; return null; },
      undefined, undefined, () => -0.1,
    )).toThrow("finite nonnegative legal cap");
    expect(reached).toBe(false);
  });

  it("refuses direct live quotes for routes denied by the captured law", () => {
    const f = fixture();
    const direct: Phase7LiveTickRequest = {
      policy: {},
      plan: {
        opportunityQuotes: [{
          planId: "plan:forbidden", linkId: f.link.linkId,
          originRegionId: f.link.fromRegionId, destinationRegionId: f.link.toRegionId,
          goodId: FOOD, authorizedAtPhase1: true, cargoWeightPerUnit: 1,
          destinationReferenceGrossUnitPrice: 1, landedGrossUnitCostDest: 1,
          estimatedTransportUnitCostDest: 0, estimatedTariffRate: 0,
          estimatedFxInputPerSourceCurrency: 1, shortageRateDestination: 0,
        }],
        residualIntents: [], fxOutputByPairCurrency: new Map(),
        fxPairIdByTradePlanId: new Map(),
        eligibleDirectedLinkIdsAtPhase1: new Set([f.link.linkId]),
        infrastructureFactors: new Map(),
        scorePolicy: {
          tradeProfitWeight: 1, shortageWeight: 1,
          minimumTradeScore: 0, maximumShortagePremiumShare: 0,
        },
      },
      dispatch: {
        autoReserveFx: true, remainingCargoWeightByLink: new Map(),
        phase8MainIntents: [],
      },
    };
    expect(() => executeM5LiveQuotedTradeTick(
      f.world, 12, f.phase1, unchanged,
      () => direct, undefined, undefined, () => undefined,
    )).toThrow("lacks captured Phase-1 directed trade permission");
    expect(f.world.shipments?.size).toBe(0);
  });
});
