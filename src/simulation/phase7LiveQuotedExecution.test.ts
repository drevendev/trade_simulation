import { describe, expect, it } from "vitest";
import {
  executeM5CanonicalIntakeTradeTick, executeM5LiveQuotedTradeTick,
} from "./m5LiveQuotedTradeTick";
import { createTransactionId, noOpPhaseHandler, type PhaseHandler } from "./tickOrchestrator";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import type { GoodId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { marketPriceKey } from "./phase6MarketPriceFormation";
import { phase7FxOutputKey } from "./phase7AggregateReservation";
import {
  phase7ConsumptionTaxKey, phase7ImportTariffKey, buildPhase7LiveWorldPlanInput,
  type Phase7LiveWorldPlanInput,
} from "./phase7LiveWorldPlan";
import { quotePhase7ActualMatchedLots } from "./phase7ActualLotQuote";
import { assessPhase7QuotedFxScarcity, reservePhase7QuotedFxLots } from "./phase7AutoFxReservations";
import { executePhase7LiveQuotedMixedTradePlan } from "./phase7LiveQuotedExecution";
import { executePreparedMixedCurrencyTradePlan } from "./phase7PreparedFxExecution";
import { preparePhase7TradePlan } from "./phase7TradePlan";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

function fxFixture(twoBuyerIntents = false) {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const poolIds = [...root.monetaryAuthorities.values()].flatMap(a => [...a.fxPools.keys()]);
  const route = [...root.transportLinks.values()].flatMap(link => {
    const origin = root.regions.get(link.fromRegionId);
    const destination = root.regions.get(link.toRegionId);
    if (!origin || !destination || !origin.controllerStateId ||
        !destination.controllerStateId ||
        origin.controllerStateId === destination.controllerStateId ||
        origin.settlementCurrencyId === destination.settlementCurrencyId) return [];
    const pairId = poolIds.find(id => {
      const pool = resolveCanonicalFxPool(root, id).pool;
      return [pool.baseCurrencyId, pool.quoteCurrencyId].includes(origin.settlementCurrencyId) &&
        [pool.baseCurrencyId, pool.quoteCurrencyId].includes(destination.settlementCurrencyId);
    });
    const seller = [...root.cohorts.values()].find(c => c.seed.regionKey === origin.seed.key);
    const buyer = [...root.cohorts.values()].find(c => c.seed.regionKey === destination.seed.key);
    const receiver = [...root.cohorts.values()].find(c =>
      c.seed.regionKey === origin.seed.key && c.cohortId !== seller?.cohortId);
    return pairId && seller && buyer && receiver
      ? [{ link, origin, destination, pairId, seller, buyer, receiver }] : [];
  })[0];
  if (!route) throw new Error("baseline must offer a controlled distinct-currency route");
  const { link, origin, destination, pairId } = route;
  const sellerActor: ActorRef = { type: "COHORT", cohortId: route.seller.cohortId };
  const buyerActor: ActorRef = { type: "COHORT", cohortId: route.buyer.cohortId };
  const feeReceiver: ActorRef = { type: "COHORT", cohortId: route.receiver.cohortId };
  const sourceCurrency = origin.settlementCurrencyId;
  const destCurrency = destination.settlementCurrencyId;
  const cohorts = new Map(root.cohorts);
  cohorts.set(route.seller.cohortId, {
    ...route.seller,
    householdInventory: new Map(route.seller.householdInventory).set(GOOD, 10),
    wallet: new Map(route.seller.wallet).set(sourceCurrency, 5),
  });
  cohorts.set(route.buyer.cohortId, {
    ...route.buyer,
    wallet: new Map(route.buyer.wallet).set(destCurrency, 100),
  });
  cohorts.set(route.receiver.cohortId, {
    ...route.receiver,
    wallet: new Map(route.receiver.wallet).set(destCurrency, 1),
  });
  const world: WorldState = {
    ...root, cohorts,
    transportLinks: new Map(root.transportLinks).set(link.linkId, {
      ...link, feeReceiver,
    }),
  };
  const sellerIntent: MarketIntent = {
    id: createMarketIntentId("mi:phase7:quote-exec:fx-seller"),
    actor: sellerActor, regionId: origin.regionId, goodId: GOOD,
    side: "SELL", purpose: "INVENTORY_REBALANCE",
    desiredQuantity: 2, minimumReserveQuantity: 0,
    sourcePlanId: "plan:phase7:quote-exec:fx-seller",
  };
  const buyers: MarketIntent[] = [0, ...(twoBuyerIntents ? [1] : [])].map(i => ({
    id: createMarketIntentId("mi:phase7:quote-exec:fx-buyer:" + i),
    actor: buyerActor, regionId: destination.regionId, goodId: GOOD,
    side: "BUY" as const, purpose: "CONSUMPTION" as const,
    desiredQuantity: twoBuyerIntents ? 1 : 2, maxSpend: 100,
    sourcePlanId: "plan:phase7:quote-exec:fx-buyer:" + i,
  }));
  const sourceMarket = [...world.markets.values()].find(m => m.seed.regionKey === origin.seed.key)!;
  const destMarket = [...world.markets.values()].find(m => m.seed.regionKey === destination.seed.key)!;
  const context = {
    tick: 7, phase: 7 as const,
    marketPrices: new Map([
      [marketPriceKey(sourceMarket.marketId, GOOD), 3],
      [marketPriceKey(destMarket.marketId, GOOD), 100],
    ]),
    effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
    ),
    phase1ImportTariffs: {
      tick: 7, ratesByDestinationStateGood: new Map([
        [phase7ImportTariffKey(destination.controllerStateId!, GOOD), 0.1],
      ]),
    },
    phase1ConsumptionTaxes: {
      tick: 7, ratesByDestinationStateGood: new Map([
        [phase7ConsumptionTaxKey(destination.controllerStateId!, GOOD), 0.1],
      ]),
      collectionEfficiencyByState: new Map([
        [destination.controllerStateId!, 1],
      ]),
    },
    transportFeeCostPolicy: {
      minimumConditionForCost: 0.1, maximumConditionCostMultiplier: 3,
    },
  };
  const planId = "plan:phase7:quote-exec:fx";
  const availableOutput = quoteFx(
    world, pairId, destCurrency, sourceCurrency, 0,
  ).maxOutputByPoolReserve;
  const input: Phase7LiveWorldPlanInput = {
    opportunityQuotes: [{
      planId, linkId: link.linkId, originRegionId: origin.regionId,
      destinationRegionId: destination.regionId, goodId: GOOD,
      authorizedAtPhase1: true, cargoWeightPerUnit: 1,
      destinationReferenceGrossUnitPrice: 200,
      landedGrossUnitCostDest: 0.001, estimatedTransportUnitCostDest: 0,
      estimatedTariffRate: 0, estimatedFxInputPerSourceCurrency: 0.001,
      shortageRateDestination: 1,
    }],
    residualIntents: [
      { intent: sellerIntent, residualQuantity: 2 },
      ...buyers.map(intent => ({
        intent, residualQuantity: intent.desiredQuantity, remainingBuyerSpend: 100,
      })),
    ],
    scorePolicy: {
      tradeProfitWeight: 1, shortageWeight: 1,
      minimumTradeScore: 0.05, maximumShortagePremiumShare: 0.25,
    },
    infrastructureFactors: new Map([[link.linkId, 1]]),
    eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>([link.linkId]),
    fxPairIdByTradePlanId: new Map([[planId, pairId]]),
    fxOutputByPairCurrency: new Map([
      [phase7FxOutputKey(pairId, sourceCurrency), availableOutput],
    ]),
  };
  const quoted = quotePhase7ActualMatchedLots(world, context, input);
  const fxReservations = new Map(quoted.quotes.map((q, ordinal) => [
    ordinal,
    {
      tick: 7,
      requestId: "fx:req:live-quoted:" + ordinal,
      payerKey: actorRefKey(buyerActor),
      quote: quoteFx(world, pairId, destCurrency, sourceCurrency,
        q.sellerInvoiceSource, { maxInputAmount: 100 }),
    },
  ] as const));
  const state = {
    fxReservationByLotOrdinal: fxReservations,
    effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
    remainingCargoWeightByLink: new Map([[link.linkId, 50]]),
    priorTransactions: [],
    phase8MainIntents: [sellerIntent, ...buyers],
  };
  return {
    world, context, input, state, quoted, link, pairId, sellerActor, buyerActor,
    feeReceiver, origin, destination, sourceCurrency, destCurrency,
  };
}

