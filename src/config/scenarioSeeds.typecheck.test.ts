import { describe, expect, it } from "vitest";

import type {
  CohortSeed,
  CurrencyRegimeSeed,
  ProductionUnitSeed,
} from "./scenarioDefinition";
import type { GoodDefinition } from "./definitionPack";

// These assertions are the actual regression: `npm run typecheck` must fail if any
// `@ts-expect-error` below stops being an error, proving REQ-CONFIG-003's seed/
// GoodDefinition shapes are narrow literal-typed rather than accepting an arbitrary
// string or a bare `Record<string, unknown>`.
describe("scenario seed and GoodDefinition shapes (compile-time)", () => {
  it("rejects a ProductionUnitSeed.owner discriminant outside CLAN | STATE", () => {
    const owner: ProductionUnitSeed["owner"] = { type: "CLAN", key: "clan-1" };

    // @ts-expect-error a third owner-kind literal is not assignable to ProductionUnitSeed["owner"].
    const mismatchedOwner: ProductionUnitSeed["owner"] = { type: "MERCHANT_GUILD", key: "g-1" };

    expect(owner.type).toBe("CLAN");
    void mismatchedOwner;
  });

  it("rejects an arbitrary string for CohortSeed.ageBand and CohortSeed.stratum", () => {
    // @ts-expect-error "TEEN" is not one of CohortSeed["ageBand"]'s literals.
    const mismatchedAgeBand: CohortSeed["ageBand"] = "TEEN";
    // @ts-expect-error "UPPER" is not one of CohortSeed["stratum"]'s literals (see HANDOFF-REPAIR-001).
    const mismatchedStratum: CohortSeed["stratum"] = "UPPER";

    void mismatchedAgeBand;
    void mismatchedStratum;
  });

  it("rejects an arbitrary string for CurrencyRegimeSeed.regimeType", () => {
    // @ts-expect-error "FIXED_PEG" is not one of CurrencyRegimeSeed["regimeType"]'s literals.
    const mismatchedRegime: CurrencyRegimeSeed["regimeType"] = "FIXED_PEG";

    void mismatchedRegime;
  });

  it("rejects a bare Record<string, unknown> for the new seed/GoodDefinition interfaces", () => {
    const bareRecord: Record<string, unknown> = { anything: "goes" };

    // @ts-expect-error a bare Record<string, unknown> is not assignable to CohortSeed.
    const mismatchedCohort: CohortSeed = bareRecord;
    // @ts-expect-error a bare Record<string, unknown> is not assignable to ProductionUnitSeed.
    const mismatchedProductionUnit: ProductionUnitSeed = bareRecord;
    // @ts-expect-error a bare Record<string, unknown> is not assignable to CurrencyRegimeSeed.
    const mismatchedCurrencyRegime: CurrencyRegimeSeed = bareRecord;
    // @ts-expect-error a bare Record<string, unknown> is not assignable to GoodDefinition.
    const mismatchedGoodDefinition: GoodDefinition = bareRecord;

    void mismatchedCohort;
    void mismatchedProductionUnit;
    void mismatchedCurrencyRegime;
    void mismatchedGoodDefinition;
  });
});
