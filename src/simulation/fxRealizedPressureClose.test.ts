import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { fxPayerCurrencyKey, reserveFxForPool } from "./fxQuoteReservation";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { settleFx } from "./fxSettlement";
import { captureFxCloseOpening, reconcileAndPlanFxClose, publishFxClose } from "./fxMonetaryClose";
import {
  createFxSettlementId, createTransactionBundleId, initializeTickContext,
} from "./tickOrchestrator";
import { buildInitialWorld, type WorldState } from "./worldState";

const PAIR = "fxpool:currency:alpha-currency:beta";
const TICK = 7;

describe("M5 #1194: realized FX pressure is not a reservation promise", () => {
  it("closes mixed-direction partial redemptions and one unused request at the opening spread", () => {
    const genesis = buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
    );
    const alpha = [...genesis.states.values()].find(s => s.seed.key === "state:alpha")!;
    const beta = [...genesis.states.values()].find(s => s.seed.key === "state:beta")!;
    const a: ActorRef = { type: "STATE", stateId: alpha.stateId };
    const b: ActorRef = { type: "STATE", stateId: beta.stateId };
    const { pool } = resolveCanonicalFxPool(genesis, PAIR);
    const base = pool.baseCurrencyId, quote = pool.quoteCurrencyId;
    // Explicit single-pair test opening stocks. No change to genesis defaults.
    const world: WorldState = {
      ...genesis,
      states: new Map(genesis.states)
        .set(alpha.stateId, { ...alpha, treasury: new Map([[base, 100], [quote, 100]]) })
        .set(beta.stateId, { ...beta, treasury: new Map([[base, 100], [quote, 100]]) }),
      monetaryAuthorities: new Map([...genesis.monetaryAuthorities].map(([id, authority]) => [
        id, { ...authority, fxPools: new Map([...authority.fxPools]
          .filter(([key]) => key === PAIR).map(([key, p]) => [key, {
            ...p, spotRateQuotePerBase: 4, transactionSpread: 0.5,
            minOperationalReserveBase: 8, minOperationalReserveQuote: 9,
            targetBaseReserveShare: 0.5, flowPressureEma: 0, maxRateMovePerTick: 0.05,
            cash: new Map([[base, 14], [quote, 25]]),
          }])) },
      ])),
    };
    const before = structuredClone(world);
    const opening = captureFxCloseOpening(world, TICK);
    const ka = actorRefKey(a), kb = actorRefKey(b);
    const reservations = reserveFxForPool(resolveCanonicalFxPool(world, PAIR).pool, [
      { requestId: "reverse", payerKey: ka, priority: 3, fromCurrencyId: quote,
        toCurrencyId: base, desiredOutputAmount: 8, maxInputAmount: 100 },
      { requestId: "forward", payerKey: kb, priority: 2, fromCurrencyId: base,
        toCurrencyId: quote, desiredOutputAmount: 12, maxInputAmount: 100 },
      { requestId: "unused", payerKey: ka, priority: 1, fromCurrencyId: quote,
        toCurrencyId: base, desiredOutputAmount: 4, maxInputAmount: 100 },
    ], new Map([[fxPayerCurrencyKey(ka, quote), 100],
      [fxPayerCurrencyKey(kb, base), 100]]), TICK);
    expect(reservations.pressure).toEqual({
      desiredDemandForBase: 12, desiredSupplyOfBase: 6,
      filledDemandForBase: 6, filledSupplyOfBase: 6,
    });
    const [reverse, forward, unused] = reservations.reservations;
    expect([reverse!.requestId, forward!.requestId, unused!.requestId])
      .toEqual(["reverse", "forward", "unused"]);
    expect([reverse!.quote.feasibleOutputAmount, forward!.quote.feasibleOutputAmount,
      unused!.quote.feasibleOutputAmount]).toEqual([6, 12, 0]);

    const first = settleFx(world, {
      settlementId: createFxSettlementId("fxs:pressure:reverse"), payer: a, recipient: b,
      pairId: PAIR, inputCurrencyId: quote, outputCurrencyId: base,
      desiredOutputAmount: 2, maxInputAmount: 100, purpose: "TRADE_GOODS",
      originatingBundleId: createTransactionBundleId("tb:pressure:reverse"),
    }, { tick: TICK, reservation: reverse!, priorTransactions: [],
      recipientAcceptsOutputCurrency: true });
    expect(first).not.toBeNull();
    expect(first!.receipt.outputAmount).toBe(2);
    const second = settleFx(first!.world, {
      settlementId: createFxSettlementId("fxs:pressure:forward"), payer: b, recipient: a,
      pairId: PAIR, inputCurrencyId: base, outputCurrencyId: quote,
      desiredOutputAmount: 6, maxInputAmount: 100, purpose: "TRADE_GOODS",
      originatingBundleId: createTransactionBundleId("tb:pressure:forward"),
    }, { tick: TICK, reservation: forward!, priorTransactions: first!.transactions,
      recipientAcceptsOutputCurrency: true });
    expect(second).not.toBeNull();
    expect(second!.receipt.outputAmount).toBe(6);
    const paid = second!.world;
    const journal = second!.transactions;
    expect(journal.map(tx => [tx.type, tx.currencyId, tx.moneyAmount])).toEqual([
      ["FX_INPUT", quote, 12], ["FX_OUTPUT", base, 2],
      ["FX_INPUT", base, 3], ["FX_OUTPUT", quote, 6],
    ]);
    expect(paid.states.get(alpha.stateId)!.treasury).toEqual(new Map([[base, 100], [quote, 94]]));
    expect(paid.states.get(beta.stateId)!.treasury).toEqual(new Map([[base, 99], [quote, 100]]));
    const live = resolveCanonicalFxPool(paid, PAIR).pool;
    expect(live.cash).toEqual(new Map([[base, 15], [quote, 31]]));
    expect(captureFxCloseOpening(paid, TICK).money).toEqual(opening.money);

    const ctx = { ...initializeTickContext(TICK, 47), phase: 11 as const,
      transactions: journal, phase7FxReservations: reservations.reservations };
    // Isolate the realized-flow signal: desired pressure is positive, reserved
    // pressure is zero, and the actual journal must drive a negative move.
    const policy = { flowPressureAlpha: 0.25, flowCoefficient: 0.08,
      reserveCoefficient: 0, maxAbsoluteLogMovePerTick: 0.03 };
    const paidBefore = structuredClone(paid);
    const close = reconcileAndPlanFxClose(opening, paid, ctx, policy);
    const result = close.pools[0]!;
    expect(result).toMatchObject({
      pairId: PAIR, desiredDemandForBase: 12, desiredSupplyOfBase: 6,
      filledDemandForBase: 2, filledSupplyOfBase: 3, settlements: 2,
      baseReserve: 15, quoteReserve: 31, currentSpot: 4,
    });
    expect(result.netFlowPressure).toBeCloseTo(-0.2, 12);
    expect(result.nextFlowPressureEma).toBeCloseTo(-0.05, 12);
    expect(result.logMove).toBeCloseTo(-0.004, 12);
    expect(result.nextSpot).toBeCloseTo(4 * Math.exp(-0.004), 12);
    expect(close.activateTick).toBe(TICK + 1);
    expect(reconcileAndPlanFxClose(opening, paid, {
      ...ctx, transactions: [...journal].reverse(),
      phase7FxReservations: [...reservations.reservations].reverse(),
    }, policy)).toEqual(close);
    expect(() => reconcileAndPlanFxClose(opening, paid, {
      ...ctx, transactions: journal.slice(0, 2),
    }, policy)).toThrow(/M5 FX close/);
    expect(paid).toEqual(paidBefore);
    expect(live.spotRateQuotePerBase).toBe(4);
    const next = publishFxClose(opening, paid, { ...ctx, phase: 15 }, close);
    const successor = resolveCanonicalFxPool(next, PAIR).pool;
    expect(successor.spotRateQuotePerBase).toBe(result.nextSpot);
    expect(successor.cash).toBe(live.cash);
    expect(next.states).toBe(paid.states);
    expect(captureFxCloseOpening(next, TICK + 1).money).toEqual(opening.money);
    expect(world).toEqual(before);
  });
});
