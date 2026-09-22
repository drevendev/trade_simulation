import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ScenarioDefinition } from "../config/scenarioDefinition";
import type { CohortId } from "../domain/id";
import { reconcileGenesisStocks } from "./genesisReconciliation";
import type { LaborAllocation } from "./laborAllocation";
import {
  applyProductionExecutionTransition,
  planProductionExecutionsPhase5,
  type ProductionExecution,
} from "./productionExecution";
import type { ProductionPlan } from "./productionPlanning";
import { buildInitialWorld } from "./worldState";

function scenarioWithDuplicateMineDeposits(): {
  readonly scenario: ScenarioDefinition;
  readonly regionKey: string;
} {
  const activeMine = (baselineScenario.productionUnits ?? []).find(
    (unit) => unit.status === "ACTIVE" && unit.recipeId === "recipe:iron-mine",
  );
  if (!activeMine) throw new Error("Baseline fixture must contain an ACTIVE iron mine");

  const geography = (baselineScenario.geography ?? []).map((region) =>
    region.key === activeMine.regionKey
      ? {
          ...region,
          deposits: [
            { resourceId: "resource:iron-ore", initialQuantity: 10, initiallyKnown: true },
            { resourceId: "resource:iron-ore", initialQuantity: 20, initiallyKnown: true },
            { resourceId: "resource:copper-ore", initialQuantity: 7, initiallyKnown: true },
          ],
        }
      : region,
  );

  return {
    scenario: { ...baselineScenario, geography },
    regionKey: activeMine.regionKey,
  };
}

function productionPlan(unitId: ProductionPlan["unitId"], recipeId: string, tick: number): ProductionPlan {
  return {
    planId: `production-plan:${tick}:${String(unitId)}`,
    unitId,
    tick,
    recipeId,
    effectiveCapacityBatches: 1,
    targetUtilization: 1,
    plannedBatches: 1,
    plannedOutputQuantity: 0,
    desiredInputQuantity: {},
    openingUsableInputQuantity: {},
    plannedInputPurchaseQuantity: {},
    procurementCashEnvelope: 0,
    grossWageCashEnvelope: 100,
    operatingLiquidityBuffer: 0,
    workingCapitalTarget: 0,
    investableCash: 0,
    investmentPressure: 0,
    investmentBudget: 0,
    laborDemandPlanId: `labor-demand-plan:${tick}:${String(unitId)}`,
    investmentIntentIds: [],
    inputIntentIds: [],
  };
}

