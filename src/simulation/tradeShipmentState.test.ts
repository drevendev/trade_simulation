import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId, ShipmentId, StateId, ClanId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { deliverDueTradeShipments } from "./tradeShipmentDelivery";
import { buildInitialWorld, type WorldState } from "./worldState";
import {
  validateTradeShipmentRegistry,
  validateTradeShipmentState,
  type TradeShipmentState,
} from "./tradeShipmentState";

function genesis(): WorldState {
  return buildInitialWorld(baselineScenario, baselineDefinitionPack,
    createDefaultSimulationConfig(), 37);
}
const world = genesis();

function sample(): TradeShipmentState {
  const link = [...world.transportLinks.values()].find((candidate) =>
    candidate.fromRegionId !== candidate.toRegionId &&
    candidate.travelTicks !== undefined,
  );
  if (!link || link.travelTicks === undefined) {
    throw new Error("Missing inter-regional directed route fixture");
  }
  const states = [...world.states.values()];
  if (states.length < 2) throw new Error("Missing two independent State owners");
  const seller: ActorRef = { type: "STATE", stateId: states[0]!.stateId };
  const buyer: ActorRef = { type: "STATE", stateId: states[1]!.stateId };
  const invoiceCurrencyId = world.regions.get(link.fromRegionId)!.settlementCurrencyId;
  const buyerPaymentCurrencyId = world.regions.get(link.toRegionId)!.settlementCurrencyId;
  return {
    id: "sh:37:alpha-beta:food:1" as ShipmentId,
    goodId: "good:food" as GoodId,
    quantity: 3,
    originRegionId: link.fromRegionId,
    destinationRegionId: link.toRegionId,
    seller,
    buyer,
    routeLinkIds: [link.linkId],
    transportLinkId: link.linkId,
    departureTick: 37,
    arrivalTick: 37 + link.travelTicks,
    status: "IN_TRANSIT",
    invoiceCurrencyId,
    buyerPaymentCurrencyId,
    sellerNetUnitPrice: 10,
    buyerGoodsPaymentAmount: 31,
    transportFeeAmount: 2,
    tariffAmount: 1,
    consumptionTaxAmount: 0.5,
    ...(invoiceCurrencyId === buyerPaymentCurrencyId
      ? {} : { fxSettlementId: "fxs:ship:37:1" }),
    beneficialOwner: buyer,
    destinationInventoryBucket: "GENERAL",
  };
}

function differentCurrency(from: CurrencyId): CurrencyId {
  const other = [...world.currencies.keys()].find((id) => id !== from);
  if (!other) throw new Error("Missing independent currency fixture");
  return other;
}

