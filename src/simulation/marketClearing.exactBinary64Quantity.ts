/**
 * Exact dyadic check for monetary/goods quantities stored as IEEE-754 binary64.
 * Pre-materialization guard: does not make WorldState Number balances exact.
 *
 * Every nonnegative finite Number is a rational with denominator 2^1074.
 * Representing all inputs in that common unit prevents an ordinary Number sum
 * from hiding lost quantity by rounding to a large total.
 *
 * All allocations must be finite and >= 0; target/tolerance must also be finite
 * and nonnegative. Work is linear in the number of allocations, with BigInt costs.
 */
const FRACTION_BITS = (1n << 52n) - 1n;
const IMPLIED_BIT = 1n << 52n;
const view = new DataView(new ArrayBuffer(8));

function asScaledInteger(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Expected finite nonnegative binary64 quantity, got ${value}`);
  }
  // Preserve caller-visible zero; -0 is harmless and canonically zero.
  if (value === 0) return 0n;
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const exponent = Number((bits >> 52n) & 2047n);
  const fractional = bits & FRACTION_BITS;
  if (exponent === 2047) throw new RangeError("Nonfinite binary64 quantity");
  // Subnormal: fraction * 2^-1074. Normal: (2^52 + fraction) * 2^(exponent - 1075).
  // Both become an exact integer when multiplied by 2^1074.
  return exponent === 0 ? fractional : (IMPLIED_BIT | fractional) << BigInt(exponent - 1);
}

export function exactBinary64QuantityDelta(
  allocations: ReadonlyArray<number>,
  intendedQuantity: number,
): bigint {
  let actual = 0n;
  for (const quantity of allocations) actual += asScaledInteger(quantity);
  const target = asScaledInteger(intendedQuantity);
  return actual >= target ? actual - target : target - actual;
}

export function exactBinary64QuantityWithinEpsilon(
  allocations: ReadonlyArray<number>,
  intendedQuantity: number,
  epsilon: number,
): boolean {
  return exactBinary64QuantityDelta(allocations, intendedQuantity) <= asScaledInteger(epsilon);
}

export function exactBinary64QuantityScaled(value: number): bigint {
  return asScaledInteger(value);
}
