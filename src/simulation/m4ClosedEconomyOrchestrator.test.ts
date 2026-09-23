import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { MarketId } from "../domain/id";
import { executeM4ClosedEconomyTick, type M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import { buildInitialWorld, type WorldState } from "./worldState";

const m4NeedCategories: Readonly<Record<string, NeedCategoryDefinition>> = {
  subsistence: {
    id: "subsistence",
    perCapitaTarget: 1,
    priority: 3,
    substitutionGoods: [
      { goodId: "good:food" as any, basePreference: 1, qualityFactor: 1 },
      { goodId: "good:grain" as any, basePreference: 0.5, qualityFactor: 1 },
    ],
    priceSensitivity: 1,
    inventoryCarryoverTicks: 1,
  },
  material: {
    id: "material",
    perCapitaTarget: 0.1,
    priority: 2,
    substitutionGoods: [{ goodId: "good:wood" as any, basePreference: 1, qualityFactor: 1 }],
    priceSensitivity: 1,
    inventoryCarryoverTicks: 2,
  },
  clothing: {
    id: "clothing",
    perCapitaTarget: 0.1,
    priority: 1,
    substitutionGoods: [{ goodId: "good:cloth" as any, basePreference: 1, qualityFactor: 1 }],
    priceSensitivity: 1,
    inventoryCarryoverTicks: 2,
  },
};

function baselineWorld(): WorldState {
  return buildInitialWorld(
    baselineScenario,
    { ...baselineDefinitionPack, needCategories: m4NeedCategories },
    createDefaultSimulationConfig(),
    42,
  );
}

function oneRegionWorld(): WorldState {
  const world = baselineWorld();
  const region = [...world.regions.values()]
    .sort((left, right) => String(left.regionId).localeCompare(String(right.regionId)))
    .find((candidate) =>
      [...world.markets.values()].some((market) => market.seed.regionKey === candidate.seed.key) &&
      [...world.productionUnits.values()].some((unit) => unit.seed.regionKey === candidate.seed.key) &&
      [...world.cohorts.values()].some((cohort) => cohort.seed.regionKey === candidate.seed.key),
    );
  expect(region).toBeDefined();
  const regionKey = region!.seed.key;
  const regions = new Map([[region!.regionId, region!]]);
  const markets = new Map(
    [...world.markets.entries()].filter(([, market]) => market.seed.regionKey === regionKey),
  );
  const productionUnits = new Map(
    [...world.productionUnits.entries()].filter(([, unit]) => unit.seed.regionKey === regionKey),
  );
  const cohorts = new Map(
    [...world.cohorts.entries()].filter(([, cohort]) => cohort.seed.regionKey === regionKey),
  );
  return { ...world, regions, markets, productionUnits, cohorts };
}

function options(world: WorldState): M4ClosedEconomyOptions {
  const market = world.simulationConfig.markets;
  expect(market.shortageSignalWeight).toBeDefined();
  expect(market.inventorySignalWeight).toBeDefined();
  expect(market.basePriceAdjustmentSpeed).toBeDefined();
  expect(market.maxAbsoluteLogPriceMovePerTick).toBeDefined();
  expect(market.targetInventoryCoverageTicks).toBeDefined();
  return {
    taxPolicy: {
      getConsumptionTaxRate: () => 0,
      getCollectionEfficiency: () => 1,
    },
    wageTaxPolicy: {
      assessWageIncomeTax: () => 0,
      getCollectionEfficiency: () => 1,
    },
    priceConfig: {
      shortageSignalWeight: market.shortageSignalWeight!,
      inventorySignalWeight: market.inventorySignalWeight!,
      basePriceAdjustmentSpeed: market.basePriceAdjustmentSpeed!,
      maxAbsoluteLogPriceMovePerTick: market.maxAbsoluteLogPriceMovePerTick!,
      targetInventoryCoverageTicks: market.targetInventoryCoverageTicks!,
      minimumPrice: 0.01,
      maximumPrice: 1_000_000,
    },
    collectMarketTelemetry: true,
  };
}

function reverseMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return new Map([...source.entries()].reverse());
}

