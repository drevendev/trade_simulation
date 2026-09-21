import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, ProductionUnitId, RegionId, StateId } from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import type { LaborDemandPlan } from "./productionPlanning";
import { executePhase, initializeTickContext } from "./tickOrchestrator";
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
  const wallet = new Map(unit!.wallet);
  wallet.set(currencyId, 1_000);
  const productionUnits = new Map(world.productionUnits);
  productionUnits.set(unit!.productionUnitId, { ...unit!, wallet });
  const fundedWorld: WorldState = { ...world, productionUnits };

  return {
    world: fundedWorld,
    unit: productionUnits.get(unit!.productionUnitId)!,
    region: region!,
    cohorts,
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
    allocationId: `labor-allocation:${tick}:${String(args.regionId)}:${args.laborCategory}:${String(args.cohortId)}:${String(args.unitId)}:${args.suffix ?? "a"}`,
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
  const laborDemand = demand({
    unitId: base.unit.productionUnitId,
    regionId: base.region.regionId,
    laborCategory: base.laborCategory,
  });
  const laborAllocation = allocation({
    unitId: base.unit.productionUnitId,
    cohortId: base.cohorts[0]!.cohortId,
    regionId: base.region.regionId,
    laborCategory: base.laborCategory,
  });
  return { ...base, laborDemand, laborAllocation };
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
    expect(settlement.grossWage).toBe(100);
    expect(settlement.assessedTax).toBe(20);
    expect(settlement.collectedTax).toBe(10);
    expect(settlement.uncollectedAssessedTax).toBe(10);
    expect(settlement.netWage).toBe(90);
    expect(settlement.netWage + settlement.collectedTax).toBe(settlement.grossWage);
    expect(settlement.wagePaymentTransaction.type).toBe("WAGE_PAYMENT");
    expect(settlement.wagePaymentTransaction.moneyAmount).toBe(90);
    expect(settlement.wageTaxWithheldTransaction?.type).toBe("WAGE_TAX_WITHHELD");
    expect(settlement.wageTaxWithheldTransaction?.moneyAmount).toBe(10);
    expect(settlement.wageTaxWithheldTransaction?.originatingTransactionId).toBe(
      settlement.wagePaymentTransaction.transactionId,
    );
    expect(settlement.wageTaxWithheldTransaction?.bundleId).toBe(settlement.bundleId);

    const settledWorld = applyWageSettlementTransition(base.world, settlements, 9, [base.laborAllocation]);
    expect(settledWorld.lastWageSettlementTransitionTick).toBe(9);
    expect(settledWorld.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(
      originalUnitCash - 100,
    );
    expect(settledWorld.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBe(
      originalCohortCash + 90,
    );
    expect(settledWorld.states.get(base.stateId)!.treasury.get(base.currencyId)).toBe(
      originalStateCash + 10,
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
    ).toBe(originalCohortCash + 90);
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
    const settled9 = applyWageSettlementTransition(base.world, settlements9, 9, [base.laborAllocation]);
    const unitCashAfter9 = settled9.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId);
    const cohortCashAfter9 = settled9.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId);
    const stateCashAfter9 = settled9.states.get(base.stateId)!.treasury.get(base.currencyId);

    expect(settled9.lastWageSettlementTransitionTick).toBe(9);
    expect(() => applyWageSettlementTransition(settled9, settlements9, 9, [base.laborAllocation])).toThrow(/cannot persist after tick 9/);
    expect(() => applyWageSettlementTransition(settled9, [], 8, [])).toThrow(/cannot persist after tick 9/);
    expect(() =>
      applyWageSettlementTransition(settled9, settlements9, 10, [{ ...base.laborAllocation, tick: 10 }]),
    ).toThrow(/is for tick 9, expected 10/);
    expect(settled9.lastWageSettlementTransitionTick).toBe(9);
    expect(settled9.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(unitCashAfter9);
    expect(settled9.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBe(cohortCashAfter9);
    expect(settled9.states.get(base.stateId)!.treasury.get(base.currencyId)).toBe(stateCashAfter9);

    const laborDemand10 = demand({
      unitId: base.unit.productionUnitId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      tick: 10,
    });
    const laborAllocation10 = allocation({
      unitId: base.unit.productionUnitId,
      cohortId: base.cohorts[0]!.cohortId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      tick: 10,
    });
    const settlements10 = planWageSettlementsPhase5({
      tick: 10,
      world: settled9,
      laborDemandPlans: [laborDemand10],
      laborAllocations: [laborAllocation10],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const settled10 = applyWageSettlementTransition(settled9, settlements10, 10, [laborAllocation10]);
    expect(settled10.lastWageSettlementTransitionTick).toBe(10);
    expect(settled10.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(unitCashAfter9! - 100);
    expect(settled10.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBe(cohortCashAfter9! + 90);
    expect(settled10.states.get(base.stateId)!.treasury.get(base.currencyId)).toBe(stateCashAfter9! + 10);
  });

  it("rejects an empty batch when canonical Phase-3 evidence contains a positive wage obligation", () => {
    const base = baseEvidence();
    const originalUnitWallet = base.world.productionUnits.get(base.unit.productionUnitId)!.wallet;
    const originalCohortWallet = base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet;
    const originalStateTreasury = base.world.states.get(base.stateId)!.treasury;

    expect(() =>
      applyWageSettlementTransition(base.world, [], 9, [base.laborAllocation]),
    ).toThrow(/missing canonical LaborAllocation/);
    expect(base.world.lastWageSettlementTransitionTick).toBe(-1);
    expect(base.world.productionUnits.get(base.unit.productionUnitId)!.wallet).toEqual(originalUnitWallet);
    expect(base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet).toEqual(originalCohortWallet);
    expect(base.world.states.get(base.stateId)!.treasury).toEqual(originalStateTreasury);

    const settlements = planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [base.laborAllocation],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const settled = applyWageSettlementTransition(base.world, settlements, 9, [base.laborAllocation]);
    expect(settled.lastWageSettlementTransitionTick).toBe(9);
    expect(settled.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(900);
    expect(settled.cohorts.get(base.cohorts[0]!.cohortId)!.wallet.get(base.currencyId)).toBe(
      (base.cohorts[0]!.wallet.get(base.currencyId) ?? 0) + 90,
    );
    expect(settled.states.get(base.stateId)!.treasury.get(base.currencyId)).toBe(
      (base.world.states.get(base.stateId)!.treasury.get(base.currencyId) ?? 0) + 10,
    );
  });

  it("rejects an incomplete settlement batch before any wallet or marker mutation", () => {
    const base = baseEvidence();
    const first = allocation({
      unitId: base.unit.productionUnitId,
      cohortId: base.cohorts[0]!.cohortId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      workers: 4,
      suffix: "coverage-a",
    });
    const second = allocation({
      unitId: base.unit.productionUnitId,
      cohortId: base.cohorts[1]!.cohortId,
      regionId: base.region.regionId,
      laborCategory: base.laborCategory,
      workers: 6,
      suffix: "coverage-b",
    });
    const settlements = planWageSettlementsPhase5({
      tick: 9,
      world: base.world,
      laborDemandPlans: [base.laborDemand],
      laborAllocations: [first, second],
      effectiveJurisdictionByRegion: jurisdiction(base.region.regionId, base.stateId),
      taxPolicy: policy(0.2, 0.5),
    });
    const originalUnitWallet = base.world.productionUnits.get(base.unit.productionUnitId)!.wallet;
    const originalFirstCohortWallet = base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet;
    const originalSecondCohortWallet = base.world.cohorts.get(base.cohorts[1]!.cohortId)!.wallet;
    const originalStateTreasury = base.world.states.get(base.stateId)!.treasury;

    expect(() =>
      applyWageSettlementTransition(base.world, settlements.slice(0, 1), 9, [first, second]),
    ).toThrow(/missing canonical LaborAllocation/);
    expect(base.world.lastWageSettlementTransitionTick).toBe(-1);
    expect(base.world.productionUnits.get(base.unit.productionUnitId)!.wallet).toEqual(originalUnitWallet);
    expect(base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet).toEqual(originalFirstCohortWallet);
    expect(base.world.cohorts.get(base.cohorts[1]!.cohortId)!.wallet).toEqual(originalSecondCohortWallet);
    expect(base.world.states.get(base.stateId)!.treasury).toEqual(originalStateTreasury);
  });

  it("closes a genuinely zero-payroll tick exactly once", () => {
    const base = baseEvidence();
    const closed = applyWageSettlementTransition(base.world, [], 9, []);
    expect(closed.lastWageSettlementTransitionTick).toBe(9);
    expect(closed.productionUnits.get(base.unit.productionUnitId)!.wallet).toEqual(base.world.productionUnits.get(base.unit.productionUnitId)!.wallet);
    expect(closed.cohorts.get(base.cohorts[0]!.cohortId)!.wallet).toEqual(base.world.cohorts.get(base.cohorts[0]!.cohortId)!.wallet);
    expect(closed.states.get(base.stateId)!.treasury).toEqual(base.world.states.get(base.stateId)!.treasury);
    expect(() => applyWageSettlementTransition(closed, [], 9, [])).toThrow(/cannot persist after tick 9/);
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
    const wallet = new Map(base.unit.wallet);
    wallet.set(base.currencyId, 99);
    const productionUnits = new Map(base.world.productionUnits);
    productionUnits.set(base.unit.productionUnitId, { ...base.unit, wallet });
    const poorWorld: WorldState = { ...base.world, productionUnits };

    expect(() => applyWageSettlementTransition(poorWorld, settlements, 9, [base.laborAllocation])).toThrow();
    expect(poorWorld.lastWageSettlementTransitionTick).toBe(-1);
    expect(poorWorld.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(99);
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
    expect(settlement!.netWage).toBe(100);
    expect(settlement!.wageTaxWithheldTransaction).toBeUndefined();
  });

  it("PCL-I10 preflights the whole unit payroll against the Phase-3 cap and available settlement cash", () => {
    const base = baseEvidence();
    const undercappedDemand: LaborDemandPlan = {
      ...base.laborDemand,
      grossPayrollCap: 99,
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
    lowWallet.set(base.currencyId, 99);
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

    expect(poorWorld.productionUnits.get(base.unit.productionUnitId)!.wallet.get(base.currencyId)).toBe(99);

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
