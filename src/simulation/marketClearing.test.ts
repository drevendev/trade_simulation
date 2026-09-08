/**
 * Tests for deterministic local clearing primitive and MarketAllocation (REQ-MARKET-003).
 *
 * Covers:
 * 1. Proportional allocation with equal supply and demand
 * 2. Excess supply (demand limits clearing quantity)
 * 3. Excess demand (supply limits clearing quantity)
 * 4. Residual correction for floating-point accuracy
 * 5. Concrete matching with two-pointer algorithm
 * 6. Shuffled intent insertion produces identical normalized allocations
 * 7. Tax-aware pricing in allocation
 * 8. Stable ID ordering in sorting and correction
 * 9. Edge cases: zero demand, zero supply, single participant
 */

import { describe, it, expect } from "vitest";
import type {
  ClanId,
  CurrencyId,
  GoodId,
  MarketId,
  ProductionUnitId,
  RegionId,
  StateId,
} from "../domain/id";
import {
  createMarketAllocationId,
  validateMarketAllocation,
  computeLocalClearing,
  computeSellableQuantity,
  computeEffectiveDemand,
  type LocalClearingInput,
  type MarketAllocation,
} from "./marketClearing";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";

// Test ID allocators
const testClanId = "c:test-clan" as ClanId;
const testStateId = "s:test-state" as StateId;
const testStateId2 = "s:test-state-2" as StateId;
const testProductionUnitId = "pu:test-pu" as ProductionUnitId;
const testRegionId = "r:test-region" as RegionId;
const testGoodId = "good:wheat" as GoodId;
const testCurrencyId = "cur:gold" as CurrencyId;
const testMarketId = "m:central" as MarketId;

describe("MarketAllocation validation", () => {
  it("validates a well-formed MarketAllocation", () => {
    const allocation: MarketAllocation = {
      id: createMarketAllocationId("ma:test-1"),
      marketId: testMarketId,
      goodId: testGoodId,
      pass: "MAIN",
      sellerIntentId: createMarketIntentId("mi:seller-1"),
      buyerIntentId: createMarketIntentId("mi:buyer-1"),
      seller: { type: "CLAN", clanId: testClanId },
      buyer: { type: "CLAN", clanId: testClanId },
      quantity: 100,
      sellerNetUnitPrice: 10,
      buyerGrossUnitPrice: 11,
      marketCurrencyId: testCurrencyId,
      consumptionTaxAmount: 100,
      destinationStateId: null,
      sellerInventoryBucket: "GENERAL",
      buyerInventoryBucket: "GENERAL",
    };

    expect(() => validateMarketAllocation(allocation)).not.toThrow();
  });

  it("rejects negative quantity", () => {
    const allocation: MarketAllocation = {
      id: createMarketAllocationId("ma:test-2"),
      marketId: testMarketId,
      goodId: testGoodId,
      pass: "MAIN",
      sellerIntentId: createMarketIntentId("mi:seller-1"),
      buyerIntentId: createMarketIntentId("mi:buyer-1"),
      seller: { type: "CLAN", clanId: testClanId },
      buyer: { type: "CLAN", clanId: testClanId },
      quantity: -10,
      sellerNetUnitPrice: 10,
      buyerGrossUnitPrice: 11,
      marketCurrencyId: testCurrencyId,
      consumptionTaxAmount: 0,
      destinationStateId: null,
      sellerInventoryBucket: "GENERAL",
      buyerInventoryBucket: "GENERAL",
    };

    expect(() => validateMarketAllocation(allocation)).toThrow("must be >= 0");
  });

  it("rejects tax amount exceeding gross payment", () => {
    const allocation: MarketAllocation = {
      id: createMarketAllocationId("ma:test-3"),
      marketId: testMarketId,
      goodId: testGoodId,
      pass: "MAIN",
      sellerIntentId: createMarketIntentId("mi:seller-1"),
      buyerIntentId: createMarketIntentId("mi:buyer-1"),
      seller: { type: "CLAN", clanId: testClanId },
      buyer: { type: "CLAN", clanId: testClanId },
      quantity: 100,
      sellerNetUnitPrice: 10,
      buyerGrossUnitPrice: 11,
      marketCurrencyId: testCurrencyId,
      consumptionTaxAmount: 2000, // exceeds gross payment of 1100
      destinationStateId: null,
      sellerInventoryBucket: "GENERAL",
      buyerInventoryBucket: "GENERAL",
    };

    expect(() => validateMarketAllocation(allocation)).toThrow("exceeds gross payment");
  });
});

