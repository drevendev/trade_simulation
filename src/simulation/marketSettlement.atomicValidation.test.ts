/** Native regressions for Issue #427's stock/ledger preflight and identity boundary. */
import { describe, expect, it } from "vitest";
import type { CohortId, CurrencyId, GoodId, MarketId, ProductionUnitId, RegionId, StateId } from "../domain/id";
import { createMarketAllocationId, type MarketAllocation } from "./marketClearing";
import { createMarketIntentId } from "./marketIntent";
import {
  computeConsumptionTax,
  createConsumptionTaxTransaction,
  createMarketSaleTransaction,
  executeMarketSettlement,
  preflightMarketSettlement,
} from "./marketSettlement";
import { createTransactionBundleId, createTransactionId } from "./tickOrchestrator";

function allocation(overrides: Partial<MarketAllocation> = {}): MarketAllocation {
  return {
    id: createMarketAllocationId("ma:atomic-0"),
    marketId: "m:atomic" as MarketId,
    regionId: "r:atomic" as RegionId,
    goodId: "good:food" as GoodId,
    pass: "MAIN",
    sellerIntentId: createMarketIntentId("mi:seller"),
    buyerIntentId: createMarketIntentId("mi:buyer"),
    seller: { type: "PRODUCTION_UNIT", productionUnitId: "pu:seller" as ProductionUnitId },
    buyer: { type: "COHORT", cohortId: "co:buyer" as CohortId },
    sellerInventoryBucket: "OUTPUT",
    buyerInventoryBucket: "GENERAL",
    quantity: 10,
    sellerNetUnitPrice: 2,
    buyerGrossUnitPrice: 2.5,
    consumptionTaxAmount: 5,
    destinationStateId: "s:treasury" as StateId,
    marketCurrencyId: "cur:local" as CurrencyId,
    ...overrides,
  };
}

const saleId = createTransactionId("tx:1:8:market-sale:0");
const bundleId = createTransactionBundleId("tb:direct");

