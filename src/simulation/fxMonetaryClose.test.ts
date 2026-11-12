import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import type { CurrencyId } from "../domain/id";
import { buildInitialWorld, type FxLiquidityPoolState, type WorldState } from "./worldState";
import { settleFx, type FxLedgerLeg } from "./fxSettlement";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import type { FxReservation } from "./fxQuoteReservation";
import {
  createFxSettlementId, createTransactionBundleId, initializeTickContext,
  type EconomicTransaction, type TickContext,
} from "./tickOrchestrator";
import {
  captureFxCloseOpening, reconcileAndPlanFxClose, publishFxClose,
  type FxClosePolicy,
} from "./fxMonetaryClose";

const PAIR = "fxpool:currency:alpha-currency:beta";
const POLICY: FxClosePolicy = {
  flowPressureAlpha: 0.25, flowCoefficient: 0.08,
  reserveCoefficient: 0.02, maxAbsoluteLogMovePerTick: 0.03,
};
function fixture(): WorldState {
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47);
  const { pool } = resolveCanonicalFxPool(world, PAIR);
  // Explicit M5 scenario boundary: ONE pool, not the legacy duplicated reverse pair.
  return {
    ...world,
    states: new Map([...world.states].map(([id, state]) => [id, {
      ...state, treasury: new Map([[pool.baseCurrencyId, 10_000], [pool.quoteCurrencyId, 10_000]]),
    }])),
    monetaryAuthorities: new Map([...world.monetaryAuthorities].map(([id, authority]) => [id, {
      ...authority, fxPools: new Map([...authority.fxPools].filter(([key]) => key === PAIR).map(([key, p]) => [key, {
        ...p, spotRateQuotePerBase: 1, transactionSpread: 0.01,
        minOperationalReserveBase: 1, minOperationalReserveQuote: 1,
        targetBaseReserveShare: 0.5, flowPressureEma: 0, maxRateMovePerTick: 0.05,
        cash: new Map([[p.baseCurrencyId, 10_000], [p.quoteCurrencyId, 10_000]]),
      }])),
    }])),
  };
}
function changePool(world: WorldState, change: (p: FxLiquidityPoolState) => FxLiquidityPoolState): WorldState {
  const { pool, owningAuthorityId } = resolveCanonicalFxPool(world, PAIR);
  const authority = world.monetaryAuthorities.get(owningAuthorityId)!;
  return { ...world, monetaryAuthorities: new Map(world.monetaryAuthorities).set(owningAuthorityId, {
    ...authority, fxPools: new Map(authority.fxPools).set(PAIR, change(pool)),
  }) };
}
function changeStateCash(world: WorldState, currency: CurrencyId, delta: number): WorldState {
  const state = [...world.states.values()].find(s => s.seed.key === "state:alpha")!;
  return { ...world, states: new Map(world.states).set(state.stateId, {
    ...state, treasury: new Map(state.treasury).set(currency, state.treasury.get(currency)! + delta),
  }) };
}
function exchange(world: WorldState, tick: number, direction: "BASE_TO_QUOTE" | "QUOTE_TO_BASE", desired = 2,
  prior: readonly EconomicTransaction[] = [], suffix = "a") {
  const { pool } = resolveCanonicalFxPool(world, PAIR);
  const alpha = [...world.states.values()].find(s => s.seed.key === "state:alpha")!;
  const beta = [...world.states.values()].find(s => s.seed.key === "state:beta")!;
  const payer: ActorRef = { type: "STATE", stateId: direction === "BASE_TO_QUOTE" ? alpha.stateId : beta.stateId };
  const recipient: ActorRef = { type: "STATE", stateId: direction === "BASE_TO_QUOTE" ? beta.stateId : alpha.stateId };
  const input = direction === "BASE_TO_QUOTE" ? pool.baseCurrencyId : pool.quoteCurrencyId;
  const output = direction === "BASE_TO_QUOTE" ? pool.quoteCurrencyId : pool.baseCurrencyId;
  const reservation: FxReservation = {
    tick, requestId: `reserve:${tick}:${suffix}`, payerKey: actorRefKey(payer),
    quote: quoteFx(world, PAIR, input, output, desired, { maxInputAmount: 10_000 }),
  };
  const settled = settleFx(world, {
    settlementId: createFxSettlementId(`fxs:close:${tick}:${suffix}`), payer, recipient, pairId: PAIR,
    inputCurrencyId: input, outputCurrencyId: output, desiredOutputAmount: desired,
    maxInputAmount: 10_000, purpose: "TRADE_GOODS",
    originatingBundleId: createTransactionBundleId(`tb:close:${tick}:${suffix}`),
  }, { tick, reservation, priorTransactions: prior, recipientAcceptsOutputCurrency: true });
  return { world: settled?.world ?? world, transactions: settled?.transactions ?? prior, reservation, settled };
}
function context(tick: number, transactions: readonly EconomicTransaction[] = [], reservations: readonly FxReservation[] = []): TickContext {
  return { ...initializeTickContext(tick, 47), phase: 11, transactions, phase7FxReservations: reservations };
}
function shuffle(world: WorldState): WorldState {
  const reverse = <K, V>(map: ReadonlyMap<K, V>) => new Map([...map].reverse());
  return { ...world, states: reverse(world.states), clans: reverse(world.clans), cohorts: reverse(world.cohorts),
    productionUnits: reverse(world.productionUnits), currencies: reverse(world.currencies),
    monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(([id, authority]) => [id, {
      ...authority, fxPools: new Map([...authority.fxPools].reverse().map(([key, p]) => [key, { ...p, cash: reverse(p.cash) }])),
    }])),
  };
}

