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
import type { ActorRef } from "../domain/genesisLedger";
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

function stock(
  world: WorldState, actor: ActorRef,
  bucket: ShipmentDestinationInventoryBucket, goodId: GoodId,
): number {
  if (actor.type === "STATE") {
    if (bucket !== "GENERAL") throw new Error("invalid State stock bucket");
    return world.states.get(actor.stateId)!.publicInventory.get(goodId) ?? 0;
  }
  if (actor.type === "COHORT") {
    if (bucket !== "GENERAL") throw new Error("invalid Cohort stock bucket");
    return world.cohorts.get(actor.cohortId)!.householdInventory.get(goodId) ?? 0;
  }
  if (actor.type === "PRODUCTION_UNIT") {
    const unit = world.productionUnits.get(actor.productionUnitId)!;
    if (bucket === "INPUT") return unit.inputInventory.get(goodId) ?? 0;
    if (bucket === "OUTPUT") return unit.outputInventory.get(goodId) ?? 0;
    if (bucket === "INVESTMENT") return unit.investmentInventory.get(goodId) ?? 0;
  }
  throw new Error("Invalid destination stock owner/bucket");
}

function assertOwnerGoodBucketDeltas(
  before: WorldState, after: WorldState, cargo: readonly TradeShipmentState[],
): void {
  // Independently project each physical transfer from immutable dispatch
  // evidence. No aggregate total can substitute for owner+good+bucket identity.
  const groups = new Map<string, { sample: TradeShipmentState; amount: number }>();
  for (const shipment of cargo) {
    const key = JSON.stringify([
      shipment.beneficialOwner, shipment.goodId, shipment.destinationInventoryBucket,
    ]);
    const previous = groups.get(key);
    groups.set(key, {
      sample: shipment, amount: (previous?.amount ?? 0) + shipment.quantity,
    });
  }
  for (const [key, { sample, amount }] of groups) {
    const initial = stock(before, sample.beneficialOwner,
      sample.destinationInventoryBucket, sample.goodId);
    const observed = stock(after, sample.beneficialOwner,
      sample.destinationInventoryBucket, sample.goodId) - initial;
    expect(observed, "owner/good/bucket " + key).toBeCloseTo(amount, 9);
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

    for (const good of [FOOD, WOOD]) {
      const selected = f.cargo.filter(shipment => shipment.goodId === good);
      const openingStock = selected.reduce((sum, shipment) =>
        sum + stock(f.forward, shipment.beneficialOwner,
          shipment.destinationInventoryBucket, shipment.goodId), 0);
      const closingStock = selected.reduce((sum, shipment) =>
        sum + stock(first.world, shipment.beneficialOwner,
          shipment.destinationInventoryBucket, shipment.goodId), 0);
      const inTransit = selected.reduce((sum, shipment) => sum + shipment.quantity, 0);
      expect(closingStock).toBeCloseTo(openingStock + inTransit, 9);
    }
    expect(first.world.states.get(
      f.stateBuyer.type === "STATE" ? f.stateBuyer.stateId : ""
    )!.treasury).toEqual(f.forward.states.get(
      f.stateBuyer.type === "STATE" ? f.stateBuyer.stateId : ""
    )!.treasury);
    expect(first.world.cohorts.get(
      f.cohortBuyer.type === "COHORT" ? f.cohortBuyer.cohortId : ""
    )!.wallet).toEqual(f.forward.cohorts.get(
      f.cohortBuyer.type === "COHORT" ? f.cohortBuyer.cohortId : ""
    )!.wallet);
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
});
