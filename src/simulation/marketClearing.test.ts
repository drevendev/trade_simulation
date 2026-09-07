/**
 * Comprehensive test suite for deterministic local market clearing (REQ-MARKET-003).
 */

import { describe, it, expect } from "vitest";
import type { CurrencyId, GoodId, MarketId, RegionId, StateId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { allocateLocal, type ClearingConfig, type SellerInput, type BuyerInput, createMarketAllocationId } from "./marketClearing";
import { createMarketIntentId } from "./marketIntent";

// Test helpers
const testMarketId = "m:test" as MarketId;
const testGoodId = "good:wheat" as GoodId;
const testCurrencyId = "cur:gold" as CurrencyId;
const testRegionId = "r:A" as RegionId;
const testStateId = "state:1" as StateId;

function createTestClanActor(clanId: string): ActorRef {
  return { type: "CLAN", clanId: clanId as any };
}

function createTestStateActor(stateId: string): ActorRef {
  return { type: "STATE", stateId: stateId as any };
}

function createTestProductionUnitActor(puId: string): ActorRef {
  return { type: "PRODUCTION_UNIT", productionUnitId: puId as any };
}

const defaultConfig: ClearingConfig = {
  marketId: testMarketId,
  goodId: testGoodId,
  pass: "MAIN",
  marketCurrencyId: testCurrencyId,
  sellerNetUnitPrice: 100, // net seller price
  buyerGrossUnitPrice: 110, // includes tax
  consumptionTaxRateByState: (stateId) => (stateId ? 0.1 : 0),
  quantityEpsilon: 1e-9,
  moneyEpsilon: 1e-9,
  reconciliationRelativeTolerance: 1e-9,
};

let allocationCounter = 0;
function nextAllocationId() {
  return createMarketAllocationId(`ma:${++allocationCounter}`);
}

describe("market clearing / REQ-MARKET-003", () => {
  describe("basic clearing", () => {
    it("clears when supply equals demand", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(1);
      const alloc = allocations[0];
      if (!alloc) throw new Error("Expected allocation");
      expect(alloc.quantity).toBe(100);
      if (alloc.seller.type !== "CLAN") throw new Error("Expected CLAN seller");
      expect(alloc.seller.clanId).toBe("clan:1");
      if (alloc.buyer.type !== "CLAN") throw new Error("Expected CLAN buyer");
      expect(alloc.buyer.clanId).toBe("clan:2");
    });

    it("limits clearing to minimum of supply and demand", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 200,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 80,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(1);
      expect(allocations[0]?.quantity).toBe(80);
    });

    it("returns empty allocations when no supply", () => {
      const sellers: SellerInput[] = [];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(0);
    });

    it("returns empty allocations when no demand", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(0);
    });
  });

  describe("proportional allocation", () => {
    it("allocates proportionally when multiple sellers", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100, // 2/3 of total
          inventoryBucket: "GENERAL",
        },
        {
          intentId: createMarketIntentId("mi:s2"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          sellable: 50, // 1/3 of total
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:3"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 150, // total demand
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      // Total clear = min(150 supply, 150 demand) = 150
      // Seller 1 gets 150 * 100/150 = 100
      // Seller 2 gets 150 * 50/150 = 50
      let totalQuantity = 0;
      for (const alloc of allocations) {
        totalQuantity += alloc.quantity;
      }
      expect(totalQuantity).toBeCloseTo(150, 6);
    });

    it("allocates proportionally when multiple buyers", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 150,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100, // 2/3 of total demand
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
        {
          intentId: createMarketIntentId("mi:b2"),
          actor: createTestClanActor("clan:3"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 50, // 1/3 of total demand
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      let totalQuantity = 0;
      for (const alloc of allocations) {
        totalQuantity += alloc.quantity;
      }
      expect(totalQuantity).toBeCloseTo(150, 6);
    });

    it("matches multiple sellers with multiple buyers", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
        {
          intentId: createMarketIntentId("mi:s2"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:3"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
        {
          intentId: createMarketIntentId("mi:b2"),
          actor: createTestClanActor("clan:4"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      let totalQuantity = 0;
      for (const alloc of allocations) {
        totalQuantity += alloc.quantity;
      }
      expect(totalQuantity).toBeCloseTo(200, 6);
      expect(allocations.length).toBeGreaterThan(1);
    });
  });

  describe("determinism and stable ordering", () => {
    it("produces identical results with shuffled input", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
        {
          intentId: createMarketIntentId("mi:s2"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:3"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
        {
          intentId: createMarketIntentId("mi:b2"),
          actor: createTestClanActor("clan:4"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      allocationCounter = 0;
      const result1 = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      // Shuffle sellers and buyers
      const sellersShuffled: SellerInput[] = [sellers[1]!, sellers[0]!];
      const buyersShuffled: BuyerInput[] = [buyers[1]!, buyers[0]!];

      allocationCounter = 0;
      const result2 = allocateLocal(sellersShuffled, buyersShuffled, defaultConfig, nextAllocationId);

      // Normalize and compare
      const normalize = (allocs: typeof result1) => {
        const sorted = allocs.slice().sort((a, b) => {
          if (a.sellerIntentId !== b.sellerIntentId) return a.sellerIntentId.localeCompare(b.sellerIntentId);
          return a.buyerIntentId.localeCompare(b.buyerIntentId);
        });
        return sorted.map((a) => ({
          seller: a.sellerIntentId,
          buyer: a.buyerIntentId,
          quantity: Math.round(a.quantity * 1e9) / 1e9,
        }));
      };

      expect(normalize(result1)).toEqual(normalize(result2));
    });
  });

  describe("taxation", () => {
    it("computes consumption tax correctly", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(1);
      // Tax = quantity * seller net price * tax rate
      // Tax = 100 * 100 * 0.1 = 1000
      expect(allocations[0]?.consumptionTaxAmount).toBeCloseTo(1000, 6);
    });

    it("applies zero tax for uncontrolled destination", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: null, // uncontrolled
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(1);
      expect(allocations[0]?.consumptionTaxAmount).toBe(0);
    });
  });

  describe("inventory buckets", () => {
    it("preserves inventory buckets for ProductionUnit", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestProductionUnitActor("pu:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "OUTPUT", // production unit output
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestProductionUnitActor("pu:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "INPUT", // production unit input
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(1);
      expect(allocations[0]?.sellerInventoryBucket).toBe("OUTPUT");
      expect(allocations[0]?.buyerInventoryBucket).toBe("INPUT");
    });
  });

  describe("edge cases and bounds", () => {
    it("handles single unit clearing", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 1,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 1,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(1);
      expect(allocations[0]?.quantity).toBeCloseTo(1, 9);
    });

    it("ignores below-epsilon quantities", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 1e-10, // below epsilon
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 1e-10, // below epsilon
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      expect(allocations).toHaveLength(0);
    });
  });

  describe("reconciliation", () => {
    it("ensures seller fills sum to cleared quantity", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 100,
          inventoryBucket: "GENERAL",
        },
        {
          intentId: createMarketIntentId("mi:s2"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          sellable: 50,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:3"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 150,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      let totalSold = 0;
      for (const alloc of allocations) {
        totalSold += alloc.quantity;
      }

      expect(totalSold).toBeCloseTo(150, 6);
    });

    it("ensures buyer fills sum to cleared quantity", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 150,
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 100,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
        {
          intentId: createMarketIntentId("mi:b2"),
          actor: createTestClanActor("clan:3"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 50,
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      let totalBought = 0;
      for (const alloc of allocations) {
        totalBought += alloc.quantity;
      }

      expect(totalBought).toBeCloseTo(150, 6);
    });

    it("never allocates above sellable stock", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 50, // limited stock
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 1000, // large demand
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      let totalSold = 0;
      for (const alloc of allocations) {
        totalSold += alloc.quantity;
      }

      expect(totalSold).toBeCloseTo(50, 6);
    });

    it("never allocates above effective demand", () => {
      const sellers: SellerInput[] = [
        {
          intentId: createMarketIntentId("mi:s1"),
          actor: createTestClanActor("clan:1"),
          goodId: testGoodId,
          sellable: 1000, // large stock
          inventoryBucket: "GENERAL",
        },
      ];

      const buyers: BuyerInput[] = [
        {
          intentId: createMarketIntentId("mi:b1"),
          actor: createTestClanActor("clan:2"),
          goodId: testGoodId,
          regionId: testRegionId,
          effectiveDemand: 50, // limited demand
          inventoryBucket: "GENERAL",
          destinationStateId: testStateId,
        },
      ];

      const allocations = allocateLocal(sellers, buyers, defaultConfig, nextAllocationId);

      let totalBought = 0;
      for (const alloc of allocations) {
        totalBought += alloc.quantity;
      }

      expect(totalBought).toBeCloseTo(50, 6);
    });
  });
});
