/**
 * Phase-6 handler: Main-market offer/price formation (REQ-MARKET-002, MTFX-I5).
 *
 * Phase-6 is "Main-market offer/price formation" per CORE_SCHEMA_AND_LIFECYCLES.md
 * section 10 and Handoff/04 section 9. This handler:
 * 1. Aggregates fixture intents into per-market/good demand (D) and supply (S)
 * 2. Calls the canonical repriceGoodInPhase6() exactly once per market/good
 * 3. Writes the resulting price into TickContext.marketPrices, keyed "marketId|goodId"
 *
 * Because `executeTick` runs this handler once per phase index (0-15) per tick, and the
 * handler is a no-op outside phase 6, repricing for a given market/good can happen at
 * most once per tick through this real dispatch path -- the orchestration-timing half of
 * MTFX-I5 that a hand-rolled test loop cannot prove. Phase-8 clearing (see
 * phase8MainMarketClearing.ts) reads that same context.marketPrices entry, so Phase 7/8
 * settle at exactly the price this handler produced this tick (Handoff/04 section 9:
 * "Phase 7 trade and Phase 8 clearing use the resulting Phase-6 price").
 */

import type { GoodId, MarketId } from "../domain/id";
import type { WorldState, MarketExpectationState, PendingTransitions } from "./worldState";
import type { TickContext, PhaseHandler } from "./tickOrchestrator";
import type { MarketIntent } from "./marketIntent";
import { computeEffectiveDemand, computeSellableQuantity } from "./marketClearing";
import { repriceGoodInPhase6 } from "./marketPricing";

const ZERO_EXPECTATION: MarketExpectationState = {
  observationCount: 0,
  expectedUseEma: 0,
  shortageEma: 0,
  surplusEma: 0,
  lastEffectiveDemand: 0,
  lastOfferedQuantity: 0,
  lastClearedQuantity: 0,
};

/** Canonical fields Phase-6 repricing needs; no canonical config source owns min/max price yet. */
export interface Phase6PriceConfig {
  readonly shortageSignalWeight: number;
  readonly inventorySignalWeight: number;
  readonly basePriceAdjustmentSpeed: number;
  readonly maxAbsoluteLogPriceMovePerTick: number;
  readonly targetInventoryCoverageTicks: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
}

/** Composite key shared with Phase-8's context.marketPrices lookup. */
export function marketPriceKey(marketId: MarketId, goodId: GoodId): string {
  return `${marketId}|${goodId}`;
}

/**
 * Create a Phase-6 handler with fixture-supplied intents and state.
 *
 * M3 note: mirrors createPhase8Handler's fixture-injection boundary. Production intents
 * (Phase-2/3 planning) and live world market state will replace these fixtures in later
 * milestones; the getFixtureCurrentPrice/getFixtureExpectation hooks fall back to
 * world.markets when omitted.
 */
export const createPhase6Handler = (options: {
  getFixtureIntents?: (world: WorldState, context: TickContext) => MarketIntent[];
  getFixtureMarketIds?: (world: WorldState) => Map<string, MarketId>;
  getFixtureCurrentPrice?: (marketId: MarketId, goodId: GoodId, world: WorldState) => number;
  getFixtureExpectation?: (marketId: MarketId, goodId: GoodId, world: WorldState) => MarketExpectationState;
  getFixtureMarketFacingStock?: (marketId: MarketId, goodId: GoodId, sellableSupply: number) => number;
  priceConfig: Phase6PriceConfig;
}): PhaseHandler => {
  const {
    getFixtureIntents,
    getFixtureMarketIds,
    getFixtureCurrentPrice,
    getFixtureExpectation,
    getFixtureMarketFacingStock,
    priceConfig,
  } = options;

  return (
    world: WorldState,
    context: TickContext,
    _pendingTransitions: PendingTransitions,
  ): TickContext => {
    // Only execute during Phase-6
    if (context.phase !== 6) {
      return context;
    }

    if (!getFixtureIntents) {
      return context;
    }

    const intents = getFixtureIntents(world, context);
    const marketIds = getFixtureMarketIds?.(world) ?? new Map();
    const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;

    // Group intents by market/good (Phase-6 has no PRE_PRODUCTION/MAIN pass concept).
    const groups = new Map<string, { buyers: MarketIntent[]; sellers: MarketIntent[]; marketId: MarketId; goodId: GoodId }>();
    for (const intent of intents) {
      const marketId = marketIds.get(intent.regionId) || ("market:1" as MarketId);
      const goodId = intent.goodId as GoodId;
      const key = marketPriceKey(marketId, goodId);

      if (!groups.has(key)) {
        groups.set(key, { buyers: [], sellers: [], marketId, goodId });
      }
      const group = groups.get(key)!;
      if (intent.side === "BUY") {
        group.buyers.push(intent);
      } else {
        group.sellers.push(intent);
      }
    }

    const newPrices = new Map(context.marketPrices);

    for (const group of groups.values()) {
      const key = marketPriceKey(group.marketId, group.goodId);
      const market = world.markets.get(group.marketId);

      const currentPrice =
        getFixtureCurrentPrice?.(group.marketId, group.goodId, world) ??
        market?.priceByGood.get(group.goodId) ??
        10;
      const expectation =
        getFixtureExpectation?.(group.marketId, group.goodId, world) ??
        market?.expectationsByGood.get(group.goodId) ??
        ZERO_EXPECTATION;

      // D and S are computed at this tick's carried-in price, per Handoff/04 section 9:
      // Phase 6 reprices from this tick's own D/S, not from the price it is about to produce.
      const totalEffectiveDemand = group.buyers.reduce(
        (sum, intent) => sum + computeEffectiveDemand(intent, currentPrice, quantityEpsilon),
        0,
      );
      // M3 fixtures assume all desired SELL quantity is available, matching Phase-8's
      // fixture convention (see phase8MainMarketClearing.ts).
      const totalSellableSupply = group.sellers.reduce(
        (sum, intent) => sum + computeSellableQuantity(intent, intent.desiredQuantity),
        0,
      );
      const marketFacingStock =
        getFixtureMarketFacingStock?.(group.marketId, group.goodId, totalSellableSupply) ?? totalSellableSupply;

      const newPrice = repriceGoodInPhase6(
        currentPrice,
        totalEffectiveDemand,
        totalSellableSupply,
        marketFacingStock,
        expectation,
        quantityEpsilon,
        priceConfig,
      );

      newPrices.set(key, newPrice);
    }

    return {
      ...context,
      marketPrices: newPrices,
    };
  };
};
