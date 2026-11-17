/**
 * Issue #676 / REQ-ACCEPTANCE-006: non-IRON physical arrival accounting.
 *
 * Exercise the real 16-phase M5 delivery integration for different goods,
 * beneficial-owner classes and named ProductionUnit buckets. A balanced
 * transfer to a wrong owner/bucket is still a failure, even when aggregate
 * physical stocks and journal totals remain unchanged.
 *
 * Scope is the paid in-transit -> destination stock handoff only. This is
 * not the full M5 dispatch/FX/tariff golden or M5 gate completion claim.
 */
import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import type { GoodId, ShipmentId } from "../domain/id";
import { executeM5ShipmentDeliveryTick } from "./m5ShipmentDeliveryTick";
import { noOpPhaseHandler } from "./tickOrchestrator";
import { validateTradeShipmentRegistry, type TradeShipmentState } from "./tradeShipmentState";
import type { ShipmentDestinationInventoryBucket } from "./tradeShipmentState";
import { buildInitialWorld, type WorldState } from "./worldState";

const FOOD = "good:food" as GoodId;
const WOOD = "good:wood" as GoodId;
const noOpTransition = (_phase: number, world: WorldState) => world;

function fixture() {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 37,
  );
  const route = [...root.transportLinks.values()].find(link =>
    link.fromRegionId !== link.toRegionId &&
    [...root.cohorts.values()].some(cohort =>
      cohort.seed.regionKey === root.regions.get(link.toRegionId)?.seed.key) &&
    [...root.productionUnits.values()].some(unit =>
      unit.seed.regionKey === root.regions.get(link.toRegionId)?.seed.key),
  );
  const states = [...root.states.values()];
  if (!route || states.length < 2) throw new Error("Missing M5 cross-region fixture");
  const destinationKey = root.regions.get(route.toRegionId)!.seed.key;
  const [cohortId] = [...root.cohorts].find(([, cohort]) =>
    cohort.seed.regionKey === destinationKey)!;
  const [unitId] = [...root.productionUnits].find(([, unit]) =>
    unit.seed.regionKey === destinationKey)!;
  const seller: ActorRef = { type: "STATE", stateId: states[0]!.stateId };
  const stateBuyer: ActorRef = { type: "STATE", stateId: states[1]!.stateId };
  const cohortBuyer: ActorRef = { type: "COHORT", cohortId };
  const unitBuyer: ActorRef = { type: "PRODUCTION_UNIT", productionUnitId: unitId };
  const invoiceCurrencyId = root.regions.get(route.fromRegionId)!.settlementCurrencyId;
  const buyerPaymentCurrencyId = root.regions.get(route.toRegionId)!.settlementCurrencyId;

  const make = (
    suffix: string, goodId: GoodId, quantity: number,
    buyer: ActorRef, bucket: ShipmentDestinationInventoryBucket,
  ): TradeShipmentState => ({
    id: ("sh:m5:multigood:" + suffix) as ShipmentId,
    goodId, quantity, seller, buyer, beneficialOwner: buyer,
    originRegionId: route.fromRegionId,
    destinationRegionId: route.toRegionId,
    routeLinkIds: [route.linkId], transportLinkId: route.linkId,
    departureTick: 6, arrivalTick: 8, travelTicksAtDispatch: 2,
    status: "IN_TRANSIT", invoiceCurrencyId, buyerPaymentCurrencyId,
    sellerNetUnitPrice: 10, buyerGoodsPaymentAmount: quantity * 10,
    transportFeeAmount: 0, tariffAmount: 0, consumptionTaxAmount: 0,
    ...(invoiceCurrencyId === buyerPaymentCurrencyId ? {}
      : { fxSettlementId: "fxs:m5:multigood:" + suffix }),
    destinationInventoryBucket: bucket,
  });
  const cargo = [
    make("state-food", FOOD, 2, stateBuyer, "GENERAL"),
    make("cohort-food", FOOD, 1.25, cohortBuyer, "GENERAL"),
    make("unit-food", FOOD, 0.5, unitBuyer, "OUTPUT"),
    make("unit-wood", WOOD, 3, unitBuyer, "INPUT"),
  ];
  const withCargo = (entries: readonly TradeShipmentState[]): WorldState => ({
    ...root,
    transportLinks: new Map(root.transportLinks).set(route.linkId, {
      ...route, travelTicks: 2,
    }),
    shipments: new Map(entries.map(shipment => [shipment.id, shipment])),
  });
  return {
    cargo, forward: withCargo(cargo), reverse: withCargo([...cargo].reverse()),
    stateBuyer, cohortBuyer, unitBuyer,
  };
}

