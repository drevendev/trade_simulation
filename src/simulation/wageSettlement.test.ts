import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId, ProductionUnitId, RegionId, StateId } from "../domain/id";
import { createPhase3LaborAllocationHandler, type LaborAllocation } from "./laborAllocation";
import { createPhase2LaborSupplyPlanningHandler } from "./laborSupplyPlanning";
import {
  createPhase2ProductionPlanningHandler,
  type LaborDemandPlan,
  type ProductionPlanningEvidence,
} from "./productionPlanning";
import { composePhaseHandlers, executePhase, initializeTickContext } from "./tickOrchestrator";
import {
  applyWageSettlementTransition,
  createPhase5WageSettlementHandler,
  getPostWageSpendableBalance,
  planWageSettlementsPhase5,
  type WageTaxPolicyProvider,
} from "./wageSettlement";
import { buildInitialWorld, type WorldState } from "./worldState";

function fixture() {
  const world = buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );

  const unit = [...world.productionUnits.values()].find((candidate) => {
    if (candidate.seed.status !== "ACTIVE") return false;
    return [...world.cohorts.values()].filter(
      (cohort) => cohort.seed.regionKey === candidate.seed.regionKey && cohort.seed.ageBand === "WORKING",
    ).length >= 2;
  });
  expect(unit).toBeDefined();

  const region = [...world.regions.values()].find((candidate) => candidate.seed.key === unit!.seed.regionKey);
  expect(region).toBeDefined();
  expect(region!.controllerStateId).not.toBeNull();

  const cohorts = [...world.cohorts.values()]
    .filter((cohort) => cohort.seed.regionKey === unit!.seed.regionKey && cohort.seed.ageBand === "WORKING")
    .sort((a, b) => String(a.cohortId).localeCompare(String(b.cohortId)));
  expect(cohorts.length).toBeGreaterThanOrEqual(2);

  const recipe = world.definitionRegistry.recipes[unit!.seed.recipeId];
  expect(recipe).toBeDefined();

  const currencyId = region!.settlementCurrencyId;
  const productionUnits = new Map(world.productionUnits);
  for (const candidate of world.productionUnits.values()) {
    const candidateRegion = [...world.regions.values()].find(
      (value) => value.seed.key === candidate.seed.regionKey,
    );
    if (candidateRegion === undefined) throw new Error(`Missing Region for ${String(candidate.productionUnitId)}`);
    const candidateWallet = new Map(candidate.wallet);
    candidateWallet.set(
      candidateRegion.settlementCurrencyId,
      candidate.productionUnitId === unit!.productionUnitId ? 1_000 : 0,
    );
    productionUnits.set(candidate.productionUnitId, { ...candidate, wallet: candidateWallet });
  }

  // Keep exactly one positive WORKING supply source in the target labor group so the
  // canonical positive fixture produces one authoritative allocation. Other cohort rows
  // remain present for settlement-planning negative tests but do not become Phase-2 supply.
  const cohortStates = new Map(world.cohorts);
  const primaryCohortId = cohorts[0]!.cohortId;
  for (const candidate of world.cohorts.values()) {
    if (
      candidate.cohortId !== primaryCohortId &&
      candidate.seed.regionKey === unit!.seed.regionKey &&
      candidate.seed.ageBand === "WORKING" &&
      candidate.seed.laborCategory === recipe!.laborCategory
    ) {
      cohortStates.set(candidate.cohortId, {
        ...candidate,
        seed: { ...candidate.seed, population: 0 },
      });
    }
  }

  const fundedWorld: WorldState = { ...world, productionUnits, cohorts: cohortStates };
  const fundedCohorts = cohorts.map((candidate) => cohortStates.get(candidate.cohortId)!);

  return {
    world: fundedWorld,
    unit: productionUnits.get(unit!.productionUnitId)!,
    region: region!,
    cohorts: fundedCohorts,
    laborCategory: recipe!.laborCategory,
    stateId: region!.controllerStateId!,
    currencyId,
  };
}

