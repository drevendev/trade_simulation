import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ActorRef } from "../domain/genesisLedger";
import { actorRefKey } from "../domain/genesisLedger";
import {
  createFxSettlementId,
  createTransactionBundleId,
} from "./tickOrchestrator";
import { quoteFx } from "./fxWorldPoolAuthority";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import {
  settleFx,
  type FxSettlementContext,
  type FxSettlementRequest,
} from "./fxSettlement";
import { readActorWallet } from "./marketSettlementTransition";
import { buildInitialWorld, type WorldState } from "./worldState";

const PAIR = "fxpool:currency:alpha-currency:beta";

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const alpha = [...world.states.values()].find((state) => state.seed.key === "state:alpha")!;
  const beta = [...world.states.values()].find((state) => state.seed.key === "state:beta")!;
  const payer: ActorRef = { type: "STATE", stateId: alpha.stateId };
  const recipient: ActorRef = { type: "STATE", stateId: beta.stateId };
  const { pool } = resolveCanonicalFxPool(world, PAIR);
  const request: FxSettlementRequest = {
    settlementId: createFxSettlementId("fxs:fixture-1"),
    payer, recipient,
    pairId: PAIR,
    inputCurrencyId: pool.baseCurrencyId,
    outputCurrencyId: pool.quoteCurrencyId,
    desiredOutputAmount: 10,
    maxInputAmount: 100,
    purpose: "TRADE_GOODS",
    originatingBundleId: createTransactionBundleId("tb:fixture-1"),
  };
  return { world, payer, recipient, pool, request };
}

function context(world: WorldState, request: FxSettlementRequest, reservedDesired = 10):
  FxSettlementContext {
  return {
    tick: 7,
    recipientAcceptsOutputCurrency: true,
    priorTransactions: [],
    reservation: {
      requestId: "fx-request-1",
      payerKey: actorRefKey(request.payer),
      quote: quoteFx(
        world, request.pairId, request.inputCurrencyId,
        request.outputCurrencyId, reservedDesired,
        { maxInputAmount: request.maxInputAmount },
      ),
    },
  };
}

function poolCash(world: WorldState, request: FxSettlementRequest, currencyId: string): number {
  const { pool } = resolveCanonicalFxPool(world, request.pairId);
  return pool.cash.get(currencyId as typeof pool.baseCurrencyId)!;
}

function withPoolCash(
  world: WorldState,
  request: FxSettlementRequest,
  currencyId: string,
  amount: number,
): WorldState {
  const { pool, owningAuthorityId } = resolveCanonicalFxPool(world, request.pairId);
  const authority = world.monetaryAuthorities.get(owningAuthorityId)!;
  const nextAuthorities = new Map(world.monetaryAuthorities);
  nextAuthorities.set(owningAuthorityId, {
    ...authority,
    fxPools: new Map(authority.fxPools).set(request.pairId, {
      ...pool,
      cash: new Map(pool.cash).set(currencyId as typeof pool.baseCurrencyId, amount),
    }),
  });
  return { ...world, monetaryAuthorities: nextAuthorities };
}

function withPayerCash(
  world: WorldState, request: FxSettlementRequest, amount: number,
): WorldState {
  if (request.payer.type !== "STATE") throw new Error("test requires State payer");
  const state = world.states.get(request.payer.stateId)!;
  return {
    ...world,
    states: new Map(world.states).set(state.stateId, {
      ...state,
      treasury: new Map(state.treasury).set(request.inputCurrencyId, amount),
    }),
  };
}

