import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { applyCapitalFormationTransition, planCapitalFormationPhase12 } from "./capitalFormation";
import { planProductionUnitLifecyclePhase14 } from "./productionUnitLifecycle";
import { planProductionUnitPhase2 } from "./productionPlanning";
import { planPlannedStartupInvestmentPhase2 } from "./productionStartupPlanning";
import { buildInitialWorld, type ProductionUnitState, type WorldState } from "./worldState";

function fixture() {
  const config = createDefaultSimulationConfig();
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
  const opening = [...world.productionUnits.values()].find(
    (candidate) => candidate.status === "ACTIVE" && candidate.seed.recipeId === "recipe:tools-craft",
  )!;
  const region = [...world.regions.values()].find((candidate) => candidate.seed.key === opening.seed.regionKey)!;
  const recipe = world.definitionRegistry.recipes[opening.seed.recipeId]!;
  const investmentPrices = Object.fromEntries(
    Object.keys(recipe.investmentGoodsPerCapitalUnit).map((goodId) => [goodId, 10]),
  ) as Readonly<Record<GoodId, number>>;
  const inputPrices = Object.fromEntries(
    Object.keys(recipe.inputsPerBatch).map((goodId) => [goodId, 10]),
  ) as Readonly<Record<GoodId, number>>;
  const planned: ProductionUnitState = {
    ...opening,
    status: "PLANNED",
    installedCapital: 0,
    investmentInventory: new Map(),
  };
  return { config, world, opening, planned, region, recipe, investmentPrices, inputPrices };
}

function withOnlyUnit(world: WorldState, unit: ProductionUnitState): WorldState {
  return { ...world, productionUnits: new Map([[unit.productionUnitId, unit]]) };
}

describe("REQ-PRODUCTION-007 PLANNED startup investment", () => {
  it("buys only real startup INVESTMENT goods from opening unit cash", () => {
    const { config, planned, region, recipe, investmentPrices } = fixture();
    const result = planPlannedStartupInvestmentPhase2({
      tick: 3,
      unit: planned,
      regionId: region.regionId,
      settlementCurrencyId: region.settlementCurrencyId,
      recipe,
      config,
      evidence: {
        mandatoryKnownCash: 0,
        priorCloseGrossInvestmentPriceByGood: investmentPrices,
      },
    });

    expect(result.investmentBudget).toBeGreaterThan(0);
    expect(result.investmentIntents.length).toBeGreaterThan(0);
    expect(result.investmentIntents.every((intent) => intent.purpose === "INVESTMENT")).toBe(true);
    expect(result.investmentIntents.every((intent) => intent.inventoryBucket === "INVESTMENT")).toBe(true);
    expect(result.investmentIntents.reduce((sum, intent) => sum + (intent.maxSpend ?? 0), 0)).toBeCloseTo(
      result.investmentBudget,
      12,
    );
  });

  it("emits no startup INVESTMENT intents off the canonical investment-review cadence", () => {
    const { config, planned, region, recipe, investmentPrices } = fixture();
    const result = planPlannedStartupInvestmentPhase2({
      tick: 1,
      unit: planned,
      regionId: region.regionId,
      settlementCurrencyId: region.settlementCurrencyId,
      recipe,
      config,
      evidence: {
        mandatoryKnownCash: 0,
        priorCloseGrossInvestmentPriceByGood: investmentPrices,
      },
    });
    expect(result.investmentIntents).toEqual([]);
    expect(result.investmentBudget).toBe(0);
  });

  it("uses live PLANNED status even when immutable seed status says ACTIVE and emits no labor/input demand", () => {
    const { config, planned, region, recipe, investmentPrices, inputPrices } = fixture();
    expect(planned.seed.status).toBe("ACTIVE");

    const result = planProductionUnitPhase2({
      tick: 3,
      unit: planned,
      regionId: region.regionId,
      settlementCurrencyId: region.settlementCurrencyId,
      recipe,
      config,
      evidence: {
        mandatoryKnownCash: 0,
        legalMinimumWageFloor: 0,
        priorCloseGrossInputPriceByGood: inputPrices,
        priorCloseGrossInvestmentPriceByGood: investmentPrices,
        infrastructureFactor: 1,
        resourceAccessFactor: 1,
        healthLaborProductivityFactor: 1,
      },
    });

    expect(result.productionPlan.plannedBatches).toBe(0);
    expect(result.laborDemandPlan.requestedWorkerEquivalents).toBe(0);
    expect(result.inputIntents).toEqual([]);
    expect(result.investmentIntents.length).toBeGreaterThan(0);
  });

  it("keeps MOTHBALLED/CLOSING outside both ordinary and startup investment flows", () => {
    const { config, planned, region, recipe, investmentPrices, inputPrices } = fixture();
    for (const status of ["MOTHBALLED", "CLOSING"] as const) {
      const unit: ProductionUnitState = { ...planned, status };
      const result = planProductionUnitPhase2({
        tick: 1,
        unit,
        regionId: region.regionId,
        settlementCurrencyId: region.settlementCurrencyId,
        recipe,
        config,
        evidence: {
          mandatoryKnownCash: 0,
          legalMinimumWageFloor: 0,
          priorCloseGrossInputPriceByGood: inputPrices,
          priorCloseGrossInvestmentPriceByGood: investmentPrices,
          infrastructureFactor: 1,
          resourceAccessFactor: 1,
          healthLaborProductivityFactor: 1,
        },
      });
      expect(result.productionPlan.plannedBatches).toBe(0);
      expect(result.laborDemandPlan.requestedWorkerEquivalents).toBe(0);
      expect(result.inputIntents).toEqual([]);
      expect(result.investmentIntents).toEqual([]);
    }
  });

  it("allows PLANNED Phase-12 startup capital but does not activate until Phase 14 queues tick+1", () => {
    const { world, planned, recipe } = fixture();
    const requiredPreDepreciationCapital = recipe.minimumStartupCapital / (1 - recipe.depreciationRatePerTick);
    const fullStartupInventory = new Map(
      Object.entries(recipe.investmentGoodsPerCapitalUnit).map(([goodId, coefficient]) => [
        goodId as GoodId,
        coefficient * requiredPreDepreciationCapital,
      ]),
    );
    const prepared = withOnlyUnit(world, { ...planned, investmentInventory: fullStartupInventory });
    const capitalPlan = planCapitalFormationPhase12({ world: prepared, tick: 3 });
    const afterPhase12 = applyCapitalFormationTransition(prepared, capitalPlan.executions, 3);
    const built = afterPhase12.productionUnits.get(planned.productionUnitId)!;
    expect(built.status).toBe("PLANNED");
    expect(built.installedCapital).toBeGreaterThanOrEqual(recipe.minimumStartupCapital);

    const lifecycle = planProductionUnitLifecyclePhase14({ world: afterPhase12, tick: 3 });
    const review = lifecycle.reviews.find((candidate) => candidate.unitId === planned.productionUnitId)!;
    expect(review.transition?.target).toBe("ACTIVE");
    expect(review.transition?.activateTick).toBe(4);
    expect(afterPhase12.productionUnits.get(planned.productionUnitId)!.status).toBe("PLANNED");
  });
});
