/**
 * #677: a reproducible, read-only M5 Pages scenario.
 *
 * This fixture is intentionally small and hypothetical. Its paid trades,
 * tariffs, liquidity transfers, cargo and rate movement come exclusively from
 * the canonical 16-phase M5 runner, not from fixture-authored preview numbers.
 * It does not add policies to the economic engine or feed projections back.
 */
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import {
  executeM5AutonomousRegionalTradeTick,
  type M5AutonomousRegionalTradeOptions,
} from "../simulation/m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "../simulation/tickOrchestrator";
import {
  buildInitialWorld,
  type ProductionUnitState,
  type RegionState,
  type WorldState,
} from "../simulation/worldState";
import { projectM5TradeTick, type M5TradeTickPreview } from "./m5TradePreview";

export const M5_PREVIEW_TICK = 7;
const IRON = "good:iron" as GoodId;

const phase1Jurisdictions: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return {
      ...context,
      effectiveJurisdictionByRegion: new Map([...world.regions].map(
        ([id, region]) => [id, region.controllerStateId] as const,
      )),
    };
  }
  // The autonomous regional planner supplies real Phase-2 production demand.
  // No fabricated household demand is needed to force cross-border trading.
  return context.phase === 2
    ? { ...context, householdMarketIntents: [] }
    : context;
};

export interface M5PreviewScenario {
  readonly opening: WorldState;
  readonly options: M5AutonomousRegionalTradeOptions;
}

