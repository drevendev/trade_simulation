import { describe, expect, it } from "vitest";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ClanId, CohortId, CurrencyId, GoodId, MarketId, RegionId, StateId } from "../domain/id";
import { getEnvelopeCommitment } from "./marketIntent";
import {
  createPhase2HouseholdConsumptionPlanningHandler,
  getHouseholdBudgetEnvelopeName,
  planHouseholdConsumptionPhase2,
} from "./householdConsumptionPlanning";
import { initializeTickContext } from "./tickOrchestrator";
import type { CohortState, LocalMarketState, RegionState, WorldState } from "./worldState";

const cohortId = (value: string) => value as CohortId;
const clanId = (value: string) => value as ClanId;
const regionId = (value: string) => value as RegionId;
const currencyId = (value: string) => value as CurrencyId;
const marketId = (value: string) => value as MarketId;
const goodId = (value: string) => value as GoodId;
const stateId = (value: string) => value as StateId;

const CUR = currencyId("currency:1");

function makeCategories(options?: { readonly reverseCandidates?: boolean }): Readonly<Record<string, NeedCategoryDefinition>> {
  const foods = [
    { goodId: goodId("food-a"), basePreference: 1, qualityFactor: 1 },
    { goodId: goodId("food-b"), basePreference: 2, qualityFactor: 1 },
  ];
  if (options?.reverseCandidates) foods.reverse();
  return {
    ESSENTIAL_FOOD: {
      id: "ESSENTIAL_FOOD",
      perCapitaTarget: 5,
      priority: 4,
      substitutionGoods: foods,
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
    BASIC_GOODS: {
      id: "BASIC_GOODS",
      perCapitaTarget: 4,
      priority: 3,
      minimumBudgetShare: 0.1,
      substitutionGoods: [{ goodId: goodId("basic"), basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 1,
    },
    SERVICES: {
      id: "SERVICES",
      perCapitaTarget: 2,
      priority: 2,
      minimumBudgetShare: 0.1,
      substitutionGoods: [{ goodId: goodId("service"), basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
    COMFORT: {
      id: "COMFORT",
      perCapitaTarget: 10,
      priority: 1,
      substitutionGoods: [{ goodId: goodId("comfort"), basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 2,
    },
  };
}

function reverseCategoryInsertion(categories: Readonly<Record<string, NeedCategoryDefinition>>): Readonly<Record<string, NeedCategoryDefinition>> {
  return Object.fromEntries(Object.entries(categories).reverse());
}

function makeCohort(id: string, cash = 100, population = 10, wageSignal = 1): CohortState {
  return {
    cohortId: cohortId(id),
    clanId: clanId("clan:1"),
    seed: {
      key: id,
      regionKey: "region-a",
      clanKey: "clan-a",
      ageBand: "WORKING",
      stratum: "WORKING_MIDDLE",
      laborCategory: "GENERAL",
      population,
      wallet: {},
      householdInventory: {},
      healthIndex: 1,
      prosperityEma: 0.5,
      essentialSatisfactionEma: 0.5,
      realIncomePerCapitaEma: 1,
      employmentRateEma: 1,
      migrationPressureEma: 0,
      mobilityAccumulator: 0,
      wageSignal,
    },
    wallet: new Map([[CUR, cash]]),
    householdInventory: new Map(),
  };
}

function makeRegion(controllerStateId: StateId | null = null): RegionState {
  return {
    regionId: regionId("region:1"),
    seed: {
      key: "region-a",
      name: "Region A",
      controllerStateKey: controllerStateId === null ? null : "state-a",
      settlementCurrencyKey: "CUR",
      settlementLevel: 1,
      infrastructure: {},
      climateHabitabilityInputs: {},
      deposits: [],
    },
    controllerStateId,
    settlementCurrencyId: CUR,
    resourceDeposits: new Map(),
  };
}

function makeMarket(priceOverrides: Readonly<Record<string, number>> = {}): LocalMarketState {
  const prices = new Map<GoodId, number>([
    [goodId("food-a"), 1],
    [goodId("food-b"), 1],
    [goodId("basic"), 1],
    [goodId("service"), 1],
    [goodId("comfort"), 1],
  ]);
  for (const [key, value] of Object.entries(priceOverrides)) prices.set(goodId(key), value);
  return {
    marketId: marketId("market:1"),
    seed: { regionKey: "region-a", initialPriceByGood: {} },
    priceByGood: prices,
    expectationsByGood: new Map(),
  };
}

function makeWorld(args?: {
  readonly cohorts?: readonly CohortState[];
  readonly categories?: Readonly<Record<string, NeedCategoryDefinition>>;
  readonly market?: LocalMarketState;
  readonly region?: RegionState;
}): WorldState {
  const config = createDefaultSimulationConfig();
  const region = args?.region ?? makeRegion();
  const market = args?.market ?? makeMarket();
  const cohorts = args?.cohorts ?? [makeCohort("cohort:a")];
  return {
    configVersion: config.configVersion,
    scenarioId: "household-consumption-test",
    seed: 123,
    definitionRegistry: {
      goods: {},
      recipes: {},
      eventDefinitions: {},
      metricDefinitions: {},
      needCategories: args?.categories ?? makeCategories(),
    },
    simulationConfig: config,
    worldGenesisLedger: { records: [] },
    regions: new Map([[region.regionId, region]]),
    states: new Map(),
    currencies: new Map(),
    monetaryAuthorities: new Map(),
    clans: new Map(),
    cohorts: new Map(cohorts.map((cohort) => [cohort.cohortId, cohort])),
    productionUnits: new Map(),
    markets: new Map([[market.marketId, market]]),
    transportLinks: new Map(),
    lastCapitalFormationTransitionTick: -1,
    pendingTransitions: {
      jurisdictionChanges: [],
      stateCreations: [],
      policyChanges: [],
      monetaryPolicyChanges: [],
    },
  };
}

function categoryBudget(world: WorldState, categoryId: string): number {
  const result = planHouseholdConsumptionPhase2(world, 7);
  return result.plans[0]!.categoryBudgets[categoryId]!;
}

describe("REQ-POPULATION-001 household consumption planning", () => {
  it("reserves liquidity, prioritizes essential budget, and never turns planning priority into clearing priority", () => {
    const world = makeWorld();
    const result = planHouseholdConsumptionPhase2(world, 7);
    const plan = result.plans[0]!;

    expect(plan.openingSpendableCash).toBe(100);
    expect(plan.expectedCurrentTickIncome).toBe(0);
    expect(plan.liquidityFloor).toBe(25);
    expect(plan.planningCashEnvelope).toBe(75);
    expect(categoryBudget(world, "ESSENTIAL_FOOD")).toBe(50);
    expect(categoryBudget(world, "BASIC_GOODS")).toBe(17.5);
    expect(categoryBudget(world, "SERVICES")).toBe(7.5);
    expect(categoryBudget(world, "COMFORT")).toBe(0);

    expect(result.intents.every((intent) => intent.side === "BUY" && intent.purpose === "CONSUMPTION")).toBe(true);
    expect(result.intents.every((intent) => intent.priorityClass === undefined)).toBe(true);
    expect(result.intents.every((intent) => intent.actor.type === "COHORT")).toBe(true);
    expect(plan.marketIntentIds).toEqual(result.intents.map((intent) => intent.id));
  });

  it("exposes canonical keyed category budgets and a separate top-level intended-consumption record", () => {
    const plan = planHouseholdConsumptionPhase2(makeWorld(), 7).plans[0]!;

    expect(Array.isArray(plan.categoryBudgets)).toBe(false);
    expect(plan.categoryBudgets).toEqual({
      ESSENTIAL_FOOD: 50,
      BASIC_GOODS: 17.5,
      SERVICES: 7.5,
      COMFORT: 0,
    });
    expect(plan.intendedUsefulConsumption).toEqual({
      ESSENTIAL_FOOD: 50,
      BASIC_GOODS: 17.5,
      SERVICES: 7.5,
      COMFORT: 0,
    });
    expect(plan.categoryDetails.map((entry) => entry.categoryId)).toEqual([
      "ESSENTIAL_FOOD",
      "BASIC_GOODS",
      "SERVICES",
      "COMFORT",
    ]);
  });

  it("reports zero intended consumption when a tiny positive cohort has zero available budget", () => {
    const population = 1e-12;
    const result = planHouseholdConsumptionPhase2(
      makeWorld({ cohorts: [makeCohort("cohort:tiny", 0, population)] }),
      7,
    );
    const plan = result.plans[0]!;

    expect(plan.categoryDetails.every((entry) => entry.targetUsefulConsumption > 0)).toBe(true);
    expect(plan.planningCashEnvelope).toBe(0);
    expect(plan.categoryBudgets).toEqual({
      ESSENTIAL_FOOD: 0,
      BASIC_GOODS: 0,
      SERVICES: 0,
      COMFORT: 0,
    });
    expect(plan.intendedUsefulConsumption).toEqual({
      ESSENTIAL_FOOD: 0,
      BASIC_GOODS: 0,
      SERVICES: 0,
      COMFORT: 0,
    });
    expect(plan.categoryDetails.every((entry) => entry.intendedUsefulConsumption === 0)).toBe(true);
    expect(result.intents).toEqual([]);
    expect(result.budgetLedger.commitmentsByEnvelope.size).toBe(0);
  });

  it("normalizes substitution finitely in log space even when observed prices are below moneyEpsilon", () => {
    const world = makeWorld({ market: makeMarket({ "food-a": 0, "food-b": Number.MIN_VALUE }) });
    const result = planHouseholdConsumptionPhase2(world, 3);
    const essential = result.plans[0]!.categoryDetails[0]!;
    const shareSum = essential.substitutionShares.reduce((sum, candidate) => sum + candidate.share, 0);

    expect(shareSum).toBeCloseTo(1, 15);
    expect(essential.substitutionShares.every((candidate) => Number.isFinite(candidate.share) && candidate.share >= 0)).toBe(true);
    expect(essential.substitutionShares.every((candidate) => candidate.expectedGrossBuyerPrice === 1e-9)).toBe(true);
    expect(result.intents.every((intent) => Number.isFinite(intent.desiredQuantity) && Number.isFinite(intent.maxSpend))).toBe(true);
  });

  it("uses the Phase-8 collected-tax semantics for expected gross buyer prices in controlled Regions", () => {
    const controlledWorld = makeWorld({ region: makeRegion(stateId("state:1")) });

    expect(() => planHouseholdConsumptionPhase2(controlledWorld, 3)).toThrow(
      /requires an explicit TaxPolicyProvider/,
    );

    const result = planHouseholdConsumptionPhase2(controlledWorld, 3, {
      taxPolicy: {
        getConsumptionTaxRate: (_stateId, good) => good === goodId("food-a") ? 0.5 : 0,
        getCollectionEfficiency: () => 0.5,
      },
    });
    const essential = result.plans[0]!.categoryDetails[0]!;
    const foodA = essential.substitutionShares.find((entry) => entry.goodId === goodId("food-a"))!;
    const foodB = essential.substitutionShares.find((entry) => entry.goodId === goodId("food-b"))!;

    expect(foodA.expectedGrossBuyerPrice).toBe(1.25);
    expect(foodB.expectedGrossBuyerPrice).toBe(1);
    expect(foodA.share).toBeCloseTo(2 / 7, 12);
    expect(foodB.share).toBeCloseTo(5 / 7, 12);

    expect(() => planHouseholdConsumptionPhase2(controlledWorld, 3, {
      taxPolicy: {
        getConsumptionTaxRate: () => Number.NaN,
        getCollectionEfficiency: () => 1,
      },
    })).toThrow(/Consumption tax rate.*must be finite/);
  });

  it("fails fast on missing/non-finite price and malformed need evidence", () => {
    expect(() => planHouseholdConsumptionPhase2(
      makeWorld({ market: makeMarket({ "food-a": Number.NaN }) }),
      1,
    )).toThrow(/Prior-close price.*food-a.*must be finite/);

    const missingPriceMarket = makeMarket();
    const missingPriceWorld = makeWorld({
      market: { ...missingPriceMarket, priceByGood: new Map([...missingPriceMarket.priceByGood].filter(([id]) => id !== goodId("service"))) },
    });
    expect(() => planHouseholdConsumptionPhase2(missingPriceWorld, 1)).toThrow(/service.*no prior-close market price/);

    const malformed = makeCategories();
    const badCategories = {
      ...malformed,
      COMFORT: { ...malformed.COMFORT!, perCapitaTarget: Number.POSITIVE_INFINITY },
    };
    expect(() => planHouseholdConsumptionPhase2(makeWorld({ categories: badCategories }), 1)).toThrow(/perCapitaTarget must be finite/);
  });

  it("does not treat the current tick wage signal as spendable cash", () => {
    const world = makeWorld({ cohorts: [makeCohort("cohort:a", 30, 10, 1_000_000)] });
    const result = planHouseholdConsumptionPhase2(world, 4);
    const plan = result.plans[0]!;
    const committed = result.intents.reduce((sum, intent) => sum + (intent.maxSpend ?? 0), 0);

    expect(plan.expectedCurrentTickIncome).toBe(0);
    expect(plan.liquidityFloor).toBe(25);
    expect(plan.planningCashEnvelope).toBe(5);
    expect(committed).toBeCloseTo(5, 12);
  });

  it("isolates identical household envelopes by Cohort actor and cannot overcommit either wallet", () => {
    const cohortA = makeCohort("cohort:a", 30);
    const cohortB = makeCohort("cohort:b", 30);
    const result = planHouseholdConsumptionPhase2(makeWorld({ cohorts: [cohortB, cohortA] }), 5);

    expect(result.plans.map((plan) => plan.cohortId)).toEqual([cohortId("cohort:a"), cohortId("cohort:b")]);
    for (const cohort of [cohortA, cohortB]) {
      const committed = getEnvelopeCommitment(
        result.budgetLedger,
        { type: "COHORT", cohortId: cohort.cohortId },
        CUR,
        getHouseholdBudgetEnvelopeName(),
      );
      expect(committed).toBeCloseTo(5, 12);
    }
  });

  it("is insertion-order deterministic across cohorts, category objects and substitution candidates", () => {
    const cohortA = makeCohort("cohort:a", 80);
    const cohortB = makeCohort("cohort:b", 60);
    const forward = planHouseholdConsumptionPhase2(makeWorld({ cohorts: [cohortA, cohortB], categories: makeCategories() }), 8);
    const shuffled = planHouseholdConsumptionPhase2(makeWorld({
      cohorts: [cohortB, cohortA],
      categories: reverseCategoryInsertion(makeCategories({ reverseCandidates: true })),
    }), 8);

    expect(shuffled.plans).toEqual(forward.plans);
    expect(shuffled.intents).toEqual(forward.intents);
    expect([...shuffled.budgetLedger.commitmentsByEnvelope]).toEqual([...forward.budgetLedger.commitmentsByEnvelope]);
  });

  it("skips zero-population cohorts and never mutates planning-time WorldState", () => {
    const live = makeCohort("cohort:a", 100, 10);
    const zero = makeCohort("cohort:zero", 100, 0);
    const world = makeWorld({ cohorts: [zero, live] });
    const walletBefore = live.wallet;
    const inventoryBefore = live.householdInventory;
    const marketBefore = world.markets.values().next().value as LocalMarketState;
    const priceBefore = marketBefore.priceByGood;

    const result = planHouseholdConsumptionPhase2(world, 2);

    expect(result.plans.map((plan) => plan.cohortId)).toEqual([live.cohortId]);
    expect(live.wallet).toBe(walletBefore);
    expect(live.householdInventory).toBe(inventoryBefore);
    expect(world.markets.values().next().value).toBe(marketBefore);
    expect(marketBefore.priceByGood).toBe(priceBefore);
    expect(live.wallet.get(CUR)).toBe(100);
  });

  it("writes plans, intents and commitments only to ephemeral Phase-2 TickContext", () => {
    const world = makeWorld();
    const handler = createPhase2HouseholdConsumptionPlanningHandler();
    const initial = initializeTickContext(6, world.seed);

    const phase1 = handler(world, { ...initial, phase: 1 }, world.pendingTransitions);
    expect(phase1.householdConsumptionPlans).toBeUndefined();
    expect(phase1.householdMarketIntents).toBeUndefined();

    const phase2 = handler(world, { ...initial, phase: 2 }, world.pendingTransitions);
    expect(phase2.householdConsumptionPlans?.map((plan) => plan.planId)).toEqual([
      "household-consumption:6:cohort:a",
    ]);
    expect(phase2.householdMarketIntents?.length).toBeGreaterThan(0);
    expect(phase2.budgetLedger.commitmentsByEnvelope.size).toBe(1);
    expect(world.cohorts.get(cohortId("cohort:a"))?.wallet.get(CUR)).toBe(100);
  });
});
