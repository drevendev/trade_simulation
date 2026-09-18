import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { createTransactionId, initializeTickContext } from "./tickOrchestrator";
import { getEnvelopeCommitment, validateMarketIntent } from "./marketIntent";
import {
  createPhase2ProductionPlanningHandler,
  planProductionUnitPhase2,
  type ProductionPlanningEvidence,
} from "./productionPlanning";
import type { ProductionUnitState, WorldState } from "./worldState";
import { buildInitialWorld } from "./worldState";

function fixture() {
  const config = createDefaultSimulationConfig();
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
  const unit = Array.from(world.productionUnits.values()).find(
    (candidate) =>
      candidate.seed.status === "ACTIVE" &&
      Object.keys(world.definitionRegistry.recipes[candidate.seed.recipeId]?.inputsPerBatch ?? {}).length >= 2,
  );
  expect(unit).toBeDefined();
  const recipe = world.definitionRegistry.recipes[unit!.seed.recipeId];
  expect(recipe).toBeDefined();
  const region = Array.from(world.regions.values()).find(
    (candidate) => candidate.seed.key === unit!.seed.regionKey,
  );
  expect(region).toBeDefined();

  const highCashUnit: ProductionUnitState = {
    ...unit!,
    wallet: new Map([[region!.settlementCurrencyId, 1_000_000]]),
    inputInventory: new Map(),
    outputInventory: new Map(),
  };
  const priorCloseGrossInputPriceByGood: Record<string, number> = {};
  for (const goodId of Object.keys(recipe!.inputsPerBatch) as GoodId[]) {
    priorCloseGrossInputPriceByGood[goodId] = world.definitionRegistry.goods[goodId]!.referencePrice;
  }
  const evidence: ProductionPlanningEvidence = {
    mandatoryKnownCash: 0,
    legalMinimumWageFloor: 0,
    priorCloseGrossInputPriceByGood: priorCloseGrossInputPriceByGood as Record<GoodId, number>,
    infrastructureFactor: 1,
    resourceAccessFactor: 1,
    healthLaborProductivityFactor: 1,
  };

  return { config, world, unit: highCashUnit, recipe: recipe!, region: region!, evidence };
}

function plan(overrides?: {
  unit?: ProductionUnitState;
  evidence?: ProductionPlanningEvidence;
}) {
  const base = fixture();
  return {
    ...base,
    result: planProductionUnitPhase2({
      tick: 7,
      unit: overrides?.unit ?? base.unit,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: base.recipe,
      config: base.config,
      evidence: overrides?.evidence ?? base.evidence,
    }),
  };
}

