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
  it("uses the canonical quantity precision default for a valid historic config without an override", () => {
    const { inTransit, shipment, buyer } = fixture();
    // NumericConfig.quantityEpsilon is optional, and both dispatch and
    // persisted-cargo validation default it to 1e-9. Delivery must not
    // strand already-paid cargo merely because this field was omitted.
    const { quantityEpsilon: _omitted, ...numeric } = inTransit.simulationConfig.numeric;
    const historic: WorldState = {
      ...inTransit,
      simulationConfig: { ...inTransit.simulationConfig, numeric },
    };
    expect(historic.simulationConfig.numeric.quantityEpsilon).toBeUndefined();
    expect(() => validateTradeShipmentRegistry(historic)).not.toThrow();

    const originalGoods = stateGoods(historic, buyer);
    const delivered = deliverDueTradeShipments(historic, {
      tick: shipment.arrivalTick, phase: 1, priorTransactions: [],
    });
    expect(stateGoods(delivered.world, buyer)).toBe(originalGoods + shipment.quantity);
    expect(delivered.world.shipments?.size).toBe(0);
    expect(delivered.newTransactions).toHaveLength(1);
    expect(delivered.newTransactions[0]?.type).toBe("SHIPMENT_DELIVERY");
    expect(historic.shipments?.get(shipment.id)).toBe(shipment);
    expect(stateGoods(historic, buyer)).toBe(originalGoods);

    // The omitted override does not relax the shared epsilon floor.
    const tiny = { ...shipment, quantity: 5e-10 };
    const corrupt: WorldState = {
      ...historic, shipments: new Map([[tiny.id, tiny]]),
    };
    expect(() => validateTradeShipmentRegistry(corrupt)).toThrow(/quantity.*epsilon/);
    expect(() => deliverDueTradeShipments(corrupt, {
      tick: tiny.arrivalTick, phase: 1, priorTransactions: [],
    })).toThrow(/quantity.*epsilon/);
    expect(stateGoods(corrupt, buyer)).toBe(originalGoods);
    expect(corrupt.shipments?.get(tiny.id)).toBe(tiny);
  });

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
    expect(result.world.shipments?.size).toBe(0);
    expect(inTransit.shipments?.get(shipment.id)).toBe(shipment);
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
    expect(result.world.shipments?.size).toBe(0);
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
    expect(inTransit.shipments?.get(shipment.id)).toBe(shipment);
  });

  it("refuses duplicate committed journal IDs without rejecting legitimate shared bundles", () => {
    const { inTransit, shipment, buyer } = fixture();
    const opening = stateGoods(inTransit, buyer);
    const bundleId = createTransactionBundleId("tb:prior:multi-leg");
    const firstId = createTransactionId("tx:prior:transport");
    const first = {
      tick: 7, phase: 7 as const, type: "TRANSPORT_FEE" as const,
      transactionId: firstId, bundleId, amount: 1,
    };
    const second = {
      tick: 7, phase: 7 as const, type: "IMPORT_TARIFF" as const,
      transactionId: createTransactionId("tx:prior:tariff"), bundleId, amount: 1,
    };
    // Two different economic legs can legally share a bundle ID.
    const validPrior = [first, second];
    const delivered = deliverDueTradeShipments(inTransit, {
      tick: 8, phase: 1, priorTransactions: validPrior,
    });
    expect(delivered.deliveredShipmentIds).toEqual([shipment.id]);
    expect(delivered.transactions).toHaveLength(3);
    expect(delivered.transactions.slice(0, 2)).toEqual(validPrior);

    // Repeating a transaction ID, even under another bundle, would make the
    // resulting ledger non-unique. Do not credit the receiver or consume cargo.
    const duplicate = { ...second, transactionId: firstId,
      bundleId: createTransactionBundleId("tb:prior:other") };
    const invalidPrior = [first, second, duplicate];
    expect(() => deliverDueTradeShipments(inTransit, {
      tick: 8, phase: 1, priorTransactions: invalidPrior,
    })).toThrow(/duplicate prior transaction identity/);
    expect(stateGoods(inTransit, buyer)).toBe(opening);
    expect(inTransit.shipments?.get(shipment.id)).toBe(shipment);
    expect(invalidPrior).toEqual([first, second, duplicate]);
  });

  it("keeps all owner stocks unchanged if a later due delivery overflows", () => {
    const { inTransit, shipment, seller, buyer } = fixture();
    if (seller.type !== "STATE" || buyer.type !== "STATE") {
      throw new Error("expected two State owners");
    }
    const sellerState = inTransit.states.get(seller.stateId)!;
    const states = new Map(inTransit.states).set(seller.stateId, {
      ...sellerState,
      publicInventory: new Map(sellerState.publicInventory).set(GOOD, Number.MAX_VALUE),
    });
    const later: TradeShipmentState = {
      ...shipment, id: "sh:delivery:unit:b" as ShipmentId,
      seller: buyer, buyer: seller, beneficialOwner: seller,
      quantity: Number.MAX_VALUE,
      ...(shipment.fxSettlementId === undefined ? {} : {
        fxSettlementId: "fxs:delivery:unit:b",
      }),
    };
    const world: WorldState = {
      ...inTransit, states,
      shipments: new Map([[shipment.id, shipment], [later.id, later]]),
    };
    validateTradeShipmentRegistry(world);
    const request = { tick: 8, phase: 1 as const, priorTransactions: [] };
    const firstOnly: WorldState = {
      ...world, shipments: new Map([[shipment.id, shipment]]),
    };
    expect(stateGoods(deliverDueTradeShipments(firstOnly, request).world, buyer))
      .toBe(stateGoods(world, buyer) + shipment.quantity);

    const buyerBefore = stateGoods(world, buyer);
    const sellerBefore = stateGoods(world, seller);
    // The earlier lexicographic shipment can credit successfully, but the
    // second destination would overflow. No intermediate WorldState escapes.
    expect(() => deliverDueTradeShipments(world, request)).toThrow(/overflows/);
    expect(stateGoods(world, buyer)).toBe(buyerBefore);
    expect(stateGoods(world, seller)).toBe(sellerBefore);
    expect(world.states).toBe(states);
    expect(world.shipments?.get(shipment.id)).toBe(shipment);
    expect(world.shipments?.get(later.id)).toBe(later);
    expect(world.shipments?.size).toBe(2);
    expect(inTransit.states.get(seller.stateId)).toBe(sellerState);
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

  it("delivers mixed ProductionUnit stock buckets once without cross-bucket goods loss", () => {
    const { inTransit, shipment } = fixture();
    const destinationKey = inTransit.regions.get(shipment.destinationRegionId)!.seed.key;
    const unit = [...inTransit.productionUnits.values()].find(candidate =>
      candidate.seed.regionKey === destinationKey);
    if (!unit) throw new Error("Missing destination-region ProductionUnit fixture");
    const buyer: ActorRef = {
      type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId,
    };
    const entries = [
      { id: "sh:delivery:bucket:a" as ShipmentId, bucket: "INPUT" as const, quantity: 0.25 },
      { id: "sh:delivery:bucket:b" as ShipmentId, bucket: "OUTPUT" as const, quantity: 0.5 },
      { id: "sh:delivery:bucket:c" as ShipmentId, bucket: "INVESTMENT" as const, quantity: 1.25 },
    ];
    const cargo: TradeShipmentState[] = entries.map(entry => ({
      ...shipment, id: entry.id, quantity: entry.quantity,
      buyer, beneficialOwner: buyer, destinationInventoryBucket: entry.bucket,
    }));
    const withCargo = (ordered: readonly TradeShipmentState[]): WorldState => ({
      ...inTransit, shipments: new Map(ordered.map(item => [item.id, item])),
    });
    const forward = withCargo(cargo);
    const reverse = withCargo([...cargo].reverse());
    const request = {
      tick: shipment.arrivalTick, phase: 1 as const, priorTransactions: [],
    };
    const openingGoods = [unit.inputInventory, unit.outputInventory,
      unit.investmentInventory].reduce((sum, bucket) => sum + (bucket.get(GOOD) ?? 0), 0);
    const inTransitGoods = cargo.reduce((sum, item) => sum + item.quantity, 0);

    const first = deliverDueTradeShipments(forward, request);
    const reordered = deliverDueTradeShipments(reverse, request);
    expect(first.deliveredShipmentIds).toEqual(entries.map(entry => entry.id));
    expect(reordered.deliveredShipmentIds).toEqual(first.deliveredShipmentIds);
    expect(reordered.newTransactions).toEqual(first.newTransactions);
    expect(first.newTransactions).toHaveLength(3);
    expect(first.newTransactions.every(tx =>
      tx.type === "SHIPMENT_DELIVERY" && tx.moneyAmount === undefined &&
      tx.currencyId === undefined)).toBe(true);

    const deliveredUnit = first.world.productionUnits.get(unit.productionUnitId)!;
    const inventories = {
      INPUT: deliveredUnit.inputInventory,
      OUTPUT: deliveredUnit.outputInventory,
      INVESTMENT: deliveredUnit.investmentInventory,
    };
    const opening = {
      INPUT: unit.inputInventory,
      OUTPUT: unit.outputInventory,
      INVESTMENT: unit.investmentInventory,
    };
    for (const entry of entries) {
      expect(inventories[entry.bucket].get(GOOD) ?? 0).toBeCloseTo(
        (opening[entry.bucket].get(GOOD) ?? 0) + entry.quantity, 12);
      expect(first.newTransactions.find(tx =>
        tx.transactionId === createTransactionId("tx:delivery:" + entry.id))?.reason)
        .toBe("IN_TRANSIT_TO_" + entry.bucket + "_STOCK:" + entry.id);
    }
    const closingGoods = Object.values(inventories)
      .reduce((sum, bucket) => sum + (bucket.get(GOOD) ?? 0), 0);
    expect(closingGoods).toBeCloseTo(openingGoods + inTransitGoods, 12);
    expect(first.world.shipments?.size).toBe(0);
    expect(forward.shipments?.size).toBe(3);
    expect(forward.productionUnits.get(unit.productionUnitId)).toBe(unit);

    const replay = deliverDueTradeShipments(first.world, {
      ...request, priorTransactions: first.transactions,
    });
    expect(replay.world).toBe(first.world);
    expect(replay.newTransactions).toEqual([]);
    expect(replay.world.productionUnits.get(unit.productionUnitId)).toBe(deliveredUnit);
  });

  it("delivers simultaneous zero-travel cargo to three beneficial-owner kinds without double credit", () => {
    const { inTransit, shipment } = fixture(0);
    const destinationKey = inTransit.regions.get(shipment.destinationRegionId)!.seed.key;
    const cohortEntry = [...inTransit.cohorts].find(([, cohort]) =>
      cohort.seed.regionKey === destinationKey);
    const unitEntry = [...inTransit.productionUnits].find(([, unit]) =>
      unit.seed.regionKey === destinationKey);
    if (!cohortEntry || !unitEntry) throw new Error("Missing destination resident fixtures");
    const [cohortId, cohort] = cohortEntry;
    const [unitId, unit] = unitEntry;
    const cohortBuyer: ActorRef = { type: "COHORT", cohortId };
    const unitBuyer: ActorRef = { type: "PRODUCTION_UNIT", productionUnitId: unitId };
    const cargo: TradeShipmentState[] = [
      {
        ...shipment, id: "sh:delivery:owners:a" as ShipmentId,
        departureTick: 9, arrivalTick: 9, quantity: 2,
      },
      {
        ...shipment, id: "sh:delivery:owners:b" as ShipmentId,
        departureTick: 9, arrivalTick: 9, quantity: 1.5,
        buyer: cohortBuyer, beneficialOwner: cohortBuyer,
      },
      {
        ...shipment, id: "sh:delivery:owners:c" as ShipmentId,
        departureTick: 9, arrivalTick: 9, quantity: 0.25,
        buyer: unitBuyer, beneficialOwner: unitBuyer,
        destinationInventoryBucket: "INPUT",
      },
    ];
    const withCargo = (entries: readonly TradeShipmentState[]): WorldState => ({
      ...inTransit, shipments: new Map(entries.map(entry => [entry.id, entry])),
    });
    const forward = withCargo(cargo);
    const reverse = withCargo([...cargo].reverse());
    validateTradeShipmentRegistry(forward);
    const originalState = stateGoods(forward, shipment.buyer);
    const originalCohort = cohort.householdInventory.get(GOOD) ?? 0;
    const originalUnit = unit.inputInventory.get(GOOD) ?? 0;
    const originalTotal = originalState + originalCohort + originalUnit;
    const transitTotal = cargo.reduce((sum, item) => sum + item.quantity, 0);
    const request = { tick: 9, phase: 7 as const, priorTransactions: [] };

    expect(() => deliverDueTradeShipments(forward, {
      ...request, phase: 1,
    })).toThrow(/Phase-7 close/);
    const delivered = deliverDueTradeShipments(forward, request);
    const reordered = deliverDueTradeShipments(reverse, request);
    expect(delivered.deliveredShipmentIds).toEqual(cargo.map(item => item.id));
    expect(reordered.deliveredShipmentIds).toEqual(delivered.deliveredShipmentIds);
    expect(reordered.newTransactions).toEqual(delivered.newTransactions);
    expect(delivered.world.shipments?.size).toBe(0);
    expect(delivered.newTransactions).toHaveLength(3);
    expect(delivered.newTransactions.every(tx =>
      tx.type === "SHIPMENT_DELIVERY" && tx.phase === 7 &&
      tx.currencyId === undefined && tx.moneyAmount === undefined)).toBe(true);

    const finalState = stateGoods(delivered.world, shipment.buyer);
    const finalCohort = delivered.world.cohorts.get(cohortId)!;
    const finalUnit = delivered.world.productionUnits.get(unitId)!;
    expect(finalState - originalState).toBeCloseTo(2, 12);
    expect((finalCohort.householdInventory.get(GOOD) ?? 0) - originalCohort)
      .toBeCloseTo(1.5, 12);
    expect((finalUnit.inputInventory.get(GOOD) ?? 0) - originalUnit)
      .toBeCloseTo(0.25, 12);
    expect(finalUnit.outputInventory).toEqual(unit.outputInventory);
    expect(finalUnit.investmentInventory).toEqual(unit.investmentInventory);
    expect(finalState + (finalCohort.householdInventory.get(GOOD) ?? 0) +
      (finalUnit.inputInventory.get(GOOD) ?? 0))
      .toBeCloseTo(originalTotal + transitTotal, 12);
    expect(delivered.world.states.get(
      shipment.buyer.type === "STATE" ? shipment.buyer.stateId
        : [...delivered.world.states.keys()][0]!)?.treasury)
      .toEqual(forward.states.get(
        shipment.buyer.type === "STATE" ? shipment.buyer.stateId
          : [...forward.states.keys()][0]!)?.treasury);
    expect(delivered.world.cohorts.get(cohortId)!.wallet).toEqual(cohort.wallet);
    expect(delivered.world.productionUnits.get(unitId)!.wallet).toEqual(unit.wallet);
    expect(forward.shipments?.size).toBe(3);
    expect(forward.cohorts.get(cohortId)).toBe(cohort);
    expect(forward.productionUnits.get(unitId)).toBe(unit);

    const replay = deliverDueTradeShipments(delivered.world, {
      ...request, priorTransactions: delivered.transactions,
    });
    expect(replay.world).toBe(delivered.world);
    expect(replay.newTransactions).toEqual([]);
  });

});
