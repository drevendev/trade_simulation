import { describe, expect, it } from "vitest";
import type { CurrencyId, GoodId, MarketId, RegionId, StateId } from "../domain/id";
import { computeLocalClearing, type LocalClearingInput, type MarketAllocation } from "./marketClearing";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { exactBinary64QuantityScaled as scaled } from "./marketClearing.exactBinary64Quantity";
import { buildExactMatchPlan, exactPlanWithinCapacities } from "./marketClearing.exactMatchPlan";

const regionId = "r:slp78701" as RegionId;
const marketId = "m:slp78701" as MarketId;
const goodId = "good:slp78701" as GoodId;
const currencyId = "cur:slp78701" as CurrencyId;
const stateId = "s:slp78701" as StateId;
const quantities = [128815828.07405503, 0.000003986101270010248, 765.5404474851422, 9.685900454960775e-11];
const Q = [...quantities].reverse().reduce((sum, value) => sum + value, 0);
const absolute = (value: bigint): bigint => value < 0n ? -value : value;

function permutations<T>(values: readonly T[]): T[][] {
  if (!values.length) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, other) => index !== other)).map((tail) => [value, ...tail]),
  );
}

function sourceInput(side: "BUY" | "SELL", oppositeFactor: number) {
  const many: MarketIntent[] = quantities.map((quantity, index) => ({
    id: createMarketIntentId(`mi:balanced-many-${index}`),
    actor: { type: "STATE", stateId: `s:balanced-${3 - index}` as StateId },
    regionId, goodId, side,
    purpose: "INVENTORY_REBALANCE", desiredQuantity: quantity,
    ...(side === "BUY" ? { maxSpend: quantity } : {}),
    sourcePlanId: `plan:balanced-${index}`,
  }));
  const opposite: MarketIntent = {
    id: createMarketIntentId("mi:balanced-opposite"),
    actor: { type: "STATE", stateId }, regionId, goodId,
    side: side === "BUY" ? "SELL" : "BUY",
    purpose: "INVENTORY_REBALANCE", desiredQuantity: Q * oppositeFactor,
    ...(side === "SELL" ? { maxSpend: Q * oppositeFactor } : {}),
    sourcePlanId: "plan:balanced-opposite",
  };
  return { many, opposite };
}

function run(side: "BUY" | "SELL", many: MarketIntent[], opposite: MarketIntent[], epsilon: number) {
  let taxationCalls = 0;
  const counter = { value: 40 };
  const input: LocalClearingInput = {
    marketId, regionId, goodId, pass: "MAIN", marketCurrencyId: currencyId,
    buyerIntents: side === "BUY" ? many : opposite,
    sellerIntents: side === "SELL" ? many : opposite,
    computeEffectiveDemand: (intent) => intent.desiredQuantity,
    computeSellableQuantity: (intent) => intent.desiredQuantity,
    computeGrossUnitPrice: (_intent, price) => price,
    getTaxationInfo: () => {
      taxationCalls++;
      return { destinationStateId: stateId, assessedTaxRate: 0, collectionEfficiency: 1 };
    },
  };
  return {
    execute: () => computeLocalClearing(input, new Map(), 1, epsilon, counter),
    counter,
    taxCalls: () => taxationCalls,
  };
}

function expectCapacities(lots: MarketAllocation[], intents: MarketIntent[]): void {
  for (const intent of intents) {
    const received = lots.filter((lot) =>
      (intent.side === "BUY" ? lot.buyerIntentId : lot.sellerIntentId) === intent.id,
    ).reduce((sum, lot) => sum + scaled(lot.quantity), 0n);
    expect(received).toBeGreaterThan(0n);
    expect(received).toBeLessThanOrEqual(scaled(intent.desiredQuantity));
  }
}