function demand(args: {
  unitId: ProductionUnitId;
  regionId: RegionId;
  laborCategory: string;
  requested?: number;
  wage?: number;
  cap?: number;
  tick?: number;
}): LaborDemandPlan {
  const requested = args.requested ?? 10;
  const wage = args.wage ?? 10;
  const tick = args.tick ?? 9;
  return {
    planId: `labor-demand-plan:${tick}:${String(args.unitId)}`,
    productionPlanId: `production-plan:${tick}:${String(args.unitId)}`,
    unitId: args.unitId,
    regionId: args.regionId,
    laborCategory: args.laborCategory,
    requestedWorkerEquivalents: requested,
    grossWageOffer: wage,
    grossPayrollCap: args.cap ?? requested * wage,
  };
}

function allocation(args: {
  unitId: ProductionUnitId;
  cohortId: CohortId;
  regionId: RegionId;
  laborCategory: string;
  workers?: number;
  wage?: number;
  suffix?: string;
  tick?: number;
}): LaborAllocation {
  const workers = args.workers ?? 10;
  const wage = args.wage ?? 10;
  const tick = args.tick ?? 9;
  return {
    allocationId: `labor-allocation:${tick}:${String(args.regionId)}:${args.laborCategory}:${String(args.cohortId)}:${String(args.unitId)}`,
    tick,
    regionId: args.regionId,
    laborCategory: args.laborCategory,
    cohortId: args.cohortId,
    unitId: args.unitId,
    workerEquivalents: workers,
    grossWagePerWorker: wage,
    grossWageObligation: workers * wage,
  };
}

function policy(rate = 0.2, efficiency = 0.5): WageTaxPolicyProvider {
  return {
    assessWageIncomeTax: (_stateId, _cohortId, grossWage) => grossWage * rate,
    getCollectionEfficiency: () => efficiency,
  };
}

function jurisdiction(regionId: RegionId, stateId: StateId | null) {
  return new Map<RegionId, StateId | null>([[regionId, stateId]]);
}

function baseEvidence() {
  const base = fixture();
  const phase3Authority = completedPhase3Authority(base.world, 9);
  const laborAllocation = phase3Authority.laborAllocations?.find(
    (candidate) =>
      candidate.unitId === base.unit.productionUnitId && candidate.grossWageObligation > 0,
  );
  if (laborAllocation === undefined) {
    throw new Error("Canonical Phase-2/3 fixture did not produce positive target-unit payroll");
  }
  const laborDemand = phase3Authority.laborDemandPlans?.find(
    (candidate) => candidate.unitId === laborAllocation.unitId,
  );
  if (laborDemand === undefined) {
    throw new Error("Canonical Phase-2/3 fixture is missing target-unit LaborDemandPlan");
  }
  const selectedCohort = base.world.cohorts.get(laborAllocation.cohortId);
  if (selectedCohort === undefined) throw new Error("Canonical allocation references missing Cohort");
  const cohorts = [
    selectedCohort,
    ...base.cohorts.filter((candidate) => candidate.cohortId !== selectedCohort.cohortId),
  ];
  return { ...base, cohorts, laborDemand, laborAllocation, phase3Authority };
}

