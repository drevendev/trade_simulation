/**
 * Bounded Phase-2 startup investment planning for PLANNED ProductionUnits.
 *
 * Startup buys real investment goods with opening unit cash only. It never creates labor
 * demand, INPUT procurement, capital, credit or owner funding; Phase 12 remains the sole
 * converter from INVESTMENT inventory to installed capital.
 */
import type { RecipeDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId, RegionId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import {
  createMarketIntentId,
  validateMarketIntent,
  type MarketIntent,
} from "./marketIntent";
import type { ProductionUnitState } from "./worldState";

export interface PlannedStartupPlanningEvidence {
  readonly mandatoryKnownCash: number;
  readonly priorCloseGrossInvestmentPriceByGood?: Readonly<Record<GoodId, number>>;
}

export interface PlannedStartupInvestmentResult {
  readonly investmentIntents: readonly MarketIntent[];
  readonly investableCash: number;
  readonly investmentBudget: number;
}

function requireFinite(name: string, value: number): number {
  if (!isFiniteCanonicalNumber(value)) throw new Error(`${name} must be finite, got ${String(value)}`);
  return value;
}

function requireNonNegative(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0) throw new Error(`${name} must be >= 0, got ${String(value)}`);
  return value;
}

function requirePositive(name: string, value: number): number {
  requireFinite(name, value);
  if (value <= 0) throw new Error(`${name} must be > 0, got ${String(value)}`);
  return value;
}

