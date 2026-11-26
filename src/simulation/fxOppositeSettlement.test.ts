import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { settleFx, type FxSettlementRequest, type FxSettlementContext } from "./fxSettlement";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { readActorWallet } from "./marketSettlementTransition";
import { createFxSettlementId, createTransactionBundleId } from "./tickOrchestrator";
import { buildInitialWorld, type WorldState } from "./worldState";

const PAIR = "fxpool:currency:alpha-currency:beta";

describe("M5 #1188 / #672 opposite FX settlement", () => {
  it("posts both directions at non-unit spot and preserves exact floors and currency balances", () => {
    const genesis = buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
    );
    const alpha = [...genesis.states.values()].find(s => s.seed.key === "state:alpha")!;
    const beta = [...genesis.states.values()].find(s => s.seed.key === "state:beta")!;
    const a: ActorRef = { type: "STATE", stateId: alpha.stateId };
    const b: ActorRef = { type: "STATE", stateId: beta.stateId };
    const { pool, owningAuthorityId } = resolveCanonicalFxPool(genesis, PAIR);
    const base = pool.baseCurrencyId;
    const quote = pool.quoteCurrencyId;
    const authority = genesis.monetaryAuthorities.get(owningAuthorityId)!;
    // Explicit test endowments; this is a settlement fixture, not a new
    // genesis contract or a planner allowed to spend forecast proceeds.
    const opening: WorldState = {
      ...genesis,
      states: new Map(genesis.states)
        .set(alpha.stateId, { ...alpha, treasury: new Map(alpha.treasury).set(base, 100) })
        .set(beta.stateId, { ...beta, treasury: new Map(beta.treasury).set(quote, 100) }),
      monetaryAuthorities: new Map(genesis.monetaryAuthorities).set(owningAuthorityId, {
        ...authority,
        fxPools: new Map(authority.fxPools).set(PAIR, {
          ...pool, spotRateQuotePerBase: 2, transactionSpread: 0.25,
          minOperationalReserveBase: 32, minOperationalReserveQuote: 40,
          cash: new Map([[base, 32], [quote, 52]]),
        }),
      }),
    };
    const forward: FxSettlementRequest = {
      settlementId: createFxSettlementId("fxs:opposite-forward"),
      originatingBundleId: createTransactionBundleId("tb:opposite-forward"),
      payer: a, recipient: b, pairId: PAIR,
      inputCurrencyId: base, outputCurrencyId: quote,
      desiredOutputAmount: 12, maxInputAmount: 8, purpose: "OTHER_EXPLICIT_PAYMENT",
    };
    const reverse: FxSettlementRequest = {
      ...forward, settlementId: createFxSettlementId("fxs:opposite-reverse"),
      originatingBundleId: createTransactionBundleId("tb:opposite-reverse"),
      payer: b, recipient: a, inputCurrencyId: quote, outputCurrencyId: base,
      desiredOutputAmount: 4, maxInputAmount: 10,
    };
    function context(world: WorldState, request: FxSettlementRequest,
      priorTransactions: FxSettlementContext["priorTransactions"] = []): FxSettlementContext {
      return {
        tick: 7, priorTransactions, recipientAcceptsOutputCurrency: true,
        reservation: {
          tick: 7, requestId: String(request.settlementId),
          payerKey: actorRefKey(request.payer),
          quote: quoteFx(world, PAIR, request.inputCurrencyId, request.outputCurrencyId,
            request.desiredOutputAmount, { maxInputAmount: request.maxInputAmount }),
        },
      };
    }
    function balances(world: WorldState) {
      const live = resolveCanonicalFxPool(world, PAIR).pool;
      expect(live.spotRateQuotePerBase).toBe(2);
      expect(live.transactionSpread).toBe(0.25);
      expect(live.minOperationalReserveBase).toBe(32);
      expect(live.minOperationalReserveQuote).toBe(40);
      return [readActorWallet(world, a).get(base), readActorWallet(world, b).get(quote),
        live.cash.get(base), live.cash.get(quote)];
    }
    const poolEndpoint = { type: "FX_POOL", owningAuthorityId, pairId: PAIR };
    function run(world: WorldState) {
      expect(balances(world)).toEqual([100, 100, 32, 52]);
      const blocked = context(world, reverse);
      expect(blocked.reservation.quote.feasibleOutputAmount).toBe(0);
      expect(settleFx(world, reverse, blocked)).toBeNull();
      expect(blocked.priorTransactions).toEqual([]);
      expect(balances(world)).toEqual([100, 100, 32, 52]);

      // 8 base * 2 * (1 - .25) = 12 quote, exactly the available quote.
      const first = settleFx(world, forward, context(world, forward))!;
      expect(first).not.toBeNull();
      expect([first.receipt.inputAmount, first.receipt.outputAmount]).toEqual([8, 12]);
      expect(balances(first.world)).toEqual([92, 112, 40, 40]);
      expect(first.ledgerLegs.map(leg => [leg.type, leg.currencyId, leg.moneyAmount,
        leg.fromAccount, leg.toAccount])).toEqual([
        ["FX_INPUT", base, 8, { type: "ACTOR", actor: a }, poolEndpoint],
        ["FX_OUTPUT", quote, 12, poolEndpoint, { type: "ACTOR", actor: b }],
      ]);

      // The old zero-fill promise does not become spendable when cash arrives.
      expect(settleFx(first.world, reverse, {
        ...blocked, priorTransactions: first.transactions,
      })).toBeNull();
      // A fresh explicit request sees the live base reserve. 4 * 2 * 1.25 = 10.
      const second = settleFx(first.world, reverse,
        context(first.world, reverse, first.transactions))!;
      expect(second).not.toBeNull();
      expect([second.receipt.inputAmount, second.receipt.outputAmount]).toEqual([10, 4]);
      expect(balances(second.world)).toEqual([96, 102, 36, 50]);
      expect(second.ledgerLegs.map(leg => [leg.type, leg.currencyId, leg.moneyAmount,
        leg.fromAccount, leg.toAccount])).toEqual([
        ["FX_INPUT", quote, 10, { type: "ACTOR", actor: b }, poolEndpoint],
        ["FX_OUTPUT", base, 4, poolEndpoint, { type: "ACTOR", actor: a }],
      ]);
      expect(second.transactions).toEqual([...first.ledgerLegs, ...second.ledgerLegs]);
      expect(new Set(second.transactions.map(tx => tx.transactionId)).size).toBe(4);
      expect(balances(first.world)).toEqual([92, 112, 40, 40]);
      expect(balances(world)).toEqual([100, 100, 32, 52]);
      // The pool gains 4 quote-equivalent forward and 2 reverse in spread.
      // Neither currency is created: 96+36=132 base; 102+50=152 quote.
      expect(96 + 36).toBe(100 + 32);
      expect(102 + 50).toBe(100 + 52);
      return { first, second };
    }
    const actual = run(opening);
    const reversed = run({
      ...opening,
      states: new Map([...opening.states].reverse()),
      monetaryAuthorities: new Map([...opening.monetaryAuthorities].reverse().map(([id, item]) =>
        [id, { ...item, fxPools: new Map([...item.fxPools].reverse().map(([key, value]) =>
          [key, { ...value, cash: new Map([...value.cash].reverse()) }] as const)) }] as const)),
    });
    expect(reversed.first).toEqual(actual.first);
    expect(reversed.second).toEqual(actual.second);
  });
});
