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
import type { PhaseHandler } from "./tickOrchestrator";
import { createTransactionId } from "./tickOrchestrator";
import { executeM5PreparedTradeTick, type Phase7LiveTradeInputBuilder } from "./m5PreparedTradeTick";
import type { Phase7Phase1TradeLawProvider } from "./phase7AuthorizedRouteDiscovery";

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
    const walletOpening = oneLotDebit * 1.75; // Funds one full and one partial lot.
    cohorts.set(cohortId, {
      ...cohort, wallet: new Map(cohort.wallet).set(currency, walletOpening),
    });
    const tightWorld: WorldState = { ...f.world, cohorts };
    const input: Phase7PreparedMixedExecutionInput = {
      ...f.input, remainingCargoWeightByLink: new Map([[linkId, 50]]),
    };
    const result = executePreparedMixedCurrencyTradePlan(tightWorld, input);
    const replay = executePreparedMixedCurrencyTradePlan(tightWorld, input);
    expect(result.prepared.actorMatches.lots).toHaveLength(2);
    expect(result.committedLots).toHaveLength(2);
    expect(result.committedLots[0]!.dispatchedQuantity).toBe(1);
    const secondQuantity = result.committedLots[1]!.dispatchedQuantity;
    expect(secondQuantity).toBeGreaterThan(0);
    expect(secondQuantity).toBeLessThan(1);
    expect(result.unfilledLotOrdinals).toEqual([]);
    const dispatched = result.committedLots.reduce(
      (total, lot) => total + lot.dispatchedQuantity, 0,
    );
    expect(dispatched).toBeGreaterThan(1);
    expect(dispatched).toBeLessThan(2);
    expect(result.remainingCargoWeightByLink.get(linkId))
      .toBeCloseTo(50 - dispatched, 8);
    expect(result.world.shipments?.size).toBe(2);
    const remaining = readActorWallet(result.world, f.fx.buying.actor).get(currency)!;
    expect(remaining).toBeGreaterThanOrEqual(0);
    const committedDebit = result.committedLots.reduce(
      (total, lot) => total + lot.buyerTotalDebitDest, 0,
    );
    expect(committedDebit).toBeLessThanOrEqual(walletOpening);
    expect(walletOpening - remaining).toBeCloseTo(committedDebit, 8);
    expect(result.phase8MainIntents.find(
      i => i.id === f.fxLots[1]!.lot.buyerIntentId,
    )?.desiredQuantity).toBeCloseTo(5 - secondQuantity, 8);
    expect(result.phase8MainIntents.find(
      i => i.id === f.fx.selling.id,
    )?.desiredQuantity).toBeCloseTo(5 - dispatched, 8);
    expect(result.transactions).toEqual(replay.transactions);
    expect(readActorWallet(tightWorld, f.fx.buying.actor).get(currency))
      .toBe(walletOpening);
    expect(tightWorld.shipments?.size).toBe(0);
    expect([...input.remainingCargoWeightByLink]).toEqual([[linkId, 50]]);
  });
});