describe("M5 #675 / M5-FX-CLOSE-001 real FX monetary close", () => {
  it.each(["BASE_TO_QUOTE", "QUOTE_TO_BASE"] as const)("reconciles %s and changes only the successor quote", direction => {
    const world = fixture();
    const opening = captureFxCloseOpening(world, 7);
    const paid = exchange(world, 7, direction);
    expect(paid.settled).not.toBeNull();
    const ctx = context(7, paid.transactions, [paid.reservation]);
    const close = reconcileAndPlanFxClose(opening, paid.world, ctx, POLICY);
    const result = close.pools[0]!;
    expect(result.settlements).toBe(1);
    expect(result.netFlowPressure).toBe(direction === "QUOTE_TO_BASE" ? 1 : -1);
    expect(Math.sign(result.logMove)).toBe(direction === "QUOTE_TO_BASE" ? 1 : -1);
    expect(Math.abs(result.logMove)).toBeLessThanOrEqual(POLICY.maxAbsoluteLogMovePerTick);
    expect(resolveCanonicalFxPool(paid.world, PAIR).pool.spotRateQuotePerBase).toBe(1);
    const next = publishFxClose(opening, paid.world, { ...ctx, phase: 15 }, close);
    const before = resolveCanonicalFxPool(paid.world, PAIR).pool;
    const after = resolveCanonicalFxPool(next, PAIR).pool;
    expect(after.cash).toBe(before.cash);
    expect(after.spotRateQuotePerBase).toBe(result.nextSpot);
    expect(next.states).toBe(paid.world.states);
    expect(next.productionUnits).toBe(paid.world.productionUnits);
    expect(next.seed).toBe(world.seed);
    expect(close.activateTick).toBe(8);
    expect(resolveCanonicalFxPool(world, PAIR).pool.cash.get(before.baseCurrencyId)).toBe(10_000);
  });

  it("freezes quote and carried EMA with no actual exchange, including unfilled demand", () => {
    const world = changePool(fixture(), p => ({ ...p, flowPressureEma: 0.8,
      cash: new Map(p.cash).set(p.baseCurrencyId, p.minOperationalReserveBase) }));
    const paid = exchange(world, 3, "QUOTE_TO_BASE", 100);
    expect(paid.settled).toBeNull();
    const close = reconcileAndPlanFxClose(captureFxCloseOpening(world, 3), paid.world,
      context(3, paid.transactions, [paid.reservation]), POLICY);
    expect(close.pools[0]).toMatchObject({ nextSpot: 1, nextFlowPressureEma: 0.8,
      desiredDemandForBase: 100, filledDemandForBase: 0, settlements: 0, logMove: 0 });
  });

  it("separates desired flow from a real reserve-limited fill", () => {
    const world = changePool(fixture(), p => ({ ...p, cash: new Map(p.cash).set(p.baseCurrencyId, 3) }));
    const paid = exchange(world, 3, "QUOTE_TO_BASE", 100);
    expect(paid.settled?.receipt.outputAmount).toBe(2);
    const result = reconcileAndPlanFxClose(captureFxCloseOpening(world, 3), paid.world,
      context(3, paid.transactions, [paid.reservation]), POLICY).pools[0]!;
    expect(result.desiredDemandForBase).toBe(100);
    expect(result.filledDemandForBase).toBe(2);
    expect(result.baseReserve).toBe(1);
    expect(result.nextSpot).toBeGreaterThan(1);
  });

  it("keeps an informative balanced zero-spread exchange neutral", () => {
    const world = changePool(fixture(), p => ({ ...p, transactionSpread: 0 }));
    const a = exchange(world, 2, "BASE_TO_QUOTE", 2);
    const b = exchange(a.world, 2, "QUOTE_TO_BASE", 2, a.transactions, "b");
    const result = reconcileAndPlanFxClose(captureFxCloseOpening(world, 2), b.world,
      context(2, b.transactions, [a.reservation, b.reservation]), POLICY).pools[0]!;
    expect(result).toMatchObject({ netFlowPressure: 0, reserveImbalance: 0, nextFlowPressureEma: 0, logMove: 0, nextSpot: 1 });
  });

  it("obeys the tighter of explicit global and pool log-step caps", () => {
    const world = changePool(fixture(), p => ({ ...p, maxRateMovePerTick: 0.001 }));
    const paid = exchange(world, 1, "QUOTE_TO_BASE");
    const result = reconcileAndPlanFxClose(captureFxCloseOpening(world, 1), paid.world,
      context(1, paid.transactions, [paid.reservation]), { ...POLICY, flowCoefficient: 10 }).pools[0]!;
    expect(result.logMove).toBe(0.001);
    expect(result.nextSpot).toBe(Math.exp(0.001));
  });

  it.each(["missing-output", "duplicate", "wrong-pool", "wrong-currency", "late", "wrong-amount", "missing-reservation"])(
    "refuses %s evidence without mutating the settled world", corruption => {
      const world = fixture(), paid = exchange(world, 4, "QUOTE_TO_BASE");
      const before = captureFxCloseOpening(paid.world, 4);
      let transactions = [...paid.transactions];
      let reservations = [paid.reservation];
      const output = transactions[1]! as FxLedgerLeg;
      if (corruption === "missing-output") transactions = transactions.slice(0, 1);
      if (corruption === "duplicate") transactions.push(transactions[0]!);
      if (corruption === "wrong-pool") transactions[1] = { ...output,
        fromAccount: { type: "FX_POOL", owningAuthorityId: resolveCanonicalFxPool(world, PAIR).owningAuthorityId, pairId: "missing" },
      } as FxLedgerLeg;
      if (corruption === "wrong-currency") transactions[1] = { ...output, currencyId: transactions[0]!.currencyId } as FxLedgerLeg;
      if (corruption === "late") transactions[1] = { ...output, phase: 12 };
      if (corruption === "wrong-amount") transactions[1] = { ...output, moneyAmount: output.moneyAmount + 1 };
      if (corruption === "missing-reservation") reservations = [];
      expect(() => reconcileAndPlanFxClose(captureFxCloseOpening(world, 4), paid.world,
        context(4, transactions, reservations), POLICY)).toThrow(/M5 FX close/);
      expect(captureFxCloseOpening(paid.world, 4)).toEqual(before);
    },
  );

  it("detects both money creation and a globally balanced unjournaled pool transfer", () => {
    const world = fixture(), opening = captureFxCloseOpening(world, 0);
    const { pool } = resolveCanonicalFxPool(world, PAIR);
    expect(() => reconcileAndPlanFxClose(opening, changeStateCash(world, pool.baseCurrencyId, 1),
      context(0), POLICY)).toThrow(/conservation/);
    const moved = changeStateCash(changePool(world, p => ({ ...p,
      cash: new Map(p.cash).set(p.baseCurrencyId, 10_001),
    })), pool.baseCurrencyId, -1);
    expect(() => reconcileAndPlanFxClose(opening, moved, context(0), POLICY)).toThrow(/pool cash/);
  });

  it("refuses stale ticks, current-quote edits and post-close cash or journal changes", () => {
    const world = fixture(), opening = captureFxCloseOpening(world, 5);
    const paid = exchange(world, 5, "BASE_TO_QUOTE");
    const ctx = context(5, paid.transactions, [paid.reservation]);
    expect(() => reconcileAndPlanFxClose(opening, paid.world, { ...ctx, tick: 6 }, POLICY)).toThrow(/Phase 11/);
    expect(() => reconcileAndPlanFxClose(opening,
      changePool(paid.world, p => ({ ...p, spotRateQuotePerBase: 2 })), ctx, POLICY)).toThrow(/opening quote/);
    const close = reconcileAndPlanFxClose(opening, paid.world, ctx, POLICY);
    expect(() => publishFxClose(opening, paid.world, ctx, close)).toThrow(/activation/);
    const currency = resolveCanonicalFxPool(world, PAIR).pool.baseCurrencyId;
    expect(() => publishFxClose(opening, changeStateCash(paid.world, currency, 1), { ...ctx, phase: 15 }, close)).toThrow(/conservation/);
    expect(() => publishFxClose(opening, paid.world, { ...ctx, phase: 15, transactions: [] }, close)).toThrow(/journal changed/);
  });

  it.each([-0.1, 1.1, NaN, Infinity])("refuses invalid EMA alpha %s", alpha => {
    const world = fixture();
    expect(() => reconcileAndPlanFxClose(captureFxCloseOpening(world, 0), world,
      context(0), { ...POLICY, flowPressureAlpha: alpha })).toThrow(/flow alpha/);
  });

  it("rejects duplicate currency-pair authority rather than choosing a reverse pool", () => {
    const world = fixture();
    const duplicate = changePool(world, p => p);
    const { pool, owningAuthorityId } = resolveCanonicalFxPool(duplicate, PAIR);
    const authority = duplicate.monetaryAuthorities.get(owningAuthorityId)!;
    const invalid = { ...duplicate, monetaryAuthorities: new Map(duplicate.monetaryAuthorities).set(owningAuthorityId, {
      ...authority, fxPools: new Map(authority.fxPools).set("duplicate-pair", { ...pool, pairId: "duplicate-pair" }),
    }) };
    expect(() => captureFxCloseOpening(invalid, 0)).toThrow(/duplicate.*pair/);
  });

  it("produces identical closes with reversed journal, reservation and registry insertion order", () => {
    const world = fixture(), a = exchange(world, 8, "BASE_TO_QUOTE");
    const b = exchange(a.world, 8, "QUOTE_TO_BASE", 1, a.transactions, "b");
    const original = reconcileAndPlanFxClose(captureFxCloseOpening(world, 8), b.world,
      context(8, b.transactions, [a.reservation, b.reservation]), POLICY);
    const reversed = reconcileAndPlanFxClose(captureFxCloseOpening(shuffle(world), 8), shuffle(b.world),
      context(8, [...b.transactions].reverse(), [b.reservation, a.reservation]), POLICY);
    expect(reversed).toEqual(original);
  });

  it("replays 600 successive real settlements and N+1 quotes without changing currency totals", () => {
    const run = (reversed: boolean) => {
      let world = reversed ? shuffle(fixture()) : fixture();
      const genesisMoney = captureFxCloseOpening(world, 0).money;
      const sequence: unknown[] = [];
      for (let tick = 0; tick < 600; tick += 1) {
        const opening = captureFxCloseOpening(world, tick);
        const direction = Math.floor(tick / 10) % 2 === 0 ? "QUOTE_TO_BASE" : "BASE_TO_QUOTE";
        const paid = exchange(world, tick, direction);
        expect(paid.settled, `real settlement at tick ${tick}`).not.toBeNull();
        expect(paid.settled!.receipt.spotRate).toBe(resolveCanonicalFxPool(world, PAIR).pool.spotRateQuotePerBase);
        const ctx = context(tick, paid.transactions, [paid.reservation]);
        const close = reconcileAndPlanFxClose(opening, paid.world, ctx, POLICY);
        world = publishFxClose(opening, paid.world, { ...ctx, phase: 15 }, close);
        expect(resolveCanonicalFxPool(world, PAIR).pool.cash).toBe(resolveCanonicalFxPool(paid.world, PAIR).pool.cash);
        expect(Math.abs(close.pools[0]!.logMove)).toBeLessThanOrEqual(0.03);
        sequence.push([close, [...captureFxCloseOpening(world, tick).money].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
      }
      const finalMoney = captureFxCloseOpening(world, 600).money;
      // Exact diagnostic units, compared against the canonical fixed epsilon, not a relative tolerance.
      const epsilon = captureFxCloseOpening(changeStateCash(world,
        resolveCanonicalFxPool(world, PAIR).pool.baseCurrencyId, 0), 600).moneyEpsilon;
      expect(epsilon).toBe(1e-9);
      for (const [currency, before] of genesisMoney) {
        const drift = finalMoney.get(currency)! - before;
        // 2^-1074 units: 2^-30 < 1e-9, a conservative lifetime assertion for this fixture.
        expect(drift < (1n << 1044n) && drift > -(1n << 1044n), `600-tick drift ${currency}`).toBe(true);
      }
      return sequence;
    };
    expect(run(true)).toEqual(run(false));
  });
});
