/**
 * Exact dyadic stock arithmetic for HANDOFF-REPAIR-M4-009 / #797 / #798.
 *
 * This is a PURE CODEC AND ARITHMETIC SEAM, not a second WorldState authority.
 * A later posting bridge must own endpoint identification and atomic mutation.
 * Values are in the currency's existing major unit or the good's existing unit.
 */
export interface ExactStockAmount {
  readonly coefficient: bigint;
  readonly exponent: number;
}

export interface EncodedExactStockAmount {
  readonly coefficient: string;
  readonly exponent: number;
}

export const EXACT_ZERO: ExactStockAmount = Object.freeze({ coefficient: 0n, exponent: 0 });

const BINARY64_MANTISSA_MASK = (1n << 52n) - 1n;
const BINARY64_EXPONENT_MASK = 0x7ffn;
const MAX_FINITE = Object.freeze({ coefficient: (1n << 53n) - 1n, exponent: 971 });
const MAX_CANONICAL_COEFFICIENT_DIGITS = 640; // MAX_VALUE at exponent -1074 needs < 640 decimal digits.
const MAX_INTERMEDIATE_EXPONENT = 2048;
const MAX_INTERMEDIATE_COEFFICIENT_BITS = 4096;

function normalized(coefficient: bigint, exponent: number): ExactStockAmount {
  if (!Number.isSafeInteger(exponent)) {
    throw new Error("exact stock exponent must be a safe integer");
  }
  if (coefficient === 0n) return EXACT_ZERO;
  let value = coefficient;
  let power = exponent;
  while ((value & 1n) === 0n) {
    value >>= 1n;
    power++;
  }
  if (!Number.isSafeInteger(power)) {
    throw new Error("exact stock normalized exponent exceeds safe integer range");
  }
  return Object.freeze({ coefficient: value, exponent: power });
}

function assertCanonical(amount: ExactStockAmount): void {
  if (
    typeof amount !== "object" || amount === null ||
    typeof amount.coefficient !== "bigint" ||
    !Number.isSafeInteger(amount.exponent) ||
    amount.exponent < -1074 || amount.exponent > MAX_INTERMEDIATE_EXPONENT ||
    (amount.coefficient !== 0n && amount.coefficient.toString(2).length > MAX_INTERMEDIATE_COEFFICIENT_BITS) ||
    (amount.coefficient === 0n && amount.exponent !== 0) ||
    (amount.coefficient !== 0n && (amount.coefficient & 1n) === 0n)
  ) {
    throw new Error("exact stock amount must be a normalized BigInt dyad");
  }
}

/** Convert a finite binary64's actual bits, not an idealized decimal string. */
export function exactFromNumber(value: number): ExactStockAmount {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("exact stock input must be a finite number");
  }
  if (value === 0) return EXACT_ZERO; // includes -0
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, false);
  const raw = bits.getBigUint64(0, false);
  const negative = (raw & (1n << 63n)) !== 0n;
  const exp = Number((raw >> 52n) & BINARY64_EXPONENT_MASK);
  const mantissa = raw & BINARY64_MANTISSA_MASK;
  const coefficient = exp === 0 ? mantissa : (1n << 52n) | mantissa;
  return normalized(negative ? -coefficient : coefficient, exp === 0 ? -1074 : exp - 1075);
}

/** Posting calculations may temporarily exceed the storage bound; validate the final endpoint. */
export function exactAdd(a: ExactStockAmount, b: ExactStockAmount): ExactStockAmount {
  assertCanonical(a);
  assertCanonical(b);
  const exponent = Math.min(a.exponent, b.exponent);
  const aShift = BigInt(a.exponent - exponent);
  const bShift = BigInt(b.exponent - exponent);
  return normalized((a.coefficient << aShift) + (b.coefficient << bShift), exponent);
}

export function exactNegate(a: ExactStockAmount): ExactStockAmount {
  assertCanonical(a);
  return a.coefficient === 0n ? EXACT_ZERO : Object.freeze({ coefficient: -a.coefficient, exponent: a.exponent });
}

export function exactSubtract(a: ExactStockAmount, b: ExactStockAmount): ExactStockAmount {
  return exactAdd(a, exactNegate(b));
}

/** Signed comparison without binary64 projection. */
export function exactCompare(a: ExactStockAmount, b: ExactStockAmount): -1 | 0 | 1 {
  assertCanonical(a);
  assertCanonical(b);
  const exponent = Math.min(a.exponent, b.exponent);
  const av = a.coefficient << BigInt(a.exponent - exponent);
  const bv = b.coefficient << BigInt(b.exponent - exponent);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Enforce the finite binary64 physical-stock magnitude WITHOUT rounding it. */
export function assertFiniteExactMagnitude(amount: ExactStockAmount): void {
  assertCanonical(amount);
  const magnitude = amount.coefficient < 0n ? exactNegate(amount) : amount;
  if (magnitude.exponent < -1074 || exactCompare(magnitude, MAX_FINITE) > 0) {
    throw new Error("exact stock amount is outside the finite binary64 storage range");
  }
}

/** A physical endpoint cannot hold a negative stock, even transiently at commit. */
export function assertPhysicalExactStock(amount: ExactStockAmount): void {
  assertFiniteExactMagnitude(amount);
  if (amount.coefficient < 0n) {
    throw new Error("physical exact stock cannot be negative");
  }
}

/** Strict v2 wire form. This does not authorize upgrading historical v1 saves. */
export function encodeExactStockAmount(amount: ExactStockAmount): EncodedExactStockAmount {
  assertFiniteExactMagnitude(amount);
  return { coefficient: amount.coefficient.toString(10), exponent: amount.exponent };
}

export function decodeExactStockAmount(value: unknown): ExactStockAmount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("exact stock encoding must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.coefficient !== "string" ||
    record.coefficient.length > MAX_CANONICAL_COEFFICIENT_DIGITS ||
    !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(record.coefficient) ||
    typeof record.exponent !== "number" ||
    !Number.isSafeInteger(record.exponent) ||
    record.exponent < -1074 || record.exponent > 1023
  ) {
    throw new Error("invalid canonical exact stock encoding");
  }
  const amount: ExactStockAmount = {
    coefficient: BigInt(record.coefficient),
    exponent: record.exponent,
  };
  assertFiniteExactMagnitude(amount); // rejects unnormalized pairs, overflow and invalid zero.
  return Object.freeze(amount);
}

/**
 * Read-only nearest-binary64 projection, ties to even. Never use this return
 * value to update authoritative stock or reconstruct accounting receipts.
 */
export function projectExactToNumber(amount: ExactStockAmount): number {
  assertFiniteExactMagnitude(amount);
  if (amount.coefficient === 0n) return 0;
  const negative = amount.coefficient < 0n;
  const magnitude = negative ? -amount.coefficient : amount.coefficient;
  const bitLength = magnitude.toString(2).length;
  let significand = magnitude;
  let exponent = amount.exponent;
  if (bitLength > 53) {
    const shift = BigInt(bitLength - 53);
    const remainder = magnitude & ((1n << shift) - 1n);
    significand = magnitude >> shift;
    const half = 1n << (shift - 1n);
    if (remainder > half || (remainder === half && (significand & 1n) === 1n)) {
      significand++;
    }
    exponent += Number(shift);
    if (significand === (1n << 53n)) {
      significand >>= 1n;
      exponent++;
    }
  }
  const projection = Number(significand) * 2 ** exponent;
  if (!Number.isFinite(projection)) {
    throw new Error("exact stock projection unexpectedly overflowed");
  }
  return negative ? -projection : projection;
}
