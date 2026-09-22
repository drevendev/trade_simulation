/**
 * Deterministic Phase-2 production planning (REQ-PRODUCTION-002, first bounded slice).
 *
 * Implements Handoff/05 sections 5-12 and 19-20 for ProductionPlan/LaborDemandPlan
 * construction, INPUT procurement and cadence-based ACTIVE-unit INVESTMENT intents.
 * Phase-5 execution and the post-production OUTPUT sell intent (section 17) remain
 * separate work.
 *
 * The planning-evidence boundary is deliberately explicit. Callers supply only values
 * that Phase 2 is allowed to know at tick open: prior-close gross input prices, effective
 * policy (mandatory known cash / minimum wage) and already-derived physical productivity
 * factors. There is no parameter for same-tick sales, Phase-7 imports, later owner
 * distributions, future subsidies or credit, so none can finance the plan accidentally.
 */

import type { RecipeDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId, ProductionUnitId, RegionId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import {
  commitBudget,
  createMarketIntentId,
  validateMarketIntent,
  type MarketIntent,
  type MarketIntentId,
} from "./marketIntent";
import { deriveNameplateCapacity } from "./productionUnitState";
import { planPlannedStartupInvestmentPhase2 } from "./productionStartupPlanning";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import type { PendingTransitions, ProductionUnitState, RegionState, WorldState } from "./worldState";

export interface ProductionPlan {
  readonly planId: string;
  readonly unitId: ProductionUnitId;
  readonly tick: number;
  readonly recipeId: string;
  readonly effectiveCapacityBatches: number;
  readonly targetUtilization: number;
  readonly plannedBatches: number;
  readonly plannedOutputQuantity: number;
  readonly desiredInputQuantity: Readonly<Record<GoodId, number>>;
  readonly openingUsableInputQuantity: Readonly<Record<GoodId, number>>;
  readonly plannedInputPurchaseQuantity: Readonly<Record<GoodId, number>>;
  readonly procurementCashEnvelope: number;
  readonly grossWageCashEnvelope: number;
  readonly operatingLiquidityBuffer: number;
  readonly workingCapitalTarget: number;
  readonly investableCash: number;
  readonly investmentPressure: number;
  readonly investmentBudget: number;
  readonly laborDemandPlanId: string;
  readonly investmentIntentIds: readonly MarketIntentId[];
  readonly inputIntentIds: readonly MarketIntentId[];
  readonly outputSellIntentId?: MarketIntentId;
}

export interface LaborDemandPlan {
  readonly planId: string;
  readonly productionPlanId: string;
  readonly unitId: ProductionUnitId;
  readonly regionId: RegionId;
  readonly laborCategory: string;
  readonly requestedWorkerEquivalents: number;
  readonly grossWageOffer: number;
  readonly grossPayrollCap: number;
}

interface Phase2LaborDemandAuthorityRecord {
  readonly tick: number;
  readonly world: WorldState;
  readonly laborDemandPlans: readonly LaborDemandPlan[];
}

/** Exact handler-issued provenance for decision-bearing Phase-2 employer labor demand. */
const phase2LaborDemandAuthorities = new WeakMap<
  readonly LaborDemandPlan[],
  Phase2LaborDemandAuthorityRecord
>();

interface CanonicalPhase2ProductionPlanningRecord {
  readonly evidenceFingerprint: string;
  readonly laborDemandPlans: readonly LaborDemandPlan[];
}

/**
 * Exactly one decision-bearing Phase-2 production-planning result is authoritative for
 * an opening WorldState/tick pair. Re-running with equivalent evidence resolves to that
 * same batch; alternate caller-selected evidence cannot mint a second payroll authority.
 */
const canonicalPhase2ProductionPlanningByWorld = new WeakMap<
  WorldState,
  Map<number, CanonicalPhase2ProductionPlanningRecord>
>();

export function requireCanonicalPhase2LaborDemandPlans(
  world: WorldState,
  laborDemandPlans: readonly LaborDemandPlan[],
  currentTick: number,
): void {
  const authority = phase2LaborDemandAuthorities.get(laborDemandPlans);
  if (
    authority === undefined ||
    authority.tick !== currentTick ||
    authority.world !== world ||
    authority.laborDemandPlans !== laborDemandPlans
  ) {
    throw new Error(
      `Phase-2 labor-demand evidence for tick ${currentTick} was not issued by the canonical Phase-2 handler for this WorldState`,
    );
  }
}

/**
 * Read-only Phase-2 evidence whose provenance must be Phase-1/opening/prior-close state.
 * Productivity factors other than condition are supplied explicitly because their later
 * canonical derivation boundaries are not owned by this requirement.
 */
export interface ProductionPlanningEvidence {
  readonly mandatoryKnownCash: number;
  readonly legalMinimumWageFloor: number;
  readonly priorCloseGrossInputPriceByGood: Readonly<Record<GoodId, number>>;
  readonly priorCloseGrossInvestmentPriceByGood?: Readonly<Record<GoodId, number>>;
  readonly infrastructureFactor: number;
  readonly resourceAccessFactor: number;
  readonly healthLaborProductivityFactor?: number;
}

export interface ProductionPlanningResult {
  readonly productionPlan: ProductionPlan;
  readonly laborDemandPlan: LaborDemandPlan;
  readonly inputIntents: readonly MarketIntent[];
  readonly investmentIntents: readonly MarketIntent[];
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

function requireFinite(name: string, value: number): number {
  if (!isFiniteCanonicalNumber(value)) {
    throw new Error(`${name} must be finite, got ${String(value)}`);
  }
  return value;
}

function requireNonNegative(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0) {
    throw new Error(`${name} must be >= 0, got ${String(value)}`);
  }
  return value;
}

function requirePositive(name: string, value: number): number {
  requireFinite(name, value);
  if (value <= 0) {
    throw new Error(`${name} must be > 0, got ${String(value)}`);
  }
  return value;
}

function requirePositiveInteger(name: string, value: number): number {
  requireFinite(name, value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1, got ${String(value)}`);
  }
  return value;
}

function requireRange(name: string, value: number, minimum: number, maximum: number): number {
  requireFinite(name, value);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be in [${minimum}, ${maximum}], got ${String(value)}`);
  }
  return value;
}

