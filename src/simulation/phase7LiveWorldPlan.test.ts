import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { phase7BuyerActorCashKey, phase7SellerEndpointKey } from "./phase7IntentMatching";
import { phase7RegionCashKey, phase7RegionGoodKey } from "./phase7AggregateReservation";
import {
  buildPhase7LiveWorldPlanInput, preparePhase7LiveWorldTradePlan,
  type Phase7LiveWorldPlanInput,
} from "./phase7LiveWorldPlan";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:wood" as GoodId;

function fixture() {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 97,
  );
  const destination = [...root.regions.values()].find(
    r => r.seed.key === "region:a2-farm",
  )!;
  const links = [...root.transportLinks.values()]
    .filter(l => l.toRegionId === destination.regionId && l.fromRegionId !== destination.regionId)
    .sort((a, b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0)
    .slice(0, 2);
  if (links.length !== 2 || !destination.controllerStateId) {
    throw new Error("baseline needs two directed links into an Alpha market");
  }
  const state = root.states.get(destination.controllerStateId)!;
  const buyer = [...root.cohorts.values()].find(c => c.seed.regionKey === destination.seed.key)!;
  if (!buyer) throw new Error("baseline needs one cohort at destination");
  const world: WorldState = {
    ...root,
    states: new Map(root.states).set(state.stateId, {
      ...state, publicInventory: new Map(state.publicInventory).set(GOOD, 9),
    }),
    cohorts: new Map(root.cohorts).set(buyer.cohortId, {
      ...buyer, wallet: new Map(buyer.wallet).set(destination.settlementCurrencyId, 30),
    }),
  };
  const makeSeller = (index: number, quantity: number, reserve = 0): MarketIntent => ({
    id: createMarketIntentId("mi:phase7:world:seller:" + index),
    actor: { type: "STATE", stateId: state.stateId },
    regionId: links[index]!.fromRegionId, goodId: GOOD,
    side: "SELL", purpose: "INVENTORY_REBALANCE",
    desiredQuantity: quantity, minimumReserveQuantity: reserve,
    inventoryBucket: "GENERAL", sourcePlanId: "plan:world:seller:" + index,
  });
  const makeBuyer = (index: number, quantity: number): MarketIntent => ({
    id: createMarketIntentId("mi:phase7:world:buyer:" + index),
    actor: { type: "COHORT", cohortId: buyer.cohortId },
    regionId: destination.regionId, goodId: GOOD,
    side: "BUY", purpose: "CONSUMPTION",
    desiredQuantity: quantity, maxSpend: 100,
    sourcePlanId: "plan:world:buyer:" + index,
  });
  const first = makeSeller(0, 4);
  const second = makeSeller(1, 5);
  const b1 = makeBuyer(0, 4);
  const b2 = makeBuyer(1, 5);
  const input: Phase7LiveWorldPlanInput = {
    residualIntents: [
      { intent: first, residualQuantity: 4 },
      { intent: b1, residualQuantity: 4, remainingBuyerSpend: 100 },
      { intent: second, residualQuantity: 5 },
      { intent: b2, residualQuantity: 5, remainingBuyerSpend: 100 },
    ],
    opportunityQuotes: links.map((link, i) => ({
      planId: "plan:world:route:" + i,
      linkId: link.linkId,
      originRegionId: link.fromRegionId,
      destinationRegionId: link.toRegionId,
      goodId: GOOD, authorizedAtPhase1: true,
      cargoWeightPerUnit: 1, destinationReferenceGrossUnitPrice: 10,
      landedGrossUnitCostDest: 2, sourceSellerNetUnitPrice: 1,
      destinationReferenceNetUnitPrice: 10, estimatedTransportUnitCostDest: 1,
      estimatedTariffRate: 0, estimatedFxInputPerSourceCurrency: 1,
      shortageRateDestination: 0.25,
    })),
    scorePolicy: {
      tradeProfitWeight: 1, shortageWeight: 0,
      minimumTradeScore: 0.01, maximumShortagePremiumShare: 0,
    },
    infrastructureFactors: new Map<TransportLinkId, number>(links.map(l => [l.linkId, 1])),
    eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>(links.map(l => l.linkId)),
    fxOutputByPairCurrency: new Map(),
  };
  return { world, input, first, second, b1, b2, links, destination, state, buyer };
}