function productionPlanningEvidenceByUnit(
  world: WorldState,
): ReadonlyMap<ProductionUnitId, ProductionPlanningEvidence> {
  const evidenceByUnit = new Map<ProductionUnitId, ProductionPlanningEvidence>();
  for (const unit of world.productionUnits.values()) {
    const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
    if (recipe === undefined) throw new Error(`Missing recipe ${unit.seed.recipeId}`);
    const priorCloseGrossInputPriceByGood: Record<string, number> = {};
    for (const goodId of Object.keys(recipe.inputsPerBatch) as GoodId[]) {
      const price = world.definitionRegistry.goods[goodId]?.referencePrice;
      if (price === undefined) throw new Error(`Missing reference price for ${String(goodId)}`);
      priorCloseGrossInputPriceByGood[goodId] = price;
    }
    const priorCloseGrossInvestmentPriceByGood: Record<string, number> = {};
    for (const goodId of Object.keys(recipe.investmentGoodsPerCapitalUnit) as GoodId[]) {
      const price = world.definitionRegistry.goods[goodId]?.referencePrice;
      if (price === undefined) throw new Error(`Missing reference price for ${String(goodId)}`);
      priorCloseGrossInvestmentPriceByGood[goodId] = price;
    }
    evidenceByUnit.set(unit.productionUnitId, {
      mandatoryKnownCash: 0,
      legalMinimumWageFloor: 0,
      priorCloseGrossInputPriceByGood: priorCloseGrossInputPriceByGood as Record<GoodId, number>,
      priorCloseGrossInvestmentPriceByGood:
        priorCloseGrossInvestmentPriceByGood as Record<GoodId, number>,
      infrastructureFactor: 1,
      resourceAccessFactor: 1,
      healthLaborProductivityFactor: 1,
    });
  }
  return evidenceByUnit;
}

function completedPhase3Authority(world: WorldState, tick: number) {
  const phase2 = executePhase(
    2,
    composePhaseHandlers(
      createPhase2LaborSupplyPlanningHandler(),
      createPhase2ProductionPlanningHandler({
        evidenceByUnit: productionPlanningEvidenceByUnit(world),
      }),
    ),
    world,
    initializeTickContext(tick, world.seed),
    world.pendingTransitions,
  );
  return executePhase(
    3,
    createPhase3LaborAllocationHandler(),
    world,
    phase2,
    world.pendingTransitions,
  );
}

