import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, RegionId, TransportLinkId } from "../domain/id";
import { createMarketIntentId } from "./marketIntent";
import { buildInitialWorld } from "./worldState";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import type { Phase7PreFxRankedCandidate } from "./tradeCandidateSelection";
import type { Phase7PreFxActorDemandLot } from "./phase7IntentMatching";
import { valuePhase7PreFxActorDemand } from "./phase7PreFxCurrencyDemand";

const pair = "fxpool:currency:alpha-currency:beta";

function fixture(reverse = false) {
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack,
    createDefaultSimulationConfig(), 37);
  const { pool, owningAuthorityId } = resolveCanonicalFxPool(world, pair);
  const sourceCurrencyId = reverse ? pool.quoteCurrencyId : pool.baseCurrencyId;
  const destinationCurrencyId = reverse ? pool.baseCurrencyId : pool.quoteCurrencyId;
  const candidate: Phase7PreFxRankedCandidate = {
    tradePlanId: "plan:1", linkId: "link:1" as TransportLinkId,
    originRegionId: "r:1" as RegionId, destinationRegionId: "r:2" as RegionId,
    goodId: "good:wood" as GoodId, sourceCurrencyId, destinationCurrencyId,
    sourceSellerNetUnitPrice: 3, destinationReferenceNetUnitPrice: 30,
    estimatedTransportUnitCostDest: 7, estimatedTariffRate: 0.2,
    estimatedFxInputPerSourceCurrency: 1, shortageRateDestination: 0.2,
    score: 1, desiredOwnQuantity: 10,
  };
  const lot: Phase7PreFxActorDemandLot = {
    tradePlanId: candidate.tradePlanId, sourceCurrencyId, destinationCurrencyId,
    sellerIntentId: createMarketIntentId("mi:seller"),
    buyerIntentId: createMarketIntentId("mi:buyer"), desiredQuantity: 4,
  };
  const pairs = new Map([[candidate.tradePlanId, pair]]);
  return { world, pool, owningAuthorityId, candidate, lot, pairs };
}

