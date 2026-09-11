/**
 * Phase-8 handler: Residual local main-market clearing and settlement with telemetry.
 *
 * Phase-8 is "Residual local main-market clearing" per CORE_SCHEMA_AND_LIFECYCLES.md section 10.
 * For M3, this handler:
 * 1. Executes clearing for seeded market scenarios with fixture intents
 * 2. Collects deterministic market telemetry (REQ-MARKET-005) from actual clearing results
 * 3. Returns updated TickContext with telemetry and the realized allocations
 *
 * Telemetry is non-authoritative diagnostic output. collectTelemetry only gates whether
 * telemetry is built and appended to context.marketTelemetry: clearing itself (and the
 * resulting context.marketAllocations) executes identically either way, so enabled/disabled
 * runs produce identical canonical stocks, allocations, and replay hash.
 */

import type { MarketId, GoodId, RegionId, CurrencyId } from "../domain/id";
import type { WorldState } from "./worldState";
import type { TickContext, PhaseHandler } from "./tickOrchestrator";
import type { PendingTransitions } from "./worldState";
import type { MarketIntent } from "./marketIntent";
import { LocalMarketTelemetryBuilder } from "./marketTelemetry";
import { computeLocalClearing, type LocalClearingInput } from "./marketClearing";
import { marketPriceKey } from "./phase6MarketPriceFormation";

/**
 * Create a Phase-8 handler with optional telemetry collection.
 *
 * Args:
 * - getFixtureIntents: optional function to provide test fixture intents for clearing
 *   (in production, intents come from Phase-2/3 planning)
 * - getFixtureMarketIds: optional function to provide market IDs for telemetry
 *   (maps region to market; in production, derived from world state markets)
 * - collectTelemetry: whether to populate telemetry (default true)
 *
 * Returns a PhaseHandler that can be injected into the orchestrator.
 *
 * M3 note: This establishes the integration boundary. Production intents and
 * multi-market clearing will be wired in later milestones.
 */