describe("Issue #590 resource genesis authority", () => {
  it("aggregates duplicate deposits into live stock, preserves provenance, and reconciles against that live authority", () => {
    const { scenario, regionKey } = scenarioWithDuplicateMineDeposits();
    const config = createDefaultSimulationConfig();
    const world = buildInitialWorld(scenario, baselineDefinitionPack, config, 590);
    const regionEntry = [...world.regions.entries()].find(([, region]) => region.seed.key === regionKey);
    expect(regionEntry).toBeDefined();
    const [regionId, region] = regionEntry!;

    expect(region.resourceDeposits.get("resource:iron-ore")).toBe(30);
    expect(region.resourceDeposits.get("resource:copper-ore")).toBe(7);
    expect(region.resourceDeposits.size).toBe(2);

    const ironProvenance = world.worldGenesisLedger.records.filter(
      (record) =>
        record.type === "RESOURCE_ENDOWMENT" &&
        record.regionId === regionId &&
        String(record.goodId) === "resource:iron-ore",
    );
    expect(ironProvenance.map((record) => record.amount)).toEqual([10, 20]);
    expect(reconcileGenesisStocks(world, world.worldGenesisLedger, config)).toEqual({ success: true });

    const regions = new Map(world.regions);
    regions.set(regionId, {
      ...region,
      resourceDeposits: new Map([
        ["resource:iron-ore", 29],
        ["resource:copper-ore", 7],
      ]),
    });
    const tampered = reconcileGenesisStocks(
      { ...world, regions },
      world.worldGenesisLedger,
      config,
    );
    expect(tampered).toMatchObject({
      success: false,
      details: { category: "RESOURCE", expected: 30, actual: 29 },
    });
  });

  it("rejects finite duplicate seed quantities when their aggregate would overflow canonical live stock", () => {
    const { scenario, regionKey } = scenarioWithDuplicateMineDeposits();
    const geography = (scenario.geography ?? []).map((region) =>
      region.key === regionKey
        ? {
            ...region,
            deposits: [
              {
                resourceId: "resource:iron-ore",
                initialQuantity: Number.MAX_VALUE,
                initiallyKnown: true,
              },
              {
                resourceId: "resource:iron-ore",
                initialQuantity: Number.MAX_VALUE,
                initiallyKnown: true,
              },
            ],
          }
        : region,
    );

    expect(Number.isFinite(Number.MAX_VALUE)).toBe(true);
    expect(Number.MAX_VALUE + Number.MAX_VALUE).toBe(Number.POSITIVE_INFINITY);
    expect(() =>
      buildInitialWorld(
        { ...scenario, geography },
        baselineDefinitionPack,
        createDefaultSimulationConfig(),
        595,
      ),
    ).toThrow(
      `Region ${regionKey} resource resource:iron-ore aggregate initial quantity must be a finite number`,
    );
  });

  it("rejects Infinity-versus-Infinity resource evidence instead of accepting a NaN residual", () => {
    const { scenario, regionKey } = scenarioWithDuplicateMineDeposits();
    const config = createDefaultSimulationConfig();
    const world = buildInitialWorld(scenario, baselineDefinitionPack, config, 596);
    const regionEntry = [...world.regions.entries()].find(([, region]) => region.seed.key === regionKey);
    expect(regionEntry).toBeDefined();
    const [regionId, region] = regionEntry!;

    const regions = new Map(world.regions);
    regions.set(regionId, {
      ...region,
      resourceDeposits: new Map(region.resourceDeposits).set(
        "resource:iron-ore",
        Number.POSITIVE_INFINITY,
      ),
    });
    const ledger = {
      records: world.worldGenesisLedger.records.map((record) =>
        record.type === "RESOURCE_ENDOWMENT" &&
        record.regionId === regionId &&
        String(record.goodId) === "resource:iron-ore"
          ? { ...record, amount: Number.MAX_VALUE }
          : record,
      ),
    };

    const result = reconcileGenesisStocks({ ...world, regions }, ledger, config);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/non-finite reconciliation evidence/);
    expect(result.details).toMatchObject({
      category: "RESOURCE",
      expected: Number.POSITIVE_INFINITY,
      actual: Number.POSITIVE_INFINITY,
    });
    expect(Number.isNaN(result.details?.residual)).toBe(true);
  });

  it("rejects actual-only NaN and negative-Infinity resource balances before they can disappear from reconciliation", () => {
    const { scenario, regionKey } = scenarioWithDuplicateMineDeposits();
    const config = createDefaultSimulationConfig();
    const world = buildInitialWorld(scenario, baselineDefinitionPack, config, 598);
    const regionEntry = [...world.regions.entries()].find(([, region]) => region.seed.key === regionKey);
    expect(regionEntry).toBeDefined();
    const [regionId, region] = regionEntry!;

    for (const nonFiniteQuantity of [Number.NaN, Number.NEGATIVE_INFINITY]) {
      const resourceDeposits = new Map(region.resourceDeposits);
      resourceDeposits.set("resource:phantom", nonFiniteQuantity);
      const regions = new Map(world.regions);
      regions.set(regionId, { ...region, resourceDeposits });

      const result = reconcileGenesisStocks({ ...world, regions }, world.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/non-finite reconciliation evidence/);
      expect(result.details?.category).toBe("RESOURCE");
      expect(result.details?.key).toContain("resource:phantom");
      expect(result.details?.expected).toBe(0);
      expect(Number.isFinite(result.details?.actual)).toBe(false);
    }
  });

  it("rejects a non-finite resource reconciliation tolerance even when stock matches", () => {
    const { scenario } = scenarioWithDuplicateMineDeposits();
    const config = createDefaultSimulationConfig();
    const world = buildInitialWorld(scenario, baselineDefinitionPack, config, 597);
    const nonFiniteToleranceConfig = {
      ...config,
      numeric: {
        ...config.numeric,
        reconciliationRelativeTolerance: Number.POSITIVE_INFINITY,
      },
    };

    const result = reconcileGenesisStocks(world, world.worldGenesisLedger, nonFiniteToleranceConfig);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/non-finite reconciliation evidence/);
    expect(result.details).toMatchObject({ category: "RESOURCE" });
  });

  it("depletes the aggregated live deposit once and the depleted authority binds later extraction to zero", () => {
    const { scenario, regionKey } = scenarioWithDuplicateMineDeposits();
    const world = buildInitialWorld(
      scenario,
      baselineDefinitionPack,
      createDefaultSimulationConfig(),
      591,
    );
    const region = [...world.regions.values()].find((candidate) => candidate.seed.key === regionKey);
    const unit = [...world.productionUnits.values()].find(
      (candidate) =>
        candidate.seed.regionKey === regionKey &&
        candidate.seed.status === "ACTIVE" &&
        candidate.seed.recipeId === "recipe:iron-mine",
    );
    expect(region).toBeDefined();
    expect(unit).toBeDefined();

    const recipe = world.definitionRegistry.recipes["recipe:iron-mine"]!;
    const realizedBatches = 30 / recipe.extractedResourcePerBatch!;
    const produced = recipe.outputPerBatch * realizedBatches;
    const openingOutput = unit!.outputInventory.get(recipe.outputGoodId) ?? 0;
    const execution: ProductionExecution = {
      tick: 5,
      productionPlanId: `production-plan:5:${String(unit!.productionUnitId)}`,
      unitId: unit!.productionUnitId,
      regionId: region!.regionId,
      recipeId: recipe.id,
      plannedBatches: realizedBatches,
      inputBoundBatches: null,
      laborBoundBatches: realizedBatches,
      capitalBoundBatches: realizedBatches,
      resourceBoundBatches: realizedBatches,
      realizedBatches,
      inputConsumedByGood: {},
      outputGoodId: recipe.outputGoodId,
      outputProducedQuantity: produced,
      postProductionOutputQuantity: openingOutput + produced,
      allocatedWorkerEquivalents: recipe.laborPerBatch * realizedBatches,
      resourceConsumption: {
        resourceId: "resource:iron-ore",
        quantity: 30,
      },
    };

    const productionUnits = new Map(world.productionUnits);
    for (const [unitId, candidate] of productionUnits) {
      if (candidate.status === "ACTIVE" && unitId !== unit!.productionUnitId) {
        productionUnits.set(unitId, {
          ...candidate,
          status: "MOTHBALLED",
        });
      }
    }
    const persistenceWorld = { ...world, productionUnits };
    const currentPlan: ProductionPlan = {
      ...productionPlan(unit!.productionUnitId, recipe.id, execution.tick),
      plannedBatches: realizedBatches,
      effectiveCapacityBatches: realizedBatches,
    };
    const currentLabor: LaborAllocation = {
      allocationId: `labor-allocation:${execution.tick}:${String(unit!.productionUnitId)}:resource-deplete`,
      tick: execution.tick,
      regionId: region!.regionId,
      laborCategory: recipe.laborCategory,
      cohortId: "Cohort:resource-deplete" as CohortId,
      unitId: unit!.productionUnitId,
      workerEquivalents: recipe.laborPerBatch * realizedBatches,
      grossWagePerWorker: 1,
      grossWageObligation: recipe.laborPerBatch * realizedBatches,
    };
    const after = applyProductionExecutionTransition(persistenceWorld, [execution], execution.tick, {
      productionPlans: [currentPlan],
      laborAllocations: [currentLabor],
    });
    expect(after.regions.get(region!.regionId)!.resourceDeposits.get("resource:iron-ore")).toBe(0);
    expect(world.regions.get(region!.regionId)!.resourceDeposits.get("resource:iron-ore")).toBe(30);

    const tick = 6;
    const labor: LaborAllocation = {
      allocationId: `labor-allocation:${tick}:${String(unit!.productionUnitId)}:resource-bind`,
      tick,
      regionId: region!.regionId,
      laborCategory: recipe.laborCategory,
      cohortId: "Cohort:resource-bind" as CohortId,
      unitId: unit!.productionUnitId,
      workerEquivalents: recipe.laborPerBatch * 2,
      grossWagePerWorker: 1,
      grossWageObligation: recipe.laborPerBatch * 2,
    };
    const planned = planProductionExecutionsPhase5({
      world: after,
      tick,
      productionPlans: [productionPlan(unit!.productionUnitId, recipe.id, tick)],
      laborAllocations: [labor],
    }).executions[0]!;

    expect(planned.resourceBoundBatches).toBe(0);
    expect(planned.realizedBatches).toBe(0);
    expect(planned.resourceConsumption).toEqual({
      resourceId: "resource:iron-ore",
      quantity: 0,
    });
  });
});
