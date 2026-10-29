import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, CurrencyId, GoodId, TransportLinkId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import {
  phase7FxOutputKey, phase7RegionCashKey, phase7RegionGoodKey,
} from "./phase7AggregateReservation";
import { phase7BuyerActorCashKey, phase7SellerEndpointKey } from "./phase7IntentMatching";
import { preparePhase7TradePlan, type Phase7PreparedTradePlanInput } from "./phase7TradePlan";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import {
  executePreparedCrossCurrencyTradePlan,
  executePreparedMixedCurrencyTradePlan,
  type Phase7PreparedMixedExecutionInput,
} from "./phase7PreparedFxExecution";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;
const FX_ID = "plan:7:fx";
const DOMESTIC_ID = "plan:7:domestic";

function addBudget<K>(map: Map<K, number>, key: K, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** Two legal directed routes are drawn from real baseline currencies/pools. */
function fixture() {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const cohorts = [...root.cohorts.values()];
  const fxPoolIds = [...root.monetaryAuthorities.values()].flatMap(authority =>
    [...authority.fxPools.keys()],
  );
  const fxRoute = [...root.transportLinks.values()].flatMap(link => {
    const source = root.regions.get(link.fromRegionId);
    const destination = root.regions.get(link.toRegionId);
    if (!source || !destination || link.travelTicks === undefined ||
        source.settlementCurrencyId === destination.settlementCurrencyId ||
        !destination.controllerStateId) return [];
    const pair = fxPoolIds.find(pairId => {
      const pool = resolveCanonicalFxPool(root, pairId).pool;
      return (pool.baseCurrencyId === source.settlementCurrencyId &&
        pool.quoteCurrencyId === destination.settlementCurrencyId) ||
        (pool.quoteCurrencyId === source.settlementCurrencyId &&
          pool.baseCurrencyId === destination.settlementCurrencyId);
    });
    const seller = cohorts.find(c => c.seed.regionKey === source.seed.key);
    const buyer = cohorts.find(c => c.seed.regionKey === destination.seed.key);
    const receiver = cohorts.find(c => c.seed.regionKey === source.seed.key &&
      c.cohortId !== seller?.cohortId);
    return pair && seller && buyer && receiver
      ? [{ link, source, destination, pair, seller, buyer, receiver }] : [];
  })[0];
  const domesticRoute = [...root.transportLinks.values()].flatMap(link => {
    const source = root.regions.get(link.fromRegionId);
    const destination = root.regions.get(link.toRegionId);
    if (!source || !destination || link.travelTicks === undefined ||
        source.settlementCurrencyId !== destination.settlementCurrencyId ||
        !destination.controllerStateId) return [];
    const seller = cohorts.find(c => c.seed.regionKey === source.seed.key);
    const buyer = cohorts.find(c => c.seed.regionKey === destination.seed.key);
    const receiver = cohorts.find(c =>
      c.cohortId !== seller?.cohortId && c.cohortId !== buyer?.cohortId);
    return seller && buyer && receiver
      ? [{ link, source, destination, seller, buyer, receiver }] : [];
  })[0];
  if (!fxRoute || !domesticRoute) {
    throw new Error("baseline requires both paired-FX and same-currency trade routes");
  }

  const actor = (id: CohortId): ActorRef => ({ type: "COHORT", cohortId: id });
  const cohortsNext = new Map(root.cohorts);
  const grantStock = (id: CohortId) => {
    const c = cohortsNext.get(id)!;
    cohortsNext.set(id, {
      ...c, householdInventory: new Map(c.householdInventory).set(GOOD, 10),
    });
  };
  const grantCash = (id: CohortId, currency: CurrencyId, minimum: number) => {
    const c = cohortsNext.get(id)!;
    cohortsNext.set(id, {
      ...c, wallet: new Map(c.wallet).set(currency,
        Math.max(minimum, c.wallet.get(currency) ?? 0)),
    });
  };
  grantStock(fxRoute.seller.cohortId);
  grantStock(domesticRoute.seller.cohortId);
  grantCash(fxRoute.buyer.cohortId, fxRoute.destination.settlementCurrencyId, 100);
  grantCash(domesticRoute.buyer.cohortId, domesticRoute.destination.settlementCurrencyId, 100);
  grantCash(fxRoute.receiver.cohortId, fxRoute.destination.settlementCurrencyId, 1);
  grantCash(domesticRoute.receiver.cohortId, domesticRoute.destination.settlementCurrencyId, 1);

  const world: WorldState = {
    ...root, cohorts: cohortsNext,
    transportLinks: new Map(root.transportLinks)
      .set(fxRoute.link.linkId, {
        ...fxRoute.link, feeReceiver: actor(fxRoute.receiver.cohortId),
      }).set(domesticRoute.link.linkId, {
        ...domesticRoute.link, feeReceiver: actor(domesticRoute.receiver.cohortId),
      }),
  };
  const makeIntents = (prefix: string, seller: ActorRef, buyer: ActorRef,
    sourceRegionId: typeof fxRoute.source.regionId,
    destRegionId: typeof fxRoute.destination.regionId) => {
    const selling: MarketIntent = {
      id: createMarketIntentId(`mi:7:${prefix}:sell`), actor: seller,
      regionId: sourceRegionId, goodId: GOOD, side: "SELL",
      purpose: "INVENTORY_REBALANCE", desiredQuantity: 5,
      minimumReserveQuantity: 0, sourcePlanId: `plan:7:${prefix}:sell`,
    };
    const buying: MarketIntent = {
      id: createMarketIntentId(`mi:7:${prefix}:buy`), actor: buyer,
      regionId: destRegionId, goodId: GOOD, side: "BUY",
      purpose: "CONSUMPTION", desiredQuantity: 5, maxSpend: 50,
      sourcePlanId: `plan:7:${prefix}:buy`,
    };
    return { selling, buying };
  };
  const fxSeller = actor(fxRoute.seller.cohortId);
  const fxBuyer = actor(fxRoute.buyer.cohortId);
  const domSeller = actor(domesticRoute.seller.cohortId);
  const domBuyer = actor(domesticRoute.buyer.cohortId);
  const fx = makeIntents("fx", fxSeller, fxBuyer,
    fxRoute.source.regionId, fxRoute.destination.regionId);
  const dom = makeIntents("dom", domSeller, domBuyer,
    domesticRoute.source.regionId, domesticRoute.destination.regionId);
  const fxUnit = quoteFx(world, fxRoute.pair,
    fxRoute.destination.settlementCurrencyId,
    fxRoute.source.settlementCurrencyId, 3,
  ).requiredInputAmountAtDesiredOutput;
  const fxGross = fxUnit + 1;
  const fxOpportunity = {
    planId: FX_ID, linkId: fxRoute.link.linkId,
    originRegionId: fxRoute.source.regionId,
    destinationRegionId: fxRoute.destination.regionId,
    goodId: GOOD, authorizedAtPhase1: true,
    exportableQuantity: 2, residualImportDemandQuantity: 2,
    buyerRemainingBudgetDest: 50, cargoWeightPerUnit: 1,
    destinationReferenceGrossUnitPrice: fxGross + 8,
    landedGrossUnitCostDest: fxGross,
    sourceSellerNetUnitPrice: 3,
    destinationReferenceNetUnitPrice: fxGross + 8,
    estimatedTransportUnitCostDest: 0.5, estimatedTariffRate: 0.1,
    estimatedFxInputPerSourceCurrency: fxUnit / 3,
    shortageRateDestination: 0.2, fxFeasibleQuantity: 2,
  };
  const domesticOpportunity = {
    planId: DOMESTIC_ID, linkId: domesticRoute.link.linkId,
    originRegionId: domesticRoute.source.regionId,
    destinationRegionId: domesticRoute.destination.regionId,
    goodId: GOOD, authorizedAtPhase1: true,
    exportableQuantity: 2, residualImportDemandQuantity: 2,
    buyerRemainingBudgetDest: 50, cargoWeightPerUnit: 1,
    destinationReferenceGrossUnitPrice: 12, landedGrossUnitCostDest: 4,
    sourceSellerNetUnitPrice: 3, destinationReferenceNetUnitPrice: 12,
    estimatedTransportUnitCostDest: 0.5, estimatedTariffRate: 0.1,
    estimatedFxInputPerSourceCurrency: 1, shortageRateDestination: 0.2,
  };
  const exported = new Map<string, number>();
  const demanded = new Map<string, number>();
  const cash = new Map<string, number>();
  const actorExported = new Map<string, number>();
  const actorCash = new Map<string, number>();
  for (const [route, intents] of [[fxRoute, fx], [domesticRoute, dom]] as const) {
    addBudget(exported, phase7RegionGoodKey(route.source.regionId, GOOD), 2);
    addBudget(demanded, phase7RegionGoodKey(route.destination.regionId, GOOD), 2);
    cash.set(phase7RegionCashKey(
      route.destination.regionId, route.destination.settlementCurrencyId), 100);
    addBudget(actorExported, phase7SellerEndpointKey(intents.selling), 2);
    actorCash.set(phase7BuyerActorCashKey(intents.buying.actor,
      route.destination.settlementCurrencyId), 100);
  }
  const planInput: Phase7PreparedTradePlanInput = {
    opportunities: [fxOpportunity, domesticOpportunity],
    scorePolicy: {
      tradeProfitWeight: 1, shortageWeight: 1,
      minimumTradeScore: 0.05, maximumShortagePremiumShare: 0.25,
    },
    infrastructureFactors: new Map([
      [fxRoute.link.linkId, 1], [domesticRoute.link.linkId, 1],
    ]),
    eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>([
      fxRoute.link.linkId, domesticRoute.link.linkId,
    ]),
    aggregateBudgets: {
      exportableByOriginGood: exported,
      importDemandByDestinationGood: demanded,
      buyerCashByDestinationCurrency: cash,
      fxOutputByPairCurrency: new Map([
        [phase7FxOutputKey(fxRoute.pair, fxRoute.source.settlementCurrencyId), 30],
      ]),
    },
    actorBudgets: {
      sellerExportableByEndpoint: actorExported,
      buyerCashByActorCurrency: actorCash,
    },
    actorsByTradePlanId: new Map([
      [FX_ID, { sellers: [{ intent: fx.selling, residualQuantity: 5 }],
        buyers: [{ intent: fx.buying, residualQuantity: 5, remainingBuyerSpend: 50 }] }],
      [DOMESTIC_ID, { sellers: [{ intent: dom.selling, residualQuantity: 5 }],
        buyers: [{ intent: dom.buying, residualQuantity: 5, remainingBuyerSpend: 50 }] }],
    ]),
    fxPairIdByTradePlanId: new Map([[FX_ID, fxRoute.pair]]),
  };
  const prepared = preparePhase7TradePlan(world, world.simulationConfig, planInput);
  const fxOrdinal = prepared.actorMatches.lots.findIndex(lot => lot.tradePlanId === FX_ID);
  if (fxOrdinal < 0 || prepared.actorMatches.lots.length !== 2) {
    throw new Error("fixture must match exactly one FX and one domestic lot");
  }
  const reservation = {
    tick: 7, requestId: "fx:req:mixed-7", payerKey: actorRefKey(fxBuyer),
    quote: quoteFx(world, fxRoute.pair,
      fxRoute.destination.settlementCurrencyId,
      fxRoute.source.settlementCurrencyId, 30, { maxInputAmount: 100 }),
  };
  const input: Phase7PreparedMixedExecutionInput = {
    tick: 7, planInput,
    termsByTradePlanId: new Map([[FX_ID, {
      sourceSellerNetUnitPrice: 3, transportFeePerUnitDest: 0.5,
      tariffPerUnitDest: 0.25, consumptionTaxPerUnitDest: 0.25,
    }]]),
    sameCurrencyTermsByTradePlanId: new Map([[DOMESTIC_ID, {
      sellerNetUnitPrice: 3, transportFeePerUnitDest: 0.5,
      tariffPerUnitDest: 0.25, consumptionTaxPerUnitDest: 0.25,
    }]]),
    fxReservationByLotOrdinal: new Map([[fxOrdinal, reservation]]),
    effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId]),
    ),
    remainingCargoWeightByLink: new Map([
      [fxRoute.link.linkId, 50], [domesticRoute.link.linkId, 50],
    ]),
    priorTransactions: [],
    phase8MainIntents: [fx.selling, fx.buying, dom.selling, dom.buying],
  };
  return { world, input, fx, dom, fxOrdinal, fxRoute, domesticRoute };
}