export const createPhase8Handler = (options?: {
  getFixtureIntents?: (world: WorldState, context: TickContext) => MarketIntent[];
  getFixtureMarketIds?: (world: WorldState) => Map<string, MarketId>;
  collectTelemetry?: boolean;
}): PhaseHandler => {
  const collectTelemetry = options?.collectTelemetry !== false;
  const getFixtureIntents = options?.getFixtureIntents;
  const getFixtureMarketIds = options?.getFixtureMarketIds;

  return (
    world: WorldState,
    context: TickContext,
    pendingTransitions: PendingTransitions,
  ): TickContext => {
    // Only execute during Phase-8
    if (context.phase !== 8) {
      return context;
    }

    // M3 Phase-8: Clearing always executes when fixture intents are provided;
    // collectTelemetry only controls whether telemetry is additionally emitted,
    // so enabling/disabling telemetry cannot change which allocations are produced.
    // Production clearing uses actual Phase-2/3 intents in later milestones

    if (!getFixtureIntents) {
      return context;
    }

    const intents = getFixtureIntents(world, context);
    const marketIds = getFixtureMarketIds?.(world) ?? new Map();
    const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
    const taxRate = 0.1; // M3 fixture tax rate

    // Group intents by market/good/pass
    const intentsByMarketGoodPass = new Map<string, {
      buyers: MarketIntent[];
      sellers: MarketIntent[];
      marketId: MarketId;
      regionId: string;
      goodId: string;
    }>();

    for (const intent of intents) {
      const marketId = marketIds.get(intent.regionId) || ("market:1" as MarketId);
      const key = `${marketId}|${intent.goodId}|MAIN`;

      if (!intentsByMarketGoodPass.has(key)) {
        intentsByMarketGoodPass.set(key, {
          buyers: [],
          sellers: [],
          marketId,
          regionId: intent.regionId,
          goodId: intent.goodId,
        });
      }

      const group = intentsByMarketGoodPass.get(key)!;
      if (intent.side === "BUY") {
        group.buyers.push(intent);
      } else {
        group.sellers.push(intent);
      }
    }

    // Process each market/good/pass combination through production clearing
    const newTelemetry: typeof context.marketTelemetry = [];
    const newAllocations: typeof context.marketAllocations = [];
    const allocationIdCounter = { value: 0 };

    for (const group of intentsByMarketGoodPass.values()) {
      if (group.buyers.length === 0 || group.sellers.length === 0) {
        continue;
      }

      // Use the price Phase 6 produced this tick when present (Handoff/04 section 9:
      // "Phase 7 trade and Phase 8 clearing use the resulting Phase-6 price"), falling
      // back to the world's current price so callers that only exercise Phase 8 in
      // isolation (no Phase-6 handler run this tick) are unaffected.
      const market = world.markets.get(group.marketId);
      const marketPrice =
        context.marketPrices.get(marketPriceKey(group.marketId, group.goodId as GoodId)) ??
        market?.priceByGood.get(group.goodId as GoodId) ??
        10;

      // Create clearing input with production computations
      const clearingInput: LocalClearingInput = {
        marketId: group.marketId,
        regionId: group.regionId as RegionId,
        goodId: group.goodId as GoodId,
        pass: "MAIN",
        marketCurrencyId: "cur:reserve" as CurrencyId,
        buyerIntents: group.buyers,
        sellerIntents: group.sellers,
        computeEffectiveDemand: (intent, grossPrice) => {
          if (intent.side !== "BUY") return 0;
          // Effective demand: min of desired quantity and maxSpend / grossPrice
          const maxAffordable = (intent as any).maxSpend
            ? (intent as any).maxSpend / grossPrice
            : intent.desiredQuantity;
          return Math.min(intent.desiredQuantity, Math.max(0, maxAffordable));
        },
        computeSellableQuantity: (intent) => {
          if (intent.side !== "SELL") return 0;
          // For M3 fixtures, assume all desired quantity is available
          return intent.desiredQuantity;
        },
        computeGrossUnitPrice: (_intent, sellerNetPrice) => {
          // Apply consumption tax to get household gross price
          return sellerNetPrice * (1 + taxRate);
        },
        getTaxationInfo: (_buyer, _regionId, _good) => {
          return {
            destinationStateId: null,
            assessedTaxRate: taxRate,
            collectionEfficiency: 1.0,
          };
        },
      };

      // Execute production clearing algorithm. This runs identically regardless
      // of collectTelemetry, so allocations never depend on the telemetry toggle.
      const allocations = computeLocalClearing(
        clearingInput,
        new Map(), // M3: no commitment ledger tracking yet
        marketPrice,
        quantityEpsilon,
        allocationIdCounter,
      );
      newAllocations.push(...allocations);

      if (!collectTelemetry) {
        continue;
      }

      // Build telemetry from production clearing results
      const builder = new LocalMarketTelemetryBuilder(
        group.marketId,
        group.regionId as RegionId,
        group.goodId as GoodId,
        "MAIN",
        quantityEpsilon,
      );

      // Compute quantities from clearing results
      const totalBuyerDesired = group.buyers.reduce((sum, i) => sum + i.desiredQuantity, 0);
      const totalSellerOffered = group.sellers.reduce((sum, i) => sum + i.desiredQuantity, 0);

      // Effective demand: computed for each buyer using production formula
      let totalBuyerEffective = 0;
      const grossPrice = marketPrice * (1 + taxRate);
      for (const buyer of group.buyers) {
        const buyerMaxSpend = (buyer as any).maxSpend ?? (buyer.desiredQuantity * grossPrice);
        totalBuyerEffective += Math.min(buyer.desiredQuantity, buyerMaxSpend / grossPrice);
      }

      // Cleared quantity from allocations
      const totalCleared = allocations.reduce((sum, a) => sum + a.quantity, 0);
      const totalTaxCollected = allocations.reduce((sum, a) => sum + a.consumptionTaxAmount, 0);

      builder.setClearingQuantities(
        totalBuyerDesired,
        totalBuyerEffective,
        totalSellerOffered,
        totalCleared,
      );

      builder.setPrices(marketPrice, grossPrice);
      builder.addConsumptionTax(totalTaxCollected);

      newTelemetry.push(builder.build());
    }

    return {
      ...context,
      marketTelemetry: [...context.marketTelemetry, ...newTelemetry],
      marketAllocations: [...context.marketAllocations, ...newAllocations],
    };
  };
};

/**
 * Default Phase-8 handler: no telemetry collection (M2 compatibility).
 */
export const defaultPhase8MainMarketClearingHandler: PhaseHandler =
  createPhase8Handler({ collectTelemetry: false });
