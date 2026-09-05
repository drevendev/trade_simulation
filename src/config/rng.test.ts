import { describe, expect, it } from "vitest";

import { deriveKeyedRandom, type RngKey } from "./rng";

const KEY_A: RngKey = { seed: 7, tick: 0, phase: "genesis", key: "region:r-1" };
const KEY_B: RngKey = { seed: 7, tick: 0, phase: "genesis", key: "region:r-2" };
const KEY_C: RngKey = { seed: 7, tick: 1, phase: "genesis", key: "region:r-1" };
const KEY_D: RngKey = { seed: 7, tick: 1, phase: "production", key: "region:r-1" };
const KEY_E: RngKey = { seed: 7, tick: 1, phase: "production", key: "region:r-2" };
const KEY_F: RngKey = { seed: 42, tick: 1, phase: "production", key: "region:r-2" };
const KEYS: RngKey[] = [KEY_A, KEY_B, KEY_C, KEY_D, KEY_E, KEY_F];

describe("deriveKeyedRandom", () => {
  it("reproduces the same value across repeated calls with the same key", () => {
    const key: RngKey = { seed: 7, tick: 3, phase: "production", key: "market:m-1" };

    const first = deriveKeyedRandom(key);
    const second = deriveKeyedRandom(key);

    expect(second).toBe(first);
  });

  it("yields identical per-key results regardless of the order keys are evaluated in", () => {
    const shuffledA = [KEY_D, KEY_A, KEY_F, KEY_B, KEY_E, KEY_C];
    const shuffledB = [KEY_C, KEY_E, KEY_B, KEY_F, KEY_A, KEY_D];

    const byKeyA = new Map(shuffledA.map((k) => [JSON.stringify(k), deriveKeyedRandom(k)]));
    const byKeyB = new Map(shuffledB.map((k) => [JSON.stringify(k), deriveKeyedRandom(k)]));

    for (const key of KEYS) {
      const encoded = JSON.stringify(key);
      expect(byKeyB.get(encoded)).toBe(byKeyA.get(encoded));
    }
  });

  it("changes the derived value when only seed differs", () => {
    const a = deriveKeyedRandom({ seed: 1, tick: 0, phase: "genesis", key: "k" });
    const b = deriveKeyedRandom({ seed: 2, tick: 0, phase: "genesis", key: "k" });
    expect(a).not.toBe(b);
  });

  it("changes the derived value when only tick differs", () => {
    const a = deriveKeyedRandom({ seed: 1, tick: 0, phase: "genesis", key: "k" });
    const b = deriveKeyedRandom({ seed: 1, tick: 1, phase: "genesis", key: "k" });
    expect(a).not.toBe(b);
  });

  it("changes the derived value when only phase differs", () => {
    const a = deriveKeyedRandom({ seed: 1, tick: 0, phase: "genesis", key: "k" });
    const b = deriveKeyedRandom({ seed: 1, tick: 0, phase: "production", key: "k" });
    expect(a).not.toBe(b);
  });

  it("changes the derived value when only the entity/event key differs", () => {
    const a = deriveKeyedRandom({ seed: 1, tick: 0, phase: "genesis", key: "k1" });
    const b = deriveKeyedRandom({ seed: 1, tick: 0, phase: "genesis", key: "k2" });
    expect(a).not.toBe(b);
  });

  it("does not collide across a key composed differently but naively concatenated the same", () => {
    // Naive delimiter-joined encodings ("a" + "," + "bc" vs "ab" + "," + "c") can
    // collide; JSON-array encoding of the four distinct fields must not.
    const a = deriveKeyedRandom({ seed: 1, tick: 0, phase: "a", key: "bc" });
    const b = deriveKeyedRandom({ seed: 1, tick: 0, phase: "ab", key: "c" });
    expect(a).not.toBe(b);
  });

  it("returns a value in the half-open interval [0, 1)", () => {
    for (const key of KEYS) {
      const value = deriveKeyedRandom(key);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("rejects a non-finite seed or tick", () => {
    expect(() =>
      deriveKeyedRandom({ seed: Number.NaN, tick: 0, phase: "genesis", key: "k" }),
    ).toThrow(/RngKey.seed/);
    expect(() =>
      deriveKeyedRandom({ seed: 0, tick: Number.POSITIVE_INFINITY, phase: "genesis", key: "k" }),
    ).toThrow(/RngKey.tick/);
  });

  it("rejects an empty phase or key", () => {
    expect(() => deriveKeyedRandom({ seed: 0, tick: 0, phase: "", key: "k" })).toThrow(
      /RngKey.phase/,
    );
    expect(() => deriveKeyedRandom({ seed: 0, tick: 0, phase: "genesis", key: "" })).toThrow(
      /RngKey.key/,
    );
  });
});
