import { describe, expect, it } from "vitest";
import { actorRefKey } from "../domain/genesisLedger";
import type { CohortId, CurrencyId, GoodId, ProductionUnitId, StateId, ClanId } from "../domain/id";
import {
  EXACT_ZERO, exactAdd, exactCompare, exactFromNumber, exactSubtract,
  projectExactToNumber, type ExactStockAmount,
} from "../domain/exactStockAmount";
import {
  stageExactPostingBundle, type ExactPostingEndpoint, type ExactPostingLeg,
} from "./exactPostingBundle";

const USD = "cur:1" as CurrencyId;
const EUR = "cur:2" as CurrencyId;
const FOOD = "good:1" as GoodId;
const BUYER: ExactPostingEndpoint = {
  kind: "MONEY", owner: { type: "COHORT", cohortId: "pc:1" as CohortId },
  bucket: "WALLET", currencyId: USD,
};
const SELLER: ExactPostingEndpoint = {
  kind: "MONEY", owner: { type: "PRODUCTION_UNIT", productionUnitId: "pu:1" as ProductionUnitId },
  bucket: "WALLET", currencyId: USD,
};
const TAX: ExactPostingEndpoint = {
  kind: "MONEY", owner: { type: "STATE", stateId: "s:1" as StateId },
  bucket: "TREASURY", currencyId: USD,
};
const SELLER_GOODS: ExactPostingEndpoint = {
  kind: "GOOD", owner: { type: "PRODUCTION_UNIT", productionUnitId: "pu:1" as ProductionUnitId },
  bucket: "OUTPUT", goodId: FOOD,
};
const BUYER_GOODS: ExactPostingEndpoint = {
  kind: "GOOD", owner: { type: "COHORT", cohortId: "pc:1" as CohortId },
  bucket: "GENERAL", goodId: FOOD,
};

function key(endpoint: ExactPostingEndpoint): string {
  return JSON.stringify([
    endpoint.kind, actorRefKey(endpoint.owner), endpoint.bucket,
    endpoint.kind === "MONEY" ? endpoint.currencyId : endpoint.goodId,
  ]);
}

function leg(legId: string, endpoint: ExactPostingEndpoint, delta: ExactStockAmount): ExactPostingLeg {
  return { legId, endpoint, delta };
}

function opening(values: readonly [ExactPostingEndpoint, ExactStockAmount][]) {
  const initial = new Map(values.map(([endpoint, amount]) => [key(endpoint), amount]));
  let reads = 0;
  return {
    initial,
    get reads() { return reads; },
    read(endpoint: ExactPostingEndpoint): ExactStockAmount {
      reads++;
      const value = initial.get(key(endpoint));
      if (!value) throw new Error("unresolved canonical endpoint");
      return value;
    },
  };
}

