import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ShipmentId, TransportLinkId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { validateTradeShipmentRegistry } from "./tradeShipmentState";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";
import { createFxSettlementId, createTransactionBundleId } from "./tickOrchestrator";
import {
  settleCrossCurrencyTradeDispatch, type CrossCurrencyDispatchRequest,
} from "./phase7CrossCurrencyDispatch";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

function fixture(reservedOutput = 30) {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const cohorts = [...root.cohorts.values()];
  const pools = [...root.monetaryAuthorities.values()].flatMap((authority) =>
    [...authority.fxPools.keys()]);
  const match = [...root.transportLinks.values()].flatMap((link) => {
    const origin = root.regions.get(link.fromRegionId);
    const destination = root.regions.get(link.toRegionId);
    if (!origin || !destination || link.travelTicks === undefined ||
        origin.settlementCurrencyId === destination.settlementCurrencyId) return [];
    const pairId = pools.find((id) => {
      const pool = resolveCanonicalFxPool(root, id).pool;
      return (pool.baseCurrencyId === origin.settlementCurrencyId &&
        pool.quoteCurrencyId === destination.settlementCurrencyId) ||
        (pool.quoteCurrencyId === origin.settlementCurrencyId &&
          pool.baseCurrencyId === destination.settlementCurrencyId);
    });
    const sellerCohort = cohorts.find((cohort) =>
      cohort.seed.regionKey === origin.seed.key);
    const buyerCohort = cohorts.find((cohort) =>
      cohort.seed.regionKey === destination.seed.key);
    const receiverCohort = cohorts.find((cohort) =>
      cohort.seed.regionKey === origin.seed.key &&
      cohort.cohortId !== sellerCohort?.cohortId);
    return pairId && sellerCohort && buyerCohort && receiverCohort &&
      destination.controllerStateId
      ? [{ link, origin, destination, pairId, sellerCohort, buyerCohort, receiverCohort }]
      : [];
  })[0];
  if (!match) throw new Error("baseline lacks a paired cross-currency directed trade route");
  const { link, origin, destination, pairId,
    sellerCohort, buyerCohort, receiverCohort } = match;
  const seller: ActorRef = { type: "COHORT", cohortId: sellerCohort.cohortId };
  const buyer: ActorRef = { type: "COHORT", cohortId: buyerCohort.cohortId };
  const receiver: ActorRef = { type: "COHORT", cohortId: receiverCohort.cohortId };
  const treasury: ActorRef = { type: "STATE", stateId: destination.controllerStateId! };
  const sourceCurrency = origin.settlementCurrencyId;
  const destinationCurrency = destination.settlementCurrencyId;
  const cohortsNext = new Map(root.cohorts);
  cohortsNext.set(sellerCohort.cohortId, {
    ...sellerCohort, householdInventory:
      new Map(sellerCohort.householdInventory).set(GOOD, 10),
    wallet: new Map(sellerCohort.wallet).set(sourceCurrency, 5),
  });
  cohortsNext.set(buyerCohort.cohortId, {
    ...buyerCohort, wallet: new Map(buyerCohort.wallet).set(destinationCurrency, 100),
  });
  cohortsNext.set(receiverCohort.cohortId, {
    ...receiverCohort, wallet: new Map(receiverCohort.wallet).set(destinationCurrency, 1),
  });
  const world: WorldState = {
    ...root, cohorts: cohortsNext,
    transportLinks: new Map(root.transportLinks).set(link.linkId, {
      ...link, feeReceiver: receiver,
    }),
  };
  const reservation = {
    tick: 7,
    requestId: "fx:req:dispatch-7",
    payerKey: actorRefKey(buyer),
    quote: quoteFx(world, pairId, destinationCurrency, sourceCurrency,
      reservedOutput, { maxInputAmount: 100 }),
  };
  const request: CrossCurrencyDispatchRequest = {
    tick: 7,
    bundleId: createTransactionBundleId("tb:7:cross:1"),
    settlementId: createFxSettlementId("fxs:7:cross:1"),
    shipmentId: "sh:7:cross:1" as ShipmentId,
    originRegionId: origin.regionId,
    destinationRegionId: destination.regionId,
    transportLinkId: link.linkId,
    goodId: GOOD, seller, buyer,
    sellerInventoryBucket: "GENERAL",
    destinationInventoryBucket: "GENERAL",
    plannedQuantity: 2, sourceSellerNetUnitPrice: 3,
    cargoWeightPerUnit: 1,
    transportFeePerUnitDest: 0.5,
    tariffPerUnitDest: 0.25,
    consumptionTaxPerUnitDest: 0.25,
    fxPairId: pairId, reservation,
    phase1EligibleDirectedLinkIds: new Set<TransportLinkId>([link.linkId]),
    effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId]),
    ),
    remainingCargoWeightByLink: new Map([[link.linkId, 50]]),
    priorTransactions: [],
  };
  return { world, request, seller, buyer, receiver, treasury,
    sourceCurrency, destinationCurrency };
}

