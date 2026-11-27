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
import type { Phase7DesiredFxFlow } from "./phase7AutoFxReservations";
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

  it.each(["BASE_TO_QUOTE", "QUOTE_TO_BASE"] as const)(
    "validates each unredeemed %s desired quote before aggregation", direction => {
      const world = changePool(fixture(), p => ({ ...p, spotRateQuotePerBase: 4, transactionSpread: 0.5 }));
      const opening = captureFxCloseOpening(world, 3);
      const { pool } = resolveCanonicalFxPool(world, PAIR);
      const fromBase = direction === "BASE_TO_QUOTE";
      const payer = [...world.states.values()].find(s => s.seed.key === "state:alpha")!;
      const payerKey = actorRefKey({ type: "STATE", stateId: payer.stateId });
      const makeReservation = (suffix: string, desiredOutput: number): FxReservation => ({
        tick: 3, requestId: "reserve:3:" + suffix, payerKey,
        quote: quoteFx(world, PAIR,
          fromBase ? pool.baseCurrencyId : pool.quoteCurrencyId,
          fromBase ? pool.quoteCurrencyId : pool.baseCurrencyId,
          desiredOutput, { maxInputAmount: 0 }),
      });
      const a = makeReservation("a", 12), b = makeReservation("b", 4);
      const close = reconcileAndPlanFxClose(opening, world, context(3, [], [a, b]), POLICY);
      expect(close.pools[0]).toMatchObject({
        desiredDemandForBase: fromBase ? 0 : 16,
        desiredSupplyOfBase: fromBase ? 8 : 0,
        filledDemandForBase: 0, filledSupplyOfBase: 0, settlements: 0,
        logMove: 0, nextSpot: 4,
      });
      expect(reconcileAndPlanFxClose(opening, world, context(3, [], [b, a]), POLICY)).toEqual(close);
      // The first valid request is large enough to mask a negative second
      // request if only the aggregate is validated. The other forged quote
      // preserves the spot and spread but changes the desired input amount.
      for (const quote of [
        { ...b.quote, desiredOutputAmount: -4, requiredInputAmountAtDesiredOutput: -b.quote.requiredInputAmountAtDesiredOutput },
        { ...b.quote, requiredInputAmountAtDesiredOutput: b.quote.requiredInputAmountAtDesiredOutput + 1 },
      ]) {
        expect(() => reconcileAndPlanFxClose(opening, world,
          context(3, [], [a, { ...b, quote }]), POLICY)).toThrow(/M5 FX close/);
      }
      expect(captureFxCloseOpening(world, 3)).toEqual(opening);
    },
  );

  it("replaces rather than adds original desired flows while keeping real paid pressure", () => {
    const world = changePool(fixture(), p => ({ ...p, transactionSpread: 0 }));
    const paid = exchange(world, 7, "QUOTE_TO_BASE", 2);
    expect(paid.settled).not.toBeNull();
    const opening = captureFxCloseOpening(world, 7);
    const ctx = context(7, paid.transactions, [paid.reservation]);
    const ordinary = reconcileAndPlanFxClose(opening, paid.world, ctx, POLICY);
    const original = new Map<number, Phase7DesiredFxFlow>([
      [0, { tick: 7, pairId: PAIR, direction: "QUOTE_TO_BASE",
        desiredOutputAmount: 12, requiredInputAmountAtDesiredOutput: 12 }],
      [2, { tick: 7, pairId: PAIR, direction: "BASE_TO_QUOTE",
        desiredOutputAmount: 6, requiredInputAmountAtDesiredOutput: 6 }],
    ]);
    const withOriginal = { ...ctx, phase7DesiredFxFlowByLotOrdinal: original };
    const close = reconcileAndPlanFxClose(opening, paid.world, withOriginal, POLICY);
    expect(close).toEqual({ ...ordinary, pools: [{
      ...ordinary.pools[0]!, desiredDemandForBase: 12, desiredSupplyOfBase: 6,
    }] });
    expect(reconcileAndPlanFxClose(opening, paid.world, {
      ...withOriginal, phase7DesiredFxFlowByLotOrdinal: new Map([...original].reverse()),
    }, POLICY)).toEqual(close);
    // The detached map never substitutes for the actual settlement promise.
    expect(() => reconcileAndPlanFxClose(opening, paid.world, {
      ...withOriginal, phase7FxReservations: [],
    }, POLICY)).toThrow(/matching unspent reservation/);
  });

  it.each(["BASE_TO_QUOTE", "QUOTE_TO_BASE"] as const)(
    "checks exact %s desired coverage despite rounded aggregate cancellation", direction => {
      const tick = 7;
      const world = changePool(fixture(), p => ({ ...p, transactionSpread: 0 }));
      const opening = captureFxCloseOpening(world, tick);
      expect(opening.moneyEpsilon).toBe(1e-9);
      const { pool } = resolveCanonicalFxPool(world, PAIR);
      const fromBase = direction === "BASE_TO_QUOTE";
      const payer = [...world.states.values()].find(s =>
        s.seed.key === (fromBase ? "state:alpha" : "state:beta"))!;
      const payerKey = actorRefKey({ type: "STATE", stateId: payer.stateId });
      const ordinals = [2, 3, 4, 5, 10];
      const reservations: FxReservation[] = ordinals.map(ordinal => ({
        tick, requestId: `fx:req:m5:${tick}:${ordinal}`, payerKey,
        quote: quoteFx(world, PAIR,
          fromBase ? pool.baseCurrencyId : pool.quoteCurrencyId,
          fromBase ? pool.quoteCurrencyId : pool.baseCurrencyId,
          ordinal === 10 ? 1e7 : 5e-10, { maxInputAmount: 0 }),
      }));
      expect(reservations.every(r => r.quote.feasibleOutputAmount === 0)).toBe(true);
      const original = new Map<number, Phase7DesiredFxFlow>(reservations.map((r, i) => [
        ordinals[i]!, {
          tick, pairId: PAIR, direction,
          desiredOutputAmount: r.quote.desiredOutputAmount,
          requiredInputAmountAtDesiredOutput: r.quote.requiredInputAmountAtDesiredOutput,
        },
      ]));
      // Lexical request ordering puts ordinal 10 first, where each small
      // obligation disappears from the rounded total. Together they exceed epsilon.
      expect([1e7, 5e-10, 5e-10, 5e-10, 5e-10].reduce((a, b) => a + b, 0)).toBe(1e7);
      const run = (evidence: ReadonlyMap<number, Phase7DesiredFxFlow>, reverse: boolean) =>
        reconcileAndPlanFxClose(opening, world, {
          ...context(tick, [], reverse ? [...reservations].reverse() : reservations),
          phase7DesiredFxFlowByLotOrdinal: reverse ? new Map([...evidence].reverse()) : evidence,
        }, POLICY);
      const complete = run(original, false);
      expect(complete.pools[0]).toMatchObject({
        settlements: 0, filledDemandForBase: 0, filledSupplyOfBase: 0,
        netFlowPressure: 0, logMove: 0, nextSpot: 1,
      });
      // A deficit smaller than the canonical absolute epsilon is allowed.
      const withinEpsilon = new Map(original);
      withinEpsilon.delete(2);
      const omitted = new Map([[10, original.get(10)!]]);
      for (const reverse of [false, true]) {
        expect(run(original, reverse)).toEqual(complete);
        expect(run(withinEpsilon, reverse).pools[0]!.settlements).toBe(0);
        expect(() => run(omitted, reverse)).toThrow(/does not cover final reservations/);
      }
      expect(captureFxCloseOpening(world, tick)).toEqual(opening);
    },
  );

  it("reports entirely unfunded original flow without changing the current or next quote", () => {
    const world = changePool(fixture(), p => ({ ...p, transactionSpread: 0,
      cash: new Map(p.cash).set(p.baseCurrencyId, p.minOperationalReserveBase) }));
    const opening = captureFxCloseOpening(world, 7);
    const original = new Map([[0, { tick: 7, pairId: PAIR, direction: "QUOTE_TO_BASE" as const,
      desiredOutputAmount: 12, requiredInputAmountAtDesiredOutput: 12 }]]);
    const close = reconcileAndPlanFxClose(opening, world, {
      ...context(7), phase7DesiredFxFlowByLotOrdinal: original,
    }, POLICY);
    expect(close.pools[0]).toMatchObject({ desiredDemandForBase: 12,
      filledDemandForBase: 0, settlements: 0, logMove: 0, nextSpot: 1 });
    expect(captureFxCloseOpening(world, 7)).toEqual(opening);
  });

  it.each(["stale", "unknown-pair", "negative", "forged", "under-covered", "opposite", "ordinal", "empty"])(
    "rejects %s original FX evidence", corruption => {
      const world = changePool(fixture(), p => ({ ...p, transactionSpread: 0 }));
      const paid = exchange(world, 7, "QUOTE_TO_BASE", 2);
      const opening = captureFxCloseOpening(world, 7);
      const before = captureFxCloseOpening(paid.world, 7);
      const q = { tick: 7, pairId: PAIR, direction: "QUOTE_TO_BASE" as "QUOTE_TO_BASE" | "BASE_TO_QUOTE",
        desiredOutputAmount: 12, requiredInputAmountAtDesiredOutput: 12 };
      if (corruption === "stale") q.tick = 6;
      if (corruption === "unknown-pair") q.pairId = "missing";
      if (corruption === "negative") q.desiredOutputAmount = -1;
      if (corruption === "forged") q.requiredInputAmountAtDesiredOutput = 13;
      if (corruption === "under-covered") q.desiredOutputAmount = q.requiredInputAmountAtDesiredOutput = 1;
      if (corruption === "opposite") q.direction = "BASE_TO_QUOTE";
      const original = new Map([[corruption === "ordinal" ? -1 : 0, q]]);
      if (corruption === "empty") original.clear();
      expect(() => reconcileAndPlanFxClose(opening, paid.world, {
        ...context(7, paid.transactions, [paid.reservation]), phase7DesiredFxFlowByLotOrdinal: original,
      }, POLICY)).toThrow(/M5 FX close/);
      expect(captureFxCloseOpening(paid.world, 7)).toEqual(before);
    },
  );

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
