import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId, ProductionUnitId, RegionId } from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import type { ProductionPlan } from "./productionPlanning";
import {
  applyProductionExecutionTransition,
  buildProductionOutputSellIntentsPhase5,
  planProductionExecutionsPhase5,
  resolveRegionResourceDeposits,
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

function activeUnit(world: WorldState, recipeId: string): ProductionUnitState {
  const unit = [...world.productionUnits.values()].find(
    (candidate) => candidate.seed.status === "ACTIVE" && candidate.seed.recipeId === recipeId,
  );
  expect(unit).toBeDefined();
  return unit!;
}

function regionFor(world: WorldState, unit: ProductionUnitState) {
  const region = [...world.regions.values()].find((candidate) => candidate.seed.key === unit.seed.regionKey);
  expect(region).toBeDefined();
  return region!;
}

function withUnit(world: WorldState, unit: ProductionUnitState): WorldState {
  const productionUnits = new Map(world.productionUnits);
  productionUnits.set(unit.productionUnitId, unit);
  return { ...world, productionUnits };
}

function withRegionResources(
  world: WorldState,
  regionId: RegionId,
  entries: readonly (readonly [string, number])[],
): WorldState {
  const regions = new Map(world.regions);
  const region = regions.get(regionId);
  expect(region).toBeDefined();
  regions.set(regionId, { ...region!, resourceDeposits: new Map(entries) });
  return { ...world, regions };
}

function plan(unit: ProductionUnitState, args?: { planned?: number; capacity?: number; tick?: number; recipeId?: string }): ProductionPlan {
  const tick = args?.tick ?? TICK;
  return {
    planId: `production-plan:${tick}:${String(unit.productionUnitId)}`,
    unitId: unit.productionUnitId,
    tick,
    recipeId: args?.recipeId ?? unit.seed.recipeId,
    effectiveCapacityBatches: args?.capacity ?? 20,
    targetUtilization: 1,
    plannedBatches: args?.planned ?? 20,
    plannedOutputQuantity: 0,
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
  laborCategory: string,
  workers: number,
  suffix = "a",
  overrides?: { tick?: number; regionId?: RegionId; laborCategory?: string; unitId?: ProductionUnitId },
): LaborAllocation {
  const tick = overrides?.tick ?? TICK;
  const unitId = overrides?.unitId ?? unit.productionUnitId;
  return {
    allocationId: `labor-allocation:${tick}:${String(unitId)}:${suffix}`,
    tick,
    regionId: overrides?.regionId ?? regionId,
    laborCategory: overrides?.laborCategory ?? laborCategory,
    cohortId: `Cohort:test-${suffix}` as CohortId,
    unitId,
    workerEquivalents: workers,
    grossWagePerWorker: 1,
    grossWageObligation: workers,
  };
}

function cloneUnitInventories(
  unit: ProductionUnitState,
  inputEntries: readonly (readonly [GoodId, number])[],
  outputEntries: readonly (readonly [GoodId, number])[] = [],
): ProductionUnitState {
  return {
    ...unit,
    inputInventory: new Map(inputEntries),
    outputInventory: new Map(outputEntries),
    investmentInventory: new Map(unit.investmentInventory),
  };
}

describe("REQ-PRODUCTION-005 Phase-5 production/extraction", () => {
  it("materializes immutable seed deposits into authoritative live Region resource stock at genesis", () => {
    const world = baselineWorld();
    const unit = activeUnit(world, "recipe:iron-mine");
    const region = regionFor(world, unit);
    const opening = region.seed.deposits.find((deposit) => deposit.resourceId === "resource:iron-ore")?.initialQuantity;
    expect(opening).toBeDefined();
    expect(resolveRegionResourceDeposits(region).get("resource:iron-ore")).toBe(opening);
    expect(region.resourceDeposits).not.toBe(region.seed.deposits);
  });

  it("uses the tightest INPUT bound, consumes exact inputs once, credits OUTPUT once, and leaves the input world unchanged", () => {
    let world = baselineWorld();
    const original = activeUnit(world, "recipe:tools-craft");
    const unit = cloneUnitInventories(
      original,
      [
        ["good:iron" as GoodId, 35],
        ["good:wood" as GoodId, 100],
      ],
      [["good:tools" as GoodId, 7]],
    );
    world = withUnit(world, unit);
    const region = regionFor(world, unit);
    const labor = allocation(unit, region.regionId, "GENERAL", 300);

    const result = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 10, capacity: 10 })],
      laborAllocations: [labor],
    });

    expect(result.executions).toHaveLength(1);
    const execution = result.executions[0]!;
    expect(execution.inputBoundBatches).toBeCloseTo(3.5, 12);
    expect(execution.laborBoundBatches).toBeCloseTo(10, 12);
    expect(execution.capitalBoundBatches).toBe(10);
    expect(execution.realizedBatches).toBeCloseTo(3.5, 12);
    expect(execution.inputConsumedByGood["good:iron" as GoodId]).toBeCloseTo(35, 12);
    expect(execution.inputConsumedByGood["good:wood" as GoodId]).toBeCloseTo(17.5, 12);
    expect(execution.outputProducedQuantity).toBeCloseTo(175, 12);

    const transitioned = applyProductionExecutionTransition(world, result.executions);
    const after = transitioned.productionUnits.get(unit.productionUnitId)!;
    expect(after.inputInventory.get("good:iron" as GoodId)).toBe(0);
    expect(after.inputInventory.get("good:wood" as GoodId)).toBeCloseTo(82.5, 12);
    expect(after.outputInventory.get("good:tools" as GoodId)).toBeCloseTo(182, 12);

    expect(world.productionUnits.get(unit.productionUnitId)!.inputInventory.get("good:iron" as GoodId)).toBe(35);
    expect(world.productionUnits.get(unit.productionUnitId)!.outputInventory.get("good:tools" as GoodId)).toBe(7);
  });

  it("independently binds by allocated labor and by effective capital capacity", () => {
    let world = baselineWorld();
    const original = activeUnit(world, "recipe:tools-craft");
    const unit = cloneUnitInventories(
      original,
      [
        ["good:iron" as GoodId, 1_000],
        ["good:wood" as GoodId, 1_000],
      ],
    );
    world = withUnit(world, unit);
    const region = regionFor(world, unit);

    const laborBound = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 10, capacity: 10 })],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 90)],
    }).executions[0]!;
    expect(laborBound.laborBoundBatches).toBeCloseTo(3, 12);
    expect(laborBound.realizedBatches).toBeCloseTo(3, 12);

    const capitalBound = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 10, capacity: 2 })],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 1_000)],
    }).executions[0]!;
    expect(capitalBound.capitalBoundBatches).toBe(2);
    expect(capitalBound.realizedBatches).toBe(2);
  });

  it("binds extraction by finite live deposits, depletes exactly once, and a depleted next tick produces zero", () => {
    let world = baselineWorld();
    const unit = activeUnit(world, "recipe:iron-mine");
    const region = regionFor(world, unit);
    world = withRegionResources(world, region.regionId, [["resource:iron-ore", 450]]);

    const first = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 10, capacity: 10 })],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 1_000)],
    }).executions[0]!;
    expect(first.resourceBoundBatches).toBeCloseTo(2.25, 12);
    expect(first.realizedBatches).toBeCloseTo(2.25, 12);
    expect(first.resourceConsumption?.quantity).toBeCloseTo(450, 12);
    expect(first.outputProducedQuantity).toBeCloseTo(450, 12);

    const afterFirst = applyProductionExecutionTransition(world, [first]);
    expect(resolveRegionResourceDeposits(afterFirst.regions.get(region.regionId)!).get("resource:iron-ore")).toBe(0);
    expect(afterFirst.productionUnits.get(unit.productionUnitId)!.outputInventory.get("good:iron" as GoodId)).toBeCloseTo(
      (unit.outputInventory.get("good:iron" as GoodId) ?? 0) + 450,
      12,
    );
    expect(resolveRegionResourceDeposits(world.regions.get(region.regionId)!).get("resource:iron-ore")).toBe(450);

    const second = planProductionExecutionsPhase5({
      world: afterFirst,
      tick: TICK + 1,
      productionPlans: [plan(afterFirst.productionUnits.get(unit.productionUnitId)!, { tick: TICK + 1, planned: 10, capacity: 10 })],
      laborAllocations: [
        allocation(
          afterFirst.productionUnits.get(unit.productionUnitId)!,
          region.regionId,
          "GENERAL",
          1_000,
          "next",
          { tick: TICK + 1 },
        ),
      ],
    }).executions[0]!;
    expect(second.resourceBoundBatches).toBe(0);
    expect(second.realizedBatches).toBe(0);
    expect(second.outputProducedQuantity).toBe(0);
  });

  it("reserves a shared finite deposit in stable unit order so two extractors cannot double-spend it", () => {
    let world = baselineWorld();
    const minesByRegion = new Map<string, ProductionUnitState[]>();
    for (const candidate of world.productionUnits.values()) {
      if (candidate.seed.status !== "ACTIVE" || candidate.seed.recipeId !== "recipe:iron-mine") continue;
      const list = minesByRegion.get(candidate.seed.regionKey) ?? [];
      list.push(candidate);
      minesByRegion.set(candidate.seed.regionKey, list);
    }
    const pair = [...minesByRegion.values()].find((candidates) => candidates.length >= 2)?.slice(0, 2);
    expect(pair).toBeDefined();
    const units = pair!.sort((a, b) => String(a.productionUnitId).localeCompare(String(b.productionUnitId)));
    const region = regionFor(world, units[0]!);
    world = withRegionResources(world, region.regionId, [["resource:iron-ore", 200]]);

    const plans = units.map((unit) => plan(unit, { planned: 5, capacity: 5 }));
    const allocations = units.map((unit, index) => allocation(unit, region.regionId, "GENERAL", 1_000, String(index)));
    const result = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [...plans].reverse(),
      laborAllocations: [...allocations].reverse(),
    });

    expect(result.executions.map((execution) => execution.unitId)).toEqual(units.map((unit) => unit.productionUnitId));
    expect(result.executions.map((execution) => execution.realizedBatches)).toEqual([1, 0]);
    expect(result.executions.reduce((sum, execution) => sum + (execution.resourceConsumption?.quantity ?? 0), 0)).toBe(200);
  });

  it("creates the canonical post-production OUTPUT sell intent from post-execution stock and reserve", () => {
    let world = baselineWorld();
    const original = activeUnit(world, "recipe:tools-craft");
    const unit: ProductionUnitState = {
      ...cloneUnitInventories(
        original,
        [
          ["good:iron" as GoodId, 100],
          ["good:wood" as GoodId, 100],
        ],
        [["good:tools" as GoodId, 10]],
      ),
      signals: { ...original.signals, outputSalesEma: 4 },
    };
    const defaults = createDefaultSimulationConfig();
    world = {
      ...withUnit(world, unit),
      simulationConfig: {
        ...world.simulationConfig,
        production: { ...defaults.production, outputCoverageTicks: 2 },
      },
    };
    const region = regionFor(world, unit);
    const execution = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 1, capacity: 1 })],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 30)],
    }).executions[0]!;
    const after = applyProductionExecutionTransition(world, [execution]);
    const intents = buildProductionOutputSellIntentsPhase5(after, [execution]);

    expect(execution.outputProducedQuantity).toBe(50);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      id: `mi:output:${TICK}:${String(unit.productionUnitId)}`,
      actor: { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId },
      regionId: region.regionId,
      goodId: "good:tools",
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 52,
      minimumReserveQuantity: 8,
      sourcePlanId: `production-plan:${TICK}:${String(unit.productionUnitId)}`,
      inventoryBucket: "OUTPUT",
    });
  });

  it("realizes zero for non-ACTIVE units and does not create physical stock", () => {
    let world = baselineWorld();
    const active = activeUnit(world, "recipe:tools-craft");
    const unit: ProductionUnitState = {
      ...cloneUnitInventories(
        active,
        [
          ["good:iron" as GoodId, 100],
          ["good:wood" as GoodId, 100],
        ],
      ),
      seed: { ...active.seed, status: "MOTHBALLED" },
    };
    world = withUnit(world, unit);
    const region = regionFor(world, unit);
    const execution = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 5, capacity: 5 })],
      laborAllocations: [],
    }).executions[0]!;
    expect(execution.realizedBatches).toBe(0);
    expect(execution.outputProducedQuantity).toBe(0);
    expect(Object.values(execution.inputConsumedByGood)).toEqual([]);

    expect(() => planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 5, capacity: 5 })],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 1, "invalid-non-active")],
    })).toThrow(/positive Phase-3 labor allocation/);
  });

  it("rejects forged physical deltas instead of permitting phantom output or missing recipe consumption", () => {
    let world = baselineWorld();
    const original = activeUnit(world, "recipe:tools-craft");
    const unit = cloneUnitInventories(
      original,
      [
        ["good:iron" as GoodId, 100],
        ["good:wood" as GoodId, 100],
      ],
    );
    world = withUnit(world, unit);
    const region = regionFor(world, unit);
    const execution = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [plan(unit, { planned: 1, capacity: 1 })],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 30, "physical")],
    }).executions[0]!;

    expect(() => applyProductionExecutionTransition(world, [{
      ...execution,
      outputProducedQuantity: execution.outputProducedQuantity + 1,
      postProductionOutputQuantity: execution.postProductionOutputQuantity + 1,
    }])).toThrow(/output quantity does not equal recipe output/);

    expect(() => applyProductionExecutionTransition(world, [{
      ...execution,
      inputConsumedByGood: { "good:iron": execution.inputConsumedByGood["good:iron" as GoodId] ?? 0 } as Readonly<Record<GoodId, number>>,
    }])).toThrow(/input-good set does not match recipe/);
  });

  it("fails fast on duplicate, stale, cross-region and cross-category labor evidence", () => {
    const world = baselineWorld();
    const unit = activeUnit(world, "recipe:tools-craft");
    const region = regionFor(world, unit);
    const currentPlan = plan(unit, { planned: 1, capacity: 1 });
    const goodAllocation = allocation(unit, region.regionId, "GENERAL", 30);

    expect(() => planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [currentPlan, currentPlan],
      laborAllocations: [],
    })).toThrow(/Duplicate ProductionPlan/);

    expect(() => planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [currentPlan],
      laborAllocations: [goodAllocation, goodAllocation],
    })).toThrow(/Duplicate LaborAllocation/);

    expect(() => planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [currentPlan],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 30, "stale", { tick: TICK - 1 })],
    })).toThrow(/expected 9/);

    const otherRegion = [...world.regions.values()].find((candidate) => candidate.regionId !== region.regionId)!;
    expect(() => planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [currentPlan],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 30, "region", { regionId: otherRegion.regionId })],
    })).toThrow(/region provenance mismatch/);

    expect(() => planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [currentPlan],
      laborAllocations: [allocation(unit, region.regionId, "GENERAL", 30, "category", { laborCategory: "SPECIALIST" })],
    })).toThrow(/labor-category provenance mismatch/);
  });

  it("is insertion-order invariant for production plans and labor allocations", () => {
    let world = baselineWorld();
    const units = [...world.productionUnits.values()]
      .filter((candidate) => candidate.seed.status === "ACTIVE" && candidate.seed.recipeId === "recipe:tools-craft")
      .slice(0, 2)
      .map((candidate) => cloneUnitInventories(candidate, [
        ["good:iron" as GoodId, 100],
        ["good:wood" as GoodId, 100],
      ]));
    expect(units).toHaveLength(2);
    for (const unit of units) world = withUnit(world, unit);
    const plans = units.map((unit) => plan(unit, { planned: 2, capacity: 2 }));
    const allocations = units.map((unit, index) => allocation(unit, regionFor(world, unit).regionId, "GENERAL", 60, String(index)));

    const forward = planProductionExecutionsPhase5({ world, tick: TICK, productionPlans: plans, laborAllocations: allocations });
    const reversed = planProductionExecutionsPhase5({
      world,
      tick: TICK,
      productionPlans: [...plans].reverse(),
      laborAllocations: [...allocations].reverse(),
    });
    expect(reversed).toEqual(forward);
  });
});
