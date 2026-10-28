import { describe, expect, it } from "vitest";
import type { CurrencyId } from "../domain/id";
import {
  fxPayerCurrencyKey,
  quoteFxForPool,
  reserveFxForPool,
  type FxQuotePoolSnapshot,
  type FxReservationRequest,
} from "./fxQuoteReservation";

const BASE = "cur:base" as CurrencyId;
const QUOTE = "cur:quote" as CurrencyId;
const THIRD = "cur:other" as CurrencyId;

function pool(overrides: Partial<FxQuotePoolSnapshot> = {}): FxQuotePoolSnapshot {
  return {
    pairId: "fx:base-quote",
    baseCurrencyId: BASE,
    quoteCurrencyId: QUOTE,
    cash: new Map([[BASE, 50], [QUOTE, 100]]),
    spotRateQuotePerBase: 2,
    transactionSpread: 0.1,
    minOperationalReserveBase: 10,
    minOperationalReserveQuote: 20,
    ...overrides,
  };
}

function request(
  requestId: string,
  payerKey: string,
  desiredOutputAmount: number,
  priority = 1,
  fromCurrencyId = BASE,
  toCurrencyId = QUOTE,
): FxReservationRequest {
  return {
    requestId,
    payerKey,
    priority,
    fromCurrencyId,
    toCurrencyId,
    desiredOutputAmount,
    maxInputAmount: 100,
  };
}

