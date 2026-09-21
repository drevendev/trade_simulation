import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId, ProductionUnitId, RegionId } from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import {
  applyProductionExecutionTransition,
  planProductionExecutionsPhase5,
  type ProductionExecution,
} from "./productionExecution";
import type { ProductionPlan } from "./productionPlanning";
import { buildInitialWorld, type ProductionUnitState, type WorldState } from "./worldState";

const TICK = 11;

function buildTwoActiveToolsWorld(): { world: WorldState; unitIds: readonly ProductionUnitId[] } {
  const opening = buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    610,
  );
  const targetIds = [...opening.productionUnits.values()]
    .filter((unit) => unit.seed.status === "ACTIVE" && unit.seed.recipeId === "recipe:tools-craft")
    .sort((left, right) => String(left.productionUnitId).localeCompare(String(right.productionUnitId)))
    .slice(0, 2)
    .map((unit) => unit.productionUnitId);
  expect(targetIds).toHaveLength(2);

  const targetSet = new Set(targetIds);
  const productionUnits = new Map<ProductionUnitId, ProductionUnitState>();
  for (const unit of opening.productionUnits.values()) {
    const isTarget = targetSet.has(unit.productionUnitId);
    productionUnits.set(unit.productionUnitId, {
      ...unit,
      seed:
        unit.seed.status === "ACTIVE" && !isTarget
          ? { ...unit.seed, status: "MOTHBALLED" }
          : unit.seed,
      ...(isTarget
        ? {
            inputInventory: new Map<GoodId, number>([
              ["good:iron" as GoodId, 1_000],
              ["good:wood" as GoodId, 1_000],
            ]),
            outputInventory: new Map<GoodId, number>([["good:tools" as GoodId, 10]]),
          }
        : {}),
    });
  }

  return { world: { ...opening, productionUnits }, unitIds: targetIds };
}

