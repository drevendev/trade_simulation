import { createHash } from "crypto";
import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { executeM4ClosedEconomyTick, type M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOLDEN_TICKS = 240;
const GOLDEN_REGION_KEY = "region:a1-capital";
const IRON_RESOURCE_ID = "resource:iron-ore";
const FOOD = "good:food" as GoodId;
const TOOLS = "good:tools" as GoodId;

const m4NeedCategories: Readonly<Record<string, NeedCategoryDefinition>> = {
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

function goldenOpeningWorld(): WorldState {
  const baseline = buildInitialWorld(
    baselineScenario,
    { ...baselineDefinitionPack, needCategories: m4NeedCategories },
    createDefaultSimulationConfig(),
    42,
  );
  const region = [...baseline.regions.values()].find((candidate) => candidate.seed.key === GOLDEN_REGION_KEY);
  expect(region).toBeDefined();

  const market = [...baseline.markets.entries()].find(([, candidate]) => candidate.seed.regionKey === GOLDEN_REGION_KEY);
  expect(market).toBeDefined();

  const ironMine = [...baseline.productionUnits.values()].find(
    (unit) =>
      unit.seed.regionKey === GOLDEN_REGION_KEY &&
      unit.seed.recipeId === "recipe:iron-mine" &&
      unit.status === "ACTIVE",
  );
  expect(ironMine).toBeDefined();

  const householdSupplier = [...baseline.productionUnits.values()].find(
    (unit) =>
      unit.seed.regionKey === "region:a2-farm" &&
      unit.seed.recipeId === "recipe:food-harvest" &&
      unit.status === "ACTIVE",
  );
  expect(householdSupplier).toBeDefined();

  const investmentInventory = new Map(ironMine!.investmentInventory);
  // One complete real-goods capital bundle makes the long-run gate non-vacuous for
  // Phase-12 installation while still using the canonical recipe conversion.
  investmentInventory.set(TOOLS, 50);
  const goldenMine = { ...ironMine!, investmentInventory };

  // Reuse one canonical Alpha food producer and its already-owned food stock inside the
  // one-Region fixture. This gives Phase 8 a real household-facing seller without adding
  // a test-only formula or settlement path.
  const goldenHouseholdSupplier = {
    ...householdSupplier!,
    seed: { ...householdSupplier!.seed, regionKey: GOLDEN_REGION_KEY },
  };

  const cohorts = new Map(
    [...baseline.cohorts.entries()]
      .filter(([, cohort]) => cohort.seed.regionKey === GOLDEN_REGION_KEY)
      .map(([cohortId, cohort]) => {
        // Remove the long baseline food buffer so the first ticks exercise actual MAIN
        // household purchase/settlement rather than satisfying the need from opening stock.
        const householdInventory = new Map(cohort.householdInventory);
        householdInventory.set(FOOD, 0);
        return [cohortId, { ...cohort, householdInventory }] as const;
      }),
  );
  expect([...cohorts.values()].some((cohort) => cohort.seed.ageBand === "WORKING")).toBe(true);

  return {
    ...baseline,
    regions: new Map([[region!.regionId, region!]]),
    markets: new Map([market!]),
    productionUnits: new Map([
      [goldenMine.productionUnitId, goldenMine],
      [goldenHouseholdSupplier.productionUnitId, goldenHouseholdSupplier],
    ]),
    cohorts,
  };
}

function assertFiniteNonNegative(label: string, value: number): void {
  expect(Number.isFinite(value), `${label} must be finite`).toBe(true);
  expect(value, `${label} must be non-negative`).toBeGreaterThanOrEqual(0);
}

function assertMapFiniteNonNegative(label: string, values: ReadonlyMap<unknown, number>): void {
  for (const [key, value] of values) assertFiniteNonNegative(`${label}[${String(key)}]`, value);
}

function assertCanonicalStocks(world: WorldState): void {
  for (const region of world.regions.values()) {
    assertMapFiniteNonNegative(`Region ${String(region.regionId)} resourceDeposits`, region.resourceDeposits);
  }
  for (const state of world.states.values()) {
    assertMapFiniteNonNegative(`State ${String(state.stateId)} treasury`, state.treasury);
    assertMapFiniteNonNegative(`State ${String(state.stateId)} publicInventory`, state.publicInventory);
  }
  for (const clan of world.clans.values()) {
    assertMapFiniteNonNegative(`Clan ${String(clan.clanId)} treasury`, clan.treasury);
  }
  for (const cohort of world.cohorts.values()) {
    assertMapFiniteNonNegative(`Cohort ${String(cohort.cohortId)} wallet`, cohort.wallet);
    assertMapFiniteNonNegative(`Cohort ${String(cohort.cohortId)} householdInventory`, cohort.householdInventory);
  }
  for (const unit of world.productionUnits.values()) {
    assertMapFiniteNonNegative(`ProductionUnit ${String(unit.productionUnitId)} wallet`, unit.wallet);
    assertMapFiniteNonNegative(`ProductionUnit ${String(unit.productionUnitId)} inputInventory`, unit.inputInventory);
    assertMapFiniteNonNegative(`ProductionUnit ${String(unit.productionUnitId)} outputInventory`, unit.outputInventory);
    assertMapFiniteNonNegative(`ProductionUnit ${String(unit.productionUnitId)} investmentInventory`, unit.investmentInventory);
    assertFiniteNonNegative(`ProductionUnit ${String(unit.productionUnitId)} installedCapital`, unit.installedCapital);
    assertFiniteNonNegative(`ProductionUnit ${String(unit.productionUnitId)} wageOffer`, unit.wageOffer);
  }
  for (const market of world.markets.values()) {
    for (const [goodId, price] of market.priceByGood) {
      expect(Number.isFinite(price), `Market ${String(market.marketId)} price ${String(goodId)} must be finite`).toBe(true);
      expect(price, `Market ${String(market.marketId)} price ${String(goodId)} must stay positive`).toBeGreaterThan(0);
    }
  }
}

function sortedNumericEntries(values: ReadonlyMap<unknown, number>): readonly (readonly [string, number])[] {
  return [...values.entries()]
    .map(([key, value]) => [String(key), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function normalizedWorldHash(world: WorldState): string {
  const normalized = {
    seed: world.seed,
    scenarioId: world.scenarioId,
    configVersion: world.configVersion,
    regions: [...world.regions.values()]
      .sort((left, right) => String(left.regionId).localeCompare(String(right.regionId)))
      .map((region) => ({ id: region.regionId, resources: sortedNumericEntries(region.resourceDeposits) })),
    states: [...world.states.values()]
      .sort((left, right) => String(left.stateId).localeCompare(String(right.stateId)))
      .map((state) => ({
        id: state.stateId,
        treasury: sortedNumericEntries(state.treasury),
        publicInventory: sortedNumericEntries(state.publicInventory),
      })),
    clans: [...world.clans.values()]
      .sort((left, right) => String(left.clanId).localeCompare(String(right.clanId)))
      .map((clan) => ({ id: clan.clanId, treasury: sortedNumericEntries(clan.treasury) })),
    cohorts: [...world.cohorts.values()]
      .sort((left, right) => String(left.cohortId).localeCompare(String(right.cohortId)))
      .map((cohort) => ({
        id: cohort.cohortId,
        wallet: sortedNumericEntries(cohort.wallet),
        inventory: sortedNumericEntries(cohort.householdInventory),
      })),
    productionUnits: [...world.productionUnits.values()]
      .sort((left, right) => String(left.productionUnitId).localeCompare(String(right.productionUnitId)))
      .map((unit) => ({
        id: unit.productionUnitId,
        status: unit.status,
        wallet: sortedNumericEntries(unit.wallet),
        input: sortedNumericEntries(unit.inputInventory),
        output: sortedNumericEntries(unit.outputInventory),
        investment: sortedNumericEntries(unit.investmentInventory),
        wageOffer: unit.wageOffer,
        installedCapital: unit.installedCapital,
        lastLifecycleReviewTick: unit.lastLifecycleReviewTick,
        signals: {
          utilizationEma: unit.signals.utilizationEma,
          sellThroughEma: unit.signals.sellThroughEma,
          marginSignalEma: unit.signals.marginSignalEma,
          outputSalesEma: unit.signals.outputSalesEma,
          inputUseEma: Object.entries(unit.signals.inputUseEma).sort(([left], [right]) => left.localeCompare(right)),
          consecutiveNonviableReviews: unit.signals.consecutiveNonviableReviews,
          consecutiveViableReviews: unit.signals.consecutiveViableReviews,
        },
      })),
    markets: [...world.markets.values()]
      .sort((left, right) => String(left.marketId).localeCompare(String(right.marketId)))
      .map((market) => ({
        id: market.marketId,
        prices: sortedNumericEntries(market.priceByGood),
        expectations: [...market.expectationsByGood.entries()]
          .sort(([left], [right]) => String(left).localeCompare(String(right)))
          .map(([goodId, value]) => [goodId, value] as const),
      })),
    transitionTicks: {
      production: world.lastProductionExecutionTransitionTick,
      wages: world.lastWageSettlementTransitionTick,
      household: world.lastHouseholdConsumptionTransitionTick,
      capital: world.lastCapitalFormationTransitionTick,
    },
    lifecyclePending: [...(world.pendingTransitions.productionUnitLifecycleChanges ?? [])]
      .map((transition) => ({ ...transition }))
      .sort((left, right) => left.transitionId.localeCompare(right.transitionId)),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function runGolden(): {
  readonly hash: string;
  readonly extracted: number;
  readonly capitalBuilt: number;
  readonly householdExecutions: number;
  readonly householdPurchaseQuantity: number;
  readonly householdSpend: number;
  readonly wageSettlements: number;
} {
  let world = goldenOpeningWorld();
  assertCanonicalStocks(world);
  const openingRegion = [...world.regions.values()][0]!;
  const openingResource = openingRegion.resourceDeposits.get(IRON_RESOURCE_ID) ?? 0;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;

  let extracted = 0;
  let capitalBuilt = 0;
  let householdExecutions = 0;
  let householdPurchaseQuantity = 0;
  let householdSpend = 0;
  let wageSettlements = 0;

  for (let tick = 0; tick < GOLDEN_TICKS; tick++) {
    const opening = world;
    const result = executeM4ClosedEconomyTick(opening, tick, options(opening));

    expect(result.phaseBoundaryError, `tick ${tick} phase boundary`).toBeUndefined();
    expect(result.reconciliationErrors, `tick ${tick} reconciliation`).toBeNull();
    expect(result.phaseTrace, `tick ${tick} phase trace`).toEqual([...Array(16).keys()]);

    for (const execution of result.context.productionExecutions ?? []) {
      assertFiniteNonNegative(`tick ${tick} realizedBatches`, execution.realizedBatches);
      const bounds = [
        execution.plannedBatches,
        execution.inputBoundBatches,
        execution.laborBoundBatches,
        execution.capitalBoundBatches,
        execution.resourceBoundBatches,
      ].filter((value): value is number => value !== null);
      for (const bound of bounds) {
        expect(execution.realizedBatches).toBeLessThanOrEqual(bound + quantityEpsilon);
      }
      if (execution.resourceConsumption !== undefined) {
        const recipe = opening.definitionRegistry.recipes[execution.recipeId]!;
        expect(recipe.extractedResourcePerBatch).toBeDefined();
        expect(execution.resourceConsumption.resourceId).toBe(recipe.extractionResourceId);
        expect(execution.resourceConsumption.quantity).toBeCloseTo(
          execution.realizedBatches * recipe.extractedResourcePerBatch!,
          10,
        );
        extracted += execution.resourceConsumption.quantity;
      }
    }

    for (const settlement of result.context.wageSettlements ?? []) {
      expect(settlement.grossWage).toBeCloseTo(settlement.netWage + settlement.collectedTax, 10);
      expect(settlement.assessedTax).toBeCloseTo(
        settlement.collectedTax + settlement.uncollectedAssessedTax,
        10,
      );
      wageSettlements++;
    }

    const householdIntentById = new Map(
      (result.context.householdMarketIntents ?? []).map((intent) => [String(intent.id), intent] as const),
    );
    const netWageByCohort = new Map<string, number>();
    for (const settlement of result.context.wageSettlements ?? []) {
      const key = String(settlement.cohortId);
      netWageByCohort.set(key, (netWageByCohort.get(key) ?? 0) + settlement.netWage);
    }
    const spendByCohort = new Map<string, number>();
    for (const allocation of result.context.marketAllocations) {
      const intent = householdIntentById.get(String(allocation.buyerIntentId));
      if (intent?.actor.type !== "COHORT" || intent.purpose !== "CONSUMPTION") continue;
      const key = String(intent.actor.cohortId);
      const spend = allocation.quantity * allocation.buyerGrossUnitPrice;
      spendByCohort.set(key, (spendByCohort.get(key) ?? 0) + spend);
      householdPurchaseQuantity += allocation.quantity;
      householdSpend += spend;
    }
    for (const [cohortId, spend] of spendByCohort) {
      const cohort = [...opening.cohorts.values()].find((candidate) => String(candidate.cohortId) === cohortId)!;
      const region = [...opening.regions.values()][0]!;
      const openingCash = cohort.wallet.get(region.settlementCurrencyId) ?? 0;
      expect(spend).toBeLessThanOrEqual(openingCash + (netWageByCohort.get(cohortId) ?? 0) + moneyEpsilon);
    }

    for (const execution of result.context.capitalFormationExecutions ?? []) {
      assertFiniteNonNegative(`tick ${tick} capitalBuilt`, execution.capitalBuilt);
      assertFiniteNonNegative(`tick ${tick} depreciationUnits`, execution.depreciationUnits);
      expect(execution.installedCapitalNext).toBeCloseTo(
        execution.postFormationInstalledCapital - execution.depreciationUnits,
        10,
      );
      const recipe = opening.definitionRegistry.recipes[execution.recipeId]!;
      for (const [goodId, consumed] of Object.entries(execution.investmentGoodsConsumedByGood)) {
        const coefficient = recipe.investmentGoodsPerCapitalUnit[goodId as GoodId];
        expect(coefficient).toBeDefined();
        expect(consumed).toBeCloseTo(execution.capitalBuilt * coefficient!, 10);
      }
      capitalBuilt += execution.capitalBuilt;
    }

    householdExecutions += (result.context.householdConsumptionExecutions ?? []).length;
    world = result.world;
    assertCanonicalStocks(world);
  }

  const finalRegion = [...world.regions.values()][0]!;
  const finalResource = finalRegion.resourceDeposits.get(IRON_RESOURCE_ID) ?? 0;
  expect(finalResource).toBeCloseTo(openingResource - extracted, 8);
  expect(finalResource).toBeGreaterThanOrEqual(0);

  return {
    hash: normalizedWorldHash(world),
    extracted,
    capitalBuilt,
    householdExecutions,
    householdPurchaseQuantity,
    householdSpend,
    wageSettlements,
  };
}

describe("REQ-ACCEPTANCE-005: M4 one-region 240-tick golden gate", () => {
  it("runs the integrated M4 economy for 240 ticks with bounded stocks/accounting and deterministic replay", () => {
    const first = runGolden();
    const second = runGolden();

    expect(first.extracted).toBeGreaterThan(0);
    expect(first.capitalBuilt).toBeGreaterThan(0);
    expect(first.householdExecutions).toBeGreaterThan(0);
    expect(first.householdPurchaseQuantity).toBeGreaterThan(0);
    expect(first.householdSpend).toBeGreaterThan(0);
    expect(first.wageSettlements).toBeGreaterThan(0);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
  });

  it("makes persistent lifecycle-review state load-bearing in the normalized replay hash", () => {
    const world = goldenOpeningWorld();
    const unit = [...world.productionUnits.values()][0]!;
    const baselineHash = normalizedWorldHash(world);
    const variants = [
      {
        ...unit,
        signals: {
          ...unit.signals,
          consecutiveNonviableReviews: unit.signals.consecutiveNonviableReviews + 1,
        },
      },
      {
        ...unit,
        signals: {
          ...unit.signals,
          consecutiveViableReviews: unit.signals.consecutiveViableReviews + 1,
        },
      },
      {
        ...unit,
        lastLifecycleReviewTick: unit.lastLifecycleReviewTick + 1,
      },
    ];

    for (const variant of variants) {
      const productionUnits = new Map(world.productionUnits);
      productionUnits.set(unit.productionUnitId, variant);
      expect(normalizedWorldHash({ ...world, productionUnits })).not.toBe(baselineHash);
    }
  });
});