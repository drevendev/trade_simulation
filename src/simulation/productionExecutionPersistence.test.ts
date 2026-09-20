import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId, ProductionUnitId, RegionId } from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import type { ProductionPlan } from "./productionPlanning";
import {
  applyProductionExecutionTransition,
  planProductionExecutionsPhase5,
} from "./productionExecution";
import { buildInitialWorld, type ProductionUnitState, type WorldState } from "./worldState";

const TICK = 9;

function baselineWorld(): WorldState {
  return buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
}

function activeToolsUnit(world: WorldState): ProductionUnitState {
  const unit = [...world.productionUnits.values()].find(
    (candidate) => candidate.seed.status === "ACTIVE" && candidate.seed.recipeId === "recipe:tools-craft",
  );
  expect(unit).toBeDefined();
  return unit!;
}

function regionFor(world: WorldState, unit: ProductionUnitState) {
  const region = [...world.regions.values()].find((candidate) => candidate.seed.key === unit.seed.regionKey);
  expect(region).toBeDefined();
  return region!;
}

function withProductionUnit(world: WorldState, unit: ProductionUnitState): WorldState {
  const productionUnits = new Map(world.productionUnits);
  productionUnits.set(unit.productionUnitId, unit);
  return { ...world, productionUnits };
}

function withOnlyActiveUnit(world: WorldState, activeUnitId: ProductionUnitId): WorldState {
  const productionUnits = new Map(world.productionUnits);
  for (const [unitId, unit] of productionUnits) {
    if (unit.seed.status === "ACTIVE" && unitId !== activeUnitId) {
      productionUnits.set(unitId, { ...unit, seed: { ...unit.seed, status: "MOTHBALLED" } });
    }
  }
  return { ...world, productionUnits };
}

function plan(unit: ProductionUnitState, tick: number): ProductionPlan {
  return {
    planId: `production-plan:${tick}:${String(unit.productionUnitId)}`,
    unitId: unit.productionUnitId,
    tick,
    recipeId: unit.seed.recipeId,
    effectiveCapacityBatches: 1,
    targetUtilization: 1,
    plannedBatches: 1,
    plannedOutputQuantity: 50,
    desiredInputQuantity: {},
    openingUsableInputQuantity: {},
    plannedInputPurchaseQuantity: {},
    procurementCashEnvelope: 0,
    grossWageCashEnvelope: 0,
    operatingLiquidityBuffer: 0,
    workingCapitalTarget: 0,
    investableCash: 0,
    investmentPressure: 0,
    investmentBudget: 0,
    laborDemandPlanId: `labor-demand-plan:${tick}:${String(unit.productionUnitId)}`,
    investmentIntentIds: [],
    inputIntentIds: [],
  };
}

function allocation(
  unit: ProductionUnitState,
  regionId: RegionId,
  tick: number,
  suffix: string,
): LaborAllocation {
  return {
    allocationId: `labor-allocation:${tick}:${String(unit.productionUnitId)}:${suffix}`,
    tick,
    regionId,
    laborCategory: "GENERAL",
    cohortId: `Cohort:persistence-${suffix}` as CohortId,
    unitId: unit.productionUnitId as ProductionUnitId,
    workerEquivalents: 30,
    grossWagePerWorker: 1,
    grossWageObligation: 30,
  };
}

function oneExecution(world: WorldState, unit: ProductionUnitState, tick: number, suffix: string) {
  const region = regionFor(world, unit);
  return planProductionExecutionsPhase5({
    world,
    tick,
    productionPlans: [plan(unit, tick)],
    laborAllocations: [allocation(unit, region.regionId, tick, suffix)],
  }).executions[0]!;
}

describe("REQ-PRODUCTION-005 Phase-5 persistence provenance", () => {
  it("rejects a fresh same-tick replan after persistence and keeps tick N+1 eligible", () => {
    let world = baselineWorld();
    const original = activeToolsUnit(world);
    const unit: ProductionUnitState = {
      ...original,
      inputInventory: new Map<GoodId, number>([
        ["good:iron" as GoodId, 100],
        ["good:wood" as GoodId, 100],
      ]),
      outputInventory: new Map<GoodId, number>([["good:tools" as GoodId, 5]]),
    };
    world = withOnlyActiveUnit(withProductionUnit(world, unit), unit.productionUnitId);

    const first = oneExecution(world, unit, TICK, "first");
    const afterFirst = applyProductionExecutionTransition(world, [first], TICK);
    expect(afterFirst.lastProductionExecutionTransitionTick).toBe(TICK);

    const unitAfterFirst = afterFirst.productionUnits.get(unit.productionUnitId)!;
    const ironAfterFirst = unitAfterFirst.inputInventory.get("good:iron" as GoodId)!;
    const woodAfterFirst = unitAfterFirst.inputInventory.get("good:wood" as GoodId)!;
    const toolsAfterFirst = unitAfterFirst.outputInventory.get("good:tools" as GoodId)!;

    const freshSameTick = oneExecution(afterFirst, unitAfterFirst, TICK, "fresh-same-tick");
    expect(freshSameTick.postProductionOutputQuantity).toBeGreaterThan(first.postProductionOutputQuantity);

    expect(() => applyProductionExecutionTransition(afterFirst, [freshSameTick], TICK)).toThrow(
      /each canonical tick may persist Phase 5 once/,
    );
    expect(afterFirst.lastProductionExecutionTransitionTick).toBe(TICK);
    expect(afterFirst.productionUnits.get(unit.productionUnitId)!.inputInventory.get("good:iron" as GoodId)).toBe(ironAfterFirst);
    expect(afterFirst.productionUnits.get(unit.productionUnitId)!.inputInventory.get("good:wood" as GoodId)).toBe(woodAfterFirst);
    expect(afterFirst.productionUnits.get(unit.productionUnitId)!.outputInventory.get("good:tools" as GoodId)).toBe(toolsAfterFirst);

    const nextTick = oneExecution(afterFirst, unitAfterFirst, TICK + 1, "next-tick");
    const afterNext = applyProductionExecutionTransition(afterFirst, [nextTick], TICK + 1);
    expect(afterNext.lastProductionExecutionTransitionTick).toBe(TICK + 1);
    expect(afterNext.productionUnits.get(unit.productionUnitId)!.inputInventory.get("good:iron" as GoodId)).toBeLessThan(ironAfterFirst);
    expect(afterNext.productionUnits.get(unit.productionUnitId)!.outputInventory.get("good:tools" as GoodId)).toBeGreaterThan(toolsAfterFirst);
  });

  it("rejects execution evidence whose embedded tick differs from the authoritative transition tick", () => {
    let world = baselineWorld();
    const original = activeToolsUnit(world);
    const unit: ProductionUnitState = {
      ...original,
      inputInventory: new Map<GoodId, number>([
        ["good:iron" as GoodId, 100],
        ["good:wood" as GoodId, 100],
      ]),
    };
    world = withOnlyActiveUnit(withProductionUnit(world, unit), unit.productionUnitId);
    const execution = oneExecution(world, unit, TICK, "tick-mismatch");

    expect(() => applyProductionExecutionTransition(world, [execution], TICK + 1)).toThrow(
      `ProductionExecution for ${String(unit.productionUnitId)} is for tick ${TICK}, expected ${TICK + 1}`,
    );
    expect(world.lastProductionExecutionTransitionTick).toBe(-1);
  });
});
