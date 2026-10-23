/** Native negative/positive controls for all-or-nothing M3 allocation materialization (#810). */
import { describe, expect, it } from "vitest";
import type { ClanId, CurrencyId, GoodId, MarketId, RegionId, StateId } from "../domain/id";
import { computeLocalClearing, type LocalClearingInput } from "./marketClearing";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";

const regionId = "r:atomic-tax" as RegionId;
const goodId = "good:atomic-tax" as GoodId;
const marketId = "m:atomic-tax" as MarketId;
const currencyId = "cur:atomic-tax" as CurrencyId;
const treasury = "s:atomic-tax" as StateId;

function buyer(key: string): MarketIntent {
  return {
    id: createMarketIntentId(`mi:buyer-${key}`),
    actor: { type: "CLAN", clanId: `c:buyer-${key}` as ClanId },
    regionId,
    goodId,
    side: "BUY",
    purpose: "CONSUMPTION",
    desiredQuantity: 1,
    maxSpend: 100,
    sourcePlanId: `plan:buyer-${key}`,
  };
}

function seller(quantity: number): MarketIntent {
  return {
    id: createMarketIntentId("mi:seller"),
    actor: { type: "CLAN", clanId: "c:seller" as ClanId },
    regionId,
    goodId,
    side: "SELL",
    purpose: "INVENTORY_REBALANCE",
    desiredQuantity: quantity,
    sourcePlanId: "plan:seller",
  };
}

function input(
  buyers: MarketIntent[] = [buyer("a")],
  tax: LocalClearingInput["getTaxationInfo"] = () => ({
    assessedTaxRate: 0.1, collectionEfficiency: 1, destinationStateId: treasury,
  }),
): LocalClearingInput {
  return {
    marketId, regionId, goodId, marketCurrencyId: currencyId, pass: "MAIN",
    buyerIntents: buyers,
    sellerIntents: [seller(buyers.length)],
    computeEffectiveDemand: (intent) => intent.desiredQuantity,
    computeSellableQuantity: (intent) => intent.desiredQuantity,
    computeGrossUnitPrice: (_intent, price) => price,
    getTaxationInfo: tax,
  };
}

function clear(plan: LocalClearingInput, counter: { value: number }, price = 10) {
  return computeLocalClearing(plan, new Map(), price, 1e-8, counter);
}

describe("local market materialization transactionality", () => {
  it("does not consume the first ID when a later taxation callback throws; exact retry IDs survive", () => {
    let failSecond = true;
    const plan = input([buyer("b"), buyer("a")], (intent) => {
      if (failSecond && intent.id === "mi:buyer-b") throw new Error("late tax service failure");
      return { assessedTaxRate: 0.1, collectionEfficiency: 1, destinationStateId: treasury };
    });
    const counter = { value: 9 };
    expect(() => clear(plan, counter)).toThrow(/late tax service failure/);
    expect(counter.value).toBe(9);
    failSecond = false;
    const allocations = clear(plan, counter);
    expect(allocations).toHaveLength(2);
    expect(allocations.map((a) => a.id)).toEqual([
      "ma:m:atomic-tax/good:atomic-tax/MAIN/10",
      "ma:m:atomic-tax/good:atomic-tax/MAIN/11",
    ]);
    expect(allocations.map((a) => a.buyerIntentId)).toEqual([
      "mi:buyer-a", "mi:buyer-b",
    ]);
    expect(allocations.every((a) =>
      a.quantity === 1 && a.buyerGrossUnitPrice === 11 &&
      a.consumptionTaxAmount === 1 && a.sellerNetUnitPrice === 10)).toBe(true);
    expect(counter.value).toBe(11);
  });

  it.each([NaN, Infinity, -0.01, 1.01])("refuses invalid assessedTaxRate %s before reserving IDs", (rate) => {
    const counter = { value: 4 };
    expect(() => clear(input(undefined, () => ({
      assessedTaxRate: rate, collectionEfficiency: 1, destinationStateId: treasury,
    })), counter)).toThrow(/assessedTaxRate|\[0, 1\]/);
    expect(counter.value).toBe(4);
  });

  it.each([NaN, -0.01, 1.01])("refuses invalid collectionEfficiency %s without spending IDs", (efficiency) => {
    const counter = { value: 4 };
    expect(() => clear(input(undefined, () => ({
      assessedTaxRate: 0.1, collectionEfficiency: efficiency, destinationStateId: treasury,
    })), counter)).toThrow(/collectionEfficiency|\[0, 1\]/);
    expect(counter.value).toBe(4);
  });

  it("rejects gross-unit-price overflow from individually finite market price and tax", () => {
    const counter = { value: 4 };
    expect(() => clear(input(undefined, () => ({
      assessedTaxRate: 1, collectionEfficiency: 1, destinationStateId: treasury,
    })), counter, Number.MAX_VALUE)).toThrow(/must be finite/);
    expect(counter.value).toBe(4);
  });

  it("rejects invalid positive-tax treasury destination before publishing an allocation ID", () => {
    const counter = { value: 4 };
    expect(() => clear(input(undefined, () => ({
      assessedTaxRate: 0.1, collectionEfficiency: 1, destinationStateId: null,
    })), counter)).toThrow(/no State treasury destination/);
    expect(counter.value).toBe(4);
  });

  it("refuses an exhausted or invalid counter before calling the taxation provider", () => {
    let taxCalls = 0;
    const plan = input([buyer("a"), buyer("b")], () => {
      taxCalls++;
      return { assessedTaxRate: 0.1, collectionEfficiency: 1, destinationStateId: treasury };
    });
    for (const value of [-1, NaN, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
      const counter = { value };
      expect(() => clear(plan, counter)).toThrow(/allocation counter/);
      expect(Object.is(counter.value, value)).toBe(true);
    }
    expect(taxCalls).toBe(0);
  });

  it("preserves a deliberate tax-free/zero-price fixture without a treasury", () => {
    const counter = { value: 0 };
    const allocations = clear(input(undefined, () => ({
      assessedTaxRate: 0, collectionEfficiency: 0, destinationStateId: null,
    })), counter, 0);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.buyerGrossUnitPrice).toBe(0);
    expect(allocations[0]!.consumptionTaxAmount).toBe(0);
    expect(allocations[0]!.destinationStateId).toBeNull();
    expect(counter.value).toBe(1);
  });
});