describe("M5 #673 Phase-7 live world opportunity planning", () => {
  it("derives two routes' goods and wallet ceilings from real owners, never quoted quantities", () => {
    const f = fixture();
    const built = buildPhase7LiveWorldPlanInput(f.world, f.input);
    const origin0 = phase7RegionGoodKey(f.first.regionId, GOOD);
    const origin1 = phase7RegionGoodKey(f.second.regionId, GOOD);
    const demandKey = phase7RegionGoodKey(f.destination.regionId, GOOD);
    const cashKey = phase7RegionCashKey(f.destination.regionId, f.destination.settlementCurrencyId);
    const sellerKey = phase7SellerEndpointKey(f.first);
    const buyerKey = phase7BuyerActorCashKey(f.b1.actor, f.destination.settlementCurrencyId);
    expect(phase7SellerEndpointKey(f.second)).toBe(sellerKey);
    expect(built.aggregateBudgets.exportableByOriginGood.get(origin0)).toBe(4);
    expect(built.aggregateBudgets.exportableByOriginGood.get(origin1)).toBe(5);
    expect(built.aggregateBudgets.importDemandByDestinationGood.get(demandKey)).toBe(9);
    expect(built.aggregateBudgets.buyerCashByDestinationCurrency.get(cashKey)).toBe(30);
    expect(built.actorBudgets.sellerExportableByEndpoint.get(sellerKey)).toBe(9);
    expect(built.actorBudgets.buyerCashByActorCurrency.get(buyerKey)).toBe(30);
    expect(built.opportunities.map(q => q.exportableQuantity).sort()).toEqual([4, 5]);
    const matched = preparePhase7LiveWorldTradePlan(f.world, f.input);
    expect(matched.aggregate.reservations.reduce((sum, r) => sum + r.allocatedQuantity, 0)).toBe(9);
    expect(matched.actorMatches.lots.reduce((sum, lot) => sum + lot.quantity, 0)).toBe(9);
    expect(matched.actorMatches.remainingSellerByEndpoint.get(sellerKey)).toBe(0);
    expect(f.world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(9);
    expect(f.world.cohorts.get(f.buyer.cohortId)!.wallet.get(f.destination.settlementCurrencyId)).toBe(30);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("remains byte-stable under all input and quote permutations", () => {
    const f = fixture();
    const reversed: Phase7LiveWorldPlanInput = {
      ...f.input,
      residualIntents: [...f.input.residualIntents].reverse(),
      opportunityQuotes: [...f.input.opportunityQuotes].reverse(),
      infrastructureFactors: new Map([...f.input.infrastructureFactors].reverse()),
    };
    const first = preparePhase7LiveWorldTradePlan(f.world, f.input);
    const second = preparePhase7LiveWorldTradePlan(f.world, reversed);
    expect(second.rankedCandidates).toEqual(first.rankedCandidates);
    expect(second.aggregate.reservations).toEqual(first.aggregate.reservations);
    expect(second.actorMatches.lots).toEqual(first.actorMatches.lots);
  });

  it("fails atomically when two legal origin regions overdraw one State inventory", () => {
    const f = fixture();
    const seller = f.world.states.get(f.state.stateId)!;
    const world: WorldState = {
      ...f.world, states: new Map(f.world.states).set(f.state.stateId, {
        ...seller, publicInventory: new Map(seller.publicInventory).set(GOOD, 8),
      }),
    };
    expect(() => preparePhase7LiveWorldTradePlan(world, f.input))
      .toThrow("cannot cover aggregate reservation");
    expect(world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(8);
    expect(f.input.residualIntents[0]!.residualQuantity).toBe(4);
  });

  it("applies the maximum common physical reserve, not a separate floor for each route", () => {
    const f = fixture();
    const residualIntents = f.input.residualIntents.map(e => ({
      ...e, intent: e.intent.side === "SELL" ? { ...e.intent, minimumReserveQuantity: 3 } : e.intent,
    }));
    const built = buildPhase7LiveWorldPlanInput(f.world, { ...f.input, residualIntents });
    expect(built.actorBudgets.sellerExportableByEndpoint.get(phase7SellerEndpointKey(f.first))).toBe(6);
    expect(() => preparePhase7LiveWorldTradePlan(f.world, { ...f.input, residualIntents }))
      .toThrow("cannot cover aggregate reservation");
  });

  it("rejects stale residual quantities, duplicated IDs, and invalid live cash without mutation", () => {
    const f = fixture();
    const tooLarge = [{ ...f.input.residualIntents[0]!, residualQuantity: 999 },
      ...f.input.residualIntents.slice(1)];
    expect(() => buildPhase7LiveWorldPlanInput(f.world, {
      ...f.input, residualIntents: tooLarge,
    })).toThrow("residual exceeds original intent");
    expect(() => buildPhase7LiveWorldPlanInput(f.world, {
      ...f.input, residualIntents: [
        ...f.input.residualIntents, f.input.residualIntents[0]!,
      ],
    })).toThrow("duplicate residual intent ID");
    const cohort = f.world.cohorts.get(f.buyer.cohortId)!;
    const bad: WorldState = {
      ...f.world, cohorts: new Map(f.world.cohorts).set(f.buyer.cohortId, {
        ...cohort, wallet: new Map(cohort.wallet).set(
          f.destination.settlementCurrencyId, Number.POSITIVE_INFINITY,
        ),
      }),
    };
    expect(() => buildPhase7LiveWorldPlanInput(bad, f.input))
      .toThrow("live buyer cash must be finite");
    expect(f.world.cohorts.get(f.buyer.cohortId)!.wallet.get(f.destination.settlementCurrencyId)).toBe(30);
  });
});
