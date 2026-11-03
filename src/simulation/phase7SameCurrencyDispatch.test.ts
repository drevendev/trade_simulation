import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ShipmentId, TransportLinkId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import {
  validateTradeShipmentRegistry, validateTradeShipmentState, type TradeShipmentState,
} from "./tradeShipmentState";
import {
  settleSameCurrencyTradeDispatch, type SameCurrencyDispatchRequest,
} from "./phase7SameCurrencyDispatch";
import { createTransactionBundleId, createTransactionId, noOpPhaseHandler } from "./tickOrchestrator";
import { executeM5ShipmentDeliveryTick } from "./m5ShipmentDeliveryTick";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

function fixture(): {
  world: WorldState;
  request: SameCurrencyDispatchRequest;
  seller: ActorRef;
  buyer: ActorRef;
  receiver: ActorRef;
  destinationState: ActorRef;
} {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 37,
  );
  const cohorts = [...root.cohorts.values()];
  const link = [...root.transportLinks.values()].find((candidate) => {
    const origin = root.regions.get(candidate.fromRegionId);
    const destination = root.regions.get(candidate.toRegionId);
    return origin && destination && candidate.travelTicks !== undefined &&
      origin.settlementCurrencyId === destination.settlementCurrencyId &&
      destination.controllerStateId !== null &&
      cohorts.some((cohort) => cohort.seed.regionKey === origin.seed.key) &&
      cohorts.some((cohort) => cohort.seed.regionKey === destination.seed.key);
  });
  if (!link || link.travelTicks === undefined) throw new Error("Missing same-currency test route");
  const origin = root.regions.get(link.fromRegionId)!;
  const destination = root.regions.get(link.toRegionId)!;
  const sellerCohort = cohorts.find((cohort) => cohort.seed.regionKey === origin.seed.key)!;
  const buyerCohort = cohorts.find((cohort) => cohort.seed.regionKey === destination.seed.key)!;
  const receiverCohort = cohorts.find((cohort) =>
    cohort.cohortId !== sellerCohort.cohortId &&
    cohort.cohortId !== buyerCohort.cohortId,
  )!;
  const currency = destination.settlementCurrencyId;
  const seller: ActorRef = { type: "COHORT", cohortId: sellerCohort.cohortId };
  const buyer: ActorRef = { type: "COHORT", cohortId: buyerCohort.cohortId };
  const receiver: ActorRef = { type: "COHORT", cohortId: receiverCohort.cohortId };
  const destinationState: ActorRef = {
    type: "STATE", stateId: destination.controllerStateId!,
  };
  const patchedCohorts = new Map(root.cohorts);
  patchedCohorts.set(sellerCohort.cohortId, {
    ...sellerCohort, householdInventory: new Map(sellerCohort.householdInventory).set(GOOD, 10),
    wallet: new Map(sellerCohort.wallet).set(currency, 5),
  });
  patchedCohorts.set(buyerCohort.cohortId, {
    ...buyerCohort, wallet: new Map(buyerCohort.wallet).set(currency, 100),
  });
  patchedCohorts.set(receiverCohort.cohortId, {
    ...receiverCohort, wallet: new Map(receiverCohort.wallet).set(currency, 1),
  });
  const world: WorldState = {
    ...root, cohorts: patchedCohorts,
    transportLinks: new Map(root.transportLinks).set(link.linkId, { ...link, feeReceiver: receiver }),
  };
  const shipment: TradeShipmentState = {
    id: "sh:37:test:dispatch:1" as ShipmentId, goodId: GOOD,
    quantity: 2, originRegionId: origin.regionId,
    destinationRegionId: destination.regionId,
    seller, buyer, beneficialOwner: buyer,
    transportLinkId: link.linkId, routeLinkIds: [link.linkId],
    departureTick: 37, arrivalTick: 37 + link.travelTicks,
    status: "IN_TRANSIT", invoiceCurrencyId: currency,
    buyerPaymentCurrencyId: currency, sellerNetUnitPrice: 3,
    buyerGoodsPaymentAmount: 6, transportFeeAmount: 2,
    tariffAmount: 1, consumptionTaxAmount: 0.5,
    destinationInventoryBucket: "GENERAL",
  };
  const request: SameCurrencyDispatchRequest = {
    tick: 37, bundleId: createTransactionBundleId("tb:37:test:dispatch:1"),
    shipment, sellerInventoryBucket: "GENERAL", cargoWeightPerUnit: 1,
    phase1EligibleDirectedLinkIds: new Set<TransportLinkId>([link.linkId]),
    remainingCargoWeightByLink: new Map([[link.linkId, 50]]),
    effectiveJurisdictionByRegion: new Map(
      [...root.regions].map(([id, region]) => [id, region.controllerStateId]),
    ),
    priorTransactions: [],
  };
  return { world, request, seller, buyer, receiver, destinationState };
}

