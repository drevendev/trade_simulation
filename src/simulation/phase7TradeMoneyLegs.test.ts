import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, StateId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { readActorWallet } from "./marketSettlementTransition";
import {
  applyConservingTradeMoneyLegs,
  type Phase7TradeMoneyLeg,
} from "./phase7TradeMoneyLegs";
import { buildInitialWorld, type WorldState } from "./worldState";

interface Fixture {
  world: WorldState;
  buyer: ActorRef;
  seller: ActorRef;
  feeReceiver: ActorRef;
  currencyId: CurrencyId;
}

function fixture(
  buyerCash = 100,
  sellerCash = 10,
  feeCash = 5,
): Fixture {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 37,
  );
  const states = [...world.states.values()];
  const feeCohort = [...world.cohorts.values()][0];
  const currencyId = [...world.currencies.keys()][0];
  if (states.length < 2 || !feeCohort || !currencyId) {
    throw new Error("Required canonical money-owner fixtures are absent");
  }
  const [buyerState, sellerState] = states;
  if (!buyerState || !sellerState) throw new Error("Missing State actors");
  const buyer: ActorRef = { type: "STATE", stateId: buyerState.stateId };
  const seller: ActorRef = { type: "STATE", stateId: sellerState.stateId };
  const feeReceiver: ActorRef = { type: "COHORT", cohortId: feeCohort.cohortId };
  const statesUpdated = new Map(world.states);
  statesUpdated.set(buyerState.stateId, {
    ...buyerState, treasury: new Map(buyerState.treasury).set(currencyId, buyerCash),
  });
  statesUpdated.set(sellerState.stateId, {
    ...sellerState, treasury: new Map(sellerState.treasury).set(currencyId, sellerCash),
  });
  return {
    world: {
      ...world,
      states: statesUpdated,
      cohorts: new Map(world.cohorts).set(feeCohort.cohortId, {
        ...feeCohort, wallet: new Map(feeCohort.wallet).set(currencyId, feeCash),
      }),
    },
    buyer, seller, feeReceiver, currencyId,
  };
}

function cash(world: WorldState, actor: ActorRef, currency: CurrencyId): number {
  return readActorWallet(world, actor).get(currency) ?? 0;
}

function legs({ buyer, seller, feeReceiver, currencyId }: Fixture): Phase7TradeMoneyLeg[] {
  return [
    { legId: "tb:37:goods", from: buyer, to: seller, currencyId, amount: 30 },
    { legId: "tb:37:tariff", from: buyer, to: seller, currencyId, amount: 3 },
    { legId: "tb:37:transport", from: buyer, to: feeReceiver, currencyId, amount: 2 },
  ];
}