function regionFor(world: WorldState, unit: ProductionUnitState) {
  const region = [...world.regions.values()].find((candidate) => candidate.seed.key === unit.seed.regionKey);
  expect(region).toBeDefined();
  return region!;
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

function allocation(unit: ProductionUnitState, regionId: RegionId, tick: number, index: number): LaborAllocation {
  return {
    allocationId: `labor-allocation:${tick}:${String(unit.productionUnitId)}:${index}`,
    tick,
    regionId,
    laborCategory: "GENERAL",
    cohortId: `Cohort:coverage-${index}` as CohortId,
    unitId: unit.productionUnitId,
    workerEquivalents: 30,
    grossWagePerWorker: 1,
    grossWageObligation: 30,
  };
}

function completeEvidence(
  world: WorldState,
  unitIds: readonly ProductionUnitId[],
  tick: number,
): {
  readonly productionPlans: readonly ProductionPlan[];
  readonly laborAllocations: readonly LaborAllocation[];
  readonly executions: readonly ProductionExecution[];
} {
  const units = unitIds.map((unitId) => {
    const unit = world.productionUnits.get(unitId);
    expect(unit).toBeDefined();
    return unit!;
  });
  const productionPlans = units.map((unit) => plan(unit, tick));
  const laborAllocations = units.map((unit, index) => allocation(unit, regionFor(world, unit).regionId, tick, index));
  const executions = planProductionExecutionsPhase5({
    world,
    tick,
    productionPlans,
    laborAllocations,
  }).executions;
  return { productionPlans, laborAllocations, executions };
}

function sortedEntries<K extends string>(values: ReadonlyMap<K, number>): readonly (readonly [K, number])[] {
  return [...values.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
}

function stockSnapshot(world: WorldState) {
  return {
    marker: world.lastProductionExecutionTransitionTick,
    units: [...world.productionUnits.values()]
      .sort((left, right) => String(left.productionUnitId).localeCompare(String(right.productionUnitId)))
      .map((unit) => ({
        unitId: unit.productionUnitId,
        input: sortedEntries(unit.inputInventory),
        output: sortedEntries(unit.outputInventory),
      })),
    regions: [...world.regions.values()]
      .sort((left, right) => String(left.regionId).localeCompare(String(right.regionId)))
      .map((region) => ({ regionId: region.regionId, resources: sortedEntries(region.resourceDeposits) })),
  };
}

describe("Issue #610 Phase-5 complete execution coverage", () => {
  it("rejects empty and partial batches atomically, then permits exactly one complete batch per tick", () => {
    const { world, unitIds } = buildTwoActiveToolsWorld();
    const evidence = completeEvidence(world, unitIds, TICK);
    expect(evidence.executions).toHaveLength(2);
    const opening = stockSnapshot(world);
    const authority = {
      productionPlans: evidence.productionPlans,
      laborAllocations: evidence.laborAllocations,
    };

    expect(() => applyProductionExecutionTransition(world, [], TICK, authority)).toThrow(/coverage.*incomplete/i);
    expect(stockSnapshot(world)).toEqual(opening);

    expect(() => applyProductionExecutionTransition(world, [evidence.executions[0]!], TICK, authority)).toThrow(/coverage.*incomplete/i);
    expect(stockSnapshot(world)).toEqual(opening);

    const after = applyProductionExecutionTransition(world, evidence.executions, TICK, authority);
    expect(after.lastProductionExecutionTransitionTick).toBe(TICK);
    for (const unitId of unitIds) {
      const beforeUnit = world.productionUnits.get(unitId)!;
      const afterUnit = after.productionUnits.get(unitId)!;
      const recipe = world.definitionRegistry.recipes[beforeUnit.seed.recipeId]!;
      for (const [goodId, perBatch] of Object.entries(recipe.inputsPerBatch) as [GoodId, number][]) {
        expect(afterUnit.inputInventory.get(goodId)).toBeCloseTo(
          (beforeUnit.inputInventory.get(goodId) ?? 0) - perBatch,
          12,
        );
      }
      expect(afterUnit.outputInventory.get(recipe.outputGoodId)).toBeCloseTo(
        (beforeUnit.outputInventory.get(recipe.outputGoodId) ?? 0) + recipe.outputPerBatch,
        12,
      );
    }

    expect(() => applyProductionExecutionTransition(after, evidence.executions, TICK, authority)).toThrow(
      /each canonical tick may persist Phase 5 once/,
    );

    const nextEvidence = completeEvidence(after, unitIds, TICK + 1);
    const afterNext = applyProductionExecutionTransition(after, nextEvidence.executions, TICK + 1, {
      productionPlans: nextEvidence.productionPlans,
      laborAllocations: nextEvidence.laborAllocations,
    });
    expect(afterNext.lastProductionExecutionTransitionTick).toBe(TICK + 1);
  });
});

describe("Issue #616 Phase-5 execution authority", () => {
  it("rejects forged self-reported plan, labor and capital bounds before physical mutation", () => {
    const { world, unitIds } = buildTwoActiveToolsWorld();
    const evidence = completeEvidence(world, unitIds, TICK);
    const opening = stockSnapshot(world);
    const target = evidence.executions[0]!;
    const unit = world.productionUnits.get(target.unitId)!;
    const recipe = world.definitionRegistry.recipes[target.recipeId]!;
    const openingOutput = unit.outputInventory.get(recipe.outputGoodId) ?? 0;
    const forgedInputs = Object.fromEntries(
      Object.entries(recipe.inputsPerBatch).map(([goodId, perBatch]) => [goodId, perBatch * 2]),
    ) as Readonly<Record<GoodId, number>>;
    const forged: ProductionExecution = {
      ...target,
      plannedBatches: 2,
      laborBoundBatches: 2,
      capitalBoundBatches: 2,
      realizedBatches: 2,
      allocatedWorkerEquivalents: recipe.laborPerBatch * 2,
      inputConsumedByGood: forgedInputs,
      outputProducedQuantity: recipe.outputPerBatch * 2,
      postProductionOutputQuantity: openingOutput + recipe.outputPerBatch * 2,
    };
    const forgedExecutions = evidence.executions.map((execution) =>
      execution.unitId === forged.unitId ? forged : execution,
    );
    const authority = {
      productionPlans: evidence.productionPlans,
      laborAllocations: evidence.laborAllocations,
    };

    expect(() => applyProductionExecutionTransition(world, forgedExecutions, TICK, authority)).toThrow(
      /authoritative ProductionPlan/,
    );
    expect(stockSnapshot(world)).toEqual(opening);

    const after = applyProductionExecutionTransition(world, evidence.executions, TICK, authority);
    expect(after.lastProductionExecutionTransitionTick).toBe(TICK);
    expect(stockSnapshot(after)).not.toEqual(opening);
  });
});
