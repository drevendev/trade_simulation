import { describe, it } from "vitest";

// These tests compile only via `tsc --noEmit` with type checking enabled.
// They do not export a runtime value. Their purpose is proving that TypeScript
// correctly narrows and rejects substitutions.

describe("scenarioSeeds typecheck (tsc --noEmit)", () => {
  it("proves StateSeed rejects a bare Record<string, unknown>", () => {
    // @ts-expect-error Type '{}' is not assignable to type 'StateSeed'
    const _: import("./scenarioDefinition").StateSeed = {};
  });

  it("proves MonetaryAuthoritySeed rejects a bare Record<string, unknown>", () => {
    // @ts-expect-error Type '{}' is not assignable to type 'MonetaryAuthoritySeed'
    const _: import("./scenarioDefinition").MonetaryAuthoritySeed = {};
  });

  it("proves ClanSeed rejects a bare Record<string, unknown>", () => {
    // @ts-expect-error Type '{}' is not assignable to type 'ClanSeed'
    const _: import("./scenarioDefinition").ClanSeed = {};
  });

  it("proves StateSeed rejects missing effectiveCurrencyRegime", () => {
    // @ts-expect-error Property 'effectiveCurrencyRegime' is missing
    const _: import("./scenarioDefinition").StateSeed = {
      key: "test",
      name: "Test State",
      treasury: {},
      publicInventory: {},
      policy: {},
    };
  });

  it("proves MonetaryAuthoritySeed.memberStateKeys is readonly", () => {
    const seed: import("./scenarioDefinition").MonetaryAuthoritySeed = {
      key: "test",
      currencyKey: "test",
      memberStateKeys: ["state-1"],
      wallet: {},
      fxPools: [],
    };
    // @ts-expect-error Property 'push' does not exist on type 'readonly string[]'
    seed.memberStateKeys.push("state-2");
  });

  it("proves ClanSeed rejects missing name", () => {
    // @ts-expect-error Property 'name' is missing
    const _: import("./scenarioDefinition").ClanSeed = {
      key: "test",
      treasury: {},
      preferences: {},
    };
  });

  it("proves CurrencyRegimeSeed.regimeType is narrow", () => {
    const _: import("./scenarioDefinition").CurrencyRegimeSeed = {
      currencyKey: "test",
      // @ts-expect-error Type '"INVALID"' is not assignable to type '"INDEPENDENT_FLOAT" | "MONETARY_UNION" | "FOREIGN_LEGAL_TENDER"'
      regimeType: "INVALID",
      policyAuthorityKey: null,
    };
  });
});
