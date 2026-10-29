import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ShipmentId, TransportLinkId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import { validateTradeShipmentRegistry, type TradeShipmentState } from "./tradeShipmentState";
import {
  settleSameCurrencyTradeDispatch, type SameCurrencyDispatchRequest,
} from "./phase7SameCurrencyDispatch";
import { createTransactionBundleId } from "./tickOrchestrator";
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