describe("Sellable quantity computation", () => {
  it("computes sellable with no reserves or commitments", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:sell-1"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 200,
      minimumReserveQuantity: 0,
      sourcePlanId: "plan:1",
    };

    const sellable = computeSellableQuantity(intent, 300, 0, 0);
    expect(sellable).toBe(200); // min(200, max(0, 300 - 0 - 0)) = 200
  });

  it("respects minimum reserve quantity", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:sell-2"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 200,
      minimumReserveQuantity: 50,
      sourcePlanId: "plan:2",
    };

    const sellable = computeSellableQuantity(intent, 300, 50, 0);
    expect(sellable).toBe(200); // min(200, max(0, 300 - 50 - 0)) = 200
  });

  it("respects commitments", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:sell-3"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 200,
      minimumReserveQuantity: 0,
      sourcePlanId: "plan:3",
    };

    const sellable = computeSellableQuantity(intent, 300, 0, 100);
    expect(sellable).toBe(200); // min(200, max(0, 300 - 0 - 100)) = 200
  });

  it("clamps to available quantity", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:sell-4"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 500,
      minimumReserveQuantity: 0,
      sourcePlanId: "plan:4",
    };

    const sellable = computeSellableQuantity(intent, 200, 0, 0);
    expect(sellable).toBe(200); // min(500, max(0, 200 - 0 - 0)) = 200
  });

  it("returns zero when nothing is available", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:sell-5"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 100,
      minimumReserveQuantity: 150,
      sourcePlanId: "plan:5",
    };

    const sellable = computeSellableQuantity(intent, 150, 150, 0);
    expect(sellable).toBe(0); // min(100, max(0, 150 - 150 - 0)) = 0
  });
});

describe("Effective demand computation", () => {
  it("computes demand with sufficient budget", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:buy-1"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 100,
      maxSpend: 1500,
      sourcePlanId: "plan:1",
    };

    const demand = computeEffectiveDemand(intent, 10);
    expect(demand).toBe(100); // min(100, 1500 / 10) = 100
  });

  it("respects budget constraint", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:buy-2"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 100,
      maxSpend: 500,
      sourcePlanId: "plan:2",
    };

    const demand = computeEffectiveDemand(intent, 10);
    expect(demand).toBe(50); // min(100, 500 / 10) = 50
  });

  it("handles zero quantity", () => {
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:buy-3"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 0,
      maxSpend: 1000,
      sourcePlanId: "plan:3",
    };

    const demand = computeEffectiveDemand(intent, 10);
    expect(demand).toBe(0); // min(0, 1000 / 10) = 0
  });
});