describe("M5 #673 persistent in-transit stock schema and canonical genesis", () => {
  it("seeds an independent, empty shipment registry for every deterministic world", () => {
    const first = genesis();
    const second = genesis();
    expect(first.shipments).toBeInstanceOf(Map);
    expect(first.shipments?.size).toBe(0);
    expect(second.shipments?.size).toBe(0);
    expect(first.shipments).not.toBe(second.shipments);
    expect(() => validateTradeShipmentRegistry(first)).not.toThrow();
  });

  it("validates one persistent, direct-link, buyer-owned in-transit record without posting stock", () => {
    const shipment = sample();
    const beforeTreasury = [...world.states.values()].map((state) =>
      [...state.treasury.entries()]);
    expect(() => validateTradeShipmentState(world, shipment)).not.toThrow();
    const committedShape: WorldState = {
      ...world, shipments: new Map([[shipment.id, shipment]]),
    };
    expect(() => validateTradeShipmentRegistry(committedShape)).not.toThrow();
    // Shape validation is not authorization to create physical stock.
    expect(world.shipments?.size).toBe(0);
    expect([...world.states.values()].map((state) =>
      [...state.treasury.entries()])).toEqual(beforeTreasury);
  });

  it("rejects unknown goods in both single-record and persistent registry validation", () => {
    const valid = sample();
    expect(Object.prototype.hasOwnProperty.call(
      world.definitionRegistry.goods, valid.goodId,
    )).toBe(true);
    expect(() => validateTradeShipmentState(world, valid)).not.toThrow();

    const unknown = { ...valid, goodId: "good:not-defined" as GoodId };
    expect(Object.prototype.hasOwnProperty.call(
      world.definitionRegistry.goods, unknown.goodId,
    )).toBe(false);
    expect(() => validateTradeShipmentState(world, unknown))
      .toThrow(/goodId.*unknown GoodDefinition/);

    const stored = new Map([[unknown.id, unknown]]);
    const candidate: WorldState = { ...world, shipments: stored };
    expect(() => validateTradeShipmentRegistry(candidate))
      .toThrow(/goodId.*unknown GoodDefinition/);
    // Rejection must never remove or rewrite the invalid candidate or alter genesis.
    expect(candidate.shipments).toBe(stored);
    expect(stored.get(unknown.id)).toEqual(unknown);
    expect(world.shipments?.size).toBe(0);
  });

  it("requires FX evidence only when the frozen invoice/payment currencies differ", () => {
    const shipment = sample();
    const other = differentCurrency(shipment.buyerPaymentCurrencyId);
    const foreign = { ...shipment, invoiceCurrencyId: other,
      fxSettlementId: "fxs:verified" };
    expect(() => validateTradeShipmentState(world, foreign)).not.toThrow();
    const { fxSettlementId: _ignored, ...foreignWithoutFx } = foreign;
    expect(() => validateTradeShipmentState(world, foreignWithoutFx))
      .toThrow(/fxSettlementId/);
    // A historical same-currency dispatch may outlive a later region policy change.
    const { fxSettlementId: _used, ...withoutFx } = foreign;
    const same = { ...withoutFx,
      invoiceCurrencyId: foreign.buyerPaymentCurrencyId };
    expect(() => validateTradeShipmentState(world, same)).not.toThrow();
    expect(() => validateTradeShipmentState(world, {
      ...same, fxSettlementId: "fxs:wrong",
    })).toThrow(/same-currency/);
  });

  it("rejects invalid physical amount, money and tick evidence before it can become stock", () => {
    const valid = sample();
    for (const quantity of [0, -1, NaN, Infinity]) {
      expect(() => validateTradeShipmentState(world, {
        ...valid, quantity,
      })).toThrow(/quantity/);
    }
    for (const transportFeeAmount of [-1, NaN, Infinity]) {
      expect(() => validateTradeShipmentState(world, {
        ...valid, transportFeeAmount,
      })).toThrow(/transportFeeAmount/);
    }
    for (const departureTick of [-1, 0.2, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateTradeShipmentState(world, {
        ...valid, departureTick,
      })).toThrow(/departureTick/);
    }
  });

  it("rejects wrong route, destination, arrival and multi-hop drift", () => {
    const valid = sample();
    expect(() => validateTradeShipmentState(world, {
      ...valid, originRegionId: valid.destinationRegionId,
    })).toThrow(/distinct regions/);
    expect(() => validateTradeShipmentState(world, {
      ...valid, routeLinkIds: [valid.transportLinkId, valid.transportLinkId],
    })).toThrow(/one directed link/);
    expect(() => validateTradeShipmentState(world, {
      ...valid, arrivalTick: valid.arrivalTick + 1,
    })).toThrow(/arrival tick/);
    expect(() => validateTradeShipmentState(world, {
      ...valid, arrivalTick: valid.departureTick - 1,
    })).toThrow(/arrival tick/);
  });

  it("refuses self-owned persisted cargo before any delivery credit", () => {
    const original = sample();
    // State public inventory is intentionally unlocated, so the distinct
    // origin/destination regions cannot themselves reject this forged record.
    const impossible: TradeShipmentState = {
      ...original, buyer: original.seller, beneficialOwner: original.seller,
    };
    const persisted: WorldState = {
      ...world, shipments: new Map([[impossible.id, impossible]]),
    };
    const owner = original.seller;
    if (owner.type !== "STATE") throw new Error("Expected State seller fixture");
    const before = world.states.get(owner.stateId)!.publicInventory;
    expect(() => validateTradeShipmentState(world, impossible))
      .toThrow(/distinct goods owners/);
    expect(() => validateTradeShipmentRegistry(persisted))
      .toThrow(/distinct goods owners/);
    expect(() => deliverDueTradeShipments(persisted, {
      tick: impossible.arrivalTick,
      phase: impossible.arrivalTick === impossible.departureTick ? 7 : 1,
      priorTransactions: [],
    })).toThrow(/distinct goods owners/);
    expect(persisted.shipments?.get(impossible.id)).toBe(impossible);
    expect(world.states.get(owner.stateId)!.publicInventory).toBe(before);
    expect(persisted.states.get(owner.stateId)!.publicInventory).toBe(before);
  });

  it("rejects phantom buyers, unsupported goods owners and forged ownership", () => {
    const valid = sample();
    expect(() => validateTradeShipmentState(world, {
      ...valid, buyer: { type: "STATE", stateId: "s:not-live" as StateId },
    })).toThrow(/missing actor/);
    expect(() => validateTradeShipmentState(world, {
      ...valid, seller: { type: "CLAN", clanId: "c:any" as ClanId },
    })).toThrow(/no canonical goods inventory/);
    expect(() => validateTradeShipmentState(world, {
      ...valid, beneficialOwner: valid.seller,
    })).toThrow(/paid buyer/);
    expect(() => validateTradeShipmentState(world, {
      ...valid, destinationInventoryBucket: "INPUT",
    })).toThrow(/inventory bucket/);
  });


  it("rejects region-mismatched Cohort/ProductionUnit endpoints before delivery", () => {
    const valid = sample();
    const originKey = world.regions.get(valid.originRegionId)!.seed.key;
    const destinationKey = world.regions.get(valid.destinationRegionId)!.seed.key;
    const cohorts = [...world.cohorts.values()];
    const units = [...world.productionUnits.values()];
    const sourceCohort = cohorts.find(cohort => cohort.seed.regionKey === originKey);
    const destinationUnit = units.find(unit => unit.seed.regionKey === destinationKey);
    const wrongSourceCohort = cohorts.find(cohort => cohort.seed.regionKey !== originKey);
    const wrongSourceUnit = units.find(unit => unit.seed.regionKey !== originKey);
    const wrongDestinationCohort = cohorts.find(cohort =>
      cohort.seed.regionKey !== destinationKey);
    const wrongDestinationUnit = units.find(unit =>
      unit.seed.regionKey !== destinationKey);
    if (!sourceCohort || !destinationUnit || !wrongSourceCohort ||
        !wrongSourceUnit || !wrongDestinationCohort || !wrongDestinationUnit) {
      throw new Error("Missing cross-region shipment actor fixtures");
    }
    const seller: ActorRef = { type: "COHORT", cohortId: sourceCohort.cohortId };
    const buyer: ActorRef = {
      type: "PRODUCTION_UNIT", productionUnitId: destinationUnit.productionUnitId,
    };
    const legal = { ...valid, seller, buyer, beneficialOwner: buyer,
      destinationInventoryBucket: "INPUT" as const };
    expect(() => validateTradeShipmentState(world, legal)).not.toThrow();

    const foreignCohortBuyer: ActorRef = {
      type: "COHORT", cohortId: wrongDestinationCohort.cohortId,
    };
    const foreignUnitBuyer: ActorRef = {
      type: "PRODUCTION_UNIT", productionUnitId: wrongDestinationUnit.productionUnitId,
    };
    const cases: { record: TradeShipmentState; role: string }[] = [
      { record: { ...legal, seller: {
        type: "COHORT", cohortId: wrongSourceCohort.cohortId,
      } }, role: "seller" },
      { record: { ...legal, seller: {
        type: "PRODUCTION_UNIT", productionUnitId: wrongSourceUnit.productionUnitId,
      } }, role: "seller" },
      { record: { ...legal, buyer: foreignCohortBuyer,
        beneficialOwner: foreignCohortBuyer,
        destinationInventoryBucket: "GENERAL" }, role: "buyer" },
      { record: { ...legal, buyer: foreignUnitBuyer,
        beneficialOwner: foreignUnitBuyer }, role: "buyer" },
    ];
    for (const { record, role } of cases) {
      const candidate: WorldState = {
        ...world, shipments: new Map([[record.id, record]]),
      };
      expect(() => validateTradeShipmentRegistry(candidate))
        .toThrow(new RegExp(role + " region"));
      expect(() => deliverDueTradeShipments(candidate, {
        tick: record.arrivalTick, phase: 1, priorTransactions: [],
      })).toThrow(new RegExp(role + " region"));
      expect(candidate.shipments?.get(record.id)).toBe(record);
      expect(world.shipments?.size).toBe(0);
    }
  });

  it("accepts only in-transit records with an unambiguous shipment identity", () => {
    const valid = sample();
    expect(() => validateTradeShipmentState(world, {
      ...valid, id: "wrong:identity" as ShipmentId,
    })).toThrow(/sh: prefix/);
    expect(() => validateTradeShipmentState(world, {
      ...valid, status: "DELIVERED" as "IN_TRANSIT",
    })).toThrow(/IN_TRANSIT/);
    expect(() => validateTradeShipmentRegistry({
      ...world, shipments: new Map([["sh:wrong" as ShipmentId, valid]]),
    })).toThrow(/registry key/);
    const { shipments: _legacy, ...worldWithoutShipments } = world;
    expect(() => validateTradeShipmentRegistry(worldWithoutShipments))
      .toThrow(/registry is missing/);
  });

  it("does not mistake an uncommitted actor match or quote for a stock movement", () => {
    const valid = sample();
    const stored = new Map([[valid.id, valid]]);
    const copy: WorldState = { ...world, shipments: stored };
    validateTradeShipmentRegistry(copy);
    expect(world.shipments).toBeInstanceOf(Map);
    expect(world.shipments?.size).toBe(0);
    // Validation never materializes its own registry or changes the candidate.
    expect(copy.shipments).toBe(stored);
    expect(stored.get(valid.id)).toEqual(valid);
  });
});