describe("REQ-PRODUCTION-004 Phase-5 wage settlement", () => {
  it("PCL-I9 atomically conserves gross payroll across cohort net wage and collected State tax", () => {
    const base = baseEvidence();
    const originalUnitCash = base.unit.wallet.get(base.currencyId) ?? 0;
    const originalCohortCash = base.cohorts[0]!.wallet.get(base.currencyId) ?? 0;
    const originalStateCash = base.world.states.get(base.stateId)!.treasury.get(base.currencyId) ?? 0;

    const settlements = planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });

    expect(settlements).toHaveLength(1);
    const settlement = settlements[0]!;
    const expectedGross = base.laborAllocation.grossWageObligation;
    const expectedAssessedTax = expectedGross * 0.2;
    const expectedCollectedTax = expectedAssessedTax * 0.5;
    const expectedNetWage = expectedGross - expectedCollectedTax;
    expect(settlement.grossWage).toBeCloseTo(expectedGross, 12);
    expect(settlement.assessedTax).toBeCloseTo(expectedAssessedTax, 12);
    expect(settlement.collectedTax).toBeCloseTo(expectedCollectedTax, 12);
    expect(settlement.uncollectedAssessedTax).toBeCloseTo(expectedAssessedTax - expectedCollectedTax, 12);
    expect(settlement.netWage).toBeCloseTo(expectedNetWage, 12);
    expect(settlement.netWage + settlement.collectedTax).toBeCloseTo(settlement.grossWage, 12);
    expect(settlement.wagePaymentTransaction.type).toBe("WAGE_PAYMENT");
    expect(settlement.wagePaymentTransaction.moneyAmount).toBeCloseTo(expectedNetWage, 12);
    expect(settlement.wageTaxWithheldTransaction?.type).toBe("WAGE_TAX_WITHHELD");
    expect(settlement.wageTaxWithheldTransaction?.moneyAmount).toBeCloseTo(expectedCollectedTax, 12);
    expect(settlement.wageTaxWithheldTransaction?.originatingTransactionId).toBe(
      settlement.wagePaymentTransaction.transactionId,
    );
    expect(settlement.wageTaxWithheldTransaction?.bundleId).toBe(settlement.bundleId);

    const settledWorld = applyWageSettlementTransition(
      base.world,
      settlements,
      9,
      base.phase3Authority,
    );
    expect(settledWorld.lastWageSettlementTransitionTick).toBe(9);
    expect(settledWorld.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBeCloseTo(
      originalUnitCash - expectedGross,
      12,
    );
    expect(settledWorld.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBeCloseTo(
      originalCohortCash + expectedNetWage,
      12,
    );
    expect(settledWorld.states.get(base.stateId)!.treasury.get(base.currencyId)).toBeCloseTo(
      originalStateCash + expectedCollectedTax,
      12,
    );

    // The input WorldState is still the opening authoritative stock for this tick.
    expect(base.world.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(originalUnitCash);
    expect(base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBe(originalCohortCash);
    expect(base.world.states.get(base.stateId)!.treasury.get(base.currencyId)).toBe(originalStateCash);

    // Phase-8 affordability can observe this tick's accepted net wage before persistence.
    expect(
      getPostWageSpendableBalance(
        base.world,
        settlements,
        { type: "COHORT", cohortId: base.cohorts[0]!.cohortId },
        base.currencyId,
      ),
    ).toBeCloseTo(originalCohortCash + expectedNetWage, 12);
  });

  it("persists wage settlements exactly once and rejects stale tick provenance atomically", () => {
    const base = baseEvidence();
    const settlements9 = planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const phase3Authority9 = base.phase3Authority;
    const settled9 = applyWageSettlementTransition(base.world, settlements9, 9, phase3Authority9);
    const unitCashAfter9 = settled9.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId);
    const cohortCashAfter9 = settled9.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId);
    const stateCashAfter9 = settled9.states.get(base.stateId)!.treasury.get(base.currencyId);

    expect(settled9.lastWageSettlementTransitionTick).toBe(9);
    expect(() => applyWageSettlementTransition(settled9, settlements9, 9, phase3Authority9)).toThrow(/cannot persist after tick 9/);
    expect(() =>
      applyWageSettlementTransition(settled9, [], 8, completedPhase3Authority(settled9, 8)),
    ).toThrow(/cannot persist after tick 9/);
    expect(() =>
      applyWageSettlementTransition(
        settled9,
        settlements9,
        10,
        completedPhase3Authority(settled9, 10),
      ),
    ).toThrow(/is for tick 9, expected 10/);
    expect(settled9.lastWageSettlementTransitionTick).toBe(9);
    expect(settled9.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(unitCashAfter9);
    expect(settled9.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBe(cohortCashAfter9);
    expect(settled9.states.get(base.stateId)!.treasury.get(base.currencyId)).toBe(stateCashAfter9);

    const phase3Authority10 = completedPhase3Authority(settled9, 10);
    const laborAllocation10 = phase3Authority10.laborAllocations?.find(
      (candidate) => candidate.unitId === base.unit.productionUnitId && candidate.grossWageObligation > 0,
    );
    if (laborAllocation10 === undefined) throw new Error("Expected positive canonical tick-10 payroll");
    const laborDemand10 = phase3Authority10.laborDemandPlans?.find(
      (candidate) => candidate.unitId === laborAllocation10.unitId,
    );
    if (laborDemand10 === undefined) throw new Error("Missing canonical tick-10 LaborDemandPlan");
    const settlements10 = planWageSettlementsPhase5({
      tick: 10,
      world: settled9,
      laborDemandPlans: [laborDemand10],
      laborAllocations: [laborAllocation10],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const settlement10 = settlements10[0]!;
    const settled10 = applyWageSettlementTransition(
      settled9,
      settlements10,
      10,
      phase3Authority10,
    );
    expect(settled10.lastWageSettlementTransitionTick).toBe(10);
    expect(settled10.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBeCloseTo(
      unitCashAfter9! - settlement10.grossWage,
      12,
    );
    expect(settled10.cohorts.get(laborAllocation10.cohortId)!.wallet.get(base.currencyId)).toBeCloseTo(
      (settled9.cohorts.get(laborAllocation10.cohortId)!.wallet.get(base.currencyId) ?? 0) + settlement10.netWage,
      12,
    );
    expect(settled10.states.get(base.stateId)!.treasury.get(base.currencyId)).toBeCloseTo(
      stateCashAfter9! + settlement10.collectedTax,
      12,
    );
  });

  it("rejects an empty batch when canonical Phase-3 evidence contains a positive wage obligation", () => {
    const base = baseEvidence();
    const originalUnitWallet = base.world.productionUnits.get(base.unit.productionUnitId)!.wallet;
    const originalCohortWallet = base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet;
    const originalStateTreasury = base.world.states.get(base.stateId)!.treasury;

    expect(() =>
      applyWageSettlementTransition(base.world, [], 9, initializeTickContext(9, base.world.seed)),
    ).toThrow(/requires completed Phase-3 labor-allocation authority/);
    expect(() =>
      executePhase(
        3,
        createPhase3LaborAllocationHandler(),
        base.world,
        initializeTickContext(9, base.world.seed),
        base.world.pendingTransitions,
      ),
    ).toThrow(/requires complete Phase-2 labor supply and demand evidence/);
    expect(() =>
      executePhase(
        3,
        createPhase3LaborAllocationHandler(),
        base.world,
        {
          ...initializeTickContext(9, base.world.seed),
          laborSupplyPlans: [],
          laborDemandPlans: [],
        },
        base.world.pendingTransitions,
      ),
    ).toThrow(/incomplete Phase-2 labor-supply evidence/);
    const fabricatedEmptyAuthority = {
      ...initializeTickContext(9, base.world.seed),
      phase: 3,
      laborAllocations: [],
    };
    expect(() =>
      applyWageSettlementTransition(base.world, [], 9, fabricatedEmptyAuthority),
    ).toThrow(/not issued by the canonical Phase-3 handler/);
    const forgedCanonicalIds = {
      ...initializeTickContext(9, base.world.seed),
      laborSupplyPlans: base.phase3Authority.laborSupplyPlans!.map((plan) => ({
        ...plan,
        availableWorkerEquivalents: 0,
      })),
      laborDemandPlans: base.phase3Authority.laborDemandPlans!.map((plan) => ({
        ...plan,
        requestedWorkerEquivalents: 0,
        grossWageOffer: 0,
        grossPayrollCap: 0,
      })),
    };
    expect(() =>
      executePhase(
        3,
        createPhase3LaborAllocationHandler(),
        base.world,
        forgedCanonicalIds,
        base.world.pendingTransitions,
      ),
    ).toThrow(/not issued by the canonical Phase-2 handler/);
    expect(() =>
      applyWageSettlementTransition(base.world, [], 9, base.phase3Authority),
    ).toThrow(/missing canonical LaborAllocation/);
    expect(base.world.lastWageSettlementTransitionTick).toBe(-1);
    expect(base.world.productionUnits.get(base.unit.productionUnitId)!.wallet).toEqual(originalUnitWallet);
    expect(base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet).toEqual(originalCohortWallet);
    expect(base.world.states.get(base.stateId)!.treasury).toEqual(originalStateTreasury);

    const moneyEpsilon = base.world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
    const canonicalSupply = base.phase3Authority.laborSupplyPlans?.find(
      (plan) => plan.cohortId === base.laborAllocation.cohortId,
    );
    if (canonicalSupply === undefined || canonicalSupply.availableWorkerEquivalents <= 0) {
      throw new Error("Expected positive canonical labor supply");
    }
    const tinyWage = moneyEpsilon / (2 * Math.max(1, canonicalSupply.availableWorkerEquivalents));
    const tinyUnits = new Map(base.world.productionUnits);
    tinyUnits.set(base.unit.productionUnitId, { ...base.unit, wageOffer: tinyWage });
    const tinyWorld: WorldState = { ...base.world, productionUnits: tinyUnits };
    const tinyAuthority = completedPhase3Authority(tinyWorld, 9);
    const tinyPositiveAllocation = tinyAuthority.laborAllocations?.find(
      (candidate) => candidate.unitId === base.unit.productionUnitId && candidate.grossWageObligation > 0,
    );
    if (tinyPositiveAllocation === undefined) throw new Error("Expected positive sub-epsilon canonical payroll");
    expect(tinyPositiveAllocation.grossWageObligation).toBeLessThan(moneyEpsilon);
    expect(() =>
      applyWageSettlementTransition(tinyWorld, [], 9, tinyAuthority),
    ).toThrow(/missing canonical LaborAllocation/);
    expect(tinyWorld.lastWageSettlementTransitionTick).toBe(-1);

    const settlements = planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const settled = applyWageSettlementTransition(
      base.world,
      settlements,
      9,
      base.phase3Authority,
    );
    const positiveSettlement = settlements[0]!;
    expect(settled.lastWageSettlementTransitionTick).toBe(9);
    expect(settled.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBeCloseTo(
      (base.unit.wallet.get(base.currencyId) ?? 0) - positiveSettlement.grossWage,
      12,
    );
    expect(settled.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBeCloseTo(
      (base.cohorts[0]!.wallet.get(base.currencyId) ?? 0) + positiveSettlement.netWage,
      12,
    );
    expect(settled.states.get(base.stateId)!.treasury.get(base.currencyId)).toBeCloseTo(
      (base.world.states.get(base.stateId)!.treasury.get(base.currencyId) ?? 0) + positiveSettlement.collectedTax,
      12,
    );
  });

  it("rejects an incomplete settlement batch before any wallet or marker mutation", () => {
    const base = baseEvidence();
    const secondCohort = base.cohorts[1]!;
    const cohorts = new Map(base.world.cohorts);
    cohorts.set(base.cohorts[0]!.cohortId, {
      ...base.cohorts[0]!,
      seed: { ...base.cohorts[0]!.seed, population: 1 },
    });
    cohorts.set(secondCohort.cohortId, {
      ...secondCohort,
      seed: {
        ...secondCohort.seed,
        regionKey: base.region.seed.key,
        ageBand: "WORKING",
        laborCategory: base.laborCategory,
        population: 100_000,
      },
    });
    const productionUnits = new Map(base.world.productionUnits);
    const richWallet = new Map(base.unit.wallet);
    richWallet.set(base.currencyId, 1_000_000);
    productionUnits.set(base.unit.productionUnitId, {
      ...base.unit,
      wallet: richWallet,
      installedCapital: Math.max(base.unit.installedCapital, 1_000),
    });
    const splitWorld: WorldState = { ...base.world, cohorts, productionUnits };
    const splitAuthority = completedPhase3Authority(splitWorld, 9);
    const positiveAllocations = (splitAuthority.laborAllocations ?? []).filter(
      (candidate) => candidate.unitId === base.unit.productionUnitId && candidate.grossWageObligation > 0,
    );
    expect(positiveAllocations.length).toBeGreaterThanOrEqual(2);
    const settlements = planWageSettlementsPhase5({
      tick: 9,
      world: splitWorld,
      laborDemandPlans: splitAuthority.laborDemandPlans ?? [],
      laborAllocations: splitAuthority.laborAllocations ?? [],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const originalUnitWallet = splitWorld.productionUnits.get(base.unit.productionUnitId)!.wallet;
    const originalFirstCohortWallet = splitWorld.cohorts.get(base.cohorts[0]!.cohortId)!.wallet;
    const originalSecondCohortWallet = splitWorld.cohorts.get(secondCohort.cohortId)!.wallet;
    const originalStateTreasury = splitWorld.states.get(base.stateId)!.treasury;

    expect(() =>
      applyWageSettlementTransition(
        splitWorld,
        settlements.slice(0, -1),
        9,
        splitAuthority,
      ),
    ).toThrow(/missing canonical LaborAllocation/);
    expect(splitWorld.lastWageSettlementTransitionTick).toBe(-1);
    expect(splitWorld.productionUnits.get(base.unit.productionUnitId)!.wallet).toEqual(originalUnitWallet);
    expect(splitWorld.cohorts.get(base.cohorts[0]!.cohortId)!.wallet).toEqual(originalFirstCohortWallet);
    expect(splitWorld.cohorts.get(secondCohort.cohortId)!.wallet).toEqual(originalSecondCohortWallet);
    expect(splitWorld.states.get(base.stateId)!.treasury).toEqual(originalStateTreasury);
  });

  it("closes a genuinely zero-payroll tick exactly once only after complete Phase-2 evidence reaches canonical Phase 3", () => {
    const base = baseEvidence();
    const productionUnits = new Map(base.world.productionUnits);
    for (const unit of base.world.productionUnits.values()) {
      const region = [...base.world.regions.values()].find((candidate) => candidate.seed.key === unit.seed.regionKey)!;
      const wallet = new Map(unit.wallet);
      wallet.set(region.settlementCurrencyId, 0);
      productionUnits.set(unit.productionUnitId, { ...unit, wallet });
    }
    const zeroWorld: WorldState = { ...base.world, productionUnits };
    const phase3Authority = completedPhase3Authority(zeroWorld, 9);
    expect(phase3Authority.laborAllocations).toEqual([]);

    const closed = applyWageSettlementTransition(zeroWorld, [], 9, phase3Authority);
    expect(closed.lastWageSettlementTransitionTick).toBe(9);
    expect(closed.productionUnits.get(base.unit.productionUnitId)!.wallet).toEqual(zeroWorld.productionUnits.get(base.unit.productionUnitId)!.wallet);
    expect(closed.cohorts.get(base.cohorts[0]!.cohortId)!.wallet).toEqual(zeroWorld.cohorts.get(base.cohorts[0]!.cohortId)!.wallet);
    expect(closed.states.get(base.stateId)!.treasury).toEqual(zeroWorld.states.get(base.stateId)!.treasury);
    expect(() => applyWageSettlementTransition(closed, [], 9, phase3Authority)).toThrow(/cannot persist after tick 9/);
  });

  it("does not advance the wage marker when wallet preflight rejects the batch", () => {
    const base = baseEvidence();
    const settlements = planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const poorBalance = base.laborAllocation.grossWageObligation / 2;
    base.world.productionUnits.get(base.unit.productionUnitId)!.wallet.set(base.currencyId, poorBalance);

    expect(() =>
      applyWageSettlementTransition(
        base.world,
        settlements,
        9,
        base.phase3Authority,
      ),
    ).toThrow();
    expect(base.world.lastWageSettlementTransitionTick).toBe(-1);
    expect(base.world.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(poorBalance);
  });

  it("uncontrolled Regions assess and collect zero State wage tax without consulting the provider", () => {
    const base = baseEvidence();
    const throwingPolicy: WageTaxPolicyProvider = {
      assessWageIncomeTax: () => {
        throw new Error("must not be called");
      },
      getCollectionEfficiency: () => {
        throw new Error("must not be called");
      },
    };
    const [settlement] = planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, null),
      taxPolicy: throwingPolicy,
    });
    expect(settlement!.assessedTax).toBe(0);
    expect(settlement!.collectedTax).toBe(0);
    expect(settlement!.netWage).toBeCloseTo(base.laborAllocation.grossWageObligation, 12);
    expect(settlement!.wageTaxWithheldTransaction).toBeUndefined();
  });

  it("PCL-I10 preflights the whole unit payroll against the Phase-3 cap and available settlement cash", () => {
    const base = baseEvidence();
    const underfundedAmount = base.laborAllocation.grossWageObligation / 2;
    const undercappedDemand: LaborDemandPlan = {
      ...base.laborDemand,
      grossPayrollCap: underfundedAmount,
    };
    expect(() => planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [undercappedDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(),
    })).toThrow(/requested payroll exceeds grossPayrollCap/);

    const lowWallet = new Map(base.unit.wallet);
    lowWallet.set(base.currencyId, underfundedAmount);
    const units = new Map(base.world.productionUnits);
    units.set(base.unit.productionUnitId, { ...base.unit, wallet: lowWallet });
    const poorWorld: WorldState = { ...base.world, productionUnits: units };
    expect(() => planWageSettlementsPhase5({
      tick: 9,
      world: poorWorld,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(),
    })).toThrow(/exceeds available settlement-currency cash/);

    expect(poorWorld.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(underfundedAmount);

    // A zero wage makes payroll-cap arithmetic unable to detect excess worker allocation;
    // the worker-equivalent cap is therefore checked independently against Phase-3 demand.
    const zeroWageDemand = demand({
      unitId: base.unit.productionUnitId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      requested: 1,
      wage: 0,
      cap: 0,
    });
    const excessZeroWageWorkers = allocation({
      unitId: base.unit.productionUnitId,
      cohortId: base.cohorts[0]!.cohortId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      workers: 2,
      wage: 0,
      suffix: "zero-wage-overallocation",
    });
    expect(() => planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [zeroWageDemand],
      laborAllocations: [excessZeroWageWorkers],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(),
    })).toThrow(/exceed LaborDemandPlan requestedWorkerEquivalents/);
  });

  it("fails fast on duplicate, stale, malformed and cross-provenance allocation evidence", () => {
    const base = baseEvidence();
    const args = {
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(),
    } as const;

    expect(() => planWageSettlementsPhase5({ ...args, laborAllocations: [base.laborAllocation, base.laborAllocation] }))
      .toThrow(/Duplicate LaborAllocation/);
    expect(() => planWageSettlementsPhase5({
      ...args,
      laborAllocations: [{ ...base.laborAllocation, tick: 8 }],
    })).toThrow(/does not match Phase-5 tick/);
    expect(() => planWageSettlementsPhase5({
      ...args,
      laborAllocations: [{ ...base.laborAllocation, grossWageObligation: 99 }],
    })).toThrow(/does not equal workers × wage/);

    const otherRegion = [...base.world.regions.keys()].find((regionId) => regionId !== base.region.regionId)!;
    expect(() => planWageSettlementsPhase5({
      ...args,
      laborAllocations: [{ ...base.laborAllocation, regionId: otherRegion }],
    })).toThrow(/crosses its demand region\/laborCategory group/);
  });

  it("validates assessed-tax and collection inputs instead of coercing fiscal evidence", () => {
    const base = baseEvidence();
    expect(() => planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(1.01, 1),
    })).toThrow(/exceeds gross wage/);
    expect(() => planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, Number.NaN),
    })).toThrow(/must be finite/);
  });

  it("normalizes settlement and transaction order independent of allocation input order", () => {
    const base = baseEvidence();
    const first = allocation({
      unitId: base.unit.productionUnitId,
      cohortId: base.cohorts[0]!.cohortId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      workers: 4,
      suffix: "a",
    });
    const second = allocation({
      unitId: base.unit.productionUnitId,
      cohortId: base.cohorts[1]!.cohortId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      workers: 6,
      suffix: "b",
    });
    const common = {
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(),
    } as const;
    const forward = planWageSettlementsPhase5({ ...common, laborAllocations: [first, second] });
    const reversed = planWageSettlementsPhase5({ ...common, laborAllocations: [second, first] });
    expect(reversed).toEqual(forward);
  });

  it("Phase-5 handler exposes accepted settlements and linked transactions without mutating WorldState", () => {
    const base = baseEvidence();
    const handler = createPhase5WageSettlementHandler({ taxPolicy: policy(0.2, 0.5) });
    const initial = initializeTickContext(9, base.world.seed);
    const context = {
      ...initial,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
    };
    const result = executePhase(5, handler, base.world, context, base.world.pendingTransitions);
    expect(result.wageSettlements).toHaveLength(1);
    expect(result.transactions.map((transaction) => transaction.type)).toEqual([
      "WAGE_PAYMENT",
      "WAGE_TAX_WITHHELD",
    ]);
    expect(base.world.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(1_000);
  });
});