/** Every authoritative on-hand goods endpoint, including non-recipients. */
function physicalStockEndpoints(world: WorldState): Map<string, { goodId: GoodId; quantity: number }> {
  const endpoints = new Map<string, { goodId: GoodId; quantity: number }>();
  const record = (
    owner: ActorRef, bucket: ShipmentDestinationInventoryBucket,
    inventory: ReadonlyMap<GoodId, number>,
  ) => {
    for (const [goodId, quantity] of inventory) {
      const key = JSON.stringify([actorRefKey(owner), bucket, goodId]);
      if (endpoints.has(key)) throw new Error("Duplicate physical goods endpoint: " + key);
      endpoints.set(key, { goodId, quantity });
    }
  };
  for (const [stateId, state] of world.states) {
    record({ type: "STATE", stateId }, "GENERAL", state.publicInventory);
  }
  for (const [cohortId, cohort] of world.cohorts) {
    record({ type: "COHORT", cohortId }, "GENERAL", cohort.householdInventory);
  }
  for (const [productionUnitId, unit] of world.productionUnits) {
    const owner: ActorRef = { type: "PRODUCTION_UNIT", productionUnitId };
    record(owner, "INPUT", unit.inputInventory);
    record(owner, "OUTPUT", unit.outputInventory);
    record(owner, "INVESTMENT", unit.investmentInventory);
  }
  return endpoints;
}

function assertOwnerGoodBucketDeltas(
  before: WorldState, after: WorldState, cargo: readonly TradeShipmentState[],
): void {
  // Manifest-derived deltas must match ALL physical stock endpoints. An extra
  // credit to an unlisted seller or goods bucket is not a harmless no-op.
  const expected = new Map<string, number>();
  for (const shipment of cargo) {
    const key = JSON.stringify([
      actorRefKey(shipment.beneficialOwner), shipment.destinationInventoryBucket,
      shipment.goodId,
    ]);
    expected.set(key, (expected.get(key) ?? 0) + shipment.quantity);
  }
  const opening = physicalStockEndpoints(before);
  const closing = physicalStockEndpoints(after);
  const keys = new Set([...opening.keys(), ...closing.keys(), ...expected.keys()]);
  for (const key of keys) {
    const observed = (closing.get(key)?.quantity ?? 0) -
      (opening.get(key)?.quantity ?? 0);
    expect(observed, "owner/bucket/good " + key).toBeCloseTo(expected.get(key) ?? 0, 9);
  }
}