describe("exact posting staging (#798): no WorldState/v2 activation", () => {
  it("balances gross/tax/net and goods by one exact amount, without rounding 0.3 - 0.1 to 0.2", () => {
    const gross = exactFromNumber(0.3);
    const tax = exactFromNumber(0.1);
    const sellerNet = exactSubtract(gross, tax);
    const quantity = exactFromNumber(0.5);
    const stocks = opening([
      [BUYER, exactFromNumber(10)], [SELLER, EXACT_ZERO], [TAX, EXACT_ZERO],
      [SELLER_GOODS, exactFromNumber(8)], [BUYER_GOODS, EXACT_ZERO],
    ]);
    const staged = stageExactPostingBundle([
      leg("buyer-debit", BUYER, exactSubtract(EXACT_ZERO, gross)),
      leg("seller-net", SELLER, sellerNet),
      leg("tax-receipt", TAX, tax),
      leg("goods-debit", SELLER_GOODS, exactSubtract(EXACT_ZERO, quantity)),
      leg("goods-credit", BUYER_GOODS, quantity),
    ], stocks.read);
    const at = (endpoint: ExactPostingEndpoint) => staged.find(row => key(row.endpoint) === key(endpoint))!;
    expect(at(BUYER).closing).toEqual(exactSubtract(exactFromNumber(10), gross));
    expect(at(SELLER).closing).toEqual(sellerNet);
    expect(at(TAX).closing).toEqual(tax);
    expect(at(SELLER_GOODS).closing).toEqual(exactFromNumber(7.5));
    expect(at(BUYER_GOODS).closing).toEqual(quantity);
    expect(exactAdd(sellerNet, tax)).toEqual(gross);
    expect(exactCompare(sellerNet, exactFromNumber(0.2))).not.toBe(0);
    expect(stocks.reads).toBe(5);
    expect(stocks.initial.get(key(BUYER))).toEqual(exactFromNumber(10));
    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.isFrozen(at(BUYER).legs)).toBe(true);
  });

  it("retains exact micro-transfers through 1000 closed bundles", () => {
    const starting = exactFromNumber(1e7);
    const amount = exactFromNumber(1e-9);
    const balances = new Map<string, ExactStockAmount>([
      [key(BUYER), starting], [key(SELLER), EXACT_ZERO],
    ]);
    for (let index = 0; index < 1000; index++) {
      const staged = stageExactPostingBundle([
        leg("debit", BUYER, exactSubtract(EXACT_ZERO, amount)),
        leg("credit", SELLER, amount),
      ], endpoint => balances.get(key(endpoint))!);
      for (const row of staged) balances.set(key(row.endpoint), row.closing);
    }
    const buyer = balances.get(key(BUYER))!;
    const seller = balances.get(key(SELLER))!;
    expect(exactAdd(buyer, seller)).toEqual(starting);
    expect(exactCompare(buyer, starting)).toBe(-1);
  });

  it("handles 2^-14 at 1e12 and the 1e15 tax fraction even when projection absorbs it", () => {
    const initial = exactFromNumber(1e15);
    const tax = exactFromNumber(0.0625);
    const net = exactSubtract(initial, tax);
    const stocks = opening([[BUYER, initial], [SELLER, EXACT_ZERO], [TAX, EXACT_ZERO]]);
    const rows = stageExactPostingBundle([
      leg("buyer", BUYER, exactSubtract(EXACT_ZERO, initial)),
      leg("seller", SELLER, net),
      leg("tax", TAX, tax),
    ], stocks.read);
    expect(rows.find(r => key(r.endpoint) === key(SELLER))!.closing).toEqual(net);
    expect(projectExactToNumber(net)).toBe(1e15);
    const tiny = exactFromNumber(2 ** -14);
    const staged = stageExactPostingBundle([
      leg("pay", BUYER, exactSubtract(EXACT_ZERO, tiny)),
      leg("receive", SELLER, tiny),
    ], endpoint => endpoint.kind === "MONEY" && key(endpoint) === key(BUYER)
      ? exactFromNumber(1e12) : EXACT_ZERO);
    expect(staged.find(r => key(r.endpoint) === key(BUYER))!.closing)
      .toEqual(exactSubtract(exactFromNumber(1e12), tiny));
  });

  it("nets alias debit-before-credit using final stock without transient overdraft", () => {
    const stocks = opening([[BUYER, EXACT_ZERO]]);
    const staged = stageExactPostingBundle([
      leg("debit-first", BUYER, exactFromNumber(-1)),
      leg("credit-second", BUYER, exactFromNumber(1)),
    ], stocks.read);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.opening).toEqual(EXACT_ZERO);
    expect(staged[0]!.closing).toEqual(EXACT_ZERO);
    expect(staged[0]!.legs.map(x => x.legId)).toEqual(["debit-first", "credit-second"]);
    expect(stocks.reads).toBe(1);
  });

  it("rejects missing/duplicate receipts, crossed currencies and wrong ownership", () => {
    const stocks = opening([[BUYER, exactFromNumber(5)], [SELLER, EXACT_ZERO]]);
    const debit = leg("debit", BUYER, exactFromNumber(-1));
    const credit = leg("credit", SELLER, exactFromNumber(1));
    expect(() => stageExactPostingBundle([debit], stocks.read)).toThrow(/unbalanced/);
    expect(() => stageExactPostingBundle([debit, debit], stocks.read)).toThrow(/duplicate leg ID/);
    expect(() => stageExactPostingBundle([leg("", BUYER, exactFromNumber(-1)), credit], stocks.read))
      .toThrow(/leg ID/);
    expect(() => stageExactPostingBundle([debit, leg("credit", { ...SELLER, currencyId: EUR } as ExactPostingEndpoint,
      exactFromNumber(1))], () => EXACT_ZERO)).toThrow(/unbalanced|negative/);
    const clanGoods: ExactPostingEndpoint = {
      kind: "GOOD", owner: { type: "CLAN", clanId: "c:1" as ClanId },
      bucket: "GENERAL", goodId: FOOD,
    };
    expect(() => stageExactPostingBundle([
      leg("a", clanGoods, exactFromNumber(1)), leg("b", BUYER_GOODS, exactFromNumber(-1)),
    ], () => exactFromNumber(10))).toThrow(/authorized goods bucket/);
    expect(() => stageExactPostingBundle([debit, credit], () => {
      throw new Error("unresolved canonical endpoint");
    })).toThrow(/unresolved canonical endpoint/);
    expect(stocks.initial.get(key(BUYER))).toEqual(exactFromNumber(5));
  });

  it("refuses overdrafts and final overflows; preserves caller's map", () => {
    const zero = opening([[BUYER, EXACT_ZERO], [SELLER, EXACT_ZERO]]);
    expect(() => stageExactPostingBundle([
      leg("debit", BUYER, exactFromNumber(-1)),
      leg("credit", SELLER, exactFromNumber(1)),
    ], zero.read)).toThrow(/negative/);
    const huge = opening([
      [BUYER, exactFromNumber(1)], [SELLER, exactFromNumber(Number.MAX_VALUE)],
    ]);
    expect(() => stageExactPostingBundle([
      leg("debit", BUYER, exactFromNumber(-1)),
      leg("credit", SELLER, exactFromNumber(1)),
    ], huge.read)).toThrow(/range/);
    expect(huge.initial.get(key(SELLER))).toEqual(exactFromNumber(Number.MAX_VALUE));
  });

  it("produces stable endpoint order irrespective of caller leg and Map insertion order", () => {
    const stocks = opening([[BUYER, exactFromNumber(2)], [SELLER, EXACT_ZERO]]);
    const a = leg("buyer", BUYER, exactFromNumber(-1));
    const b = leg("seller", SELLER, exactFromNumber(1));
    const first = stageExactPostingBundle([a, b], stocks.read);
    const second = stageExactPostingBundle([b, a], stocks.read);
    expect(first.map(x => [key(x.endpoint), x.opening, x.closing]))
      .toEqual(second.map(x => [key(x.endpoint), x.opening, x.closing]));
  });
});
