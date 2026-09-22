import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId, RegionId } from "../domain/id";
import type { LaborAllocation } from "./laborAllocation";
import type { ProductionPlan } from "./productionPlanning";
import {
  applyProductionExecutionTransition,
  buildProductionOutputSellIntentsPhase5,
  planProductionExecutionsPhase5,
} from "./productionExecution";
import type { ProductionUnitLifecycleStatus } from "./productionUnitState";
import { buildInitialWorld, type ProductionUnitState, type WorldState } from "./worldState";

const TICK = 23;

type SeedStatus = ProductionUnitState["seed"]["status"];

function baselineWorld(): WorldState {
  return buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
}

function fixtureUnit(world: WorldState, recipeId: string): ProductionUnitState {
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

function isolateUnit(world: WorldState, target: ProductionUnitState): WorldState {
  const productionUnits = new Map(world.productionUnits);
  for (const [unitId, unit] of productionUnits) {
    productionUnits.set(unitId, { ...unit, status: "MOTHBALLED" });
  }
  productionUnits.set(target.productionUnitId, target);
  return { ...world, productionUnits };
}

function plan(unit: ProductionUnitState, plannedBatches = 1, effectiveCapacityBatches = 1): ProductionPlan {
  return {
    planId: `production-plan:${TICK}:${String(unit.productionUnitId)}`,
    unitId: unit.productionUnitId,
    tick: TICK,
    recipeId: unit.seed.recipeId,
    effectiveCapacityBatches,
    targetUtilization: 1,
    plannedBatches,
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
    laborDemandPlanId: `labor-demand-plan:${TICK}:${String(unit.productionUnitId)}`,
    investmentIntentIds: [],
    inputIntentIds: [],
  };
}

function allocation(
  unit: ProductionUnitState,
  regionId: RegionId,
  laborCategory: string,
  workers: number,
  suffix: string,
): LaborAllocation {
  return {
    allocationId: `labor-allocation:${TICK}:${String(unit.productionUnitId)}:${suffix}`,
    tick: TICK,
    regionId,
    laborCategory,
    cohortId: `Cohort:lifecycle-${suffix}` as CohortId,
    unitId: unit.productionUnitId,
    workerEquivalents: workers,
    grossWagePerWorker: 1,
    grossWageObligation: workers,
  };
}

function toolsUnit(
  world: WorldState,
  seedStatus: SeedStatus,
  liveStatus: ProductionUnitLifecycleStatus,
  outputQuantity = 10,
): ProductionUnitState {
  const original = fixtureUnit(world, "recipe:tools-craft");
  return {
    ...original,
    seed: { ...original.seed, status: seedStatus },
    status: liveStatus,
    inputInventory: new Map<GoodId, number>([
      ["good:iron" as GoodId, 100],
      ["good:wood" as GoodId, 100],
    ]),
    outputInventory: new Map<GoodId, number>([["good:tools" as GoodId, outputQuantity]]),
    investmentInventory: new Map(original.investmentInventory),
    signals: { ...original.signals, outputSalesEma: 4 },
  };
}

function runActiveTools(seedStatus: SeedStatus) {
  let world = baselineWorld();
  const unit = toolsUnit(world, seedStatus, "ACTIVE");
  world = isolateUnit(world, unit);
  const region = regionFor(world, unit);
  const productionPlan = plan(unit);
  const labor = allocation(unit, region.regionId, "GENERAL", 30, String(seedStatus).toLowerCase());
  const execution = planProductionExecutionsPhase5({
    world,
    tick: TICK,
    productionPlans: [productionPlan],
    laborAllocations: [labor],
  }).executions[0]!;
  const after = applyProductionExecutionTransition(world, [execution], TICK, {
    productionPlans: [productionPlan],
    laborAllocations: [labor],
  });
  return {
    execution,
    intents: buildProductionOutputSellIntentsPhase5(after, [execution]),
    outputQuantity: after.productionUnits.get(unit.productionUnitId)!.outputInventory.get("good:tools" as GoodId),
  };
}

function runClosingTools(seedStatus: SeedStatus) {
  let world = baselineWorld();
  const unit = toolsUnit(world, seedStatus, "CLOSING", 20);
  const defaults = createDefaultSimulationConfig();
  world = isolateUnit({
    ...world,
    simulationConfig: {
      ...world.simulationConfig,
      production: { ...defaults.production, outputCoverageTicks: 2 },
    },
  }, unit);
  const productionPlan = plan(unit, 5, 5);
  const execution = planProductionExecutionsPhase5({
    world,
    tick: TICK,
    productionPlans: [productionPlan],
    laborAllocations: [],
  }).executions[0]!;
  const after = applyProductionExecutionTransition(world, [execution], TICK, {
    productionPlans: [productionPlan],
    laborAllocations: [],
  });
  return {
    execution,
    intents: buildProductionOutputSellIntentsPhase5(after, [execution]),
  };
}

describe("Issue #638 Phase-5 live ProductionUnit status authority", () => {
  it("makes reactivated live-ACTIVE execution, coverage and OUTPUT SELL independent of immutable seed status", () => {
    const seededActive = runActiveTools("ACTIVE");
    const reactivated = runActiveTools("MOTHBALLED");

    expect(seededActive.execution.realizedBatches).toBeGreaterThan(0);
    expect(reactivated.execution).toEqual(seededActive.execution);
    expect(reactivated.outputQuantity).toBe(seededActive.outputQuantity);
    expect(reactivated.intents).toEqual(seededActive.intents);
    expect(reactivated.intents).toHaveLength(1);
  });

  it.each(["PLANNED", "MOTHBALLED"] as const)(
    "keeps seed-ACTIVE but live-%s units out of normal production, ACTIVE coverage and OUTPUT selling",
    (liveStatus) => {
      let world = baselineWorld();
      const unit = toolsUnit(world, "ACTIVE", liveStatus, 20);
      world = isolateUnit(world, unit);
      const productionPlan = plan(unit, 5, 5);
      const execution = planProductionExecutionsPhase5({
        world,
        tick: TICK,
        productionPlans: [productionPlan],
        laborAllocations: [],
      }).executions[0]!;

      expect(execution.realizedBatches).toBe(0);
      expect(execution.outputProducedQuantity).toBe(0);
      const after = applyProductionExecutionTransition(world, [execution], TICK, {
        productionPlans: [productionPlan],
        laborAllocations: [],
      });
      expect(buildProductionOutputSellIntentsPhase5(after, [execution])).toEqual([]);
    },
  );

  it("lets live CLOSING units liquidate residual OUTPUT identically across seed statuses while producing zero", () => {
    const seededActive = runClosingTools("ACTIVE");
    const seededMothballed = runClosingTools("MOTHBALLED");

    expect(seededActive.execution.realizedBatches).toBe(0);
    expect(seededActive.execution.outputProducedQuantity).toBe(0);
    expect(seededMothballed.execution).toEqual(seededActive.execution);
    expect(seededMothballed.intents).toEqual(seededActive.intents);
    expect(seededActive.intents).toHaveLength(1);
    expect(seededActive.intents[0]).toMatchObject({
      side: "SELL",
      inventoryBucket: "OUTPUT",
      desiredQuantity: 20,
      minimumReserveQuantity: 0,
    });
  });

  it("keeps live-ACTIVE input and extraction provenance fail-closed when the immutable seed was MOTHBALLED", () => {
    let toolsWorld = baselineWorld();
    const tools = toolsUnit(toolsWorld, "MOTHBALLED", "ACTIVE");
    toolsWorld = isolateUnit(toolsWorld, tools);
    const toolsRegion = regionFor(toolsWorld, tools);
    const toolsPlan = plan(tools);
    const toolsLabor = allocation(tools, toolsRegion.regionId, "GENERAL", 30, "tools");
    const toolsExecution = planProductionExecutionsPhase5({
      world: toolsWorld,
      tick: TICK,
      productionPlans: [toolsPlan],
      laborAllocations: [toolsLabor],
    }).executions[0]!;

    expect(() => applyProductionExecutionTransition(toolsWorld, [{
      ...toolsExecution,
      inputConsumedByGood: {
        "good:iron": toolsExecution.inputConsumedByGood["good:iron" as GoodId] ?? 0,
      } as Readonly<Record<GoodId, number>>,
    }], TICK, {
      productionPlans: [toolsPlan],
      laborAllocations: [toolsLabor],
    })).toThrow(/input-good set does not match recipe/);

    let extractionWorld = baselineWorld();
    const originalMine = fixtureUnit(extractionWorld, "recipe:iron-mine");
    const mine: ProductionUnitState = {
      ...originalMine,
      seed: { ...originalMine.seed, status: "MOTHBALLED" },
      status: "ACTIVE",
    };
    extractionWorld = isolateUnit(extractionWorld, mine);
    const mineRegion = regionFor(extractionWorld, mine);
    const minePlan = plan(mine);
    const mineLabor = allocation(mine, mineRegion.regionId, "GENERAL", 1_000, "mine");
    const mineExecution = planProductionExecutionsPhase5({
      world: extractionWorld,
      tick: TICK,
      productionPlans: [minePlan],
      laborAllocations: [mineLabor],
    }).executions[0]!;
    expect(mineExecution.realizedBatches).toBeGreaterThan(0);
    const { resourceConsumption, ...executionWithoutResource } = mineExecution;
    expect(resourceConsumption).toBeDefined();

    expect(() => applyProductionExecutionTransition(extractionWorld, [executionWithoutResource], TICK, {
      productionPlans: [minePlan],
      laborAllocations: [mineLabor],
    })).toThrow(/extraction resource provenance mismatch/);
  });
});
