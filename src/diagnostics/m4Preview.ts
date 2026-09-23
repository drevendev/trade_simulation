/**
 * Deterministic M4 Milestone Preview projection (REQ-VISUALIZATION-009).
 *
 * The preview executes the already-canonical one-region M4 runner and projects a compact
 * read-only trace for GitHub Pages. It defines no economic formula and never feeds data
 * back into WorldState. The keyed RNG used by the engine has no mutable cursor, so a
 * diagnostic run cannot consume randomness from a later authoritative run.
 */

import type { NeedCategoryDefinition } from "../config/definitionPack";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import {
  executeM4ClosedEconomyTick,
  type M4ClosedEconomyOptions,
} from "../simulation/m4ClosedEconomyOrchestrator";
import { buildInitialWorld, type WorldState } from "../simulation/worldState";

const REGION_KEY = "region:a1-capital";
const FOOD = "good:food" as GoodId;
const TOOLS = "good:tools" as GoodId;

export const M4_PREVIEW_TICKS = 60;
export const M4_PREVIEW_SAMPLE_EVERY = 5;

const needCategories: Readonly<Record<string, NeedCategoryDefinition>> = {
  ESSENTIAL_FOOD: {
    id: "ESSENTIAL_FOOD",
    perCapitaTarget: 1,
    priority: 4,
    substitutionGoods: [
      { goodId: "good:food" as GoodId, basePreference: 1, qualityFactor: 1 },
      { goodId: "good:grain" as GoodId, basePreference: 0.5, qualityFactor: 1 },
    ],
    priceSensitivity: 1,
    inventoryCarryoverTicks: 1,
  },
  BASIC_GOODS: {
    id: "BASIC_GOODS",
    perCapitaTarget: 0.1,
    priority: 3,
    substitutionGoods: [{ goodId: "good:wood" as GoodId, basePreference: 1, qualityFactor: 1 }],
    priceSensitivity: 1,
    inventoryCarryoverTicks: 2,
  },
  SERVICES: {
    id: "SERVICES",
    perCapitaTarget: 0.1,
    priority: 2,
    substitutionGoods: [{ goodId: "good:tools" as GoodId, basePreference: 1, qualityFactor: 1 }],
    priceSensitivity: 1,
    inventoryCarryoverTicks: 1,
  },
  COMFORT: {
    id: "COMFORT",
    perCapitaTarget: 0.1,
    priority: 1,
    substitutionGoods: [{ goodId: "good:cloth" as GoodId, basePreference: 1, qualityFactor: 1 }],
    priceSensitivity: 1,
    inventoryCarryoverTicks: 2,
  },
};

export interface M4PreviewSample {
  readonly tick: number;
  /** Realized Phase-5 output across the one-region ProductionUnits, goods units this tick. */
  readonly outputProduced: number;
  /** Realized Phase-3 employment, worker-equivalents this tick. */
  readonly employedWorkers: number;
  /** Realized Phase-5 gross payroll, settlement-currency units this tick. */
  readonly grossWagesPaid: number;
  /** Arithmetic mean of canonical Phase-9 essential-need coverage across Cohorts. */
  readonly essentialCoverage: number;
  /** Canonical food stock across selected Cohorts/ProductionUnits plus the selected Region controller State. */
  readonly foodInventory: number;
  /** Persistent installed capital across the one-region ProductionUnits. */
  readonly installedCapital: number;
}

export interface M4Preview {
  readonly milestone: "M4";
  readonly requirement: "REQ-VISUALIZATION-009";
  readonly scenario: {
    readonly scenarioId: string;
    readonly seed: number;
    readonly configVersion: string;
    readonly ticksExecuted: number;
    readonly sampleEveryTicks: number;
  };
  readonly region: {
    readonly name: string;
    readonly currencyCode: string;
    readonly foodGoodName: string;
    readonly goodsUnitLabel: string;
    readonly workerUnitLabel: "worker-equivalents";
    readonly capitalUnitLabel: "capital units";
  };
  readonly samples: readonly M4PreviewSample[];
  readonly totals: {
    readonly outputProduced: number;
    readonly grossWagesPaid: number;
    readonly capitalBuilt: number;
    readonly householdPurchaseQuantity: number;
  };
}

