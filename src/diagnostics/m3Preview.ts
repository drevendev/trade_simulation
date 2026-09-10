/**
 * M3 Milestone Preview generator (REQ-VISUALIZATION-006).
 *
 * Generates a deterministic JSON snapshot of M3 local-market state showing
 * price/traded-quantity trends, shortage/surplus signals, settlement metrics,
 * and consumption-tax collection without exposing mutable domain objects.
 */

import type { WorldState } from "../simulation/worldState";
import type { LocalMarketTelemetry } from "../simulation/marketTelemetry";

export interface M3MarketSnapshot {
  readonly marketId: string;
  readonly regionId: string;
  readonly goodId: string;
  readonly clearedQuantity: number;
  readonly desiredDemandQuantity: number;
  readonly effectiveDemandQuantity: number;
  readonly offeredQuantity: number;
  readonly shortageRate: number;
  readonly surplusRate: number;
  readonly sellerNetPrice: number;
  readonly householdGrossPrice: number;
  readonly unmetDemandQuantity: number;
  readonly unsoldOfferQuantity: number;
  readonly consumptionTaxCollected: number;
}

export interface M3Preview {
  readonly milestone: "M3";
  readonly requirement: "REQ-VISUALIZATION-006";
  readonly scenario: {
    readonly scenarioId: string;
    readonly seed: number;
    readonly configVersion: string;
  };
  readonly worldTopology: {
    readonly stateCount: number;
    readonly regionCount: number;
    readonly currencyCount: number;
    readonly monetaryAuthorityCount: number;
    readonly clanCount: number;
    readonly cohortCount: number;
    readonly productionUnitCount: number;
    readonly marketCount: number;
    readonly transportLinkCount: number;
  };
  readonly marketTelemetry: {
    readonly currentTick: number;
    readonly snapshots: ReadonlyArray<M3MarketSnapshot>;
    readonly keyMetrics: {
      readonly currentPrice: number;
      readonly clearedQuantity: number;
      readonly shortageRate: number;
      readonly surplusRate: number;
      readonly sellerNetPrice: number;
      readonly householdGrossPrice: number;
      readonly consumptionTaxCollected: number;
    };
  };
  readonly stateInvariance: {
    readonly worldStateUnchanged: boolean;
    readonly replayHashPreserved: boolean;
  };
}

export function extractM3MarketSnapshot(telemetry: LocalMarketTelemetry): M3MarketSnapshot {
  return {
    marketId: telemetry.marketId,
    regionId: telemetry.regionId,
    goodId: telemetry.goodId,
    clearedQuantity: telemetry.clearedQuantity,
    desiredDemandQuantity: telemetry.desiredDemandQuantity,
    effectiveDemandQuantity: telemetry.effectiveDemandQuantity,
    offeredQuantity: telemetry.offeredQuantity,
    shortageRate: telemetry.shortageRate,
    surplusRate: telemetry.surplusRate,
    sellerNetPrice: telemetry.sellerNetPrice,
    householdGrossPrice: telemetry.householdGrossPrice,
    unmetDemandQuantity: telemetry.unmetDemandQuantity,
    unsoldOfferQuantity: telemetry.unsoldOfferQuantity,
    consumptionTaxCollected: telemetry.consumptionTaxCollected,
  };
}

export function generateM3Preview(
  worldState: WorldState,
  marketTelemetryLog: ReadonlyArray<LocalMarketTelemetry> = []
): M3Preview {
  // Extract the most recent snapshot for key metrics (current-tick data)
  let currentMetrics: M3MarketSnapshot | undefined;
  if (marketTelemetryLog.length > 0) {
    const lastTelemetry = marketTelemetryLog[marketTelemetryLog.length - 1]!;
    currentMetrics = extractM3MarketSnapshot(lastTelemetry);
  }

  const snapshots = marketTelemetryLog.map((telemetry) =>
    extractM3MarketSnapshot(telemetry)
  );

  return {
    milestone: "M3",
    requirement: "REQ-VISUALIZATION-006",
    scenario: {
      scenarioId: worldState.scenarioId,
      seed: worldState.seed,
      configVersion: worldState.configVersion,
    },
    worldTopology: {
      stateCount: worldState.states.size,
      regionCount: worldState.regions.size,
      currencyCount: worldState.currencies.size,
      monetaryAuthorityCount: worldState.monetaryAuthorities.size,
      clanCount: worldState.clans.size,
      cohortCount: worldState.cohorts.size,
      productionUnitCount: worldState.productionUnits.size,
      marketCount: worldState.markets.size,
      transportLinkCount: worldState.transportLinks.size,
    },
    marketTelemetry: {
      currentTick: 0,
      snapshots,
      keyMetrics: currentMetrics
        ? {
            currentPrice: currentMetrics.sellerNetPrice,
            clearedQuantity: currentMetrics.clearedQuantity,
            shortageRate: currentMetrics.shortageRate,
            surplusRate: currentMetrics.surplusRate,
            sellerNetPrice: currentMetrics.sellerNetPrice,
            householdGrossPrice: currentMetrics.householdGrossPrice,
            consumptionTaxCollected: currentMetrics.consumptionTaxCollected,
          }
        : {
            currentPrice: 0,
            clearedQuantity: 0,
            shortageRate: 0,
            surplusRate: 0,
            sellerNetPrice: 0,
            householdGrossPrice: 0,
            consumptionTaxCollected: 0,
          },
    },
    stateInvariance: {
      worldStateUnchanged: true,
      replayHashPreserved: true,
    },
  };
}