function requiredNumber(
  name: string,
  configured: number | undefined,
  canonicalDefault: number | undefined,
): number {
  const value = configured ?? canonicalDefault;
  if (value === undefined) {
    throw new Error(`${name} is required for Phase-2 production planning`);
  }
  return requireFinite(name, value);
}

function orderedRecord(entries: readonly (readonly [GoodId, number])[]): Readonly<Record<GoodId, number>> {
  const record: Record<string, number> = {};
  for (const [goodId, value] of stableOrderBy(entries, ([goodId]) => String(goodId))) {
    record[goodId] = value;
  }
  return record as Readonly<Record<GoodId, number>>;
}

function resolvePlanningConfig(config: SimulationConfig) {
  const defaults = createDefaultSimulationConfig();
  return {
    quantityEpsilon: requirePositive(
      "SimulationConfig.numeric.quantityEpsilon",
      config.numeric.quantityEpsilon ?? defaults.numeric.quantityEpsilon!,
    ),
    moneyEpsilon: requirePositive(
      "SimulationConfig.numeric.moneyEpsilon",
      config.numeric.moneyEpsilon ?? defaults.numeric.moneyEpsilon!,
    ),
    baseTargetUtilization: requiredNumber(
      "ProductionConfig.baseTargetUtilization",
      config.production.baseTargetUtilization,
      defaults.production.baseTargetUtilization,
    ),
    minTargetUtilization: requiredNumber(
      "ProductionConfig.minTargetUtilization",
      config.production.minTargetUtilization,
      defaults.production.minTargetUtilization,
    ),
    maxTargetUtilization: requiredNumber(
      "ProductionConfig.maxTargetUtilization",
      config.production.maxTargetUtilization,
      defaults.production.maxTargetUtilization,
    ),
    marginResponse: requiredNumber(
      "ProductionConfig.marginResponse",
      config.production.marginResponse,
      defaults.production.marginResponse,
    ),
    sellThroughResponse: requiredNumber(
      "ProductionConfig.sellThroughResponse",
      config.production.sellThroughResponse,
      defaults.production.sellThroughResponse,
    ),
    inventoryResponse: requiredNumber(
      "ProductionConfig.inventoryResponse",
      config.production.inventoryResponse,
      defaults.production.inventoryResponse,
    ),
    targetSellThrough: requiredNumber(
      "ProductionConfig.targetSellThrough",
      config.production.targetSellThrough,
      defaults.production.targetSellThrough,
    ),
    outputCoverageTicks: requireNonNegative(
      "ProductionConfig.outputCoverageTicks",
      config.production.outputCoverageTicks ?? defaults.production.outputCoverageTicks!,
    ),
    inputCoverageTicks: requireNonNegative(
      "ProductionConfig.inputCoverageTicks",
      config.production.inputCoverageTicks ?? defaults.production.inputCoverageTicks!,
    ),
    inputSafetyCoverageTicks: requireNonNegative(
      "ProductionConfig.inputSafetyCoverageTicks",
      config.production.inputSafetyCoverageTicks ?? defaults.production.inputSafetyCoverageTicks!,
    ),
    minOperatingCash: requireNonNegative(
      "ProductionConfig.minOperatingCash",
      config.production.minOperatingCash ?? defaults.production.minOperatingCash!,
    ),
    liquidityBufferShare: requireRange(
      "ProductionConfig.liquidityBufferShare",
      config.production.liquidityBufferShare ?? defaults.production.liquidityBufferShare!,
      0,
      1,
    ),
    maxInputCriticality: requirePositive(
      "ProductionConfig.maxInputCriticality",
      config.production.maxInputCriticality ?? defaults.production.maxInputCriticality!,
    ),
    investmentReviewCadenceTicks: requirePositiveInteger(
      "ProductionConfig.investmentReviewCadenceTicks",
      config.production.investmentReviewCadenceTicks ?? defaults.production.investmentReviewCadenceTicks!,
    ),
    investmentUtilizationThreshold: requireRange(
      "ProductionConfig.investmentUtilizationThreshold",
      config.production.investmentUtilizationThreshold ?? defaults.production.investmentUtilizationThreshold!,
      0,
      1,
    ),
    minimumInvestmentMargin: requireFinite(
      "ProductionConfig.minimumInvestmentMargin",
      config.production.minimumInvestmentMargin ?? defaults.production.minimumInvestmentMargin!,
    ),
    investmentPropensity: requireNonNegative(
      "ProductionConfig.investmentPropensity",
      config.production.investmentPropensity ?? defaults.production.investmentPropensity!,
    ),
    maxInvestmentShareOfExcessCash: requireRange(
      "ProductionConfig.maxInvestmentShareOfExcessCash",
      config.production.maxInvestmentShareOfExcessCash ?? defaults.production.maxInvestmentShareOfExcessCash!,
      0,
      1,
    ),
    maxCapitalGrowthPerReview: requireNonNegative(
      "ProductionConfig.maxCapitalGrowthPerReview",
      config.production.maxCapitalGrowthPerReview ?? defaults.production.maxCapitalGrowthPerReview!,
    ),
    startingReferenceWage: requireNonNegative(
      "LaborConfig.startingReferenceWage",
      config.labor.startingReferenceWage ?? defaults.labor.startingReferenceWage!,
    ),
    minimumWorkingHealthFactor: requireNonNegative(
      "LaborConfig.minimumWorkingHealthFactor",
      config.labor.minimumWorkingHealthFactor ?? defaults.labor.minimumWorkingHealthFactor!,
    ),
    maximumWorkingHealthFactor: requirePositive(
      "LaborConfig.maximumWorkingHealthFactor",
      config.labor.maximumWorkingHealthFactor ?? defaults.labor.maximumWorkingHealthFactor!,
    ),
  };
}