function options(world: WorldState): M4ClosedEconomyOptions {
  const market = world.simulationConfig.markets;
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

/**
 * Build the deterministic one-region presentation fixture from canonical baseline data.
 * This mirrors the accepted M4 golden's non-vacuity setup: one mine receives one real-goods
 * investment bundle, one existing food producer is located in the region, and opening
 * household food is zeroed so Phase 8/9 must exercise real purchase and need realization.
 */
export function createM4PreviewWorld(): WorldState {
  const baseline = buildInitialWorld(
    baselineScenario,
    { ...baselineDefinitionPack, needCategories },
    createDefaultSimulationConfig(),
    42,
  );
  const region = [...baseline.regions.values()].find((candidate) => candidate.seed.key === REGION_KEY);
  if (region === undefined) throw new Error(`M4 preview region ${REGION_KEY} is missing`);

  const marketEntry = [...baseline.markets.entries()].find(([, candidate]) => candidate.seed.regionKey === REGION_KEY);
  if (marketEntry === undefined) throw new Error(`M4 preview market for ${REGION_KEY} is missing`);

  const ironMine = [...baseline.productionUnits.values()].find(
    (unit) => unit.seed.regionKey === REGION_KEY && unit.seed.recipeId === "recipe:iron-mine" && unit.status === "ACTIVE",
  );
  if (ironMine === undefined) throw new Error("M4 preview active iron mine is missing");

  const householdSupplier = [...baseline.productionUnits.values()].find(
    (unit) =>
      unit.seed.regionKey === "region:a2-farm" &&
      unit.seed.recipeId === "recipe:food-harvest" &&
      unit.status === "ACTIVE",
  );
  if (householdSupplier === undefined) throw new Error("M4 preview active food supplier is missing");

  const investmentInventory = new Map(ironMine.investmentInventory);
  investmentInventory.set(TOOLS, 50);
  const previewMine = { ...ironMine, investmentInventory };
  const previewFoodSupplier = {
    ...householdSupplier,
    seed: { ...householdSupplier.seed, regionKey: REGION_KEY },
  };

  const cohorts = new Map(
    [...baseline.cohorts.entries()]
      .filter(([, cohort]) => cohort.seed.regionKey === REGION_KEY)
      .map(([cohortId, cohort]) => {
        const householdInventory = new Map(cohort.householdInventory);
        householdInventory.set(FOOD, 0);
        return [cohortId, { ...cohort, householdInventory }] as const;
      }),
  );

  return {
    ...baseline,
    regions: new Map([[region.regionId, region]]),
    markets: new Map([marketEntry]),
    productionUnits: new Map([
      [previewMine.productionUnitId, previewMine],
      [previewFoodSupplier.productionUnitId, previewFoodSupplier],
    ]),
    cohorts,
  };
}

function totalFoodInventory(world: WorldState): number {
  let total = 0;
  for (const cohort of world.cohorts.values()) total += cohort.householdInventory.get(FOOD) ?? 0;

  const region = [...world.regions.values()][0];
  if (region === undefined) throw new Error("M4 preview food projection requires one Region");
  if (region.controllerStateId !== null) {
    const controllerState = world.states.get(region.controllerStateId);
    if (controllerState === undefined) {
      throw new Error(`M4 preview controller State ${region.controllerStateId} is missing`);
    }
    total += controllerState.publicInventory.get(FOOD) ?? 0;
  }

  for (const unit of world.productionUnits.values()) {
    total += unit.inputInventory.get(FOOD) ?? 0;
    total += unit.outputInventory.get(FOOD) ?? 0;
    total += unit.investmentInventory.get(FOOD) ?? 0;
  }
  return total;
}

function totalInstalledCapital(world: WorldState): number {
  return [...world.productionUnits.values()].reduce((sum, unit) => sum + unit.installedCapital, 0);
}

/** Execute and project the canonical M4 loop without mutating the caller's WorldState. */
export function generateM4Preview(openingWorld: WorldState): M4Preview {
  if (openingWorld.regions.size !== 1) {
    throw new Error(`M4 preview requires exactly one Region, got ${openingWorld.regions.size}`);
  }
  const region = [...openingWorld.regions.values()][0]!;
  const currency = openingWorld.currencies.get(region.settlementCurrencyId);
  const food = openingWorld.definitionRegistry.goods[FOOD];

  const samples: M4PreviewSample[] = [];
  let world = openingWorld;
  let totalOutput = 0;
  let totalWages = 0;
  let totalCapitalBuilt = 0;
  let totalHouseholdPurchaseQuantity = 0;

  for (let tick = 0; tick < M4_PREVIEW_TICKS; tick++) {
    const result = executeM4ClosedEconomyTick(world, tick, options(world));
    if (result.phaseBoundaryError !== undefined) {
      throw new Error(
        `M4 preview tick ${tick} failed phase ${result.phaseBoundaryError.phase}: ` +
          JSON.stringify(result.phaseBoundaryError.errors),
      );
    }
    if (result.reconciliationErrors !== null) {
      throw new Error(`M4 preview tick ${tick} failed reconciliation: ${JSON.stringify(result.reconciliationErrors)}`);
    }

    const outputProduced = (result.context.productionExecutions ?? []).reduce(
      (sum, execution) => sum + execution.outputProducedQuantity,
      0,
    );
    const employedWorkers = (result.context.laborAllocations ?? []).reduce(
      (sum, allocation) => sum + allocation.workerEquivalents,
      0,
    );
    const grossWagesPaid = (result.context.wageSettlements ?? []).reduce(
      (sum, settlement) => sum + settlement.grossWage,
      0,
    );
    const householdExecutions = result.context.householdConsumptionExecutions ?? [];
    const essentialCoverage = householdExecutions.length === 0
      ? 0
      : householdExecutions.reduce((sum, execution) => sum + execution.essentialCoverage, 0) /
        householdExecutions.length;
    const householdIntentIds = new Set(
      (result.context.householdMarketIntents ?? [])
        .filter((intent) => intent.actor.type === "COHORT" && intent.purpose === "CONSUMPTION")
        .map((intent) => String(intent.id)),
    );
    const householdPurchaseQuantity = result.context.marketAllocations.reduce(
      (sum, allocation) => householdIntentIds.has(String(allocation.buyerIntentId)) ? sum + allocation.quantity : sum,
      0,
    );
    const capitalBuilt = (result.context.capitalFormationExecutions ?? []).reduce(
      (sum, execution) => sum + execution.capitalBuilt,
      0,
    );

    totalOutput += outputProduced;
    totalWages += grossWagesPaid;
    totalCapitalBuilt += capitalBuilt;
    totalHouseholdPurchaseQuantity += householdPurchaseQuantity;

    world = result.world;
    if (tick % M4_PREVIEW_SAMPLE_EVERY === 0 || tick === M4_PREVIEW_TICKS - 1) {
      samples.push({
        tick,
        outputProduced,
        employedWorkers,
        grossWagesPaid,
        essentialCoverage,
        foodInventory: totalFoodInventory(world),
        installedCapital: totalInstalledCapital(world),
      });
    }
  }

  return {
    milestone: "M4",
    requirement: "REQ-VISUALIZATION-009",
    scenario: {
      scenarioId: openingWorld.scenarioId,
      seed: openingWorld.seed,
      configVersion: openingWorld.configVersion,
      ticksExecuted: M4_PREVIEW_TICKS,
      sampleEveryTicks: M4_PREVIEW_SAMPLE_EVERY,
    },
    region: {
      name: region.seed.name,
      currencyCode: currency?.seed.code ?? String(region.settlementCurrencyId),
      foodGoodName: food?.name ?? String(FOOD),
      goodsUnitLabel: food?.unitLabel ?? "units",
      workerUnitLabel: "worker-equivalents",
      capitalUnitLabel: "capital units",
    },
    samples,
    totals: {
      outputProduced: totalOutput,
      grossWagesPaid: totalWages,
      capitalBuilt: totalCapitalBuilt,
      householdPurchaseQuantity: totalHouseholdPurchaseQuantity,
    },
  };
}
