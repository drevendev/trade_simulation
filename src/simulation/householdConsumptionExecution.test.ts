import { describe, expect, it } from "vitest";
import type { GoodDefinition, NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type {
  ClanId,
  CohortId,
  CurrencyId,
  GoodId,
  MarketId,
  ProductionUnitId,
  RegionId,
  StateId,
} from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import type { LaborSupplyPlan } from "./laborSupplyPlanning";
import { createMarketAllocationId, type MarketAllocation } from "./marketClearing";
import { createMarketIntentId } from "./marketIntent";
import {
  applyHouseholdConsumptionTransition,
  createPhase9HouseholdConsumptionHandler,
  planHouseholdConsumptionPhase9,
} from "./householdConsumptionExecution";
import {
  createTransactionBundleId,
  createTransactionId,
  initializeTickContext,
  type EconomicTransaction,
  type TickContext,
} from "./tickOrchestrator";
import type { WageSettlement } from "./wageSettlement";
import type { CohortState, RegionState, WorldState } from "./worldState";

const cohortId = (value: string) => value as CohortId;
const clanId = (value: string) => value as ClanId;
const regionId = (value: string) => value as RegionId;
const currencyId = (value: string) => value as CurrencyId;
const goodId = (value: string) => value as GoodId;
const unitId = (value: string) => value as ProductionUnitId;
const marketId = (value: string) => value as MarketId;
const stateId = (value: string) => value as StateId;

const COHORT = cohortId("cohort:a");
const REGION = regionId("region:1");
const CUR = currencyId("currency:1");
const UNIT = unitId("unit:1");
const FOOD = goodId("good:food");
const BASIC = goodId("good:basic");
const SERVICE = goodId("good:service");
const COMFORT = goodId("good:comfort");

function good(id: GoodId, spoilageRatePerTick: number): GoodDefinition {
  return {
    id,
    name: String(id),
    unitLabel: "units",
    spoilageRatePerTick,
    consumerNeedCategory: "test",
    necessityWeight: 1,
    substitutionGroup: "test",
    referencePrice: 1,
    tradable: true,
  };
}

function categories(args?: {
  readonly foodTarget?: number;
  readonly foodCarryover?: number;
  readonly foodQuality?: number;
  readonly overlapBasicWithFood?: boolean;
}): Readonly<Record<string, NeedCategoryDefinition>> {
  return {
    ESSENTIAL_FOOD: {
      id: "ESSENTIAL_FOOD",
      perCapitaTarget: args?.foodTarget ?? 10,
      priority: 4,
      substitutionGoods: [{ goodId: FOOD, basePreference: 1, qualityFactor: args?.foodQuality ?? 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: args?.foodCarryover ?? 0,
    },
    BASIC_GOODS: {
      id: "BASIC_GOODS",
      perCapitaTarget: args?.overlapBasicWithFood ? 10 : 0,
      priority: 3,
      substitutionGoods: [{
        goodId: args?.overlapBasicWithFood ? FOOD : BASIC,
        basePreference: 1,
        qualityFactor: 1,
      }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
    SERVICES: {
      id: "SERVICES",
      perCapitaTarget: 0,
      priority: 2,
      substitutionGoods: [{ goodId: SERVICE, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
    COMFORT: {
      id: "COMFORT",
      perCapitaTarget: 0,
      priority: 1,
      substitutionGoods: [{ goodId: COMFORT, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
  };
}

function cohort(inventory: readonly (readonly [GoodId, number])[], population = 1): CohortState {
  return {
    cohortId: COHORT,
    clanId: clanId("clan:1"),
    seed: {
      key: "cohort-a",
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
      employmentRateEma: 0,
      migrationPressureEma: 0,
      mobilityAccumulator: 0,
      wageSignal: 1,
    },
    wallet: new Map([[CUR, 100]]),
    householdInventory: new Map(inventory),
  };
}

function region(): RegionState {
  return {
    regionId: REGION,
    seed: {
      key: "region-a",
      name: "Region A",
      controllerStateKey: null,
      settlementCurrencyKey: "CUR",
      settlementLevel: 1,
      infrastructure: {},
      climateHabitabilityInputs: {},
      deposits: [],
    },
    controllerStateId: null,
    settlementCurrencyId: CUR,
    resourceDeposits: new Map(),
  };
}

function world(args?: {
  readonly inventory?: readonly (readonly [GoodId, number])[];
  readonly categories?: Readonly<Record<string, NeedCategoryDefinition>>;
  readonly foodSpoilage?: number;
}): WorldState {
  const config = createDefaultSimulationConfig();
  const c = cohort(args?.inventory ?? []);
  const r = region();
  return {
    configVersion: config.configVersion,
    scenarioId: "phase9-household-test",
    seed: 1,
    definitionRegistry: {
      goods: {
        [FOOD]: good(FOOD, args?.foodSpoilage ?? 1),
        [BASIC]: good(BASIC, 0),
        [SERVICE]: good(SERVICE, 0),
        [COMFORT]: good(COMFORT, 0),
      },
      recipes: {},
      eventDefinitions: {},
      metricDefinitions: {},
      needCategories: args?.categories ?? categories(),
    },
    simulationConfig: config,
    worldGenesisLedger: { records: [] },
    regions: new Map([[r.regionId, r]]),
    states: new Map(),
    currencies: new Map(),
    monetaryAuthorities: new Map(),
    clans: new Map(),
    cohorts: new Map([[c.cohortId, c]]),
    productionUnits: new Map(),
    markets: new Map(),
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

function supply(availableWorkerEquivalents = 0): LaborSupplyPlan {
  return {
    planId: "labor-supply:7:cohort:a",
    cohortId: COHORT,
    regionId: REGION,
    laborCategory: "GENERAL",
    availableWorkerEquivalents,
  };
}

function wageEvidence(): {
  readonly allocation: LaborAllocation;
  readonly settlement: WageSettlement;
  readonly transaction: EconomicTransaction;
} {
  const allocation: LaborAllocation = {
    allocationId: "labor-allocation:7:a",
    tick: 7,
    regionId: REGION,
    laborCategory: "GENERAL",
    cohortId: COHORT,
    unitId: UNIT,
    workerEquivalents: 4,
    grossWagePerWorker: 5,
    grossWageObligation: 20,
  };
  const bundleId = createTransactionBundleId("tb:7:5:wage:labor-allocation:7:a");
  const transactionId = createTransactionId("tx:7:5:wage-payment:labor-allocation:7:a");
  const transaction: EconomicTransaction = {
    tick: 7,
    phase: 5,
    type: "WAGE_PAYMENT",
    transactionId,
    bundleId,
    source: { type: "PRODUCTION_UNIT", productionUnitId: UNIT },
    destination: { type: "COHORT", cohortId: COHORT },
    currencyId: CUR,
    moneyAmount: 18,
    grossMoneyAmount: 20,
    assessedTaxAmount: 2,
    taxAmount: 2,
    sourceRegionId: REGION,
    destinationRegionId: REGION,
    amount: 18,
    reason: allocation.allocationId,
  };
  const settlement: WageSettlement = {
    settlementId: "wage-settlement:7:labor-allocation:7:a",
    allocationId: allocation.allocationId,
    tick: 7,
    regionId: REGION,
    cohortId: COHORT,
    unitId: UNIT,
    currencyId: CUR,
    controllerStateId: stateId("state:1"),
    grossWage: 20,
    assessedTax: 2,
    collectedTax: 2,
    uncollectedAssessedTax: 0,
    netWage: 18,
    bundleId,
    wagePaymentTransaction: transaction as WageSettlement["wagePaymentTransaction"],
    wageTaxWithheldTransaction: undefined,
  };
  return { allocation, settlement, transaction };
}

function plan(args: {
  readonly world: WorldState;
  readonly marketAllocations?: readonly MarketAllocation[];
  readonly supply?: LaborSupplyPlan;
  readonly allocations?: readonly LaborAllocation[];
  readonly settlements?: readonly WageSettlement[];
  readonly transactions?: readonly EconomicTransaction[];
}) {
  return planHouseholdConsumptionPhase9({
    world: args.world,
    tick: 7,
    marketAllocations: args.marketAllocations ?? [],
    laborSupplyPlans: [args.supply ?? supply()],
    laborAllocations: args.allocations ?? [],
    wageSettlements: args.settlements ?? [],
    transactions: args.transactions ?? [],
  });
}

function purchaseAllocation(quantity: number): MarketAllocation {
  return {
    id: createMarketAllocationId("ma:7:food:1"),
    marketId: marketId("market:1"),
    regionId: REGION,
    goodId: FOOD,
    pass: "MAIN",
    sellerIntentId: createMarketIntentId("mi:sell:food"),
    buyerIntentId: createMarketIntentId("mi:buy:food"),
    seller: { type: "PRODUCTION_UNIT", productionUnitId: UNIT },
    buyer: { type: "COHORT", cohortId: COHORT },
    quantity,
    sellerNetUnitPrice: 1,
    buyerGrossUnitPrice: 1,
    marketCurrencyId: CUR,
    consumptionTaxAmount: 0,
    destinationStateId: null,
    sellerInventoryBucket: "OUTPUT",
    buyerInventoryBucket: "GENERAL",
  };
}

describe("REQ-POPULATION-003 Phase-9 household realization", () => {
  it("turns physical shortage into bounded coverage without negative inventory", () => {
    const input = world({ inventory: [[FOOD, 4]], categories: categories({ foodTarget: 10 }) });
    const result = plan({ world: input });
    const execution = result.executions[0]!;
    const food = execution.categories.find((item) => item.categoryId === "ESSENTIAL_FOOD")!;

    expect(food.requiredUsefulConsumption).toBe(10);
    expect(food.realizedUsefulConsumption).toBe(4);
    expect(food.coverage).toBeCloseTo(0.4);
    expect(execution.essentialCoverage).toBeCloseTo(0.2);
    expect(execution.endingInventoryByGood[FOOD]).toBe(0);
    expect(result.physicalLosses.some(
      (loss) => loss.cause === "consumption" && loss.amount === 4 && loss.phase === 9 && loss.causalPhase === 9,
    )).toBe(true);

    const transitioned = applyHouseholdConsumptionTransition(input, result.executions);
    expect(input.cohorts.get(COHORT)!.householdInventory.get(FOOD)).toBe(4);
    expect(transitioned.cohorts.get(COHORT)!.householdInventory.get(FOOD)).toBe(0);
  });

  it("destroys only excess perishable carryover and records explicit HOUSEHOLD_SPOILAGE", () => {
    const input = world({
      inventory: [[FOOD, 10]],
      categories: categories({ foodTarget: 2, foodCarryover: 1 }),
      foodSpoilage: 0.25,
    });
    const result = plan({ world: input });
    const execution = result.executions[0]!;

    expect(execution.consumedByGood[FOOD]).toBeCloseTo(2);
    expect(execution.spoiledByGood[FOOD]).toBeCloseTo(6);
    expect(execution.endingInventoryByGood[FOOD]).toBeCloseTo(2);
    expect(result.transactions.some((tx) => tx.type === "HOUSEHOLD_SPOILAGE" && tx.quantity === 6)).toBe(true);
    expect(result.physicalLosses.some(
      (loss) => loss.cause === "spoilage" && loss.amount === 6 && loss.phase === 9 && loss.causalPhase === 9,
    )).toBe(true);
  });

  it("retains durable goods instead of silently destroying them above a carryover cap", () => {
    const input = world({
      inventory: [[FOOD, 10]],
      categories: categories({ foodTarget: 2, foodCarryover: 1 }),
      foodSpoilage: 0,
    });
    const execution = plan({ world: input }).executions[0]!;

    expect(execution.consumedByGood[FOOD]).toBeCloseTo(2);
    expect(execution.spoiledByGood[FOOD] ?? 0).toBe(0);
    expect(execution.endingInventoryByGood[FOOD]).toBeCloseTo(8);
  });

  it("never lets one physical good satisfy two overlapping need categories twice", () => {
    const input = world({
      inventory: [[FOOD, 10]],
      categories: categories({ foodTarget: 10, overlapBasicWithFood: true }),
    });
    const execution = plan({ world: input }).executions[0]!;
    const essential = execution.categories.find((item) => item.categoryId === "ESSENTIAL_FOOD")!;
    const basic = execution.categories.find((item) => item.categoryId === "BASIC_GOODS")!;

    expect(essential.coverage).toBe(1);
    expect(basic.coverage).toBe(0);
    expect(execution.consumedByGood[FOOD]).toBe(10);
    expect(execution.endingInventoryByGood[FOOD]).toBe(0);
  });

  it("projects realized Phase-8 purchases but refuses persistence before canonical market settlement", () => {
    const opening = world({
      inventory: [],
      categories: categories({ foodTarget: 2, foodCarryover: 1 }),
      foodSpoilage: 0,
    });
    const result = plan({ world: opening, marketAllocations: [purchaseAllocation(3)] });
    const execution = result.executions[0]!;

    expect(execution.postMarketInventoryByGood[FOOD]).toBe(3);
    expect(execution.consumedByGood[FOOD]).toBe(2);
    expect(() => applyHouseholdConsumptionTransition(opening, result.executions)).toThrow(/requires canonical Phase-8 settlement first/);

    const c = opening.cohorts.get(COHORT)!;
    const settled: WorldState = {
      ...opening,
      cohorts: new Map([[COHORT, { ...c, householdInventory: new Map([[FOOD, 3]]) }]]),
    };
    const transitioned = applyHouseholdConsumptionTransition(settled, result.executions);
    expect(transitioned.cohorts.get(COHORT)!.householdInventory.get(FOOD)).toBeCloseTo(1);
  });

  it("rejects a tampered ending inventory instead of persisting an unproved Phase-9 stock delta", () => {
    const input = world({ inventory: [[FOOD, 4]], categories: categories({ foodTarget: 10 }) });
    const execution = plan({ world: input }).executions[0]!;
    const beforeInventory = input.cohorts.get(COHORT)!.householdInventory;

    const mismatchedLossDelta = {
      ...execution,
      endingInventoryByGood: { ...execution.endingInventoryByGood, [FOOD]: 3 },
    };
    expect(() => applyHouseholdConsumptionTransition(input, [mismatchedLossDelta])).toThrow(
      /ending inventory does not match declared consumption\/spoilage/,
    );
    expect(input.cohorts.get(COHORT)!.householdInventory).toBe(beforeInventory);
    expect(input.cohorts.get(COHORT)!.householdInventory.get(FOOD)).toBe(4);

    const unexpectedEndingGood = {
      ...execution,
      endingInventoryByGood: { ...execution.endingInventoryByGood, [SERVICE]: 1 },
    };
    expect(() => applyHouseholdConsumptionTransition(input, [unexpectedEndingGood])).toThrow(
      /ending inventory does not match declared consumption\/spoilage/,
    );
    expect(input.cohorts.get(COHORT)!.householdInventory).toBe(beforeInventory);
  });

  it("reconciles employment and net wage receipts to existing Phase-3/5 evidence without recomputing tax", () => {
    const evidence = wageEvidence();
    const result = plan({
      world: world(),
      supply: supply(10),
      allocations: [evidence.allocation],
      settlements: [evidence.settlement],
      transactions: [evidence.transaction],
    });
    const economic = result.executions[0]!.economic;

    expect(economic.availableWorkerEquivalents).toBe(10);
    expect(economic.employedWorkerEquivalents).toBe(4);
    expect(economic.employmentRate).toBeCloseTo(0.4);
    expect(economic.grossWageIncome).toBe(20);
    expect(economic.netWageReceipt).toBe(18);
    expect(economic.wageTaxWithheld).toBe(2);

    const malformed = { ...evidence.transaction, moneyAmount: 17, amount: 17 };
    expect(() => plan({
      world: world(),
      supply: supply(10),
      allocations: [evidence.allocation],
      settlements: [evidence.settlement],
      transactions: [malformed],
    })).toThrow(/does not match Phase-5 settlement evidence/);
  });

  it("consumes for CHILD/ELDER cohorts with zero employment evidence and rejects phantom labor artifacts", () => {
    const opening = world({
      inventory: [[FOOD, 2]],
      categories: categories({ foodTarget: 2 }),
    });
    const existing = opening.cohorts.get(COHORT)!;
    const childWorld: WorldState = {
      ...opening,
      cohorts: new Map([[COHORT, { ...existing, seed: { ...existing.seed, ageBand: "CHILD" } }]]),
    };

    const result = planHouseholdConsumptionPhase9({
      world: childWorld,
      tick: 7,
      marketAllocations: [],
      laborSupplyPlans: [],
      laborAllocations: [],
      wageSettlements: [],
      transactions: [],
    });
    expect(result.executions[0]!.consumedByGood[FOOD]).toBe(2);
    expect(result.executions[0]!.economic).toEqual({
      cohortId: COHORT,
      availableWorkerEquivalents: 0,
      employedWorkerEquivalents: 0,
      employmentRate: 0,
      grossWageIncome: 0,
      netWageReceipt: 0,
      wageTaxWithheld: 0,
    });

    expect(() => planHouseholdConsumptionPhase9({
      world: childWorld,
      tick: 7,
      marketAllocations: [],
      laborSupplyPlans: [supply(1)],
      laborAllocations: [],
      wageSettlements: [],
      transactions: [],
    })).toThrow(/Non-WORKING Cohort.*must not have/);
  });

  it("is insertion-order deterministic and the Phase-9 handler mutates only TickContext", () => {
    const evidence = wageEvidence();
    const firstWorld = world({ inventory: [[FOOD, 4], [BASIC, 2]] });
    const reversedWorld = world({ inventory: [[BASIC, 2], [FOOD, 4]] });
    const a = plan({
      world: firstWorld,
      supply: supply(10),
      allocations: [evidence.allocation],
      settlements: [evidence.settlement],
      transactions: [evidence.transaction],
    });
    const b = plan({
      world: reversedWorld,
      supply: supply(10),
      allocations: [evidence.allocation].reverse(),
      settlements: [evidence.settlement].reverse(),
      transactions: [evidence.transaction].reverse(),
    });
    expect(b).toEqual(a);

    const handler = createPhase9HouseholdConsumptionHandler();
    const base = initializeTickContext(7, 123);
    const context: TickContext = {
      ...base,
      phase: 9,
      laborSupplyPlans: [supply(10)],
      laborAllocations: [evidence.allocation],
      wageSettlements: [evidence.settlement],
      transactions: [evidence.transaction],
    };
    const beforeInventory = firstWorld.cohorts.get(COHORT)!.householdInventory;
    const next = handler(firstWorld, context, firstWorld.pendingTransitions);

    expect(firstWorld.cohorts.get(COHORT)!.householdInventory).toBe(beforeInventory);
    expect(next.householdConsumptionExecutions).toHaveLength(1);
    expect(next.currentLedger.records.some((record) => record.type === "PHYSICAL_LOSS")).toBe(true);
    expect(next.transactions.some((tx) => tx.type === "HOUSEHOLD_CONSUMPTION")).toBe(true);
  });
});
