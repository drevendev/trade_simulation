import { describe, expect, it } from "vitest";

import {
  EXACT_ZERO,
  assertFiniteExactMagnitude,
  assertPhysicalExactStock,
  decodeExactStockAmount,
  encodeExactStockAmount,
  exactAdd,
  exactCompare,
  exactFromNumber,
  exactNegate,
  exactSubtract,
  projectExactToNumber,
} from "./exactStockAmount";

describe("ExactStockAmount v2 pure codec (#797/#798)", () => {
  it("decodes actual binary64 bits including ordinary fractions, negative zero and subnormal values", () => {
    expect(encodeExactStockAmount(exactFromNumber(0.1))).toEqual({
      coefficient: "3602879701896397", exponent: -55,
    });
    expect(exactFromNumber(-0)).toBe(EXACT_ZERO);
    expect(encodeExactStockAmount(exactFromNumber(Number.MIN_VALUE))).toEqual({
      coefficient: "1", exponent: -1074,
    });
    expect(encodeExactStockAmount(exactFromNumber(-Number.MIN_VALUE))).toEqual({
      coefficient: "-1", exponent: -1074,
    });
    for (const invalid of [Number.NaN, Infinity, -Infinity, "1", null]) {
      expect(() => exactFromNumber(invalid as number)).toThrow(/finite number/);
    }
  });

  it("performs exact signed add/subtract/compare with no Number-roundtrip", () => {
    const a = exactFromNumber(0.1);
    const b = exactFromNumber(0.2);
    const sum = exactAdd(a, b);
    expect(exactCompare(sum, exactFromNumber(0.3))).not.toBe(0);
    expect(exactSubtract(sum, b)).toEqual(a);
    expect(exactAdd(a, exactNegate(a))).toBe(EXACT_ZERO);
    expect(exactCompare(a, b)).toBe(-1);
    expect(exactCompare(exactNegate(a), exactNegate(b))).toBe(1);
  });

  it("has zero conservation residual for 1000 micro-transfers from a large wallet", () => {
    const initial = exactFromNumber(1e7);
    const transfer = exactFromNumber(1e-9);
    let buyer = initial;
    let seller = EXACT_ZERO;
    let legacyBuyer = 1e7;
    let legacySeller = 0;
    for (let index = 0; index < 1000; index++) {
      buyer = exactSubtract(buyer, transfer);
      seller = exactAdd(seller, transfer);
      legacyBuyer -= 1e-9;
      legacySeller += 1e-9;
    }
    expect(exactAdd(buyer, seller)).toEqual(initial);
    expect(exactCompare(buyer, initial)).toBe(-1);
    expect(exactCompare(seller, EXACT_ZERO)).toBe(1);
    expect(Math.abs(legacyBuyer + legacySeller - 1e7)).toBeGreaterThan(1e-8);
  });

  it("does not absorb 2^-14 at 1e12 or collect tax into a different currency amount", () => {
    const initial = exactFromNumber(1e12);
    const small = exactFromNumber(2 ** -14);
    expect(exactAdd(exactSubtract(initial, small), small)).toEqual(initial);
    const gross = exactFromNumber(1e15);
    const tax = exactFromNumber(0.0625);
    const net = exactSubtract(gross, tax);
    expect(exactAdd(net, tax)).toEqual(gross);
    expect(exactCompare(net, gross)).toBe(-1);
  });

  it("uses rounded projections only for read models, including nearest ties-to-even", () => {
    const two53 = exactFromNumber(2 ** 53);
    expect(projectExactToNumber(exactAdd(two53, exactFromNumber(1)))).toBe(2 ** 53);
    expect(projectExactToNumber(exactAdd(two53, exactFromNumber(3)))).toBe(2 ** 53 + 4);
    for (const sample of [0, 0.1, 1e7, 1e12, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      expect(Object.is(projectExactToNumber(exactFromNumber(sample)), sample)).toBe(true);
    }
  });

  it("rejects negative physical stocks and exact overflows, with no epsilon clamping", () => {
    expect(() => assertPhysicalExactStock(exactFromNumber(-Number.MIN_VALUE))).toThrow(/negative/);
    expect(() => assertFiniteExactMagnitude(exactAdd(exactFromNumber(Number.MAX_VALUE), exactFromNumber(1)))).toThrow(/range/);
    expect(() => assertFiniteExactMagnitude(exactAdd(exactFromNumber(Number.MAX_VALUE), exactFromNumber(Number.MAX_VALUE)))).toThrow(/range/);
    expect(() => assertPhysicalExactStock(exactFromNumber(Number.MIN_VALUE))).not.toThrow();
    expect(() => exactAdd({ coefficient: 1n, exponent: Number.MAX_SAFE_INTEGER }, EXACT_ZERO)).toThrow(/normalized/);
    expect(() => exactAdd({ coefficient: 1n << 5000n, exponent: 0 }, EXACT_ZERO)).toThrow(/normalized/);
  });

  it("has a strict deterministic wire form and round-trips every finite binary64 sample exactly", () => {
    for (const value of [Number.MIN_VALUE, 0, -0, 0.1, -0.2, 1e-308, 1e12, 1e15, Number.MAX_VALUE]) {
      const exact = exactFromNumber(value);
      expect(decodeExactStockAmount(encodeExactStockAmount(exact))).toEqual(exact);
    }
    expect(encodeExactStockAmount(EXACT_ZERO)).toEqual({ coefficient: "0", exponent: 0 });
  });

  it("rejects malformed, unnormalized, unsafe, noncanonical and oversized wire data", () => {
    for (const candidate of [
      null, [], { coefficient: 0, exponent: 0 }, { coefficient: "01", exponent: 0 },
      { coefficient: "-0", exponent: 0 }, { coefficient: "+1", exponent: 0 },
      { coefficient: "0", exponent: 1 }, { coefficient: "2", exponent: -2 },
      { coefficient: "1", exponent: -1075 }, { coefficient: "1", exponent: 1024 },
      { coefficient: "1", exponent: 0, unexpected: "field" },
      { coefficient: "1".repeat(641), exponent: -1074 },
      { coefficient: "1", exponent: Number.MAX_VALUE },
    ]) {
      expect(() => decodeExactStockAmount(candidate)).toThrow();
    }
  });
});
