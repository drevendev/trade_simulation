import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { CohortId, ProductionUnitId, RegionId } from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import type { LaborSupplyPlan } from "./laborSupplyPlanning";
import type { LaborDemandPlan } from "./productionPlanning";
import { initializeTickContext } from "./tickOrchestrator";
import {
  applyWageOfferStateTransition,
  createPhase15WageOfferUpdateHandler,
  planWageOfferUpdatesPhase15,
} from "./wageOfferUpdate";
import { buildInitialWorld, type ProductionUnitState } from "./worldState";

const cohortId = (value: string) => value as CohortId;
const unitId = (value: string) => value as ProductionUnitId;

function fixture() {
  const config = createDefaultSimulationConfig();
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
  const unit = [...world.productionUnits.values()].find((candidate) => candidate.seed.status === "ACTIVE");
  expect(unit).toBeDefined();
  const region = [...world.regions.values()].find((candidate) => candidate.seed.key === unit!.seed.regionKey);
  expect(region).toBeDefined();
  const recipe = world.definitionRegistry.recipes[unit!.seed.recipeId];
  expect(recipe).toBeDefined();
  return { config, world, unit: unit!, regionId: region!.regionId, laborCategory: recipe!.laborCategory };
}

function supply(regionId: RegionId, category: string, available: number, suffix = "a"): LaborSupplyPlan {
  return {
    planId: `labor-supply:9:cohort:${suffix}`,
    cohortId: cohortId(`cohort:${suffix}`),
    regionId,
    laborCategory: category,
    availableWorkerEquivalents: available,
  };
}

function demand(
  unitId: ProductionUnitId,
  regionId: RegionId,
  category: string,
  requested: number,
  wage = 10,
): LaborDemandPlan {
  return {
    planId: `labor-demand-plan:9:${String(unitId)}`,
    productionPlanId: `production-plan:9:${String(unitId)}`,
    unitId,
    regionId,
    laborCategory: category,
    requestedWorkerEquivalents: requested,
    grossWageOffer: wage,
    grossPayrollCap: requested * wage,
  };
}

function allocation(
  unitId: ProductionUnitId,
  regionId: RegionId,
  category: string,
  workers: number,
  suffix = "a",
): LaborAllocation {
  return {
    allocationId: `labor-allocation:9:${String(regionId)}:${category}:cohort:${suffix}:${String(unitId)}`,
    tick: 9,
    regionId,
    laborCategory: category,
    cohortId: cohortId(`cohort:${suffix}`),
    unitId,
    workerEquivalents: workers,
    grossWagePerWorker: 10,
    grossWageObligation: workers * 10,
  };
}

function plan(args: {
  unit?: ProductionUnitState;
  config?: SimulationConfig;
  requested: number;
  available: number;
  allocated: number;
  floor?: number;
}) {
  const base = fixture();
  const unit = args.unit ?? { ...base.unit, wageOffer: 10 };
  return planWageOfferUpdatesPhase15({
    tick: 9,
    config: args.config ?? base.config,
    productionUnits: new Map([[unit.productionUnitId, unit]]),
    laborSupplyPlans: [supply(base.regionId, base.laborCategory, args.available)],
    laborDemandPlans: [demand(unit.productionUnitId, base.regionId, base.laborCategory, args.requested, unit.wageOffer)],
    laborAllocations: args.allocated > 0
      ? [allocation(unit.productionUnitId, base.regionId, base.laborCategory, args.allocated)]
      : [],
    effectiveMinimumWageFloorByUnit: new Map([[unit.productionUnitId, args.floor ?? 0]]),
  });
}