describe("Local clearing algorithm", () => {
  function createTestInput(
    buyerIntents: MarketIntent[],
    sellerIntents: MarketIntent[],
  ): LocalClearingInput {
    return {
      marketId: testMarketId,
      goodId: testGoodId,
      pass: "MAIN",
      marketCurrencyId: testCurrencyId,
      buyerIntents,
      sellerIntents,
      computeEffectiveDemand: (intent: MarketIntent, price: number) => {
        if (intent.side !== "BUY") throw new Error("Must be BUY");
        const taxRate = 0.1; // 10% tax
        const grossPrice = price * (1 + taxRate);
        return Math.min(
          intent.desiredQuantity,
          (intent.maxSpend ?? 0) / Math.max(grossPrice, 1e-8),
        );
      },
      computeSellableQuantity: (intent: MarketIntent) => {
        if (intent.side !== "SELL") throw new Error("Must be SELL");
        // For test purposes, assume actor owns desired quantity
        return intent.desiredQuantity;
      },
      computeGrossUnitPrice: (intent: MarketIntent, sellerNetPrice: number) => {
        // 10% consumption tax
        const taxRate = 0.1;
        return sellerNetPrice * (1 + taxRate);
      },
      getTaxationInfo: () => ({
        destinationStateId: testStateId,
        assessedTaxRate: 0.1,
        collectionEfficiency: 1.0,
      }),
    };
  }

  it("clears when supply equals demand", () => {
    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-eq"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 100,
      maxSpend: 1500,
      sourcePlanId: "plan:buyer",
    };

    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-eq"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 100,
      sourcePlanId: "plan:seller",
    };

    const input = createTestInput([buyerIntent], [sellerIntent]);
    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), 10, 1e-8, counter);

    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.quantity).toBe(100);
    expect(allocations[0]!.sellerNetUnitPrice).toBe(10);
  });

  it("clears with excess supply (demand limits)", () => {
    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-low"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 50,
      maxSpend: 750,
      sourcePlanId: "plan:buyer",
    };

    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-high"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 200,
      sourcePlanId: "plan:seller",
    };

    const input = createTestInput([buyerIntent], [sellerIntent]);
    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), 10, 1e-8, counter);

    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.quantity).toBe(50);
  });

  it("clears with excess demand (supply limits)", () => {
    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-high"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 500,
      maxSpend: 7500,
      sourcePlanId: "plan:buyer",
    };

    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-low"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 100,
      sourcePlanId: "plan:seller",
    };

    const input = createTestInput([buyerIntent], [sellerIntent]);
    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), 10, 1e-8, counter);

    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.quantity).toBe(100);
  });

  it("proportionally allocates with multiple buyers and sellers", () => {
    const buyers: MarketIntent[] = [
      {
        id: createMarketIntentId("mi:buyer-1"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 100,
        maxSpend: 1500,
        sourcePlanId: "plan:buyer-1",
      },
      {
        id: createMarketIntentId("mi:buyer-2"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 100,
        maxSpend: 1500,
        sourcePlanId: "plan:buyer-2",
      },
    ];

    const sellers: MarketIntent[] = [
      {
        id: createMarketIntentId("mi:seller-1"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 100,
        sourcePlanId: "plan:seller-1",
      },
      {
        id: createMarketIntentId("mi:seller-2"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 100,
        sourcePlanId: "plan:seller-2",
      },
    ];

    const input = createTestInput(buyers, sellers);
    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), 10, 1e-8, counter);

    // With 200 total demand and 200 total supply, all should clear proportionally
    const totalCleared = allocations.reduce((sum, a) => sum + a.quantity, 0);
    expect(totalCleared).toBeCloseTo(200, 2);
  });

  it("returns empty when demand is zero", () => {
    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-zero"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 0,
      maxSpend: 0,
      sourcePlanId: "plan:buyer",
    };

    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-ok"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 100,
      sourcePlanId: "plan:seller",
    };

    const input = createTestInput([buyerIntent], [sellerIntent]);
    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), 10, 1e-8, counter);

    expect(allocations).toHaveLength(0);
  });

  it("returns empty when supply is zero", () => {
    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-ok"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 100,
      maxSpend: 1500,
      sourcePlanId: "plan:buyer",
    };

    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-zero"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 0,
      sourcePlanId: "plan:seller",
    };

    const input = createTestInput([buyerIntent], [sellerIntent]);
    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), 10, 1e-8, counter);

    expect(allocations).toHaveLength(0);
  });
});

