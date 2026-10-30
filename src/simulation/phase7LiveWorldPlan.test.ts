import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { phase7BuyerActorCashKey, phase7SellerEndpointKey } from "./phase7IntentMatching";
import { phase7FxOutputKey, phase7RegionCashKey, phase7RegionGoodKey } from "./phase7AggregateReservation";
import { marketPriceKey } from "./phase6MarketPriceFormation";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";

import {
  buildPhase7LiveWorldPlanInput, preparePhase7LiveWorldTradePlan,
  derivePhase7DestinationNetPrices, derivePhase7LiveFxOutputBudgets,
  derivePhase7Phase1ImportTariffs, phase7ImportTariffKey,
  derivePhase7DestinationGrossReferencePrices, phase7ConsumptionTaxKey,
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
      estimatedTransportUnitCostDest: 1,
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
  const market = [...world.markets.values()].find(m => m.seed.regionKey === destination.seed.key)!;
  const phase1Rates = new Map<string, number>();
  for (const link of links) {
    const source = world.regions.get(link.fromRegionId)!;
    const target = world.regions.get(link.toRegionId)!;
    if (target.controllerStateId !== null &&
        source.controllerStateId !== target.controllerStateId) {
      phase1Rates.set(phase7ImportTariffKey(target.controllerStateId, GOOD), 0);
    }
  }
  const context = {
    tick: 15, phase: 7 as const, marketPrices: new Map([[marketPriceKey(market.marketId, GOOD), 10]]),
    effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
    ),
    phase1ImportTariffs: { tick: 15, ratesByDestinationStateGood: phase1Rates },
    phase1ConsumptionTaxes: {
      tick: 15,
      ratesByDestinationStateGood: new Map(
        [...world.states.keys()].map(id => [phase7ConsumptionTaxKey(id, GOOD), 0]),
      ),
      collectionEfficiencyByState: new Map(
        [...world.states.keys()].map(id => [id, 1]),
      ),
    },
  };
  return { world, context, input, first, second, b1, b2, links, destination, state, buyer };
}