describe("M5 pre-FX actor demand currency valuation", () => {
  it.each([false, true])("values both directions independently of liquidity (reverse=%s)", reverse => {
    const { world, pool, owningAuthorityId, candidate, lot, pairs } = fixture(reverse);
    const owner = world.monetaryAuthorities.get(owningAuthorityId)!;
    const emptyCash = new Map([
      [pool.baseCurrencyId, pool.minOperationalReserveBase],
      [pool.quoteCurrencyId, pool.minOperationalReserveQuote],
    ]);
    const emptyPool = { ...pool, cash: emptyCash };
    const thin = { ...world, monetaryAuthorities: new Map(world.monetaryAuthorities)
      .set(owningAuthorityId, { ...owner, fxPools: new Map(owner.fxPools).set(pair, emptyPool) }) };
    const originalCash = [...pool.cash];
    const result = valuePhase7PreFxActorDemand(world, 7, [lot], [candidate], pairs);
    expect(valuePhase7PreFxActorDemand(thin, 7, [lot], [candidate], pairs)).toEqual(result);
    const expectedInput = reverse
      ? 12 / (pool.spotRateQuotePerBase * (1 - pool.transactionSpread))
      : 12 * pool.spotRateQuotePerBase * (1 + pool.transactionSpread);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ ...lot, tick: 7, pairId: pair,
      direction: reverse ? "BASE_TO_QUOTE" : "QUOTE_TO_BASE",
      desiredOutputAmount: 12, requiredInputAmountAtDesiredOutput: expect.closeTo(expectedInput, 12) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect([...pool.cash]).toEqual(originalCash);
    expect([...emptyCash]).toEqual([
      [pool.baseCurrencyId, pool.minOperationalReserveBase],
      [pool.quoteCurrencyId, pool.minOperationalReserveQuote],
    ]);
    expect([...pairs]).toEqual([[candidate.tradePlanId, pair]]);
  });

  it("retains distinct intent provenance without introducing dispatch ordinals", () => {
    const { world, candidate, lot, pairs } = fixture();
    const second = { ...lot, buyerIntentId: createMarketIntentId("mi:other"), desiredQuantity: 2 };
    const result = valuePhase7PreFxActorDemand(world, 0, [lot, second], [candidate], pairs);
    expect(result.map(v => [v.buyerIntentId, v.desiredOutputAmount])).toEqual([
      [lot.buyerIntentId, 12], [second.buyerIntentId, 6],
    ]);
    expect(result[0]).not.toHaveProperty("feasibleOutputAmount");
    expect(result[0]).not.toHaveProperty("requestId");
    expect(result[0]).not.toHaveProperty("ordinal");
    expect(() => valuePhase7PreFxActorDemand(world, 0, [lot, lot], [candidate], pairs))
      .toThrow(/duplicate lot/);
  });

  it("bounds the sum of distinct lots per plan, using one canonical quantity epsilon", () => {
    const { world, candidate, lot, pairs } = fixture();
    const lots = (a: number, b: number) => [
      { ...lot, desiredQuantity: a },
      { ...lot, buyerIntentId: createMarketIntentId("mi:other"), desiredQuantity: b },
    ];
    expect(() => valuePhase7PreFxActorDemand(world, 0, lots(6, 6), [candidate], pairs))
      .toThrow(/aggregate lots exceed candidate bound/);
    expect(valuePhase7PreFxActorDemand(world, 0, lots(6, 4), [candidate], pairs)
      .map(v => v.desiredOutputAmount)).toEqual([18, 12]);
    expect(valuePhase7PreFxActorDemand(world, 0, lots(0.1, 0.2),
      [{ ...candidate, desiredOwnQuantity: 0.3 }], pairs)).toHaveLength(2);
    const epsilon = world.simulationConfig.numeric.quantityEpsilon!;
    expect(() => valuePhase7PreFxActorDemand(world, 0, [
      { ...lot, desiredQuantity: 10 },
      { ...lot, buyerIntentId: createMarketIntentId("mi:other"), desiredQuantity: epsilon * 0.75 },
      { ...lot, buyerIntentId: createMarketIntentId("mi:third"), desiredQuantity: epsilon * 0.75 },
    ], [candidate], pairs)).toThrow(/aggregate lots exceed candidate bound/);
  });

  it("rejects a known pool with wrong currencies and underflow of required input", () => {
    const { world, pool, owningAuthorityId, candidate, lot, pairs } = fixture();
    const wrong = "currency:other" as typeof lot.destinationCurrencyId;
    expect(() => valuePhase7PreFxActorDemand(world, 0, [
      { ...lot, destinationCurrencyId: wrong },
    ], [{ ...candidate, destinationCurrencyId: wrong }], pairs)).toThrow(/currencies do not match/);
    const owner = world.monetaryAuthorities.get(owningAuthorityId)!;
    const tinyRate = { ...world, monetaryAuthorities: new Map(world.monetaryAuthorities)
      .set(owningAuthorityId, { ...owner, fxPools: new Map(owner.fxPools)
        .set(pair, { ...pool, spotRateQuotePerBase: 0.25 }) }) };
    expect(() => valuePhase7PreFxActorDemand(tinyRate, 0,
      [{ ...lot, desiredQuantity: Number.MIN_VALUE }],
      [{ ...candidate, sourceSellerNetUnitPrice: 1 }], pairs)).toThrow(/required input/);
  });

  it("rejects missing, mismatched, domestic and duplicate route evidence", () => {
    const { world, candidate, lot, pairs } = fixture();
    expect(() => valuePhase7PreFxActorDemand(world, 0, [lot], [], pairs)).toThrow(/route evidence/);
    expect(() => valuePhase7PreFxActorDemand(world, 0, [lot], [candidate], new Map()))
      .toThrow(/route evidence/);
    expect(() => valuePhase7PreFxActorDemand(world, 0, [lot], [candidate, candidate], pairs))
      .toThrow(/duplicate/);
    expect(() => valuePhase7PreFxActorDemand(world, 0, [
      { ...lot, destinationCurrencyId: lot.sourceCurrencyId },
    ], [candidate], pairs)).toThrow(/route evidence/);
    expect(() => valuePhase7PreFxActorDemand(world, 0, [lot], [candidate],
      new Map([[lot.tradePlanId, "missing-pair"]]))).toThrow(/Unknown canonical FX pair/);
  });

  it("rejects invalid tick, invalid quantity, and invoice overflow or underflow", () => {
    const { world, candidate, lot, pairs } = fixture();
    expect(() => valuePhase7PreFxActorDemand(world, -1, [lot], [candidate], pairs)).toThrow(/tick/);
    for (const desiredQuantity of [0, -1, NaN, Infinity, 11]) {
      expect(() => valuePhase7PreFxActorDemand(world, 0, [
        { ...lot, desiredQuantity },
      ], [candidate], pairs)).toThrow();
    }
    expect(() => valuePhase7PreFxActorDemand(world, 0, [lot], [
      { ...candidate, sourceSellerNetUnitPrice: Number.MAX_VALUE },
    ], pairs)).toThrow(/invoice/);
    expect(() => valuePhase7PreFxActorDemand(world, 0, [
      { ...lot, desiredQuantity: Number.MIN_VALUE },
    ], [{ ...candidate, sourceSellerNetUnitPrice: Number.MIN_VALUE }], pairs))
      .toThrow(/invoice/);
  });
});
