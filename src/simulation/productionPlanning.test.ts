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
  const priorCloseGrossInvestmentPriceByGood: Record<string, number> = {};
  for (const goodId of Object.keys(recipe!.investmentGoodsPerCapitalUnit) as GoodId[]) {
    priorCloseGrossInvestmentPriceByGood[goodId] = world.definitionRegistry.goods[goodId]!.referencePrice;
  }
  const evidence: ProductionPlanningEvidence = {
    mandatoryKnownCash: 0,
    legalMinimumWageFloor: 0,
    priorCloseGrossInputPriceByGood: priorCloseGrossInputPriceByGood as Record<GoodId, number>,
    priorCloseGrossInvestmentPriceByGood: priorCloseGrossInvestmentPriceByGood as Record<GoodId, number>,
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
      // Runtime behavior follows live lifecycle status, never immutable scenario seed status.
      status: "MOTHBALLED",
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

  it("emits deterministic due-cadence INVESTMENT intents from the canonical pressure and protected cash envelope", () => {
    const base = fixture();
    const unit: ProductionUnitState = {
      ...base.unit,
      signals: {
        ...base.unit.signals,
        utilizationEma: 0.9,
        marginSignalEma: 0.2,
        sellThroughEma: 0.95,
      },
    };
    const result = planProductionUnitPhase2({
      tick: 6,
      unit,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: base.recipe,
      config: base.config,
      evidence: base.evidence,
    });

    const demandPressure = Math.min(
      1,
      Math.max(
        -1,
        (unit.signals.utilizationEma - base.config.production.investmentUtilizationThreshold!) /
          Math.max(1 - base.config.production.investmentUtilizationThreshold!, base.config.numeric.quantityEpsilon!),
      ),
    );
    const marginPressure = Math.max(
      0,
      unit.signals.marginSignalEma - base.config.production.minimumInvestmentMargin!,
    );
    const salesPressure = Math.max(
      0,
      unit.signals.sellThroughEma - base.config.production.targetSellThrough!,
    );
    const expectedPressure = Math.min(1, Math.max(0, (demandPressure + marginPressure + salesPressure) / 3));

    expect(result.productionPlan.investmentPressure).toBeCloseTo(expectedPressure, 10);
    expect(result.productionPlan.workingCapitalTarget).toBeCloseTo(
      base.evidence.mandatoryKnownCash +
        result.productionPlan.grossWageCashEnvelope +
        Object.entries(result.productionPlan.plannedInputPurchaseQuantity).reduce(
          (sum, [goodId, quantity]) =>
            sum + quantity * base.evidence.priorCloseGrossInputPriceByGood[goodId as GoodId]!,
          0,
        ) +
        result.productionPlan.operatingLiquidityBuffer,
      8,
    );
    expect(result.investmentIntents.length).toBeGreaterThan(0);
    expect(result.productionPlan.investmentIntentIds).toEqual(result.investmentIntents.map((intent) => intent.id));
    expect(result.investmentIntents.map((intent) => String(intent.goodId))).toEqual(
      [...result.investmentIntents.map((intent) => String(intent.goodId))].sort(),
    );
    for (const intent of result.investmentIntents) {
      expect(() => validateMarketIntent(intent)).not.toThrow();
      expect(intent.side).toBe("BUY");
      expect(intent.purpose).toBe("INVESTMENT");
      expect(intent.inventoryBucket).toBe("INVESTMENT");
      expect(intent.sourcePlanId).toBe(result.productionPlan.planId);
    }
    expect(result.investmentIntents.reduce((sum, intent) => sum + (intent.maxSpend ?? 0), 0)).toBeCloseTo(
      result.productionPlan.investmentBudget,
      8,
    );
    expect(result.productionPlan.outputSellIntentId).toBeUndefined();
  });

  it("emits no ordinary INVESTMENT intents at genesis or off cadence", () => {
    const base = fixture();
    const investmentReady: ProductionUnitState = {
      ...base.unit,
      signals: { ...base.unit.signals, utilizationEma: 1, marginSignalEma: 1, sellThroughEma: 1 },
    };
    for (const tick of [0, 7]) {
      const result = planProductionUnitPhase2({
        tick,
        unit: investmentReady,
        regionId: base.region.regionId,
        settlementCurrencyId: base.region.settlementCurrencyId,
        recipe: base.recipe,
        config: base.config,
        evidence: base.evidence,
      });
      expect(result.productionPlan.investmentPressure).toBe(0);
      expect(result.productionPlan.investmentBudget).toBe(0);
      expect(result.investmentIntents).toEqual([]);
      expect(result.productionPlan.investmentIntentIds).toEqual([]);
    }
  });

  it("requires positive finite prior-close INVESTMENT prices for material desired purchases", () => {
    const base = fixture();
    const investmentReady: ProductionUnitState = {
      ...base.unit,
      signals: { ...base.unit.signals, utilizationEma: 1, marginSignalEma: 1, sellThroughEma: 1 },
    };
    const investmentGood = Object.keys(base.recipe.investmentGoodsPerCapitalUnit)[0] as GoodId;
    expect(investmentGood).toBeDefined();

    for (const badPrice of [undefined, 0, -1, Number.NaN]) {
      const prices = badPrice === undefined
        ? {}
        : { [investmentGood]: badPrice };
      expect(() =>
        planProductionUnitPhase2({
          tick: 6,
          unit: investmentReady,
          regionId: base.region.regionId,
          settlementCurrencyId: base.region.settlementCurrencyId,
          recipe: base.recipe,
          config: base.config,
          evidence: {
            ...base.evidence,
            priorCloseGrossInvestmentPriceByGood: prices as Record<GoodId, number>,
          },
        }),
      ).toThrow(/priorCloseGrossInvestmentPriceByGood/);
    }
  });

  it("keeps INVESTMENT commitments distinct from INPUT and rejects duplicate investment overcommit", () => {
    const base = fixture();
    const fullInputs = new Map<GoodId, number>();
    for (const goodId of Object.keys(base.recipe.inputsPerBatch) as GoodId[]) {
      fullInputs.set(goodId, 1_000_000);
    }
    const unit: ProductionUnitState = {
      ...base.unit,
      inputInventory: fullInputs,
      signals: { ...base.unit.signals, utilizationEma: 1, marginSignalEma: 1, sellThroughEma: 1 },
    };
    const oneUnitWorld: WorldState = {
      ...base.world,
      productionUnits: new Map([[unit.productionUnitId, unit]]),
    };
    const handler = createPhase2ProductionPlanningHandler({
      evidenceByUnit: new Map([[unit.productionUnitId, base.evidence]]),
    });
    const phase2 = { ...initializeTickContext(6, 42), phase: 2 };
    const planned = handler(oneUnitWorld, phase2, oneUnitWorld.pendingTransitions);
    const productionPlan = planned.productionPlans![0]!;
    const investmentIntents = planned.productionMarketIntents!.filter((intent) => intent.purpose === "INVESTMENT");
    expect(investmentIntents.length).toBeGreaterThan(0);
    expect(planned.productionMarketIntents!.filter((intent) => intent.purpose === "INPUT")).toEqual([]);
    expect(getEnvelopeCommitment(
      planned.budgetLedger,
      investmentIntents[0]!.actor,
      base.region.settlementCurrencyId,
      productionPlan.planId,
    )).toBe(0);
    expect(getEnvelopeCommitment(
      planned.budgetLedger,
      investmentIntents[0]!.actor,
      base.region.settlementCurrencyId,
      `${productionPlan.planId}:INVESTMENT`,
    )).toBeCloseTo(investmentIntents.reduce((sum, intent) => sum + (intent.maxSpend ?? 0), 0), 10);

    expect(() => handler(oneUnitWorld, planned, oneUnitWorld.pendingTransitions)).toThrow(
      /Phase-2 INVESTMENT budget commitment failed.*would exceed limit/,
    );
  });

  it("keeps uneven multi-good INVESTMENT shares within the exact ledger envelope", () => {
    const base = fixture();
    const investmentBudget = 16_457.035838952725;
    const investmentGoods = {
      "good:stone": 0.01490897216709655,
      "good:tools": 465_419.80594505713,
    } as Record<GoodId, number>;
    const recipe = {
      ...base.recipe,
      laborPerBatch: 0,
      investmentGoodsPerCapitalUnit: investmentGoods,
    };
    const fullInputs = new Map<GoodId, number>();
    for (const goodId of Object.keys(recipe.inputsPerBatch) as GoodId[]) {
      fullInputs.set(goodId, 1_000_000);
    }
    const unit: ProductionUnitState = {
      ...base.unit,
      installedCapital: 1,
      wallet: new Map([[base.region.settlementCurrencyId, investmentBudget]]),
      inputInventory: fullInputs,
      investmentInventory: new Map<GoodId, number>(),
      signals: { ...base.unit.signals, utilizationEma: 1, marginSignalEma: 1, sellThroughEma: 1 },
    };
    const config = {
      ...base.config,
      production: {
        ...base.config.production,
        minOperatingCash: 0,
        liquidityBufferShare: 0,
        investmentReviewCadenceTicks: 3,
        investmentUtilizationThreshold: 0,
        minimumInvestmentMargin: 0,
        targetSellThrough: 0,
        investmentPropensity: 1,
        maxInvestmentShareOfExcessCash: 1,
        maxCapitalGrowthPerReview: 1,
      },
    };
    const evidence: ProductionPlanningEvidence = {
      ...base.evidence,
      priorCloseGrossInvestmentPriceByGood: {
        "good:stone": 1,
        "good:tools": 1,
      } as Record<GoodId, number>,
    };
    const oneUnitWorld: WorldState = {
      ...base.world,
      simulationConfig: config,
      definitionRegistry: {
        ...base.world.definitionRegistry,
        recipes: { ...base.world.definitionRegistry.recipes, [recipe.id]: recipe },
      },
      productionUnits: new Map([[unit.productionUnitId, unit]]),
    };
    const handler = createPhase2ProductionPlanningHandler({
      evidenceByUnit: new Map([[unit.productionUnitId, evidence]]),
    });
    const phase2 = { ...initializeTickContext(6, 42), phase: 2 };

    const planned = handler(oneUnitWorld, phase2, oneUnitWorld.pendingTransitions);
    const productionPlan = planned.productionPlans![0]!;
    const investmentIntents = planned.productionMarketIntents!.filter((intent) => intent.purpose === "INVESTMENT");
    const submittedMaxSpend = investmentIntents.reduce((sum, intent) => sum + (intent.maxSpend ?? 0), 0);
    const committed = getEnvelopeCommitment(
      planned.budgetLedger,
      investmentIntents[0]!.actor,
      base.region.settlementCurrencyId,
      `${productionPlan.planId}:INVESTMENT`,
    );

    expect(investmentIntents).toHaveLength(2);
    expect(productionPlan.investmentBudget).toBe(investmentBudget);
    expect(submittedMaxSpend).toBeLessThanOrEqual(productionPlan.investmentBudget);
    expect(committed).toBe(submittedMaxSpend);
    expect(committed).toBeLessThanOrEqual(productionPlan.investmentBudget);
  });

  it("is investment-order invariant, ignores same-tick financing context, and mutates no capital or INVESTMENT stock", () => {
    const base = fixture();
    const investmentGoods = {
      "good:tools": 100,
      "good:stone": 40,
    } as Record<GoodId, number>;
    const recipe = { ...base.recipe, investmentGoodsPerCapitalUnit: investmentGoods };
    const unit: ProductionUnitState = {
      ...base.unit,
      signals: { ...base.unit.signals, utilizationEma: 1, marginSignalEma: 1, sellThroughEma: 1 },
      investmentInventory: new Map([["good:tools" as GoodId, 1]]),
    };
    const prices = {
      "good:tools": base.world.definitionRegistry.goods["good:tools" as GoodId]!.referencePrice,
      "good:stone": base.world.definitionRegistry.goods["good:stone" as GoodId]!.referencePrice,
    } as Record<GoodId, number>;
    const evidence = { ...base.evidence, priorCloseGrossInvestmentPriceByGood: prices };
    const beforeCapital = unit.installedCapital;
    const beforeInventory = Array.from(unit.investmentInventory.entries());
    const forward = planProductionUnitPhase2({
      tick: 6,
      unit,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe,
      config: base.config,
      evidence,
    });
    const reversed = planProductionUnitPhase2({
      tick: 6,
      unit,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: { ...recipe, investmentGoodsPerCapitalUnit: Object.fromEntries(Object.entries(investmentGoods).reverse()) as Record<GoodId, number> },
      config: base.config,
      evidence: { ...evidence, priorCloseGrossInvestmentPriceByGood: Object.fromEntries(Object.entries(prices).reverse()) as Record<GoodId, number> },
    });
    expect(reversed).toEqual(forward);
    expect(unit.installedCapital).toBe(beforeCapital);
    expect(Array.from(unit.investmentInventory.entries())).toEqual(beforeInventory);

    const oneUnitWorld: WorldState = {
      ...base.world,
      definitionRegistry: {
        ...base.world.definitionRegistry,
        recipes: { ...base.world.definitionRegistry.recipes, [recipe.id]: recipe },
      },
      productionUnits: new Map([[unit.productionUnitId, unit]]),
    };
    const handler = createPhase2ProductionPlanningHandler({
      evidenceByUnit: new Map([[unit.productionUnitId, evidence]]),
    });
    const clean = { ...initializeTickContext(6, 42), phase: 2 };
    const contaminated = {
      ...clean,
      transactions: [
        { tick: 6, phase: 7, type: "MARKET_SALE", transactionId: createTransactionId("tx:fake-import-money"), amount: 900_000, moneyAmount: 900_000 },
        { tick: 6, phase: 10, type: "MARKET_SALE", transactionId: createTransactionId("tx:fake-distribution"), amount: 900_000, moneyAmount: 900_000 },
      ],
      marketPrices: new Map([["fake-market|good:tools", 900_000]]),
    };
    const cleanResult = handler(oneUnitWorld, clean, oneUnitWorld.pendingTransitions);
    const contaminatedResult = handler(oneUnitWorld, contaminated, oneUnitWorld.pendingTransitions);
    expect(contaminatedResult.productionPlans).toEqual(cleanResult.productionPlans);
    expect(contaminatedResult.productionMarketIntents).toEqual(cleanResult.productionMarketIntents);
  });

  it("reads the canonical live wageOffer rather than the immutable scenario seed", () => {
    const base = fixture();
    const unit: ProductionUnitState = {
      ...base.unit,
      wageOffer: 17,
      seed: { ...base.unit.seed, wageOffer: 2 },
    };
    const result = planProductionUnitPhase2({
      tick: 7,
      unit,
      regionId: base.region.regionId,
      settlementCurrencyId: base.region.settlementCurrencyId,
      recipe: base.recipe,
      config: base.config,
      evidence: { ...base.evidence, legalMinimumWageFloor: 0 },
    });
    expect(result.laborDemandPlan.grossWageOffer).toBe(17);
  });
});