/** Plan startup INVESTMENT intents for a PLANNED unit from tick-opening stocks only. */
export function planPlannedStartupInvestmentPhase2(args: {
  readonly tick: number;
  readonly unit: ProductionUnitState;
  readonly regionId: RegionId;
  readonly settlementCurrencyId: CurrencyId;
  readonly recipe: RecipeDefinition;
  readonly config: SimulationConfig;
  readonly evidence?: PlannedStartupPlanningEvidence;
}): PlannedStartupInvestmentResult {
  const { tick, unit, regionId, settlementCurrencyId, recipe, config, evidence } = args;
  if (unit.status !== "PLANNED") {
    return { investmentIntents: [], investableCash: 0, investmentBudget: 0 };
  }
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`PLANNED startup tick must be a non-negative integer, got ${String(tick)}`);
  }

  const defaults = createDefaultSimulationConfig();
  const quantityEpsilon = requirePositive(
    "NumericConfig.quantityEpsilon",
    config.numeric.quantityEpsilon ?? defaults.numeric.quantityEpsilon!,
  );
  const moneyEpsilon = requirePositive(
    "NumericConfig.moneyEpsilon",
    config.numeric.moneyEpsilon ?? defaults.numeric.moneyEpsilon!,
  );
  const minOperatingCash = requireNonNegative(
    "ProductionConfig.minOperatingCash",
    config.production.minOperatingCash ?? defaults.production.minOperatingCash!,
  );
  const liquidityBufferShare = requireNonNegative(
    "ProductionConfig.liquidityBufferShare",
    config.production.liquidityBufferShare ?? defaults.production.liquidityBufferShare!,
  );
  const investmentReviewCadenceTicks = requirePositive(
    "ProductionConfig.investmentReviewCadenceTicks",
    config.production.investmentReviewCadenceTicks ?? defaults.production.investmentReviewCadenceTicks!,
  );
  if (!Number.isInteger(investmentReviewCadenceTicks)) {
    throw new Error(
      `ProductionConfig.investmentReviewCadenceTicks must be an integer, got ${String(investmentReviewCadenceTicks)}`,
    );
  }
  if (liquidityBufferShare > 1) {
    throw new Error(`ProductionConfig.liquidityBufferShare must be <= 1, got ${liquidityBufferShare}`);
  }

  if (tick === 0 || tick % investmentReviewCadenceTicks !== 0) {
    return { investmentIntents: [], investableCash: 0, investmentBudget: 0 };
  }

  const minimumStartupCapital = requireNonNegative(
    `Recipe ${recipe.id} minimumStartupCapital`,
    recipe.minimumStartupCapital,
  );
  const installedCapital = requireNonNegative(
    `ProductionUnit ${String(unit.productionUnitId)} installedCapital`,
    unit.installedCapital,
  );
  const depreciationRate = requireNonNegative(
    `Recipe ${recipe.id} depreciationRate`,
    recipe.depreciationRate,
  );
  if (depreciationRate >= 1 && minimumStartupCapital > quantityEpsilon) {
    throw new Error(
      `Recipe ${recipe.id} depreciationRate must be < 1 for finite PLANNED startup capital`,
    );
  }
  // Phase 12 depreciates post-formation capital in the same tick. Startup procurement must
  // therefore target the pre-depreciation stock that leaves minimumStartupCapital alive
  // after that canonical transition; otherwise a PLANNED unit can buy a full nominal
  // startup bundle forever and still fail its Phase-14 readiness gate.
  const requiredPreDepreciationCapital =
    depreciationRate >= 1 ? 0 : minimumStartupCapital / (1 - depreciationRate);
  const capitalGap = Math.max(0, requiredPreDepreciationCapital - installedCapital);
  if (capitalGap <= quantityEpsilon) {
    return { investmentIntents: [], investableCash: 0, investmentBudget: 0 };
  }

  const openingCash = requireNonNegative(
    `ProductionUnit wallet[${String(settlementCurrencyId)}]`,
    unit.wallet.get(settlementCurrencyId) ?? 0,
  );
  const mandatoryKnownCash = requireNonNegative(
    "PlannedStartupPlanningEvidence.mandatoryKnownCash",
    evidence?.mandatoryKnownCash ?? 0,
  );
  const operatingReserve = Math.max(minOperatingCash, openingCash * liquidityBufferShare);
  const investableCash = Math.max(0, openingCash - mandatoryKnownCash - operatingReserve);

  const requirements: {
    readonly goodId: GoodId;
    readonly desiredQuantity: number;
    readonly expectedPrice: number;
    readonly requiredCost: number;
  }[] = [];
  let totalRequiredCost = 0;
  for (const [goodId, coefficientValue] of stableOrderBy(
    Object.entries(recipe.investmentGoodsPerCapitalUnit) as [GoodId, number][],
    ([goodId]) => String(goodId),
  )) {
    const coefficient = requirePositive(
      `Recipe ${recipe.id} investmentGoodsPerCapitalUnit[${String(goodId)}]`,
      coefficientValue,
    );
    const onHand = requireNonNegative(
      `ProductionUnit INVESTMENT[${String(goodId)}]`,
      unit.investmentInventory.get(goodId) ?? 0,
    );
    const desiredQuantity = Math.max(0, capitalGap * coefficient - onHand);
    if (desiredQuantity <= quantityEpsilon) continue;
    const expectedPriceValue = evidence?.priorCloseGrossInvestmentPriceByGood?.[goodId];
    if (expectedPriceValue === undefined) {
      throw new Error(
        `PLANNED startup requires prior-close INVESTMENT price for ${String(goodId)}`,
      );
    }
    const expectedPrice = requirePositive(
      `PlannedStartupPlanningEvidence.priorCloseGrossInvestmentPriceByGood[${String(goodId)}]`,
      expectedPriceValue,
    );
    const requiredCost = desiredQuantity * expectedPrice;
    totalRequiredCost += requiredCost;
    requirements.push({ goodId, desiredQuantity, expectedPrice, requiredCost });
  }

  const investmentBudget = Math.min(investableCash, totalRequiredCost);
  const intents: MarketIntent[] = [];
  let allocatedSpend = 0;
  for (const requirement of requirements) {
    const proportionalSpend = totalRequiredCost > moneyEpsilon
      ? investmentBudget * requirement.requiredCost / totalRequiredCost
      : 0;
    const maxSpend = Math.min(proportionalSpend, Math.max(0, investmentBudget - allocatedSpend));
    allocatedSpend += maxSpend;
    const intent: MarketIntent = {
      id: createMarketIntentId(
        `mi:${tick}:${String(unit.productionUnitId)}:INVESTMENT:${String(requirement.goodId)}`,
      ),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId },
      regionId,
      goodId: requirement.goodId,
      side: "BUY",
      purpose: "INVESTMENT",
      desiredQuantity: requirement.desiredQuantity,
      maxSpend,
      sourcePlanId: `production-plan:${tick}:${String(unit.productionUnitId)}`,
      inventoryBucket: "INVESTMENT",
    };
    validateMarketIntent(intent);
    intents.push(intent);
  }

  return {
    investmentIntents: intents,
    investableCash,
    investmentBudget,
  };
}
