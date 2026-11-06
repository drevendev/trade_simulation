import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { buildInitialWorld } from "./worldState";
import {
  derivePhase7Phase1ImportTariffs, phase7ImportTariffKey,
  type Phase7LiveQuoteWithoutMarketNetPrices,
} from "./phase7LiveWorldPlan";
import { capturePhase7ImportTariffsAtPhase1 } from "./phase7Phase1TariffCapture";

const GOOD = "good:food" as GoodId;

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const effectiveJurisdictionByRegion = new Map(
    [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
  );
  const phase1 = {
    tick: 7, phase: 1 as const, effectiveJurisdictionByRegion,
  };
  const crossBorder = [...world.transportLinks.values()]
    .filter(link => {
      const from = world.regions.get(link.fromRegionId)!;
      const to = world.regions.get(link.toRegionId)!;
      return to.controllerStateId !== null &&
        to.controllerStateId !== from.controllerStateId;
    })
    .sort((a, b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);
  if (crossBorder.length === 0 || !world.definitionRegistry.goods[GOOD]?.tradable) {
    throw new Error("baseline fixture requires a tradable food and a State border");
  }
  const link = crossBorder[0]!;
  const destination = world.regions.get(link.toRegionId)!;
  return { world, phase1, link, destination, crossBorder };
}

describe("M5 #673 Phase-1 canonical import-tariff capture", () => {
  it("freezes one explicit State/good law rate and hydrates a Phase-7 trade instead of caller rates", () => {
    const f = fixture();
    const calls: string[] = [];
    const snapshot = capturePhase7ImportTariffsAtPhase1(f.world, f.phase1, query => {
      calls.push(phase7ImportTariffKey(query.destinationStateId, query.goodId));
      expect(query.tick).toBe(7);
      return query.goodId === GOOD ? 0.125 : undefined;
    });
    const key = phase7ImportTariffKey(f.destination.controllerStateId!, GOOD);
    expect(snapshot.tick).toBe(7);
    expect(snapshot.ratesByDestinationStateGood.get(key)).toBe(0.125);
    // Multiple source links into the same State cannot produce multiple
    // contradictory tariffs or invoke a state-level provider repeatedly.
    expect(new Set(calls).size).toBe(calls.length);
    const quote: Phase7LiveQuoteWithoutMarketNetPrices = {
      planId: "plan:phase1:tariff:capture",
      linkId: f.link.linkId,
      originRegionId: f.link.fromRegionId,
      destinationRegionId: f.link.toRegionId,
      goodId: GOOD,
      authorizedAtPhase1: true,
      cargoWeightPerUnit: 1,
      destinationReferenceGrossUnitPrice: 2,
      landedGrossUnitCostDest: 1,
      estimatedTransportUnitCostDest: 1,
      estimatedTariffRate: 999,
      estimatedFxInputPerSourceCurrency: 1,
      shortageRateDestination: 0.25,
    };
    const context = {
      ...f.phase1, phase: 7 as const, marketPrices: new Map(),
      phase1ImportTariffs: snapshot,
    };
    const hydrated = derivePhase7Phase1ImportTariffs(f.world, context, [quote]);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.estimatedTariffRate).toBe(0.125);
    expect(quote.estimatedTariffRate).toBe(999);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("does not fabricate zero if the policy authority abstains", () => {
    const f = fixture();
    const snapshot = capturePhase7ImportTariffsAtPhase1(
      f.world, f.phase1, () => undefined,
    );
    expect(snapshot.ratesByDestinationStateGood.size).toBe(0);
    const key = phase7ImportTariffKey(f.destination.controllerStateId!, GOOD);
    expect(snapshot.ratesByDestinationStateGood.has(key)).toBe(false);
    const explicitZero = capturePhase7ImportTariffsAtPhase1(
      f.world, f.phase1, () => 0,
    );
    expect(explicitZero.ratesByDestinationStateGood.has(key)).toBe(true);
    expect(explicitZero.ratesByDestinationStateGood.get(key)).toBe(0);
  });

  it("rejects missing, stale and forged Phase-1 jurisdiction before consulting any policy", () => {
    const f = fixture();
    const decide = () => 0.1;
    expect(() => capturePhase7ImportTariffsAtPhase1(
      f.world, { ...f.phase1, phase: 7 }, decide,
    )).toThrow("requires current Phase-1");
    const missing = new Map(f.phase1.effectiveJurisdictionByRegion);
    missing.delete(f.link.toRegionId);
    expect(() => capturePhase7ImportTariffsAtPhase1(
      f.world, { ...f.phase1, effectiveJurisdictionByRegion: missing }, decide,
    )).toThrow("incomplete/stale jurisdiction");
    const stale = new Map(f.phase1.effectiveJurisdictionByRegion);
    stale.set(f.link.toRegionId, null);
    expect(() => capturePhase7ImportTariffsAtPhase1(
      f.world, { ...f.phase1, effectiveJurisdictionByRegion: stale }, decide,
    )).toThrow("incomplete/stale jurisdiction");
  });

  it("rejects invalid statutory rates and leaves WorldState unchanged", () => {
    const f = fixture();
    const original = [...f.world.states].map(([id, state]) => [id, [...state.treasury]]);
    for (const rate of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => capturePhase7ImportTariffsAtPhase1(
        f.world, f.phase1, () => rate,
      )).toThrow("finite nonnegative statutory rate");
    }
    expect([...f.world.states].map(([id, state]) => [id, [...state.treasury]])).toEqual(original);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("produces identical ordered rates despite shuffled region and link iteration", () => {
    const f = fixture();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const decide = (calls: string[]) => (query: {
      destinationStateId: string; goodId: GoodId;
    }) => {
      calls.push(phase7ImportTariffKey(
        query.destinationStateId as Parameters<typeof phase7ImportTariffKey>[0], query.goodId,
      ));
      return query.goodId === GOOD ? 0.15 : undefined;
    };
    const a = capturePhase7ImportTariffsAtPhase1(
      f.world, f.phase1, decide(callsA),
    );
    const reordered = {
      ...f.world,
      regions: new Map([...f.world.regions].reverse()),
      transportLinks: new Map([...f.world.transportLinks].reverse()),
    };
    const b = capturePhase7ImportTariffsAtPhase1(
      reordered, f.phase1, decide(callsB),
    );
    expect(callsB).toEqual(callsA);
    expect([...b.ratesByDestinationStateGood]).toEqual([...a.ratesByDestinationStateGood]);
  });
});