describe("M5 #673 mixed prepared same-currency + FX execution", () => {
  it("commits both payment types in one deterministic ordered world and only real Phase-8 residuals", () => {
    const f = fixture();
    const first = executePreparedMixedCurrencyTradePlan(f.world, f.input);
    const replay = executePreparedMixedCurrencyTradePlan(f.world, f.input);
    expect(first.prepared.actorMatches.lots).toHaveLength(2);
    expect(first.committedLots).toHaveLength(2);
    expect(first.unfilledLotOrdinals).toEqual([]);
    expect(first.transactions.filter(tx => tx.type === "FX_INPUT")).toHaveLength(1);
    expect(first.transactions.filter(tx => tx.type === "FX_OUTPUT")).toHaveLength(1);
    expect(first.transactions.filter(tx => tx.type === "TRADE_GOODS_SALE")).toHaveLength(2);
    expect(first.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH")).toHaveLength(2);
    expect(first.world.shipments?.size).toBe(2);
    expect(first.transactions).toEqual(replay.transactions);
    expect(first.world.shipments).toEqual(replay.world.shipments);
    expect(first.phase8MainIntents).toEqual(replay.phase8MainIntents);
    for (const intent of f.input.phase8MainIntents) {
      const residual = first.phase8MainIntents.find(i => i.id === intent.id);
      expect(residual?.desiredQuantity).toBe(3);
      if (intent.side === "BUY") {
        expect(residual?.maxSpend).toBeLessThan(intent.maxSpend!);
      }
    }
    expect(f.world.shipments?.size).toBe(0);
    expect(f.input.priorTransactions).toEqual([]);
    expect([...f.input.remainingCargoWeightByLink.values()]).toEqual([50, 50]);
    expect([...first.remainingCargoWeightByLink.values()]).toEqual([48, 48]);
  });

  it("preserves the FX-only guard and rejects missing or wrongly indexed FX promises", () => {
    const f = fixture();
    expect(() => executePreparedCrossCurrencyTradePlan(f.world, f.input))
      .toThrow(/domestic lot requires/);
    expect(() => executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.input, fxReservationByLotOrdinal: new Map(),
    })).toThrow(/lot-specific FX reservation/);
    const domesticOrdinal = f.fxOrdinal === 0 ? 1 : 0;
    expect(() => executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.input, fxReservationByLotOrdinal: new Map([
        ...f.input.fxReservationByLotOrdinal, [domesticOrdinal,
          f.input.fxReservationByLotOrdinal.get(f.fxOrdinal)!],
      ]),
    })).toThrow(/domestic-bound FX lot reservation/);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("fails closed on a malformed domestic quote without exposing an earlier staged FX trade", () => {
    const f = fixture();
    const badQuotes = new Map(f.input.sameCurrencyTermsByTradePlanId);
    badQuotes.set(DOMESTIC_ID, {
      ...badQuotes.get(DOMESTIC_ID)!, consumptionTaxPerUnitDest: 0,
    });
    const beforeFxCash = [...readActorWallet(
      f.world, f.fx.buying.actor)];
    const beforeGoods = readMarketActorInventory(
      f.world, f.dom.selling.actor, "GENERAL").get(GOOD);
    expect(() => executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.input, sameCurrencyTermsByTradePlanId: badQuotes,
    })).toThrow(/domestic charges disagree/);
    expect([...readActorWallet(f.world, f.fx.buying.actor)]).toEqual(beforeFxCash);
    expect(readMarketActorInventory(f.world, f.dom.selling.actor, "GENERAL").get(GOOD))
      .toBe(beforeGoods);
    expect(f.world.shipments?.size).toBe(0);
    expect(f.input.priorTransactions).toEqual([]);
  });

  it("does not charge or shrink FX MAIN intents when FX is unfillable but domestic settles", () => {
    const f = fixture();
    const promised = f.input.fxReservationByLotOrdinal.get(f.fxOrdinal)!;
    const exhausted = {
      ...promised, quote: {
        ...promised.quote, feasibleOutputAmount: 0,
        requiredInputForFeasibleOutput: 0,
      },
    };
    const result = executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.input, fxReservationByLotOrdinal: new Map([[f.fxOrdinal, exhausted]]),
    });
    expect(result.unfilledLotOrdinals).toEqual([f.fxOrdinal]);
    expect(result.committedLots).toHaveLength(1);
    expect(result.transactions.some(tx => tx.type === "FX_INPUT")).toBe(false);
    expect(result.phase8MainIntents.find(i => i.id === f.fx.buying.id)?.desiredQuantity)
      .toBe(5);
    expect(result.phase8MainIntents.find(i => i.id === f.dom.buying.id)?.desiredQuantity)
      .toBe(3);
    expect(f.world.shipments?.size).toBe(0);
  });
});


