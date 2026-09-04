/**
 * Finite-number invariant (REQ-CORE-002).
 *
 * See `docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md` section 2:
 * "All quantities, money values and rates use finite IEEE-754 numbers in v1... No
 * NaN/Infinity may enter canonical state." Every subsystem that writes a canonical
 * numeric field (quantities, money, rates, tolerances) must route the value through
 * this guard before it is stored.
 */

/** True for any finite `number` — rejects `NaN`, `+Infinity`, `-Infinity`, and non-numbers. */
export function isFiniteCanonicalNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Throws unless `value` is a finite `number`. `label` identifies the field being
 * validated so the error names the offending canonical value, not just "a number".
 */
export function assertFiniteCanonicalNumber(
  value: unknown,
  label: string,
): asserts value is number {
  if (!isFiniteCanonicalNumber(value)) {
    throw new Error(`${label} must be a finite number, got ${describeNonFinite(value)}`);
  }
}

function describeNonFinite(value: unknown): string {
  if (typeof value === "number") {
    return Number.isNaN(value) ? "NaN" : value.toString();
  }
  return JSON.stringify(value);
}
