import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ShipmentId, TransportLinkId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";
import { validateTradeShipmentRegistry, type TradeShipmentState } from "./tradeShipmentState";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

function mixedArrivalFixture() {
  const root = buildInitialWorld(baselineScenario, baselineDefinitionPack,
    createDefaultSimulationConfig(), 37);
  const route = [...root.transportLinks.values()].find(link =>
    link.fromRegionId !== link.toRegionId && link.travelTicks !== undefined);
  const states = [...root.states.values()];
  if (!route || states.length < 2) throw new Error("Missing interregional fixture");

  // One directed route takes two ticks; a second parallel route arrives at
  // Phase-7 close. Both shipments are already paid and beneficially owned by
  // the same State, so arrival must only move physical goods, never money.
  const instantLinkId = (route.linkId + ":instant") as TransportLinkId;
  const world: WorldState = {
    ...root,
    transportLinks: new Map(root.transportLinks)
      .set(route.linkId, { ...route, travelTicks: 2 })
      .set(instantLinkId, { ...route, linkId: instantLinkId, travelTicks: 0 }),
  };
  const seller: ActorRef = { type: "STATE", stateId: states[0]!.stateId };
  const buyer: ActorRef = { type: "STATE", stateId: states[1]!.stateId };
  const sourceCurrency = world.regions.get(route.fromRegionId)!.settlementCurrencyId;
  const destinationCurrency = world.regions.get(route.toRegionId)!.settlementCurrencyId;
  const slow: TradeShipmentState = {
    id: "sh:delivery:mixed:slow" as ShipmentId,
    goodId: GOOD, quantity: 3,
    originRegionId: route.fromRegionId,
    destinationRegionId: route.toRegionId,
    seller, buyer, beneficialOwner: buyer,
    routeLinkIds: [route.linkId], transportLinkId: route.linkId,
    departureTick: 8, arrivalTick: 10, status: "IN_TRANSIT",
    invoiceCurrencyId: sourceCurrency,
    buyerPaymentCurrencyId: destinationCurrency,
    sellerNetUnitPrice: 10, buyerGoodsPaymentAmount: 30,
    transportFeeAmount: 0, tariffAmount: 0, consumptionTaxAmount: 0,
    ...(sourceCurrency === destinationCurrency ? {}
      : { fxSettlementId: "fxs:delivery:mixed:slow" }),
    destinationInventoryBucket: "GENERAL",
  };
  const instant: TradeShipmentState = {
    ...slow,
    id: "sh:delivery:mixed:instant" as ShipmentId, quantity: 2,
    transportLinkId: instantLinkId, routeLinkIds: [instantLinkId],
    arrivalTick: 8, buyerGoodsPaymentAmount: 20,
    ...(sourceCurrency === destinationCurrency ? {}
      : { fxSettlementId: "fxs:delivery:mixed:instant" }),
  };
  const makeWorld = (entries: readonly TradeShipmentState[]): WorldState => ({
    ...world, shipments: new Map(entries.map(entry => [entry.id, entry])),
  });
  return { buyer, slow, instant,
    forward: makeWorld([slow, instant]),
    reverse: makeWorld([instant, slow]) };
}

function buyerGoods(world: WorldState, buyer: ActorRef): number {
  if (buyer.type !== "STATE") throw new Error("Expected State owner");
  return world.states.get(buyer.stateId)!.publicInventory.get(GOOD) ?? 0;
}
function transitGoods(world: WorldState): number {
  return [...(world.shipments?.values() ?? [])].reduce((sum, cargo) => sum + cargo.quantity, 0);
}