describe("M5 #676 multi-good owner-bound delivery through the 16-phase runner", () => {
  it("conserves FOOD and WOOD independently, without re-credit or financial settlement", () => {
    const f = fixture();
    validateTradeShipmentRegistry(f.forward);
    validateTradeShipmentRegistry(f.reverse);
    const run = (world: WorldState) =>
      executeM5ShipmentDeliveryTick(world, 8, noOpPhaseHandler, noOpTransition);
    const first = run(f.forward);
    const reordered = run(f.reverse);
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    expect(first.phaseBoundaryError).toBeUndefined();
    expect(first.reconciliationErrors).toBeNull();
    expect(first.world.shipments?.size).toBe(0);
    expect(first.context.transactions).toHaveLength(f.cargo.length);
    expect(first.context.transactions).toEqual(reordered.context.transactions);
    expect(first.world.states).toEqual(reordered.world.states);
    expect(first.world.cohorts).toEqual(reordered.world.cohorts);
    expect(first.world.productionUnits).toEqual(reordered.world.productionUnits);
    expect(first.context.transactions.every(tx =>
      tx.type === "SHIPMENT_DELIVERY" && tx.phase === 1 &&
      tx.moneyAmount === undefined && tx.currencyId === undefined)).toBe(true);
    assertOwnerGoodBucketDeltas(f.forward, first.world, f.cargo);

    // Independent whole-world per-good conservation, including the cargo
    // registry that owns goods while in transit (not just listed recipients).
    const physicalTotal = (world: WorldState, good: GoodId) =>
      [...physicalStockEndpoints(world).values()]
        .filter(endpoint => endpoint.goodId === good)
        .reduce((sum, endpoint) => sum + endpoint.quantity, 0);
    const transitTotal = (world: WorldState, good: GoodId) =>
      [...(world.shipments?.values() ?? [])]
        .filter(shipment => shipment.goodId === good)
        .reduce((sum, shipment) => sum + shipment.quantity, 0);
    for (const good of [FOOD, WOOD]) {
      expect(physicalTotal(first.world, good) + transitTotal(first.world, good))
        .toBeCloseTo(physicalTotal(f.forward, good) + transitTotal(f.forward, good), 9);
    }
    if (f.stateBuyer.type !== "STATE" || f.cohortBuyer.type !== "COHORT") {
      throw new Error("Unexpected multi-good delivery owner");
    }
    expect(first.world.states.get(f.stateBuyer.stateId)!.treasury)
      .toEqual(f.forward.states.get(f.stateBuyer.stateId)!.treasury);
    expect(first.world.cohorts.get(f.cohortBuyer.cohortId)!.wallet)
      .toEqual(f.forward.cohorts.get(f.cohortBuyer.cohortId)!.wallet);
    const next = executeM5ShipmentDeliveryTick(
      first.world, 9, noOpPhaseHandler, noOpTransition);
    expect(next.context.transactions).toEqual([]);
    expect(next.world).toBe(first.world);
    expect(f.forward.shipments?.size).toBe(f.cargo.length);
  });

  it("rejects balanced owner, bucket and good swaps that preserve stock sums", () => {
    const f = fixture();
    const first = executeM5ShipmentDeliveryTick(
      f.forward, 8, noOpPhaseHandler, noOpTransition);
    const { stateBuyer, cohortBuyer, unitBuyer } = f;
    if (stateBuyer.type !== "STATE" ||
        cohortBuyer.type !== "COHORT" ||
        unitBuyer.type !== "PRODUCTION_UNIT") {
      throw new Error("Incorrect multi-good test owners");
    }
    const state = first.world.states.get(stateBuyer.stateId)!;
    const cohort = first.world.cohorts.get(cohortBuyer.cohortId)!;
    const unit = first.world.productionUnits.get(unitBuyer.productionUnitId)!;
    // Positive control: the actual completed delivery satisfies the full oracle.
    expect(() => assertOwnerGoodBucketDeltas(f.forward, first.world, f.cargo))
      .not.toThrow();

    // Negative control: unbacked FOOD minted into an unlisted seller State.
    // Every manifest recipient still has its exact expected credit.
    const seller = f.cargo[0]!.seller;
    if (seller.type !== "STATE" || seller.stateId === stateBuyer.stateId) {
      throw new Error("Expected a distinct unlisted seller State");
    }
    const sellerState = first.world.states.get(seller.stateId)!;
    const forgedSellerCredit: WorldState = {
      ...first.world,
      states: new Map(first.world.states).set(seller.stateId, {
        ...sellerState,
        publicInventory: new Map(sellerState.publicInventory)
          .set(FOOD, (sellerState.publicInventory.get(FOOD) ?? 0) + 1),
      }),
    };
    expect(() => assertOwnerGoodBucketDeltas(f.forward, forgedSellerCredit, f.cargo))
      .toThrow();

    // Global FOOD stock unchanged, but credited to the wrong beneficiary.
    const forgedOwners: WorldState = {
      ...first.world,
      states: new Map(first.world.states).set(stateBuyer.stateId, {
        ...state, publicInventory: new Map(state.publicInventory)
          .set(FOOD, (state.publicInventory.get(FOOD) ?? 0) - 0.25),
      }),
      cohorts: new Map(first.world.cohorts).set(cohortBuyer.cohortId, {
        ...cohort, householdInventory: new Map(cohort.householdInventory)
          .set(FOOD, (cohort.householdInventory.get(FOOD) ?? 0) + 0.25),
      }),
    };
    expect(() => assertOwnerGoodBucketDeltas(f.forward, forgedOwners, f.cargo)).toThrow();

    // ProductionUnit still owns precisely the same WOOD, but in wrong bucket.
    const forgedBucket: WorldState = {
      ...first.world,
      productionUnits: new Map(first.world.productionUnits).set(
        unitBuyer.productionUnitId, {
          ...unit,
          inputInventory: new Map(unit.inputInventory)
            .set(WOOD, (unit.inputInventory.get(WOOD) ?? 0) - 0.5),
          investmentInventory: new Map(unit.investmentInventory)
            .set(WOOD, (unit.investmentInventory.get(WOOD) ?? 0) + 0.5),
        },
      ),
    };
    expect(() => assertOwnerGoodBucketDeltas(f.forward, forgedBucket, f.cargo)).toThrow();

    // Total unit output quantity unchanged, but FOOD changed into WOOD.
    const forgedGood: WorldState = {
      ...first.world,
      productionUnits: new Map(first.world.productionUnits).set(
        unitBuyer.productionUnitId, {
          ...unit,
          outputInventory: new Map(unit.outputInventory)
            .set(FOOD, (unit.outputInventory.get(FOOD) ?? 0) - 0.25)
            .set(WOOD, (unit.outputInventory.get(WOOD) ?? 0) + 0.25),
        },
      ),
    };
    expect(() => assertOwnerGoodBucketDeltas(f.forward, forgedGood, f.cargo)).toThrow();
  });

  it("settles mixed prior-tick and zero-travel cargo at their own phases for all owner classes", () => {
    const f = fixture();
    const older = f.cargo.slice(0, 2); // State and Cohort FOOD: due in Phase 1.
    const instant = f.cargo.slice(2).map(shipment => ({
      ...shipment, departureTick: 8, arrivalTick: 8, travelTicksAtDispatch: 0,
    })); // ProductionUnit OUTPUT FOOD and INPUT WOOD: dispatched at Phase 7.
    const opening = (entries: readonly TradeShipmentState[]): WorldState => ({
      ...f.forward,
      shipments: new Map(entries.map(shipment => [shipment.id, shipment] as const)),
    });
    const commitAtPhase7 = (entries: readonly TradeShipmentState[]) =>
      (phase: number, world: WorldState): WorldState =>
        phase === 7 ? {
          ...world,
          shipments: new Map([
            ...world.shipments,
            ...entries.map(shipment => [shipment.id, shipment] as const),
          ]),
        } : world;
    const first = executeM5ShipmentDeliveryTick(
      opening(older), 8, noOpPhaseHandler, commitAtPhase7(instant),
    );
    const replay = executeM5ShipmentDeliveryTick(
      opening([...older].reverse()), 8, noOpPhaseHandler,
      commitAtPhase7([...instant].reverse()),
    );
    for (const result of [first, replay]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(result.world.shipments?.size).toBe(0);
      expect(result.context.transactions).toHaveLength(f.cargo.length);
      expect(result.context.transactions.every(tx =>
        tx.type === "SHIPMENT_DELIVERY" &&
        tx.moneyAmount === undefined && tx.currencyId === undefined)).toBe(true);
      const byId = (shipment: TradeShipmentState, phase: 1 | 7) =>
        result.context.transactions.filter(tx =>
          tx.phase === phase && tx.goodId === shipment.goodId &&
          tx.quantity === shipment.quantity &&
          tx.reason === "IN_TRANSIT_TO_" +
            shipment.destinationInventoryBucket + "_STOCK:" + shipment.id);
      for (const shipment of older) expect(byId(shipment, 1)).toHaveLength(1);
      for (const shipment of instant) expect(byId(shipment, 7)).toHaveLength(1);
      // All physical inventory endpoints are checked, not just credited owners.
      assertOwnerGoodBucketDeltas(opening(older), result.world, f.cargo);

      // Phase-7 synthetic committed cargo enters the in-transit ledger at
      // dispatch, while Phase-1 cargo was already present at tick start.
      // Whole-world conservation must account for both waves exactly once.
      const goodsTotal = (world: WorldState, goodId: GoodId) =>
        [...physicalStockEndpoints(world).values()]
          .filter(entry => entry.goodId === goodId)
          .reduce((sum, entry) => sum + entry.quantity, 0) +
        [...world.shipments.values()]
          .filter(shipment => shipment.goodId === goodId)
          .reduce((sum, shipment) => sum + shipment.quantity, 0);
      for (const goodId of [FOOD, WOOD]) {
        const introduced = instant.filter(shipment => shipment.goodId === goodId)
          .reduce((sum, shipment) => sum + shipment.quantity, 0);
        expect(goodsTotal(result.world, goodId))
          .toBeCloseTo(goodsTotal(opening(older), goodId) + introduced, 9);
      }
    }
    expect(replay.context.transactions).toEqual(first.context.transactions);
    expect(replay.world.states).toEqual(first.world.states);
    expect(replay.world.cohorts).toEqual(first.world.cohorts);
    expect(replay.world.productionUnits).toEqual(first.world.productionUnits);
    const next = executeM5ShipmentDeliveryTick(
      first.world, 9, noOpPhaseHandler, noOpTransition,
    );
    expect(next.reconciliationErrors).toBeNull();
    expect(next.context.transactions).toEqual([]);
    expect(next.world).toBe(first.world);
  });

});
