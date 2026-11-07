/**
 * M5 / REQ-MARKET-007: opt-in Phase-6 price formation from actual Phase-2/4/5
 * intents instead of external/fixture price or intent injection.
 *
 * This is only the ownership-aware price-input adapter. The canonical Phase-6
 * log-space repricing formula remains in phase6MarketPriceFormation.ts.
 * Later M5 wiring still owns full autonomous Phase-7 route dispatch.
 */
import type { MarketId } from "../domain/id";
import type { MarketIntent } from "./marketIntent";
import { createPhase6Handler, type Phase6PriceConfig } from "./phase6MarketPriceFormation";
import { derivePhase7PostProcurementIntents } from "./phase7PostProcurementIntents";
import type { WorldState } from "./worldState";
import type { PhaseHandler } from "./tickOrchestrator";

/** Only persisted markets may set a Phase-6 net quote. Never use the
 * fixture-only market:1 fallback or a synthetic prior price of 10. */
function canonicalMarketIds(world: WorldState): Map<string, MarketId> {
  const byRegion = new Map<string, MarketId>();
  for (const region of world.regions.values()) {
    const markets = [...world.markets.values()].filter(
      market => market.seed.regionKey === region.seed.key,
    );
    if (markets.length > 1) {
      throw new Error("Phase-6 canonical intake requires one LocalMarket per Region");
    }
    if (markets.length === 1) byRegion.set(String(region.regionId), markets[0]!.marketId);
  }
  return byRegion;
}

/**
 * Call after genuine Phase-2 plans, Phase-4 realized allocations and Phase-5
 * offers have reached TickContext. It reprices only goods present in the
 * remaining canonical intentions; it does not invent empty-region demand.
 *
 * The residual Phase-4 quantity and budget are identical to the inputs later
 * used by Phase-7 and Phase-8. The existing Phase-6 primitive still treats
 * seller offers as stated supply; physical inventory and settlement are
 * separately checked by the downstream market/trade owners.
 */
export function createPhase6CanonicalPostProcurementPriceHandler(
  priceConfig: Phase6PriceConfig,
): PhaseHandler {
  return createPhase6Handler({
    priceConfig,
    getFixtureIntents: (world, context): MarketIntent[] => {
      const intents = derivePhase7PostProcurementIntents(world, context, 6).phase8MainIntents;
      const byRegion = canonicalMarketIds(world);
      for (const intent of intents) {
        const marketId = byRegion.get(String(intent.regionId));
        const market = marketId === undefined ? undefined : world.markets.get(marketId);
        if (!market) {
          throw new Error("Phase-6 canonical intake requires a persisted market for each intent Region");
        }
        const price = market.priceByGood.get(intent.goodId);
        if (price === undefined || !Number.isFinite(price) || price <= 0) {
          throw new Error("Phase-6 canonical intake requires a finite positive prior-close net price");
        }
      }
      return [...intents];
    },
    getFixtureMarketIds: canonicalMarketIds,
  });
}
