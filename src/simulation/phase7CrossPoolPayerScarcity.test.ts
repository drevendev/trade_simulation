import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { createMarketIntentId } from "./marketIntent";
import { phase7FxOutputKey } from "./phase7AggregateReservation";
import type { Phase7ActualLotQuote } from "./phase7ActualLotQuote";
import {
  assessPhase7QuotedFxScarcity, reservePhase7QuotedFxLots,
} from "./phase7AutoFxReservations";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { buildInitialWorld, type WorldState } from "./worldState";

describe("M5 #1192 / #671 shared cash across canonical FX pairs", () => {
  it("limits the second pool by the common opening wallet, not its own reserves", () => {
    const root = buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
    );
    const alpha = [...root.states.values()].find(s => s.seed.key === "state:alpha")!;
    const beta = [...root.states.values()].find(s => s.seed.key === "state:beta")!;
    const gamma = [...root.states.values()].find(s => s.seed.key === "state:gamma")!;
    const a: ActorRef = { type: "STATE", stateId: alpha.stateId };
    const b: ActorRef = { type: "STATE", stateId: beta.stateId };
    const g: ActorRef = { type: "STATE", stateId: gamma.stateId };
    const pairs = ["fxpool:currency:alpha-currency:beta", "fxpool:currency:alpha-currency:gamma"];
    const located = pairs.map(id => resolveCanonicalFxPool(root, id));
    const input = located[0]!.pool.baseCurrencyId;
    expect(located[1]!.pool.baseCurrencyId).toBe(input);
    expect(located[0]!.pool.quoteCurrencyId).not.toBe(located[1]!.pool.quoteCurrencyId);
    const authorities = new Map(root.monetaryAuthorities);
    for (const [i, { pool, owningAuthorityId }] of located.entries()) {
      const authority = authorities.get(owningAuthorityId)!;
      authorities.set(owningAuthorityId, {
        ...authority,
        fxPools: new Map(authority.fxPools).set(pool.pairId, {
          ...pool, spotRateQuotePerBase: i === 0 ? 2 : 4, transactionSpread: 0.5,
          minOperationalReserveBase: 10, minOperationalReserveQuote: 10,
          cash: new Map([[pool.baseCurrencyId, 100], [pool.quoteCurrencyId, 100]]),
        }),
      });
    }
    const world: WorldState = {
      ...root,
      monetaryAuthorities: authorities,
      states: new Map(root.states)
        .set(alpha.stateId, { ...alpha, treasury: new Map([[input, 10]]) })
        .set(beta.stateId, { ...beta, treasury: new Map([[input, 6]]) }),
    };
    const quotes: Phase7ActualLotQuote[] = located.map(({ pool }, i) => ({
      lot: {
        tradePlanId: "plan:cross-pool:" + i,
        sellerIntentId: createMarketIntentId("mi:cross-pool:seller:" + i),
        buyerIntentId: createMarketIntentId("mi:cross-pool:buyer:" + i),
        seller: i === 0 ? b : g, buyer: a,
        sellerInventoryBucket: "GENERAL", buyerInventoryBucket: "GENERAL",
        quantity: i === 0 ? 3 : 6,
      },
      originCurrencyId: pool.quoteCurrencyId, destinationCurrencyId: input,
      destinationTreasuryStateId: alpha.stateId, transportFeeReceiver: null,
      fxPairId: pool.pairId, sourceSellerNetUnitPrice: 2,
      sellerInvoiceSource: i === 0 ? 6 : 12,
      goodsPaymentDest: 6, invoiceMidDest: 3, transportFeeDest: 0,
      importTariffDest: 0, consumptionTaxDest: 0, buyerDebitDest: 6,
    }));
    // These are preflight quote fixtures, not legal route or dispatch receipts.
    const before = structuredClone(world);
    const independent = quotes.map(q => quoteFx(
      world, q.fxPairId!, input, q.originCurrencyId, q.sellerInvoiceSource,
      { maxInputAmount: 10 },
    ));
    expect(independent.map(q => q.feasibleOutputAmount)).toEqual([6, 12]);
    expect(independent.map(q => q.requiredInputForFeasibleOutput)).toEqual([6, 6]);
    expect(independent.map(q => q.maxOutputByPoolReserve)).toEqual([90, 90]);
    expect(() => reservePhase7QuotedFxLots(world, 7, quotes))
      .toThrow("FX liquidity requires quantity shrink and re-quote before dispatch");
    const caps = assessPhase7QuotedFxScarcity(world, 7, quotes);
    const secondKey = phase7FxOutputKey(pairs[1]!, quotes[1]!.originCurrencyId);
    expect(caps.requiresShrink).toBe(true);
    expect(caps.reducedOutputByPairCurrency).toEqual(new Map([[secondKey, 8]]));
    expect(caps.feasibleQuantityByLotOrdinal).toEqual(new Map([[0, 3], [1, 4]]));
    const expectedDesired = [
      { tick: 7, pairId: pairs[0], direction: "BASE_TO_QUOTE",
        desiredOutputAmount: 6, requiredInputAmountAtDesiredOutput: 6 },
      { tick: 7, pairId: pairs[1], direction: "BASE_TO_QUOTE",
        desiredOutputAmount: 12, requiredInputAmountAtDesiredOutput: 6 },
    ];
    // Full original demand survives even though the second feasible output is 8.
    // Exact shape also proves no request ID, feasible amount or redemption promise leaks.
    expect([...caps.desiredFlowByLotOrdinal]).toEqual([
      [0, expectedDesired[0]], [1, expectedDesired[1]],
    ]);
    expect([...caps.desiredFlowByLotOrdinal.values()].every(Object.isFrozen)).toBe(true);

    // Pair order, not registry or incoming ordinal across pairs, owns priority.
    const reordered: WorldState = {
      ...world,
      states: new Map([...world.states].reverse()),
      monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(
        ([id, authority]) => [id, { ...authority, fxPools: new Map([...authority.fxPools].reverse()) }] as const,
      )),
    };
    const reorderedBefore = structuredClone(reordered);
    const reversed = assessPhase7QuotedFxScarcity(reordered, 7, [...quotes].reverse());
    expect(reversed.reducedOutputByPairCurrency).toEqual(caps.reducedOutputByPairCurrency);
    expect(reversed.feasibleQuantityByLotOrdinal).toEqual(new Map([[0, 4], [1, 3]]));
    expect([...reversed.desiredFlowByLotOrdinal]).toEqual([
      [0, expectedDesired[1]], [1, expectedDesired[0]],
    ]);

    // Exact shared-cash boundary and separate-payer counterfactual.
    const funded: WorldState = {
      ...world, states: new Map(world.states).set(alpha.stateId, {
        ...world.states.get(alpha.stateId)!, treasury: new Map([[input, 12]]),
      }),
    };
    const split = [quotes[0]!, {
      ...quotes[1]!, lot: { ...quotes[1]!.lot, buyer: b },
    }];
    const fundedBefore = structuredClone(funded);
    for (const [fixture, lots, payers] of [
      [funded, quotes, [a, a]],
      [world, split, [a, b]],
    ] as const) {
      const full = reservePhase7QuotedFxLots(fixture, 7, lots);
      expect([...full.values()].map(r => [
        r.payerKey, r.quote.pairId, r.quote.feasibleOutputAmount,
        r.quote.requiredInputForFeasibleOutput,
      ])).toEqual([
        [actorRefKey(payers[0]!), pairs[0], 6, 6],
        [actorRefKey(payers[1]!), pairs[1], 12, 6],
      ]);
      const noScarcity = assessPhase7QuotedFxScarcity(fixture, 7, lots);
      expect(noScarcity.requiresShrink).toBe(false);
      expect(noScarcity.desiredFlowByLotOrdinal).toEqual(caps.desiredFlowByLotOrdinal);
    }
    expect(world).toEqual(before);
    expect(reordered).toEqual(reorderedBefore);
    expect(funded).toEqual(fundedBefore);
  });
});