function cash(world: WorldState, actor: ActorRef, currency: string): number {
  return readActorWallet(world, actor).get(
    currency as ReturnType<typeof readActorWallet> extends ReadonlyMap<infer K, number>
      ? K : never,
  ) ?? 0;
}
function stock(world: WorldState, request: CrossCurrencyDispatchRequest): number {
  return readMarketActorInventory(
    world, request.seller, request.sellerInventoryBucket,
  ).get(request.goodId) ?? 0;
}
function snapshot(world: WorldState, request: CrossCurrencyDispatchRequest) {
  const pool = resolveCanonicalFxPool(world, request.fxPairId).pool;
  return {
    sellerStock: stock(world, request),
    buyerCash: [...readActorWallet(world, request.buyer)],
    sellerCash: [...readActorWallet(world, request.seller)],
    poolCash: [...pool.cash],
    shipments: [...(world.shipments ?? new Map())],
    capacity: [...request.remainingCargoWeightByLink],
    journal: [...request.priorTransactions],
  };
}
function unchanged(world: WorldState, request: CrossCurrencyDispatchRequest,
  call: () => unknown) {
  const before = snapshot(world, request);
  expect(call).toThrow();
  expect(snapshot(world, request)).toEqual(before);
}

describe("M5 #673 atomic cross-currency Phase-7 dispatch", () => {
  it("keeps the gross FX invoice, destroys routine cargo once and delivers only survivors", () => {
    const f = fixture();
    const link = f.world.transportLinks.get(f.request.transportLinkId)!;
    const world: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(link.linkId, {
        ...link, seed: { ...link.seed, routinePhysicalLossRate: 0.25 },
      }),
    };
    const buyerOpening = readMarketActorInventory(world, f.buyer, "GENERAL").get(GOOD) ?? 0;
    const result = settleCrossCurrencyTradeDispatch(world, f.request)!;
    const replay = settleCrossCurrencyTradeDispatch(world, f.request)!;
    expect(result.transactions).toEqual(replay.transactions);
    expect(result.shipment.quantity).toBe(1.5);
    expect(result.sizing.quantity).toBe(2);
    expect(result.fxReceipt.outputAmount).toBe(6);
    expect(stock(result.world, f.request)).toBe(8);
    const destroyed = result.newTransactions.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({
      source: f.buyer, goodId: GOOD, quantity: 0.5, amount: 0.5,
      bundleId: f.request.bundleId,
    });
    expect(destroyed[0]!.currencyId).toBeUndefined();
    expect(destroyed[0]!.moneyAmount).toBeUndefined();
    expect(result.newTransactions.find(tx => tx.type === "SHIPMENT_DISPATCH")?.quantity).toBe(1.5);
    expect(result.newTransactions.find(tx => tx.type === "TRADE_GOODS_SALE")?.quantity).toBe(2);
    const delivered = deliverDueTradeShipments(result.world, {
      tick: result.shipment.arrivalTick,
      phase: result.shipment.arrivalTick === result.shipment.departureTick ? 7 : 1,
      priorTransactions: result.transactions,
    });
    expect(readMarketActorInventory(delivered.world, f.buyer, "GENERAL").get(GOOD))
      .toBeCloseTo(buyerOpening + 1.5, 12);
    expect(delivered.transactions.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS")).toHaveLength(1);
  });

  it("rejects unrepresentable physical attrition before any FX, goods or journal effects", () => {
    const f = fixture();
    const link = f.world.transportLinks.get(f.request.transportLinkId)!;
    const world: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(link.linkId, {
        ...link, seed: { ...link.seed, routinePhysicalLossRate: 1 - Number.EPSILON },
      }),
    };
    unchanged(world, f.request, () => settleCrossCurrencyTradeDispatch(world, f.request));
  });

  it("commits one FX pair, seller goods, destination fees and shipment as one bundle", () => {
    const f = fixture();
    const { world, request } = f;
    const beforePool = resolveCanonicalFxPool(world, request.fxPairId).pool;
    const beforeSeller = cash(world, f.seller, f.sourceCurrency);
    const beforeBuyer = cash(world, f.buyer, f.destinationCurrency);
    const beforeFee = cash(world, f.receiver, f.destinationCurrency);
    const beforeTax = cash(world, f.treasury, f.destinationCurrency);
    const result = settleCrossCurrencyTradeDispatch(world, request)!;
    expect(result).not.toBeNull();
    expect(result.shipment.quantity).toBe(2);
    expect(result.shipment.destinationInventoryBucket).toBe("GENERAL");
    expect(result.shipment.buyerGoodsPaymentAmount).toBe(result.fxReceipt.inputAmount);
    expect(result.fxReceipt.outputAmount).toBe(6);
    expect(stock(result.world, request)).toBe(8);
    expect(stock(world, request)).toBe(10);
    expect(result.world.shipments?.get(request.shipmentId)).toEqual(result.shipment);
    expect(world.shipments?.size).toBe(0);
    expect(result.remainingCargoWeightByLink.get(request.transportLinkId)).toBe(48);
    expect(request.remainingCargoWeightByLink.get(request.transportLinkId)).toBe(50);
    expect(cash(result.world, f.seller, f.sourceCurrency) - beforeSeller).toBe(6);
    expect(beforeBuyer - cash(result.world, f.buyer, f.destinationCurrency))
      .toBeCloseTo(result.fxReceipt.inputAmount + 2, 9);
    expect(cash(result.world, f.receiver, f.destinationCurrency) - beforeFee).toBe(1);
    expect(cash(result.world, f.treasury, f.destinationCurrency) - beforeTax).toBe(1);
    const afterPool = resolveCanonicalFxPool(result.world, request.fxPairId).pool;
    expect(afterPool.cash.get(f.destinationCurrency)! -
      beforePool.cash.get(f.destinationCurrency)!).toBeCloseTo(
      result.fxReceipt.inputAmount, 9);
    expect(beforePool.cash.get(f.sourceCurrency)! -
      afterPool.cash.get(f.sourceCurrency)!).toBe(6);
    expect(result.newTransactions.map((tx) => tx.type)).toEqual([
      "TRADE_GOODS_SALE", "FX_INPUT", "FX_OUTPUT",
      "TRANSPORT_FEE", "IMPORT_TARIFF", "CONSUMPTION_TAX",
      "SHIPMENT_DISPATCH",
    ]);
    expect(result.newTransactions.filter((tx) => tx.type === "FX_OUTPUT")).toHaveLength(1);
    expect(result.newTransactions.every((tx) => tx.bundleId === request.bundleId)).toBe(true);
    expect(new Set(result.newTransactions.map((tx) => tx.transactionId)).size).toBe(7);
    expect(() => validateTradeShipmentRegistry(result.world)).not.toThrow();
    // The invoice is informational: FX_OUTPUT supplies the actual seller money.
    expect(result.newTransactions.find((tx) => tx.type === "TRADE_GOODS_SALE")?.reason)
      .toMatch(/NONPOSTING/);
  });

  it("shrinks a reserved FX lot before goods move and recalculates every destination charge", () => {
    const f = fixture(3);
    const result = settleCrossCurrencyTradeDispatch(f.world, f.request)!;
    expect(result.shipment.quantity).toBeGreaterThan(0);
    expect(result.shipment.quantity).toBeLessThan(2);
    expect(result.fxReceipt.outputAmount).toBe(result.shipment.quantity * 3);
    expect(result.shipment.tariffAmount).toBe(result.shipment.quantity * 0.25);
    expect(result.shipment.transportFeeAmount).toBe(result.shipment.quantity * 0.5);
    expect(result.shipment.consumptionTaxAmount).toBe(result.shipment.quantity * 0.25);
    expect(stock(f.world, f.request)).toBe(10);
    expect(stock(result.world, f.request))
      .toBeCloseTo(10 - result.shipment.quantity, 12);
    expect(result.remainingCargoWeightByLink.get(f.request.transportLinkId))
      .toBe(50 - result.shipment.quantity);
  });

  it("replays deterministically without changing caller-owned state, journal or pool", () => {
    const f = fixture();
    const before = snapshot(f.world, f.request);
    const a = settleCrossCurrencyTradeDispatch(f.world, f.request)!;
    const b = settleCrossCurrencyTradeDispatch(f.world, f.request)!;
    expect(a.sizing).toEqual(b.sizing);
    expect(a.transactions).toEqual(b.transactions);
    expect([...a.world.shipments!]).toEqual([...b.world.shipments!]);
    expect([...a.remainingCargoWeightByLink]).toEqual([...b.remainingCargoWeightByLink]);
    expect(snapshot(f.world, f.request)).toEqual(before);
  });

  it("rejects stale reservation, illegal link and duplicate execution without partial posting", () => {
    const f = fixture();
    unchanged(f.world, f.request, () => settleCrossCurrencyTradeDispatch(f.world, {
      ...f.request, reservation: { ...f.request.reservation, tick: 6 },
    }));
    unchanged(f.world, f.request, () => settleCrossCurrencyTradeDispatch(f.world, {
      ...f.request, phase1EligibleDirectedLinkIds: new Set(),
    }));
    const first = settleCrossCurrencyTradeDispatch(f.world, f.request)!;
    const repeated = { ...f.request, priorTransactions: first.transactions,
      remainingCargoWeightByLink: first.remainingCargoWeightByLink };
    unchanged(first.world, repeated,
      () => settleCrossCurrencyTradeDispatch(first.world, repeated));
  });

  it("refuses missing fee receiver or destination tax authority and keeps source world intact", () => {
    const f = fixture();
    const link = f.world.transportLinks.get(f.request.transportLinkId)!;
    const missingReceiver: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(link.linkId, {
        ...link, feeReceiver: null,
      }),
    };
    unchanged(missingReceiver, f.request,
      () => settleCrossCurrencyTradeDispatch(missingReceiver, f.request));
    const noController = new Map(f.request.effectiveJurisdictionByRegion);
    noController.set(f.request.destinationRegionId, null);
    unchanged(f.world, f.request, () => settleCrossCurrencyTradeDispatch(f.world, {
      ...f.request, effectiveJurisdictionByRegion: noController,
    }));
  });

  it("fails FX seller-credit precision without removing goods or publishing any journal", () => {
    const f = fixture();
    if (f.seller.type !== "COHORT") throw new Error("fixture needs a cohort seller");
    const c = f.world.cohorts.get(f.seller.cohortId)!;
    const huge: WorldState = { ...f.world,
      cohorts: new Map(f.world.cohorts).set(f.seller.cohortId, {
        ...c, wallet: new Map(c.wallet).set(f.sourceCurrency, 1e16),
      }),
    };
    // A +6 balance change at 1e16 is representable; +3 rounds up to +4.
    const oneUnit = { ...f.request, plannedQuantity: 1 };
    unchanged(huge, oneUnit, () => settleCrossCurrencyTradeDispatch(huge, oneUnit));
  });

  it("rolls back a fee-recipient precision failure that occurs AFTER FX staging", () => {
    const f = fixture();
    if (f.receiver.type !== "COHORT") throw new Error("fixture needs cohort receiver");
    const c = f.world.cohorts.get(f.receiver.cohortId)!;
    const huge: WorldState = { ...f.world,
      cohorts: new Map(f.world.cohorts).set(f.receiver.cohortId, {
        ...c, wallet: new Map(c.wallet).set(f.destinationCurrency, 1e16),
      }),
    };
    unchanged(huge, f.request, () => settleCrossCurrencyTradeDispatch(huge, f.request));
  });

  it("fails an unobservable physical stock removal before attempting FX", () => {
    const f = fixture();
    if (f.seller.type !== "COHORT") throw new Error("fixture needs cohort seller");
    const c = f.world.cohorts.get(f.seller.cohortId)!;
    const huge: WorldState = { ...f.world,
      cohorts: new Map(f.world.cohorts).set(f.seller.cohortId, {
        ...c, householdInventory: new Map(c.householdInventory).set(GOOD, 1e16),
      }),
    };
    // Subtracting 2 from 1e16 is representable; subtracting 1 is not.
    const oneUnit = { ...f.request, plannedQuantity: 1 };
    unchanged(huge, oneUnit, () => settleCrossCurrencyTradeDispatch(huge, oneUnit));
  });

  it("preserves a foreign transport receiver's destination-currency funds without implicit FX", () => {
    const f = fixture();
    const origin = f.world.regions.get(f.request.originRegionId)!;
    const destination = f.world.regions.get(f.request.destinationRegionId)!;
    expect(origin.settlementCurrencyId).not.toBe(destination.settlementCurrencyId);
    expect(f.receiver.type).toBe("COHORT");
    const result = settleCrossCurrencyTradeDispatch(f.world, f.request)!;
    expect(cash(result.world, f.receiver, f.destinationCurrency))
      .toBe(cash(f.world, f.receiver, f.destinationCurrency) + 1);
    expect(result.newTransactions.filter((tx) => tx.type === "FX_INPUT")).toHaveLength(1);
  });
});