describe("M5 #672 atomic settleFx / Handoff-04 §§19–21", () => {
  it("posts only two linked FX legs and conserves each currency across actor and live pool", () => {
    const { world, payer, recipient, pool, request } = fixture();
    const beforeIn = readActorWallet(world, payer).get(request.inputCurrencyId)!;
    const beforeOut = readActorWallet(world, recipient).get(request.outputCurrencyId)!;
    const result = settleFx(world, request, context(world, request))!;
    expect(result).not.toBeNull();
    expect(result.receipt.outputAmount).toBe(10);
    expect(result.receipt.inputAmount).toBeGreaterThan(10);
    expect(result.receipt.spread).toBe(pool.transactionSpread);
    expect(result.ledgerLegs.map((x) => x.type)).toEqual(["FX_INPUT", "FX_OUTPUT"]);
    expect(result.ledgerLegs.map((x) => x.currencyId)).toEqual([
      request.inputCurrencyId, request.outputCurrencyId,
    ]);
    expect(result.ledgerLegs.every((x) =>
      x.fxSettlementId === request.settlementId &&
      x.bundleId === request.originatingBundleId)).toBe(true);
    expect(result.ledgerLegs[0].toAccount.type).toBe("FX_POOL");
    expect(result.ledgerLegs[1].fromAccount.type).toBe("FX_POOL");
    expect(result.transactions).toEqual(result.ledgerLegs);

    const paid = beforeIn - readActorWallet(result.world, payer).get(request.inputCurrencyId)!;
    const creditedPool = poolCash(result.world, request, request.inputCurrencyId) -
      poolCash(world, request, request.inputCurrencyId);
    const removedPool = poolCash(world, request, request.outputCurrencyId) -
      poolCash(result.world, request, request.outputCurrencyId);
    const received = readActorWallet(result.world, recipient).get(request.outputCurrencyId)! - beforeOut;
    expect(paid).toBeCloseTo(result.receipt.inputAmount, 9);
    expect(creditedPool).toBeCloseTo(paid, 9);
    expect(removedPool).toBeCloseTo(result.receipt.outputAmount, 9);
    expect(received).toBeCloseTo(removedPool, 9);
    expect(poolCash(result.world, request, request.outputCurrencyId)).toBeGreaterThanOrEqual(
      pool.minOperationalReserveQuote,
    );
    // No in-place changes, and the pool rate never changes during settlement.
    expect(readActorWallet(world, payer).get(request.inputCurrencyId)).toBe(beforeIn);
    expect(resolveCanonicalFxPool(world, PAIR).pool).toBe(pool);
    expect(resolveCanonicalFxPool(result.world, PAIR).pool.spotRateQuotePerBase)
      .toBe(pool.spotRateQuotePerBase);
  });

  it("supports reverse pair direction with the same actual pool and a positive spread", () => {
    const { world, payer, recipient, pool, request } = fixture();
    const reversed: FxSettlementRequest = {
      ...request,
      settlementId: createFxSettlementId("fxs:reverse"),
      payer: recipient, recipient: payer,
      inputCurrencyId: pool.quoteCurrencyId,
      outputCurrencyId: pool.baseCurrencyId,
    };
    const result = settleFx(world, reversed, context(world, reversed))!;
    expect(result.receipt.outputAmount).toBe(10);
    expect(result.receipt.inputAmount).toBeCloseTo(10 * (1 + pool.transactionSpread), 9);
    expect(poolCash(result.world, reversed, reversed.inputCurrencyId)).toBeGreaterThan(
      poolCash(world, reversed, reversed.inputCurrencyId),
    );
  });

  it("may underfill but never exceed the Phase-7 reservation or the payer's cash", () => {
    const { world, request } = fixture();
    const limited = settleFx(world, request, context(world, request, 2))!;
    expect(limited.receipt.outputAmount).toBe(2);
    expect(limited.receipt.fillRatio).toBeCloseTo(0.2, 12);

    const poorWorld = withPayerCash(world, request, 1);
    const poor = settleFx(poorWorld, request, context(world, request))!;
    expect(poor.receipt.outputAmount).toBeGreaterThan(0);
    expect(poor.receipt.outputAmount).toBeLessThan(10);
    expect(readActorWallet(poor.world, request.payer).get(request.inputCurrencyId))
      .toBeGreaterThanOrEqual(0);
  });

  it("returns no commit on a genuinely exhausted output pool", () => {
    const { world, pool, request } = fixture();
    const exhausted = withPoolCash(
      world, request, request.outputCurrencyId, pool.minOperationalReserveQuote,
    );
    const before = resolveCanonicalFxPool(exhausted, request.pairId).pool;
    expect(settleFx(exhausted, request, context(exhausted, request))).toBeNull();
    expect(resolveCanonicalFxPool(exhausted, request.pairId).pool).toBe(before);
  });

  it("refuses invalid direction, recipient contract and missing/wrong reservation without mutation", () => {
    const { world, request, pool } = fixture();
    const ctx = context(world, request);
    expect(() => settleFx(world, { ...request, outputCurrencyId: request.inputCurrencyId }, ctx))
      .toThrow(/same-currency/);
    expect(() => settleFx(world, request, {
      ...ctx, recipientAcceptsOutputCurrency: false,
    })).toThrow(/recipient does not accept/);
    expect(() => settleFx(world, request, {
      ...ctx, reservation: { ...ctx.reservation, payerKey: "STATE:not-the-payer" },
    })).toThrow(/reservation/);
    expect(() => settleFx(world, { ...request, desiredOutputAmount: Number.NaN }, ctx))
      .toThrow(/desiredOutputAmount/);
    expect(resolveCanonicalFxPool(world, PAIR).pool).toBe(pool);
    expect(ctx.priorTransactions).toEqual([]);
  });

  it("refuses a duplicate settlement ID before any pool or wallet change", () => {
    const { world, request } = fixture();
    const first = settleFx(world, request, context(world, request))!;
    expect(() => settleFx(first.world, request, {
      ...context(first.world, request), priorTransactions: first.transactions,
    })).toThrow(/duplicate settlement/);
    expect(first.transactions.length).toBe(2);
  });

  it("rejects two distinct settlement IDs redeeming one same-tick reservation", () => {
    const { world, request } = fixture();
    const ctx = context(world, request);
    const first = settleFx(world, request, ctx)!;
    expect(first.receipt.outputAmount).toBe(10);
    expect(first.ledgerLegs.map((leg) => leg.fxReservationRequestId)).toEqual([
      ctx.reservation.requestId, ctx.reservation.requestId,
    ]);

    // The first conversion is already committed: replay must be rejected
    // even though cash and pool stock could fund a second identical exchange.
    const secondRequest: FxSettlementRequest = {
      ...request, settlementId: createFxSettlementId("fxs:fixture-2"),
    };
    const committedPool = resolveCanonicalFxPool(first.world, request.pairId).pool;
    const committedPayer = readActorWallet(first.world, request.payer)
      .get(request.inputCurrencyId);
    expect(() => settleFx(first.world, secondRequest, {
      ...ctx, priorTransactions: first.transactions,
    })).toThrow(/reservation already redeemed/);
    expect(resolveCanonicalFxPool(first.world, request.pairId).pool).toBe(committedPool);
    expect(readActorWallet(first.world, request.payer).get(request.inputCurrencyId))
      .toBe(committedPayer);
    expect(first.transactions).toHaveLength(2);
  });

  it("rejects a reservation already evidenced by just one FX ledger leg", () => {
    const { world, request } = fixture();
    const ctx = context(world, request);
    const first = settleFx(world, request, ctx)!;
    const distinct = { ...request, settlementId: createFxSettlementId("fxs:fixture-3") };
    expect(() => settleFx(first.world, distinct, {
      ...ctx, priorTransactions: [first.ledgerLegs[1]],
    })).toThrow(/reservation already redeemed/);
  });

  it("rejects large-stock rounded-up pool credits instead of silently minting money", () => {
    const { world, request } = fixture();
    const huge = withPoolCash(world, request, request.inputCurrencyId, 1e16);
    const snapshot = resolveCanonicalFxPool(huge, PAIR).pool;
    expect(() => settleFx(huge, {
      ...request, desiredOutputAmount: 3,
    }, context(huge, { ...request, desiredOutputAmount: 3 }, 3)))
      .toThrow(/money precision|non-conserving/);
    expect(resolveCanonicalFxPool(huge, PAIR).pool).toBe(snapshot);
  });

  it("replays exactly despite reversed map insertion order", () => {
    const { world, request } = fixture();
    const reverse = {
      ...world,
      states: new Map([...world.states].reverse()),
      monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(([id, a]) =>
        [id, { ...a, fxPools: new Map([...a.fxPools].reverse()) }] as const)),
    };
    const a = settleFx(world, request, context(world, request))!;
    const b = settleFx(reverse, request, context(reverse, request))!;
    expect(b.receipt).toEqual(a.receipt);
    expect(b.ledgerLegs).toEqual(a.ledgerLegs);
    expect(poolCash(b.world, request, request.inputCurrencyId))
      .toBe(poolCash(a.world, request, request.inputCurrencyId));
    expect(readActorWallet(b.world, request.recipient))
      .toEqual(readActorWallet(a.world, request.recipient));
  });
});
