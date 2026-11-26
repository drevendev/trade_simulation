import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import {
  fxPayerCurrencyKey, reserveFxForPool, type FxReservationRequest,
} from "./fxQuoteReservation";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { readActorWallet } from "./marketSettlementTransition";
import { buildInitialWorld, type WorldState } from "./worldState";

const PAIR = "fxpool:currency:alpha-currency:beta";

describe("M5 #1190 / #671 live-pool mixed-direction reservations", () => {
  it("rations opening wallets and both output reserves without posting money or moving spot", () => {
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
    // Explicit test-only balances, not a canonical genesis change.
    // Rate 4, spread 1/2: one base buys 2 quote; one base costs 6 quote.
    const opening: WorldState = {
      ...genesis,
      states: new Map(genesis.states)
        .set(alpha.stateId, { ...alpha, treasury: new Map([[base, 5], [quote, 12]]) })
        .set(beta.stateId, { ...beta, treasury: new Map([[base, 20], [quote, 48]]) }),
      monetaryAuthorities: new Map(genesis.monetaryAuthorities).set(owningAuthorityId, {
        ...authority,
        fxPools: new Map(authority.fxPools).set(PAIR, {
          ...pool, spotRateQuotePerBase: 4, transactionSpread: 0.5,
          minOperationalReserveBase: 8, minOperationalReserveQuote: 9,
          cash: new Map([[base, 14], [quote, 25]]),
        }),
      }),
    };
    const ka = actorRefKey(a);
    const kb = actorRefKey(b);
    const aBase = fxPayerCurrencyKey(ka, base);
    const bBase = fxPayerCurrencyKey(kb, base);
    const aQuote = fxPayerCurrencyKey(ka, quote);
    const bQuote = fxPayerCurrencyKey(kb, quote);
    const requests: FxReservationRequest[] = [
      { requestId: "a-first", payerKey: ka, priority: 5, fromCurrencyId: base,
        toCurrencyId: quote, desiredOutputAmount: 6, maxInputAmount: 100 },
      { requestId: "b-second", payerKey: ka, priority: 5, fromCurrencyId: base,
        toCurrencyId: quote, desiredOutputAmount: 8, maxInputAmount: 100 },
      { requestId: "c-competitor", payerKey: kb, priority: 4, fromCurrencyId: base,
        toCurrencyId: quote, desiredOutputAmount: 12, maxInputAmount: 100 },
      { requestId: "d-reverse", payerKey: kb, priority: 3, fromCurrencyId: quote,
        toCurrencyId: base, desiredOutputAmount: 8, maxInputAmount: 100 },
      { requestId: "e-reverse", payerKey: ka, priority: 2, fromCurrencyId: quote,
        toCurrencyId: base, desiredOutputAmount: 2, maxInputAmount: 100 },
    ];

    function run(world: WorldState, ordered: readonly FxReservationRequest[], reverse: boolean) {
      const before = structuredClone(world);
      const live = resolveCanonicalFxPool(world, PAIR).pool;
      const entries = [
        [aBase, readActorWallet(world, a).get(base)!],
        [bBase, readActorWallet(world, b).get(base)!],
        [aQuote, readActorWallet(world, a).get(quote)!],
        [bQuote, readActorWallet(world, b).get(quote)!],
      ] as const;
      const budgets = new Map(reverse ? [...entries].reverse() : entries);
      const beforeBudgets = new Map(budgets);
      expect([...entries].map(([, balance]) => balance)).toEqual([5, 20, 12, 48]);

      // Negative witness: independent quotes each see the opening reserves
      // and would double-promise both output currencies and alpha's base cash.
      const isolated = requests.map(r => quoteFx(
        world, PAIR, r.fromCurrencyId, r.toCurrencyId, r.desiredOutputAmount,
        { maxInputAmount: budgets.get(fxPayerCurrencyKey(r.payerKey, r.fromCurrencyId))! },
      ));
      expect(isolated.map(q => q.feasibleOutputAmount)).toEqual([6, 8, 12, 6, 2]);
      expect(isolated[0]!.requiredInputForFeasibleOutput +
        isolated[1]!.requiredInputForFeasibleOutput).toBe(7);

      const plan = reserveFxForPool(live, ordered, budgets, 7);
      expect(plan.reservations.map(r => [
        r.requestId, r.tick, r.quote.feasibleOutputAmount, r.quote.requiredInputForFeasibleOutput,
      ])).toEqual([
        ["a-first", 7, 6, 3],
        ["b-second", 7, 4, 2], // remaining alpha base cash, not pool output
        ["c-competitor", 7, 6, 3], // remaining quote pool output, not buyer cash
        ["d-reverse", 7, 6, 36], // opening base output only: 14 - 8
        ["e-reverse", 7, 0, 0], // no spending promised receipts in reverse
      ]);
      expect(plan.reservedOutputByCurrency).toEqual(new Map([[quote, 16], [base, 6]]));
      expect(plan.reservedInputByPayerCurrency).toEqual(new Map([
        [aBase, 5], [bBase, 3], [bQuote, 36], [aQuote, 0],
      ]));
      // Base-denominated desired and filled supply differ from quote amounts.
      expect(plan.pressure).toEqual({
        desiredDemandForBase: 10, desiredSupplyOfBase: 13,
        filledDemandForBase: 6, filledSupplyOfBase: 8,
      });
      expect(plan.reservations.every(r => r.quote.spotRate === 4 && r.quote.spread === 0.5))
        .toBe(true);
      expect(budgets).toEqual(beforeBudgets);
      expect(world).toEqual(before);
      expect(live.cash).toEqual(new Map([[base, 14], [quote, 25]]));
      return plan;
    }

    const actual = run(opening, requests, false);
    const reversed = run({
      ...opening,
      states: new Map([...opening.states].reverse().map(([id, state]) =>
        [id, { ...state, treasury: new Map([...state.treasury].reverse()) }] as const)),
      monetaryAuthorities: new Map([...opening.monetaryAuthorities].reverse().map(([id, item]) =>
        [id, { ...item, fxPools: new Map([...item.fxPools].reverse().map(([key, value]) =>
          [key, { ...value, cash: new Map([...value.cash].reverse()) }] as const)) }] as const)),
    }, [...requests].reverse(), true);
    expect(reversed).toEqual(actual);
  });
});
