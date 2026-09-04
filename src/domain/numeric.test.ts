import { describe, expect, it } from "vitest";

import { assertFiniteCanonicalNumber, isFiniteCanonicalNumber } from "./numeric";

describe("isFiniteCanonicalNumber", () => {
  it("accepts ordinary finite numbers, including zero and negative values", () => {
    expect(isFiniteCanonicalNumber(0)).toBe(true);
    expect(isFiniteCanonicalNumber(-0)).toBe(true);
    expect(isFiniteCanonicalNumber(42)).toBe(true);
    expect(isFiniteCanonicalNumber(-17.5)).toBe(true);
    expect(isFiniteCanonicalNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects NaN, +Infinity and -Infinity", () => {
    expect(isFiniteCanonicalNumber(Number.NaN)).toBe(false);
    expect(isFiniteCanonicalNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteCanonicalNumber(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("rejects non-number input", () => {
    expect(isFiniteCanonicalNumber("42")).toBe(false);
    expect(isFiniteCanonicalNumber(null)).toBe(false);
    expect(isFiniteCanonicalNumber(undefined)).toBe(false);
    expect(isFiniteCanonicalNumber({})).toBe(false);
    expect(isFiniteCanonicalNumber([1])).toBe(false);
  });
});

describe("assertFiniteCanonicalNumber", () => {
  it("does not throw for a finite number, including zero and a negative value", () => {
    expect(() => assertFiniteCanonicalNumber(0, "quantity")).not.toThrow();
    expect(() => assertFiniteCanonicalNumber(-3.5, "balance")).not.toThrow();
  });

  it("throws naming the field and value for NaN", () => {
    expect(() => assertFiniteCanonicalNumber(Number.NaN, "price")).toThrow(/price.*NaN/s);
  });

  it("throws naming the field for +Infinity and -Infinity", () => {
    expect(() => assertFiniteCanonicalNumber(Number.POSITIVE_INFINITY, "stock")).toThrow(
      /stock/,
    );
    expect(() => assertFiniteCanonicalNumber(Number.NEGATIVE_INFINITY, "rate")).toThrow(/rate/);
  });

  it("throws for non-number input", () => {
    expect(() => assertFiniteCanonicalNumber("100", "money")).toThrow(/money/);
  });

  it("narrows the type for downstream use after a passing assertion", () => {
    const value: unknown = 12.5;
    assertFiniteCanonicalNumber(value, "tolerance");
    const doubled: number = value * 2;
    expect(doubled).toBe(25);
  });
});