describe("shared settlement preflight — derived amounts and recipient ownership", () => {
  it.each([
    { quantity: Number.MAX_VALUE, sellerNetUnitPrice: 2, buyerGrossUnitPrice: 2, consumptionTaxAmount: 0 },
    { quantity: Number.MAX_VALUE, sellerNetUnitPrice: 0.5, buyerGrossUnitPrice: 2, consumptionTaxAmount: 0 },
    { quantity: 1, sellerNetUnitPrice: Number.MAX_VALUE, buyerGrossUnitPrice: Number.MAX_VALUE, consumptionTaxAmount: Number.MAX_VALUE },
  ])("refuses finite operands whose money products/sum overflow: %j", (overrides) => {
    const value = allocation(overrides);
    const before = structuredClone(value);
    const counter = { value: 7 };
    expect(preflightMarketSettlement(value, 1, 8)).toMatch(/must be finite/);
    expect(() => executeMarketSettlement(value, 1, 8, counter)).toThrow(/must be finite/);
    expect(counter.value).toBe(7);
    expect(value).toEqual(before);
  });

  it.each([null, undefined, "", "  "])("refuses nonzero tax with absent/malformed treasury %j", (destination) => {
    const value = allocation({ destinationStateId: destination as StateId | null });
    const counter = { value: 7 };
    expect(preflightMarketSettlement(value, 1, 8)).toMatch(/no destinationStateId/);
    expect(() => executeMarketSettlement(value, 1, 8, counter)).toThrow(/no destinationStateId/);
    expect(() => createConsumptionTaxTransaction(value, saleId, bundleId, 1, 8, counter))
      .toThrow(/no destinationStateId/);
    expect(counter.value).toBe(7);
  });

  it("does not discard a positive sub-epsilon orphan tax", () => {
    const value = allocation({
      quantity: 1, sellerNetUnitPrice: 1, buyerGrossUnitPrice: 1,
      consumptionTaxAmount: Number.MIN_VALUE, destinationStateId: null,
    });
    expect(preflightMarketSettlement(value, 1, 8)).toMatch(/no destinationStateId/);
  });

  it("rejects positive quantity/price whose product underflows to zero", () => {
    const value = allocation({
      quantity: Number.MIN_VALUE, sellerNetUnitPrice: 0.5, buyerGrossUnitPrice: 0.5,
      consumptionTaxAmount: 0, destinationStateId: null,
    });
    const counter = { value: 4 };
    expect(preflightMarketSettlement(value, 1, 8)).toMatch(/underflow/);
    expect(() => executeMarketSettlement(value, 1, 8, counter)).toThrow(/underflow/);
    expect(() => createMarketSaleTransaction(value, bundleId, 1, 8, counter)).toThrow(/underflow/);
    expect(counter.value).toBe(4);
  });

  it.each([
    { quantity: 10, sellerNetUnitPrice: 0, buyerGrossUnitPrice: 0 },
    { quantity: 0, sellerNetUnitPrice: Number.MAX_VALUE, buyerGrossUnitPrice: Number.MAX_VALUE },
    { quantity: Number.MIN_VALUE, sellerNetUnitPrice: 1, buyerGrossUnitPrice: 1 },
  ])("retains explicit free, zero-quantity and representable subnormal controls: %j", (terms) => {
    const value = allocation({ ...terms, consumptionTaxAmount: 0, destinationStateId: null });
    const counter = { value: 0 };
    expect(preflightMarketSettlement(value, 1, 8)).toBeNull();
    const result = executeMarketSettlement(value, 1, 8, counter);
    expect(result.marketSaleTransaction.quantity).toBe(value.quantity);
    expect(result.marketSaleTransaction.moneyAmount).toBe(value.quantity * value.sellerNetUnitPrice);
    expect(result.consumptionTaxTransaction).toBeNull();
    expect(counter.value).toBe(1);
  });

  it.each([-1, NaN, Infinity, -Infinity])("direct tax helper rejects invalid amount %s without consuming an ID", (tax) => {
    const counter = { value: 7 };
    expect(() => createConsumptionTaxTransaction(allocation({ consumptionTaxAmount: tax }), saleId, bundleId, 1, 8, counter)).toThrow();
    expect(counter.value).toBe(7);
  });

  it("negative taxable value cannot create negative assessed/collected tax", () => {
    expect(() => computeConsumptionTax("s:treasury" as StateId, "good:food", -1, {
      getConsumptionTaxRate: () => 0.1, getCollectionEfficiency: () => 1,
    })).toThrow(/sellerNetValue must be >= 0/);
  });
});