function cash(world: WorldState, actor: ActorRef, request: SameCurrencyDispatchRequest): number {
  return readActorWallet(world, actor).get(request.shipment.buyerPaymentCurrencyId) ?? 0;
}
function stock(world: WorldState, request: SameCurrencyDispatchRequest): number {
  return readMarketActorInventory(
    world, request.shipment.seller, request.sellerInventoryBucket,
  ).get(request.shipment.goodId) ?? 0;
}
function unchanged(world: WorldState, request: SameCurrencyDispatchRequest, act: () => unknown): void {
  const beforeSeller = stock(world, request);
  const beforeWallets = [...world.cohorts].map(([key, c]) => [key, [...c.wallet]]);
  const beforeShipments = [...(world.shipments ?? new Map())];
  const beforeCapacity = [...request.remainingCargoWeightByLink];
  const beforeJournal = [...request.priorTransactions];
  expect(act).toThrow();
  expect(stock(world, request)).toBe(beforeSeller);
  expect([...world.cohorts].map(([key, c]) => [key, [...c.wallet]])).toEqual(beforeWallets);
  expect([...(world.shipments ?? new Map())]).toEqual(beforeShipments);
  expect([...request.remainingCargoWeightByLink]).toEqual(beforeCapacity);
  expect(request.priorTransactions).toEqual(beforeJournal);
}