/**
 * Construct one unit's Phase-2 plans and INPUT intents from tick-opening state only.
 */
export function planProductionUnitPhase2(args: {
  readonly tick: number;
  readonly unit: ProductionUnitState;
  readonly regionId: RegionId;
  readonly settlementCurrencyId: CurrencyId;
  readonly recipe: RecipeDefinition;
  readonly config: SimulationConfig;
  readonly evidence?: ProductionPlanningEvidence;
}): ProductionPlanningResult {
  const { tick, unit, regionId, settlementCurrencyId, recipe, config } = args;
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Phase-2 planning tick must be a non-negative integer, got ${String(tick)}`);
  }

  const planning = resolvePlanningConfig(config);
  if (planning.minTargetUtilization > planning.maxTargetUtilization) {
    throw new Error("ProductionConfig minTargetUtilization must not exceed maxTargetUtilization");
  }
  if (planning.minimumWorkingHealthFactor > planning.maximumWorkingHealthFactor) {
    throw new Error("LaborConfig minimumWorkingHealthFactor must not exceed maximumWorkingHealthFactor");
  }

  const planId = `production-plan:${tick}:${String(unit.productionUnitId)}`;
  const laborPlanId = `labor-demand-plan:${tick}:${String(unit.productionUnitId)}`;
  const isActive = unit.status === "ACTIVE";

  if (!isActive) {
    const startup = unit.status === "PLANNED"
      ? planPlannedStartupInvestmentPhase2({
          tick,
          unit,
          regionId,
          settlementCurrencyId,
          recipe,
          config,
          ...(args.evidence === undefined
            ? {}
            : {
                evidence: {
                  mandatoryKnownCash: args.evidence.mandatoryKnownCash,
                  priorCloseGrossInvestmentPriceByGood: args.evidence.priorCloseGrossInvestmentPriceByGood,
                },
              }),
        })
      : { investmentIntents: [], investableCash: 0, investmentBudget: 0 };
    const zeroInputs = orderedRecord(
      stableOrderBy(Object.keys(recipe.inputsPerBatch) as GoodId[], String).map((goodId) => [goodId, 0] as const),
    );
    return {
      productionPlan: {
        planId,
        unitId: unit.productionUnitId,
        tick,
        recipeId: recipe.id,
        effectiveCapacityBatches: 0,
        targetUtilization: 0,
        plannedBatches: 0,
        plannedOutputQuantity: 0,
        desiredInputQuantity: zeroInputs,
        openingUsableInputQuantity: orderedRecord(
          stableOrderBy(Object.keys(recipe.inputsPerBatch) as GoodId[], String).map((goodId) => [
            goodId,
            unit.inputInventory.get(goodId) ?? 0,
          ] as const),
        ),
        plannedInputPurchaseQuantity: zeroInputs,
        procurementCashEnvelope: 0,
        grossWageCashEnvelope: 0,
        operatingLiquidityBuffer: 0,
        workingCapitalTarget: 0,
        investableCash: startup.investableCash,
        investmentPressure: 0,
        investmentBudget: startup.investmentBudget,
        laborDemandPlanId: laborPlanId,
        investmentIntentIds: startup.investmentIntents.map((intent) => intent.id),
        inputIntentIds: [],
      },
      laborDemandPlan: {
        planId: laborPlanId,
        productionPlanId: planId,
        unitId: unit.productionUnitId,
        regionId,
        laborCategory: recipe.laborCategory,
        requestedWorkerEquivalents: 0,
        grossWageOffer: 0,
        grossPayrollCap: 0,
      },
      inputIntents: [],
      investmentIntents: startup.investmentIntents,
    };
  }

  const evidence = args.evidence;
  if (evidence === undefined) {
    throw new Error(`ACTIVE ProductionUnit ${String(unit.productionUnitId)} requires Phase-2 planning evidence`);
  }
  const mandatoryKnownCash = requireNonNegative("ProductionPlanningEvidence.mandatoryKnownCash", evidence.mandatoryKnownCash);
  const legalMinimumWageFloor = requireNonNegative(
    "ProductionPlanningEvidence.legalMinimumWageFloor",
    evidence.legalMinimumWageFloor,
  );
  const infrastructureFactor = requireRange(
    "ProductionPlanningEvidence.infrastructureFactor",
    evidence.infrastructureFactor,
    0,
    1,
  );
  const resourceAccessFactor = requireRange(
    "ProductionPlanningEvidence.resourceAccessFactor",
    evidence.resourceAccessFactor,
    0,
    1,
  );
  const healthLaborProductivityFactor = requireRange(
    "ProductionPlanningEvidence.healthLaborProductivityFactor",
    evidence.healthLaborProductivityFactor ?? 1,
    planning.minimumWorkingHealthFactor,
    planning.maximumWorkingHealthFactor,
  );

  const nameplateBatches = deriveNameplateCapacity(unit, recipe);
  const conditionFactor = clamp(requireFinite("ProductionUnit condition", unit.seed.condition), 0, 1);
  const effectiveCapacityBatches =
    nameplateBatches *
    requirePositive("RecipeDefinition.baseThroughputFactor", recipe.baseThroughputFactor) *
    conditionFactor *
    infrastructureFactor *
    resourceAccessFactor *
    healthLaborProductivityFactor;
  requireNonNegative("effectiveCapacityBatches", effectiveCapacityBatches);

  const outputInventory = unit.outputInventory.get(recipe.outputGoodId) ?? 0;
  requireNonNegative(`outputInventory[${String(recipe.outputGoodId)}]`, outputInventory);
  const inventoryTargetOutput = Math.max(
    recipe.outputPerBatch,
    unit.signals.outputSalesEma * planning.outputCoverageTicks,
  );
  const outputInventoryGap = clamp(
    (inventoryTargetOutput - outputInventory) / Math.max(inventoryTargetOutput, planning.quantityEpsilon),
    -1,
    1,
  );
  const rawUtilization =
    planning.baseTargetUtilization +
    planning.marginResponse * unit.signals.marginSignalEma +
    planning.sellThroughResponse * (unit.signals.sellThroughEma - planning.targetSellThrough) +
    planning.inventoryResponse * outputInventoryGap;
  const targetUtilization = clamp(rawUtilization, planning.minTargetUtilization, planning.maxTargetUtilization);
  const plannedBatches = effectiveCapacityBatches * targetUtilization;
  const plannedOutputQuantity = plannedBatches * requirePositive("RecipeDefinition.outputPerBatch", recipe.outputPerBatch);

  const orderedInputGoods = stableOrderBy(Object.keys(recipe.inputsPerBatch) as GoodId[], String);
  const desiredEntries: (readonly [GoodId, number])[] = [];
  const openingEntries: (readonly [GoodId, number])[] = [];
  const purchaseEntries: (readonly [GoodId, number])[] = [];
  const weightEntries: (readonly [GoodId, number])[] = [];
  let desiredInputCost = 0;

  for (const goodId of orderedInputGoods) {
    const inputPerBatch = requireNonNegative(
      `RecipeDefinition.inputsPerBatch[${String(goodId)}]`,
      recipe.inputsPerBatch[goodId] ?? 0,
    );
    const plannedUse = plannedBatches * inputPerBatch;
    const priorUse = requireNonNegative(
      `ProductionSignalState.inputUseEma[${String(goodId)}]`,
      unit.signals.inputUseEma[goodId] ?? 0,
    );
    const safetyUse = priorUse * planning.inputSafetyCoverageTicks;
    const targetClosing = Math.max(plannedUse, safetyUse) * planning.inputCoverageTicks;
    const desiredPosition = plannedUse + targetClosing;
    const openingUsable = requireNonNegative(
      `inputInventory[${String(goodId)}]`,
      unit.inputInventory.get(goodId) ?? 0,
    );
    const plannedPurchase = Math.max(0, desiredPosition - openingUsable);

    desiredEntries.push([goodId, desiredPosition]);
    openingEntries.push([goodId, openingUsable]);
    purchaseEntries.push([goodId, plannedPurchase]);

    if (plannedPurchase > planning.quantityEpsilon) {
      const expectedPriceValue = evidence.priorCloseGrossInputPriceByGood[goodId];
      if (expectedPriceValue === undefined) {
        throw new Error(
          `ProductionPlanningEvidence.priorCloseGrossInputPriceByGood[${String(goodId)}] is required when INPUT procurement is planned`,
        );
      }
      const expectedPrice = requirePositive(
        `ProductionPlanningEvidence.priorCloseGrossInputPriceByGood[${String(goodId)}]`,
        expectedPriceValue,
      );
      const cost = plannedPurchase * expectedPrice;
      desiredInputCost += cost;
      const coverage = openingUsable / Math.max(plannedUse, planning.quantityEpsilon);
      const criticality = clamp(1 / Math.max(coverage, 0.25), 1, planning.maxInputCriticality);
      weightEntries.push([goodId, cost * criticality]);
    }
  }

  const openingHomeCash = requireNonNegative(
    `ProductionUnit wallet[${String(settlementCurrencyId)}]`,
    unit.wallet.get(settlementCurrencyId) ?? 0,
  );
  const operatingLiquidityBuffer = Math.max(
    planning.minOperatingCash,
    planning.liquidityBufferShare * openingHomeCash,
  );
  const unitWageOffer = requireNonNegative(
    "ProductionUnit wageOffer",
    unit.wageOffer,
  );
  const grossWageOffer = Math.max(unitWageOffer, legalMinimumWageFloor);
  const rawLaborDemand = plannedBatches * requireNonNegative("RecipeDefinition.laborPerBatch", recipe.laborPerBatch);
  const cashBeforePayroll = Math.max(0, openingHomeCash - mandatoryKnownCash - operatingLiquidityBuffer);
  const maxAffordableLabor = cashBeforePayroll / Math.max(grossWageOffer, planning.moneyEpsilon);
  const affordableLaborDemand = Math.min(rawLaborDemand, maxAffordableLabor);
  const grossWageCashEnvelope = affordableLaborDemand * grossWageOffer;

  const availableForInputs = Math.max(
    0,
    openingHomeCash - mandatoryKnownCash - operatingLiquidityBuffer - grossWageCashEnvelope,
  );
  const procurementCashEnvelope = Math.min(availableForInputs, desiredInputCost);
  const totalWeight = weightEntries.reduce((sum, [, weight]) => sum + weight, 0);

  const investmentReviewDue = tick > 0 && tick % planning.investmentReviewCadenceTicks === 0;
  const demandPressure = investmentReviewDue
    ? clamp(
        (unit.signals.utilizationEma - planning.investmentUtilizationThreshold) /
          Math.max(1 - planning.investmentUtilizationThreshold, planning.quantityEpsilon),
        -1,
        1,
      )
    : 0;
  const marginPressure = investmentReviewDue
    ? Math.max(0, unit.signals.marginSignalEma - planning.minimumInvestmentMargin)
    : 0;
  const salesPressure = investmentReviewDue
    ? Math.max(0, unit.signals.sellThroughEma - planning.targetSellThrough)
    : 0;
  const investmentPressure = investmentReviewDue
    ? clamp((demandPressure + marginPressure + salesPressure) / 3, 0, 1)
    : 0;
  const workingCapitalTarget =
    mandatoryKnownCash + grossWageCashEnvelope + desiredInputCost + operatingLiquidityBuffer;
  const investableCash = Math.max(0, openingHomeCash - workingCapitalTarget);
  const investmentBudget = investmentReviewDue
    ? investableCash * clamp(
        planning.investmentPropensity * investmentPressure,
        0,
        planning.maxInvestmentShareOfExcessCash,
      )
    : 0;

  const maxDesiredCapitalAddition = unit.installedCapital * planning.maxCapitalGrowthPerReview;
  const capitalAdditionTarget = maxDesiredCapitalAddition * investmentPressure;
  const investmentCostEntries: (readonly [GoodId, number])[] = [];
  const investmentPurchaseEntries: (readonly [GoodId, number])[] = [];
  let totalRequiredInvestmentCost = 0;
  for (const goodId of stableOrderBy(Object.keys(recipe.investmentGoodsPerCapitalUnit) as GoodId[], String)) {
    const unitsPerCapital = requireNonNegative(
      `RecipeDefinition.investmentGoodsPerCapitalUnit[${String(goodId)}]`,
      recipe.investmentGoodsPerCapitalUnit[goodId] ?? 0,
    );
    const requiredQuantity = capitalAdditionTarget * unitsPerCapital;
    const onHand = requireNonNegative(
      `investmentInventory[${String(goodId)}]`,
      unit.investmentInventory.get(goodId) ?? 0,
    );
    const desiredPurchase = Math.max(0, requiredQuantity - onHand);
    investmentPurchaseEntries.push([goodId, desiredPurchase]);
    if (desiredPurchase <= planning.quantityEpsilon) {
      continue;
    }

    const expectedPriceValue = evidence.priorCloseGrossInvestmentPriceByGood?.[goodId];
    if (expectedPriceValue === undefined) {
      throw new Error(
        `ProductionPlanningEvidence.priorCloseGrossInvestmentPriceByGood[${String(goodId)}] is required when INVESTMENT procurement is planned`,
      );
    }
    const expectedPrice = requirePositive(
      `ProductionPlanningEvidence.priorCloseGrossInvestmentPriceByGood[${String(goodId)}]`,
      expectedPriceValue,
    );
    const requiredCost = desiredPurchase * expectedPrice;
    investmentCostEntries.push([goodId, requiredCost]);
    totalRequiredInvestmentCost += requiredCost;
  }

  const investmentIntents: MarketIntent[] = [];
  let allocatedInvestmentSpend = 0;
  for (const [goodId, requiredCost] of stableOrderBy(investmentCostEntries, ([candidate]) => String(candidate))) {
    const desiredQuantity = investmentPurchaseEntries.find(([candidate]) => candidate === goodId)?.[1] ?? 0;
    const proportionalSpend = totalRequiredInvestmentCost > planning.moneyEpsilon
      ? investmentBudget * requiredCost / totalRequiredInvestmentCost
      : 0;
    const remainingInvestmentBudget = Math.max(0, investmentBudget - allocatedInvestmentSpend);
    const maxSpend = Math.min(proportionalSpend, remainingInvestmentBudget);
    allocatedInvestmentSpend += maxSpend;
    const intent: MarketIntent = {
      id: createMarketIntentId(`mi:${tick}:${String(unit.productionUnitId)}:INVESTMENT:${String(goodId)}`),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId },
      regionId,
      goodId,
      side: "BUY",
      purpose: "INVESTMENT",
      desiredQuantity,
      maxSpend,
      sourcePlanId: planId,
      inventoryBucket: "INVESTMENT",
    };
    validateMarketIntent(intent);
    investmentIntents.push(intent);
  }

  const inputIntents: MarketIntent[] = [];
  for (const [goodId, weight] of stableOrderBy(weightEntries, ([goodId]) => String(goodId))) {
    const desiredQuantity = purchaseEntries.find(([candidate]) => candidate === goodId)?.[1] ?? 0;
    if (desiredQuantity <= planning.quantityEpsilon) {
      continue;
    }
    const maxSpend = totalWeight > planning.moneyEpsilon
      ? procurementCashEnvelope * weight / totalWeight
      : 0;
    const intent: MarketIntent = {
      id: createMarketIntentId(`mi:${tick}:${String(unit.productionUnitId)}:INPUT:${String(goodId)}`),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId },
      regionId,
      goodId,
      side: "BUY",
      purpose: "INPUT",
      desiredQuantity,
      maxSpend,
      sourcePlanId: planId,
      inventoryBucket: "INPUT",
    };
    validateMarketIntent(intent);
    inputIntents.push(intent);
  }

  const inputIntentIds = inputIntents.map((intent) => intent.id);
  const investmentIntentIds = investmentIntents.map((intent) => intent.id);
  const productionPlan: ProductionPlan = {
    planId,
    unitId: unit.productionUnitId,
    tick,
    recipeId: recipe.id,
    effectiveCapacityBatches,
    targetUtilization,
    plannedBatches,
    plannedOutputQuantity,
    desiredInputQuantity: orderedRecord(desiredEntries),
    openingUsableInputQuantity: orderedRecord(openingEntries),
    plannedInputPurchaseQuantity: orderedRecord(purchaseEntries),
    procurementCashEnvelope,
    grossWageCashEnvelope,
    operatingLiquidityBuffer,
    workingCapitalTarget,
    investableCash,
    investmentPressure,
    investmentBudget,
    laborDemandPlanId: laborPlanId,
    investmentIntentIds,
    inputIntentIds,
  };
  const laborDemandPlan: LaborDemandPlan = {
    planId: laborPlanId,
    productionPlanId: planId,
    unitId: unit.productionUnitId,
    regionId,
    laborCategory: recipe.laborCategory,
    requestedWorkerEquivalents: affordableLaborDemand,
    grossWageOffer,
    grossPayrollCap: grossWageCashEnvelope,
  };

  return { productionPlan, laborDemandPlan, inputIntents, investmentIntents };
}

function regionForUnit(world: WorldState, unit: ProductionUnitState): RegionState {
  const region = stableOrderBy(world.regions.values(), (candidate) => String(candidate.regionId)).find(
    (candidate) => candidate.seed.key === unit.seed.regionKey,
  );
  if (region === undefined) {
    throw new Error(
      `ProductionUnit ${String(unit.productionUnitId)} references unknown region seed ${unit.seed.regionKey}`,
    );
  }
  return region;
}

function canonicalM4ProductionPolicyEvidence(
  world: WorldState,
  unit: ProductionUnitState,
  region: RegionState,
  recipe: RecipeDefinition,
): Pick<ProductionPlanningEvidence, "mandatoryKnownCash" | "legalMinimumWageFloor"> {
  if (region.controllerStateId === null) {
    // No controller is itself the explicit Phase-1 jurisdiction result: there is no
    // applicable State minimum-wage or mandatory pre-payroll-cash rule in M4.
    return { mandatoryKnownCash: 0, legalMinimumWageFloor: 0 };
  }

  const controller = world.states.get(region.controllerStateId);
  if (controller === undefined) {
    throw new Error(
      `Canonical Phase-2 planning Region ${String(region.regionId)} references missing controller State ${String(region.controllerStateId)}`,
    );
  }
  const policy = controller.seed.policy.m4ProductionPlanning;
  if (policy === undefined) {
    throw new Error(
      `Canonical Phase-2 planning requires an explicit M4 production-planning policy fixture for controlled Region ${String(region.regionId)}`,
    );
  }

  const regionalMinimumWage = policy.minimumWageFloorByRegionKey[region.seed.key]?.[recipe.laborCategory] ?? 0;
  const mandatoryKnownCash = policy.mandatoryKnownCashByProductionUnitKey[unit.seed.key] ?? 0;
  return {
    mandatoryKnownCash: requireNonNegative(
      `StatePolicySeed.m4ProductionPlanning.mandatoryKnownCashByProductionUnitKey[${unit.seed.key}]`,
      mandatoryKnownCash,
    ),
    legalMinimumWageFloor: requireNonNegative(
      `StatePolicySeed.m4ProductionPlanning.minimumWageFloorByRegionKey[${region.seed.key}][${recipe.laborCategory}]`,
      regionalMinimumWage,
    ),
  };
}

function normalizedEvidenceRecord(
  record: Readonly<Record<GoodId, number>> | undefined,
): readonly (readonly [string, number])[] | null {
  if (record === undefined) return null;
  return stableOrderBy(
    Object.entries(record) as [string, number][],
    ([goodId]) => goodId,
  ).map(([goodId, value]) => [goodId, value] as const);
}

/**
 * Stable fingerprint of every decision-bearing external input consumed by the Phase-2
 * production planner for live units. This is intentionally content-based rather than
 * Map/object identity based: equivalent replays are harmless, while a second invocation
 * that changes cash, policy, prices or physical productivity evidence is not authority.
 */
function productionPlanningEvidenceFingerprint(
  world: WorldState,
  evidenceByUnit: ReadonlyMap<ProductionUnitId, ProductionPlanningEvidence>,
): string {
  return JSON.stringify(
    stableOrderBy(world.productionUnits.values(), (unit) => String(unit.productionUnitId)).map((unit) => {
      const evidence = evidenceByUnit.get(unit.productionUnitId);
      if (evidence === undefined) {
        return { unitId: String(unit.productionUnitId), evidence: null };
      }
      return {
        unitId: String(unit.productionUnitId),
        evidence: {
          mandatoryKnownCash: evidence.mandatoryKnownCash,
          legalMinimumWageFloor: evidence.legalMinimumWageFloor,
          priorCloseGrossInputPriceByGood: normalizedEvidenceRecord(evidence.priorCloseGrossInputPriceByGood),
          priorCloseGrossInvestmentPriceByGood: normalizedEvidenceRecord(
            evidence.priorCloseGrossInvestmentPriceByGood,
          ),
          infrastructureFactor: evidence.infrastructureFactor,
          resourceAccessFactor: evidence.resourceAccessFactor,
          healthLaborProductivityFactor: evidence.healthLaborProductivityFactor ?? null,
        },
      };
    }),
  );
}

function canonicalPhase2ProductionPlanningEvidence(
  world: WorldState,
  unit: ProductionUnitState,
  region: RegionState,
  recipe: RecipeDefinition,
): ProductionPlanningEvidence {
  const localMarkets = stableOrderBy(
    [...world.markets.values()].filter((market) => market.seed.regionKey === region.seed.key),
    (market) => String(market.marketId),
  );
  if (localMarkets.length !== 1) {
    throw new Error(
      `Canonical Phase-2 planning requires exactly one local market for Region ${String(region.regionId)}, got ${localMarkets.length}`,
    );
  }
  const localMarket = localMarkets[0]!;
  const priceRecord = (goodIds: readonly GoodId[]): Readonly<Record<GoodId, number>> => {
    const result: Record<string, number> = {};
    for (const goodId of stableOrderBy(goodIds, String)) {
      const price = localMarket.priceByGood.get(String(goodId));
      if (price === undefined) {
        throw new Error(
          `Canonical Phase-2 planning is missing prior-close local price for ${String(goodId)} in Region ${String(region.regionId)}`,
        );
      }
      result[goodId] = requirePositive(
        `LocalMarket prior-close price[${String(goodId)}]`,
        price,
      );
    }
    return result as Readonly<Record<GoodId, number>>;
  };

  const infrastructureFactor = recipe.infrastructureCategory === undefined
    ? 1
    : requireRange(
        `Region infrastructure[${recipe.infrastructureCategory}]`,
        region.seed.infrastructure[recipe.infrastructureCategory] ?? 0,
        0,
        1,
      );
  const resourceAccessFactor = recipe.extractionResourceId === undefined
    ? 1
    : (() => {
        const deposit = region.seed.deposits.find(
          (candidate) => candidate.resourceId === recipe.extractionResourceId,
        );
        return deposit?.initiallyKnown === true &&
          (region.resourceDeposits.get(recipe.extractionResourceId) ?? 0) > 0
          ? 1
          : 0;
      })();

  const m4Policy = canonicalM4ProductionPolicyEvidence(world, unit, region, recipe);

  return {
    mandatoryKnownCash: m4Policy.mandatoryKnownCash,
    legalMinimumWageFloor: m4Policy.legalMinimumWageFloor,
    priorCloseGrossInputPriceByGood: priceRecord(
      Object.keys(recipe.inputsPerBatch) as GoodId[],
    ),
    priorCloseGrossInvestmentPriceByGood: priceRecord(
      Object.keys(recipe.investmentGoodsPerCapitalUnit) as GoodId[],
    ),
    infrastructureFactor,
    resourceAccessFactor,
    // The production contract explicitly defines 1 as the default until a Population-owned
    // health productivity factor is wired into the canonical tick.
    healthLaborProductivityFactor: 1,
  };
}

function sameLaborDemandBatch(
  left: readonly LaborDemandPlan[],
  right: readonly LaborDemandPlan[],
): boolean {
  return left.length === right.length && left.every((candidate, index) => {
    const other = right[index];
    return other !== undefined &&
      candidate.planId === other.planId &&
      candidate.productionPlanId === other.productionPlanId &&
      candidate.unitId === other.unitId &&
      candidate.regionId === other.regionId &&
      candidate.laborCategory === other.laborCategory &&
      candidate.requestedWorkerEquivalents === other.requestedWorkerEquivalents &&
      candidate.grossWageOffer === other.grossWageOffer &&
      candidate.grossPayrollCap === other.grossPayrollCap;
  });
}

/**
 * Build a real Phase-2 handler from a prior-close evidence snapshot. The snapshot is keyed
 * by persistent ProductionUnitId and captured outside TickContext, so market allocations or
 * transactions accumulated later in the same tick cannot become financing inputs.
 */
function createPhase2ProductionPlanningHandlerInternal(
  options: { readonly evidenceByUnit: ReadonlyMap<ProductionUnitId, ProductionPlanningEvidence> } | undefined,
  authoritative: boolean,
): PhaseHandler {
  return (world: WorldState, context: TickContext, _pendingTransitions: PendingTransitions): TickContext => {
    if (context.phase !== 2) {
      return context;
    }

    const productionPlans: ProductionPlan[] = [];
    const laborDemandPlans: LaborDemandPlan[] = [];
    const productionMarketIntents: MarketIntent[] = [];
    const resolvedEvidenceByUnit = new Map<ProductionUnitId, ProductionPlanningEvidence>();
    let budgetLedger = context.budgetLedger;

    for (const unit of stableOrderBy(world.productionUnits.values(), (candidate) => String(candidate.productionUnitId))) {
      const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
      if (recipe === undefined) {
        throw new Error(
          `ProductionUnit ${String(unit.productionUnitId)} references unknown recipe ${unit.seed.recipeId}`,
        );
      }
      const region = regionForUnit(world, unit);
      const planningEvidence = authoritative
        ? canonicalPhase2ProductionPlanningEvidence(world, unit, region, recipe)
        : options?.evidenceByUnit.get(unit.productionUnitId);
      if (planningEvidence !== undefined) {
        resolvedEvidenceByUnit.set(unit.productionUnitId, planningEvidence);
      }
      const result = planProductionUnitPhase2({
        tick: context.tick,
        unit,
        regionId: region.regionId,
        settlementCurrencyId: region.settlementCurrencyId,
        recipe,
        config: world.simulationConfig,
        ...(planningEvidence === undefined ? {} : { evidence: planningEvidence }),
      });

      for (const intent of result.inputIntents) {
        const maxSpend = intent.maxSpend;
        if (maxSpend === undefined) {
          throw new Error(`Phase-2 INPUT intent ${String(intent.id)} is missing maxSpend`);
        }
        const committed = commitBudget(
          budgetLedger,
          intent.actor,
          region.settlementCurrencyId,
          result.productionPlan.planId,
          maxSpend,
          result.productionPlan.procurementCashEnvelope,
        );
        if (typeof committed === "string") {
          throw new Error(`Phase-2 INPUT budget commitment failed for ${String(intent.id)}: ${committed}`);
        }
        budgetLedger = committed;
      }

      const investmentEnvelope = `${result.productionPlan.planId}:INVESTMENT`;
      for (const intent of result.investmentIntents) {
        const maxSpend = intent.maxSpend;
        if (maxSpend === undefined) {
          throw new Error(`Phase-2 INVESTMENT intent ${String(intent.id)} is missing maxSpend`);
        }
        const committed = commitBudget(
          budgetLedger,
          intent.actor,
          region.settlementCurrencyId,
          investmentEnvelope,
          maxSpend,
          result.productionPlan.investmentBudget,
        );
        if (typeof committed === "string") {
          throw new Error(`Phase-2 INVESTMENT budget commitment failed for ${String(intent.id)}: ${committed}`);
        }
        budgetLedger = committed;
      }

      productionPlans.push(result.productionPlan);
      laborDemandPlans.push(result.laborDemandPlan);
      productionMarketIntents.push(...result.inputIntents, ...result.investmentIntents);
    }

    const proposedLaborDemandPlans = Object.freeze(
      laborDemandPlans.map((plan) => Object.freeze({ ...plan })),
    );

    // A caller-supplied evidence map is useful for pure planning/tests, but it is never
    // payroll authority. Only the fixed canonical planner below may register a demand batch;
    // its decision-bearing evidence is derived from the opening WorldState rather than from
    // whichever public executeTick/executePhase invocation happened to arrive first.
    if (!authoritative) {
      return {
        ...context,
        budgetLedger,
        productionPlans,
        laborDemandPlans: proposedLaborDemandPlans,
        productionMarketIntents,
      };
    }

    const evidenceFingerprint = productionPlanningEvidenceFingerprint(world, resolvedEvidenceByUnit);
    let authorityByTick = canonicalPhase2ProductionPlanningByWorld.get(world);
    if (authorityByTick === undefined) {
      authorityByTick = new Map();
      canonicalPhase2ProductionPlanningByWorld.set(world, authorityByTick);
    }

    const existingAuthority = authorityByTick.get(context.tick);
    let canonicalLaborDemandPlans = proposedLaborDemandPlans;
    if (existingAuthority === undefined) {
      authorityByTick.set(context.tick, {
        evidenceFingerprint,
        laborDemandPlans: proposedLaborDemandPlans,
      });
    } else {
      if (existingAuthority.evidenceFingerprint !== evidenceFingerprint) {
        throw new Error(
          `Phase-2 production-planning authority for tick ${context.tick} already exists for this WorldState; alternate same-world/tick planning evidence is not authoritative`,
        );
      }
      if (!sameLaborDemandBatch(existingAuthority.laborDemandPlans, proposedLaborDemandPlans)) {
        throw new Error(
          `Phase-2 production-planning authority for tick ${context.tick} changed under identical authoritative evidence`,
        );
      }
      canonicalLaborDemandPlans = existingAuthority.laborDemandPlans;
    }

    phase2LaborDemandAuthorities.set(canonicalLaborDemandPlans, {
      tick: context.tick,
      world,
      laborDemandPlans: canonicalLaborDemandPlans,
    });

    return {
      ...context,
      budgetLedger,
      productionPlans,
      laborDemandPlans: canonicalLaborDemandPlans,
      productionMarketIntents,
    };
  };
}

/**
 * Pure/planning entry point. Caller-supplied evidence can never mint payroll authority,
 * even when this handler is invoked through executeTick().
 */
export function createPhase2ProductionPlanningHandler(options: {
  readonly evidenceByUnit: ReadonlyMap<ProductionUnitId, ProductionPlanningEvidence>;
}): PhaseHandler {
  return createPhase2ProductionPlanningHandlerInternal(options, false);
}

/**
 * Canonical M4 Phase-2 payroll-driving planner. Its evidence is derived from the exact
 * opening WorldState, so calling executeTick() with a different public planner cannot win
 * an authority race by choosing alternate productivity/policy/price inputs.
 */
export function createCanonicalPhase2ProductionPlanningHandler(): PhaseHandler {
  return createPhase2ProductionPlanningHandlerInternal(undefined, true);
}