describe("M5 #673 committed prepared trade in the canonical 0..15 tick", () => {
  const noWorldTransition = (_phase: number, world: WorldState) => world;
  const phase1AndPhase8: PhaseHandler = (world, context) => {
    if (context.phase === 1) {
      return {
        ...context,
        effectiveJurisdictionByRegion: new Map(
          [...world.regions].map(([id, region]) => [id, region.controllerStateId]),
        ),
      };
    }
    return context;
  };
  const currentTradeInput = (f: ReturnType<typeof fixture>) =>
    (_world: WorldState, context: Parameters<PhaseHandler>[1]) => ({
      ...f.input,
      tick: context.tick,
      priorTransactions: context.transactions,
      effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
    });

  it("publishes both settlement types and Phase-8 committed residuals, then delivers two ticks later without paying again", () => {
    const f = fixture();
    const transportLinks = new Map(f.world.transportLinks);
    for (const linkId of [f.fxRoute.link.linkId, f.domesticRoute.link.linkId]) {
      transportLinks.set(linkId, { ...transportLinks.get(linkId)!, travelTicks: 2 });
    }
    const opening: WorldState = { ...f.world, transportLinks };
    const beforeCashByBuyer = new Map(
      [f.fx.buying.actor, f.dom.buying.actor].map(actor =>
        [actorRefKey(actor), [...readActorWallet(opening, actor)]],
      ),
    );
    const buyers = new Map(
      [f.fx.buying.actor, f.dom.buying.actor].map(actor => [actorRefKey(actor), actor]),
    );
    const phase8Views: { tick: number; residuals: number[] | undefined; dispatches: number }[] = [];
    const observer: PhaseHandler = (world, context, pending) => {
      const next = phase1AndPhase8(world, context, pending);
      if (next.phase === 8) {
        phase8Views.push({
          tick: next.tick,
          residuals: next.phase7MainIntents?.map(intent => intent.desiredQuantity),
          dispatches: next.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH").length,
        });
      }
      return next;
    };

    const first = executeM5PreparedTradeTick(
      opening, 7, observer, noWorldTransition, currentTradeInput(f),
    );
    const replay = executeM5PreparedTradeTick(
      opening, 7, phase1AndPhase8, noWorldTransition, currentTradeInput(f),
    );
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    expect(first.phaseBoundaryError).toBeUndefined();
    expect(first.context.transactions).toEqual(replay.context.transactions);
    expect(first.world.shipments).toEqual(replay.world.shipments);
    expect(first.context.phase7MainIntents).toEqual(replay.context.phase7MainIntents);
    expect(first.context.transactions.filter(tx => tx.type === "FX_INPUT")).toHaveLength(1);
    expect(first.context.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH")).toHaveLength(2);
    expect(first.context.transactions.some(tx => tx.type === "SHIPMENT_DELIVERY")).toBe(false);
    expect(first.world.shipments?.size).toBe(2);
    expect(first.context.phase7MainIntents?.map(intent => intent.desiredQuantity))
      .toEqual([3, 3, 3, 3]);
    expect(phase8Views[0]).toEqual({ tick: 7, residuals: [3, 3, 3, 3], dispatches: 2 });
    const shippedGoods = new Map<string, number>();
    for (const shipment of first.world.shipments!.values()) {
      const buyer = actorRefKey(shipment.beneficialOwner);
      shippedGoods.set(buyer, (shippedGoods.get(buyer) ?? 0) + shipment.quantity);
      expect(shipment.arrivalTick).toBe(9);
    }
    for (const buyer of buyers.values()) {
      const key = actorRefKey(buyer);
      const before = readMarketActorInventory(opening, buyer, "GENERAL").get(GOOD) ?? 0;
      const dispatched = readMarketActorInventory(first.world, buyer, "GENERAL").get(GOOD) ?? 0;
      expect(dispatched).toBe(before);
      expect([...readActorWallet(opening, buyer)]).toEqual(beforeCashByBuyer.get(key));
    }
    expect(opening.shipments?.size).toBe(0);

    const second = executeM5PreparedTradeTick(
      first.world, 8, phase1AndPhase8, noWorldTransition, () => null,
    );
    expect(second.world.shipments?.size).toBe(2);
    expect(second.context.transactions).toEqual([]);
    expect(second.context.phase7MainIntents).toBeUndefined();
    const third = executeM5PreparedTradeTick(
      second.world, 9, phase1AndPhase8, noWorldTransition, () => null,
    );
    expect(third.world.shipments?.size).toBe(0);
    expect(third.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
      .toHaveLength(2);
    expect(third.context.transactions.some(tx => tx.type === "FX_INPUT" ||
      tx.type === "IMPORT_TARIFF" || tx.type === "TRANSPORT_FEE")).toBe(false);
    for (const buyer of buyers.values()) {
      const key = actorRefKey(buyer);
      const beforeGoods = readMarketActorInventory(opening, buyer, "GENERAL").get(GOOD) ?? 0;
      const arrivedGoods = readMarketActorInventory(third.world, buyer, "GENERAL").get(GOOD) ?? 0;
      expect(arrivedGoods - beforeGoods).toBeCloseTo(shippedGoods.get(key) ?? 0, 8);
      expect([...readActorWallet(third.world, buyer)])
        .toEqual([...readActorWallet(first.world, buyer)]);
    }
  });

  it("delivers zero-travel committed shipments before Phase-8 reads the reduced plan", () => {
    const f = fixture();
    const transportLinks = new Map(f.world.transportLinks);
    for (const linkId of [f.fxRoute.link.linkId, f.domesticRoute.link.linkId]) {
      transportLinks.set(linkId, { ...transportLinks.get(linkId)!, travelTicks: 0 });
    }
    let observedPhase8 = false;
    const handler: PhaseHandler = (world, context, pending) => {
      const next = phase1AndPhase8(world, context, pending);
      if (next.phase === 8) {
        observedPhase8 = true;
        expect(world.shipments?.size).toBe(0);
        expect(next.phase7MainIntents?.every(intent => intent.desiredQuantity === 3))
          .toBe(true);
        expect(next.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
          .toHaveLength(2);
      }
      return next;
    };
    const result = executeM5PreparedTradeTick(
      { ...f.world, transportLinks }, 7, handler,
      noWorldTransition, currentTradeInput(f),
    );
    expect(observedPhase8).toBe(true);
    expect(result.world.shipments?.size).toBe(0);
    expect(result.context.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH"))
      .toHaveLength(2);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("captures law only at Phase 1 and binds it to real same-tick FX and domestic dispatch", () => {
    const f = fixture();
    let lastPhase = -1;
    let phase7Calls = 0;
    const observedLawPhases: number[] = [];
    const handler: PhaseHandler = (world, context, pending) => {
      lastPhase = context.phase;
      return phase1AndPhase8(world, context, pending);
    };
    const decide: Phase7Phase1TradeLawProvider = query => {
      observedLawPhases.push(lastPhase);
      return query.goodId === GOOD &&
        (query.linkId === f.fxRoute.link.linkId ||
         query.linkId === f.domesticRoute.link.linkId)
        ? null : undefined;
    };
    const build: Phase7LiveTradeInputBuilder = (world, context, frozen) => {
      phase7Calls++;
      expect(lastPhase).toBe(7);
      expect(frozen?.tick).toBe(context.tick);
      expect(frozen?.permittedGoodsByDirectedLink.get(f.fxRoute.link.linkId)?.get(GOOD))
        .toBeNull();
      expect(frozen?.permittedGoodsByDirectedLink.get(f.domesticRoute.link.linkId)?.get(GOOD))
        .toBeNull();
      return currentTradeInput(f)(world, context);
    };
    const first = executeM5PreparedTradeTick(
      f.world, 7, handler, noWorldTransition, build, undefined, decide,
    );
    const replay = executeM5PreparedTradeTick(
      f.world, 7, handler, noWorldTransition, build, undefined, decide,
    );
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    expect(first.reconciliationErrors).toBeNull();
    expect(first.phaseBoundaryError).toBeUndefined();
    expect(first.context.transactions).toEqual(replay.context.transactions);
    expect(first.world.shipments).toEqual(replay.world.shipments);
    expect(first.context.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH"))
      .toHaveLength(2);
    expect(first.world.shipments?.size).toBe(2);
    expect(phase7Calls).toBe(2);
    expect(observedLawPhases.length).toBeGreaterThan(0);
    expect(new Set(observedLawPhases)).toEqual(new Set([1]));
    expect(f.world.shipments?.size).toBe(0);
  });

  it("refuses denied routes and altered statutory caps before any mixed trade dispatch", () => {
    const f = fixture();
    const onlyFx: Phase7Phase1TradeLawProvider = query =>
      query.linkId === f.fxRoute.link.linkId && query.goodId === GOOD
        ? null : undefined;
    const forged: Phase7LiveTradeInputBuilder = (world, context, frozen) => {
      // Even a malicious/mistaken builder modifying its supplied Map must not
      // rewrite the law snapshot retained by the tick coordinator.
      const editable = frozen!.permittedGoodsByDirectedLink as
        Map<TransportLinkId, Map<GoodId, number | null>>;
      editable.set(f.domesticRoute.link.linkId, new Map([[GOOD, null]]));
      return currentTradeInput(f)(world, context);
    };
    expect(() => executeM5PreparedTradeTick(
      f.world, 7, phase1AndPhase8, noWorldTransition, forged, undefined, onlyFx,
    )).toThrow(/eligible link lacks frozen Phase-1 permission/);

    const capped: Phase7Phase1TradeLawProvider = query =>
      query.goodId === GOOD &&
      (query.linkId === f.fxRoute.link.linkId ||
       query.linkId === f.domesticRoute.link.linkId) ? 1 : undefined;
    expect(() => executeM5PreparedTradeTick(
      f.world, 7, phase1AndPhase8, noWorldTransition,
      currentTradeInput(f), undefined, capped,
    )).toThrow(/frozen Phase-1 legal quantity cap/);
    expect(f.world.shipments?.size).toBe(0);
    expect(f.input.priorTransactions).toEqual([]);
  });

  it("refuses missing Phase-1 jurisdiction before querying law or opening Phase-7 builder", () => {
    const f = fixture();
    let lawQueries = 0;
    let planned = 0;
    expect(() => executeM5PreparedTradeTick(
      f.world, 7, (_world, context) => context, noWorldTransition,
      () => { planned++; return null; }, undefined,
      () => { lawQueries++; return null; },
    )).toThrow(/incomplete jurisdiction/);
    expect(lawQueries).toBe(0);
    expect(planned).toBe(0);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects a stale tick, stale journal or fabricated Phase-1 jurisdiction before settlement", () => {
    const f = fixture();
    const opening = f.world;
    const builder = currentTradeInput(f);
    expect(() => executeM5PreparedTradeTick(
      opening, 7, phase1AndPhase8, noWorldTransition,
      (world, context) => ({ ...builder(world, context), tick: 6 }),
    )).toThrow(/current canonical tick/);
    expect(() => executeM5PreparedTradeTick(
      opening, 7, phase1AndPhase8, noWorldTransition,
      (world, context) => ({
        ...builder(world, context),
        priorTransactions: [{ tick: 7, phase: 5, type: "FORGED",
          transactionId: createTransactionId("tx:forged:old"), amount: 0 }],
      }),
    )).toThrow(/live committed tick journal/);
    expect(() => executeM5PreparedTradeTick(
      opening, 7, phase1AndPhase8, noWorldTransition,
      (world, context) => ({
        ...builder(world, context), effectiveJurisdictionByRegion: new Map(),
      }),
    )).toThrow(/current Phase-1 jurisdiction/);
    expect(opening.shipments?.size).toBe(0);
    expect(f.input.priorTransactions).toEqual([]);
  });
});


/**
 * #673 / M5 conservation golden: source goods -> IN_TRANSIT -> destination
 * and all named cash holders, including the finite FX pool, form ONE
 * physically conserved world across several canonical ticks. Dispatch-only
 * journal checks cannot prove this invariant after deferred delivery.
 */
function m5WorldStockTotals(world: WorldState): {
  money: Map<string, number>;
  goods: Map<string, number>;
} {
  type Running = { sum: number; correction: number };
  const money = new Map<string, Running>();
  const goods = new Map<string, Running>();
  const add = (totals: Map<string, Running>, key: string, value: number): void => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("M5 golden encountered invalid live stock " + key);
    }
    const prev = totals.get(key) ?? { sum: 0, correction: 0 };
    const sum = prev.sum + value;
    const correction = prev.correction + (Math.abs(prev.sum) >= Math.abs(value)
      ? (prev.sum - sum) + value
      : (value - sum) + prev.sum);
    totals.set(key, { sum, correction });
  };
  const wallet = (w: ReadonlyMap<string, number>) => {
    for (const [currency, amount] of w) add(money, currency, amount);
  };
  const inventory = (i: ReadonlyMap<string, number>) => {
    for (const [good, quantity] of i) add(goods, good, quantity);
  };
  for (const state of world.states.values()) {
    wallet(state.treasury);
    inventory(state.publicInventory);
  }
  for (const clan of world.clans.values()) wallet(clan.treasury);
  for (const cohort of world.cohorts.values()) {
    wallet(cohort.wallet);
    inventory(cohort.householdInventory);
  }
  for (const unit of world.productionUnits.values()) {
    wallet(unit.wallet);
    inventory(unit.inputInventory);
    inventory(unit.outputInventory);
    inventory(unit.investmentInventory);
  }
  // FX pool reserves are independent physical owners, NOT authority wallets.
  for (const authority of world.monetaryAuthorities.values()) {
    for (const pool of authority.fxPools.values()) wallet(pool.cash);
  }
  for (const shipment of world.shipments?.values() ?? []) {
    add(goods, shipment.goodId, shipment.quantity);
  }
  const canonical = (totals: Map<string, Running>) => new Map(
    [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, running]) => [key, running.sum + running.correction] as const),
  );
  return { money: canonical(money), goods: canonical(goods) };
}

function expectM5WorldConserved(
  opening: ReturnType<typeof m5WorldStockTotals>,
  current: WorldState,
  destroyedGoods: number,
): void {
  const actual = m5WorldStockTotals(current);
  const { moneyEpsilon, quantityEpsilon } = current.simulationConfig.numeric;
  if (moneyEpsilon === undefined || quantityEpsilon === undefined) {
    throw new Error("M5 conservation golden needs canonical numeric tolerances");
  }
  expect([...actual.money.keys()]).toEqual([...opening.money.keys()]);
  expect([...actual.goods.keys()]).toEqual([...opening.goods.keys()]);
  for (const [currency, initial] of opening.money) {
    expect(Math.abs(actual.money.get(currency)! - initial),
      "currency " + currency + " must conserve across FX/pool/fees")
      .toBeLessThanOrEqual(moneyEpsilon);
  }
  for (const [good, initial] of opening.goods) {
    const destroyed = good === GOOD ? destroyedGoods : 0;
    expect(Math.abs(actual.goods.get(good)! - (initial - destroyed)),
      "good " + good + " must count in-transit and explicitly destroyed stock")
      .toBeLessThanOrEqual(quantityEpsilon);
  }
}

describe("M5 #673 multicycle world-level trade conservation golden", () => {
  const passPhase1: PhaseHandler = (world, context) =>
    context.phase === 1
      ? { ...context, effectiveJurisdictionByRegion: new Map(
        [...world.regions].map(([id, region]) => [id, region.controllerStateId]),
      ) }
      : context;
  const unchanged = (_phase: number, world: WorldState) => world;

  it.each([0, 0.125])(
    "conserves both currencies and goods at dispatch, in transit and arrival (loss rate %s)",
    (routineLossRate) => {
      const f = fixture();
      const links = new Map(f.world.transportLinks);
      for (const id of [f.fxRoute.link.linkId, f.domesticRoute.link.linkId]) {
        const link = links.get(id)!;
        links.set(id, { ...link, travelTicks: 2, seed: {
          ...link.seed, routinePhysicalLossRate: routineLossRate,
        } });
      }
      const opening: WorldState = { ...f.world, transportLinks: links };
      const initial = m5WorldStockTotals(opening);
      const build = (_world: WorldState, context: Parameters<PhaseHandler>[1]) => ({
        ...f.input,
        tick: context.tick,
        priorTransactions: context.transactions,
        effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
      });
      const dispatched = executeM5PreparedTradeTick(
        opening, 7, passPhase1, unchanged, build,
      );
      const replay = executeM5PreparedTradeTick(
        opening, 7, passPhase1, unchanged, build,
      );
      expect(dispatched.reconciliationErrors).toBeNull();
      expect(dispatched.phaseBoundaryError).toBeUndefined();
      expect(dispatched.context.transactions).toEqual(replay.context.transactions);
      expect(dispatched.world.shipments).toEqual(replay.world.shipments);
      expect(dispatched.world.shipments?.size).toBe(2);
      expect(dispatched.context.transactions.filter(tx => tx.type === "FX_INPUT"))
        .toHaveLength(1);
      expect(dispatched.context.transactions.filter(tx => tx.type === "FX_OUTPUT"))
        .toHaveLength(1);
      expect(dispatched.context.transactions.filter(tx => tx.type === "TRADE_GOODS_SALE"))
        .toHaveLength(2);
      expect(dispatched.context.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH"))
        .toHaveLength(2);

      const losses = dispatched.context.transactions.filter(
        tx => tx.type === "GOODS_TRANSPORT_LOSS",
      );
      expect(losses).toHaveLength(routineLossRate === 0 ? 0 : 2);
      const destroyed = losses.reduce((sum, tx) => sum + (tx.quantity ?? 0), 0);
      expect(destroyed).toBeCloseTo(4 * routineLossRate, 8);
      expectM5WorldConserved(initial, dispatched.world, destroyed);

      const inTransit = executeM5PreparedTradeTick(
        dispatched.world, 8, passPhase1, unchanged, () => null,
      );
      expect(inTransit.context.transactions).toEqual([]);
      expect(inTransit.world.shipments?.size).toBe(2);
      expectM5WorldConserved(initial, inTransit.world, destroyed);

      const arrived = executeM5PreparedTradeTick(
        inTransit.world, 9, passPhase1, unchanged, () => null,
      );
      expect(arrived.world.shipments?.size).toBe(0);
      expect(arrived.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
        .toHaveLength(2);
      expect(arrived.context.transactions.some(tx =>
        tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT" ||
        tx.type === "TRADE_GOODS_SALE" || tx.type === "TRANSPORT_FEE" ||
        tx.type === "GOODS_TRANSPORT_LOSS")).toBe(false);
      expectM5WorldConserved(initial, arrived.world, destroyed);

      for (const buyer of [f.fx.buying.actor, f.dom.buying.actor]) {
        const before = readMarketActorInventory(opening, buyer, "GENERAL").get(GOOD) ?? 0;
        const after = readMarketActorInventory(arrived.world, buyer, "GENERAL").get(GOOD) ?? 0;
        const delivered = [...dispatched.world.shipments!.values()]
          .filter(shipment => actorRefKey(shipment.beneficialOwner) === actorRefKey(buyer))
          .reduce((sum, shipment) => sum + shipment.quantity, 0);
        expect(after - before).toBeCloseTo(delivered, 8);
        expect([...readActorWallet(arrived.world, buyer)])
          .toEqual([...readActorWallet(dispatched.world, buyer)]);
      }
      expect(opening.shipments?.size).toBe(0);
    },
  );

  it("fails atomically if arrival would credit an unrepresentable quantity", () => {
    const f = fixture();
    const links = new Map(f.world.transportLinks);
    for (const id of [f.fxRoute.link.linkId, f.domesticRoute.link.linkId]) {
      const link = links.get(id)!;
      links.set(id, { ...link, travelTicks: 2, seed: {
        ...link.seed, routinePhysicalLossRate: 0.125,
      } });
    }
    const opening: WorldState = { ...f.world, transportLinks: links };
    const dispatched = executeM5PreparedTradeTick(
      opening, 7, passPhase1, unchanged, (_world, context) => ({
        ...f.input, tick: context.tick, priorTransactions: context.transactions,
        effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
      }),
    );
    const buyerId = f.fxRoute.buyer.cohortId;
    const cohort = dispatched.world.cohorts.get(buyerId)!;
    const unstable: WorldState = { ...dispatched.world, cohorts:
      new Map(dispatched.world.cohorts).set(buyerId, {
        ...cohort,
        householdInventory: new Map(cohort.householdInventory).set(GOOD, 1e16),
      }),
    };
    const snapshot = m5WorldStockTotals(unstable);
    expect(() => executeM5PreparedTradeTick(
      unstable, 9, passPhase1, unchanged, () => null,
    )).toThrow(/destination goods credit loses quantity precision/);
    expect(m5WorldStockTotals(unstable)).toEqual(snapshot);
    expect(unstable.shipments?.size).toBe(2);
  });
});