describe("M5 / #673 atomic prepriced same-currency physical dispatch", () => {
  it("rejects prefix-only bundle IDs before paid dispatch, without mutating inputs", () => {
    const { world, request } = fixture();
    // The typed factory accepts this prefix-only string. The settlement
    // boundary must reject it instead of emitting non-identifying tx:tb: IDs.
    const prefixOnly: SameCurrencyDispatchRequest = {
      ...request, bundleId: createTransactionBundleId("tb:"),
    };
    unchanged(world, prefixOnly,
      () => settleSameCurrencyTradeDispatch(world, prefixOnly));
    expect(() => settleSameCurrencyTradeDispatch(world, prefixOnly))
      .toThrow(/invalid transaction bundle ID/);
    // Properly identified bundles must still settle.
    expect(() => settleSameCurrencyTradeDispatch(world, request)).not.toThrow();
  });

  it("rejects forged frozen duration before same-currency payment and stock commit", () => {
    const f = fixture();
    const link = f.world.transportLinks.get(f.request.shipment.transportLinkId)!;
    const world: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(link.linkId, {
        ...link, travelTicks: 5,
      }),
    };
    // A persisted-shipment validator trusts this caller's internally
    // consistent snapshot, which is correct for previously paid cargo but
    // NOT authority for a new Phase-7 dispatch against the live route.
    const forged: SameCurrencyDispatchRequest = {
      ...f.request,
      shipment: {
        ...f.request.shipment,
        arrivalTick: f.request.tick + 2,
        travelTicksAtDispatch: 2,
      },
    };
    expect(() => validateTradeShipmentState(world, forged.shipment)).not.toThrow();
    unchanged(world, forged, () => settleSameCurrencyTradeDispatch(world, forged));
    expect(() => settleSameCurrencyTradeDispatch(world, forged))
      .toThrow(/arrival tick.*current directed link travel duration/);

    // Valid prepared lots remain payable; the committed record freezes the
    // live duration so later route changes cannot retroactively retime it.
    const legitimate: SameCurrencyDispatchRequest = {
      ...f.request,
      shipment: { ...f.request.shipment, arrivalTick: f.request.tick + 5 },
    };
    const dispatched = settleSameCurrencyTradeDispatch(world, legitimate);
    expect(dispatched.world.shipments?.get(legitimate.shipment.id))
      .toMatchObject({ arrivalTick: f.request.tick + 5, travelTicksAtDispatch: 5 });
    expect(() => validateTradeShipmentRegistry(dispatched.world)).not.toThrow();
  });

  it("keeps real paid cargo in transit until its future Phase-1 tick, with loss only at dispatch", () => {
    const f = fixture();
    const link = f.world.transportLinks.get(f.request.shipment.transportLinkId)!;
    const world: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(link.linkId, {
        ...link, travelTicks: 2,
        seed: { ...link.seed, routinePhysicalLossRate: 0.25 },
      }),
    };
    const shipment: TradeShipmentState = {
      ...f.request.shipment, arrivalTick: f.request.tick + 2,
    };
    const request: SameCurrencyDispatchRequest = { ...f.request, shipment };
    const openingSeller = stock(world, request);
    const openingBuyer = readMarketActorInventory(world, f.buyer, "GENERAL").get(GOOD) ?? 0;

    // Only the Phase-7 dispatch pays the seller and charges transport/taxes.
    const dispatched = settleSameCurrencyTradeDispatch(world, request);
    expect(stock(dispatched.world, request)).toBe(openingSeller - 2);
    expect(dispatched.world.shipments?.get(shipment.id)?.quantity).toBe(1.5);
    expect(dispatched.newTransactions.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS"))
      .toHaveLength(1);
    expect(dispatched.newTransactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
      .toHaveLength(0);

    const noOpTransition = (_phase: number, state: WorldState) => state;
    const waiting = executeM5ShipmentDeliveryTick(
      dispatched.world, request.tick + 1, noOpPhaseHandler, noOpTransition,
    );
    expect(waiting.world.shipments?.get(shipment.id)?.quantity).toBe(1.5);
    expect(waiting.context.transactions).toEqual([]);
    expect(readMarketActorInventory(waiting.world, f.buyer, "GENERAL").get(GOOD) ?? 0)
      .toBe(openingBuyer);

    const arrived = executeM5ShipmentDeliveryTick(
      waiting.world, request.tick + 2, noOpPhaseHandler, noOpTransition,
    );
    expect(arrived.world.shipments?.has(shipment.id)).toBe(false);
    expect(arrived.context.transactions).toMatchObject([{
      type: "SHIPMENT_DELIVERY", phase: 1, tick: request.tick + 2,
      quantity: 1.5, goodId: GOOD,
    }]);
    expect(arrived.context.transactions.every(tx =>
      tx.type !== "GOODS_TRANSPORT_LOSS" && tx.moneyAmount === undefined)).toBe(true);
    expect(readMarketActorInventory(arrived.world, f.buyer, "GENERAL").get(GOOD) ?? 0)
      .toBeCloseTo(openingBuyer + 1.5, 12);
    expect(stock(arrived.world, request)).toBe(openingSeller - 2);
    expect((openingSeller - stock(arrived.world, request)) -
      (readMarketActorInventory(arrived.world, f.buyer, "GENERAL").get(GOOD)! - openingBuyer))
      .toBeCloseTo(0.5, 12);

    const replay = executeM5ShipmentDeliveryTick(
      arrived.world, request.tick + 3, noOpPhaseHandler, noOpTransition,
    );
    expect(replay.context.transactions).toEqual([]);
    expect(replay.world.shipments?.size).toBe(0);
    expect(readMarketActorInventory(replay.world, f.buyer, "GENERAL").get(GOOD))
      .toEqual(readMarketActorInventory(arrived.world, f.buyer, "GENERAL").get(GOOD));
    expect(world.shipments?.size).toBe(0);
  });

  it("destroys directed-link attrition exactly once without a cash refund or arrival re-loss", () => {
    const f = fixture();
    const link = f.world.transportLinks.get(f.request.shipment.transportLinkId)!;
    const world: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(link.linkId, {
        ...link, seed: { ...link.seed, routinePhysicalLossRate: 0.25 },
      }),
    };
    const buyerOpening = readMarketActorInventory(world, f.buyer, "GENERAL").get(GOOD) ?? 0;
    const result = settleSameCurrencyTradeDispatch(world, f.request);
    const transit = result.world.shipments!.get(f.request.shipment.id)!;
    const destruction = result.newTransactions.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS");
    expect(transit.quantity).toBe(1.5);
    expect(stock(result.world, f.request)).toBe(8);
    expect(destruction).toHaveLength(1);
    expect(destruction[0]).toMatchObject({
      bundleId: f.request.bundleId, source: f.buyer, quantity: 0.5, amount: 0.5,
      goodId: GOOD, phase: 7,
    });
    expect(destruction[0]!.moneyAmount).toBeUndefined();
    expect(result.newTransactions.find(tx => tx.type === "TRADE_GOODS_SALE")?.quantity).toBe(2);
    expect(result.newTransactions.find(tx => tx.type === "SHIPMENT_DISPATCH")?.quantity).toBe(1.5);
    expect(10 - stock(result.world, f.request)).toBeCloseTo(transit.quantity + 0.5, 12);
    expect(result.newTransactions.filter(tx => tx.type === "TRANSPORT_FEE")).toHaveLength(1);
    const delivered = deliverDueTradeShipments(result.world, {
      tick: transit.arrivalTick,
      phase: transit.arrivalTick === transit.departureTick ? 7 : 1,
      priorTransactions: result.transactions,
    });
    expect(delivered.world.shipments?.size).toBe(0);
    expect(readMarketActorInventory(delivered.world, f.buyer, "GENERAL").get(GOOD))
      .toBeCloseTo(buyerOpening + 1.5, 12);
    expect(delivered.transactions.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS")).toHaveLength(1);
    const repeat = deliverDueTradeShipments(delivered.world, {
      tick: transit.arrivalTick, phase: transit.arrivalTick === transit.departureTick ? 7 : 1,
      priorTransactions: delivered.transactions,
    });
    expect(repeat.newTransactions).toEqual([]);
  });

  it("commits goods to in-transit stock, all money recipients, capacity and journal together", () => {
    const { world, request, seller, buyer, receiver, destinationState } = fixture();
    const treasuryBefore = cash(world, destinationState, request);
    const sellerBefore = cash(world, seller, request);
    const feeBefore = cash(world, receiver, request);
    const result = settleSameCurrencyTradeDispatch(world, request);
    expect(stock(result.world, request)).toBe(8);
    expect(stock(world, request)).toBe(10);
    expect(result.world.shipments?.get(request.shipment.id)?.quantity).toBe(2);
    expect(result.world.shipments?.size).toBe(1);
    expect(world.shipments?.size).toBe(0);
    expect(result.remainingCargoWeightByLink.get(request.shipment.transportLinkId)).toBe(48);
    expect(request.remainingCargoWeightByLink.get(request.shipment.transportLinkId)).toBe(50);
    expect(cash(result.world, buyer, request)).toBe(90.5);
    expect(cash(result.world, seller, request)).toBe(sellerBefore + 6);
    expect(cash(result.world, receiver, request)).toBe(feeBefore + 2);
    expect(cash(result.world, destinationState, request)).toBe(treasuryBefore + 1.5);
    expect(result.newTransactions.map((tx) => tx.type)).toEqual([
      "TRADE_GOODS_SALE", "TRANSPORT_FEE", "IMPORT_TARIFF",
      "CONSUMPTION_TAX", "SHIPMENT_DISPATCH",
    ]);
    expect(result.newTransactions.every((tx) => tx.bundleId === request.bundleId)).toBe(true);
    expect(new Set(result.newTransactions.map((tx) => tx.transactionId)).size).toBe(5);
    expect(result.transactions).toEqual(result.newTransactions);
    expect(() => validateTradeShipmentRegistry(result.world)).not.toThrow();
  });

  it("is reproducible from equivalent inputs and never mutates caller-owned objects", () => {
    const { world, request } = fixture();
    const one = settleSameCurrencyTradeDispatch(world, request);
    const two = settleSameCurrencyTradeDispatch(world, request);
    expect(one.transactions).toEqual(two.transactions);
    expect([...one.world.shipments!]).toEqual([...two.world.shipments!]);
    expect([...one.remainingCargoWeightByLink]).toEqual([...two.remainingCargoWeightByLink]);
    expect(stock(one.world, request)).toEqual(stock(two.world, request));
    expect(world.shipments?.size).toBe(0);
    expect(request.priorTransactions).toEqual([]);
  });

  it("rejects missing seller goods and impossible buyer money without partial effects", () => {
    const f = fixture();
    const zeroGoods: WorldState = {
      ...f.world, cohorts: new Map(f.world.cohorts).set(
        (f.seller as Extract<ActorRef, {type:"COHORT"}>).cohortId,
        { ...f.world.cohorts.get((f.seller as Extract<ActorRef, {type:"COHORT"}>).cohortId)!,
          householdInventory: new Map([[GOOD, 1]]) },
      ),
    };
    unchanged(zeroGoods, f.request, () => settleSameCurrencyTradeDispatch(zeroGoods, f.request));
    const buyerId = (f.buyer as Extract<ActorRef, {type:"COHORT"}>).cohortId;
    const poorWorld: WorldState = {
      ...f.world, cohorts: new Map(f.world.cohorts).set(buyerId, {
        ...f.world.cohorts.get(buyerId)!,
        wallet: new Map([[f.request.shipment.buyerPaymentCurrencyId, 0]]),
      }),
    };
    unchanged(poorWorld, f.request, () => settleSameCurrencyTradeDispatch(poorWorld, f.request));
  });

  it("rejects unapproved routes and overallocated capacity without journal or stock writes", () => {
    const { world, request } = fixture();
    unchanged(world, { ...request, phase1EligibleDirectedLinkIds: new Set() },
      () => settleSameCurrencyTradeDispatch(world, {
        ...request, phase1EligibleDirectedLinkIds: new Set(),
      }));
    const capacity = { ...request,
      remainingCargoWeightByLink: new Map([[request.shipment.transportLinkId, 1]]) };
    unchanged(world, capacity, () => settleSameCurrencyTradeDispatch(world, capacity));
  });

  it("rejects mismatched currency, invoice and physical actor-region identity", () => {
    const { world, request } = fixture();
    const other = [...world.currencies.keys()].find((id) =>
      id !== request.shipment.invoiceCurrencyId)!;
    unchanged(world, request, () => settleSameCurrencyTradeDispatch(world, {
      ...request, shipment: { ...request.shipment, invoiceCurrencyId: other,
        fxSettlementId: "fxs:wrong" },
    }));
    unchanged(world, request, () => settleSameCurrencyTradeDispatch(world, {
      ...request, shipment: { ...request.shipment, buyerGoodsPaymentAmount: 7 },
    }));
    const swapped = { ...request, shipment: {
      ...request.shipment, seller: request.shipment.buyer,
    }};
    unchanged(world, swapped, () => settleSameCurrencyTradeDispatch(world, swapped));
  });

  it("rejects positive shipment invoices erased or underpaid within absolute money epsilon", () => {
    const { world, request } = fixture();
    const erased = { ...request, shipment: {
      ...request.shipment, sellerNetUnitPrice: 1e-12, buyerGoodsPaymentAmount: 0,
    }};
    unchanged(world, erased, () => settleSameCurrencyTradeDispatch(world, erased));
    const underpaid = { ...request, shipment: {
      ...request.shipment, sellerNetUnitPrice: 1e-12, buyerGoodsPaymentAmount: 1e-16,
    }};
    unchanged(world, underpaid, () => settleSameCurrencyTradeDispatch(world, underpaid));
    const subnormal = { ...request, shipment: {
      ...request.shipment, sellerNetUnitPrice: Number.MIN_VALUE,
      buyerGoodsPaymentAmount: 0,
    }};
    unchanged(world, subnormal, () => settleSameCurrencyTradeDispatch(world, subnormal));
  });

  it("rejects a 49% underpayment even when the entire invoice is below money epsilon", () => {
    const { world, request } = fixture();
    // SLP-874-01: 2 * 5e-11 = 1e-10, but 5.1e-11 pays only 51%.
    // The old min(moneyEpsilon, priced * 0.5) guard accepted this.
    const underpaid = { ...request, shipment: {
      ...request.shipment, sellerNetUnitPrice: 5e-11,
      buyerGoodsPaymentAmount: 5.1e-11,
    }};
    expect(underpaid.shipment.quantity * underpaid.shipment.sellerNetUnitPrice)
      .toBe(1e-10);
    unchanged(world, underpaid,
      () => settleSameCurrencyTradeDispatch(world, underpaid));
  });

  it("accepts the fully paid microscopic invoice without weakening conservation", () => {
    const { world, request, seller, buyer } = fixture();
    const paid = { ...request, shipment: {
      ...request.shipment, sellerNetUnitPrice: 5e-11,
      buyerGoodsPaymentAmount: 1e-10,
    }};
    const result = settleSameCurrencyTradeDispatch(world, paid);
    expect(result.world.shipments?.get(request.shipment.id)?.quantity).toBe(2);
    expect(stock(result.world, paid)).toBe(8);
    expect(cash(result.world, seller, paid)).toBe(cash(world, seller, paid) + 1e-10);
    expect(cash(result.world, buyer, paid)).toBeLessThan(cash(world, buyer, paid));
    expect(stock(world, paid)).toBe(10);
  });

  it("fails closed on missing tax authority or positive fee with no recipient", () => {
    const { world, request } = fixture();
    const jurisdictions = new Map(request.effectiveJurisdictionByRegion);
    jurisdictions.set(request.shipment.destinationRegionId, null);
    const unauthorizedTax = { ...request, effectiveJurisdictionByRegion: jurisdictions };
    unchanged(world, unauthorizedTax,
      () => settleSameCurrencyTradeDispatch(world, unauthorizedTax));
    const link = world.transportLinks.get(request.shipment.transportLinkId)!;
    const noReceiverWorld: WorldState = { ...world,
      transportLinks: new Map(world.transportLinks).set(link.linkId, {
        ...link, feeReceiver: null,
      }),
    };
    unchanged(noReceiverWorld, request,
      () => settleSameCurrencyTradeDispatch(noReceiverWorld, request));
  });

  it("refuses malformed pending cargo before a second paid dispatch, without blocking valid cargo", () => {
    const { world, request } = fixture();
    const first = settleSameCurrencyTradeDispatch(world, request);
    const second: SameCurrencyDispatchRequest = {
      ...request,
      bundleId: createTransactionBundleId("tb:37:test:dispatch:2"),
      shipment: { ...request.shipment, id: "sh:37:test:dispatch:2" as ShipmentId },
      priorTransactions: first.transactions,
      remainingCargoWeightByLink: first.remainingCargoWeightByLink,
    };
    // Multiple legitimate shipments may share a route and owners, with distinct
    // shipment/bundle identities and fully funded independent settlements.
    expect(() => validateTradeShipmentRegistry(first.world)).not.toThrow();
    const legitimate = settleSameCurrencyTradeDispatch(first.world, second);
    expect(legitimate.world.shipments?.size).toBe(2);
    expect(stock(legitimate.world, second)).toBe(6);

    const prior = first.world.shipments!.get(request.shipment.id)!;
    const wrongKey: WorldState = {
      ...first.world,
      shipments: new Map([["sh:37:wrong-key" as ShipmentId, prior]]),
    };
    const wrongBucket: WorldState = {
      ...first.world,
      shipments: new Map<ShipmentId, TradeShipmentState>([
        [prior.id, { ...prior, destinationInventoryBucket: "INPUT" }],
      ]),
    };
    for (const malformed of [wrongKey, wrongBucket]) {
      expect(() => validateTradeShipmentRegistry(malformed)).toThrow();
      unchanged(malformed, second,
        () => settleSameCurrencyTradeDispatch(malformed, second));
    }
  });

  it("rejects replayed shipment and transaction identity before money or stock leaves again", () => {
    const { world, request } = fixture();
    const committed = settleSameCurrencyTradeDispatch(world, request);
    const repeated = { ...request, priorTransactions: committed.transactions,
      remainingCargoWeightByLink: committed.remainingCargoWeightByLink };
    unchanged(committed.world, repeated,
      () => settleSameCurrencyTradeDispatch(committed.world, repeated));
    const journalOnly = { ...request, priorTransactions: committed.transactions };
    unchanged(world, journalOnly, () => settleSameCurrencyTradeDispatch(world, journalOnly));
  });

  it("rejects pre-existing duplicate journal transaction IDs even when unrelated to this lot", () => {
    const { world, request } = fixture();
    const sample = settleSameCurrencyTradeDispatch(world, request).newTransactions[0]!;
    const prior = {
      ...sample,
      transactionId: createTransactionId("tx:prior:independent:1"),
      bundleId: createTransactionBundleId("tb:prior:independent:1"),
    };
    const legitimate = { ...request, priorTransactions: [prior] };
    const validResult = settleSameCurrencyTradeDispatch(world, legitimate);
    expect(validResult.transactions).toHaveLength(validResult.newTransactions.length + 1);

    // Distinct bundle IDs do not make reuse of a transaction ID safe.
    const duplicate = {
      ...prior, bundleId: createTransactionBundleId("tb:prior:independent:2"),
    };
    const corrupted = { ...request, priorTransactions: [prior, duplicate] };
    unchanged(world, corrupted,
      () => settleSameCurrencyTradeDispatch(world, corrupted));
    expect(() => settleSameCurrencyTradeDispatch(world, corrupted))
      .toThrow(/duplicate committed journal transaction identity/);
  });

  it("rejects unobservable microscopic physical debit or cargo capacity use", () => {
    const f = fixture();
    const sellerId = (f.seller as Extract<ActorRef, {type:"COHORT"}>).cohortId;
    const enormousWorld: WorldState = {
      ...f.world, cohorts: new Map(f.world.cohorts).set(sellerId, {
        ...f.world.cohorts.get(sellerId)!,
        householdInventory: new Map([[GOOD, 1e16]]),
      }),
    };
    const tiny = { ...f.request, shipment: {
      ...f.request.shipment, quantity: 1,
      buyerGoodsPaymentAmount: 3,
    }};
    unchanged(enormousWorld, tiny,
      () => settleSameCurrencyTradeDispatch(enormousWorld, tiny));
    const enormousCapacity = { ...tiny,
      remainingCargoWeightByLink: new Map([[f.request.shipment.transportLinkId, 1e16]]) };
    unchanged(f.world, enormousCapacity,
      () => settleSameCurrencyTradeDispatch(f.world, enormousCapacity));
  });
});