describe("REQ-PRODUCTION-003 Phase-15 sticky wage-offer update", () => {
  it("PCL-T9 raises offers in tight labor markets and lowers them in slack markets within max step", () => {
    const tight = plan({ requested: 100, available: 50, allocated: 50 })[0]!;
    const slack = plan({ requested: 50, available: 100, allocated: 50 })[0]!;
    const maxMultiplier = Math.exp(createDefaultSimulationConfig().labor.maxLogWageStep!);

    expect(tight.nextOffer).toBeGreaterThan(10);
    expect(tight.nextOffer).toBeLessThanOrEqual(10 * maxMultiplier + 1e-12);
    expect(slack.nextOffer).toBeLessThan(10);
    expect(slack.nextOffer).toBeGreaterThanOrEqual(10 / maxMultiplier - 1e-12);
  });

  it("adds configured unit vacancy pressure and clamps the combined log wage step", () => {
    const base = createDefaultSimulationConfig();
    const vacancyOnly: SimulationConfig = {
      ...base,
      labor: {
        ...base.labor,
        wageAdjustmentSpeed: 0,
        unitVacancyResponse: 0.2,
        maxLogWageStep: 0.05,
      },
    };
    const update = plan({ config: vacancyOnly, requested: 100, available: 50, allocated: 50 })[0]!;
    expect(update.vacancyRate).toBeCloseTo(0.5, 12);
    expect(update.regionalWageGrowth).toBe(0);
    expect(update.nextOffer).toBeCloseTo(10 * Math.exp(0.05), 12);
  });

  it("applies the explicit next-tick minimum-wage floor after the sticky adjustment", () => {
    const update = plan({ requested: 50, available: 100, allocated: 50, floor: 12 })[0]!;
    expect(update.nextOffer).toBe(12);
    expect(update.effectiveMinimumWageFloor).toBe(12);
  });

  it("updates only ACTIVE units while zero demand still follows the regional sticky signal", () => {
    const base = fixture();
    const inactive: ProductionUnitState = {
      ...base.unit,
      wageOffer: 10,
      seed: { ...base.unit.seed, status: "MOTHBALLED" },
    };
    expect(plan({ unit: inactive, requested: 50, available: 100, allocated: 50 })).toEqual([]);

    const active: ProductionUnitState = { ...base.unit, wageOffer: 10 };
    const zeroDemand = planWageOfferUpdatesPhase15({
      tick: 9,
      config: base.config,
      productionUnits: new Map([[active.productionUnitId, active]]),
      laborSupplyPlans: [supply(base.regionId, base.laborCategory, 100)],
      laborDemandPlans: [demand(active.productionUnitId, base.regionId, base.laborCategory, 0, 10)],
      laborAllocations: [],
      effectiveMinimumWageFloorByUnit: new Map([[active.productionUnitId, 0]]),
    });
    expect(zeroDemand).toHaveLength(1);
    expect(zeroDemand[0]!.vacancyRate).toBe(0);
    expect(zeroDemand[0]!.nextOffer).toBeLessThan(10);
  });

  it("is insertion-order invariant and emits stable unit ordering", () => {
    const base = fixture();
    const unitA: ProductionUnitState = { ...base.unit, productionUnitId: unitId("unit:a"), wageOffer: 10 };
    const unitB: ProductionUnitState = { ...base.unit, productionUnitId: unitId("unit:b"), wageOffer: 11 };
    const supplies = [supply(base.regionId, base.laborCategory, 30, "b"), supply(base.regionId, base.laborCategory, 30, "a")];
    const demands = [
      demand(unitB.productionUnitId, base.regionId, base.laborCategory, 40, 11),
      demand(unitA.productionUnitId, base.regionId, base.laborCategory, 20, 10),
    ];
    const allocations = [
      allocation(unitB.productionUnitId, base.regionId, base.laborCategory, 40, "a"),
      allocation(unitA.productionUnitId, base.regionId, base.laborCategory, 20, "b"),
    ];
    const floors = new Map<ProductionUnitId, number>([[unitB.productionUnitId, 0], [unitA.productionUnitId, 0]]);
    const units = new Map<ProductionUnitId, ProductionUnitState>([[unitB.productionUnitId, unitB], [unitA.productionUnitId, unitA]]);

    const forward = planWageOfferUpdatesPhase15({ tick: 9, config: base.config, productionUnits: units, laborSupplyPlans: supplies, laborDemandPlans: demands, laborAllocations: allocations, effectiveMinimumWageFloorByUnit: floors });
    const reversed = planWageOfferUpdatesPhase15({ tick: 9, config: base.config, productionUnits: new Map([...units].reverse()), laborSupplyPlans: [...supplies].reverse(), laborDemandPlans: [...demands].reverse(), laborAllocations: [...allocations].reverse(), effectiveMinimumWageFloorByUnit: floors });
    expect(reversed).toEqual(forward);
    expect(forward.map((row) => String(row.unitId))).toEqual(["unit:a", "unit:b"]);
  });

  it("fails fast on invalid, duplicate, cross-group or incomplete Phase-3 evidence", () => {
    const base = fixture();
    const unit: ProductionUnitState = { ...base.unit, wageOffer: 10 };
    const common = {
      tick: 9,
      config: base.config,
      productionUnits: new Map([[unit.productionUnitId, unit]]),
      effectiveMinimumWageFloorByUnit: new Map([[unit.productionUnitId, 0]]),
    };
    const goodSupply = supply(base.regionId, base.laborCategory, 10);
    const goodDemand = demand(unit.productionUnitId, base.regionId, base.laborCategory, 10);
    const goodAllocation = allocation(unit.productionUnitId, base.regionId, base.laborCategory, 10);

    expect(() => planWageOfferUpdatesPhase15({ ...common, laborSupplyPlans: [{ ...goodSupply, availableWorkerEquivalents: Number.NaN }], laborDemandPlans: [goodDemand], laborAllocations: [] })).toThrow(/finite/);
    expect(() => planWageOfferUpdatesPhase15({ ...common, laborSupplyPlans: [goodSupply, goodSupply], laborDemandPlans: [goodDemand], laborAllocations: [goodAllocation] })).toThrow(/Duplicate/);
    expect(() => planWageOfferUpdatesPhase15({ ...common, laborSupplyPlans: [goodSupply], laborDemandPlans: [goodDemand, goodDemand], laborAllocations: [goodAllocation] })).toThrow(/Duplicate/);
    expect(() => planWageOfferUpdatesPhase15({ ...common, laborSupplyPlans: [goodSupply], laborDemandPlans: [goodDemand], laborAllocations: [] })).toThrow(/expected matched/);
    expect(() => planWageOfferUpdatesPhase15({ ...common, laborSupplyPlans: [goodSupply], laborDemandPlans: [goodDemand], laborAllocations: [{ ...goodAllocation, laborCategory: "OTHER" }] })).toThrow(/crosses/);
  });

  it("keeps WorldState immutable in Phase 15 and persists only the N+1 live wage offer", () => {
    const base = fixture();
    const beforeUnit = base.world.productionUnits.get(base.unit.productionUnitId)!;
    const context = {
      ...initializeTickContext(9, base.world.seed),
      phase: 15,
      laborSupplyPlans: [supply(base.regionId, base.laborCategory, 50)],
      laborDemandPlans: [demand(base.unit.productionUnitId, base.regionId, base.laborCategory, 100, beforeUnit.wageOffer)],
      laborAllocations: [allocation(base.unit.productionUnitId, base.regionId, base.laborCategory, 50)],
    };
    const handled = createPhase15WageOfferUpdateHandler({
      effectiveMinimumWageFloorByUnit: new Map([[base.unit.productionUnitId, 0]]),
    })(base.world, context, base.world.pendingTransitions);

    expect(base.world.productionUnits.get(base.unit.productionUnitId)).toBe(beforeUnit);
    expect(beforeUnit.wageOffer).toBe(base.unit.wageOffer);
    expect(handled.wageOfferUpdates).toHaveLength(1);

    const nextWorld = applyWageOfferStateTransition(base.world, handled);
    expect(nextWorld).not.toBe(base.world);
    expect(nextWorld.productionUnits).not.toBe(base.world.productionUnits);
    expect(nextWorld.productionUnits.get(base.unit.productionUnitId)!.wageOffer).toBe(handled.wageOfferUpdates![0]!.nextOffer);
    expect(base.world.productionUnits.get(base.unit.productionUnitId)!.wageOffer).toBe(beforeUnit.wageOffer);
    expect(nextWorld.regions).toBe(base.world.regions);
    expect(nextWorld.cohorts).toBe(base.world.cohorts);
  });
});