describe("SLP-787-01 exact balanced clearing", () => {
  for (const epsilon of [1e-8, 1e-9]) {
    it.each(["BUY", "SELL"] as const)(`clears balanced %s at ${epsilon} for all 24 permutations`, (side) => {
      const { many, opposite } = sourceInput(side, 1);
      const reference = run(side, many, [opposite], epsilon).execute();
      expect(reference.length).toBeGreaterThan(0);
      expect(Math.abs(reference.reduce((sum, lot) => sum + lot.quantity, 0) - Q)).toBeLessThanOrEqual(epsilon);
      const exactTotal = reference.reduce((sum, lot) => sum + scaled(lot.quantity), 0n);
      expect(absolute(exactTotal - scaled(Q))).toBeLessThanOrEqual(scaled(epsilon));
      expect(reference.some((lot) => lot.quantity === quantities[3])).toBe(true);
      expectCapacities(reference, [...many, opposite]);
      const orders = permutations(many);
      expect(orders).toHaveLength(24);
      for (const order of orders) {
        const before = JSON.stringify(order);
        const invocation = run(side, order, [opposite], epsilon);
        const actual = invocation.execute();
        expect(actual).toEqual(reference);
        expect(invocation.counter.value).toBe(40 + actual.length);
        expect(invocation.taxCalls()).toBe(actual.length);
        expect(JSON.stringify(order)).toBe(before);
      }
    });
  }

  it.each(["BUY", "SELL"] as const)("preserves the 2Q %s positive control", (side) => {
    const { many, opposite } = sourceInput(side, 2);
    const invocation = run(side, many, [opposite], 1e-8);
    const lots = invocation.execute();
    expect(lots.length).toBeGreaterThan(0);
    expect(absolute(lots.reduce((sum, lot) => sum + scaled(lot.quantity), 0n) - scaled(Q)))
      .toBeLessThanOrEqual(scaled(1e-8));
    expectCapacities(lots, [...many, opposite]);
    expect(invocation.taxCalls()).toBe(lots.length);
  });

  it("detects the rounded-sum negative control without calling the feasible market impossible", () => {
    const exact = quantities.reduce((sum, quantity) => sum + scaled(quantity), 0n);
    expect(absolute(exact - scaled(Q))).toBeGreaterThan(scaled(1e-9));
    expect([...quantities].reverse().reduce((sum, quantity) => sum + quantity, 0)).toBe(Q);
    // Reconciliation, not a wider tolerance, makes the emitted plan feasible.
    const { many, opposite } = sourceInput("BUY", 1);
    expect(() => run("BUY", many, [opposite], 1e-9).execute()).not.toThrow();
  });

  it("rejects reused intent identity before taxation and allocation-ID consumption", () => {
    const { many, opposite } = sourceInput("BUY", 1);
    const duplicate = many.map((intent) => ({ ...intent, id: many[0]!.id }));
    const invocation = run("BUY", duplicate, [opposite], 1e-8);
    expect(invocation.execute).toThrow();
    expect(invocation.counter.value).toBe(40);
    expect(invocation.taxCalls()).toBe(0);
  });

  it("does not exceed exact physical capacity to satisfy an impossible target", () => {
    const sellers = [{ intent: { id: "s" }, correctedFill: 1, capacity: 1 }];
    const buyers = [{ intent: { id: "b" }, correctedFill: 2, capacity: 2 }];
    expect(() => buildExactMatchPlan(sellers, buyers, 2, 1e-9)).toThrow(/physical capacity/);
  });

  it("keeps proportional targets distinct from physical capacities", () => {
    const sellers = [{ intent: { id: "s" }, correctedFill: 1, capacity: 2 }];
    const buyers = [{ intent: { id: "b" }, correctedFill: 1, capacity: 2 }];
    const safe = [{ seller: sellers[0]!.intent, buyer: buyers[0]!.intent, quantity: 1 + 5e-10 }];
    expect(exactPlanWithinCapacities(safe, sellers, buyers, 1, 1e-9)).toBe(true);
    const overdrawn = [{ ...safe[0]!, quantity: 2.1 }];
    expect(exactPlanWithinCapacities(overdrawn, sellers, buyers, 1, 1e-9)).toBe(false);
  });
});
