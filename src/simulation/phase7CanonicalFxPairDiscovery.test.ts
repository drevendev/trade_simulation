import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { buildInitialWorld, type WorldState } from "./worldState";
import {
  derivePhase7CanonicalFxOutputBudgets,
  derivePhase7UnambiguousCanonicalFxPairs,
  type Phase7FxPairRoute,
} from "./phase7CanonicalFxPairDiscovery";
import { phase7FxOutputKey } from "./phase7AggregateReservation";
import { quoteFx } from "./fxWorldPoolAuthority";

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 73,
  );
  const origin = [...world.regions.values()].find(r => r.seed.key === "region:a1-capital");
  const destination = [...world.regions.values()].find(r => r.seed.key === "region:b1-capital");
  const domestic = [...world.regions.values()].find(r => r.seed.key === "region:a2-farm");
  if (!origin || !destination || !domestic) throw new Error("missing baseline FX fixture Regions");
  const route: Phase7FxPairRoute = {
    planId: "m5:alpha-beta", originRegionId: origin.regionId,
    destinationRegionId: destination.regionId,
  };
  const sameCurrency: Phase7FxPairRoute = {
    planId: "m5:alpha-alpha", originRegionId: origin.regionId,
    destinationRegionId: domestic.regionId,
  };
  const source = origin.settlementCurrencyId;
  const target = destination.settlementCurrencyId;
  const matchingPools = [...world.monetaryAuthorities.values()].flatMap(authority =>
    [...authority.fxPools.values()].filter(pool =>
      [pool.baseCurrencyId, pool.quoteCurrencyId].includes(source) &&
      [pool.baseCurrencyId, pool.quoteCurrencyId].includes(target)),
  );
  const solePool = matchingPools[0];
  if (!solePool || matchingPools.length < 2) {
    throw new Error("expected baseline opposing FX pair seeds");
  }
  const uniqueWorld: WorldState = {
    ...world,
    monetaryAuthorities: new Map([...world.monetaryAuthorities].map(([id, authority]) => [
      id, {
        ...authority,
        fxPools: new Map([...authority.fxPools].filter(([pairId, pool]) =>
          !([pool.baseCurrencyId, pool.quoteCurrencyId].includes(source) &&
            [pool.baseCurrencyId, pool.quoteCurrencyId].includes(target)) ||
          pairId === solePool.pairId)),
      },
    ])),
  };
  return { world, uniqueWorld, route, sameCurrency, solePool, source, target };
}

