import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import {
  applyProductionExecutionTransition,
  buildProductionOutputSellIntentsPhase5,
  planProductionExecutionsPhase5,
} from "./productionExecution";
import type { ProductionPlan } from "./productionPlanning";
import { isProductionUnitSafeForRetirement } from "./productionUnitLifecycle";
import { buildInitialWorld, type ProductionUnitState, type WorldState } from "./worldState";

const TICK = 29;

type SeedStatus = ProductionUnitState["seed"]["status"];
type LiveStatus = ProductionUnitState["status"];

function baselineWorld(): WorldState {
  return buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
}

function toolsUnit(world: WorldState): ProductionUnitState {
  const unit = [...world.productionUnits.values()].find(
    (candidate) => candidate.seed.status === "ACTIVE" && candidate.seed.recipeId === "recipe:tools-craft",
  );
  expect(unit).toBeDefined();
  return unit!;
}

function isolateUnit(world: WorldState, target: ProductionUnitState): WorldState {
  const productionUnits = new Map(world.productionUnits);
  for (const [unitId, unit] of productionUnits) {
    productionUnits.set(unitId, { ...unit, status: "MOTHBALLED" });
  }
  productionUnits.set(target.productionUnitId, target);
  return { ...world, productionUnits };
}

function zeroMap<K>(source: ReadonlyMap<K, number>): Map<K, number> {
  return new Map([...source.keys()].map((key) => [key, 0] as const));
}

function zeroProductionPlan(unit: ProductionUnitState): ProductionPlan {
  return {
    planId: `production-plan:${TICK}:${String(unit.productionUnitId)}`,
    unitId: unit.productionUnitId,
    tick: TICK,
    recipeId: unit.seed.recipeId,
    effectiveCapacityBatches: 0,
    targetUtilization: 0,
    plannedBatches: 0,
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

function runOutputSaleFixture(seedStatus: SeedStatus, liveStatus: LiveStatus) {
  let world = baselineWorld();
  const original = toolsUnit(world);
  const unit: ProductionUnitState = {
    ...original,
    seed: { ...original.seed, status: seedStatus },
    status: liveStatus,
    outputInventory: new Map<GoodId, number>([["good:tools" as GoodId, 20]]),
    signals: { ...original.signals, outputSalesEma: 4 },
  };
  const defaults = createDefaultSimulationConfig();
  world = isolateUnit({
    ...world,
    simulationConfig: {
      ...world.simulationConfig,
      production: { ...defaults.production, outputCoverageTicks: 2 },
    },
  }, unit);

  const productionPlan = zeroProductionPlan(unit);
  const execution = planProductionExecutionsPhase5({
    world,
    tick: TICK,
    productionPlans: [productionPlan],
    laborAllocations: [],
  }).executions[0]!;
  const worldAfterProduction = applyProductionExecutionTransition(world, [execution], TICK, {
    productionPlans: [productionPlan],
    laborAllocations: [],
  });

  return {
    execution,
    worldAfterProduction,
    intents: buildProductionOutputSellIntentsPhase5(worldAfterProduction, [execution]),
  };
}

describe("Issue #640 CLOSING OUTPUT liquidation", () => {
  it("exposes all live-CLOSING OUTPUT with zero operating reserve, independent of immutable seed status", () => {
    const seededActive = runOutputSaleFixture("ACTIVE", "CLOSING");
    const seededMothballed = runOutputSaleFixture("MOTHBALLED", "CLOSING");

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

  it("allows a fully filled CLOSING OUTPUT offer to reach zero stock and the safe-retirement boundary", () => {
    const result = runOutputSaleFixture("ACTIVE", "CLOSING");
    const intent = result.intents[0]!;
    const liveUnit = result.worldAfterProduction.productionUnits.get(result.execution.unitId)!;
    const openingOutput = liveUnit.outputInventory.get(result.execution.outputGoodId) ?? 0;
    const outputAfterFullFill = openingOutput - intent.desiredQuantity;

    expect(outputAfterFullFill).toBe(0);

    const retirementReadyUnit: ProductionUnitState = {
      ...liveUnit,
      wallet: zeroMap(liveUnit.wallet),
      inputInventory: zeroMap(liveUnit.inputInventory),
      outputInventory: new Map([[result.execution.outputGoodId, outputAfterFullFill]]),
      investmentInventory: zeroMap(liveUnit.investmentInventory),
      installedCapital: 0,
    };
    const productionUnits = new Map(result.worldAfterProduction.productionUnits);
    productionUnits.set(retirementReadyUnit.productionUnitId, retirementReadyUnit);
    const retirementWorld: WorldState = {
      ...result.worldAfterProduction,
      productionUnits,
      pendingTransitions: {
        ...result.worldAfterProduction.pendingTransitions,
        productionUnitLifecycleChanges: [],
      },
    };

    expect(isProductionUnitSafeForRetirement(retirementWorld, retirementReadyUnit.productionUnitId)).toBe(true);
    expect(buildProductionOutputSellIntentsPhase5(retirementWorld, [result.execution])[0]).toMatchObject({
      desiredQuantity: 0,
      minimumReserveQuantity: 0,
    });
  });

  it("keeps the existing ACTIVE output reserve and does not turn it into liquidation behavior", () => {
    const active = runOutputSaleFixture("ACTIVE", "ACTIVE");

    expect(active.intents).toHaveLength(1);
    expect(active.intents[0]).toMatchObject({
      side: "SELL",
      inventoryBucket: "OUTPUT",
      desiredQuantity: 12,
      minimumReserveQuantity: 8,
    });
  });
});