describe("M5 finite FX pool quote and reservations — Issue #671", () => {
  it("uses the explicit base/quote direction and spread in both formulas", () => {
    const bToQ = quoteFxForPool(pool(), BASE, QUOTE, 18);
    expect(bToQ.direction).toBe("BASE_TO_QUOTE");
    expect(bToQ.spotRate).toBe(2);
    expect(bToQ.spread).toBe(0.1);
    expect(bToQ.requiredInputAmountAtDesiredOutput).toBeCloseTo(10, 12);
    expect(bToQ.feasibleOutputAmount).toBe(18);
    expect(bToQ.requiredInputForFeasibleOutput).toBeCloseTo(10, 12);
    expect(bToQ.maxOutputByPoolReserve).toBe(80);
    expect(bToQ.reserveLimited).toBe(false);

    const qToB = quoteFxForPool(pool(), QUOTE, BASE, 10);
    expect(qToB.direction).toBe("QUOTE_TO_BASE");
    expect(qToB.requiredInputAmountAtDesiredOutput).toBeCloseTo(22, 12);
    expect(qToB.requiredInputForFeasibleOutput).toBeCloseTo(22, 12);
    expect(qToB.maxOutputByPoolReserve).toBe(40);
  });

  it("honors caller input cap and current prior output reservations without moving stocks", () => {
    const source = pool();
    const originalBase = source.cash.get(BASE);
    const originalQuote = source.cash.get(QUOTE);
    const quote = quoteFxForPool(source, BASE, QUOTE, 60, {
      maxInputAmount: 5,
      reservedOutputAmount: 70,
    });
    expect(quote.maxOutputByPoolReserve).toBe(10);
    expect(quote.maxOutputByProvidedInput).toBeCloseTo(9, 12);
    expect(quote.feasibleOutputAmount).toBeCloseTo(9, 12);
    expect(quote.requiredInputForFeasibleOutput).toBeLessThanOrEqual(5);
    expect(quote.reserveLimited).toBe(true);
    expect(source.cash.get(BASE)).toBe(originalBase);
    expect(source.cash.get(QUOTE)).toBe(originalQuote);
    expect(source.spotRateQuotePerBase).toBe(2);
  });

  it("prevents draining either operational floor and permits legitimate zero fills", () => {
    const thin = pool({ cash: new Map([[BASE, 10], [QUOTE, 20]]) });
    expect(quoteFxForPool(thin, BASE, QUOTE, 5).feasibleOutputAmount).toBe(0);
    expect(quoteFxForPool(thin, QUOTE, BASE, 5).feasibleOutputAmount).toBe(0);
    expect(quoteFxForPool(pool(), BASE, QUOTE, 4, { maxInputAmount: 0 })
      .feasibleOutputAmount).toBe(0);
    expect(quoteFxForPool(pool(), BASE, QUOTE, 0).requiredInputForFeasibleOutput).toBe(0);
  });

  it("protects a sub-ulp operational floor in both quote sizing and actual reservation promises", () => {
    const big = 1e16;
    const near = big - 2; // adjacent representable binary64 value below 1e16
    const source = pool({
      cash: new Map([[BASE, big], [QUOTE, big]]),
      spotRateQuotePerBase: 1,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 1,
    });
    // Previously stock - floor rounded UP to the full stock and promised
    // 1e16, leaving zero QUOTE despite an operational reserve floor of 1.
    expect(big - 1).toBe(big); // load-bearing numeric witness
    const quote = quoteFxForPool(source, BASE, QUOTE, big, { maxInputAmount: big });
    expect(quote.maxOutputByPoolReserve).toBe(near);
    expect(quote.feasibleOutputAmount).toBe(near);
    expect(big - quote.feasibleOutputAmount).toBe(2);
    expect(quote.reserveLimited).toBe(true);

    const buyerKey = fxPayerCurrencyKey("buyer", BASE);
    const budgets = new Map([[buyerKey, big]]);
    const plan = reserveFxForPool(
      source,
      [{ ...request("full-stock", "buyer", big), maxInputAmount: big }],
      budgets, 7,
    );
    expect(plan.reservedOutputByCurrency.get(QUOTE)).toBe(near);
    expect(plan.reservedInputByPayerCurrency.get(buyerKey)).toBe(near);
    expect(big - plan.reservedOutputByCurrency.get(QUOTE)!).toBeGreaterThanOrEqual(1);
    expect(source.cash.get(QUOTE)).toBe(big);
    expect(budgets.get(buyerKey)).toBe(big);

    // A neighboring representable fill remains valid; only the amount
    // that would consume the protected floor is excluded.
    expect(quoteFxForPool(source, BASE, QUOTE, near, { maxInputAmount: big })
      .feasibleOutputAmount).toBe(near);
  });

  it("refuses a previously reserved full-stock promise when a tiny floor cannot survive", () => {
    const big = 1e16;
    const source = pool({
      cash: new Map([[BASE, big], [QUOTE, big]]),
      spotRateQuotePerBase: 1,
      transactionSpread: 0,
      minOperationalReserveBase: 1,
      minOperationalReserveQuote: 1,
    });
    expect(() => quoteFxForPool(source, BASE, QUOTE, 2, {
      reservedOutputAmount: big,
      maxInputAmount: big,
    })).toThrow(/prior FX reservations exceed/);
    expect(() => quoteFxForPool(source, QUOTE, BASE, 2, {
      reservedOutputAmount: big,
      maxInputAmount: big,
    })).toThrow(/prior FX reservations exceed/);
    // The reverse exchange respects the BASE floor as well.
    expect(quoteFxForPool(source, QUOTE, BASE, big, { maxInputAmount: big })
      .feasibleOutputAmount).toBe(big - 2);
  });

  it("rejects positive output whose required input underflows to zero in quote and planner", () => {
    const tiny = pool({
      cash: new Map([[BASE, 50], [QUOTE, 2e-200]]),
      spotRateQuotePerBase: 1e200,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
    });
    const budgetKey = fxPayerCurrencyKey("buyer", BASE);
    const budgets = new Map([[budgetKey, 1]]);
    expect(() => quoteFxForPool(tiny, BASE, QUOTE, 1e-200, { maxInputAmount: 1 }))
      .toThrow(/positive output.*zero input/);
    expect(() => reserveFxForPool(
      tiny, [{ ...request("underflow", "buyer", 1e-200), maxInputAmount: 1 }], budgets, 7,
    )).toThrow(/positive output.*zero input/);
    expect(tiny.cash.get(QUOTE)).toBe(2e-200);
    expect(budgets.get(budgetKey)).toBe(1);
  });

  it("still permits tiny FX fills when the positive input cost is representable", () => {
    const tiny = pool({
      cash: new Map([[BASE, 50], [QUOTE, 2e-150]]),
      spotRateQuotePerBase: 1e150,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
    });
    const q = quoteFxForPool(tiny, BASE, QUOTE, 1e-150, { maxInputAmount: 1 });
    expect(q.feasibleOutputAmount).toBe(1e-150);
    expect(q.requiredInputForFeasibleOutput).toBeGreaterThan(0);
    expect(q.requiredInputForFeasibleOutput / 1e-300).toBeCloseTo(1, 12);
    const key = fxPayerCurrencyKey("buyer", BASE);
    const plan = reserveFxForPool(
      tiny, [{ ...request("tiny", "buyer", 1e-150), maxInputAmount: 1 }],
      new Map([[key, 1]]), 7,
    );
    expect(plan.reservedOutputByCurrency.get(QUOTE)).toBe(1e-150);
    expect(plan.reservedInputByPayerCurrency.get(key)).toBeGreaterThan(0);
  });

  it("fails closed on malformed pair, extra currency, reserve and quote evidence", () => {
    expect(() => quoteFxForPool(pool(), BASE, THIRD, 1)).toThrow(/pair\/direction/);
    expect(() => quoteFxForPool(pool({ baseCurrencyId: QUOTE }), BASE, QUOTE, 1))
      .toThrow(/distinct|exactly/);
    expect(() => quoteFxForPool(pool({ cash: new Map([[BASE, 50]]) }), BASE, QUOTE, 1))
      .toThrow(/exactly/);
    expect(() => quoteFxForPool(pool({ cash: new Map([[BASE, 50], [QUOTE, 5]]) }), BASE, QUOTE, 1))
      .toThrow(/floor/);
    expect(() => quoteFxForPool(pool({ transactionSpread: 1 }), BASE, QUOTE, 1))
      .toThrow(/less than one/);
    expect(() => quoteFxForPool(pool({ spotRateQuotePerBase: 0 }), BASE, QUOTE, 1))
      .toThrow(/positive/);
    expect(() => quoteFxForPool(pool(), BASE, QUOTE, Number.NaN))
      .toThrow(/finite/);
    expect(() => quoteFxForPool(pool(), BASE, QUOTE, 1, { reservedOutputAmount: 81 }))
      .toThrow(/exceed/);
  });

  it("assigns a single finite output reserve to competing requests, independent of insertion order", () => {
    const inputs = new Map([
      [fxPayerCurrencyKey("buyer-a", BASE), 100],
      [fxPayerCurrencyKey("buyer-b", BASE), 100],
    ]);
    const first = request("first", "buyer-a", 60, 5);
    const second = request("second", "buyer-b", 60, 2);
    const source = pool();
    const a = reserveFxForPool(source, [second, first], inputs, 7);
    const b = reserveFxForPool(source, [first, second], inputs, 7);
    expect(a).toEqual(b);
    expect(a.reservations.map((x) => [x.requestId, x.quote.feasibleOutputAmount]))
      .toEqual([["first", 60], ["second", 20]]);
    expect(a.reservedOutputByCurrency.get(QUOTE)).toBe(80);
    expect(a.reservedInputByPayerCurrency.get(fxPayerCurrencyKey("buyer-a", BASE)))
      .toBeCloseTo(60 / 1.8, 10);
    expect(source.cash.get(QUOTE)).toBe(100);
    expect(inputs.get(fxPayerCurrencyKey("buyer-a", BASE))).toBe(100);
    expect(a.pressure.desiredSupplyOfBase).toBeCloseTo(120 / 1.8, 10);
    expect(a.pressure.filledSupplyOfBase).toBeCloseTo(80 / 1.8, 10);
  });

  it("shares one payer's input cash across different requests, without overdraft", () => {
    const inputs = new Map([[fxPayerCurrencyKey("buyer", BASE), 30]]);
    const planned = reserveFxForPool(
      pool(), [request("b", "buyer", 40), request("a", "buyer", 40)], inputs, 7,
    );
    expect(planned.reservations.map((x) => x.requestId)).toEqual(["a", "b"]);
    const totalInput = planned.reservedInputByPayerCurrency.get(fxPayerCurrencyKey("buyer", BASE))!;
    const totalOutput = planned.reservedOutputByCurrency.get(QUOTE)!;
    expect(totalInput).toBeLessThanOrEqual(30);
    expect(totalOutput).toBeCloseTo(54, 10);
    expect(totalOutput).toBeLessThanOrEqual(80);
  });

  it("does not spend expected opposing-direction receipts within one phase", () => {
    const inputs = new Map([
      [fxPayerCurrencyKey("a", BASE), 100],
      [fxPayerCurrencyKey("b", QUOTE), 100],
    ]);
    const a = reserveFxForPool(pool(), [
      request("base-to-quote", "a", 80, 3),
      request("quote-to-base", "b", 100, 2, QUOTE, BASE),
    ], inputs, 7);
    expect(a.reservedOutputByCurrency.get(QUOTE)).toBe(80);
    expect(a.reservedOutputByCurrency.get(BASE)).toBe(40);
    expect(a.pressure.desiredDemandForBase).toBe(100);
    expect(a.pressure.filledDemandForBase).toBe(40);
  });

  it("fails closed when a shared payer/pool rounds a 3-unit quote up to 4", () => {
    const big = 1e16;
    const source = pool({
      cash: new Map([[BASE, 50], [QUOTE, big + 8]]),
      spotRateQuotePerBase: 1,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
    });
    const key = fxPayerCurrencyKey("buyer", BASE);
    const requests = [
      { ...request("large", "buyer", big, 2), maxInputAmount: big },
      { ...request("small", "buyer", 3, 1), maxInputAmount: 3 },
    ];
    // Both raw quotes fit. Yet binary64 records 1e16 + 3 as 1e16 + 4:
    // the aggregate would overstate both the payer debit and pool output by 1.
    expect(quoteFxForPool(source, BASE, QUOTE, 3).requiredInputForFeasibleOutput).toBe(3);
    expect(big + 3).toBe(big + 4);
    expect(() => reserveFxForPool(source, requests, new Map([[key, big + 4]]), 7))
      .toThrow(/reconcile.*precision/);
    expect(source.cash.get(QUOTE)).toBe(big + 8);
  });

  it("rejects small-before-large FX aggregate rounding hidden by subtractive drift", () => {
    const big = 1e16;
    const source = pool({
      cash: new Map([[BASE, 50], [QUOTE, big + 8]]),
      spotRateQuotePerBase: 1,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
    });
    const key = fxPayerCurrencyKey("buyer", BASE);
    const budgets = new Map([[key, big + 8]]);
    const small = { ...request("small", "buyer", 3, 2), maxInputAmount: 3 };
    const large = { ...request("large", "buyer", big, 1), maxInputAmount: big };
    // The old (next - previous) - quoted check falsely produced zero:
    // (3 + 1e16 - 3) - 1e16 === 0 although the rounded sum is 1e16+4.
    expect(3 + big).toBe(big + 4);
    expect(((3 + big) - 3) - big).toBe(0);
    expect(() => reserveFxForPool(source, [large, small], budgets, 7))
      .toThrow(/reconcile.*precision/);
    // A rejected pure plan must not touch the authoritative snapshots.
    expect(source.cash.get(QUOTE)).toBe(big + 8);
    expect(source.cash.get(BASE)).toBe(50);
    expect(budgets.get(key)).toBe(big + 8);
  });

  it("refuses pool-output overcount even when payer inputs belong to different actors", () => {
    const big = 1e16;
    const source = pool({
      cash: new Map([[BASE, 50], [QUOTE, big + 8]]),
      spotRateQuotePerBase: 1,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
    });
    expect(() => reserveFxForPool(source, [
      { ...request("large", "a", big, 2), maxInputAmount: big },
      { ...request("small", "b", 3, 1), maxInputAmount: 3 },
    ], new Map([
      [fxPayerCurrencyKey("a", BASE), big],
      [fxPayerCurrencyKey("b", BASE), 3],
    ]), 7)).toThrow(/pool output.*reconcile.*precision/);
  });

  it("refuses payer-input overcount when the pool-output increment is still precise", () => {
    const big = 1e16;
    const source = pool({
      cash: new Map([[BASE, 50], [QUOTE, 10000 + 1e-8]]),
      spotRateQuotePerBase: 1e-12,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
    });
    const large = { ...request("large", "buyer", 10000, 2), maxInputAmount: big };
    const small = { ...request("small", "buyer", 3e-12, 1), maxInputAmount: 3 };
    expect(quoteFxForPool(source, BASE, QUOTE, 3e-12).requiredInputForFeasibleOutput).toBe(3);
    expect(() => reserveFxForPool(source, [small, large], new Map([
      [fxPayerCurrencyKey("buyer", BASE), big + 4],
    ]), 7)).toThrow(/payer input.*reconcile.*precision/);
  });

  it("preserves exact, insertion-order-independent totals when large and small increments fit", () => {
    const big = 1e12;
    const source = pool({
      cash: new Map([[BASE, 50], [QUOTE, big + 8]]),
      spotRateQuotePerBase: 1,
      transactionSpread: 0,
      minOperationalReserveBase: 0,
      minOperationalReserveQuote: 0,
    });
    const key = fxPayerCurrencyKey("buyer", BASE);
    const budgets = new Map([[key, big + 4]]);
    const requests = [
      { ...request("large", "buyer", big, 2), maxInputAmount: big },
      { ...request("small", "buyer", 3, 1), maxInputAmount: 3 },
    ];
    const first = reserveFxForPool(source, requests, budgets, 7);
    expect(reserveFxForPool(source, [...requests].reverse(), budgets, 7)).toEqual(first);
    expect(first.reservations.map(({ quote }) => [
      quote.feasibleOutputAmount, quote.requiredInputForFeasibleOutput,
    ])).toEqual([[big, big], [3, 3]]);
    expect(first.reservedInputByPayerCurrency.get(key)).toBe(big + 3);
    expect(first.reservedOutputByCurrency.get(QUOTE)).toBe(big + 3);

    // Invert priorities as well as insertion order: small-before-large
    // must remain valid when the exact sum is representable.
    const smallFirstRequests = requests.map((r) => ({
      ...r,
      priority: r.priority === 2 ? 1 : 2,
    }));
    const smallFirst = reserveFxForPool(source, smallFirstRequests, budgets, 7);
    expect(smallFirst.reservations.map(({ quote }) => [
      quote.feasibleOutputAmount, quote.requiredInputForFeasibleOutput,
    ])).toEqual([[3, 3], [big, big]]);
    expect(smallFirst.reservedInputByPayerCurrency.get(key)).toBe(big + 3);
    expect(smallFirst.reservedOutputByCurrency.get(QUOTE)).toBe(big + 3);
    expect(smallFirst.pressure.filledSupplyOfBase).toBe(big + 3);
    expect(first.pressure.filledSupplyOfBase).toBe(big + 3);

    expect(budgets.get(key)).toBe(big + 4);
    expect(source.cash.get(QUOTE)).toBe(big + 8);
  });

  it("rejects invalid/duplicate requests before publishing any provisional reservation", () => {
    const inputs = new Map([[fxPayerCurrencyKey("buyer", BASE), 100]]);
    const good = request("same", "buyer", 3);
    expect(() => reserveFxForPool(pool(), [good, good], inputs, 7)).toThrow(/unique/);
    expect(() => reserveFxForPool(pool(), [good, request("other", "unfunded", 3)], inputs, 7))
      .toThrow(/missing FX payer/);
    expect(() => reserveFxForPool(pool(), [{ ...good, priority: Infinity }], inputs, 7))
      .toThrow(/priority/);
    expect(() => reserveFxForPool(pool(), [{ ...good, desiredOutputAmount: -1 }], inputs, 7))
      .toThrow(/positive/);
    expect(inputs.get(fxPayerCurrencyKey("buyer", BASE))).toBe(100);
  });
  it("binds each reservation to its producing tick and rejects invalid tick values", () => {
    const source = pool();
    const candidate = request("tick-bound", "buyer", 10);
    const budgets = new Map([[fxPayerCurrencyKey("buyer", BASE), 100]]);
    const tick7 = reserveFxForPool(source, [candidate], budgets, 7);
    const tick8 = reserveFxForPool(source, [candidate], budgets, 8);
    expect(tick7.reservations[0]!.tick).toBe(7);
    expect(tick8.reservations[0]!.tick).toBe(8);
    expect(tick8.reservations[0]!.quote).toEqual(tick7.reservations[0]!.quote);
    expect(() => reserveFxForPool(source, [candidate], budgets, -1)).toThrow(/tick/);
    expect(() => reserveFxForPool(source, [candidate], budgets, 7.5)).toThrow(/tick/);
    expect(() => reserveFxForPool(source, [candidate], budgets, Number.NaN)).toThrow(/tick/);
    expect(source.cash.get(QUOTE)).toBe(100);
  });

});
