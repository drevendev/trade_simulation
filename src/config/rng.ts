/**
 * Keyed deterministic RNG service (REQ-CONFIG-002).
 *
 * See `docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`
 * Milestone 1: "Implement keyed deterministic RNG service. RNG keys must include
 * seed + tick + phase + entity/event key as specified; iteration order must not
 * alter results." `deriveKeyedRandom` is a pure function of its four-part key —
 * there is no shared/mutable generator state — so evaluating the same key twice,
 * or interleaved with any number of other keys in any order, always reproduces
 * the same value.
 */

import { assertFiniteCanonicalNumber } from "../domain/numeric";

/** Identifies one deterministic draw: `seed + tick + phase + entity/event key`. */
export interface RngKey {
  readonly seed: number;
  readonly tick: number;
  readonly phase: string;
  readonly key: string;
}

/**
 * Derives a deterministic value in `[0, 1)` from `rngKey`. Calling this with the
 * same key — at any point in a run, in any order relative to other keys — always
 * returns the same value; changing any one of `seed`, `tick`, `phase` or `key`
 * changes the derived value.
 */
export function deriveKeyedRandom(rngKey: RngKey): number {
  assertFiniteCanonicalNumber(rngKey.seed, "RngKey.seed");
  assertFiniteCanonicalNumber(rngKey.tick, "RngKey.tick");
  if (rngKey.phase.length === 0) {
    throw new Error("RngKey.phase must be a non-empty string");
  }
  if (rngKey.key.length === 0) {
    throw new Error("RngKey.key must be a non-empty string");
  }

  const encoded = JSON.stringify([rngKey.seed, rngKey.tick, rngKey.phase, rngKey.key]);
  return hashToUnitInterval(encoded);
}

/**
 * `cyrb53` (public-domain string hash by bryc) mixed down to a 53-bit unsigned
 * integer, then normalized to `[0, 1)`. Chosen for good avalanche behavior
 * (small input changes flip roughly half the output bits) using only integer
 * arithmetic representable exactly as JS numbers — no external dependency, no
 * platform-specific `Math.random`.
 */
function hashToUnitInterval(input: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const uint53 = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return uint53 / 9007199254740992; // 2**53
}
