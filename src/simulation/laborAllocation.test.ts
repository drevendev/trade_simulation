import { describe, expect, it } from "vitest";
import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { CohortId, ProductionUnitId, RegionId } from "../domain/id";
import type { LaborSupplyPlan } from "./laborSupplyPlanning";
import type { LaborDemandPlan } from "./productionPlanning";
import { allocateLaborPhase3, createPhase3LaborAllocationHandler } from "./laborAllocation";
import { initializeTickContext } from "./tickOrchestrator";
import type { CohortState, WorldState } from "./worldState";

const cohortId = (value: string) => value as CohortId;
const unitId = (value: string) => value as ProductionUnitId;
const regionId = (value: string) => value as RegionId;

function supply(id: string, available: number, region = "region:1", category = "GENERAL"): LaborSupplyPlan {
  return {
    planId: `labor-supply:7:${id}`,
    cohortId: cohortId(id),
    regionId: regionId(region),
    laborCategory: category,
    availableWorkerEquivalents: available,
  };
}

function demand(
  id: string,
  requested: number,
  wage: number,
  region = "region:1",
  category = "GENERAL",
): LaborDemandPlan {
  return {
    planId: `labor-demand-plan:7:${id}`,
    productionPlanId: `production-plan:7:${id}`,
    unitId: unitId(id),
    regionId: regionId(region),
    laborCategory: category,
    requestedWorkerEquivalents: requested,
    grossWageOffer: wage,
    grossPayrollCap: requested * wage,
  };
}

function allocate(args: {
  supplies: readonly LaborSupplyPlan[];
  demands: readonly LaborDemandPlan[];
  wages?: ReadonlyMap<CohortId, number>;
  config?: SimulationConfig;
}) {
  return allocateLaborPhase3({
    tick: 7,
    config: args.config ?? createDefaultSimulationConfig(),
    laborSupplyPlans: args.supplies,
    laborDemandPlans: args.demands,
    wageSignalByCohort: args.wages ?? new Map(args.supplies.map((plan) => [plan.cohortId, 10])),
  });
}

function totalBy<T extends string>(
  rows: readonly { readonly workerEquivalents: number }[],
  keyOf: (index: number) => T,
): ReadonlyMap<T, number> {
  const result = new Map<T, number>();
  rows.forEach((row, index) => result.set(keyOf(index), (result.get(keyOf(index)) ?? 0) + row.workerEquivalents));
  return result;
}