describe("M5 #673: current WorldState owns opt-in Phase-7 FX pair identity", () => {
  it("selects the one existing issuer-owned pool, independent of registry/route order", () => {
    const f = fixture();
    const other: Phase7FxPairRoute = { ...f.route, planId: "m5:another" };
    const originalShipments = f.uniqueWorld.shipments;
    const originalAuthorities = f.uniqueWorld.monetaryAuthorities;
    const first = derivePhase7UnambiguousCanonicalFxPairs(
      f.uniqueWorld, [other, f.sameCurrency, f.route],
    );
    const reverseWorld: WorldState = {
      ...f.uniqueWorld,
      monetaryAuthorities: new Map([...f.uniqueWorld.monetaryAuthorities].reverse()),
    };
    const second = derivePhase7UnambiguousCanonicalFxPairs(
      reverseWorld, [f.route, f.sameCurrency, other],
    );
    expect([...first]).toEqual([
      ["m5:alpha-beta", f.solePool.pairId],
      ["m5:another", f.solePool.pairId],
    ]);
    expect([...second]).toEqual([...first]);
    expect(f.uniqueWorld.shipments).toBe(originalShipments);
    expect(f.uniqueWorld.monetaryAuthorities).toBe(originalAuthorities);
  });

  it("derives one shared live FX output ceiling per pool and direction, invariant under route order", () => {
    const f = fixture();
    const other: Phase7FxPairRoute = { ...f.route, planId: "m5:another" };
    const pairs = new Map([
      [f.route.planId, f.solePool.pairId],
      [other.planId, f.solePool.pairId],
    ]);
    const expected = quoteFx(
      f.uniqueWorld, f.solePool.pairId, f.target, f.source, 0,
    ).maxOutputByPoolReserve;
    expect(expected).toBeGreaterThan(0);
    const first = derivePhase7CanonicalFxOutputBudgets(
      f.uniqueWorld, [other, f.sameCurrency, f.route], pairs,
    );
    const reversed = derivePhase7CanonicalFxOutputBudgets(
      f.uniqueWorld, [f.route, other, f.sameCurrency], new Map([...pairs].reverse()),
    );
    expect([...first]).toEqual([[phase7FxOutputKey(f.solePool.pairId, f.source), expected]]);
    expect([...reversed]).toEqual([...first]);
    expect(f.uniqueWorld.shipments?.size).toBe(0);
  });

  it("respects the source-currency pool reserve floor, with no invented liquidity or stock mutation", () => {
    const f = fixture();
    const floor = f.solePool.baseCurrencyId === f.source
      ? f.solePool.minOperationalReserveBase
      : f.solePool.minOperationalReserveQuote;
    const constrained: WorldState = {
      ...f.uniqueWorld,
      monetaryAuthorities: new Map([...f.uniqueWorld.monetaryAuthorities].map(([id, authority]) => [
        id, {
          ...authority,
          fxPools: new Map([...authority.fxPools].map(([pairId, pool]) => [
            pairId, pairId === f.solePool.pairId
              ? { ...pool, cash: new Map(pool.cash).set(f.source, floor) }
              : pool,
          ])),
        },
      ])),
    };
    const pairs = new Map([[f.route.planId, f.solePool.pairId]]);
    const output = derivePhase7CanonicalFxOutputBudgets(constrained, [f.route], pairs);
    expect(output.get(phase7FxOutputKey(f.solePool.pairId, f.source))).toBe(0);
    expect(f.uniqueWorld.monetaryAuthorities).not.toBe(constrained.monetaryAuthorities);
    expect(constrained.shipments?.size).toBe(0);
  });

  it("rejects forged, missing or surplus pool identities and same-currency FX claims", () => {
    const f = fixture();
    const correct = new Map([[f.route.planId, f.solePool.pairId]]);
    const run = (routes: readonly Phase7FxPairRoute[], pairs: Map<string, string>) =>
      derivePhase7CanonicalFxOutputBudgets(f.uniqueWorld, routes, pairs);
    expect(() => run([f.route], new Map())).toThrow("resolved live pool");
    expect(() => run([f.route], new Map([[f.route.planId, "fake-pool"]])))
      .toThrow("Unknown canonical FX pair");
    expect(() => run([f.route, f.route], correct)).toThrow("duplicate");
    expect(() => run([f.route], new Map([...correct, ["surplus", f.solePool.pairId]])))
      .toThrow("surplus");
    expect(() => run([f.sameCurrency], new Map([[f.sameCurrency.planId, f.solePool.pairId]])))
      .toThrow("same-currency");
    expect([...run([f.sameCurrency], new Map())]).toEqual([]);
    expect(f.uniqueWorld.shipments?.size).toBe(0);
  });

  it("fails closed on two configured reverse-oriented pools rather than inventing a preference", () => {
    const f = fixture();
    expect(() => derivePhase7UnambiguousCanonicalFxPairs(f.world, [f.route]))
      .toThrow("exactly one live pool");
    expect(f.world.shipments?.size).toBe(0);
  });

  it("fails closed when the only currency pair is absent", () => {
    const f = fixture();
    const withoutPair: WorldState = {
      ...f.uniqueWorld,
      monetaryAuthorities: new Map([...f.uniqueWorld.monetaryAuthorities].map(([id, authority]) => [
        id, {
          ...authority,
          fxPools: new Map([...authority.fxPools].filter(([pairId]) =>
            pairId !== f.solePool.pairId)),
        },
      ])),
    };
    expect(() => derivePhase7UnambiguousCanonicalFxPairs(withoutPair, [f.route]))
      .toThrow("exactly one live pool");
  });

  it("never requires an FX pair on a same-currency directed route", () => {
    const f = fixture();
    expect([...derivePhase7UnambiguousCanonicalFxPairs(f.world, [f.sameCurrency])])
      .toEqual([]);
  });

  it("rejects duplicate plan identity and unknown Region without touching stocks", () => {
    const f = fixture();
    expect(() => derivePhase7UnambiguousCanonicalFxPairs(
      f.uniqueWorld, [f.route, f.route],
    )).toThrow("duplicate");
    expect(() => derivePhase7UnambiguousCanonicalFxPairs(f.uniqueWorld, [
      { ...f.route, destinationRegionId: "region:missing" as never },
    ])).toThrow("unknown Region");
    expect(f.uniqueWorld.shipments?.size).toBe(0);
  });

  it("rejects an unowned or malformed matching FX pool rather than accepting its pairId", () => {
    const f = fixture();
    const owning = [...f.uniqueWorld.monetaryAuthorities].find(([, authority]) =>
      authority.fxPools.has(f.solePool.pairId));
    if (!owning) throw new Error("missing selected issuer");
    const [ownerId, authority] = owning;
    const malformed: WorldState = {
      ...f.uniqueWorld,
      monetaryAuthorities: new Map([
        ...[...f.uniqueWorld.monetaryAuthorities].filter(([id]) => id !== ownerId),
        [ownerId, {
          ...authority,
          fxPools: new Map([...authority.fxPools].map(([key, pool]) =>
            [key, key === f.solePool.pairId
              ? { ...pool, spotRateQuotePerBase: Number.NaN }
              : pool] as const)),
        }],
      ]),
    };
    expect(() => derivePhase7UnambiguousCanonicalFxPairs(malformed, [f.route]))
      .toThrow();
  });
});
