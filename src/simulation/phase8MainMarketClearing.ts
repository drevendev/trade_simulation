/**
 * Phase-8 handler: Residual local main-market clearing and settlement with telemetry.
 *
 * Phase-8 is "Residual local main-market clearing" per CORE_SCHEMA_AND_LIFECYCLES.md section 10.
 * For M3, this handler:
 * 1. Executes clearing for seeded market scenarios with fixture intents
 * 2. Collects deterministic market telemetry (REQ-MARKET-005)
 * 3. Returns updated TickContext with telemetry
 *
 * Telemetry is non-authoritative diagnostic output; enabled/disabled runs
 * produce identical canonical stocks, allocations, and replay hash.
 */

import type { MarketId } from "../domain/id";
import type { WorldState } from "./worldState";
import type { TickContext, PhaseHandler } from "./tickOrchestrator";
import type { PendingTransitions } from "./worldState";
import type { MarketIntent } from "./marketIntent";
import { LocalMarketTelemetryBuilder } from "./marketTelemetry";

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
    // M3 Phase-8: Clearing with optional telemetry collection
    // If fixture intents are provided (for testing), collect telemetry from them
    // Production clearing uses actual Phase-2/3 intents in later milestones

    if (collectTelemetry && getFixtureIntents) {
      const intents = getFixtureIntents(world, context);
      const marketIds = getFixtureMarketIds?.(world) ?? new Map();

      const newTelemetry = intents.map((intent) => {
        // Get market ID for this region, or use a fixture default
        const marketId =
          marketIds.get(intent.regionId) || ("market:1" as MarketId);

        // For each intent, create a minimal telemetry record to demonstrate collection
        const builder = new LocalMarketTelemetryBuilder(
          marketId,
          intent.regionId,
          intent.goodId,
          "MAIN",
          world.simulationConfig.numeric.quantityEpsilon ?? 1e-9,
        );

        // Fixture telemetry: simulate clearing quantities from intent
        builder.setClearingQuantities(
          intent.desiredQuantity, // desiredDemand
          intent.desiredQuantity, // effectiveDemand
          intent.desiredQuantity, // offeredQuantity
          Math.min(intent.desiredQuantity * 0.75, intent.desiredQuantity), // clearedQuantity (75% of desired)
        );

        // Add prices from market if available, else use fixture values
        const market = world.markets.get(marketId);
        const price = market?.priceByGood.get(intent.goodId) ?? 10;
        const taxRate = 0.1; // Fixture tax rate
        const householdGrossPrice = price * (1 + taxRate);
        builder.setPrices(price, householdGrossPrice);
        builder.addConsumptionTax(price * taxRate * intent.desiredQuantity);

        return builder.build();
      });

      return {
        ...context,
        marketTelemetry: [...context.marketTelemetry, ...newTelemetry],
      };
    }

    // No-op if no fixture intents provided or telemetry collection disabled
    return context;
  };
};

/**
 * Default Phase-8 handler: no telemetry collection (M2 compatibility).
 */
export const defaultPhase8MainMarketClearingHandler: PhaseHandler =
  createPhase8Handler({ collectTelemetry: false });