/**
 * Two DISTINCT buy intents of one physical actor can receive two matched lots
 * from ONE FX route/good candidate. The actor wallet and directed link are
 * shared stocks, never duplicated per buyer intent or per shipment ID.
 * Planning budgets here deliberately reflect the earlier tick; execution
 * must re-check tighter LIVE cash/cargo rather than trusting that preview.
 */
function sharedBuyerAndRouteFixture() {
  const f = fixture();
  const secondBuyer: MarketIntent = {
    ...f.fx.buying,
    id: createMarketIntentId("mi:7:fx:buyer-second"),
    sourcePlanId: "plan:7:fx:buyer-second",
  };
  const fxActors = f.input.planInput.actorsByTradePlanId.get(FX_ID)!;
  const planInput: Phase7PreparedTradePlanInput = {
    ...f.input.planInput,
    opportunities: f.input.planInput.opportunities.filter(q => q.planId === FX_ID),
    actorsByTradePlanId: new Map([[FX_ID, {
      ...fxActors,
      buyers: [...fxActors.buyers, {
        intent: secondBuyer, residualQuantity: 5, remainingBuyerSpend: 50,
      }],
    }]]),
  };
  const prepared = preparePhase7TradePlan(f.world, f.world.simulationConfig, planInput);
  const fxLots = prepared.actorMatches.lots.map((lot, ordinal) => ({ lot, ordinal }))
    .filter(({ lot }) => lot.tradePlanId === FX_ID);
  if (fxLots.length !== 2 || fxLots.some(({ lot }) => lot.quantity !== 1)) {
    throw new Error("shared-buyer fixture requires two real one-unit FX lots");
  }
  const initialReservation = f.input.fxReservationByLotOrdinal.get(f.fxOrdinal)!;
  const input: Phase7PreparedMixedExecutionInput = {
    ...f.input,
    planInput,
    phase8MainIntents: [f.fx.selling, f.fx.buying, secondBuyer],
    fxReservationByLotOrdinal: new Map(fxLots.map(({ ordinal }) =>
      [ordinal, {
        ...initialReservation,
        requestId: "fx:req:shared-buyer:" + ordinal,
      }])),
  };
  return { ...f, input, fxLots, secondBuyer };
}