describe("transaction ordinal reservations are safe and failure-atomic", () => {
  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])
    ("refuses invalid next ordinal %s on both bundle and direct helper APIs", (initial) => {
      const counter = { value: initial };
      expect(() => executeMarketSettlement(allocation(), 1, 8, counter)).toThrow(/counter/);
      expect(Object.is(counter.value, initial)).toBe(true);
      expect(() => createMarketSaleTransaction(allocation(), bundleId, 1, 8, counter)).toThrow(/counter/);
      expect(() => createConsumptionTaxTransaction(allocation(), saleId, bundleId, 1, 8, counter)).toThrow(/counter/);
      expect(Object.is(counter.value, initial)).toBe(true);
    });

  it("reserves both taxed-bundle IDs before constructing the sale", () => {
    const counter = { value: Number.MAX_SAFE_INTEGER - 1 };
    expect(() => executeMarketSettlement(allocation(), 1, 8, counter)).toThrow(/counter/);
    expect(counter.value).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it("allows the last representable complete taxed bundle", () => {
    const counter = { value: Number.MAX_SAFE_INTEGER - 2 };
    const result = executeMarketSettlement(allocation(), 1, 8, counter);
    expect(result.marketSaleTransaction.transactionId).toBe(`tx:1:8:market-sale:${Number.MAX_SAFE_INTEGER - 2}`);
    expect(result.consumptionTaxTransaction!.transactionId).toBe(`tx:1:8:consumption-tax:${Number.MAX_SAFE_INTEGER - 1}`);
    expect(counter.value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("untaxed settlement reserves exactly one ID at the frontier", () => {
    const counter = { value: Number.MAX_SAFE_INTEGER - 1 };
    const value = allocation({ buyerGrossUnitPrice: 2, consumptionTaxAmount: 0, destinationStateId: null });
    expect(executeMarketSettlement(value, 1, 8, counter).consumptionTaxTransaction).toBeNull();
    expect(counter.value).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => executeMarketSettlement(value, 1, 8, counter)).toThrow(/counter/);
    expect(counter.value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    [-1, 8], [0.5, 8], [NaN, 8], [Infinity, 8], [Number.MAX_SAFE_INTEGER + 1, 8],
    [1, -1], [1, 0.5], [1, 16], [1, NaN], [1, Infinity],
  ])("rejects invalid tick/phase (%s, %s) without consuming IDs", (tick, phase) => {
    const counter = { value: 7 };
    expect(preflightMarketSettlement(allocation(), tick, phase)).toMatch(/tick and phase/);
    expect(() => executeMarketSettlement(allocation(), tick, phase, counter)).toThrow(/tick and phase/);
    expect(() => createMarketSaleTransaction(allocation(), bundleId, tick, phase, counter)).toThrow(/tick and phase/);
    expect(counter.value).toBe(7);
  });

  it("a failed allocation does not renumber the next valid settlement", () => {
    const counter = { value: 9 };
    expect(() => executeMarketSettlement(allocation({ destinationStateId: null }), 1, 8, counter)).toThrow();
    const actual = executeMarketSettlement(allocation(), 1, 8, counter);
    const control = executeMarketSettlement(allocation(), 1, 8, { value: 9 });
    expect(actual).toEqual(control);
    expect(counter.value).toBe(11);
  });
});

describe("bundle identity follows the allocation, never the mutable transaction counter", () => {
  it("split lots for the same two intents have distinct paired audit bundles", () => {
    const counter = { value: 0 };
    const first = executeMarketSettlement(allocation({ id: createMarketAllocationId("ma:lot-0") }), 1, 8, counter);
    const second = executeMarketSettlement(allocation({ id: createMarketAllocationId("ma:lot-1") }), 1, 8, counter);
    expect(first.bundleId).not.toBe(second.bundleId);
    expect(new Set([first.marketSaleTransaction.transactionId, first.consumptionTaxTransaction!.transactionId,
      second.marketSaleTransaction.transactionId, second.consumptionTaxTransaction!.transactionId]).size).toBe(4);
    for (const result of [first, second]) {
      expect(result.marketSaleTransaction.bundleId).toBe(result.bundleId);
      expect(result.consumptionTaxTransaction!.bundleId).toBe(result.bundleId);
      expect(result.consumptionTaxTransaction!.originatingTransactionId).toBe(result.marketSaleTransaction.transactionId);
      expect(result.marketSaleTransaction.moneyAmount! + result.consumptionTaxTransaction!.moneyAmount!)
        .toBe(allocation().quantity * allocation().buyerGrossUnitPrice);
    }
  });

  it("colon-containing intent IDs cannot alias distinct semantic tuples", () => {
    const left = allocation({
      sellerIntentId: createMarketIntentId("mi:seller"), buyerIntentId: createMarketIntentId("mi:tail:mi:buyer"),
    });
    const right = allocation({
      sellerIntentId: createMarketIntentId("mi:seller:mi:tail"), buyerIntentId: createMarketIntentId("mi:buyer"),
    });
    expect(`${left.sellerIntentId}:${left.buyerIntentId}`).toBe(`${right.sellerIntentId}:${right.buyerIntentId}`);
    expect(executeMarketSettlement(left, 1, 8, { value: 0 }).bundleId)
      .not.toBe(executeMarketSettlement(right, 1, 8, { value: 0 }).bundleId);
  });

  it("is stable across counter offsets and distinguishes pass/currency context", () => {
    const value = allocation();
    const expected = executeMarketSettlement(value, 1, 8, { value: 0 }).bundleId;
    expect(executeMarketSettlement(value, 1, 8, { value: 100 }).bundleId).toBe(expected);
    expect(executeMarketSettlement(allocation({ pass: "PRE_PRODUCTION" }), 1, 8, { value: 0 }).bundleId).not.toBe(expected);
    expect(executeMarketSettlement(allocation({ marketCurrencyId: "cur:other" as CurrencyId }), 1, 8, { value: 0 }).bundleId).not.toBe(expected);
  });
});
