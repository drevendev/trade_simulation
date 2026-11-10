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
      regionId: testRegionId,
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
      regionId: testRegionId,
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
      regionId: testRegionId,
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

  it("never spends one binary64 ULP above a real buyer budget", () => {
    // Exact long-run M5 Phase-4 bug: tick 11 BUY maximum is below the
    // money value of the rounded-up affordable quantity.
    const maxSpend = 0.8082225516890139;
    const grossPrice = 1.05;
    const intent: MarketIntent = {
      id: createMarketIntentId("mi:buy-ulp"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 100,
      maxSpend,
      sourcePlanId: "plan:ulp",
    };
    expect((maxSpend / grossPrice) * grossPrice).toBeGreaterThan(maxSpend);
    const quantity = computeEffectiveDemand(intent, grossPrice);
    expect(quantity).toBeGreaterThan(0);
    expect(quantity).toBeLessThan(maxSpend / grossPrice);
    expect(quantity * grossPrice).toBeLessThanOrEqual(maxSpend);
    // An exact division is unaffected; an actor with unconstrained demand
    // is not subjected to an arbitrary universal percentage haircut.
    expect(computeEffectiveDemand({ ...intent, maxSpend: 500 }, 10)).toBe(50);
    expect(computeEffectiveDemand({ ...intent, desiredQuantity: 1, maxSpend: 500 }, 10)).toBe(1);
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
      regionId: testRegionId,
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

  it("reserves ordinals for payable matches rather than zero-funded tentative matches", () => {
    // Two physically feasible tentative lots, but the first BUY has no cash.
    // With one safe ordinal left, the payable second trade must still succeed.
    const buyers: MarketIntent[] = [
      {
        id: createMarketIntentId("mi:budget-zero"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 5,
        maxSpend: 0,
        sourcePlanId: "plan:budget-zero",
      },
      {
        id: createMarketIntentId("mi:funded"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 5,
        maxSpend: 10,
        sourcePlanId: "plan:funded",
      },
    ];
    const sellers: MarketIntent[] = [1, 2].map((index) => ({
      id: createMarketIntentId(`mi:reserve-seller-${index}`),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: (`pu:reserve-seller-${index}` as ProductionUnitId) },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 5,
      sourcePlanId: "plan:reserve-seller",
    }));
    const input: LocalClearingInput = {
      ...createTestInput(buyers, sellers),
      computeEffectiveDemand: (intent) => intent.desiredQuantity,
      // Adversarial demand evidence; final payment validation must still
      // discard the zero-funded BUY without spending its allocation ID.
    };
    const lastAvailable = Number.MAX_SAFE_INTEGER - 1;
    const counter = { value: lastAvailable };
    const paid = computeLocalClearing(input, new Map(), 1, 1e-8, counter);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.buyerIntentId).toBe(buyers[1]!.id);
    expect(paid[0]!.quantity).toBe(5);
    expect(paid[0]!.quantity * paid[0]!.buyerGrossUnitPrice).toBeGreaterThan(0);
    expect(paid[0]!.id).toBe(`ma:m:central/good:wheat/MAIN/${Number.MAX_SAFE_INTEGER}`);
    expect(counter.value).toBe(Number.MAX_SAFE_INTEGER);
    expect(computeLocalClearing(
      { ...input, buyerIntents: [...buyers].reverse(), sellerIntents: [...sellers].reverse() },
      new Map(), 1, 1e-8, { value: lastAvailable },
    )).toEqual(paid);

    // After the final representable ordinal is spent, refusal is atomic.
    const exhausted = { value: Number.MAX_SAFE_INTEGER };
    expect(() => computeLocalClearing(input, new Map(), 1, 1e-8, exhausted))
      .toThrow("cannot reserve safe ordinals");
    expect(exhausted.value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("cannot materialize a paid lot with zero budget even if demand evidence is forged", () => {
    // An invalid upstream effective-demand callback can claim positive demand
    // for a zero-funded buyer. At a positive price below one, a binary64
    // subnormal quantity can multiply to a zero debit; it is not a free trade.
    const buyer: MarketIntent = {
      id: createMarketIntentId("mi:unfunded-forged-demand"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 1,
      maxSpend: 0,
      sourcePlanId: "plan:unfunded",
    };
    const seller: MarketIntent = {
      id: createMarketIntentId("mi:unfunded-seller"),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: testProductionUnitId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 1,
      sourcePlanId: "plan:unfunded-seller",
    };
    const input: LocalClearingInput = {
      ...createTestInput([buyer], [seller]),
      computeEffectiveDemand: () => 1, // adversarial: ignores maxSpend
    };
    const counter = { value: 9 };
    expect(computeLocalClearing(input, new Map(), 0.1, 1e-8, counter)).toEqual([]);
    expect(counter.value).toBe(9); // No free stock and no consumed allocation ID.

    // The full-sized forged lot enters the affordability search, but a single
    // subnormal lot has gross debit zero and would bypass that search entirely.
    // Positive physical lots below quantityEpsilon are legal clearing inputs:
    // rejecting unpaid delivery must not depend on a minimum-lot cutoff.
    const subnormal = Number.MIN_VALUE;
    expect(subnormal * (0.1 + 0.1 * 0.1)).toBe(0);
    const tinyInput: LocalClearingInput = {
      ...input,
      buyerIntents: [{ ...buyer, desiredQuantity: subnormal }],
      sellerIntents: [{ ...seller, desiredQuantity: subnormal }],
      computeEffectiveDemand: () => subnormal,
    };
    const tinyCounter = { value: 9 };
    expect(computeLocalClearing(tinyInput, new Map(), 0.1, 1e-8, tinyCounter)).toEqual([]);
    expect(tinyCounter.value).toBe(9);

    // Funding must not turn a mathematically priced subnormal lot into a
    // zero-transfer delivery or a late exception. No allocation ID is spent.
    const fundedTinyCounter = { value: 9 };
    expect(computeLocalClearing(
      { ...tinyInput, buyerIntents: [{ ...buyer, desiredQuantity: subnormal, maxSpend: 1 }] },
      new Map(), 0.1, 1e-8, fundedTinyCounter,
    )).toEqual([]);
    expect(fundedTinyCounter.value).toBe(9);

    // A tiny physical lot whose monetary transfers ARE representable remains
    // tradable; quantityEpsilon is a reconciliation bound, not a minimum lot.
    const paidTinyCounter = { value: 9 };
    const paidTiny = computeLocalClearing(
      { ...tinyInput, buyerIntents: [{ ...buyer, desiredQuantity: subnormal, maxSpend: 1 }] },
      new Map(), 2, 1e-8, paidTinyCounter,
    );
    expect(paidTiny).toHaveLength(1);
    expect(paidTiny[0]!.quantity).toBe(subnormal);
    expect(paidTiny[0]!.quantity * paidTiny[0]!.sellerNetUnitPrice).toBeGreaterThan(0);
    expect(paidTiny[0]!.quantity * paidTiny[0]!.buyerGrossUnitPrice).toBeGreaterThan(0);
    expect(paidTinyCounter.value).toBe(10);

    // Positive control: the same physically feasible match does settle
    // at the same sub-unit price when the buyer has real funds.
    const funded = computeLocalClearing(
      { ...input, buyerIntents: [{ ...buyer, maxSpend: 1 }] },
      new Map(), 0.1, 1e-8, { value: 9 },
    );
    expect(funded).toHaveLength(1);
    expect(funded[0]!.quantity).toBe(1);
    expect(funded[0]!.quantity * funded[0]!.buyerGrossUnitPrice).toBeGreaterThan(0);
    expect(funded[0]!.id).toBe("ma:m:central/good:wheat/MAIN/10");
  });

  it("preserves individually paid micro-lots even when a running binary64 sum absorbs their debit", () => {
    const price = 1e16;
    const tinyQuantity = 1e-17;
    expect(tinyQuantity * price).toBeGreaterThan(0);
    expect(0.5 * price + tinyQuantity * price).toBe(0.5 * price);

    const buyer: MarketIntent = {
      id: createMarketIntentId("mi:absorbed-buyer"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 1,
      maxSpend: price,
      sourcePlanId: "plan:absorbed",
    };
    const seller = (ordinal: number, quantity: number): MarketIntent => ({
      id: createMarketIntentId(`mi:absorbed-seller-${ordinal}`),
      actor: {
        type: "PRODUCTION_UNIT",
        productionUnitId: (`pu:absorbed-${ordinal}` as ProductionUnitId),
      },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: quantity,
      sourcePlanId: "plan:absorbed",
    });
    const sellers = [seller(1, 0.5), seller(2, tinyQuantity), seller(3, 0.5)];
    const input: LocalClearingInput = {
      ...createTestInput([buyer], sellers),
      computeGrossUnitPrice: (_intent, netPrice) => netPrice,
      computeEffectiveDemand,
      getTaxationInfo: () => ({
        destinationStateId: null,
        assessedTaxRate: 0,
        collectionEfficiency: 1,
      }),
    };
    const counter = { value: 30 };
    const allocations = computeLocalClearing(input, new Map(), price, 1e-8, counter);
    // The second lot has its own representable positive payment. Discarding
    // it merely because a separate running total absorbs 0.1 breaks SLP-787
    // balanced matching and per-lot settlement semantics.
    // Exact dyadic matching may split an owner's fill into multiple lots;
    // preserve each seller, not an assumed one-allocation-per-seller shape.
    expect(new Set(allocations.map(a => a.sellerIntentId))).toEqual(
      new Set(sellers.map(s => s.id)),
    );
    expect(allocations.map(a => a.id)).toEqual(allocations.map(
      (_, index) => `ma:m:central/good:wheat/MAIN/${31 + index}`,
    ));
    const tinyLots = allocations.filter(a => a.sellerIntentId === sellers[1]!.id);
    expect(tinyLots).not.toHaveLength(0);
    expect(tinyLots.reduce((sum, a) => sum + a.quantity, 0)).toBe(tinyQuantity);
    for (const lot of tinyLots) {
      expect(lot.quantity * lot.buyerGrossUnitPrice).toBeGreaterThan(0);
      expect(lot.quantity * lot.sellerNetUnitPrice).toBeGreaterThan(0);
    }
    expect(counter.value).toBe(30 + allocations.length);
    expect(allocations.reduce((sum, a) => sum + a.quantity * a.buyerGrossUnitPrice, 0))
      .toBeLessThanOrEqual(buyer.maxSpend!);
    expect(computeLocalClearing(
      { ...input, sellerIntents: [...sellers].reverse() },
      new Map(), price, 1e-8, { value: 30 },
    )).toEqual(allocations);

    // No global minimum lot: the identical micro-lot can trade when it is
    // the *first* debit and its positive payment is representable.
    const firstDebitCounter = { value: 30 };
    const alone = computeLocalClearing(
      {
        ...input,
        buyerIntents: [{ ...buyer, desiredQuantity: tinyQuantity }],
        sellerIntents: [sellers[1]!],
      },
      new Map(), price, 1e-8, firstDebitCounter,
    );
    expect(alone).toHaveLength(1);
    expect(alone[0]!.quantity).toBe(tinyQuantity);
    expect(alone[0]!.quantity * alone[0]!.buyerGrossUnitPrice).toBeGreaterThan(0);
    expect(firstDebitCounter.value).toBe(31);
  });

  it("caps the actual two-seller buyer debit, not only aggregate affordable demand", () => {
    // Binary64 counterexample: the rounded aggregate q * gross is affordable,
    // but its two separately materialized match debits are one ULP too large.
    const net = 1.0001355523809525;
    const gross = net + net * 0.05;
    const budget = 0.0001123729857;
    const aggregate = budget / gross;
    const first = aggregate / 9;
    const second = aggregate - first;
    expect(aggregate * gross).toBe(budget);
    expect(first * gross + second * gross).toBeGreaterThan(budget);

    const buyer: MarketIntent = {
      id: createMarketIntentId("mi:split-buyer"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 1,
      maxSpend: budget,
      sourcePlanId: "plan:split-buyer",
    };
    const seller = (ordinal: number, quantity: number): MarketIntent => ({
      id: createMarketIntentId(`mi:split-seller-${ordinal}`),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: (`pu:split-${ordinal}` as ProductionUnitId) },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: quantity,
      sourcePlanId: "plan:split-seller",
    });
    const sellers = [seller(1, first), seller(2, second)];
    const input: LocalClearingInput = {
      ...createTestInput([buyer], sellers),
      computeGrossUnitPrice: (_intent, price) => price + price * 0.05,
      computeEffectiveDemand,
      getTaxationInfo: () => ({
        destinationStateId: testStateId,
        assessedTaxRate: 0.05,
        collectionEfficiency: 1,
      }),
    };
    const counter = { value: 0 };
    const allocations = computeLocalClearing(input, new Map(), net, 1e-8, counter);
    expect(allocations).toHaveLength(2); // Both sellers actually clear stock.
    expect(allocations.map(a => a.sellerIntentId)).toEqual(sellers.map(s => s.id));
    // The exact-capacity matcher may itself reduce an initial fill by a few
    // dyadic units. The budget guard must not *increase* either seller's
    // physical allocation and both must retain positive deliveries.
    expect(allocations[0]!.quantity).toBeGreaterThan(0);
    expect(allocations[0]!.quantity).toBeLessThanOrEqual(first);
    expect(allocations[1]!.quantity).toBeGreaterThan(0);
    expect(allocations[1]!.quantity).toBeLessThanOrEqual(second);
    const spent = allocations.reduce(
      (sum, allocation) => sum + allocation.quantity * allocation.buyerGrossUnitPrice, 0,
    );
    expect(spent).toBeLessThanOrEqual(budget);
    expect(spent).toBeGreaterThan(0);
    expect(allocations.reduce((sum, allocation) => sum + allocation.quantity, 0))
      .toBeLessThanOrEqual(aggregate);
    expect(counter.value).toBe(2);
    // Shuffled insertion is not permitted to change which owner receives
    // the rounding tail or the buyer's exact budget result.
    expect(computeLocalClearing(
      { ...input, sellerIntents: [...sellers].reverse() },
      new Map(), net, 1e-8, { value: 0 },
    )).toEqual(allocations);
  });

  it("bounds three separately rounded seller debits across deterministic taxed price sweeps", () => {
    // Exercise materialized seller-match debits, not only aggregate Q * gross.
    // The earlier fixed two-seller ULP counterexample remains an exact witness;
    // this sweep protects its per-BUY-intent commitment rule across price scales.
    for (let caseIndex = 0; caseIndex < 48; caseIndex++) {
      const rate = [0, 0.05, 0.2, 0.37][caseIndex % 4]!;
      const netPrice = 0.01 + (caseIndex + 1) * 0.000987654321;
      const budget = 0.12 + caseIndex * 0.001013;
      const grossPrice = netPrice + netPrice * rate;
      const affordable = budget / grossPrice;
      const caps = [affordable * 0.17, affordable * 0.31, affordable * 0.71];
      const buyer: MarketIntent = {
        id: createMarketIntentId("mi:sweep-buyer"),
        actor: { type: "CLAN", clanId: testClanId },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: affordable * 2,
        maxSpend: budget,
        sourcePlanId: "plan:sweep-buyer",
      };
      const sellers: MarketIntent[] = caps.map((cap, index) => ({
        id: createMarketIntentId(`mi:sweep-seller-${index}`),
        actor: {
          type: "PRODUCTION_UNIT",
          productionUnitId: (`pu:sweep-${index}` as ProductionUnitId),
        },
        regionId: testRegionId,
        goodId: testGoodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: cap,
        sourcePlanId: "plan:sweep-seller",
      }));
      const input: LocalClearingInput = {
        ...createTestInput([buyer], sellers),
        computeGrossUnitPrice: (_intent, price) => price + price * rate,
        computeEffectiveDemand,
        getTaxationInfo: () => ({
          destinationStateId: testStateId,
          assessedTaxRate: rate,
          collectionEfficiency: 1,
        }),
      };
      const counter = { value: 0 };
      const fills = computeLocalClearing(input, new Map(), netPrice, 1e-8, counter);
      expect(fills, `case ${caseIndex}`).toHaveLength(3);
      expect(counter.value).toBe(3);
      const debits = fills.reduce(
        (sum, fill) => sum + fill.quantity * fill.buyerGrossUnitPrice, 0,
      );
      expect(debits, `case ${caseIndex} overspent budget`).toBeLessThanOrEqual(budget);
      expect(debits).toBeGreaterThan(0);
      for (let index = 0; index < 3; index++) {
        const fill = fills[index]!;
        expect(fill.sellerIntentId).toBe(sellers[index]!.id);
        expect(fill.quantity).toBeGreaterThan(0);
        expect(fill.quantity).toBeLessThanOrEqual(caps[index]!);
        expect(fill.buyerGrossUnitPrice).toBe(grossPrice);
      }
      // Sorting is an explicit economic reproducibility contract, including
      // which seller receives the final one-ULP quantity adjustment.
      expect(computeLocalClearing(
        { ...input, sellerIntents: [...sellers].reverse() },
        new Map(), netPrice, 1e-8, { value: 0 },
      )).toEqual(fills);
    }
  });

  it("rolls back the allocation counter when a later tax callback fails", () => {
    // A late rejection must not leak IDs allocated for earlier seller matches.
    // A retry from the same tick counter must emit the canonical contiguous IDs.
    const buyer: MarketIntent = {
      id: createMarketIntentId("mi:atomic-buyer"),
      actor: { type: "CLAN", clanId: testClanId },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 10,
      maxSpend: 150,
      sourcePlanId: "plan:atomic-buyer",
    };
    const sellers: MarketIntent[] = [1, 2].map((index) => ({
      id: createMarketIntentId(`mi:atomic-seller-${index}`),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: (`pu:atomic-${index}` as ProductionUnitId) },
      regionId: testRegionId,
      goodId: testGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 5,
      sourcePlanId: "plan:atomic-seller",
    }));
    const input = createTestInput([buyer], sellers);
    let taxCalls = 0;
    const rejecting: LocalClearingInput = {
      ...input,
      getTaxationInfo: (...args) => {
        taxCalls++;
        if (taxCalls === 2) throw new Error("late-tax-rejection");
        return input.getTaxationInfo(...args);
      },
    };
    const counter = { value: 20 };
    expect(() => computeLocalClearing(rejecting, new Map(), 10, 1e-8, counter))
      .toThrow("late-tax-rejection");
    expect(taxCalls).toBe(2);
    expect(counter.value).toBe(20);

    const retried = computeLocalClearing(input, new Map(), 10, 1e-8, counter);
    expect(retried).toHaveLength(2);
    expect(retried.map((allocation) => allocation.quantity)).toEqual([5, 5]);
    expect(retried.map((allocation) => allocation.id)).toEqual([
      "ma:m:central/good:wheat/MAIN/21",
      "ma:m:central/good:wheat/MAIN/22",
    ]);
    expect(counter.value).toBe(22);
    expect(retried).toEqual(computeLocalClearing(input, new Map(), 10, 1e-8, { value: 20 }));
  });

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
      regionId: testRegionId,
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
      regionId: testRegionId,
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