describe("M5 #673 live actual-lot FX quotation to atomic dispatch", () => {
  it("settles one live FX invoice with explicit charges, conserved goods and two currencies", () => {
    const f = fxFixture();
    expect(f.quoted.quotes).toHaveLength(1);
    const invoice = f.quoted.quotes[0]!;
    expect(invoice.fxPairId).toBe(f.pairId);
    const sellerStart = readActorWallet(f.world, f.sellerActor).get(f.sourceCurrency)!;
    const buyerStart = readActorWallet(f.world, f.buyerActor).get(f.destCurrency)!;
    const receiverStart = readActorWallet(f.world, f.feeReceiver).get(f.destCurrency)!;
    const treasuryStart = f.world.states.get(f.destination.controllerStateId!)!
      .treasury.get(f.destCurrency)!;
    const stockStart = readMarketActorInventory(f.world, f.sellerActor, "GENERAL")
      .get(GOOD)!;
    const poolStart = resolveCanonicalFxPool(f.world, f.pairId).pool;
    const result = executePhase7LiveQuotedMixedTradePlan(
      f.world, f.context, f.input, f.state,
    );
    const replay = executePhase7LiveQuotedMixedTradePlan(
      f.world, f.context, f.input, f.state,
    );
    expect(result.committedLots).toHaveLength(1);
    expect(result.unfilledLotOrdinals).toEqual([]);
    expect(result.world.shipments?.size).toBe(1);
    expect(result.transactions.filter(t => t.type === "FX_INPUT")).toHaveLength(1);
    expect(result.transactions.filter(t => t.type === "FX_OUTPUT")).toHaveLength(1);
    expect(result.transactions.filter(t => t.type === "TRADE_GOODS_SALE")).toHaveLength(1);
    expect(result.transactions.filter(t => t.type === "SHIPMENT_DISPATCH")).toHaveLength(1);
    expect(result.transactions.filter(t => t.type === "IMPORT_TARIFF")).toHaveLength(1);
    expect(result.transactions.filter(t => t.type === "CONSUMPTION_TAX")).toHaveLength(1);
    expect(result.transactions.filter(t => t.type === "TRANSPORT_FEE")).toHaveLength(1);
    expect(readActorWallet(result.world, f.sellerActor).get(f.sourceCurrency)! - sellerStart)
      .toBeCloseTo(invoice.sellerInvoiceSource, 9);
    expect(buyerStart - readActorWallet(result.world, f.buyerActor).get(f.destCurrency)!)
      .toBeCloseTo(invoice.buyerDebitDest, 9);
    expect(readActorWallet(result.world, f.feeReceiver).get(f.destCurrency)! - receiverStart)
      .toBeCloseTo(invoice.transportFeeDest, 9);
    const treasuryEnd = result.world.states.get(f.destination.controllerStateId!)!
      .treasury.get(f.destCurrency)!;
    expect(treasuryEnd - treasuryStart)
      .toBeCloseTo(invoice.importTariffDest + invoice.consumptionTaxDest, 9);
    expect(stockStart - readMarketActorInventory(result.world, f.sellerActor, "GENERAL")
      .get(GOOD)!).toBeCloseTo(invoice.lot.quantity, 9);
    expect(result.world.shipments!.values().next().value?.quantity)
      .toBeCloseTo(invoice.lot.quantity, 9);
    const poolEnd = resolveCanonicalFxPool(result.world, f.pairId).pool;
    expect(poolStart.cash.get(f.sourceCurrency)! - poolEnd.cash.get(f.sourceCurrency)!)
      .toBeCloseTo(invoice.sellerInvoiceSource, 9);
    expect(poolEnd.cash.get(f.destCurrency)! - poolStart.cash.get(f.destCurrency)!)
      .toBeCloseTo(invoice.goodsPaymentDest, 9);
    expect(result.transactions).toEqual(replay.transactions);
    expect(result.world.shipments).toEqual(replay.world.shipments);
    expect(f.world.shipments?.size).toBe(0);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency)).toBe(buyerStart);
    expect(readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD))
      .toBe(stockStart);
  });


  it("settles two different lot-specific tax rates on one FX route without averaging", () => {
    const f = fxFixture(true);
    expect(f.quoted.quotes).toHaveLength(2);
    const [first, second] = f.quoted.quotes;
    const q0 = first!;
    const q1 = second!;
    const delta = Math.min(q0.consumptionTaxDest, q1.consumptionTaxDest) / 4;
    expect(delta).toBeGreaterThan(0);
    const planId = q0.lot.tradePlanId;
    expect(q1.lot.tradePlanId).toBe(planId);
    const terms = (q: typeof q0, offset: number) => ({
      terms: {
        sourceSellerNetUnitPrice: q.sellerInvoiceSource / q.lot.quantity,
        transportFeePerUnitDest: q.transportFeeDest / q.lot.quantity,
        tariffPerUnitDest: q.importTariffDest / q.lot.quantity,
        consumptionTaxPerUnitDest: (q.consumptionTaxDest + offset) / q.lot.quantity,
      },
      buyerDebitDest: q.buyerDebitDest + offset,
    });
    const frozen = new Map([[0, terms(q0, delta)], [1, terms(q1, -delta)]]);
    const result = executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.state,
      tick: f.context.tick,
      planInput: buildPhase7LiveWorldPlanInput(f.world, f.context, f.input),
      termsByTradePlanId: new Map([[planId, frozen.get(0)!.terms]]),
      sameCurrencyTermsByTradePlanId: new Map(),
      quotedFxTermsByLotOrdinal: frozen,
    });
    const taxes = result.transactions.filter(tx => tx.type === "CONSUMPTION_TAX");
    expect(result.committedLots).toHaveLength(2);
    expect(result.unfilledLotOrdinals).toEqual([]);
    expect(taxes).toHaveLength(2);
    expect(taxes[0]!.moneyAmount).toBeCloseTo(q0.consumptionTaxDest + delta, 9);
    expect(taxes[1]!.moneyAmount).toBeCloseTo(q1.consumptionTaxDest - delta, 9);
    expect(result.committedLots.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0))
      .toBeCloseTo(q0.buyerDebitDest + q1.buyerDebitDest, 9);
    expect(result.world.shipments?.size).toBe(2);
    expect(f.world.shipments?.size).toBe(0);

    // A missing or unrelated quote is rejected BEFORE any cash or stock mutation.
    const bad = new Map([[0, frozen.get(0)!], [3, frozen.get(1)!]]);
    expect(() => executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.state,
      tick: f.context.tick,
      planInput: buildPhase7LiveWorldPlanInput(f.world, f.context, f.input),
      termsByTradePlanId: new Map([[planId, frozen.get(0)!.terms]]),
      sameCurrencyTermsByTradePlanId: new Map(),
      quotedFxTermsByLotOrdinal: bad,
    })).toThrow("lot-specific FX quotes must cover every FX match");
    expect(f.world.shipments?.size).toBe(0);

    const unreserved = new Map(frozen);
    const secondWithUnreservedTax = frozen.get(1)!;
    unreserved.set(1, {
      terms: {
        ...secondWithUnreservedTax.terms,
        consumptionTaxPerUnitDest: secondWithUnreservedTax.terms.consumptionTaxPerUnitDest + 1,
      },
      buyerDebitDest: secondWithUnreservedTax.buyerDebitDest + 1,
    });
    expect(() => executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.state,
      tick: f.context.tick,
      planInput: buildPhase7LiveWorldPlanInput(f.world, f.context, f.input),
      termsByTradePlanId: new Map([[planId, frozen.get(0)!.terms]]),
      sameCurrencyTermsByTradePlanId: new Map(),
      quotedFxTermsByLotOrdinal: unreserved,
    })).toThrow("lot-specific buyer debits disagree with accepted aggregate reservation");
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects offsetting per-lot taxes that exceed an individual matched BUY spend", () => {
    const f = fxFixture(true);
    const [first, second] = f.quoted.quotes;
    const q0 = first!;
    const q1 = second!;
    expect(f.quoted.quotes).toHaveLength(2);
    expect(q0.lot.buyerIntentId).not.toBe(q1.lot.buyerIntentId);
    const delta = Math.min(q0.consumptionTaxDest, q1.consumptionTaxDest) / 4;
    expect(delta).toBeGreaterThan(0);
    const canonicalPlan = buildPhase7LiveWorldPlanInput(f.world, f.context, f.input);
    const unitGross = canonicalPlan.opportunities.find(q =>
      q.planId === q0.lot.tradePlanId)!.landedGrossUnitCostDest;
    const originalAuthorization = q0.lot.quantity * unitGross;
    // Matcher may spend the agreed per-unit reservation, but may NOT spend
    // this intent's newly inflated individual quote even if the other intent
    // offsets it and the shared wallet can afford both.
    const remainingBuyerSpend =
      Math.max(originalAuthorization, q0.buyerDebitDest) + delta / 2;
    expect(remainingBuyerSpend).toBeLessThan(q0.buyerDebitDest + delta);
    const narrowedInput = {
      ...f.input,
      residualIntents: f.input.residualIntents.map(entry =>
        entry.intent.id === q0.lot.buyerIntentId
          ? { ...entry, remainingBuyerSpend }
          : entry),
    };
    const planInput = buildPhase7LiveWorldPlanInput(
      f.world, f.context, narrowedInput,
    );
    const prepared = preparePhase7TradePlan(
      f.world, f.world.simulationConfig, planInput,
    );
    expect(prepared.actorMatches.lots.map(lot => lot.buyerIntentId))
      .toEqual(f.quoted.quotes.map(q => q.lot.buyerIntentId));
    const quotedTerms = (q: typeof q0, offset: number) => ({
      terms: {
        sourceSellerNetUnitPrice: q.sellerInvoiceSource / q.lot.quantity,
        transportFeePerUnitDest: q.transportFeeDest / q.lot.quantity,
        tariffPerUnitDest: q.importTariffDest / q.lot.quantity,
        consumptionTaxPerUnitDest: (q.consumptionTaxDest + offset) / q.lot.quantity,
      },
      buyerDebitDest: q.buyerDebitDest + offset,
    });
    const lots = new Map([
      [0, quotedTerms(q0, delta)],
      [1, quotedTerms(q1, -delta)],
    ]);
    const buyerCash = readActorWallet(f.world, f.buyerActor).get(f.destCurrency);
    const sellerStock = readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD);
    const beforeIntents = [...f.state.phase8MainIntents];
    const beforeTransactions = [...f.state.priorTransactions];
    const beforePool = resolveCanonicalFxPool(f.world, f.pairId).pool.cash;
    expect(() => executePreparedMixedCurrencyTradePlan(f.world, {
      ...f.state,
      tick: f.context.tick,
      planInput,
      termsByTradePlanId: new Map([[q0.lot.tradePlanId, lots.get(0)!.terms]]),
      sameCurrencyTermsByTradePlanId: new Map(),
      quotedFxTermsByLotOrdinal: lots,
    })).toThrow("lot-specific buyer debit exceeds matched BUY intent remaining spend");
    expect(f.world.shipments?.size).toBe(0);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency)).toBe(buyerCash);
    expect(readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD))
      .toBe(sellerStock);
    expect(resolveCanonicalFxPool(f.world, f.pairId).pool.cash).toEqual(beforePool);
    expect(f.state.priorTransactions).toEqual(beforeTransactions);
    expect(f.state.phase8MainIntents).toEqual(beforeIntents);
  });

  it("refuses missing, wrong-owner and reused reservations with no published changes", () => {
    const f = fxFixture();
    const quote = f.state.fxReservationByLotOrdinal.get(0)!;
    const stock = readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD);
    const cash = readActorWallet(f.world, f.buyerActor).get(f.destCurrency);
    expect(() => executePhase7LiveQuotedMixedTradePlan(f.world, f.context, f.input, {
      ...f.state, fxReservationByLotOrdinal: new Map(),
    })).toThrow("missing or duplicated lot-specific FX reservation");
    expect(() => executePhase7LiveQuotedMixedTradePlan(f.world, f.context, f.input, {
      ...f.state, fxReservationByLotOrdinal: new Map([
        [0, { ...quote, payerKey: "not-the-buyer" }],
      ]),
    })).toThrow(/reservation|payer/i);
    expect(f.world.shipments?.size).toBe(0);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency)).toBe(cash);
    expect(readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD)).toBe(stock);

    const split = fxFixture(true);
    expect(split.quoted.quotes).toHaveLength(2);
    const first = split.state.fxReservationByLotOrdinal.get(0)!;
    const second = split.state.fxReservationByLotOrdinal.get(1)!;
    expect(() => executePhase7LiveQuotedMixedTradePlan(
      split.world, split.context, split.input, {
        ...split.state, fxReservationByLotOrdinal: new Map([
          [0, first], [1, { ...second, requestId: first.requestId }],
        ]),
      },
    )).toThrow("missing or duplicated lot-specific FX reservation");
    expect(split.world.shipments?.size).toBe(0);
  });
  it("executes canonical live quotes at the Phase-7 tick-close boundary", () => {
    const f = fxFixture();
    const marker = {
      tick: 7, phase: 5, type: "TEST_PRIOR_PHASE_RECEIPT",
      transactionId: createTransactionId("tx:phase7:live-tick:prior"),
      amount: 1,
    };
    const handler: PhaseHandler = (world, context) => {
      if (context.phase === 1) {
        return { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion };
      }
      if (context.phase === 5) {
        return { ...context, transactions: [...context.transactions, marker] };
      }
      if (context.phase === 6) {
        return { ...context, marketPrices: f.context.marketPrices };
      }
      if (context.phase === 8) {
        expect(world).not.toBe(f.world);
        expect(context.transactions[0]).toBe(marker);
        expect(context.transactions.filter(t => t.type === "FX_OUTPUT")).toHaveLength(1);
        expect(context.phase7MainIntents).toBeDefined();
      }
      return context;
    };
    const observations: number[] = [];
    const build = (_world: WorldState, context: Parameters<PhaseHandler>[1]) => {
      expect(context.phase).toBe(7);
      expect(context.tick).toBe(f.context.tick);
      expect(context.transactions[0]).toBe(marker);
      // Malicious extra runtime properties on policy/dispatch MUST NOT override
      // live Phase-1 jurisdiction, Phase-6 prices or the committed journal.
      const policy = {
        phase1ImportTariffs: f.context.phase1ImportTariffs,
        phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
        transportFeeCostPolicy: f.context.transportFeeCostPolicy,
        tick: -99,
        phase: 0,
        marketPrices: new Map(),
        effectiveJurisdictionByRegion: new Map(),
      };
      return {
        policy,
        plan: f.input,
        dispatch: {
          ...f.state,
          priorTransactions: [],
          effectiveJurisdictionByRegion: new Map(),
        },
      };
    };
    const run = () => executeM5LiveQuotedTradeTick(
      f.world, 7, handler, (_phase, world) => world,
      build, phase => { observations.push(phase); },
    );
    const actual = run();
    const replay = run();
    expect(actual.phaseTrace).toEqual([...Array(16).keys()]);
    expect(actual.reconciliationErrors).toBeNull();
    expect(actual.phaseBoundaryError).toBeUndefined();
    expect(actual.context.transactions[0]).toBe(marker);
    expect(actual.context.transactions.filter(t => t.type === "SHIPMENT_DISPATCH")).toHaveLength(1);
    expect(actual.context.transactions.filter(t => t.type === "FX_INPUT")).toHaveLength(1);
    expect(actual.context.transactions.filter(t => t.type === "FX_OUTPUT")).toHaveLength(1);
    expect(actual.context.transactions).toEqual(replay.context.transactions);
    expect(actual.world.shipments).toEqual(replay.world.shipments);
    expect(observations).toContain(7);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency)).toBe(100);
    expect(readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD)).toBe(10);
    expect(f.world.shipments?.size).toBe(0);
  });


  it("uses current Phase-2/4/5 projected intents for live FX dispatch and Phase-8 fallback", () => {
    const f = fxFixture();
    const seller = f.input.residualIntents.find(e => e.intent.side === "SELL")!.intent;
    const buyer = f.input.residualIntents.find(e => e.intent.side === "BUY")!.intent;
    const handler: PhaseHandler = (_world, context) => {
      if (context.phase === 1) {
        return { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion };
      }
      if (context.phase === 2) {
        return {
          ...context, productionMarketIntents: [seller],
          householdMarketIntents: [buyer],
        };
      }
      if (context.phase === 4) {
        // Realized Phase-4 allocations are explicitly empty this tick:
        // no phantom earlier cash/quantity debit is authorized.
        return { ...context, phase4MarketAllocations: [] };
      }
      if (context.phase === 6) {
        return { ...context, marketPrices: f.context.marketPrices };
      }
      return context;
    };
    const policy = {
      phase1ImportTariffs: f.context.phase1ImportTariffs,
      phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
      transportFeeCostPolicy: f.context.transportFeeCostPolicy,
    };
    // Extra fields simulate untyped external JS callers trying to reset both
    // residual demand and the Phase-8 continuation to an empty, forged set.
    // The opt-in canonical intake entry point MUST overwrite both.
    const forgedPlan = { ...f.input, residualIntents: [] };
    const forgedDispatch = {
      remainingCargoWeightByLink: f.state.remainingCargoWeightByLink,
      autoReserveFx: true as const,
      phase8MainIntents: [],
    };
    const run = () => executeM5CanonicalIntakeTradeTick(
      f.world, 7, handler, (_phase, world) => world,
      () => ({ policy, plan: forgedPlan, dispatch: forgedDispatch }),
    );
    const actual = run();
    const replay = run();
    expect(actual.phaseTrace).toEqual([...Array(16).keys()]);
    expect(actual.phaseBoundaryError).toBeUndefined();
    expect(actual.reconciliationErrors).toBeNull();
    expect(actual.context.transactions.filter(t => t.type === "SHIPMENT_DISPATCH"))
      .toHaveLength(1);
    expect(actual.context.transactions.filter(t => t.type === "FX_OUTPUT"))
      .toHaveLength(1);
    expect(actual.context.phase7MainIntents).toBeDefined();
    expect(actual.context.phase7MainIntents!.every(i => [seller.id, buyer.id].includes(i.id)))
      .toBe(true);
    expect(actual.context.transactions).toEqual(replay.context.transactions);
    expect(actual.world.shipments).toEqual(replay.world.shipments);
    expect(f.world.shipments?.size).toBe(0);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency)).toBe(100);
    expect(readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD)).toBe(10);
  });

  it("executes canonical Phase-7 FX trade only through discovered current-tick directed permissions", () => {
    const f = fxFixture();
    const seller = f.input.residualIntents.find(e => e.intent.side === "SELL")!.intent;
    const buyer = f.input.residualIntents.find(e => e.intent.side === "BUY")!.intent;
    const planId = JSON.stringify(["m5:route", f.link.linkId, GOOD]);
    const handler: PhaseHandler = (_world, context) => {
      if (context.phase === 1) {
        return { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion };
      }
      if (context.phase === 2) {
        return {
          ...context, productionMarketIntents: [seller],
          householdMarketIntents: [buyer],
        };
      }
      if (context.phase === 4) return { ...context, phase4MarketAllocations: [] };
      if (context.phase === 6) return { ...context, marketPrices: f.context.marketPrices };
      return context;
    };
    const policy = {
      phase1ImportTariffs: f.context.phase1ImportTariffs,
      phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
      transportFeeCostPolicy: f.context.transportFeeCostPolicy,
    };
    const forged = {
      ...f.input,
      opportunityQuotes: f.input.opportunityQuotes.map(q => ({
        ...q, planId, cargoWeightPerUnit: 0.001,
        authorizedAtPhase1: false, legalQuantityCap: 0,
      })),
      eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>(),
      fxPairIdByTradePlanId: new Map([[planId, f.pairId]]),
    };
    const request = () => ({
      policy, plan: forged,
      authorizedRouteDiscovery: {
        permissions: {
          tick: 7,
          permittedGoodsByDirectedLink: new Map([
            [f.link.linkId, new Map<GoodId, number | null>([[GOOD, null]])],
          ]),
        },
      },
      dispatch: {
        remainingCargoWeightByLink: f.state.remainingCargoWeightByLink,
        autoReserveFx: true as const,
      },
    });
    const run = () => executeM5CanonicalIntakeTradeTick(
      f.world, 7, handler, (_phase, world) => world, request,
    );
    const actual = run();
    const replay = run();
    expect(actual.phaseBoundaryError).toBeUndefined();
    expect(actual.reconciliationErrors).toBeNull();
    expect(actual.context.transactions.filter(t => t.type === "SHIPMENT_DISPATCH"))
      .toHaveLength(1);
    expect(actual.context.transactions.filter(t => t.type === "FX_OUTPUT"))
      .toHaveLength(1);
    expect(actual.context.transactions).toEqual(replay.context.transactions);
    expect(actual.world.shipments).toEqual(replay.world.shipments);
    expect(f.world.shipments?.size).toBe(0);

    // The same forged legal flag and quantities cannot authorize an absent
    // Phase-1 link/good decision, even if price/FX and buyer wallet are valid.
    expect(() => executeM5CanonicalIntakeTradeTick(
      f.world, 7, handler, (_phase, world) => world,
      () => ({
        ...request(),
        authorizedRouteDiscovery: {
          permissions: { tick: 7, permittedGoodsByDirectedLink: new Map() },
        },
      }),
    )).toThrow("complete discovered route/good");
    expect(f.world.shipments?.size).toBe(0);
  });

  it("refuses canonical Phase-7 execution without authentic earlier intake evidence", () => {
    const f = fxFixture();
    // Phase-1 and Phase-6 are present, but Phase-2/4/5 never supplied
    // realized intake evidence. The canonical wrapper must not infer
    // no procurement, reconstruct original maxSpend, or dispatch anyway.
    const handler: PhaseHandler = (_world, context) => {
      if (context.phase === 1) {
        return { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion };
      }
      if (context.phase === 6) {
        return { ...context, marketPrices: f.context.marketPrices };
      }
      return context;
    };
    expect(() => executeM5CanonicalIntakeTradeTick(
      f.world, 7, handler, (_phase, world) => world,
      () => ({
        policy: {
          phase1ImportTariffs: f.context.phase1ImportTariffs,
          phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
          transportFeeCostPolicy: f.context.transportFeeCostPolicy,
        },
        plan: f.input,
        dispatch: {
          remainingCargoWeightByLink: f.state.remainingCargoWeightByLink,
          autoReserveFx: true as const,
        },
      }),
    )).toThrow(/Phase-7 intake requires complete same-tick/i);
    expect(f.world.shipments?.size).toBe(0);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency)).toBe(100);
    expect(readMarketActorInventory(f.world, f.sellerActor, "GENERAL").get(GOOD)).toBe(10);
  });

  it("automatically reserves two live FX lots against one canonical payer and pool", () => {
    const f = fxFixture(true);
    expect(f.quoted.quotes).toHaveLength(2);
    const openingPool = resolveCanonicalFxPool(f.world, f.pairId).pool.cash;
    const openingBuyerCash = readActorWallet(f.world, f.buyerActor).get(f.destCurrency);
    const reservations = reservePhase7QuotedFxLots(
      f.world, f.context.tick, f.quoted.quotes,
    );
    const replayReservations = reservePhase7QuotedFxLots(
      f.world, f.context.tick, f.quoted.quotes,
    );
    expect(reservations).toEqual(replayReservations);
    expect([...reservations.keys()]).toEqual([0, 1]);
    for (const [ordinal, quote] of f.quoted.quotes.entries()) {
      const reservation = reservations.get(ordinal)!;
      expect(reservation.tick).toBe(f.context.tick);
      expect(reservation.payerKey).toBe(actorRefKey(f.buyerActor));
      expect(reservation.quote.feasibleOutputAmount).toBe(quote.sellerInvoiceSource);
      expect(reservation.quote.requiredInputForFeasibleOutput)
        .toBeCloseTo(quote.goodsPaymentDest, 9);
    }
    const settled = executePhase7LiveQuotedMixedTradePlan(
      f.world, f.context, f.input,
      { ...f.state, fxReservationByLotOrdinal: reservations },
    );
    expect(settled.committedLots).toHaveLength(2);
    expect(settled.transactions.filter(tx => tx.type === "FX_OUTPUT")).toHaveLength(2);
    expect(settled.world.shipments?.size).toBe(2);
    expect(resolveCanonicalFxPool(f.world, f.pairId).pool.cash).toEqual(openingPool);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency))
      .toBe(openingBuyerCash);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects rounded-away FX inputs across two canonical pools for the same payer", () => {
    const f = fxFixture(true);
    expect(f.quoted.quotes).toHaveLength(2);
    if (f.buyerActor.type !== "COHORT") throw new Error("fixture buyer must be a cohort");

    // Select two independently issuer-owned canonical pairs with the same
    // destination/input currency but DIFFERENT source/output currencies.
    const candidates = [...f.world.monetaryAuthorities.values()].flatMap(authority =>
      [...authority.fxPools.values()].map(pool => ({
        authorityId: authority.authorityId,
        pool,
        outputCurrencyId: pool.baseCurrencyId === f.destCurrency
          ? pool.quoteCurrencyId : pool.baseCurrencyId,
      })),
    ).filter(entry =>
      entry.pool.baseCurrencyId === f.destCurrency ||
      entry.pool.quoteCurrencyId === f.destCurrency,
    ).sort((a, b) => a.pool.pairId < b.pool.pairId ? -1 :
      a.pool.pairId > b.pool.pairId ? 1 : 0);
    const first = candidates[0]!;
    const second = candidates.find(entry =>
      entry.outputCurrencyId !== first.outputCurrencyId)!;
    const selected = [first, second].sort((a, b) =>
      a.pool.pairId < b.pool.pairId ? -1 : 1);
    expect(selected[0]!.outputCurrencyId).not.toBe(selected[1]!.outputCurrencyId);

    // Give both authoritative pools enough liquidity for a full quote; this
    // must fail because of aggregation precision, NOT pool scarcity.
    const authorities = new Map(f.world.monetaryAuthorities);
    for (const { authorityId, pool } of selected) {
      const authority = authorities.get(authorityId)!;
      authorities.set(authorityId, {
        ...authority,
        fxPools: new Map(authority.fxPools).set(pool.pairId, {
          ...pool,
          cash: new Map([
            [pool.baseCurrencyId, 2e16],
            [pool.quoteCurrencyId, 2e16],
          ]),
          spotRateQuotePerBase: 1,
          transactionSpread: 0,
          minOperationalReserveBase: 0,
          minOperationalReserveQuote: 0,
        }),
      });
    }
    const buyer = f.world.cohorts.get(f.buyerActor.cohortId)!;
    const openingCash = 1e16 + 10;
    const world: WorldState = {
      ...f.world,
      monetaryAuthorities: authorities,
      cohorts: new Map(f.world.cohorts).set(buyer.cohortId, {
        ...buyer, wallet: new Map(buyer.wallet).set(f.destCurrency, openingCash),
      }),
    };
    // The first gross buyer debit is 2 = FX input 1 + transport fee 1.
    // The second debit is 1e16. Both gross debits fit opening cash and can
    // reconcile, but the separate FX input promises (1 + 1e16) cannot.
    const quotes = selected.map(({ pool, outputCurrencyId }, index) => {
      const amount = index === 0 ? 1 : 1e16;
      return {
        ...f.quoted.quotes[index]!,
        fxPairId: pool.pairId,
        originCurrencyId: outputCurrencyId,
        destinationCurrencyId: f.destCurrency,
        sellerInvoiceSource: amount,
        goodsPaymentDest: amount,
        invoiceMidDest: amount,
        transportFeeDest: index === 0 ? 1 : 0,
        importTariffDest: 0,
        consumptionTaxDest: 0,
        buyerDebitDest: index === 0 ? 2 : amount,
      };
    });
    expect(openingCash - 1).toBeLessThan(openingCash);
    expect(1 + 1e16).toBe(1e16); // binary64 witness: old subtraction check misses 1
    const beforeCash = readActorWallet(world, f.buyerActor).get(f.destCurrency);
    const beforePools = selected.map(({ pool }) =>
      new Map(resolveCanonicalFxPool(world, pool.pairId).pool.cash));
    expect(() => reservePhase7QuotedFxLots(world, f.context.tick, quotes))
      .toThrow("cumulative FX payer reservation cannot reconcile across pools");
    expect(readActorWallet(world, f.buyerActor).get(f.destCurrency)).toBe(beforeCash);
    expect(selected.map(({ pool }) =>
      resolveCanonicalFxPool(world, pool.pairId).pool.cash)).toEqual(beforePools);
    expect(world.shipments?.size).toBe(0);

    // A representable two-pool reservation remains supported and deterministic.
    const smallQuotes = quotes.map((quote, index) => index === 0 ? quote : {
      ...quote, sellerInvoiceSource: 16, goodsPaymentDest: 16,
      invoiceMidDest: 16, buyerDebitDest: 16,
    });
    const accepted = reservePhase7QuotedFxLots(world, f.context.tick, smallQuotes);
    expect([...accepted.keys()]).toEqual([0, 1]);
    expect(accepted.get(0)!.quote.requiredInputForFeasibleOutput).toBe(1);
    expect(accepted.get(1)!.quote.requiredInputForFeasibleOutput).toBe(16);
    expect(reservePhase7QuotedFxLots(world, f.context.tick, smallQuotes))
      .toEqual(accepted);
  });

  it("uses explicit auto-reservation mode at Phase-7 close without an outside FX promise", () => {
    const f = fxFixture();
    const phaseHandler: PhaseHandler = (_world, context) => {
      if (context.phase === 1) {
        return { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion };
      }
      if (context.phase === 6) {
        return { ...context, marketPrices: f.context.marketPrices };
      }
      return context;
    };
    const run = () => executeM5LiveQuotedTradeTick(
      f.world, 7, phaseHandler, (_phase, world) => world,
      () => ({
        policy: {
          phase1ImportTariffs: f.context.phase1ImportTariffs,
          phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
          transportFeeCostPolicy: f.context.transportFeeCostPolicy,
        },
        plan: f.input,
        dispatch: {
          remainingCargoWeightByLink: f.state.remainingCargoWeightByLink,
          phase8MainIntents: f.state.phase8MainIntents,
          autoReserveFx: true as const,
        },
      }),
    );
    const committed = run();
    const replay = run();
    expect(committed.phaseTrace).toEqual([...Array(16).keys()]);
    expect(committed.reconciliationErrors).toBeNull();
    expect(committed.context.transactions.filter(tx => tx.type === "FX_OUTPUT"))
      .toHaveLength(1);
    expect(committed.context.transactions).toEqual(replay.context.transactions);
    expect(committed.world.shipments).toEqual(replay.world.shipments);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("refuses FX scarcity before dispatch without changing any world balances", () => {
    const f = fxFixture(true);
    const located = resolveCanonicalFxPool(f.world, f.pairId);
    const pool = located.pool;
    const floor = f.sourceCurrency === pool.baseCurrencyId
      ? pool.minOperationalReserveBase : pool.minOperationalReserveQuote;
    const reducedCash = new Map(pool.cash);
    reducedCash.set(f.sourceCurrency, floor + f.quoted.quotes[0]!.sellerInvoiceSource / 2);
    const authority = f.world.monetaryAuthorities.get(located.owningAuthorityId)!;
    const constrained: WorldState = {
      ...f.world,
      monetaryAuthorities: new Map(f.world.monetaryAuthorities).set(
        located.owningAuthorityId, {
          ...authority,
          fxPools: new Map(authority.fxPools).set(f.pairId, { ...pool, cash: reducedCash }),
        },
      ),
    };
    const openingBuyerCash = readActorWallet(f.world, f.buyerActor).get(f.destCurrency);
    expect(() => reservePhase7QuotedFxLots(
      constrained, f.context.tick, f.quoted.quotes,
    )).toThrow(/quantity shrink/i);
    expect(resolveCanonicalFxPool(f.world, f.pairId).pool.cash).toEqual(pool.cash);
    expect(readActorWallet(f.world, f.buyerActor).get(f.destCurrency))
      .toBe(openingBuyerCash);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("proposes deterministic pre-dispatch FX output and goods ceilings under scarce pool cash", () => {
    const f = fxFixture(true);
    const located = resolveCanonicalFxPool(f.world, f.pairId);
    const pool = located.pool;
    const floor = f.sourceCurrency === pool.baseCurrencyId
      ? pool.minOperationalReserveBase : pool.minOperationalReserveQuote;
    const available = f.quoted.quotes[0]!.sellerInvoiceSource / 2;
    const cash = new Map(pool.cash).set(f.sourceCurrency, floor + available);
    const authority = f.world.monetaryAuthorities.get(located.owningAuthorityId)!;
    const constrained: WorldState = {
      ...f.world,
      monetaryAuthorities: new Map(f.world.monetaryAuthorities).set(
        located.owningAuthorityId, {
          ...authority,
          fxPools: new Map(authority.fxPools).set(f.pairId, { ...pool, cash }),
        },
      ),
    };
    const beforeWallet = readActorWallet(constrained, f.buyerActor).get(f.destCurrency);
    const beforeStock = readMarketActorInventory(constrained, f.sellerActor, "GENERAL").get(GOOD);
    const beforePool = resolveCanonicalFxPool(constrained, f.pairId).pool.cash;
    const result = assessPhase7QuotedFxScarcity(
      constrained, f.context.tick, f.quoted.quotes,
    );
    const replay = assessPhase7QuotedFxScarcity(
      constrained, f.context.tick, f.quoted.quotes,
    );
    const key = phase7FxOutputKey(f.pairId, f.sourceCurrency);
    expect(result).toEqual(replay);
    expect(result.requiresShrink).toBe(true);
    expect([...result.reducedOutputByPairCurrency.keys()]).toEqual([key]);
    const cap = result.reducedOutputByPairCurrency.get(key)!;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(f.quoted.quotes.reduce(
      (sum, quote) => sum + quote.sellerInvoiceSource, 0,
    ));
    expect(result.feasibleQuantityByLotOrdinal.get(0)!).toBeGreaterThan(0);
    expect(result.feasibleQuantityByLotOrdinal.get(0)!)
      .toBeLessThan(f.quoted.quotes[0]!.lot.quantity);
    expect(result.feasibleQuantityByLotOrdinal.get(1)).toBe(0);

    // A caller can use this ceiling in a NEW aggregate match/re-quote pass.
    // These ORIGINAL partial FX promises are never settlement authority.
    const reducedInput = {
      ...f.input,
      fxOutputByPairCurrency: new Map(f.input.fxOutputByPairCurrency).set(key, cap),
    };
    const requoted = quotePhase7ActualMatchedLots(constrained, f.context, reducedInput);
    expect(requoted.quotes.length).toBeGreaterThan(0);
    expect(requoted.quotes.reduce((sum, quote) => sum + quote.lot.quantity, 0))
      .toBeLessThan(f.quoted.quotes.reduce((sum, quote) => sum + quote.lot.quantity, 0));
    const strict = reservePhase7QuotedFxLots(
      constrained, f.context.tick, requoted.quotes,
    );
    expect(strict.size).toBe(requoted.quotes.filter(q => q.fxPairId !== null).length);
    const settled = executePhase7LiveQuotedMixedTradePlan(
      constrained, f.context, reducedInput,
      { ...f.state, fxReservationByLotOrdinal: strict },
    );
    expect(settled.committedLots.length).toBeGreaterThan(0);
    expect(settled.world.shipments!.size).toBeGreaterThan(0);
    expect(readActorWallet(constrained, f.buyerActor).get(f.destCurrency))
      .toBe(beforeWallet);
    expect(readMarketActorInventory(constrained, f.sellerActor, "GENERAL").get(GOOD))
      .toBe(beforeStock);
    expect(resolveCanonicalFxPool(constrained, f.pairId).pool.cash).toEqual(beforePool);
    expect(constrained.shipments?.size).toBe(0);
  });

  it("caps FX at the live pool before the first quote, without an unreachable retry", () => {
    const f = fxFixture(true);
    const located = resolveCanonicalFxPool(f.world, f.pairId);
    const pool = located.pool;
    const floor = f.sourceCurrency === pool.baseCurrencyId
      ? pool.minOperationalReserveBase : pool.minOperationalReserveQuote;
    const available = f.quoted.quotes[0]!.sellerInvoiceSource / 2;
    const authority = f.world.monetaryAuthorities.get(located.owningAuthorityId)!;
    const constrained: WorldState = {
      ...f.world,
      monetaryAuthorities: new Map(f.world.monetaryAuthorities).set(
        located.owningAuthorityId, {
          ...authority,
          fxPools: new Map(authority.fxPools).set(f.pairId, {
            ...pool, cash: new Map(pool.cash).set(f.sourceCurrency, floor + available),
          }),
        },
      ),
    };
    // SLP-907-01: the canonical first pass already reads the live FX pool,
    // constrains the quantity and reserves a fully funded invoice. A smaller
    // shipment alone is NOT evidence that a late scarcity retry ran.
    const firstPass = quotePhase7ActualMatchedLots(constrained, f.context, f.input);
    const firstPassQuantity = firstPass.quotes.reduce(
      (sum, quote) => sum + quote.lot.quantity, 0,
    );
    expect(firstPassQuantity).toBeGreaterThan(0);
    expect(firstPassQuantity).toBeLessThan(2);
    const scarcity = assessPhase7QuotedFxScarcity(
      constrained, f.context.tick, firstPass.quotes,
    );
    expect(scarcity.requiresShrink).toBe(false);
    expect(scarcity.reducedOutputByPairCurrency.size).toBe(0);
    const strict = reservePhase7QuotedFxLots(
      constrained, f.context.tick, firstPass.quotes,
    );
    expect(strict.size).toBe(firstPass.quotes.filter(q => q.fxPairId !== null).length);
    const phaseHandler: PhaseHandler = (_world, context) => {
      if (context.phase === 1) {
        return { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion };
      }
      if (context.phase === 6) {
        return { ...context, marketPrices: f.context.marketPrices };
      }
      return context;
    };
    const run = () => executeM5LiveQuotedTradeTick(
      constrained, f.context.tick, phaseHandler, (_phase, world) => world,
      () => ({
        policy: {
          phase1ImportTariffs: f.context.phase1ImportTariffs,
          phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
          transportFeeCostPolicy: f.context.transportFeeCostPolicy,
        },
        plan: f.input,
        dispatch: {
          remainingCargoWeightByLink: f.state.remainingCargoWeightByLink,
          phase8MainIntents: f.state.phase8MainIntents,
          autoReserveFx: true as const,
        },
      }),
    );
    const committed = run();
    const replay = run();
    expect(committed.reconciliationErrors).toBeNull();
    expect(committed.context.transactions).toEqual(replay.context.transactions);
    expect(committed.world.shipments).toEqual(replay.world.shipments);
    expect(committed.context.transactions.some(tx => tx.type === "FX_OUTPUT")).toBe(true);
    const dispatched = [...committed.world.shipments!.values()]
      .reduce((sum, shipment) => sum + shipment.quantity, 0);
    expect(dispatched).toBeGreaterThan(0);
    expect(dispatched).toBeLessThan(2);
    expect(dispatched).toBeCloseTo(firstPassQuantity, 9);
    expect(constrained.shipments?.size).toBe(0);
    expect(readActorWallet(constrained, f.buyerActor).get(f.destCurrency)).toBe(100);
    expect(readMarketActorInventory(constrained, f.sellerActor, "GENERAL").get(GOOD)).toBe(10);
    expect(resolveCanonicalFxPool(constrained, f.pairId).pool.cash)
      .toEqual(new Map(pool.cash).set(f.sourceCurrency, floor + available));
    expect(f.input.fxOutputByPairCurrency.get(
      phase7FxOutputKey(f.pairId, f.sourceCurrency),
    )).toBeGreaterThan(available);
  });

  it("shrinks against the canonical source price before a real re-quote and strict FX reserve", () => {
    // SLP-906-01: reconstructing a unit price from the rounded invoice
    // falsely accepts 10.2 units whose canonical re-quote exceeds finite FX.
    const f = fxFixture();
    const price = 999999.99;
    const requestedQuantity = 17;
    const invoice = requestedQuantity * price;
    const available = invoice * 0.6;
    const reconstructed = invoice / requestedQuantity;
    const unsafe = available / reconstructed;
    expect(unsafe * reconstructed).toBeLessThanOrEqual(available);
    expect(unsafe * price).toBeGreaterThan(available);

    const located = resolveCanonicalFxPool(f.world, f.pairId);
    const authority = f.world.monetaryAuthorities.get(located.owningAuthorityId)!;
    const pool = {
      ...located.pool,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
      cash: new Map(located.pool.cash).set(f.sourceCurrency, invoice * 2),
    };
    const seller = f.world.cohorts.get(f.sellerActor.cohortId)!;
    const buyer = f.world.cohorts.get(f.buyerActor.cohortId)!;
    const walletsAndStock = new Map(f.world.cohorts);
    walletsAndStock.set(seller.cohortId, {
      ...seller, householdInventory: new Map(seller.householdInventory).set(GOOD, 20),
    });
    walletsAndStock.set(buyer.cohortId, {
      ...buyer, wallet: new Map(buyer.wallet).set(f.destCurrency, 1e9),
    });
    const sourceMarket = [...f.world.markets.values()].find(
      market => market.seed.regionKey === f.origin.seed.key,
    )!;
    const destMarket = [...f.world.markets.values()].find(
      market => market.seed.regionKey === f.destination.seed.key,
    )!;
    const context = {
      ...f.context,
      marketPrices: new Map(f.context.marketPrices)
        .set(marketPriceKey(sourceMarket.marketId, GOOD), price)
        .set(marketPriceKey(destMarket.marketId, GOOD), 50000000),
    };
    const input: Phase7LiveWorldPlanInput = {
      ...f.input,
      residualIntents: f.input.residualIntents.map(entry => ({
        ...entry,
        intent: {
          ...entry.intent, desiredQuantity: requestedQuantity,
          ...(entry.intent.side === "BUY" ? { maxSpend: 1e9 } : {}),
        },
        residualQuantity: requestedQuantity,
        ...(entry.intent.side === "BUY" ? { remainingBuyerSpend: 1e9 } : {}),
      })),
      fxOutputByPairCurrency: new Map([
        [phase7FxOutputKey(f.pairId, f.sourceCurrency), invoice * 2],
      ]),
    };
    const makeWorld = (outputCash: number): WorldState => ({
      ...f.world,
      // A deliberately high-money fixture needs a representable budget delta;
      // strict FX-output feasibility is still compared EXACTLY, not by epsilon.
      simulationConfig: {
        ...f.world.simulationConfig,
        numeric: { ...f.world.simulationConfig.numeric, moneyEpsilon: 1e-6 },
      },
      cohorts: walletsAndStock,
      monetaryAuthorities: new Map(f.world.monetaryAuthorities).set(
        located.owningAuthorityId, {
          ...authority, fxPools: new Map(authority.fxPools).set(f.pairId, {
            ...pool, cash: new Map(pool.cash).set(f.sourceCurrency, outputCash),
          }),
        },
      ),
    });
    const originalWorld = makeWorld(invoice * 2);
    const original = quotePhase7ActualMatchedLots(originalWorld, context, input);
    expect(original.quotes).toHaveLength(1);
    expect(original.quotes[0]!.lot.quantity).toBe(requestedQuantity);
    expect(original.quotes[0]!.sourceSellerNetUnitPrice).toBe(price);
    expect(original.quotes[0]!.sellerInvoiceSource).toBe(invoice);

    const scarce = makeWorld(available);
    const openingBuyer = readActorWallet(scarce, f.buyerActor).get(f.destCurrency);
    const openingSeller = readMarketActorInventory(scarce, f.sellerActor, "GENERAL").get(GOOD);
    const openingPool = resolveCanonicalFxPool(scarce, f.pairId).pool.cash;
    const caps = assessPhase7QuotedFxScarcity(scarce, context.tick, original.quotes);
    expect(caps.requiresShrink).toBe(true);
    const proposed = caps.feasibleQuantityByLotOrdinal.get(0)!;
    expect(proposed).toBeGreaterThan(0);
    expect(proposed).toBeLessThan(unsafe);
    expect(proposed * price).toBeLessThanOrEqual(available);

    const key = phase7FxOutputKey(f.pairId, f.sourceCurrency);
    const reducedInput = {
      ...input,
      fxOutputByPairCurrency: new Map(input.fxOutputByPairCurrency)
        .set(key, caps.reducedOutputByPairCurrency.get(key)!),
    };
    const requoted = quotePhase7ActualMatchedLots(scarce, context, reducedInput);
    expect(requoted.quotes).toHaveLength(1);
    expect(requoted.quotes[0]!.lot.quantity).toBeLessThanOrEqual(proposed);
    expect(requoted.quotes[0]!.sellerInvoiceSource).toBeLessThanOrEqual(available);
    const strict = reservePhase7QuotedFxLots(scarce, context.tick, requoted.quotes);
    expect(strict.get(0)!.quote.feasibleOutputAmount)
      .toBe(requoted.quotes[0]!.sellerInvoiceSource);
    expect(readActorWallet(scarce, f.buyerActor).get(f.destCurrency)).toBe(openingBuyer);
    expect(readMarketActorInventory(scarce, f.sellerActor, "GENERAL").get(GOOD))
      .toBe(openingSeller);
    expect(resolveCanonicalFxPool(scarce, f.pairId).pool.cash).toEqual(openingPool);
    expect(scarce.shipments?.size).toBe(0);
  });

  it("fails closed without canonical net prices or with stale Phase-1 policy; permits no-trade ticks", () => {
    const f = fxFixture();
    const root = f.world;
    const transition = (_phase: number, world: WorldState) => world;
    const phase1Only: PhaseHandler = (_world, context) => context.phase === 1
      ? { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion }
      : context;
    const live: PhaseHandler = (world, context) => context.phase === 6
      ? { ...context, marketPrices: f.context.marketPrices }
      : phase1Only(world, context, world.pendingTransitions);
    const request = {
      policy: {
        phase1ImportTariffs: f.context.phase1ImportTariffs,
        phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
        transportFeeCostPolicy: f.context.transportFeeCostPolicy,
      },
      plan: f.input,
      dispatch: f.state,
    };
    // A missing same-tick Phase-6 override is legal when a carried LocalMarket
    // price exists: Phase 8 uses exactly that fallback. Remove BOTH forms of
    // canonical price authority to make this a real fail-closed negative test.
    const missingMarkets = new Map(root.markets);
    for (const [id, market] of missingMarkets) {
      if (market.seed.regionKey === f.origin.seed.key ||
          market.seed.regionKey === f.destination.seed.key) {
        const prices = new Map(market.priceByGood);
        prices.delete(GOOD);
        missingMarkets.set(id, { ...market, priceByGood: prices });
      }
    }
    const noPriceWorld: WorldState = { ...root, markets: missingMarkets };
    const observed: number[] = [];
    expect(() => executeM5LiveQuotedTradeTick(
      noPriceWorld, 7, phase1Only, transition, () => request,
      phase => { observed.push(phase); },
    )).toThrow(/price/i);
    expect(observed).not.toContain(7);
    expect(root.shipments?.size).toBe(0);
    expect(readActorWallet(root, f.buyerActor).get(f.destCurrency)).toBe(100);
    expect(readMarketActorInventory(root, f.sellerActor, "GENERAL").get(GOOD)).toBe(10);

    expect(() => executeM5LiveQuotedTradeTick(
      root, 7, live, transition,
      () => ({
        ...request,
        policy: {
          ...request.policy,
          phase1ImportTariffs: { ...f.context.phase1ImportTariffs!, tick: 6 },
        },
      }),
    )).toThrow(/current-tick|tariff|policy/i);
    expect(root.shipments?.size).toBe(0);

    const noTrade = executeM5LiveQuotedTradeTick(
      root, 7, noOpPhaseHandler, transition, () => null,
    );
    expect(noTrade.world).toBe(root);
    expect(noTrade.context.transactions).toEqual([]);
    expect(noTrade.phaseTrace).toEqual([...Array(16).keys()]);
  });

});


describe("M5 #673 canonical tick FX discovery: SLP-914-01 integration gate", () => {
  function canonicalDiscovery() {
    const f = fxFixture();
    const pair = resolveCanonicalFxPool(f.world, f.pairId).pool;
    const matches = (pool: typeof pair) =>
      [pool.baseCurrencyId, pool.quoteCurrencyId].includes(f.sourceCurrency) &&
      [pool.baseCurrencyId, pool.quoteCurrencyId].includes(f.destCurrency);
    const uniqueWorld: WorldState = {
      ...f.world,
      monetaryAuthorities: new Map([...f.world.monetaryAuthorities].map(([id, authority]) => [
        id, { ...authority, fxPools: new Map([...authority.fxPools].filter(([pairId, pool]) =>
          pairId === f.pairId || !matches(pool))) },
      ])),
    };
    const missingWorld: WorldState = {
      ...uniqueWorld,
      monetaryAuthorities: new Map([...uniqueWorld.monetaryAuthorities].map(([id, authority]) => [
        id, { ...authority, fxPools: new Map([...authority.fxPools].filter(([pairId]) =>
          pairId !== f.pairId)) },
      ])),
    };
    const seller = f.input.residualIntents.find(e => e.intent.side === "SELL")!.intent;
    const buyer = f.input.residualIntents.find(e => e.intent.side === "BUY")!.intent;
    const handler: PhaseHandler = (_world, context) => {
      if (context.phase === 1) {
        return { ...context, effectiveJurisdictionByRegion: f.context.effectiveJurisdictionByRegion };
      }
      if (context.phase === 2) {
        return { ...context, productionMarketIntents: [seller], householdMarketIntents: [buyer] };
      }
      if (context.phase === 4) return { ...context, phase4MarketAllocations: [] };
      if (context.phase === 6) return { ...context, marketPrices: f.context.marketPrices };
      return context;
    };
    const planId = JSON.stringify(["m5:route", f.link.linkId, GOOD]);
    // Opt-in auto budget mode supplies NO external FX map: canonical live
    // WorldState pool reserves are the only liquidity authority.
    const { fxOutputByPairCurrency: _externalFxBudget, ...budgetFreeInput } = f.input;
    const plan = {
      ...budgetFreeInput,
      opportunityQuotes: f.input.opportunityQuotes.map(q => ({ ...q, planId })),
      fxPairIdByTradePlanId: undefined,
    };
    const request = () => ({
      policy: {
        phase1ImportTariffs: f.context.phase1ImportTariffs,
        phase1ConsumptionTaxes: f.context.phase1ConsumptionTaxes,
        transportFeeCostPolicy: f.context.transportFeeCostPolicy,
      },
      plan,
      authorizedRouteDiscovery: {
        permissions: {
          tick: 7,
          permittedGoodsByDirectedLink: new Map([
            [f.link.linkId, new Map<GoodId, number | null>([[GOOD, null]])],
          ]),
        },
        autoResolveCanonicalFxPairs: true as const,
        autoDeriveCanonicalFxOutputBudgets: true as const,
      },
      dispatch: {
        remainingCargoWeightByLink: f.state.remainingCargoWeightByLink,
        autoReserveFx: true as const,
      },
    });
    const execute = (
      world: WorldState,
      build: Parameters<typeof executeM5CanonicalIntakeTradeTick>[4] = request,
    ) =>
      executeM5CanonicalIntakeTradeTick(
        world, 7, handler, (_phase, current) => current, build,
      );
    return { f, uniqueWorld, missingWorld, request, execute, planId };
  }

  it("executes an actual canonical cross-currency tick with a unique persisted pool and conserved endpoints", () => {
    const { f, uniqueWorld, execute } = canonicalDiscovery();
    const openingBuyer = readActorWallet(uniqueWorld, f.buyerActor).get(f.destCurrency)!;
    const openingSeller = readActorWallet(uniqueWorld, f.sellerActor).get(f.sourceCurrency)!;
    const openingFee = readActorWallet(uniqueWorld, f.feeReceiver).get(f.destCurrency)!;
    const openingTreasury = uniqueWorld.states.get(f.destination.controllerStateId!)!
      .treasury.get(f.destCurrency)!;
    const openingGoods = readMarketActorInventory(uniqueWorld, f.sellerActor, "GENERAL").get(GOOD)!;
    const openingPool = resolveCanonicalFxPool(uniqueWorld, f.pairId).pool.cash;
    const actual = execute(uniqueWorld);
    const replay = execute(uniqueWorld);
    expect(actual.phaseTrace).toEqual([...Array(16).keys()]);
    expect(actual.phaseBoundaryError).toBeUndefined();
    expect(actual.reconciliationErrors).toBeNull();
    const transactions = actual.context.transactions;
    expect(transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH")).toHaveLength(1);
    expect(transactions.filter(tx => tx.type === "FX_INPUT")).toHaveLength(1);
    expect(transactions.filter(tx => tx.type === "FX_OUTPUT")).toHaveLength(1);
    expect(actual.world.shipments?.size).toBe(1);
    const shipped = [...actual.world.shipments!.values()][0]!.quantity;
    expect(shipped).toBeGreaterThan(0);
    expect(openingGoods - readMarketActorInventory(
      actual.world, f.sellerActor, "GENERAL").get(GOOD)!).toBeCloseTo(shipped, 9);
    const sellerPaid = readActorWallet(actual.world, f.sellerActor)
      .get(f.sourceCurrency)! - openingSeller;
    const buyerPaid = openingBuyer - readActorWallet(actual.world, f.buyerActor)
      .get(f.destCurrency)!;
    const transportPaid = readActorWallet(actual.world, f.feeReceiver)
      .get(f.destCurrency)! - openingFee;
    const taxPaid = actual.world.states.get(f.destination.controllerStateId!)!
      .treasury.get(f.destCurrency)! - openingTreasury;
    const settledPool = resolveCanonicalFxPool(actual.world, f.pairId).pool.cash;
    const poolSourceOut = openingPool.get(f.sourceCurrency)! - settledPool.get(f.sourceCurrency)!;
    const poolDestIn = settledPool.get(f.destCurrency)! - openingPool.get(f.destCurrency)!;
    expect(sellerPaid).toBeGreaterThan(0);
    expect(poolSourceOut).toBeCloseTo(sellerPaid, 9);
    expect(buyerPaid).toBeCloseTo(poolDestIn + transportPaid + taxPaid, 9);
    expect(actual.context.transactions).toEqual(replay.context.transactions);
    expect(actual.world.shipments).toEqual(replay.world.shipments);
    expect(uniqueWorld.shipments?.size).toBe(0);
    expect(readActorWallet(uniqueWorld, f.buyerActor).get(f.destCurrency)).toBe(openingBuyer);
    expect(readMarketActorInventory(uniqueWorld, f.sellerActor, "GENERAL").get(GOOD))
      .toBe(openingGoods);
    expect(resolveCanonicalFxPool(uniqueWorld, f.pairId).pool.cash).toEqual(openingPool);
  });

  it("rejects caller FX identity and absent/ambiguous live pools before any shipment or monetary mutation", () => {
    const { f, uniqueWorld, missingWorld, request, execute, planId } = canonicalDiscovery();
    const buyerBefore = readActorWallet(uniqueWorld, f.buyerActor).get(f.destCurrency);
    const sellerBefore = readMarketActorInventory(uniqueWorld, f.sellerActor, "GENERAL").get(GOOD);
    const poolBefore = resolveCanonicalFxPool(uniqueWorld, f.pairId).pool.cash;
    expect(() => execute(uniqueWorld, () => ({
      ...request(),
      plan: {
        ...request().plan,
        fxPairIdByTradePlanId: new Map([[planId, f.pairId]]),
      },
    }))).toThrow("cannot accept a caller FX pair map");
    expect(() => execute(uniqueWorld, () => ({
      ...request(),
      plan: {
        ...request().plan,
        fxOutputByPairCurrency: new Map([["forged", Number.POSITIVE_INFINITY]]),
      },
    }))).toThrow("cannot accept a caller FX budget");
    expect(() => execute(uniqueWorld, () => ({
      ...request(),
      dispatch: {
        remainingCargoWeightByLink: f.state.remainingCargoWeightByLink,
        fxReservationByLotOrdinal: new Map(),
      },
    }))).toThrow("requires canonical pairs and auto reservations");
    expect(() => execute(f.world)).toThrow("exactly one live pool");
    expect(() => execute(missingWorld)).toThrow("exactly one live pool");
    for (const world of [uniqueWorld, f.world, missingWorld]) {
      expect(world.shipments?.size).toBe(0);
      expect(readActorWallet(world, f.buyerActor).get(f.destCurrency)).toBe(buyerBefore);
      expect(readMarketActorInventory(world, f.sellerActor, "GENERAL").get(GOOD))
        .toBe(sellerBefore);
    }
    expect(resolveCanonicalFxPool(uniqueWorld, f.pairId).pool.cash).toEqual(poolBefore);
  });

  it("bypasses FX completely on an authorized same-currency directed link", () => {
    const f = fxFixture();
    const link = [...f.world.transportLinks.values()].find(candidate => {
      const a = f.world.regions.get(candidate.fromRegionId);
      const b = f.world.regions.get(candidate.toRegionId);
      return a && b && a.regionId !== b.regionId &&
        a.controllerStateId === b.controllerStateId &&
        a.settlementCurrencyId === b.settlementCurrencyId &&
        [...f.world.cohorts.values()].some(c => c.seed.regionKey === a.seed.key) &&
        [...f.world.cohorts.values()].some(c => c.seed.regionKey === b.seed.key);
    });
    if (!link) throw new Error("baseline must provide a same-currency directed link");
    const origin = f.world.regions.get(link.fromRegionId)!;
    const destination = f.world.regions.get(link.toRegionId)!;
    const seller = [...f.world.cohorts.values()].find(c => c.seed.regionKey === origin.seed.key)!;
    const buyer = [...f.world.cohorts.values()].find(c => c.seed.regionKey === destination.seed.key)!;
    const currency = origin.settlementCurrencyId;
    const sellerActor: ActorRef = { type: "COHORT", cohortId: seller.cohortId };
    const buyerActor: ActorRef = { type: "COHORT", cohortId: buyer.cohortId };
    const world: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts)
        .set(seller.cohortId, {
          ...seller, householdInventory: new Map(seller.householdInventory).set(GOOD, 10),
        })
        .set(buyer.cohortId, {
          ...buyer, wallet: new Map(buyer.wallet).set(currency, 100),
        }),
      transportLinks: new Map(f.world.transportLinks)
        .set(link.linkId, { ...link, feeReceiver: f.feeReceiver }),
    };
    const sell: MarketIntent = {
      id: createMarketIntentId("mi:phase7:canonical:domestic:sell"),
      actor: sellerActor, regionId: origin.regionId, goodId: GOOD,
      side: "SELL", purpose: "INVENTORY_REBALANCE", desiredQuantity: 2,
      minimumReserveQuantity: 0, sourcePlanId: "plan:phase7:domestic:sell",
    };
    const buy: MarketIntent = {
      id: createMarketIntentId("mi:phase7:canonical:domestic:buy"),
      actor: buyerActor, regionId: destination.regionId, goodId: GOOD,
      side: "BUY", purpose: "CONSUMPTION", desiredQuantity: 2,
      maxSpend: 100, sourcePlanId: "plan:phase7:domestic:buy",
    };
    const sourceMarket = [...world.markets.values()].find(m =>
      m.seed.regionKey === origin.seed.key)!;
    const destinationMarket = [...world.markets.values()].find(m =>
      m.seed.regionKey === destination.seed.key)!;
    const marketPrices = new Map([
      [marketPriceKey(sourceMarket.marketId, GOOD), 3],
      [marketPriceKey(destinationMarket.marketId, GOOD), 100],
    ]);
    const jurisdiction = f.context.effectiveJurisdictionByRegion;
    const handler: PhaseHandler = (_world, context) => {
      if (context.phase === 1) return { ...context, effectiveJurisdictionByRegion: jurisdiction };
      if (context.phase === 2) {
        return { ...context, productionMarketIntents: [sell], householdMarketIntents: [buy] };
      }
      if (context.phase === 4) return { ...context, phase4MarketAllocations: [] };
      if (context.phase === 6) return { ...context, marketPrices };
      return context;
    };
    const planId = JSON.stringify(["m5:route", link.linkId, GOOD]);
    const request = () => ({
      policy: {
        phase1ImportTariffs: {
          tick: 7, ratesByDestinationStateGood: new Map([
            [phase7ImportTariffKey(destination.controllerStateId!, GOOD), 0],
          ]),
        },
        phase1ConsumptionTaxes: {
          tick: 7, ratesByDestinationStateGood: new Map([
            [phase7ConsumptionTaxKey(destination.controllerStateId!, GOOD), 0],
          ]),
          collectionEfficiencyByState: new Map([[destination.controllerStateId!, 1]]),
        },
        transportFeeCostPolicy: f.context.transportFeeCostPolicy,
      },
      plan: {
        ...f.input,
        opportunityQuotes: [{
          ...f.input.opportunityQuotes[0]!, planId,
          linkId: link.linkId, originRegionId: origin.regionId,
          destinationRegionId: destination.regionId,
        }],
        infrastructureFactors: new Map([[link.linkId, 1]]),
        eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>(),
        fxPairIdByTradePlanId: undefined,
        fxOutputByPairCurrency: new Map(),
      },
      authorizedRouteDiscovery: {
        permissions: {
          tick: 7,
          permittedGoodsByDirectedLink: new Map([
            [link.linkId, new Map<GoodId, number | null>([[GOOD, null]])],
          ]),
        },
        autoResolveCanonicalFxPairs: true as const,
      },
      dispatch: {
        remainingCargoWeightByLink: new Map([[link.linkId, 50]]),
        autoReserveFx: true as const,
      },
    });
    const run = () => executeM5CanonicalIntakeTradeTick(
      world, 7, handler, (_phase, current) => current, request,
    );
    const settled = run();
    expect(settled.phaseBoundaryError).toBeUndefined();
    expect(settled.reconciliationErrors).toBeNull();
    expect(settled.context.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH"))
      .toHaveLength(1);
    expect(settled.context.transactions.filter(tx => tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT"))
      .toHaveLength(0);
    expect(settled.world.shipments?.size).toBe(1);
    expect(settled.context.transactions).toEqual(run().context.transactions);
    expect(world.shipments?.size).toBe(0);
    expect(readActorWallet(world, buyerActor).get(currency)).toBe(100);
    expect(readMarketActorInventory(world, sellerActor, "GENERAL").get(GOOD)).toBe(10);
  });
});
