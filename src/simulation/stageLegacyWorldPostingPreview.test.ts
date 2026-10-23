import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, CurrencyId, GoodId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import {
  EXACT_ZERO, exactAdd, exactCompare, exactFromNumber, exactSubtract,
  projectExactToNumber, type ExactStockAmount,
} from "../domain/exactStockAmount";
import type { ExactPostingEndpoint, ExactPostingLeg } from "./exactPostingBundle";
import { stageLegacyWorldPostingPreview } from "./stageLegacyWorldPostingPreview";
import { buildInitialWorld } from "./worldState";

function fixture() {
  // Genuine genesis/registry objects, with deliberately controlled live M4
  // balances; never mutate the frozen genesis ledger or authoritative inputs.
  const base = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
  );
  const currencyId = [...base.currencies.keys()][0]!;
  const goodId = Object.keys(base.definitionRegistry.goods)[0]! as GoodId;
  const [cohortId, cohort] = [...base.cohorts.entries()][0]!;
  const [unitId, unit] = [...base.productionUnits.entries()][0]!;
  const cohorts = new Map(base.cohorts);
  const units = new Map(base.productionUnits);
  cohorts.set(cohortId, {
    ...cohort,
    wallet: new Map([[currencyId, 1e12]]),
    householdInventory: new Map(),
  });
  units.set(unitId, {
    ...unit,
    wallet: new Map(), // valid empty holding, not an invented owner
    outputInventory: new Map([[goodId, 5]]),
  });
  const world = { ...base, cohorts, productionUnits: units };

  const buyerMoney: ExactPostingEndpoint = {
    kind: "MONEY", owner: { type: "COHORT", cohortId }, bucket: "WALLET", currencyId,
  };
  const sellerMoney: ExactPostingEndpoint = {
    kind: "MONEY", owner: { type: "PRODUCTION_UNIT", productionUnitId: unitId },
    bucket: "WALLET", currencyId,
  };
  const buyerGoods: ExactPostingEndpoint = {
    kind: "GOOD", owner: { type: "COHORT", cohortId }, bucket: "GENERAL", goodId,
  };
  const sellerGoods: ExactPostingEndpoint = {
    kind: "GOOD", owner: { type: "PRODUCTION_UNIT", productionUnitId: unitId },
    bucket: "OUTPUT", goodId,
  };
  return { world, currencyId, goodId, cohortId, buyerMoney, sellerMoney, buyerGoods, sellerGoods };
}

function record(legId: string, endpoint: ExactPostingEndpoint, delta: ExactStockAmount): ExactPostingLeg {
  return { legId, endpoint, delta };
}

function key(endpoint: ExactPostingEndpoint): string {
  return JSON.stringify([
    endpoint.kind, actorRefKey(endpoint.owner), endpoint.bucket,
    endpoint.kind === "MONEY" ? endpoint.currencyId : endpoint.goodId,
  ]);
}

