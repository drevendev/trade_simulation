import { describe, expect, it } from "vitest";
import type { CohortId, GoodId, ProductionUnitId, RegionId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import {
  projectPhase8CommittedTradeResiduals,
  type CommittedPhase7ShipmentLot,
} from "./phase7CommittedIntentResiduals";

const origin = "region:origin" as RegionId;
const destination = "region:destination" as RegionId;
const food = "good:food" as GoodId;
const tools = "good:tools" as GoodId;

const seller: MarketIntent = {
  id: createMarketIntentId("mi:dispatch-seller"),
  actor: { type: "PRODUCTION_UNIT", productionUnitId: "unit:seller" as ProductionUnitId },
  regionId: origin, goodId: food, side: "SELL",
  purpose: "INVENTORY_REBALANCE", desiredQuantity: 8,
  minimumReserveQuantity: 2, inventoryBucket: "OUTPUT",
  sourcePlanId: "plan:seller",
};
const buyer: MarketIntent = {
  id: createMarketIntentId("mi:dispatch-buyer"),
  actor: { type: "COHORT", cohortId: "cohort:buyer" as CohortId },
  regionId: destination, goodId: food, side: "BUY",
  purpose: "CONSUMPTION", desiredQuantity: 6, maxSpend: 60,
  sourcePlanId: "plan:buyer",
};

function committed(shipmentId: string, quantity: number, debit: number): CommittedPhase7ShipmentLot {
  return {
    shipmentId, sellerIntentId: seller.id, buyerIntentId: buyer.id,
    originRegionId: origin, destinationRegionId: destination,
    goodId: food, dispatchedQuantity: quantity, buyerTotalDebitDest: debit,
  };
}

function byId(intents: readonly MarketIntent[], id: MarketIntent["id"]): MarketIntent {
  const found = intents.find((intent) => intent.id === id);
  if (!found) throw new Error(`missing intent ${id}`);
  return found;
}

describe("M5 #670 committed Phase-7 -> Phase-8 MAIN residual projection", () => {
  it("subtracts only REALIZED dispatched quantity and buyer destination-currency spend", () => {
    const inputs = [seller, buyer];
    const receipts = [committed("sh:1", 4, 40)];
    const projection = projectPhase8CommittedTradeResiduals(inputs, receipts);
    expect(byId(projection, seller.id)).toMatchObject({
      desiredQuantity: 4, inventoryBucket: "OUTPUT", minimumReserveQuantity: 2,
    });
    expect(byId(projection, buyer.id)).toMatchObject({
      desiredQuantity: 2, maxSpend: 20, purpose: "CONSUMPTION",
    });
    expect(inputs).toEqual([seller, buyer]);
    expect(receipts).toEqual([committed("sh:1", 4, 40)]);
    expect(projection[0]).not.toBe(inputs[1]);
  });

  it("debits multiple committed shipments exactly once and is insertion-order invariant", () => {
    const lots = [committed("sh:b", 2, 20), committed("sh:a", 3, 30)];
    const forward = projectPhase8CommittedTradeResiduals([seller, buyer], lots);
    const reverse = projectPhase8CommittedTradeResiduals([buyer, seller], [...lots].reverse());
    expect(reverse).toEqual(forward);
    expect(byId(forward, seller.id).desiredQuantity).toBe(3);
    expect(byId(forward, buyer.id).desiredQuantity).toBe(1);
    expect(byId(forward, buyer.id).maxSpend).toBe(10);
  });

  it("keeps uncommitted planning from stealing any Phase-8 resources", () => {
    const result = projectPhase8CommittedTradeResiduals([seller, buyer], []);
    expect(result).toEqual([buyer, seller]); // canonical MarketIntent id order
    expect(result[0]).not.toBe(buyer);
  });

  it("rejects duplicate shipment and duplicate MarketIntent IDs", () => {
    expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
      committed("sh:one", 1, 10), committed("sh:one", 1, 10),
    ])).toThrow(/unique persistent shipment IDs/);
    expect(() => projectPhase8CommittedTradeResiduals([seller, seller, buyer], []))
      .toThrow(/duplicate MarketIntent/);
  });

  it("rejects wrong intent identity, sides, good, origin or destination", () => {
    const base = committed("sh:one", 1, 10);
    const changes: Partial<CommittedPhase7ShipmentLot>[] = [
      { sellerIntentId: buyer.id },
      { buyerIntentId: seller.id },
      { sellerIntentId: createMarketIntentId("mi:unknown") },
      { goodId: tools },
      { originRegionId: destination },
      { destinationRegionId: origin },
    ];
    for (const change of changes) {
      expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
        { ...base, ...change },
      ])).toThrow(/stale intent, good or region evidence/);
    }
  });

  it("rejects oversold goods, overallocated demand and overdrawn buyer cash", () => {
    expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
      committed("sh:one", 7, 7),
    ])).toThrow(/buyer quantity exceeds/);
    expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
      committed("sh:one", 1, 61),
    ])).toThrow(/buyer destination-currency spend exceeds/);
    expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
      committed("sh:one", 4, 30), committed("sh:two", 4, 30),
    ])).toThrow(/buyer quantity exceeds/);
    const shortSeller = { ...seller, desiredQuantity: 1 };
    expect(() => projectPhase8CommittedTradeResiduals([shortSeller, buyer], [
      committed("sh:one", 2, 20),
    ])).toThrow(/seller quantity exceeds/);
  });

  it("fails closed on nonpositive/nonfinite quantities, zero cash debit and malformed IDs", () => {
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
        committed("sh:one", invalid, 1),
      ])).toThrow(/dispatchedQuantity/);
      expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
        committed("sh:one", 1, invalid),
      ])).toThrow(/buyerTotalDebitDest/);
    }
    expect(() => projectPhase8CommittedTradeResiduals([seller, buyer], [
      committed("not-a-shipment", 1, 1),
    ])).toThrow(/unique persistent shipment IDs/);
  });

  it("refuses positive binary64 debits that leave authority numerically unchanged", () => {
    const hugeSeller = { ...seller, desiredQuantity: 1e16 };
    expect(() => projectPhase8CommittedTradeResiduals([hugeSeller, buyer], [
      committed("sh:one", 0.01, 0.01),
    ])).toThrow(/seller quantity loses binary64 debit precision/);
    const hugeBuyer = { ...buyer, maxSpend: 1e16 };
    expect(() => projectPhase8CommittedTradeResiduals([seller, hugeBuyer], [
      committed("sh:one", 1, 0.01),
    ])).toThrow(/buyer destination-currency spend loses binary64 debit precision/);
  });
});
