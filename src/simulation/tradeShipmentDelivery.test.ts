import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ShipmentId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { createTransactionBundleId, createTransactionId } from "./tickOrchestrator";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";
import { validateTradeShipmentRegistry, type TradeShipmentState } from "./tradeShipmentState";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

function fixture(travelTicks = 2) {
  const root = buildInitialWorld(baselineScenario, baselineDefinitionPack,
    createDefaultSimulationConfig(), 37);
  const link = [...root.transportLinks.values()].find(route =>
    route.fromRegionId !== route.toRegionId && route.travelTicks !== undefined);
  const states = [...root.states.values()];
  if (!link || states.length < 2) throw new Error("Missing interregional fixture");
  const seller: ActorRef = { type: "STATE", stateId: states[0]!.stateId };
  const buyer: ActorRef = { type: "STATE", stateId: states[1]!.stateId };
  const sourceCurrency = root.regions.get(link.fromRegionId)!.settlementCurrencyId;
  const destinationCurrency = root.regions.get(link.toRegionId)!.settlementCurrencyId;
  const world: WorldState = {
    ...root,
    transportLinks: new Map(root.transportLinks).set(link.linkId,
      { ...link, travelTicks }),
  };
  const shipment: TradeShipmentState = {
    id: "sh:delivery:unit:a" as ShipmentId, goodId: GOOD, quantity: 3,
    originRegionId: link.fromRegionId, destinationRegionId: link.toRegionId,
    seller, buyer, beneficialOwner: buyer, routeLinkIds: [link.linkId],
    transportLinkId: link.linkId, departureTick: 6, arrivalTick: 6 + travelTicks,
    status: "IN_TRANSIT", invoiceCurrencyId: sourceCurrency,
    buyerPaymentCurrencyId: destinationCurrency,
    sellerNetUnitPrice: 10, buyerGoodsPaymentAmount: 31,
    transportFeeAmount: 2, tariffAmount: 1, consumptionTaxAmount: 0.5,
    ...(sourceCurrency === destinationCurrency
      ? {} : { fxSettlementId: "fxs:delivery:unit:a" }),
    destinationInventoryBucket: "GENERAL",
  };
  const inTransit: WorldState = {
    ...world, shipments: new Map([[shipment.id, shipment]]),
  };
  validateTradeShipmentRegistry(inTransit);
  return { inTransit, shipment, buyer, seller };
}

function stateGoods(world: WorldState, actor: ActorRef): number {
  if (actor.type !== "STATE") throw new Error("expected State actor");
  return world.states.get(actor.stateId)!.publicInventory.get(GOOD) ?? 0;
}

