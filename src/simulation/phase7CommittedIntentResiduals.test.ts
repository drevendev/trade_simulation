import { describe, expect, it } from "vitest";
import type { CohortId, GoodId, ProductionUnitId, RegionId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import {
  projectPhase8CommittedTradeResiduals as projectWithPrecision,
  type CommittedPhase7ShipmentLot,
} from "./phase7CommittedIntentResiduals";

// Handoff/03 §3: canonical numeric quantity/money precision (both 1e-9).
const precision = { quantityEpsilon: 1e-9, moneyEpsilon: 1e-9 } as const;
function projectPhase8CommittedTradeResiduals(
  intents: readonly MarketIntent[], lots: readonly CommittedPhase7ShipmentLot[],
): MarketIntent[] {
  return projectWithPrecision(intents, lots, precision);
}

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

  it("refuses a rounded goods subtraction that changes stock by MORE than the committed quantity", () => {
    const hugeSeller = { ...seller, desiredQuantity: 1e16 };
    // 1e16 - 3 rounds to 1e16 - 4. A merely observable debit is not correct.
    expect(hugeSeller.desiredQuantity - (hugeSeller.desiredQuantity - 3)).toBe(4);
    expect(() => projectPhase8CommittedTradeResiduals([hugeSeller, buyer], [
      committed("sh:three-units", 3, 3),
    ])).toThrow(/seller quantity loses binary64 debit precision/);

    // Exact representable decrement at the same scale is still allowed.
    const exact = projectPhase8CommittedTradeResiduals([hugeSeller, buyer], [
      committed("sh:four-units", 4, 4),
    ]);
    expect(byId(exact, seller.id).desiredQuantity).toBe(1e16 - 4);
  });

  it("refuses a rounded buyer-cash subtraction that spends MORE than the settled debit", () => {
    const hugeWalletBuyer = { ...buyer, maxSpend: 1e16 };
    expect(hugeWalletBuyer.maxSpend - (hugeWalletBuyer.maxSpend - 3)).toBe(4);
    expect(() => projectPhase8CommittedTradeResiduals([seller, hugeWalletBuyer], [
      committed("sh:three-cash", 1, 3),
    ])).toThrow(/buyer destination-currency spend loses binary64 debit precision/);
  });

  it("permits harmless sub-epsilon binary64 rounding and rejects invalid configured tolerances", () => {
    const decimalBuyer = { ...buyer, desiredQuantity: 0.3, maxSpend: 0.3 };
    const decimalSeller = { ...seller, desiredQuantity: 0.3 };
    const residuals = projectPhase8CommittedTradeResiduals([decimalSeller, decimalBuyer], [
      committed("sh:decimal", 0.1, 0.1),
    ]);
    expect(byId(residuals, buyer.id).maxSpend).toBeCloseTo(0.2, 12);

    for (const invalid of [NaN, Infinity, -1]) {
      expect(() => projectWithPrecision([seller, buyer], [], {
        quantityEpsilon: invalid, moneyEpsilon: 1e-9,
      })).toThrow(/finite nonnegative quantity and money precision/);
      expect(() => projectWithPrecision([seller, buyer], [], {
        quantityEpsilon: 1e-9, moneyEpsilon: invalid,
      })).toThrow(/finite nonnegative quantity and money precision/);
    }
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
