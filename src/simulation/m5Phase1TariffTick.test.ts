import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { buildInitialWorld, type WorldState } from "./worldState";
import type { PhaseHandler } from "./tickOrchestrator";
import {
  executeM5CanonicalIntakeTradeTick, executeM5LiveQuotedTradeTick,
  type Phase7LiveTickRequest,
} from "./m5LiveQuotedTradeTick";
import {
  derivePhase7Phase1ImportTariffs, phase7ImportTariffKey,
  type Phase7LiveQuoteWithoutMarketNetPrices,
} from "./phase7LiveWorldPlan";

const GOOD = "good:food" as GoodId;
const unchanged = (_phase: number, world: WorldState) => world;

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const jurisdictions = new Map(
    [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
  );
  const link = [...world.transportLinks.values()].find(candidate => {
    const origin = world.regions.get(candidate.fromRegionId)!;
    const destination = world.regions.get(candidate.toRegionId)!;
    return destination.controllerStateId !== null &&
      destination.controllerStateId !== origin.controllerStateId;
  });
  if (!link || !world.definitionRegistry.goods[GOOD]?.tradable) {
    throw new Error("baseline must contain an authorized border and tradable food");
  }
  const destination = world.regions.get(link.toRegionId)!;
  const key = phase7ImportTariffKey(destination.controllerStateId!, GOOD);
  const quote: Phase7LiveQuoteWithoutMarketNetPrices = {
    planId: "plan:phase1-tariff-tick",
    linkId: link.linkId,
    originRegionId: link.fromRegionId,
    destinationRegionId: link.toRegionId,
    goodId: GOOD,
    authorizedAtPhase1: true,
    cargoWeightPerUnit: 1,
    destinationReferenceGrossUnitPrice: 10,
    landedGrossUnitCostDest: 8,
    estimatedTransportUnitCostDest: 1,
    estimatedTariffRate: 999,
    estimatedFxInputPerSourceCurrency: 1,
    shortageRateDestination: 0.1,
  };
  const phase1: PhaseHandler = (_world, context) => context.phase === 1
    ? { ...context, effectiveJurisdictionByRegion: jurisdictions }
    : context;
  return { world, jurisdictions, key, quote, phase1 };
}

describe("M5 #673 Phase-1 tariff authority through canonical 16-phase tick", () => {
  it("captures after activation and carries the rate to Phase 7 instead of caller quote", () => {
    const f = fixture();
    const calls: string[] = [];
    const run = () => executeM5LiveQuotedTradeTick(
      f.world, 7, f.phase1, unchanged,
      (world, context) => {
        expect(context.phase).toBe(7);
        expect(context.phase1ImportTariffs?.tick).toBe(7);
        const derived = derivePhase7Phase1ImportTariffs(world, context, [f.quote]);
        expect(derived[0]?.estimatedTariffRate).toBe(0.125);
        expect(f.quote.estimatedTariffRate).toBe(999);
        return null;
      },
      undefined,
      query => {
        calls.push(phase7ImportTariffKey(query.destinationStateId, query.goodId));
        expect(query.tick).toBe(7);
        return query.goodId === GOOD ? 0.125 : undefined;
      },
    );
    const actual = run();
    const firstCalls = [...calls];
    expect(actual.phaseTrace).toEqual([...Array(16).keys()]);
    expect(actual.phaseBoundaryError).toBeUndefined();
    expect(actual.reconciliationErrors).toBeNull();
    expect(actual.context.phase1ImportTariffs?.ratesByDestinationStateGood.get(f.key))
      .toBe(0.125);
    expect(actual.world).toBe(f.world);
    expect(actual.context.transactions).toEqual([]);
    expect(f.world.shipments?.size).toBe(0);
    expect(new Set(firstCalls).size).toBe(firstCalls.length);
    const replay = run();
    expect(replay.context.phase1ImportTariffs).toEqual(actual.context.phase1ImportTariffs);
    expect(calls.slice(firstCalls.length)).toEqual(firstCalls);
  });

  it("keeps missing policy missing and fails before a trade can use it", () => {
    const f = fixture();
    let consulted = false;
    expect(() => executeM5LiveQuotedTradeTick(
      f.world, 7, f.phase1, unchanged,
      (world, context) => {
        consulted = true;
        expect(context.phase1ImportTariffs?.ratesByDestinationStateGood.has(f.key))
          .toBe(false);
        derivePhase7Phase1ImportTariffs(world, context, [f.quote]);
        return null;
      },
      undefined, () => undefined,
    )).toThrow("missing destination State/good policy rate");
    expect(consulted).toBe(true);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("refuses a later handler's forged Phase-1 snapshot before consulting the Phase-7 builder", () => {
    const f = fixture();
    const corrupt: PhaseHandler = (world, context, pending) => {
      const authorized = f.phase1(world, context, pending);
      if (context.phase !== 2) return authorized;
      return {
        ...authorized,
        phase1ImportTariffs: {
          tick: 7,
          ratesByDestinationStateGood: new Map([[f.key, 0.99]]),
        },
      };
    };
    let built = false;
    expect(() => executeM5LiveQuotedTradeTick(
      f.world, 7, corrupt, unchanged,
      () => { built = true; return null; },
      undefined, query => query.goodId === GOOD ? 0.1 : undefined,
    )).toThrow("unmodified current-tick Phase-1 tariff evidence");
    expect(built).toBe(false);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects a caller-provided law snapshot when canonical Phase-1 capture is enabled", () => {
    const f = fixture();
    const forged: Phase7LiveTickRequest = {
      policy: {
        phase1ImportTariffs: {
          tick: 7,
          ratesByDestinationStateGood: new Map([[f.key, 0]]),
        },
      },
      plan: {
        opportunityQuotes: [], residualIntents: [],
        fxOutputByPairCurrency: new Map(), fxPairIdByTradePlanId: new Map(),
        eligibleDirectedLinkIdsAtPhase1: new Set(), infrastructureFactors: new Map(),
        scorePolicy: {
          tradeProfitWeight: 1, shortageWeight: 1,
          minimumTradeScore: 0, maximumShortagePremiumShare: 0,
        },
      },
      dispatch: {
        autoReserveFx: true,
        remainingCargoWeightByLink: new Map(),
        phase8MainIntents: [],
      },
    };
    expect(() => executeM5LiveQuotedTradeTick(
      f.world, 7, f.phase1, unchanged, () => forged,
      undefined, query => query.goodId === GOOD ? 0.1 : undefined,
    )).toThrow("cannot override captured Phase-1 tariffs");
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects an invalid law in Phase 1 even if Phase 7 would do no trade", () => {
    const f = fixture();
    let reachedPhase7 = false;
    expect(() => executeM5LiveQuotedTradeTick(
      f.world, 7, f.phase1, unchanged,
      () => { reachedPhase7 = true; return null; },
      undefined, () => -0.01,
    )).toThrow("finite nonnegative statutory rate");
    expect(reachedPhase7).toBe(false);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("forwards the same canonical capture through the auto-intake wrapper", () => {
    const f = fixture();
    let seen = 0;
    const result = executeM5CanonicalIntakeTradeTick(
      f.world, 7, f.phase1, unchanged,
      (_world, context) => {
        expect(context.phase).toBe(7);
        seen = context.phase1ImportTariffs?.ratesByDestinationStateGood.get(f.key) ?? -1;
        return null;
      },
      undefined, query => query.goodId === GOOD ? 0.2 : undefined,
    );
    expect(seen).toBe(0.2);
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.world).toBe(f.world);
  });
});