describe("REQ-PRODUCTION-002 Phase-2 production planning slice", () => {
  it("derives effective capacity, adaptive utilization, labor demand and valid INPUT intents", () => {
    const { config, unit, recipe, result } = plan();
    const expectedCapacity =
      unit.installedCapital *
      recipe.batchesPerCapitalUnit *
      recipe.baseThroughputFactor *
      unit.seed.condition;

    expect(result.productionPlan.effectiveCapacityBatches).toBeCloseTo(expectedCapacity, 10);
    // Empty output inventory makes the section-7 output gap +1. Neutral margin and
    // sell-through signals leave only the configured inventory response above base target.
    expect(result.productionPlan.targetUtilization).toBeCloseTo(
      Math.min(
        config.production.maxTargetUtilization!,
        config.production.baseTargetUtilization! + config.production.inventoryResponse!,
      ),
      10,
    );
    expect(result.productionPlan.plannedBatches).toBeCloseTo(
      result.productionPlan.effectiveCapacityBatches * result.productionPlan.targetUtilization,
      10,
    );
    expect(result.productionPlan.plannedOutputQuantity).toBeCloseTo(
      result.productionPlan.plannedBatches * recipe.outputPerBatch,
      10,
    );
    expect(result.laborDemandPlan.requestedWorkerEquivalents).toBeGreaterThan(0);
    expect(result.laborDemandPlan.grossPayrollCap).toBeCloseTo(
      result.laborDemandPlan.requestedWorkerEquivalents * result.laborDemandPlan.grossWageOffer,
      10,
    );

    expect(result.inputIntents.map((intent) => String(intent.goodId))).toEqual(
      [...result.inputIntents.map((intent) => String(intent.goodId))].sort(),
    );
    expect(result.inputIntents.length).toBeGreaterThan(0);
    for (const intent of result.inputIntents) {
      expect(() => validateMarketIntent(intent)).not.toThrow();
      expect(intent.side).toBe("BUY");
      expect(intent.purpose).toBe("INPUT");
      expect(intent.inventoryBucket).toBe("INPUT");
      expect(intent.sourcePlanId).toBe(result.productionPlan.planId);
    }
    expect(result.inputIntents.reduce((sum, intent) => sum + (intent.maxSpend ?? 0), 0)).toBeCloseTo(
      result.productionPlan.procurementCashEnvelope,
      8,
    );
    expect(result.productionPlan.investmentIntentIds).toEqual([]);
    expect(result.productionPlan.outputSellIntentId).toBeUndefined();
  });

  it("reserves mandatory cash, operating liquidity and payroll before INPUT procurement", () => {
    const base = fixture();
    const constrained: ProductionUnitState = {
      ...base.unit,
      wallet: new Map([[base.region.settlementCurrencyId, 100]]),
      inputInventory: new Map(),
      outputInventory: new Map(),
    };
    const evidence: ProductionPlanningEvidence = {
      ...base.evidence,
      mandatoryKnownCash: 10,
    };
    const result = planProductionUnitPhase2({
      tick: 7,
      unit: constrained,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: base.recipe,
      config: base.config,
      evidence,
    });

    expect(result.productionPlan.operatingLiquidityBuffer).toBe(10);
    expect(result.productionPlan.grossWageCashEnvelope).toBeCloseTo(80, 10);
    expect(result.productionPlan.procurementCashEnvelope).toBeCloseTo(0, 10);
    expect(
      evidence.mandatoryKnownCash +
        result.productionPlan.operatingLiquidityBuffer +
        result.productionPlan.grossWageCashEnvelope +
        result.productionPlan.procurementCashEnvelope,
    ).toBeLessThanOrEqual(100 + 1e-9);
    expect(result.inputIntents.every((intent) => intent.maxSpend === 0)).toBe(true);
  });

  it("cannot finance Phase-2 plans from same-tick sale transactions or market outputs", () => {
    const base = fixture();
    const oneUnitWorld: WorldState = {
      ...base.world,
      productionUnits: new Map([[base.unit.productionUnitId, base.unit]]),
    };
    const handler = createPhase2ProductionPlanningHandler({
      evidenceByUnit: new Map([[base.unit.productionUnitId, base.evidence]]),
    });
    const phase2 = { ...initializeTickContext(7, 42), phase: 2 };
    const withFakeSameTickSale = {
      ...phase2,
      transactions: [
        {
          tick: 7,
          phase: 8,
          type: "MARKET_SALE",
          transactionId: createTransactionId("tx:fake-same-tick-sale"),
          amount: 999_999,
          moneyAmount: 999_999,
        },
      ],
      marketPrices: new Map([["fake-market|good:tools", 999_999]]),
    };

    const cleanResult = handler(oneUnitWorld, phase2, oneUnitWorld.pendingTransitions);
    const contaminatedResult = handler(oneUnitWorld, withFakeSameTickSale, oneUnitWorld.pendingTransitions);

    expect(contaminatedResult.productionPlans).toEqual(cleanResult.productionPlans);
    expect(contaminatedResult.laborDemandPlans).toEqual(cleanResult.laborDemandPlans);
    expect(contaminatedResult.productionMarketIntents).toEqual(cleanResult.productionMarketIntents);
  });

  it("is insertion-order invariant for recipe inputs and prior-close price evidence", () => {
    const base = fixture();
    const entries = Object.entries(base.recipe.inputsPerBatch) as [GoodId, number][];
    expect(entries.length).toBeGreaterThan(1);
    const reversedInputs = Object.fromEntries([...entries].reverse()) as Record<GoodId, number>;
    const priceEntries = Object.entries(base.evidence.priorCloseGrossInputPriceByGood) as [GoodId, number][];
    const reversedPrices = Object.fromEntries([...priceEntries].reverse()) as Record<GoodId, number>;

    const forward = planProductionUnitPhase2({
      tick: 7,
      unit: base.unit,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: base.recipe,
      config: base.config,
      evidence: base.evidence,
    });
    const reversed = planProductionUnitPhase2({
      tick: 7,
      unit: base.unit,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: { ...base.recipe, inputsPerBatch: reversedInputs },
      config: base.config,
      evidence: { ...base.evidence, priorCloseGrossInputPriceByGood: reversedPrices },
    });

    expect(reversed).toEqual(forward);
  });

  it("gives non-ACTIVE units zero normal production/labor demand without inventing evidence", () => {
    const base = fixture();
    const mothballed: ProductionUnitState = {
      ...base.unit,
      seed: { ...base.unit.seed, status: "MOTHBALLED" },
    };
    const result = planProductionUnitPhase2({
      tick: 7,
      unit: mothballed,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: base.recipe,
      config: base.config,
    });

    expect(result.productionPlan.effectiveCapacityBatches).toBe(0);
    expect(result.productionPlan.plannedBatches).toBe(0);
    expect(result.productionPlan.procurementCashEnvelope).toBe(0);
    expect(result.laborDemandPlan.requestedWorkerEquivalents).toBe(0);
    expect(result.inputIntents).toEqual([]);
  });

  it("fails fast on negative/non-finite Phase-2 evidence instead of normalizing it", () => {
    const base = fixture();
    expect(() =>
      planProductionUnitPhase2({
        tick: 7,
        unit: base.unit,
        regionId: base.region.regionId,
        settlementCurrencyId: base.region.settlementCurrencyId,
        recipe: base.recipe,
        config: base.config,
        evidence: { ...base.evidence, mandatoryKnownCash: Number.NaN },
      }),
    ).toThrow(/mandatoryKnownCash.*finite/);

    const firstInput = Object.keys(base.recipe.inputsPerBatch)[0] as GoodId;
    expect(() =>
      planProductionUnitPhase2({
        tick: 7,
        unit: base.unit,
        regionId: base.region.regionId,
        settlementCurrencyId: base.region.settlementCurrencyId,
        recipe: base.recipe,
        config: base.config,
        evidence: {
          ...base.evidence,
          priorCloseGrossInputPriceByGood: {
            ...base.evidence.priorCloseGrossInputPriceByGood,
            [firstInput]: -1,
          },
        },
      }),
    ).toThrow(/priorCloseGrossInputPriceByGood.*must be > 0/);

    expect(() =>
      planProductionUnitPhase2({
        tick: 7,
        unit: base.unit,
        regionId: base.region.regionId,
        settlementCurrencyId: base.region.settlementCurrencyId,
        recipe: base.recipe,
        config: base.config,
        evidence: { ...base.evidence, infrastructureFactor: 1.1 },
      }),
    ).toThrow(/infrastructureFactor.*\[0, 1\]/);
  });

  it("commits Phase-2 INPUT maxSpend to the plan envelope and rejects duplicate overcommit", () => {
    const base = fixture();
    const oneUnitWorld: WorldState = {
      ...base.world,
      productionUnits: new Map([[base.unit.productionUnitId, base.unit]]),
    };
    const handler = createPhase2ProductionPlanningHandler({
      evidenceByUnit: new Map([[base.unit.productionUnitId, base.evidence]]),
    });
    const phase1 = { ...initializeTickContext(7, 42), phase: 1 };
    const phase2 = { ...phase1, phase: 2 };

    expect(handler(oneUnitWorld, phase1, oneUnitWorld.pendingTransitions)).toBe(phase1);
    const planned = handler(oneUnitWorld, phase2, oneUnitWorld.pendingTransitions);
    expect(planned.productionPlans).toHaveLength(1);
    expect(planned.laborDemandPlans).toHaveLength(1);
    expect(planned.productionMarketIntents?.length).toBeGreaterThan(0);
    expect(planned.transactions).toEqual([]);
    expect(planned.currentLedger.records).toEqual([]);

    const productionPlan = planned.productionPlans![0]!;
    const intents = planned.productionMarketIntents!;
    const submittedMaxSpend = intents.reduce((sum, intent) => sum + (intent.maxSpend ?? 0), 0);
    const committed = getEnvelopeCommitment(
      planned.budgetLedger,
      intents[0]!.actor,
      base.region.settlementCurrencyId,
      productionPlan.planId,
    );
    expect(committed).toBeCloseTo(submittedMaxSpend, 10);
    expect(submittedMaxSpend).toBeCloseTo(productionPlan.procurementCashEnvelope, 8);

    expect(() => handler(oneUnitWorld, planned, oneUnitWorld.pendingTransitions)).toThrow(
      /Phase-2 INPUT budget commitment failed.*would exceed limit/,
    );
  });
});