describe("REQ-PRODUCTION-003 Phase-3 labor allocation slice", () => {
  it("conserves matched worker-equivalents and never exceeds cohort supply or unit demand", () => {
    const supplies = [supply("cohort:b", 30), supply("cohort:a", 70)];
    const demands = [demand("unit:b", 25, 10), demand("unit:a", 55, 10)];
    const result = allocate({ supplies, demands });

    expect(result.reduce((sum, row) => sum + row.workerEquivalents, 0)).toBeCloseTo(80, 12);
    const byCohort = new Map<CohortId, number>();
    const byUnit = new Map<ProductionUnitId, number>();
    for (const row of result) {
      byCohort.set(row.cohortId, (byCohort.get(row.cohortId) ?? 0) + row.workerEquivalents);
      byUnit.set(row.unitId, (byUnit.get(row.unitId) ?? 0) + row.workerEquivalents);
      expect(row.grossWageObligation).toBeCloseTo(row.workerEquivalents * row.grossWagePerWorker, 12);
    }
    expect(byCohort.get(cohortId("cohort:a"))!).toBeLessThanOrEqual(70);
    expect(byCohort.get(cohortId("cohort:b"))!).toBeLessThanOrEqual(30);
    expect(byUnit.get(unitId("unit:a"))).toBeCloseTo(55, 12);
    expect(byUnit.get(unitId("unit:b"))).toBeCloseTo(25, 12);
  });

  it("gives a bounded wage-attractiveness advantage and respects employer caps", () => {
    const base = createDefaultSimulationConfig();
    const config: SimulationConfig = {
      ...base,
      labor: {
        ...base.labor,
        laborWageAttractivenessElasticity: 1,
        minWageWeight: 0.5,
        maxWageWeight: 2,
      },
    };
    const supplies = [supply("cohort:a", 60)];
    const result = allocate({
      supplies,
      demands: [demand("unit:low", 100, 5), demand("unit:high", 20, 100)],
      wages: new Map([[cohortId("cohort:a"), 10]]),
      config,
    });
    const high = result.filter((row) => row.unitId === unitId("unit:high")).reduce((sum, row) => sum + row.workerEquivalents, 0);
    const low = result.filter((row) => row.unitId === unitId("unit:low")).reduce((sum, row) => sum + row.workerEquivalents, 0);
    expect(high).toBeCloseTo(20, 12);
    expect(low).toBeCloseTo(40, 12);
  });

  it("uses supply-weighted cohort wageSignal as the regional reference wage", () => {
    const base = createDefaultSimulationConfig();
    const config: SimulationConfig = {
      ...base,
      labor: { ...base.labor, laborWageAttractivenessElasticity: 1, minWageWeight: 0.01, maxWageWeight: 100 },
    };
    const supplies = [supply("cohort:a", 75), supply("cohort:b", 25)];
    const wages = new Map<CohortId, number>([[cohortId("cohort:a"), 10], [cohortId("cohort:b"), 30]]);
    const result = allocate({ supplies, demands: [demand("unit:a", 100, 15)], wages, config });
    expect(result.reduce((sum, row) => sum + row.workerEquivalents, 0)).toBeCloseTo(100, 12);
    expect(result.every((row) => row.grossWagePerWorker === 15)).toBe(true);
  });

  it("is insertion-order invariant with stable cohort-to-unit IDs", () => {
    const supplies = [supply("cohort:c", 20), supply("cohort:a", 50), supply("cohort:b", 30)];
    const demands = [demand("unit:c", 40, 9), demand("unit:a", 20, 11), demand("unit:b", 40, 10)];
    const wages = new Map<CohortId, number>(supplies.map((plan, index) => [plan.cohortId, 8 + index]));
    const forward = allocate({ supplies, demands, wages });
    const reversed = allocate({ supplies: [...supplies].reverse(), demands: [...demands].reverse(), wages });
    expect(reversed).toEqual(forward);
    expect(forward.map((row) => row.allocationId)).toEqual([...forward.map((row) => row.allocationId)].sort());
  });

  it("keeps region and labor-category groups isolated", () => {
    const result = allocate({
      supplies: [supply("cohort:a", 10, "region:1", "GENERAL"), supply("cohort:b", 20, "region:2", "SKILLED")],
      demands: [demand("unit:a", 20, 10, "region:1", "GENERAL"), demand("unit:b", 30, 10, "region:2", "SKILLED")],
    });
    expect(result).toHaveLength(2);
    expect(result.find((row) => row.cohortId === cohortId("cohort:a"))?.unitId).toBe(unitId("unit:a"));
    expect(result.find((row) => row.cohortId === cohortId("cohort:b"))?.unitId).toBe(unitId("unit:b"));
  });

  it("handles zero-material groups and preserves tiny positive matching without NaN/Infinity", () => {
    expect(allocate({ supplies: [supply("cohort:a", 0)], demands: [demand("unit:a", 5, 10)] })).toEqual([]);
    const tiny = allocate({ supplies: [supply("cohort:a", Number.EPSILON)], demands: [demand("unit:a", 1, 10)] });
    expect(tiny).toHaveLength(1);
    expect(tiny[0]!.workerEquivalents).toBe(Number.EPSILON);
    expect(Number.isFinite(tiny[0]!.grossWageObligation)).toBe(true);
  });

  it("fails fast on non-finite/negative values, duplicate identities and impossible payroll caps", () => {
    expect(() => allocate({ supplies: [supply("cohort:a", Number.NaN)], demands: [] })).toThrow(/finite/);
    expect(() => allocate({ supplies: [supply("cohort:a", -1)], demands: [] })).toThrow(/>= 0/);
    expect(() => allocate({ supplies: [supply("cohort:a", 1), supply("cohort:a", 1)], demands: [] })).toThrow(/Duplicate.*cohort/);
    expect(() => allocate({ supplies: [], demands: [demand("unit:a", 1, 10), demand("unit:a", 1, 10)] })).toThrow(/Duplicate.*unit/);
    const impossible = { ...demand("unit:a", 2, 10), grossPayrollCap: 1 };
    expect(() => allocate({ supplies: [supply("cohort:a", 2)], demands: [impossible] })).toThrow(/grossPayrollCap/);
  });

  it("applies deterministic stable residual correction under awkward floating ratios", () => {
    const supplies = [supply("cohort:a", 0.1), supply("cohort:b", 0.2), supply("cohort:c", 0.3)];
    const demands = [demand("unit:a", 0.2, 7), demand("unit:b", 0.4, 13)];
    const result = allocate({ supplies, demands });
    expect(result.reduce((sum, row) => sum + row.workerEquivalents, 0)).toBeCloseTo(0.6, 14);
    for (const row of result) expect(row.workerEquivalents).toBeGreaterThan(0);
  });

  it("Phase-3 handler writes only ephemeral allocations and does not mutate WorldState", () => {
    const cohort: CohortState = {
      cohortId: cohortId("cohort:a"),
      clanId: "clan:1" as never,
      seed: {
        key: "cohort-a",
        regionKey: "region-a",
        clanKey: "clan-a",
        ageBand: "WORKING",
        stratum: "WORKING_MIDDLE",
        laborCategory: "GENERAL",
        population: 100,
        wallet: {},
        householdInventory: {},
        healthIndex: 1,
        prosperityEma: 0.5,
        essentialSatisfactionEma: 0.5,
        realIncomePerCapitaEma: 1,
        employmentRateEma: 1,
        migrationPressureEma: 0,
        mobilityAccumulator: 0,
        wageSignal: 12,
      },
      wallet: new Map(),
      householdInventory: new Map(),
    };
    const config = createDefaultSimulationConfig();
    const world: WorldState = {
      configVersion: config.configVersion,
      scenarioId: "labor-allocation-test",
      seed: 1,
      definitionRegistry: {} as never,
      simulationConfig: config,
      worldGenesisLedger: {} as never,
      regions: new Map(), states: new Map(), currencies: new Map(), monetaryAuthorities: new Map(), clans: new Map(),
      cohorts: new Map([[cohort.cohortId, cohort]]), productionUnits: new Map(), markets: new Map(), transportLinks: new Map(),
      lastCapitalFormationTransitionTick: -1,
      pendingTransitions: { jurisdictionChanges: [], stateCreations: [], policyChanges: [], monetaryPolicyChanges: [] },
    };
    const before = JSON.stringify(cohort.seed);
    const context = {
      ...initializeTickContext(7, 1),
      phase: 3,
      laborSupplyPlans: [supply("cohort:a", 5)],
      laborDemandPlans: [demand("unit:a", 5, 12)],
    };
    const result = createPhase3LaborAllocationHandler()(world, context, world.pendingTransitions);
    expect(result.laborAllocations?.reduce((sum, row) => sum + row.workerEquivalents, 0)).toBeCloseTo(5, 12);
    expect(JSON.stringify(cohort.seed)).toBe(before);
    expect(world.cohorts.get(cohort.cohortId)).toBe(cohort);
  });
});
