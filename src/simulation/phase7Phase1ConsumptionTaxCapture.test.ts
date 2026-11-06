import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { buildInitialWorld } from "./worldState";
import {
  phase7ConsumptionTaxKey,
  type Phase7LiveOpportunityQuote,
} from "./phase7LiveWorldPlan";
import { capturePhase7ConsumptionTaxesAtPhase1 } from "./phase7Phase1ConsumptionTaxCapture";
import { derivePhase7DestinationGrossReferencePrices } from "./phase7LiveWorldPlan";

const GOOD = "good:food" as GoodId;

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const jurisdiction = new Map(
    [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
  );
  const phase1 = { tick: 7, phase: 1, effectiveJurisdictionByRegion: jurisdiction };
  const link = [...world.transportLinks.values()].find(link =>
    world.regions.get(link.toRegionId)?.controllerStateId !== null &&
    world.regions.get(link.toRegionId)?.controllerStateId !== undefined);
  if (!link || !world.definitionRegistry.goods[GOOD]?.tradable) {
    throw new Error("baseline must contain a State-controlled route and tradable food");
  }
  const destination = world.regions.get(link.toRegionId)!;
  return { world, phase1, link, destination };
}

describe("M5 #673 captured Phase-1 consumption tax authority", () => {
  it("reads each State/good rate and State efficiency once, with an explicit zero", () => {
    const f = fixture();
    const calls: string[] = [];
    const efficiencies: string[] = [];
    const snapshot = capturePhase7ConsumptionTaxesAtPhase1(f.world, f.phase1, {
      getConsumptionTaxRate: (stateId, goodId) => {
        calls.push(JSON.stringify([stateId, goodId]));
        return goodId === GOOD ? 0.2 : 0;
      },
      getCollectionEfficiency: stateId => {
        efficiencies.push(String(stateId));
        return 0.4;
      },
    });
    const stateId = f.destination.controllerStateId!;
    expect(snapshot.tick).toBe(7);
    expect(snapshot.ratesByDestinationStateGood.get(phase7ConsumptionTaxKey(stateId, GOOD)))
      .toBe(0.2);
    expect(snapshot.collectionEfficiencyByState.get(stateId)).toBe(0.4);
    expect(new Set(calls).size).toBe(calls.length);
    expect(new Set(efficiencies).size).toBe(efficiencies.length);
    expect(snapshot.ratesByDestinationStateGood.size).toBeGreaterThan(0);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("produces an identical snapshot under shuffled region and link insertion", () => {
    const f = fixture();
    const policy = {
      getConsumptionTaxRate: (_stateId: unknown, goodId: string) =>
        goodId === GOOD ? 0.125 : 0,
      getCollectionEfficiency: () => 0.75,
    };
    const original = capturePhase7ConsumptionTaxesAtPhase1(f.world, f.phase1, policy);
    const shuffled = capturePhase7ConsumptionTaxesAtPhase1({
      ...f.world,
      regions: new Map([...f.world.regions].reverse()),
      transportLinks: new Map([...f.world.transportLinks].reverse()),
    }, f.phase1, policy);
    expect([...shuffled.ratesByDestinationStateGood])
      .toEqual([...original.ratesByDestinationStateGood]);
    expect([...shuffled.collectionEfficiencyByState])
      .toEqual([...original.collectionEfficiencyByState]);
  });

  it("refuses stale jurisdiction, missing rates, negative and non-finite policy", () => {
    const f = fixture();
    const valid = {
      getConsumptionTaxRate: () => 0.1,
      getCollectionEfficiency: () => 1,
    };
    const missing = new Map(f.phase1.effectiveJurisdictionByRegion);
    missing.delete(f.link.toRegionId);
    expect(() => capturePhase7ConsumptionTaxesAtPhase1(
      f.world, { ...f.phase1, effectiveJurisdictionByRegion: missing }, valid,
    )).toThrow("incomplete/stale jurisdiction");
    expect(() => capturePhase7ConsumptionTaxesAtPhase1(
      f.world, { ...f.phase1, phase: 7 }, valid,
    )).toThrow("requires explicit current-tick");
    for (const rate of [undefined, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => capturePhase7ConsumptionTaxesAtPhase1(f.world, f.phase1, {
        ...valid, getConsumptionTaxRate: () => rate as number,
      })).toThrow("explicit finite statutory rate");
    }
    for (const efficiency of [undefined, -0.1, 1.01, Number.NaN]) {
      expect(() => capturePhase7ConsumptionTaxesAtPhase1(f.world, f.phase1, {
        ...valid, getCollectionEfficiency: () => efficiency as number,
      })).toThrow("explicit finite collection efficiency");
    }
    expect(f.world.shipments?.size).toBe(0);
  });

  it("uses the captured Phase-1 rate and collection efficiency for the Phase-7 gross reference", () => {
    const f = fixture();
    const snapshot = capturePhase7ConsumptionTaxesAtPhase1(f.world, f.phase1, {
      getConsumptionTaxRate: () => 0.2,
      getCollectionEfficiency: () => 0.4,
    });
    const quote: Phase7LiveOpportunityQuote = {
      planId: "plan:m5:consumption-tax",
      linkId: f.link.linkId,
      originRegionId: f.link.fromRegionId,
      destinationRegionId: f.link.toRegionId,
      goodId: GOOD,
      authorizedAtPhase1: true,
      cargoWeightPerUnit: 1,
      sourceSellerNetUnitPrice: 5,
      destinationReferenceNetUnitPrice: 10,
      destinationReferenceGrossUnitPrice: 999,
      landedGrossUnitCostDest: 999,
      estimatedTransportUnitCostDest: 1,
      estimatedTariffRate: 0,
      estimatedFxInputPerSourceCurrency: 1,
      shortageRateDestination: 0.5,
    };
    const pricing = {
      ...f.phase1, phase: 7, marketPrices: new Map(),
      phase1ConsumptionTaxes: snapshot,
    };
    const [gross] = derivePhase7DestinationGrossReferencePrices(f.world, pricing, [quote], []);
    expect(gross?.destinationReferenceGrossUnitPrice).toBeCloseTo(10.8, 10);
    expect(quote.destinationReferenceGrossUnitPrice).toBe(999);
    expect(f.world.shipments?.size).toBe(0);
  });
});