function normalizedOutcome(world: WorldState, result: ReturnType<typeof executeM4ClosedEconomyTick>): string {
  const sortedEntries = <K extends string>(values: ReadonlyMap<K, number>) =>
    [...values.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
  return JSON.stringify({
    phaseTrace: result.phaseTrace,
    transactions: result.context.transactions.map((transaction) => ({
      id: transaction.transactionId,
      type: transaction.type,
      phase: transaction.phase,
      amount: transaction.amount,
    })),
    phase4: (result.context.phase4MarketAllocations ?? []).map((allocation) => ({
      id: allocation.id,
      q: allocation.quantity,
      buyer: allocation.buyerIntentId,
      seller: allocation.sellerIntentId,
    })),
    main: result.context.marketAllocations.map((allocation) => ({
      id: allocation.id,
      q: allocation.quantity,
      buyer: allocation.buyerIntentId,
      seller: allocation.sellerIntentId,
    })),
    units: [...world.productionUnits.values()]
      .sort((left, right) => String(left.productionUnitId).localeCompare(String(right.productionUnitId)))
      .map((unit) => ({
        id: unit.productionUnitId,
        status: unit.status,
        wageOffer: unit.wageOffer,
        capital: unit.installedCapital,
        wallet: sortedEntries(unit.wallet),
        input: sortedEntries(unit.inputInventory),
        output: sortedEntries(unit.outputInventory),
        investment: sortedEntries(unit.investmentInventory),
      })),
    cohorts: [...world.cohorts.values()]
      .sort((left, right) => String(left.cohortId).localeCompare(String(right.cohortId)))
      .map((cohort) => ({
        id: cohort.cohortId,
        wallet: sortedEntries(cohort.wallet),
        inventory: sortedEntries(cohort.householdInventory),
      })),
    markets: [...world.markets.values()]
      .sort((left, right) => String(left.marketId).localeCompare(String(right.marketId)))
      .map((market) => ({
        id: market.marketId as MarketId,
        prices: sortedEntries(market.priceByGood),
      })),
  });
}

describe("REQ-PRODUCTION-008 canonical M4 closed-economy orchestration", () => {
  it("threads one Region through phases 0..15 and persists M4 transitions in causal order", () => {
    const opening = oneRegionWorld();
    const openingProductionTick = opening.lastProductionExecutionTransitionTick;
    const openingWageTick = opening.lastWageSettlementTransitionTick;
    const openingHouseholdTick = opening.lastHouseholdConsumptionTransitionTick;
    const openingCapitalTick = opening.lastCapitalFormationTransitionTick;

    const result = executeM4ClosedEconomyTick(opening, 0, options(opening));

    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.world).not.toBe(opening);
    expect(result.world.lastProductionExecutionTransitionTick).toBe(0);
    expect(result.world.lastWageSettlementTransitionTick).toBe(0);
    expect(result.world.lastHouseholdConsumptionTransitionTick).toBe(0);
    expect(result.world.lastCapitalFormationTransitionTick).toBe(0);
    expect(result.context.productionPlans?.length).toBe(opening.productionUnits.size);
    expect(result.context.laborAllocations).toBeDefined();
    expect(result.context.householdConsumptionExecutions).toBeDefined();
    expect(result.context.capitalFormationExecutions).toBeDefined();
    expect(result.context.productionUnitLifecycleReviews).toBeDefined();
    expect((result.context.phase4MarketAllocations ?? []).every((allocation) => allocation.pass === "PRE_PRODUCTION")).toBe(true);
    expect(result.context.marketAllocations.every((allocation) => allocation.pass === "MAIN")).toBe(true);
    expect(result.context.transactions.some((transaction) => transaction.phase === 7)).toBe(false);

    // The caller-owned opening state is unchanged; all settlement/persistence is explicit.
    expect(opening.lastProductionExecutionTransitionTick).toBe(openingProductionTick);
    expect(opening.lastWageSettlementTransitionTick).toBe(openingWageTick);
    expect(opening.lastHouseholdConsumptionTransitionTick).toBe(openingHouseholdTick);
    expect(opening.lastCapitalFormationTransitionTick).toBe(openingCapitalTick);
  });

  it("is stable under irrelevant live-map insertion-order changes", () => {
    const opening = oneRegionWorld();
    const reordered: WorldState = {
      ...opening,
      regions: reverseMap(opening.regions),
      states: reverseMap(opening.states),
      currencies: reverseMap(opening.currencies),
      clans: reverseMap(opening.clans),
      cohorts: reverseMap(opening.cohorts),
      productionUnits: reverseMap(opening.productionUnits),
      markets: reverseMap(opening.markets),
    };

    const left = executeM4ClosedEconomyTick(opening, 0, options(opening));
    const right = executeM4ClosedEconomyTick(reordered, 0, options(reordered));

    expect(normalizedOutcome(left.world, left)).toBe(normalizedOutcome(right.world, right));
  });
});