describe("M5 #673 shared buyer-wallet and directed-route adversarial regressions", () => {
  it("does not dispatch a second FX shipment against already used link capacity", () => {
    const f = sharedBuyerAndRouteFixture();
    const linkId = f.fxRoute.link.linkId;
    const currency = f.fxRoute.destination.settlementCurrencyId;
    const input: Phase7PreparedMixedExecutionInput = {
      ...f.input,
      remainingCargoWeightByLink: new Map([[linkId, 1]]),
    };
    const buyerCashBefore = readActorWallet(f.world, f.fx.buying.actor).get(currency)!;
    const sellerGoodsBefore = readMarketActorInventory(
      f.world, f.fx.selling.actor, "GENERAL",
    ).get(GOOD)!;
    const result = executePreparedMixedCurrencyTradePlan(f.world, input);
    const replay = executePreparedMixedCurrencyTradePlan(f.world, input);

    expect(result.prepared.actorMatches.lots).toHaveLength(2);
    expect(result.committedLots).toHaveLength(1);
    expect(result.committedLots[0]!.dispatchedQuantity).toBe(1);
    expect(result.unfilledLotOrdinals).toEqual([f.fxLots[1]!.ordinal]);
    expect(result.remainingCargoWeightByLink.get(linkId)).toBe(0);
    expect(result.world.shipments?.size).toBe(1);
    expect(result.transactions.filter(tx => tx.type === "FX_INPUT")).toHaveLength(1);
    expect(result.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH"))
      .toHaveLength(1);
    const buyerCashAfter = readActorWallet(result.world, f.fx.buying.actor).get(currency)!;
    const sellerGoodsAfter = readMarketActorInventory(
      result.world, f.fx.selling.actor, "GENERAL",
    ).get(GOOD)!;
    expect(buyerCashBefore - buyerCashAfter)
      .toBeCloseTo(result.committedLots[0]!.buyerTotalDebitDest, 8);
    expect(sellerGoodsBefore - sellerGoodsAfter).toBe(1);

    const settledBuyerIntent = result.committedLots[0]!.buyerIntentId;
    const unfilledBuyerIntent = f.fxLots[1]!.lot.buyerIntentId;
    expect(result.phase8MainIntents.find(i => i.id === settledBuyerIntent)?.desiredQuantity)
      .toBe(4);
    expect(result.phase8MainIntents.find(i => i.id === unfilledBuyerIntent)?.desiredQuantity)
      .toBe(5);
    expect(result.phase8MainIntents.find(i => i.id === f.fx.selling.id)?.desiredQuantity)
      .toBe(4);
    expect(result.transactions).toEqual(replay.transactions);
    expect(result.world.shipments).toEqual(replay.world.shipments);
    expect(f.world.shipments?.size).toBe(0);
    expect([...input.remainingCargoWeightByLink]).toEqual([[linkId, 1]]);
    expect(f.input.priorTransactions).toEqual([]);
  });

  it("rechecks the SAME actor wallet across two distinct prepared FX buyer intents", () => {
    const f = sharedBuyerAndRouteFixture();
    const linkId = f.fxRoute.link.linkId;
    const currency = f.fxRoute.destination.settlementCurrencyId;
    const oneLot = executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.input, remainingCargoWeightByLink: new Map([[linkId, 1]]),
    });
    expect(oneLot.committedLots).toHaveLength(1);
    const oneLotDebit = oneLot.committedLots[0]!.buyerTotalDebitDest;
    const cohortId = f.fxRoute.buyer.cohortId;
    const cohort = f.world.cohorts.get(cohortId)!;
    const cohorts = new Map(f.world.cohorts);
    const walletOpening = oneLotDebit + 1e-4; // Below a minimum shipment's cost.
    cohorts.set(cohortId, {
      ...cohort, wallet: new Map(cohort.wallet).set(currency, walletOpening),
    });
    const tightWorld: WorldState = { ...f.world, cohorts };
    const input: Phase7PreparedMixedExecutionInput = {
      ...f.input, remainingCargoWeightByLink: new Map([[linkId, 50]]),
    };
    const result = executePreparedMixedCurrencyTradePlan(tightWorld, input);
    expect(result.prepared.actorMatches.lots).toHaveLength(2);
    expect(result.committedLots).toHaveLength(1);
    expect(result.committedLots[0]!.dispatchedQuantity).toBe(1);
    expect(result.unfilledLotOrdinals).toEqual([f.fxLots[1]!.ordinal]);
    expect(result.remainingCargoWeightByLink.get(linkId)).toBe(49);
    expect(result.world.shipments?.size).toBe(1);
    const remaining = readActorWallet(result.world, f.fx.buying.actor).get(currency)!;
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(walletOpening - remaining)
      .toBeCloseTo(result.committedLots[0]!.buyerTotalDebitDest, 8);
    expect(result.phase8MainIntents.find(
      i => i.id === f.fxLots[1]!.lot.buyerIntentId,
    )?.desiredQuantity).toBe(5);
    expect(readActorWallet(tightWorld, f.fx.buying.actor).get(currency))
      .toBe(walletOpening);
    expect(tightWorld.shipments?.size).toBe(0);
    expect([...input.remainingCargoWeightByLink]).toEqual([[linkId, 50]]);
  });
});