describe("M5 #673 conserving Phase-7 trade money legs", () => {
  it("pays seller, tariff treasury and fee receiver with exact observed per-currency conservation", () => {
    const input = fixture();
    const before = [input.buyer, input.seller, input.feeReceiver]
      .map((actor) => cash(input.world, actor, input.currencyId));
    const result = applyConservingTradeMoneyLegs(input.world, legs(input));
    expect(cash(result, input.buyer, input.currencyId)).toBe(65);
    expect(cash(result, input.seller, input.currencyId)).toBe(43);
    expect(cash(result, input.feeReceiver, input.currencyId)).toBe(7);
    const after = [input.buyer, input.seller, input.feeReceiver]
      .map((actor) => cash(result, actor, input.currencyId));
    expect(after.reduce((a, b) => a + b, 0)).toBe(before.reduce((a, b) => a + b, 0));
    expect([input.buyer, input.seller, input.feeReceiver]
      .map((actor) => cash(input.world, actor, input.currencyId))).toEqual(before);
    expect(result.states).not.toBe(input.world.states);
    expect(result.shipments).toBe(input.world.shipments);
  });

  it("uses stable leg identity ordering independently of caller input order", () => {
    const input = fixture();
    const a = applyConservingTradeMoneyLegs(input.world, legs(input));
    const b = applyConservingTradeMoneyLegs(input.world, [...legs(input)].reverse());
    for (const actor of [input.buyer, input.seller, input.feeReceiver]) {
      expect(cash(a, actor, input.currencyId)).toBe(cash(b, actor, input.currencyId));
    }
    expect(a.shipments).toBe(b.shipments);
  });

  it("refuses gross debit financed only by an incoming leg in the SAME bundle", () => {
    const input = fixture(0, 0);
    const bundle: Phase7TradeMoneyLeg[] = [
      { legId: "cycle-a", from: input.buyer, to: input.seller, currencyId: input.currencyId, amount: 10 },
      { legId: "cycle-b", from: input.seller, to: input.buyer, currencyId: input.currencyId, amount: 10 },
    ];
    expect(() => applyConservingTradeMoneyLegs(input.world, bundle))
      .toThrow(/gross debit exceeds opening/);
    expect(cash(input.world, input.buyer, input.currencyId)).toBe(0);
    expect(cash(input.world, input.seller, input.currencyId)).toBe(0);
  });

  it("refuses silently lost buyer debits and silently lost seller credits near 10^16", () => {
    const lostDebit = fixture(1e16, 10);
    const debitLeg: Phase7TradeMoneyLeg = {
      legId: "unobservable-debit", from: lostDebit.buyer, to: lostDebit.seller,
      currencyId: lostDebit.currencyId, amount: 1,
    };
    expect(() => applyConservingTradeMoneyLegs(lostDebit.world, [debitLeg]))
      .toThrow(/cannot be represented/);
    expect(cash(lostDebit.world, lostDebit.buyer, lostDebit.currencyId)).toBe(1e16);

    const lostCredit = fixture(10, 1e16);
    const creditLeg: Phase7TradeMoneyLeg = {
      legId: "unobservable-credit", from: lostCredit.buyer, to: lostCredit.seller,
      currencyId: lostCredit.currencyId, amount: 1,
    };
    expect(() => applyConservingTradeMoneyLegs(lostCredit.world, [creditLeg]))
      .toThrow(/cannot be represented/);
    expect(cash(lostCredit.world, lostCredit.seller, lostCredit.currencyId)).toBe(1e16);
  });

  it("refuses a fee silently lost by rounded compensated gross debits and credits", () => {
    const f = fixture(2e16, 0, 0);
    const bundle: Phase7TradeMoneyLeg[] = [
      { legId: "goods", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1e16 },
      { legId: "fee", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1 },
    ];
    expect(() => applyConservingTradeMoneyLegs(f.world, bundle))
      .toThrow(/cannot be represented|precision/);
    expect(cash(f.world, f.buyer, f.currencyId)).toBe(2e16);
    expect(cash(f.world, f.seller, f.currencyId)).toBe(0);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("permits exactly representable large single and combined money legs", () => {
    const f = fixture(2e16, 0, 0);
    const large: Phase7TradeMoneyLeg = {
      legId: "goods", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1e16,
    };
    const single = applyConservingTradeMoneyLegs(f.world, [large]);
    expect(cash(single, f.buyer, f.currencyId)).toBe(1e16);
    expect(cash(single, f.seller, f.currencyId)).toBe(1e16);
    const withExactFee = applyConservingTradeMoneyLegs(f.world, [
      large,
      { ...large, legId: "fee", amount: 2 },
    ]);
    expect(cash(withExactFee, f.buyer, f.currencyId)).toBe(1e16 - 2);
    expect(cash(withExactFee, f.seller, f.currencyId)).toBe(1e16 + 2);
    expect(cash(f.world, f.buyer, f.currencyId)).toBe(2e16);
    expect(cash(f.world, f.seller, f.currencyId)).toBe(0);
  });

  it("accepts multiple small named fees when their exact combined gross is representable", () => {
    const f = fixture(2e16, 0, 0);
    const bundle: Phase7TradeMoneyLeg[] = [
      { legId: "a-goods", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1e16 },
      { legId: "b-fee1", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1 },
      { legId: "c-fee3", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 3 },
    ];
    // Neither fee has to be separately distinguishable when subtracted from
    // the final gross; 1e16 + 1 + 3 is exactly representable as a whole.
    for (const ordered of [bundle, [...bundle].reverse()]) {
      const result = applyConservingTradeMoneyLegs(f.world, ordered);
      expect(cash(result, f.buyer, f.currencyId)).toBe(1e16 - 4);
      expect(cash(result, f.seller, f.currencyId)).toBe(1e16 + 4);
      expect(result.shipments).toBe(f.world.shipments);
    }
    expect(cash(f.world, f.buyer, f.currencyId)).toBe(2e16);
    expect(cash(f.world, f.seller, f.currencyId)).toBe(0);
  });

  it("refuses an inexact large gross even if one positive leg nearly fits the rounding gap", () => {
    const f = fixture(2e16, 0, 0);
    const candidate: Phase7TradeMoneyLeg[] = [
      { legId: "goods", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1e16 },
      { legId: "fee", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 3 },
    ];
    expect(() => applyConservingTradeMoneyLegs(f.world, candidate))
      .toThrow(/gross money leg amount cannot be represented/);
    expect(cash(f.world, f.buyer, f.currencyId)).toBe(2e16);
    expect(cash(f.world, f.seller, f.currencyId)).toBe(0);
  });

  it("rejects a swallowed positive micro-leg even when it is below moneyEpsilon", () => {
    const f = fixture(2e16, 0, 0);
    const bundle: Phase7TradeMoneyLeg[] = [
      { legId: "goods", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1e16 },
      { legId: "micropayment", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 1e-10 },
    ];
    expect(() => applyConservingTradeMoneyLegs(f.world, bundle))
      .toThrow(/cannot be represented/);
    // Move the micro-leg ahead of the large leg in sorted legId order. The
    // same promised payment must still fail; compensation is order-independent.
    const microFirst = [
      { ...bundle[0]!, legId: "z-goods" },
      { ...bundle[1]!, legId: "a-micro" },
    ];
    expect(() => applyConservingTradeMoneyLegs(f.world, microFirst))
      .toThrow(/cannot be represented/);
    expect(cash(f.world, f.buyer, f.currencyId)).toBe(2e16);
    expect(cash(f.world, f.seller, f.currencyId)).toBe(0);
  });

  it("permits compensated ordinary decimal money legs within numerical epsilon", () => {
    const f = fixture(10, 0, 0);
    const bundle: Phase7TradeMoneyLeg[] = [
      { legId: "goods", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 0.1 },
      { legId: "fee", from: f.buyer, to: f.seller, currencyId: f.currencyId, amount: 0.2 },
    ];
    const result = applyConservingTradeMoneyLegs(f.world, bundle);
    expect(cash(result, f.buyer, f.currencyId)).toBeCloseTo(9.7, 12);
    expect(cash(result, f.seller, f.currencyId)).toBeCloseTo(0.3, 12);
  });

  it("rejects duplicate IDs, unknown currency, self-payments, bad amounts and insufficient money", () => {
    const input = fixture();
    const valid = legs(input)[0]!;
    const other = { ...valid, legId: "duplicate" };
    const invalid: readonly Phase7TradeMoneyLeg[][] = [
      [],
      [valid, valid],
      [{ ...valid, currencyId: "cur:not-real" as CurrencyId }],
      [{ ...valid, to: input.buyer }],
      [{ ...valid, amount: 0 }],
      [{ ...valid, amount: -1 }],
      [{ ...valid, amount: NaN }],
      [{ ...valid, amount: Infinity }],
      [{ ...other, amount: 101 }],
      [{ ...valid, from: { type: "STATE", stateId: "s:ghost" as StateId } }],
    ];
    for (const candidate of invalid) {
      expect(() => applyConservingTradeMoneyLegs(input.world, candidate)).toThrow();
      expect(cash(input.world, input.buyer, input.currencyId)).toBe(100);
      expect(cash(input.world, input.seller, input.currencyId)).toBe(10);
      expect(input.world.shipments?.size).toBe(0);
    }
  });

  it("rejects a transfer that overflows an otherwise nonnegative live balance", () => {
    const input = fixture(Number.MAX_VALUE, Number.MAX_VALUE);
    const transfer: Phase7TradeMoneyLeg = {
      legId: "overflow-credit", from: input.buyer, to: input.seller,
      currencyId: input.currencyId, amount: Number.MAX_VALUE,
    };
    expect(() => applyConservingTradeMoneyLegs(input.world, [transfer]))
      .toThrow(/cannot be represented|non-finite/);
    expect(cash(input.world, input.seller, input.currencyId)).toBe(Number.MAX_VALUE);
  });
});
