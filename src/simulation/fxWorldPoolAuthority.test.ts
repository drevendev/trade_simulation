import { describe, expect, it } from "vitest";

import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { reconcileGenesisStocks } from "./genesisReconciliation";
import { buildInitialWorld, type WorldState } from "./worldState";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";

const PAIR = "fxpool:currency:alpha-currency:beta";

function genesis(scenario = baselineScenario): WorldState {
  return buildInitialWorld(scenario, baselineDefinitionPack, createDefaultSimulationConfig(), 37);
}

function authorityByKey(world: WorldState, key: string) {
  const authority = [...world.monetaryAuthorities.values()].find((item) => item.seed.key === key);
  if (!authority) throw new Error("Missing fixture authority: " + key);
  return authority;
}

describe("M5 #671 canonical WorldState FX pool ownership (Handoff/04 §17)", () => {
  it("materializes every oriented seed pool exactly once under its base issuer", () => {
    const world = genesis();
    const keys = new Set<string>();
    let count = 0;

    for (const [authorityId, authority] of world.monetaryAuthorities) {
      for (const [pairId, pool] of authority.fxPools) {
        expect(keys.has(pairId)).toBe(false);
        keys.add(pairId);
        count++;
        expect(pool.pairId).toBe(pairId);
        expect(authority.authorityId).toBe(authorityId);
        expect(pool.baseCurrencyId).toBe(authority.currencyId);
        expect(world.currencies.get(pool.baseCurrencyId)?.issuerAuthorityId).toBe(authorityId);
        expect([...pool.cash.keys()].sort()).toEqual(
          [pool.baseCurrencyId, pool.quoteCurrencyId].sort(),
        );
        expect(resolveCanonicalFxPool(world, pairId)).toEqual({
          owningAuthorityId: authorityId,
          pool,
        });
      }
    }

    const declared = baselineScenario.monetaryAuthorities.reduce(
      (sum, authority) => sum + authority.fxPools.length, 0,
    );
    expect(count).toBe(declared);
    expect(count).toBeGreaterThan(0);
    expect(world.monetaryAuthorities.size).toBe(4);
  });

  it("retains independent reciprocal pools with correct explicit directions", () => {
    const world = genesis();
    const alpha = authorityByKey(world, "authority:alpha");
    const beta = authorityByKey(world, "authority:beta");
    const ab = alpha.fxPools.get(PAIR)!;
    const ba = beta.fxPools.get("fxpool:currency:beta-currency:alpha")!;
    expect(ab).toBeDefined();
    expect(ba).toBeDefined();
    expect(ab.baseCurrencyId).toBe(alpha.currencyId);
    expect(ba.baseCurrencyId).toBe(beta.currencyId);
    expect(ab).not.toBe(ba);
    expect(ab.cash).not.toBe(ba.cash);

    const forward = quoteFx(world, PAIR, ab.baseCurrencyId, ab.quoteCurrencyId, 20);
    const reverse = quoteFx(world, PAIR, ab.quoteCurrencyId, ab.baseCurrencyId, 20);
    expect(forward.direction).toBe("BASE_TO_QUOTE");
    expect(reverse.direction).toBe("QUOTE_TO_BASE");
    expect(forward.requiredInputForFeasibleOutput).toBeCloseTo(20 / (1 - ab.transactionSpread), 9);
    expect(reverse.requiredInputForFeasibleOutput).toBeCloseTo(20 * (1 + ab.transactionSpread), 9);
    expect(() => quoteFx(world, PAIR, ab.baseCurrencyId, ab.baseCurrencyId, 20))
      .toThrow(/pair\/direction/);
  });

  it("preserves opening money in live pool stock, not an authority wallet or mutable seed cash", () => {
    const scenario = structuredClone(baselineScenario);
    const world = genesis(scenario);
    const alpha = authorityByKey(world, "authority:alpha");
    const pool = alpha.fxPools.get(PAIR)!;
    const original = pool.cash.get(pool.baseCurrencyId)!;
    const opening = scenario.monetaryAuthorities[0]!.fxPools[0]!;
    expect(original).toBe(opening.cash[opening.baseCurrencyKey]);

    // Updating origin data cannot manufacture or destroy a pool's live stock.
    (opening.cash as Record<string, number>)[opening.baseCurrencyKey] = 0;
    expect(pool.cash.get(pool.baseCurrencyId)).toBe(original);
    expect(reconcileGenesisStocks(world, world.worldGenesisLedger, world.simulationConfig).success).toBe(true);
    expect(quoteFx(world, PAIR, pool.baseCurrencyId, pool.quoteCurrencyId, 10).feasibleOutputAmount)
      .toBe(10);
  });

  it("fails opening reconciliation when live pool balances diverge from the recorded endowment", () => {
    const world = genesis();
    const alpha = authorityByKey(world, "authority:alpha");
    const pool = alpha.fxPools.get(PAIR)!;
    const corruptedCash = new Map(pool.cash);
    corruptedCash.set(pool.baseCurrencyId, corruptedCash.get(pool.baseCurrencyId)! + 5);
    const alteredAuthorities = new Map(world.monetaryAuthorities);
    alteredAuthorities.set(alpha.authorityId, {
      ...alpha,
      fxPools: new Map(alpha.fxPools).set(PAIR, { ...pool, cash: corruptedCash }),
    });
    const changed = { ...world, monetaryAuthorities: alteredAuthorities };
    const result = reconcileGenesisStocks(
      changed, world.worldGenesisLedger, world.simulationConfig,
    );
    expect(result.success).toBe(false);
    expect(result.details?.category).toMatch(/MONEY/);
    expect(result.details?.key).toContain(PAIR);
  });

  it.each([
    ["base", Number.NaN],
    ["quote", Number.POSITIVE_INFINITY],
    ["quote", Number.NEGATIVE_INFINITY],
  ] as const)(
    "fails opening money reconciliation for non-finite live FX %s cash (%s)",
    (side, invalidAmount) => {
      const world = genesis();
      const authority = authorityByKey(world, "authority:alpha");
      const pool = authority.fxPools.get(PAIR)!;
      const currencyId = side === "base" ? pool.baseCurrencyId : pool.quoteCurrencyId;

      // Preserve identity, map shape and the original ledger: only the live cash
      // changes. A NaN residual or Infinity tolerance must not mean SUCCESS.
      const corruptedCash = new Map(pool.cash);
      corruptedCash.set(currencyId, invalidAmount);
      const authorities = new Map(world.monetaryAuthorities);
      authorities.set(authority.authorityId, {
        ...authority,
        fxPools: new Map(authority.fxPools).set(PAIR, { ...pool, cash: corruptedCash }),
      });
      const result = reconcileGenesisStocks(
        { ...world, monetaryAuthorities: authorities },
        world.worldGenesisLedger,
        world.simulationConfig,
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/non-finite reconciliation evidence/);
      expect(result.details?.category).toBe("MONEY");
      expect(result.details?.key).toContain(PAIR);
      expect(result.details?.actual).toBe(invalidAmount);
    },
  );

  it("rejects duplicate pool ownership and a misplaced pool under the quote issuer", () => {
    const world = genesis();
    const alpha = authorityByKey(world, "authority:alpha");
    const beta = authorityByKey(world, "authority:beta");
    const pool = alpha.fxPools.get(PAIR)!;

    const duplicateAuthorities = new Map(world.monetaryAuthorities);
    duplicateAuthorities.set(beta.authorityId, {
      ...beta, fxPools: new Map(beta.fxPools).set(PAIR, pool),
    });
    expect(() => resolveCanonicalFxPool({
      ...world, monetaryAuthorities: duplicateAuthorities,
    }, PAIR)).toThrow(/duplicate canonical pool owners/);

    const misplacedAuthorities = new Map(duplicateAuthorities);
    misplacedAuthorities.set(alpha.authorityId, {
      ...alpha, fxPools: new Map([...alpha.fxPools].filter(([key]) => key !== PAIR)),
    });
    expect(() => resolveCanonicalFxPool({
      ...world, monetaryAuthorities: misplacedAuthorities,
    }, PAIR)).toThrow(/not owned by the base-currency issuer/);
  });

  it("is deterministic under authority and pool seed order permutations", () => {
    const first = genesis();
    const reversed = genesis({
      ...baselineScenario,
      monetaryAuthorities: [...baselineScenario.monetaryAuthorities].reverse().map(
        (authority) => ({ ...authority, fxPools: [...authority.fxPools].reverse() }),
      ),
    });
    const left = resolveCanonicalFxPool(first, PAIR).pool;
    const right = resolveCanonicalFxPool(reversed, PAIR).pool;
    expect(left).toEqual(right);
    expect(quoteFx(first, PAIR, left.baseCurrencyId, left.quoteCurrencyId, 15))
      .toEqual(quoteFx(reversed, PAIR, right.baseCurrencyId, right.quoteCurrencyId, 15));
  });
});