describe("M4 read-only legacy WorldState posting preview (#798)", () => {
  it("uses real M4 wallets and buckets, preserving sub-ULP money and paired goods without a WorldState write", () => {
    const f = fixture();
    const tiny = exactFromNumber(2 ** -14);
    const good = exactFromNumber(0.25);
    const originalCohort = f.world.cohorts.get(f.cohortId)!;
    const originalUnit = [...f.world.productionUnits.values()][0]!;
    const beforeLedger = f.world.worldGenesisLedger;

    const staged = stageLegacyWorldPostingPreview(f.world, [
      record("buyer-cash", f.buyerMoney, exactSubtract(EXACT_ZERO, tiny)),
      record("seller-cash", f.sellerMoney, tiny),
      record("seller-stock", f.sellerGoods, exactSubtract(EXACT_ZERO, good)),
      record("buyer-stock", f.buyerGoods, good),
    ]);
    const at = (endpoint: ExactPostingEndpoint) => staged.find(row => key(row.endpoint) === key(endpoint))!;
    expect(staged).toHaveLength(4);
    expect(at(f.buyerMoney).opening).toEqual(exactFromNumber(1e12));
    expect(at(f.sellerMoney).opening).toEqual(EXACT_ZERO);
    expect(at(f.sellerGoods).opening).toEqual(exactFromNumber(5));
    expect(at(f.buyerGoods).opening).toEqual(EXACT_ZERO);
    expect(exactAdd(at(f.buyerMoney).closing, at(f.sellerMoney).closing))
      .toEqual(exactFromNumber(1e12));
    expect(exactAdd(at(f.sellerGoods).closing, at(f.buyerGoods).closing))
      .toEqual(exactFromNumber(5));
    expect(exactCompare(at(f.buyerMoney).closing, at(f.buyerMoney).opening)).toBe(-1);
    // The legacy Number projection can swallow this valid amount. Preview must
    // not be misrepresented as a successful authoritative WorldState commit.
    expect(projectExactToNumber(at(f.buyerMoney).closing)).toBe(1e12);
    expect(f.world.cohorts.get(f.cohortId)).toBe(originalCohort);
    expect([...f.world.productionUnits.values()][0]).toBe(originalUnit);
    expect(originalCohort.wallet.get(f.currencyId)).toBe(1e12);
    expect(originalCohort.householdInventory.get(f.goodId)).toBeUndefined();
    expect(originalUnit.wallet.get(f.currencyId)).toBeUndefined();
    expect(originalUnit.outputInventory.get(f.goodId)).toBe(5);
    expect(f.world.worldGenesisLedger).toBe(beforeLedger);
    expect(Object.isFrozen(staged)).toBe(true);
    expect(stageLegacyWorldPostingPreview(f.world, [
      record("seller-cash", f.sellerMoney, tiny),
      record("buyer-cash", f.buyerMoney, exactSubtract(EXACT_ZERO, tiny)),
    ]).map(row => [key(row.endpoint), row.opening, row.closing]))
      .toEqual(staged.filter(row => row.endpoint.kind === "MONEY")
        .map(row => [key(row.endpoint), row.opening, row.closing]));
  });

  it("fails closed for absent actors, unregistered assets, and forbidden physical buckets", () => {
    const f = fixture();
    const debit = record("buyer", f.buyerMoney, exactFromNumber(-1));
    const credit = record("seller", f.sellerMoney, exactFromNumber(1));
    const absent: ExactPostingEndpoint = {
      ...f.buyerMoney, owner: { type: "COHORT", cohortId: "cohort:unknown" as CohortId },
    };
    expect(() => stageLegacyWorldPostingPreview(f.world, [
      record("missing-owner", absent, exactFromNumber(-1)), credit,
    ])).toThrow(/no CohortState/);

    const invalidCurrency: ExactPostingEndpoint = {
      ...f.sellerMoney, currencyId: "currency:unknown" as CurrencyId,
    };
    expect(() => stageLegacyWorldPostingPreview(f.world, [
      debit, record("unknown-currency", invalidCurrency, exactFromNumber(1)),
    ])).toThrow(/unknown live currency/);

    const invalidGood: ExactPostingEndpoint = {
      ...f.sellerGoods, goodId: "__proto__" as GoodId,
    };
    expect(() => stageLegacyWorldPostingPreview(f.world, [
      record("unknown-good", invalidGood, exactFromNumber(-1)),
      record("good-credit", f.buyerGoods, exactFromNumber(1)),
    ])).toThrow(/unknown live good/);

    const invalidBucket: ExactPostingEndpoint = {
      ...f.sellerGoods, bucket: "GENERAL",
    };
    expect(() => stageLegacyWorldPostingPreview(f.world, [
      record("wrong-bucket", invalidBucket, exactFromNumber(-1)),
      record("good-credit", f.buyerGoods, exactFromNumber(1)),
    ])).toThrow(/authorized goods bucket/);
    expect(f.world.cohorts.get(f.cohortId)!.wallet.get(f.currencyId)).toBe(1e12);
  });

  it("refuses corrupt live Number balances instead of normalizing them or mutating the world", () => {
    const f = fixture();
    for (const invalid of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const cohorts = new Map(f.world.cohorts);
      const cohort = cohorts.get(f.cohortId)!;
      cohorts.set(f.cohortId, {
        ...cohort, wallet: new Map([[f.currencyId, invalid]]),
      });
      const corrupt = { ...f.world, cohorts };
      expect(() => stageLegacyWorldPostingPreview(corrupt, [
        record("buyer", f.buyerMoney, exactFromNumber(-0.5)),
        record("seller", f.sellerMoney, exactFromNumber(0.5)),
      ])).toThrow(/negative|finite/);
      expect(corrupt.cohorts.get(f.cohortId)!.wallet.get(f.currencyId))
        .toBe(invalid);
    }
  });
  it("rejects present nullish receiver stocks for MONEY and GOOD but accepts genuinely missing keys", () => {
    const f = fixture();
    const buyerDebit = record("money-debit", f.buyerMoney, exactFromNumber(-0.5));
    const sellerCredit = record("money-credit", f.sellerMoney, exactFromNumber(0.5));
    const unitDebit = record("goods-debit", f.sellerGoods, exactFromNumber(-0.25));
    const cohortCredit = record("goods-credit", f.buyerGoods, exactFromNumber(0.25));
    const initialGenesis = f.world.worldGenesisLedger;

    // Missing wallet/inventory entries are legal zero stocks, not missing owners.
    expect(stageLegacyWorldPostingPreview(f.world, [buyerDebit, sellerCredit]))
      .find(row => key(row.endpoint) === key(f.sellerMoney))?.opening).toEqual(EXACT_ZERO);
    expect(stageLegacyWorldPostingPreview(f.world, [unitDebit, cohortCredit]))
      .find(row => key(row.endpoint) === key(f.buyerGoods))?.opening).toEqual(EXACT_ZERO);

    for (const invalid of [null, undefined] as const) {
      // Credit into a present malformed wallet must refuse, even when the
      // opposite debit is valid, fully funded and the bundle conserves money.
      const units = new Map(f.world.productionUnits);
      const [unitId, unit] = [...units.entries()][0]!;
      const malformedWallet = new Map(unit.wallet);
      malformedWallet.set(f.currencyId, invalid as unknown as number);
      units.set(unitId, { ...unit, wallet: malformedWallet });
      const corruptMoney = { ...f.world, productionUnits: units };
      expect(() => stageLegacyWorldPostingPreview(corruptMoney, [
        buyerDebit, sellerCredit,
      ])).toThrow(/present holding must be a finite nonnegative number/);
      expect(corruptMoney.productionUnits.get(unitId)!.wallet.has(f.currencyId)).toBe(true);
      expect(corruptMoney.productionUnits.get(unitId)!.wallet.get(f.currencyId)).toBe(invalid);
      expect(corruptMoney.worldGenesisLedger).toBe(initialGenesis);
      expect(f.world.productionUnits.get(unitId)!.wallet.has(f.currencyId)).toBe(false);

      // Repeat with a receiving cohort's physical inventory: Map.has is
      // required for both assets, not just for wallet entries.
      const cohorts = new Map(f.world.cohorts);
      const cohort = cohorts.get(f.cohortId)!;
      const malformedInventory = new Map(cohort.householdInventory);
      malformedInventory.set(f.goodId, invalid as unknown as number);
      cohorts.set(f.cohortId, { ...cohort, householdInventory: malformedInventory });
      const corruptGoods = { ...f.world, cohorts };
      expect(() => stageLegacyWorldPostingPreview(corruptGoods, [
        unitDebit, cohortCredit,
      ])).toThrow(/present holding must be a finite nonnegative number/);
      expect(corruptGoods.cohorts.get(f.cohortId)!.householdInventory.has(f.goodId)).toBe(true);
      expect(corruptGoods.cohorts.get(f.cohortId)!.householdInventory.get(f.goodId)).toBe(invalid);
      expect(corruptGoods.worldGenesisLedger).toBe(initialGenesis);
      expect(f.world.cohorts.get(f.cohortId)!.householdInventory.has(f.goodId)).toBe(false);
    }
  });

});
