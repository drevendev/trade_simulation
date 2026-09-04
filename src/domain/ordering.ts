/**
 * Deterministic-ordering primitive (REQ-CORE-002).
 *
 * See `docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md` section 2:
 * "Stable ordering rule: whenever results could depend on iteration order, sort by
 * persistent ID (or a documented deterministic secondary key) before processing."
 * `Record`/`Map`/`Set` iteration order is an implementation artifact of insertion
 * order, not a canonical property — any result-sensitive iteration over canonical
 * collections must go through this helper instead.
 */

/**
 * Returns a new array containing `items` sorted ascending by `keyOf(item)`
 * (ordinary lexicographic string comparison — persistent IDs are opaque strings,
 * see `./id`). Shuffling the input's iteration order never changes the result.
 *
 * `keyOf` must be injective over `items` for the result to be fully determined:
 * when two items share a key, this falls back to their relative order in `items`
 * (a stable sort), which is itself an iteration-order artifact. Callers with
 * possibly-colliding keys must supply a `keyOf` that also encodes a documented
 * secondary key, per the specification's "or a documented deterministic secondary
 * key" allowance.
 */
export function stableOrderBy<T>(items: Iterable<T>, keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const keyA = keyOf(a);
    const keyB = keyOf(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

/** Convenience for the common case: `items` already carry their persistent ID at `.id`. */
export function sortByPersistentId<T extends { readonly id: string }>(items: Iterable<T>): T[] {
  return stableOrderBy(items, (item) => item.id);
}