describe("M5 #673 Phase-7 live world opportunity planning", () => {
  it("derives two routes' goods and wallet ceilings from real owners, never quoted quantities", () => {
    const f = fixture();
    const built = buildPhase7LiveWorldPlanInput(f.world, f.context, f.input);
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
    const matched = preparePhase7LiveWorldTradePlan(f.world, f.context, f.input);
    expect(matched.aggregate.reservations.reduce((sum, r) => sum + r.allocatedQuantity, 0)).toBe(9);
    expect(matched.actorMatches.lots.reduce((sum, lot) => sum + lot.quantity, 0)).toBe(9);
    expect(matched.actorMatches.remainingSellerByEndpoint.get(sellerKey)).toBe(0);
    expect(f.world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(9);
    expect(f.world.cohorts.get(f.buyer.cohortId)!.wallet.get(f.destination.settlementCurrencyId)).toBe(30);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("hydrates the actual prepared plan, even against a forged caller net price", () => {
    const f = fixture();
    const baseline = preparePhase7LiveWorldTradePlan(f.world, f.context, f.input);
    const forged = {
      ...f.input,
      opportunityQuotes: f.input.opportunityQuotes.map(q => ({
        ...q, destinationReferenceNetUnitPrice: 1e8,
      })),
    };
    const actual = preparePhase7LiveWorldTradePlan(f.world, f.context, forged);
    expect(actual).toEqual(baseline);
    expect(actual.rankedCandidates.map(c => c.destinationReferenceNetUnitPrice)).toEqual([10, 10]);

    const market = [...f.world.markets.values()].find(
      m => m.seed.regionKey === f.destination.seed.key,
    )!;
    const badContext = {
      ...f.context,
      marketPrices: new Map([[marketPriceKey(market.marketId, GOOD), Number.NaN]]),
    };
    expect(() => preparePhase7LiveWorldTradePlan(f.world, badContext, forged))
      .toThrow("finite positive canonical market price");
    expect(f.world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(9);
    expect(f.world.cohorts.get(f.buyer.cohortId)!.wallet.get(f.destination.settlementCurrencyId)).toBe(30);
  });

  it("remains byte-stable under all input and quote permutations", () => {
    const f = fixture();
    const reversed: Phase7LiveWorldPlanInput = {
      ...f.input,
      residualIntents: [...f.input.residualIntents].reverse(),
      opportunityQuotes: [...f.input.opportunityQuotes].reverse(),
      infrastructureFactors: new Map([...f.input.infrastructureFactors].reverse()),
    };
    const first = preparePhase7LiveWorldTradePlan(f.world, f.context, f.input);
    const second = preparePhase7LiveWorldTradePlan(f.world, f.context, reversed);
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
    expect(() => preparePhase7LiveWorldTradePlan(world, f.context, f.input))
      .toThrow("cannot cover aggregate reservation");
    expect(world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(8);
    expect(f.input.residualIntents[0]!.residualQuantity).toBe(4);
  });

  it("applies the maximum common physical reserve, not a separate floor for each route", () => {
    const f = fixture();
    const residualIntents = f.input.residualIntents.map(e => ({
      ...e, intent: e.intent.side === "SELL" ? { ...e.intent, minimumReserveQuantity: 3 } : e.intent,
    }));
    const built = buildPhase7LiveWorldPlanInput(f.world, f.context, { ...f.input, residualIntents });
    expect(built.actorBudgets.sellerExportableByEndpoint.get(phase7SellerEndpointKey(f.first))).toBe(6);
    expect(() => preparePhase7LiveWorldTradePlan(f.world, f.context, { ...f.input, residualIntents }))
      .toThrow("cannot cover aggregate reservation");
  });

  it("sources Phase-7 net price from the live Phase-6 context, not a supplied quote", () => {
    const f = fixture();
    const market = [...f.world.markets.values()].find(
      m => m.seed.regionKey === f.destination.seed.key,
    )!;
    const carriedPrice = market.priceByGood.get(GOOD)!;
    const sameTickPrice = carriedPrice + 2;
    const unpriced = f.input.opportunityQuotes[0]!;
    expect("destinationReferenceNetUnitPrice" in unpriced).toBe(false);
    const quotes = derivePhase7DestinationNetPrices(
      f.world,
      { phase: 7, marketPrices: new Map([
        [marketPriceKey(market.marketId, GOOD), sameTickPrice],
      ]) },
      [unpriced],
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.destinationReferenceNetUnitPrice).toBe(sameTickPrice);
    expect(quotes[0]!.destinationReferenceGrossUnitPrice)
      .toBe(unpriced.destinationReferenceGrossUnitPrice);
    expect(market.priceByGood.get(GOOD)).toBe(carriedPrice);
  });

  it("uses Phase-8's carried-price fallback and stable route ordering", () => {
    const f = fixture();
    const market = [...f.world.markets.values()].find(
      m => m.seed.regionKey === f.destination.seed.key,
    )!;
    const unpriced = f.input.opportunityQuotes;
    const prices = { phase: 7, marketPrices: new Map<string, number>() };
    const forward = derivePhase7DestinationNetPrices(f.world, prices, unpriced);
    const reverse = derivePhase7DestinationNetPrices(f.world, prices, [...unpriced].reverse());
    expect(reverse).toEqual(forward);
    expect(forward.map(q => q.destinationReferenceNetUnitPrice)).toEqual([
      market.priceByGood.get(GOOD), market.priceByGood.get(GOOD),
    ]);
  });

  it("refuses stale phase, missing/ambiguous market and invalid Phase-6 prices", () => {
    const f = fixture();
    const market = [...f.world.markets.values()].find(
      m => m.seed.regionKey === f.destination.seed.key,
    )!;
    const unpriced = f.input.opportunityQuotes[0]!;
    expect("destinationReferenceNetUnitPrice" in unpriced).toBe(false);
    const noPrice = { phase: 7, marketPrices: new Map<string, number>() };
    expect(() => derivePhase7DestinationNetPrices(
      f.world, { ...noPrice, phase: 6 }, [unpriced],
    )).toThrow("requires live Phase-7");
    expect(() => derivePhase7DestinationNetPrices(
      f.world, {
        phase: 7, marketPrices: new Map([
          [marketPriceKey(market.marketId, GOOD), Number.NaN],
        ]),
      }, [unpriced],
    )).toThrow("finite positive canonical market price");
    const emptyWorld: WorldState = {
      ...f.world,
      markets: new Map([...f.world.markets].filter(([id]) => id !== market.marketId)),
    };
    expect(() => derivePhase7DestinationNetPrices(
      emptyWorld, noPrice, [unpriced],
    )).toThrow("exactly one destination LocalMarket");
    const duplicatedWorld: WorldState = {
      ...f.world,
      markets: new Map(f.world.markets).set("market:duplicate" as typeof market.marketId, {
        ...market, marketId: "market:duplicate" as typeof market.marketId,
      }),
    };
    expect(() => derivePhase7DestinationNetPrices(
      duplicatedWorld, noPrice, [unpriced],
    )).toThrow("exactly one destination LocalMarket");
    expect(() => derivePhase7DestinationNetPrices(
      f.world, noPrice, [{ ...unpriced, originRegionId: f.destination.regionId }],
    )).toThrow("mismatched directed link");
    expect(f.world.markets.get(market.marketId)!.priceByGood.get(GOOD))
      .toBe(market.priceByGood.get(GOOD));
  });

  it("rejects stale residual quantities, duplicated IDs, and invalid live cash without mutation", () => {
    const f = fixture();
    const tooLarge = [{ ...f.input.residualIntents[0]!, residualQuantity: 999 },
      ...f.input.residualIntents.slice(1)];
    expect(() => buildPhase7LiveWorldPlanInput(f.world, f.context, {
      ...f.input, residualIntents: tooLarge,
    })).toThrow("residual exceeds original intent");
    expect(() => buildPhase7LiveWorldPlanInput(f.world, f.context, {
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
    expect(() => buildPhase7LiveWorldPlanInput(bad, f.context, f.input))
      .toThrow("live buyer cash must be finite");
    expect(f.world.cohorts.get(f.buyer.cohortId)!.wallet.get(f.destination.settlementCurrencyId)).toBe(30);
  });

  it("rejects missing or stale Phase-1 jurisdiction before the quote reserves anything", () => {
    const f = fixture();
    const route = f.input.opportunityQuotes[0]!;
    const region = f.world.regions.get(route.originRegionId)!;
    const missing = new Map(f.context.effectiveJurisdictionByRegion);
    missing.delete(route.originRegionId);
    expect(() => preparePhase7LiveWorldTradePlan(f.world, {
      ...f.context, effectiveJurisdictionByRegion: missing,
    }, f.input)).toThrow("missing current Phase-1 jurisdiction");

    const stale = new Map(f.context.effectiveJurisdictionByRegion);
    stale.set(route.originRegionId, region.controllerStateId === null
      ? f.destination.controllerStateId : null);
    expect(() => preparePhase7LiveWorldTradePlan(f.world, {
      ...f.context, effectiveJurisdictionByRegion: stale,
    }, f.input)).toThrow("disagrees with activated Phase-1 jurisdiction");

    expect(() => preparePhase7LiveWorldTradePlan(f.world, {
      ...f.context, effectiveJurisdictionByRegion: undefined as unknown as typeof stale,
    }, f.input)).toThrow("requires current Phase-1 jurisdiction evidence");
    expect(f.world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(9);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects invented same-State and uncontrolled-destination tariffs from live quotes", () => {
    const f = fixture();
    const route = f.input.opportunityQuotes[0]!;
    const origin = f.world.regions.get(route.originRegionId)!;
    const tariffInput: Phase7LiveWorldPlanInput = {
      ...f.input,
      opportunityQuotes: f.input.opportunityQuotes.map(q =>
        q.planId === route.planId ? { ...q, estimatedTariffRate: 0.25 } : q),
    };
    const domesticWorld: WorldState = {
      ...f.world,
      regions: new Map(f.world.regions).set(origin.regionId, {
        ...origin, controllerStateId: f.destination.controllerStateId,
      }),
    };
    const domesticContext = {
      ...f.context,
      effectiveJurisdictionByRegion: new Map(f.context.effectiveJurisdictionByRegion)
        .set(origin.regionId, f.destination.controllerStateId),
    };
    expect(() => preparePhase7LiveWorldTradePlan(
      domesticWorld, domesticContext, tariffInput,
    )).toThrow("cannot charge a tariff without a destination-State border");

    const uncontrolledWorld: WorldState = {
      ...f.world,
      regions: new Map(f.world.regions).set(f.destination.regionId, {
        ...f.destination, controllerStateId: null,
      }),
    };
    const uncontrolledContext = {
      ...f.context,
      effectiveJurisdictionByRegion: new Map(f.context.effectiveJurisdictionByRegion)
        .set(f.destination.regionId, null),
    };
    expect(() => preparePhase7LiveWorldTradePlan(
      uncontrolledWorld, uncontrolledContext, tariffInput,
    )).toThrow("cannot charge a tariff without a destination-State border");
    expect(f.world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(9);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("does not treat a Phase-14 queued jurisdiction change as current-tick trade law", () => {
    const f = fixture();
    const future: WorldState = {
      ...f.world,
      pendingTransitions: {
        ...f.world.pendingTransitions,
        jurisdictionChanges: [...f.world.pendingTransitions.jurisdictionChanges, {
          regionId: f.destination.regionId,
          nextControllerStateId: null,
          activateTick: 500,
        }],
      },
    };
    const expected = preparePhase7LiveWorldTradePlan(f.world, f.context, f.input);
    const actual = preparePhase7LiveWorldTradePlan(future, f.context, f.input);
    expect(actual).toEqual(expected);
    expect(future.regions.get(f.destination.regionId)!.controllerStateId)
      .toBe(f.destination.controllerStateId);
  });

  it("hydrates positive border tariff from current Phase-1 policy, ignoring a forged quote", () => {
    const f = fixture();
    const link = [...f.world.transportLinks.values()].find(candidate => {
      const origin = f.world.regions.get(candidate.fromRegionId)!;
      const destination = f.world.regions.get(candidate.toRegionId)!;
      return destination.controllerStateId !== null &&
        origin.controllerStateId !== destination.controllerStateId;
    });
    if (!link) throw new Error("baseline needs a controlled international directed link");
    const destination = f.world.regions.get(link.toRegionId)!;
    const quote = {
      ...f.input.opportunityQuotes[0]!,
      planId: "plan:world:tariff-policy",
      linkId: link.linkId,
      originRegionId: link.fromRegionId,
      destinationRegionId: link.toRegionId,
      estimatedTariffRate: 999,
    };
    const key = phase7ImportTariffKey(destination.controllerStateId!, GOOD);
    const snapshot = { tick: f.context.tick, ratesByDestinationStateGood: new Map([[key, 0.18]]) };
    const context = { ...f.context, phase1ImportTariffs: snapshot };
    const originalRegionController = destination.controllerStateId;
    const lawful = derivePhase7Phase1ImportTariffs(f.world, context, [quote]);
    expect(lawful.map(x => x.estimatedTariffRate)).toEqual([0.18]);
    expect(derivePhase7Phase1ImportTariffs(f.world, context, [...[quote]].reverse()))
      .toEqual(lawful);
    expect(quote.estimatedTariffRate).toBe(999);
    expect(f.world.regions.get(destination.regionId)!.controllerStateId)
      .toBe(originalRegionController);

    // Missing is not a zero tariff. The snapshot belongs to the current tick,
    // not a future Phase-14 decision or a caller-provided quote.
    expect(() => derivePhase7Phase1ImportTariffs(f.world, {
      ...f.context, phase1ImportTariffs: undefined,
    }, [quote])).toThrow("requires frozen Phase-1 policy evidence");
    expect(() => derivePhase7Phase1ImportTariffs(f.world, {
      ...context, phase1ImportTariffs: { ...snapshot, tick: f.context.tick + 1 },
    }, [quote])).toThrow("current-tick frozen Phase-1 policy snapshot");
    expect(() => derivePhase7Phase1ImportTariffs(f.world, {
      ...context, phase1ImportTariffs: { ...snapshot, ratesByDestinationStateGood: new Map() },
    }, [quote])).toThrow("missing destination State/good policy rate");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      expect(() => derivePhase7Phase1ImportTariffs(f.world, {
        ...context,
        phase1ImportTariffs: {
          ...snapshot,
          ratesByDestinationStateGood: new Map([[key, bad]]),
        },
      }, [quote])).toThrow("policy rate must be finite and non-negative");
    }
    expect(f.world.shipments?.size).toBe(0);
  });


  it("hydrates tax-inclusive gross reference from frozen Phase-1 policy, ignoring caller inflation", () => {
    const f = fixture();
    const stateId = f.destination.controllerStateId!;
    const context = {
      ...f.context,
      phase1ConsumptionTaxes: {
        tick: f.context.tick,
        ratesByDestinationStateGood: new Map([[phase7ConsumptionTaxKey(stateId, GOOD), 0.2]]),
        collectionEfficiencyByState: new Map([[stateId, 0.5]]),
      },
    };
    const expected = buildPhase7LiveWorldPlanInput(f.world, context, f.input);
    expect(expected.opportunities.map(q => q.destinationReferenceNetUnitPrice)).toEqual([10, 10]);
    expect(expected.opportunities.map(q => q.destinationReferenceGrossUnitPrice)).toEqual([11, 11]);
    const forged = {
      ...f.input,
      opportunityQuotes: f.input.opportunityQuotes.map(q => ({
        ...q, destinationReferenceGrossUnitPrice: 1e9,
      })),
    };
    expect(buildPhase7LiveWorldPlanInput(f.world, context, forged)).toEqual(expected);
    expect(preparePhase7LiveWorldTradePlan(f.world, context, forged))
      .toEqual(preparePhase7LiveWorldTradePlan(f.world, context, f.input));
    expect(f.world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(9);
    expect(f.world.cohorts.get(f.buyer.cohortId)!.wallet.get(
      f.destination.settlementCurrencyId,
    )).toBe(30);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects absent, stale and invalid current-tick gross tax facts without state mutation", () => {
    const f = fixture();
    const stateId = f.destination.controllerStateId!;
    const key = phase7ConsumptionTaxKey(stateId, GOOD);
    const valid = {
      tick: f.context.tick,
      ratesByDestinationStateGood: new Map([[key, 0.1]]),
      collectionEfficiencyByState: new Map([[stateId, 0.8]]),
    };
    expect(() => buildPhase7LiveWorldPlanInput(f.world, {
      ...f.context, phase1ConsumptionTaxes: undefined,
    }, f.input)).toThrow("requires frozen Phase-1 consumption-tax policy");
    expect(() => buildPhase7LiveWorldPlanInput(f.world, {
      ...f.context, phase1ConsumptionTaxes: { ...valid, tick: f.context.tick - 1 },
    }, f.input)).toThrow("current-tick frozen tax-policy snapshot");
    expect(() => buildPhase7LiveWorldPlanInput(f.world, {
      ...f.context,
      phase1ConsumptionTaxes: { ...valid, ratesByDestinationStateGood: new Map() },
    }, f.input)).toThrow("missing destination State tax-policy evidence");
    expect(() => buildPhase7LiveWorldPlanInput(f.world, {
      ...f.context,
      phase1ConsumptionTaxes: { ...valid, collectionEfficiencyByState: new Map() },
    }, f.input)).toThrow("missing destination State tax-policy evidence");
    for (const value of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildPhase7LiveWorldPlanInput(f.world, {
        ...f.context,
        phase1ConsumptionTaxes: {
          ...valid, ratesByDestinationStateGood: new Map([[key, value]]),
        },
      }, f.input)).toThrow("tax policy must be finite in [0, 1]");
      expect(() => buildPhase7LiveWorldPlanInput(f.world, {
        ...f.context,
        phase1ConsumptionTaxes: {
          ...valid, collectionEfficiencyByState: new Map([[stateId, value]]),
        },
      }, f.input)).toThrow("tax policy must be finite in [0, 1]");
    }
    expect(f.world.states.get(f.state.stateId)!.publicInventory.get(GOOD)).toBe(9);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("matches Phase-8 State self-procurement exemption and refuses mixed gross buyer classes", () => {
    const f = fixture();
    const stateId = f.destination.controllerStateId!;
    const context = {
      ...f.context,
      phase1ConsumptionTaxes: {
        tick: f.context.tick,
        ratesByDestinationStateGood: new Map([[phase7ConsumptionTaxKey(stateId, GOOD), 0.25]]),
        collectionEfficiencyByState: new Map([[stateId, 1]]),
      },
    };
    const priced = derivePhase7DestinationNetPrices(f.world, context, f.input.opportunityQuotes);
    const exempt = f.input.residualIntents.map(entry => entry.intent.side === "BUY"
      ? {
          ...entry,
          intent: {
            ...entry.intent, actor: { type: "STATE" as const, stateId },
            purpose: "PUBLIC_PROCUREMENT" as const,
          },
        } : entry);
    expect(derivePhase7DestinationGrossReferencePrices(
      f.world, context, priced, exempt,
    ).map(q => q.destinationReferenceGrossUnitPrice)).toEqual([10, 10]);
    const mixed = exempt.map((entry, index) =>
      index === 1 ? f.input.residualIntents[index]! : entry);
    expect(() => derivePhase7DestinationGrossReferencePrices(
      f.world, context, priced, mixed,
    )).toThrow("cannot mix taxable and exempt buyer classes");
    const future: WorldState = {
      ...f.world,
      pendingTransitions: {
        ...f.world.pendingTransitions,
        jurisdictionChanges: [...f.world.pendingTransitions.jurisdictionChanges, {
          regionId: f.destination.regionId,
          nextControllerStateId: null,
          activateTick: f.context.tick + 1,
        }],
      },
    };
    expect(derivePhase7DestinationGrossReferencePrices(
      future, context, priced, f.input.residualIntents,
    ).map(q => q.destinationReferenceGrossUnitPrice)).toEqual([12.5, 12.5]);
  });

  it("caps live FX output to canonical pool cash after reserve floors, not caller claims", () => {
    const f = fixture();
    const pairIds = [...f.world.monetaryAuthorities.values()].flatMap(
      authority => [...authority.fxPools.keys()],
    );
    const cross = [...f.world.transportLinks.values()].flatMap(link => {
      const origin = f.world.regions.get(link.fromRegionId);
      const destination = f.world.regions.get(link.toRegionId);
      if (!origin || !destination ||
          origin.settlementCurrencyId === destination.settlementCurrencyId) return [];
      const pair = pairIds.find(id => {
        const pool = resolveCanonicalFxPool(f.world, id).pool;
        return (pool.baseCurrencyId === origin.settlementCurrencyId &&
          pool.quoteCurrencyId === destination.settlementCurrencyId) ||
          (pool.quoteCurrencyId === origin.settlementCurrencyId &&
            pool.baseCurrencyId === destination.settlementCurrencyId);
      });
      return pair ? [{ link, origin, destination, pair }] : [];
    })[0];
    if (!cross) throw new Error("baseline needs an FX-paired international directed link");

    const quote = {
      ...f.input.opportunityQuotes[0]!,
      estimatedTariffRate: 999,
      planId: "plan:world:live-fx",
      linkId: cross.link.linkId,
      originRegionId: cross.origin.regionId,
      destinationRegionId: cross.destination.regionId,
    };
    const key = phase7FxOutputKey(cross.pair, cross.origin.settlementCurrencyId);
    const available = quoteFx(
      f.world, cross.pair, cross.destination.settlementCurrencyId,
      cross.origin.settlementCurrencyId, 0,
    ).maxOutputByPoolReserve;
    expect(available).toBeGreaterThan(0);
    const declared = new Map([[key, available + 1_000_000]]);
    const pairs = new Map([[quote.planId, cross.pair]]);
    const input = {
      ...f.input, opportunityQuotes: [quote],
      fxPairIdByTradePlanId: pairs, fxOutputByPairCurrency: declared,
    };
    if (!cross.destination.controllerStateId ||
        cross.origin.controllerStateId === cross.destination.controllerStateId) {
      throw new Error("baseline FX route must cross a controlled State border");
    }
    const tariffContext = {
      ...f.context,
      phase1ImportTariffs: {
        tick: f.context.tick,
        ratesByDestinationStateGood: new Map([
          [phase7ImportTariffKey(cross.destination.controllerStateId, GOOD), 0.12],
        ]),
      },
    };
    const before = resolveCanonicalFxPool(f.world, cross.pair).pool.cash;
    const built = buildPhase7LiveWorldPlanInput(f.world, tariffContext, input);
    expect(built.opportunities[0]!.estimatedTariffRate).toBe(0.12);
    expect(built.aggregateBudgets.fxOutputByPairCurrency).toEqual(new Map([[key, available]]));
    expect(declared.get(key)).toBe(available + 1_000_000);
    expect(resolveCanonicalFxPool(f.world, cross.pair).pool.cash).toBe(before);

    // A smaller genuine earlier reservation is preserved rather than enlarged.
    const priorReserved = new Map([[key, available / 2]]);
    const limited = derivePhase7LiveFxOutputBudgets(
      f.world, [quote], pairs, priorReserved,
    );
    expect(limited.get(key)).toBe(available / 2);
    expect(() => derivePhase7LiveFxOutputBudgets(
      f.world, [quote], pairs, new Map(),
    )).toThrow("missing explicit tick-local output budget");
    expect(() => derivePhase7LiveFxOutputBudgets(
      f.world, [quote], pairs, new Map([[key, Number.POSITIVE_INFINITY]]),
    )).toThrow("must be finite and non-negative");
    expect(() => derivePhase7LiveFxOutputBudgets(
      f.world, [quote], new Map([[quote.planId, "fxpool:unknown"]]), declared,
    )).toThrow("missing explicit tick-local output budget");
    expect(() => derivePhase7LiveFxOutputBudgets(
      f.world, [quote], undefined, declared,
    )).toThrow("requires an explicit FX pair");
    expect(() => derivePhase7LiveFxOutputBudgets(
      f.world, f.input.opportunityQuotes,
      new Map([[f.input.opportunityQuotes[0]!.planId, cross.pair]]), new Map(),
    )).toThrow("same-currency quote must not reserve FX");
  });
});
