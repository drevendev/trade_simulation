/**
 * Persists Phase-6/Phase-8 tick output into the next tick's authoritative
 * `WorldState.markets` (REQ-ACCEPTANCE-004, MTFX-I5).
 *
 * Handoff/04 section 11 states persistent truth after `MarketAllocation` execution
 * includes LocalMarket price/expectation state. Section 9 requires price to update
 * exactly once in Phase 6 and expectation to update exactly once after Phase-8 MAIN
 * clearing, so the next tick's Phase 6 reads the lagged, persisted values rather than
 * test-owned or fixture-owned cross-tick memory.
 *
 * `executeTick()` keeps `WorldState` immutable for the duration of one tick (see
 * tickOrchestrator.ts); this function is the explicit boundary a caller applies
 * between consecutive `executeTick()` calls to carry that tick's Phase-6 price and
 * Phase-8 MAIN observation forward.
 */

import type { WorldState, LocalMarketState } from "./worldState";
import type { TickContext } from "./tickOrchestrator";
import { parseMarketPriceKey, ZERO_EXPECTATION } from "./phase6MarketPriceFormation";
import { updateMarketExpectations } from "./marketPricing";

/**
 * Return a new WorldState whose `markets` map carries forward this tick's Phase-6
 * price (context.marketPrices) and post-Phase-8-MAIN MarketExpectationState
 * (derived from context.marketClearingAggregates, which is populated regardless of
 * the telemetry toggle) into the next tick's authoritative LocalMarket state.
 *
 * Every market/good touched by context.marketPrices or context.marketClearingAggregates
 * must already exist in world.markets: this boundary updates the canonical stock
 * LocalMarketState already owns, it never invents a new market/good endpoint.
 */
export function applyMarketStateTransition(world: WorldState, context: TickContext): WorldState {
  if (context.marketPrices.size === 0 && context.marketClearingAggregates.size === 0) {
    return world;
  }

  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
  const expectationAlpha = world.simulationConfig.markets.expectationAlpha ?? 0.25;

  const touchedKeys = new Set<string>([
    ...context.marketPrices.keys(),
    ...context.marketClearingAggregates.keys(),
  ]);

  const updatedMarkets = new Map(world.markets);

  for (const key of touchedKeys) {
    const { marketId, goodId } = parseMarketPriceKey(key);
    const existingMarket = updatedMarkets.get(marketId);
    if (!existingMarket) {
      throw new Error(
        `applyMarketStateTransition: no canonical LocalMarketState for marketId "${marketId}" ` +
          `(good "${goodId}"). This boundary updates existing market state; it never invents one.`,
      );
    }

    const priceByGood = new Map(existingMarket.priceByGood);
    const expectationsByGood = new Map(existingMarket.expectationsByGood);

    const newPrice = context.marketPrices.get(key);
    if (newPrice !== undefined) {
      priceByGood.set(goodId, newPrice);
    }

    const aggregate = context.marketClearingAggregates.get(key);
    if (aggregate !== undefined) {
      const currentExpectation = expectationsByGood.get(goodId) ?? ZERO_EXPECTATION;
      const nextExpectation = updateMarketExpectations(
        currentExpectation,
        aggregate.effectiveDemandQuantity,
        aggregate.offeredQuantity,
        aggregate.clearedQuantity,
        quantityEpsilon,
        expectationAlpha,
      );
      expectationsByGood.set(goodId, nextExpectation);
    }

    const nextMarket: LocalMarketState = {
      ...existingMarket,
      priceByGood,
      expectationsByGood,
    };
    updatedMarkets.set(marketId, nextMarket);
  }

  return { ...world, markets: updatedMarkets };
}