export function createM5PreviewScenario(): M5PreviewScenario {
  const initial = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
  );
  const source = [...initial.regions.values()].find(
    region => region.seed.key === "region:a4-border",
  );
  const destination = [...initial.regions.values()].find(
    region => region.seed.key === "region:b4-chokepoint",
  );
  if (!source || !destination || source.settlementCurrencyId === destination.settlementCurrencyId) {
    throw new Error("M5 preview requires two different settlement currencies");
  }
  const link = [...initial.transportLinks.values()].find(
    candidate => candidate.fromRegionId === source.regionId &&
      candidate.toRegionId === destination.regionId,
  );
  if (!link) throw new Error("M5 preview requires the real directed border link");
  const templates = [...initial.productionUnits.values()].slice(0, 4);
  if (templates.length !== 4) throw new Error("M5 preview requires four production units");

  function unit(
    template: ProductionUnitState, region: RegionState,
    status: "ACTIVE" | "CLOSING", cash: number, iron: number,
  ): ProductionUnitState {
    return {
      ...template,
      seed: { ...template.seed, regionKey: region.seed.key, recipeId: "recipe:tools-craft" },
      status,
      installedCapital: status === "ACTIVE" ? 5 : 0,
      wallet: new Map([[region.settlementCurrencyId, cash]]),
      inputInventory: iron === 0 ? new Map() : new Map([[IRON, iron]]),
      outputInventory: new Map(),
      investmentInventory: new Map(),
    };
  }
  const productionUnits = [
    unit(templates[0]!, source, "ACTIVE", 1_000_000, 0),
    unit(templates[1]!, source, "CLOSING", 5, 500),
    unit(templates[2]!, destination, "ACTIVE", 1_000_000, 0),
    unit(templates[3]!, destination, "CLOSING", 5, 2),
  ];
  const matchesPair = (base: string, quote: string) =>
    (base === source.settlementCurrencyId && quote === destination.settlementCurrencyId) ||
    (quote === source.settlementCurrencyId && base === destination.settlementCurrencyId);
  const poolIds = [...initial.monetaryAuthorities.values()].flatMap(
    authority => [...authority.fxPools].filter(
      ([, pool]) => matchesPair(pool.baseCurrencyId, pool.quoteCurrencyId),
    ).map(([id]) => id),
  );
  if (poolIds.length < 1) throw new Error("M5 preview requires canonical issuer FX liquidity");
  const selectedPoolId = poolIds[0]!;
  // There must be exactly one eligible issuer pool; otherwise the canonical
  // Phase-7 quote owner correctly refuses to trade as ambiguous.
  const monetaryAuthorities = new Map([...initial.monetaryAuthorities].map(
    ([id, authority]) => [
      id, {
        ...authority,
        fxPools: new Map([...authority.fxPools].filter(([poolId]) => poolId === selectedPoolId)),
      },
    ] as const,
  ));
  const opening: WorldState = {
    ...initial,
    regions: new Map([
      [source.regionId, source], [destination.regionId, destination],
    ]),
    markets: new Map([...initial.markets].filter(
      ([, market]) => market.seed.regionKey === source.seed.key ||
        market.seed.regionKey === destination.seed.key,
    ).map(([id, market]) => [id, {
      ...market,
      priceByGood: new Map(market.priceByGood).set(
        IRON, market.seed.regionKey === source.seed.key ? 1 : 100,
      ),
    }] as const)),
    productionUnits: new Map(productionUnits.map(item => [item.productionUnitId, item] as const)),
    transportLinks: new Map([[link.linkId, link]]),
    monetaryAuthorities,
  };
  const market = opening.simulationConfig.markets;
  const options: M5AutonomousRegionalTradeOptions = {
    procurement: {
      taxPolicy: { getConsumptionTaxRate: () => 0.05, getCollectionEfficiency: () => 1 },
      wageTaxPolicy: { assessWageIncomeTax: () => 0, getCollectionEfficiency: () => 1 },
      priceConfig: {
        shortageSignalWeight: market.shortageSignalWeight!,
        inventorySignalWeight: market.inventorySignalWeight!,
        basePriceAdjustmentSpeed: market.basePriceAdjustmentSpeed!,
        maxAbsoluteLogPriceMovePerTick: market.maxAbsoluteLogPriceMovePerTick!,
        targetInventoryCoverageTicks: market.targetInventoryCoverageTicks!,
        minimumPrice: 0.001,
        maximumPrice: 1_000_000,
      },
    },
    scorePolicy: {
      tradeProfitWeight: 1, shortageWeight: 1,
      minimumTradeScore: -100, maximumShortagePremiumShare: 1,
    },
    transportFeeCostPolicy: {
      minimumConditionForCost: 0.01, maximumConditionCostMultiplier: 10,
    },
    infrastructureFactors: new Map([[link.linkId, 1]]),
    phase1TradeLawProvider: query =>
      query.linkId === link.linkId && query.goodId === IRON ? null : undefined,
    phase1TariffLawProvider: query => query.goodId === IRON ? 0.1 : 0,
    settleMainMarketInPhase8: true,
    closeFxAtPhase11: {
      flowPressureAlpha: 0.25, flowCoefficient: 0.08,
      reserveCoefficient: 0.02, maxAbsoluteLogMovePerTick: 0.03,
    },
  };
  return { opening, options };
}

/** One real execution, then one-way projection of actual committed receipts. */
export function generateM5Preview(scenario: M5PreviewScenario): M5TradeTickPreview {
  const { opening, options } = scenario;
  const result = executeM5AutonomousRegionalTradeTick(
    opening, M5_PREVIEW_TICK, phase1Jurisdictions,
    (_phase, current) => current, options,
  );
  const preview = projectM5TradeTick(
    opening, result, M5_PREVIEW_TICK, options.infrastructureFactors,
  );
  if (preview.routes.every(route => route.departures.length === 0) ||
      preview.routes.every(route => route.departures.every(cargo => cargo.fxSettlementId === null)) ||
      preview.fxPools.every(pool => pool.spotBefore === pool.spotAfter)) {
    throw new Error("M5 preview fixture lacks paid FX cargo or source-backed FX rate movement");
  }
  return preview;
}

/** Stable JSON for a later checked-in Pages artifact; never substitute fake data. */
export function serializeM5Preview(scenario: M5PreviewScenario): string {
  return JSON.stringify(generateM5Preview(scenario), null, 2) + "\n";
}