describe("M5 #674 mixed same-tick and future-tick cargo conservation", () => {
  it("delivers zero-travel in Phase 7, carries delayed goods to Phase 1, and replays deterministically", () => {
    const { buyer, slow, instant, forward, reverse } = mixedArrivalFixture();
    if (buyer.type !== "STATE") throw new Error("Expected State buyer");
    const beforeGoods = buyerGoods(forward, buyer);
    const openingTotal = beforeGoods + transitGoods(forward);
    const beforeStates = forward.states;
    const beforeShipments = forward.shipments;
    expect(() => validateTradeShipmentRegistry(forward)).not.toThrow();

    // The post-dispatch registry cannot be presented as Phase-1 opening state.
    expect(() => deliverDueTradeShipments(forward,
      { tick: 8, phase: 1, priorTransactions: [] })).toThrow(/Phase-7 close/);

    const phase7 = { tick: 8, phase: 7 as const, priorTransactions: [] };
    const sameTick = deliverDueTradeShipments(forward, phase7);
    const reordered = deliverDueTradeShipments(reverse, phase7);
    expect(sameTick.deliveredShipmentIds).toEqual([instant.id]);
    expect(reordered.deliveredShipmentIds).toEqual(sameTick.deliveredShipmentIds);
    expect(reordered.newTransactions).toEqual(sameTick.newTransactions);
    expect(sameTick.newTransactions).toHaveLength(1);
    expect(sameTick.newTransactions[0]).toMatchObject({
      type: "SHIPMENT_DELIVERY", tick: 8, phase: 7, quantity: 2,
      destination: buyer,
    });
    expect(sameTick.newTransactions[0]?.moneyAmount).toBeUndefined();
    expect(buyerGoods(sameTick.world, buyer)).toBe(beforeGoods + instant.quantity);
    expect(sameTick.world.shipments?.size).toBe(1);
    expect(sameTick.world.shipments?.get(slow.id)).toBe(slow);
    expect(buyerGoods(sameTick.world, buyer) + transitGoods(sameTick.world))
      .toBe(openingTotal);
    expect(forward.states).toBe(beforeStates);
    expect(forward.shipments).toBe(beforeShipments);
    expect(forward.shipments?.size).toBe(2);
    expect(buyerGoods(forward, buyer)).toBe(beforeGoods);

    // Replaying the already committed Phase-7 close must not credit the first lot.
    const replay7 = deliverDueTradeShipments(sameTick.world, {
      ...phase7, priorTransactions: sameTick.transactions,
    });
    expect(replay7.world).toBe(sameTick.world);
    expect(replay7.newTransactions).toEqual([]);

    const early = deliverDueTradeShipments(sameTick.world,
      { tick: 9, phase: 1, priorTransactions: [] });
    expect(early.world).toBe(sameTick.world);
    expect(early.deliveredShipmentIds).toEqual([]);

    const arrival = deliverDueTradeShipments(early.world,
      { tick: 10, phase: 1, priorTransactions: [] });
    expect(arrival.deliveredShipmentIds).toEqual([slow.id]);
    expect(arrival.newTransactions).toHaveLength(1);
    expect(arrival.newTransactions[0]).toMatchObject({
      type: "SHIPMENT_DELIVERY", tick: 10, phase: 1, quantity: 3,
      destination: buyer,
    });
    expect(arrival.newTransactions[0]?.moneyAmount).toBeUndefined();
    expect(arrival.world.shipments?.size).toBe(0);
    expect(buyerGoods(arrival.world, buyer)).toBe(beforeGoods + 5);
    expect(buyerGoods(arrival.world, buyer) + transitGoods(arrival.world))
      .toBe(openingTotal);
    expect(arrival.world.states.get(buyer.stateId)!.treasury)
      .toEqual(forward.states.get(buyer.stateId)!.treasury);
    expect(() => validateTradeShipmentRegistry(arrival.world)).not.toThrow();

    const replay1 = deliverDueTradeShipments(arrival.world, {
      tick: 10, phase: 1, priorTransactions: arrival.transactions,
    });
    expect(replay1.world).toBe(arrival.world);
    expect(replay1.newTransactions).toEqual([]);
  });
});
