import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId, ProductionUnitId, RegionId, StateId } from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import type { LaborSupplyPlan } from "./laborSupplyPlanning";
import {
  createPhase9HouseholdConsumptionHandler,
  planHouseholdConsumptionPhase9,
} from "./householdConsumptionExecution";
import type { LaborDemandPlan } from "./productionPlanning";
import {
  createTransactionBundleId,
  createTransactionId,
  initializeTickContext,
  type EconomicTransaction,
  type TickContext,
} from "./tickOrchestrator";
import { planWageSettlementsPhase5, type WageSettlement } from "./wageSettlement";
import { buildInitialWorld, type WorldState } from "./worldState";

interface WageFixture {
  readonly world: WorldState;
  readonly supply: LaborSupplyPlan;
  readonly allocation: LaborAllocation;
  readonly settlement: WageSettlement;
  readonly transactions: readonly EconomicTransaction[];
}

function zeroNeedCategories(): Readonly<Record<string, NeedCategoryDefinition>> {
  const food = "good:food" as GoodId;
  const wood = "good:wood" as GoodId;
  const cloth = "good:cloth" as GoodId;
  const tools = "good:tools" as GoodId;
  return {
    ESSENTIAL_FOOD: {
      id: "ESSENTIAL_FOOD",
      perCapitaTarget: 0,
      priority: 4,
      substitutionGoods: [{ goodId: food, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
    BASIC_GOODS: {
      id: "BASIC_GOODS",
      perCapitaTarget: 0,
      priority: 3,
      substitutionGoods: [{ goodId: wood, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
    SERVICES: {
      id: "SERVICES",
      perCapitaTarget: 0,
      priority: 2,
      substitutionGoods: [{ goodId: cloth, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
    COMFORT: {
      id: "COMFORT",
      perCapitaTarget: 0,
      priority: 1,
      substitutionGoods: [{ goodId: tools, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1,
      inventoryCarryoverTicks: 0,
    },
  };
}

function canonicalWageFixture(controlled = true): WageFixture {
  const world = buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
  const match = [...world.productionUnits.values()].flatMap((unit) => {
    if (unit.seed.status !== "ACTIVE") return [];
    const region = [...world.regions.values()].find((candidate) => candidate.seed.key === unit.seed.regionKey);
    if (region === undefined) return [];
    const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
    if (recipe === undefined) return [];
    const cohort = [...world.cohorts.values()].find(
      (candidate) =>
        candidate.seed.regionKey === unit.seed.regionKey &&
        candidate.seed.ageBand === "WORKING" &&
        candidate.seed.laborCategory === recipe.laborCategory &&
        candidate.seed.population > 0,
    );
    if (cohort === undefined) return [];
    if (controlled && region.controllerStateId === null) return [];
    return [{ unit, region, recipe, cohort }];
  })[0];
  if (match === undefined) throw new Error("Baseline fixture has no suitable active unit/working cohort pair");

  const tick = 7;
  const allocation: LaborAllocation = {
    allocationId: `labor-allocation:${tick}:${String(match.region.regionId)}:${match.recipe.laborCategory}:${String(match.cohort.cohortId)}:${String(match.unit.productionUnitId)}`,
    tick,
    regionId: match.region.regionId,
    laborCategory: match.recipe.laborCategory,
    cohortId: match.cohort.cohortId,
    unitId: match.unit.productionUnitId,
    workerEquivalents: 1,
    grossWagePerWorker: 10,
    grossWageObligation: 10,
  };
  const demand: LaborDemandPlan = {
    planId: `labor-demand-plan:${tick}:${String(match.unit.productionUnitId)}`,
    productionPlanId: `production-plan:${tick}:${String(match.unit.productionUnitId)}`,
    unitId: match.unit.productionUnitId,
    regionId: match.region.regionId,
    laborCategory: match.recipe.laborCategory,
    requestedWorkerEquivalents: 1,
    grossWageOffer: 10,
    grossPayrollCap: 10,
  };
  const controllerStateId = controlled ? match.region.controllerStateId : null;
  const settlements = planWageSettlementsPhase5({
    tick,
    world,
    laborDemandPlans: [demand],
    laborAllocations: [allocation],
    effectiveJurisdictionByRegion: new Map([[match.region.regionId, controllerStateId]]),
    taxPolicy: {
      assessWageIncomeTax: (_stateId, _cohortId, grossWage) => grossWage * 0.2,
      getCollectionEfficiency: () => 0.5,
    },
  });
  const settlement = settlements[0];
  if (settlement === undefined) throw new Error("Canonical Phase-5 fixture produced no WageSettlement");
  const transactions: EconomicTransaction[] = [settlement.wagePaymentTransaction];
  if (settlement.wageTaxWithheldTransaction !== undefined) {
    transactions.push(settlement.wageTaxWithheldTransaction);
  }

  const phase9World: WorldState = {
    ...world,
    definitionRegistry: {
      ...world.definitionRegistry,
      needCategories: zeroNeedCategories(),
    },
    cohorts: new Map([[match.cohort.cohortId, match.cohort]]),
  };
  const supply: LaborSupplyPlan = {
    planId: `labor-supply:${tick}:${String(match.cohort.cohortId)}`,
    cohortId: match.cohort.cohortId,
    regionId: match.region.regionId,
    laborCategory: match.recipe.laborCategory,
    availableWorkerEquivalents: 1,
  };
  return { world: phase9World, supply, allocation, settlement, transactions };
}

function phase9(fixture: WageFixture, args?: {
  readonly settlement?: WageSettlement;
  readonly transactions?: readonly EconomicTransaction[];
}) {
  return planHouseholdConsumptionPhase9({
    world: fixture.world,
    tick: 7,
    marketAllocations: [],
    laborSupplyPlans: [fixture.supply],
    laborAllocations: [fixture.allocation],
    wageSettlements: [args?.settlement ?? fixture.settlement],
    transactions: args?.transactions ?? fixture.transactions,
  });
}

describe("REQ-POPULATION-003 Phase-9 wage withholding evidence", () => {
  it("accepts the canonical taxed Phase-5 bundle without recomputing tax", () => {
    const fixture = canonicalWageFixture(true);
    expect(fixture.settlement.wageTaxWithheldTransaction).toBeDefined();

    const economic = phase9(fixture).executions[0]!.economic;
    expect(economic.grossWageIncome).toBe(10);
    expect(economic.netWageReceipt).toBe(9);
    expect(economic.wageTaxWithheld).toBe(1);
  });

  it("rejects positive collected withholding when canonical or actual tax-transfer evidence is absent", () => {
    const fixture = canonicalWageFixture(true);
    const paymentOnly = [fixture.settlement.wagePaymentTransaction];

    expect(() => phase9(fixture, { transactions: paymentOnly })).toThrow(
      /exactly one actual WAGE_TAX_WITHHELD transaction attributable to its wage bundle\/allocation/,
    );

    const missingCanonical: WageSettlement = {
      ...fixture.settlement,
      wageTaxWithheldTransaction: undefined,
    };
    expect(() => phase9(fixture, { settlement: missingCanonical, transactions: paymentOnly })).toThrow(
      /positive collected tax must include canonical WAGE_TAX_WITHHELD evidence/,
    );
  });

  it("rejects one-field WAGE_TAX_WITHHELD provenance and amount mismatches", () => {
    const fixture = canonicalWageFixture(true);
    const canonical = fixture.settlement.wageTaxWithheldTransaction;
    if (canonical === undefined) throw new Error("Expected canonical positive withholding transaction");
    const payment = fixture.settlement.wagePaymentTransaction;

    const provenanceMismatches: readonly EconomicTransaction[] = [
      { ...canonical, tick: 8 },
      { ...canonical, phase: 6 },
      { ...canonical, bundleId: createTransactionBundleId("tb:7:5:wage:forged") },
      { ...canonical, originatingTransactionId: createTransactionId("tx:7:5:wage-payment:forged") },
      { ...canonical, source: { type: "PRODUCTION_UNIT", productionUnitId: "unit:forged" as ProductionUnitId } },
      { ...canonical, destination: { type: "STATE", stateId: "state:forged" as StateId } },
      { ...canonical, currencyId: "currency:forged" as CurrencyId },
      { ...canonical, sourceRegionId: "region:forged" as RegionId },
      { ...canonical, destinationRegionId: "region:forged" as RegionId },
      { ...canonical, reason: "labor-allocation:forged" },
    ];
    for (const forged of provenanceMismatches) {
      expect(() => phase9(fixture, { transactions: [payment, forged] })).toThrow(/provenance mismatch/);
    }

    const amountMismatches: readonly EconomicTransaction[] = [
      { ...canonical, moneyAmount: 2 },
      { ...canonical, grossMoneyAmount: 11 },
      { ...canonical, assessedTaxAmount: 3 },
      { ...canonical, taxAmount: 2 },
      { ...canonical, amount: 2 },
    ];
    for (const forged of amountMismatches) {
      expect(() => phase9(fixture, { transactions: [payment, forged] })).toThrow(
        /does not match Phase-5 settlement evidence/,
      );
    }
  });

  it("rejects an extra distinct-ID withholding leg on a positive-tax wage bundle", () => {
    const fixture = canonicalWageFixture(true);
    const canonical = fixture.settlement.wageTaxWithheldTransaction;
    if (canonical === undefined) throw new Error("Expected canonical positive withholding transaction");

    const extraWithholding: EconomicTransaction = {
      ...canonical,
      transactionId: createTransactionId("tx:7:5:wage-tax:extra-positive"),
    };

    expect(() => phase9(fixture, { transactions: [...fixture.transactions, extraWithholding] })).toThrow(
      /exactly one actual WAGE_TAX_WITHHELD transaction attributable to its wage bundle\/allocation/,
    );
  });

  it("rejects an actual same-bundle withholding leg when canonical collected tax is zero", () => {
    const fixture = canonicalWageFixture(false);
    const stateId = [...fixture.world.states.keys()][0];
    if (stateId === undefined) throw new Error("Expected baseline fixture State");
    const payment = fixture.settlement.wagePaymentTransaction;
    const extraWithholding: EconomicTransaction = {
      tick: fixture.settlement.tick,
      phase: 5,
      type: "WAGE_TAX_WITHHELD",
      transactionId: createTransactionId("tx:7:5:wage-tax:extra-zero"),
      bundleId: fixture.settlement.bundleId,
      originatingTransactionId: payment.transactionId,
      source: { type: "PRODUCTION_UNIT", productionUnitId: fixture.settlement.unitId },
      destination: { type: "STATE", stateId },
      currencyId: fixture.settlement.currencyId,
      moneyAmount: 1,
      grossMoneyAmount: fixture.settlement.grossWage,
      assessedTaxAmount: 1,
      taxAmount: 1,
      sourceRegionId: fixture.settlement.regionId,
      destinationRegionId: fixture.settlement.regionId,
      amount: 1,
      reason: fixture.settlement.allocationId,
    };

    expect(() => phase9(fixture, { transactions: [...fixture.transactions, extraWithholding] })).toThrow(
      /zero collected tax must have zero actual WAGE_TAX_WITHHELD transactions attributable to its wage bundle\/allocation/,
    );
  });

  it("rejects a coherently rewritten withholding destination that disagrees with Phase-1 jurisdiction", () => {
    const fixture = canonicalWageFixture(true);
    const authoritativeController = fixture.settlement.controllerStateId;
    const canonicalWithholding = fixture.settlement.wageTaxWithheldTransaction;
    if (authoritativeController === null || canonicalWithholding === undefined) {
      throw new Error("Expected canonical controlled positive withholding fixture");
    }

    const forgedStateId = "state:forged" as StateId;
    const forgedWithholding: EconomicTransaction = {
      ...canonicalWithholding,
      destination: { type: "STATE", stateId: forgedStateId },
    };
    const forgedSettlement: WageSettlement = {
      ...fixture.settlement,
      controllerStateId: forgedStateId,
      wageTaxWithheldTransaction: forgedWithholding as WageSettlement["wageTaxWithheldTransaction"],
    };
    const base = initializeTickContext(7, fixture.world.seed);
    const context: TickContext = {
      ...base,
      phase: 9,
      effectiveJurisdictionByRegion: new Map([[fixture.allocation.regionId, authoritativeController]]),
      laborSupplyPlans: [fixture.supply],
      laborAllocations: [fixture.allocation],
      wageSettlements: [forgedSettlement],
      transactions: [fixture.settlement.wagePaymentTransaction, forgedWithholding],
    };

    const handler = createPhase9HouseholdConsumptionHandler();
    expect(() => handler(fixture.world, context, fixture.world.pendingTransitions)).toThrow(
      /controller State does not match Phase-1 effective jurisdiction/,
    );
  });

  it("accepts canonical zero-collected-tax Phase-5 evidence without a withholding transfer", () => {
    const fixture = canonicalWageFixture(false);
    expect(fixture.settlement.collectedTax).toBe(0);
    expect(fixture.settlement.wageTaxWithheldTransaction).toBeUndefined();

    const economic = phase9(fixture).executions[0]!.economic;
    expect(economic.grossWageIncome).toBe(10);
    expect(economic.netWageReceipt).toBe(10);
    expect(economic.wageTaxWithheld).toBe(0);
  });
});
