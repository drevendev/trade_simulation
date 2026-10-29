import { describe, expect, it } from "vitest";

import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ActorRef } from "../domain/genesisLedger";
import type { GoodId, ShipmentId } from "../domain/id";
import {
  createTransactionId, noOpPhaseHandler, type PhaseHandler,
} from "./tickOrchestrator";
import { executeStatefulTick } from "./statefulTickOrchestrator";
import { executeM5ShipmentDeliveryTick } from "./m5ShipmentDeliveryTick";
import { validateTradeShipmentRegistry, type TradeShipmentState } from "./tradeShipmentState";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;
const noOpTransition = (_phase: number, world: WorldState) => world;

function fixture(travelTicks: number, departureTick: number) {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 37,
  );
  const link = [...root.transportLinks.values()].find(candidate =>
    candidate.fromRegionId !== candidate.toRegionId && candidate.travelTicks !== undefined);
  const states = [...root.states.values()];
  if (link === undefined || states.length < 2) throw new Error("Missing M5 fixture route or State");
  const seller: ActorRef = { type: "STATE", stateId: states[0]!.stateId };
  const buyer: ActorRef = { type: "STATE", stateId: states[1]!.stateId };
  const sourceCurrency = root.regions.get(link.fromRegionId)!.settlementCurrencyId;
  const destinationCurrency = root.regions.get(link.toRegionId)!.settlementCurrencyId;
  const base: WorldState = {
    ...root,
    transportLinks: new Map(root.transportLinks).set(link.linkId, { ...link, travelTicks }),
  };
  const shipment: TradeShipmentState = {
    id: "sh:runner:alpha" as ShipmentId, goodId: GOOD, quantity: 3,
    originRegionId: link.fromRegionId, destinationRegionId: link.toRegionId,
    seller, buyer, beneficialOwner: buyer, routeLinkIds: [link.linkId],
    transportLinkId: link.linkId, departureTick,
    arrivalTick: departureTick + travelTicks, status: "IN_TRANSIT",
    invoiceCurrencyId: sourceCurrency, buyerPaymentCurrencyId: destinationCurrency,
    sellerNetUnitPrice: 10, buyerGoodsPaymentAmount: 30,
    transportFeeAmount: 1, tariffAmount: 0.5, consumptionTaxAmount: 0,
    ...(sourceCurrency === destinationCurrency
      ? {} : { fxSettlementId: "fxs:runner:alpha" }),
    destinationInventoryBucket: "GENERAL",
  };
  return { base, shipment, buyer };
}

function withShipments(world: WorldState, ...shipments: TradeShipmentState[]): WorldState {
  const result: WorldState = {
    ...world, shipments: new Map(shipments.map(shipment => [shipment.id, shipment])),
  };
  validateTradeShipmentRegistry(result);
  return result;
}

function buyerGoods(world: WorldState, buyer: ActorRef): number {
  if (buyer.type !== "STATE") throw new Error("Fixture buyer must be a State");
  return world.states.get(buyer.stateId)!.publicInventory.get(GOOD) ?? 0;
}

function goodsIncludingTransit(world: WorldState, buyer: ActorRef): number {
  return buyerGoods(world, buyer) +
    [...(world.shipments?.values() ?? [])].reduce(
      (sum, shipment) => sum + (shipment.goodId === GOOD ? shipment.quantity : 0), 0);
}