describe("M5 #674 deterministic Phase-1 and zero-travel Phase-7 shipment arrival", () => {
  it("delivers future-tick in-transit goods once, without a second cash or tax settlement", () => {
    const { inTransit, shipment, buyer } = fixture();
    const initial = stateGoods(inTransit, buyer);
    const originalStates = inTransit.states;
    const tooEarly = deliverDueTradeShipments(inTransit,
      { tick: 7, phase: 1, priorTransactions: [] });
    expect(tooEarly.world).toBe(inTransit);
    expect(tooEarly.newTransactions).toEqual([]);
    const result = deliverDueTradeShipments(inTransit,
      { tick: 8, phase: 1, priorTransactions: [] });
    expect(result.world.shipments.size).toBe(0);
    expect(inTransit.shipments.get(shipment.id)).toBe(shipment);
    expect(stateGoods(result.world, buyer)).toBe(initial + 3);
    expect(stateGoods(inTransit, buyer)).toBe(initial);
    expect(inTransit.states).toBe(originalStates);
    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0]).toMatchObject({
      type: "SHIPMENT_DELIVERY", phase: 1, tick: 8,
      goodId: GOOD, quantity: 3, amount: 3, destination: buyer,
    });
    expect(result.newTransactions[0]!.currencyId).toBeUndefined();
    expect(result.newTransactions[0]!.moneyAmount).toBeUndefined();
    expect(result.world.states.get(buyer.type === "STATE" ? buyer.stateId
      : [...result.world.states.keys()][0]!)?.treasury)
      .toEqual(inTransit.states.get(buyer.type === "STATE" ? buyer.stateId
        : [...inTransit.states.keys()][0]!)?.treasury);
    expect(() => validateTradeShipmentRegistry(result.world)).not.toThrow();
    // Re-execution on the committed world is a no-op, not another credit.
    const again = deliverDueTradeShipments(result.world,
      { tick: 8, phase: 1, priorTransactions: result.transactions });
    expect(again.world).toBe(result.world);
    expect(again.newTransactions).toEqual([]);
  });

  it("credits production INPUT without filling OUTPUT or INVESTMENT", () => {
    const { inTransit, shipment } = fixture();
    const unit = [...inTransit.productionUnits.values()][0];
    if (!unit) throw new Error("Missing ProductionUnit fixture");
    const buyer: ActorRef = { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId };
    const assigned: TradeShipmentState = {
      ...shipment, buyer, beneficialOwner: buyer,
      destinationInventoryBucket: "INPUT",
    };
    const world: WorldState = {
      ...inTransit, shipments: new Map([[assigned.id, assigned]]),
    };
    const initialInput = unit.inputInventory.get(GOOD) ?? 0;
    const result = deliverDueTradeShipments(world,
      { tick: 8, phase: 1, priorTransactions: [] });
    const after = result.world.productionUnits.get(unit.productionUnitId)!;
    expect(after.inputInventory.get(GOOD)).toBe(initialInput + 3);
    expect(after.outputInventory).toEqual(unit.outputInventory);
    expect(after.investmentInventory).toEqual(unit.investmentInventory);
    expect(world.productionUnits.get(unit.productionUnitId)).toBe(unit);
  });

  it("delivers zero-travel stock only in Phase-7 close, not Phase 1", () => {
    const { inTransit, shipment, buyer } = fixture(0);
    const zero: TradeShipmentState = {
      ...shipment, departureTick: 8, arrivalTick: 8,
    };
    const world: WorldState = {
      ...inTransit, shipments: new Map([[zero.id, zero]]),
    };
    const before = stateGoods(world, buyer);
    expect(() => deliverDueTradeShipments(world,
      { tick: 8, phase: 1, priorTransactions: [] })).toThrow(/Phase-7 close/);
    const result = deliverDueTradeShipments(world,
      { tick: 8, phase: 7, priorTransactions: [] });
    expect(result.newTransactions[0]?.phase).toBe(7);
    expect(stateGoods(result.world, buyer)).toBe(before + 3);
    expect(result.world.shipments.size).toBe(0);
  });

  it("is insensitive to shipment Map order and preserves stable transaction IDs", () => {
    const { inTransit, shipment, buyer } = fixture();
    const other: TradeShipmentState = {
      ...shipment, id: "sh:delivery:unit:b" as ShipmentId, quantity: 2,
    };
    const forward: WorldState = {
      ...inTransit, shipments: new Map([[shipment.id, shipment], [other.id, other]]),
    };
    const reverse: WorldState = {
      ...inTransit, shipments: new Map([[other.id, other], [shipment.id, shipment]]),
    };
    const request = { tick: 8, phase: 1 as const, priorTransactions: [] };
    const a = deliverDueTradeShipments(forward, request);
    const b = deliverDueTradeShipments(reverse, request);
    expect(a.deliveredShipmentIds).toEqual([shipment.id, other.id]);
    expect(b.deliveredShipmentIds).toEqual(a.deliveredShipmentIds);
    expect(b.newTransactions).toEqual(a.newTransactions);
    expect(stateGoods(a.world, buyer)).toBe(stateGoods(b.world, buyer));
    expect(stateGoods(forward, buyer)).toBe(stateGoods(reverse, buyer));
  });

  it("rejects stale, corrupt and duplicate delivery evidence without partial publication", () => {
    const { inTransit, shipment, buyer } = fixture();
    const before = stateGoods(inTransit, buyer);
    expect(() => deliverDueTradeShipments(inTransit,
      { tick: 9, phase: 1, priorTransactions: [] })).toThrow(/overdue/);
    const transactionId = createTransactionId("tx:delivery:" + shipment.id);
    const bundleId = createTransactionBundleId("tb:delivery:" + shipment.id);
    expect(() => deliverDueTradeShipments(inTransit,
      { tick: 8, phase: 1, priorTransactions: [{
        tick: 8, phase: 1, type: "SHIPMENT_DELIVERY", transactionId,
        bundleId, amount: 3,
      }] })).toThrow(/duplicate/);
    const corrupt: TradeShipmentState = { ...shipment, quantity: Number.POSITIVE_INFINITY };
    const invalid: WorldState = {
      ...inTransit, shipments: new Map([[shipment.id, corrupt]]),
    };
    expect(() => deliverDueTradeShipments(invalid,
      { tick: 8, phase: 1, priorTransactions: [] })).toThrow(/quantity/);
    expect(stateGoods(inTransit, buyer)).toBe(before);
    expect(inTransit.shipments.get(shipment.id)).toBe(shipment);
  });

  it("refuses binary64 lost credits, overflowing stock, and cumulative precision loss", () => {
    const { inTransit, shipment, buyer } = fixture();
    if (buyer.type !== "STATE") throw new Error("expected State");
    const original = inTransit.states.get(buyer.stateId)!;
    const setBalance = (quantity: number, shipmentQuantity: number,
      extra?: TradeShipmentState): WorldState => ({
      ...inTransit,
      simulationConfig: {
        ...inTransit.simulationConfig,
        numeric: { ...inTransit.simulationConfig.numeric, quantityEpsilon: 1e-9 },
      },
      states: new Map(inTransit.states).set(buyer.stateId, {
        ...original,
        publicInventory: new Map(original.publicInventory).set(GOOD, quantity),
      }),
      shipments: new Map([
        [shipment.id, { ...shipment, quantity: shipmentQuantity }],
        ...(extra ? [[extra.id, extra] as const] : []),
      ]),
    });
    const lost = setBalance(1e16, 1);
    expect(() => deliverDueTradeShipments(lost,
      { tick: 8, phase: 1, priorTransactions: [] })).toThrow(/precision/);
    const overflow = setBalance(Number.MAX_VALUE, Number.MAX_VALUE);
    expect(() => deliverDueTradeShipments(overflow,
      { tick: 8, phase: 1, priorTransactions: [] })).toThrow(/overflows/);
    const second: TradeShipmentState = {
      ...shipment, id: "sh:delivery:unit:b" as ShipmentId, quantity: 0.3,
    };
    const cumulative = setBalance(10_000_000, 0.3, second);
    expect(() => deliverDueTradeShipments(cumulative,
      { tick: 8, phase: 1, priorTransactions: [] }))
      .toThrow(/cumulative.*precision/);
    // Exact binary64 credit remains possible and does not over-reject.
    const exact = setBalance(1e16, 2);
    const okay = deliverDueTradeShipments(exact,
      { tick: 8, phase: 1, priorTransactions: [] });
    expect(stateGoods(okay.world, buyer)).toBe(1e16 + 2);
  });
});