describe("M5 #673 canonical cargo mass at same-currency settlement", () => {
  it("refuses spoofed mass or invalid GoodDefinition before any cash, goods or journal mutation", () => {
    const f = fixture();
    const spoofed: SameCurrencyDispatchRequest = {
      ...f.request, cargoWeightPerUnit: 0.01,
    };
    unchanged(f.world, spoofed, () =>
      settleSameCurrencyTradeDispatch(f.world, spoofed));

    const original = f.world.definitionRegistry.goods[GOOD]!;
    const withDefinition = (definition: typeof original): WorldState => ({
      ...f.world,
      definitionRegistry: {
        ...f.world.definitionRegistry,
        goods: { ...f.world.definitionRegistry.goods, [GOOD]: definition },
      },
    });
    for (const definition of [
      { ...original, cargoWeightPerUnit: 3 },
      { ...original, cargoWeightPerUnit: Number.NaN },
      { ...original, tradable: false },
    ]) {
      const altered = withDefinition(definition);
      unchanged(altered, f.request, () =>
        settleSameCurrencyTradeDispatch(altered, f.request));
    }

    // A legitimate heavier definition must debit the full canonical mass.
    const heavy = withDefinition({ ...original, cargoWeightPerUnit: 3 });
    const aligned: SameCurrencyDispatchRequest = {
      ...f.request, cargoWeightPerUnit: 3,
    };
    const settled = settleSameCurrencyTradeDispatch(heavy, aligned);
    expect(settled.remainingCargoWeightByLink.get(aligned.shipment.transportLinkId)).toBe(44);
    expect(stock(settled.world, aligned)).toBe(8);
    expect(settled.newTransactions.filter(tx => tx.type === "SHIPMENT_DISPATCH")).toHaveLength(1);
  });
});