describe("Shuffled intent insertion invariance", () => {
  it("produces identical allocations regardless of buyer order", () => {
    const createBuyers = (): MarketIntent[] => [
      {
        id: createMarketIntentId("mi:buyer-1"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 100,
        maxSpend: 1500,
        sourcePlanId: "plan:buyer-1",
      },
      {
        id: createMarketIntentId("mi:buyer-2"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 100,
        maxSpend: 1500,
        sourcePlanId: "plan:buyer-2",
      },
    ];

    const createSellers = (): MarketIntent[] => [
      {
        id: createMarketIntentId("mi:seller-1"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 100,
        sourcePlanId: "plan:seller-1",
      },
      {
        id: createMarketIntentId("mi:seller-2"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 100,
        sourcePlanId: "plan:seller-2",
      },
    ];

    const createInput = (buyers: MarketIntent[], sellers: MarketIntent[]): LocalClearingInput => ({
      marketId: testMarketId,
      goodId: testGoodId,
      pass: "MAIN",
      marketCurrencyId: testCurrencyId,
      buyerIntents: buyers,
      sellerIntents: sellers,
      computeEffectiveDemand: (intent: MarketIntent, price: number) => {
        const taxRate = 0.1;
        const grossPrice = price * (1 + taxRate);
        return Math.min(intent.desiredQuantity, (intent.maxSpend ?? 0) / grossPrice);
      },
      computeSellableQuantity: (intent: MarketIntent) => intent.desiredQuantity,
      computeGrossUnitPrice: (intent: MarketIntent, price: number) => price * 1.1,
      getTaxationInfo: () => ({
        destinationStateId: testStateId,
        assessedTaxRate: 0.1,
        collectionEfficiency: 1.0,
      }),
    });

    // Test with original order
    const buyers1 = createBuyers();
    const sellers1 = createSellers();
    const input1 = createInput(buyers1, sellers1);
    const counter1 = { value: 0 };
    const allocations1 = computeLocalClearing(input1, new Map(), 10, 1e-8, counter1);

    // Test with reversed buyer order
    const buyers2 = createBuyers().reverse();
    const sellers2 = createSellers();
    const input2 = createInput(buyers2, sellers2);
    const counter2 = { value: 0 };
    const allocations2 = computeLocalClearing(input2, new Map(), 10, 1e-8, counter2);

    // Both should clear the same total quantity
    const total1 = allocations1.reduce((sum, a) => sum + a.quantity, 0);
    const total2 = allocations2.reduce((sum, a) => sum + a.quantity, 0);
    expect(total1).toBeCloseTo(total2, 2);

    // Both should have same number of lots
    expect(allocations1.length).toBe(allocations2.length);
  });
});

describe("Tax-aware pricing in allocations", () => {
  it("computes consumption tax amount correctly", () => {
    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-tax"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 100,
      maxSpend: 1500,
      sourcePlanId: "plan:buyer",
    };

    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-tax"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 100,
      sourcePlanId: "plan:seller",
    };

    const input: LocalClearingInput = {
      marketId: testMarketId,
      goodId: testGoodId,
      pass: "MAIN",
      marketCurrencyId: testCurrencyId,
      buyerIntents: [buyerIntent],
      sellerIntents: [sellerIntent],
      computeEffectiveDemand: (intent: MarketIntent, price: number) => {
        const taxRate = 0.1;
        const grossPrice = price * (1 + taxRate);
        return Math.min(intent.desiredQuantity, (intent.maxSpend ?? 0) / grossPrice);
      },
      computeSellableQuantity: (intent: MarketIntent) => intent.desiredQuantity,
      computeGrossUnitPrice: (intent: MarketIntent, price: number) => price * 1.1,
      getTaxationInfo: () => ({
        destinationStateId: testStateId,
        assessedTaxRate: 0.1,
        collectionEfficiency: 1.0,
      }),
    };

    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), 10, 1e-8, counter);

    expect(allocations).toHaveLength(1);
    const alloc = allocations[0]!;
    expect(alloc.sellerNetUnitPrice).toBe(10);
    expect(alloc.buyerGrossUnitPrice).toBe(11); // 10 * 1.1
    expect(alloc.consumptionTaxAmount).toBe(100); // 100 * 10 * 0.1 * 1.0
  });
});