describe("M5 #674 canonical Phase-1 / Phase-7 shipment-delivery tick wiring", () => {
  it("delivers an earlier-tick shipment before Phase-2 planning, with one journal receipt", () => {
    const { base, shipment, buyer } = fixture(2, 6);
    const opening = withShipments(base, shipment);
    const goodsBefore = buyerGoods(opening, buyer);
    const transitBefore = goodsIncludingTransit(opening, buyer);
    const seen: { phase: number; inventory: number; deliveries: number }[] = [];
    const handler: PhaseHandler = (world, context) => {
      if (context.phase === 2 || context.phase === 8) {
        seen.push({
          phase: context.phase,
          inventory: buyerGoods(world, buyer),
          deliveries: context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY").length,
        });
      }
      return context;
    };

    const result = executeM5ShipmentDeliveryTick(opening, 8, handler, noOpTransition);
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(seen).toEqual([
      { phase: 2, inventory: goodsBefore + 3, deliveries: 1 },
      { phase: 8, inventory: goodsBefore + 3, deliveries: 1 },
    ]);
    expect(result.world.shipments?.size).toBe(0);
    expect(goodsIncludingTransit(result.world, buyer)).toBe(transitBefore);
    expect(result.context.transactions).toMatchObject([{
      type: "SHIPMENT_DELIVERY", phase: 1, tick: 8, quantity: 3, amount: 3,
    }]);
    expect(result.context.transactions[0]?.moneyAmount).toBeUndefined();
    expect(opening.shipments?.get(shipment.id)).toBe(shipment);
    expect(buyerGoods(opening, buyer)).toBe(goodsBefore);

    const repeated = executeM5ShipmentDeliveryTick(
      result.world, 9, noOpPhaseHandler, noOpTransition);
    expect(repeated.context.transactions).toEqual([]);
    expect(buyerGoods(repeated.world, buyer)).toBe(goodsBefore + 3);
  });

  it("delivers new zero-travel shipments AFTER Phase-7 dispatch and BEFORE Phase-8", () => {
    const { base, shipment, buyer } = fixture(0, 8);
    const opening = withShipments(base);
    const before = buyerGoods(opening, buyer);
    const seen: string[] = [];
    const dispatchTx = {
      tick: 8, phase: 7, type: "TRADE_DISPATCH",
      transactionId: createTransactionId("tx:dispatch:runner:alpha"), amount: 30,
    };
    const handler: PhaseHandler = (world, context) => {
      if (context.phase === 5) {
        expect(buyerGoods(world, buyer)).toBe(before);
        expect(context.transactions).toHaveLength(0);
        seen.push("phase5-before-dispatch");
      }
      if (context.phase === 7) {
        expect(world.shipments?.size).toBe(0);
        return { ...context, transactions: [...context.transactions, dispatchTx] };
      }
      if (context.phase === 8) {
        expect(buyerGoods(world, buyer)).toBe(before + shipment.quantity);
        expect(world.shipments?.size).toBe(0);
        expect(context.transactions.map(tx => tx.type)).toEqual([
          "TRADE_DISPATCH", "SHIPMENT_DELIVERY",
        ]);
        seen.push("phase8-after-delivery");
      }
      return context;
    };
    const observations: number[] = [];
    const result = executeM5ShipmentDeliveryTick(
      opening, 8, handler,
      (phase, world) => phase === 7 ? withShipments(world, shipment) : world,
      phase => { observations.push(phase); },
    );

    expect(result.reconciliationErrors).toBeNull();
    expect(seen).toEqual(["phase5-before-dispatch", "phase8-after-delivery"]);
    expect(observations).toEqual([...Array(16).keys()]);
    expect(result.context.transactions[1]).toMatchObject({
      type: "SHIPMENT_DELIVERY", phase: 7, tick: 8, quantity: 3,
    });
    expect(result.world.shipments?.size).toBe(0);
    expect(buyerGoods(result.world, buyer)).toBe(before + 3);
    expect(opening.shipments?.size).toBe(0);
    expect(buyerGoods(opening, buyer)).toBe(before);
  });

  it("retains future cargo until its exact Phase-1 tick without changing money", () => {
    const { base, shipment, buyer } = fixture(2, 6);
    const opening = withShipments(base, shipment);
    const initial = buyerGoods(opening, buyer);
    const next = executeM5ShipmentDeliveryTick(opening, 7, noOpPhaseHandler, noOpTransition);
    expect(next.world.shipments?.has(shipment.id)).toBe(true);
    expect(next.context.transactions).toEqual([]);
    expect(buyerGoods(next.world, buyer)).toBe(initial);
    const arrived = executeM5ShipmentDeliveryTick(next.world, 8, noOpPhaseHandler, noOpTransition);
    expect(arrived.world.shipments?.size).toBe(0);
    expect(buyerGoods(arrived.world, buyer)).toBe(initial + shipment.quantity);
    const originalBuyer = buyer.type === "STATE" ? opening.states.get(buyer.stateId)! : null;
    const arrivedBuyer = buyer.type === "STATE" ? arrived.world.states.get(buyer.stateId)! : null;
    expect(arrivedBuyer?.treasury).toEqual(originalBuyer?.treasury);
    expect(arrived.context.transactions).toHaveLength(1);
  });

  it("delivers in persistent shipment ID order regardless of Map insertion order", () => {
    const { base, shipment, buyer } = fixture(2, 6);
    const other: TradeShipmentState = {
      ...shipment, id: "sh:runner:beta" as ShipmentId, quantity: 2,
    };
    const forward = withShipments(base, other, shipment);
    const reverse = withShipments(base, shipment, other);
    const a = executeM5ShipmentDeliveryTick(forward, 8, noOpPhaseHandler, noOpTransition);
    const b = executeM5ShipmentDeliveryTick(reverse, 8, noOpPhaseHandler, noOpTransition);
    expect(a.context.transactions).toEqual(b.context.transactions);
    expect(a.context.transactions.map(tx => tx.transactionId)).toEqual([
      "tx:delivery:sh:runner:alpha", "tx:delivery:sh:runner:beta",
    ]);
    expect(buyerGoods(a.world, buyer)).toBe(buyerGoods(b.world, buyer));
    expect(goodsIncludingTransit(a.world, buyer)).toBe(goodsIncludingTransit(forward, buyer));
  });

  it("fails closed on overdue or preexisting same-tick shipments, without publishing stock", () => {
    const { base, shipment, buyer } = fixture(2, 6);
    const overdue = withShipments(base, shipment);
    const initial = buyerGoods(overdue, buyer);
    const observed: number[] = [];
    expect(() => executeM5ShipmentDeliveryTick(
      overdue, 9, noOpPhaseHandler, noOpTransition,
      phase => { observed.push(phase); },
    )).toThrow(/overdue/);
    expect(observed).not.toContain(1);
    expect(overdue.shipments?.has(shipment.id)).toBe(true);
    expect(buyerGoods(overdue, buyer)).toBe(initial);

    const zero = fixture(0, 8);
    const illegal = withShipments(zero.base, zero.shipment);
    expect(() => executeM5ShipmentDeliveryTick(
      illegal, 8, noOpPhaseHandler, noOpTransition,
    )).toThrow(/Phase-7 close/);
    expect(illegal.shipments?.has(zero.shipment.id)).toBe(true);
  });

  it("rejects duplicate dispatch/delivery IDs without publishing the Phase-7 shipment", () => {
    const { base, shipment, buyer } = fixture(0, 8);
    const opening = withShipments(base);
    const original = buyerGoods(opening, buyer);
    const seen: number[] = [];
    const collision: PhaseHandler = (_world, context) => context.phase === 7
      ? { ...context, transactions: [...context.transactions, {
        tick: 8, phase: 7, type: "OTHER",
        transactionId: createTransactionId("tx:delivery:" + shipment.id),
        amount: 1,
      }] }
      : context;
    expect(() => executeM5ShipmentDeliveryTick(
      opening, 8, collision,
      (phase, world) => phase === 7 ? withShipments(world, shipment) : world,
      phase => { seen.push(phase); },
    )).toThrow(/duplicate delivery/);
    expect(seen).not.toContain(7);
    expect(opening.shipments?.size).toBe(0);
    expect(buyerGoods(opening, buyer)).toBe(original);
  });

  it("preserves legacy stateful tick behavior unless M5 delivery is explicitly enabled", () => {
    const { base } = fixture(2, 6);
    const opening = withShipments(base);
    const legacy = executeStatefulTick(opening, 8, noOpPhaseHandler, noOpTransition);
    const enabled = executeM5ShipmentDeliveryTick(opening, 8, noOpPhaseHandler, noOpTransition);
    expect(enabled.phaseTrace).toEqual(legacy.phaseTrace);
    expect(enabled.context).toEqual(legacy.context);
    expect(enabled.world).toBe(opening);
    expect(legacy.world).toBe(opening);
  });
});
