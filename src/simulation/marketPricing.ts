/**
 * Phase-6 price formation for local markets (REQ-MARKET-002).
 *
 * Implements bounded log-space repricing using persistent market expectations
 * and configured market parameters.
 */

import type { WorldState, MarketExpectationState } from "./worldState";
import { assertFiniteCanonicalNumber } from "../domain/numeric";

/**
 * Calculate market pressure from excess demand/supply and inventory gap.
 * Returns pressure value clamped to [-1, 1].
 */
export function calculateMarketPressure(
  excessRatio: number,
  inventoryGapRatio: number,
  shortageSignalWeight: number,
  inventorySignalWeight: number,
): number {
  const pressure = shortageSignalWeight * excessRatio + inventorySignalWeight * inventoryGapRatio;
  return pressure;
}

/**
 * Calculate log-space price change bounded by maximum move per tick.
 * Returns the log change clamped to [-maxLogPriceStep, +maxLogPriceStep].
 */
export function calculateLogPriceChange(
  pressure: number,
  basePriceAdjustmentSpeed: number,
  maxAbsoluteLogPriceMovePerTick: number,
): number {
  const logChange = basePriceAdjustmentSpeed * pressure;
  return Math.max(-maxAbsoluteLogPriceMovePerTick, Math.min(maxAbsoluteLogPriceMovePerTick, logChange));
}

/**
 * Apply log-space change to price and enforce price bounds.
 * Returns new price clamped to [minPrice, maxPrice].
 */
export function applyLogPriceChange(
  oldPrice: number,
  logChange: number,
  minPrice: number,
  maxPrice: number,
): number {
  const newPrice = oldPrice * Math.exp(logChange);
  return Math.max(minPrice, Math.min(maxPrice, newPrice));
}

/**
 * Phase-6 price formation: bounded log-space repricing using demand/supply pressure and inventory gaps.
 *
 * For active market m and good g:
 * - If effectiveDemand ≈ 0 and sellable ≈ 0, price unchanged
 * - Otherwise, calculate pressure = wExcess × excess + wInventory × inventoryGap
 * - Apply bounded log-space adjustment: price_new = price_old × exp(logChange)
 * - Enforce price floor/ceiling bounds
 *
 * Returns updated price, or original price if no change needed.
 */
export function repriceGoodInPhase6(
  currentPrice: number,
  effectiveDemand: number,
  sellableSupply: number,
  marketFacingStock: number,
  currentExpectation: MarketExpectationState,
  quantityEpsilon: number,
  config: {
    readonly shortageSignalWeight: number;
    readonly inventorySignalWeight: number;
    readonly basePriceAdjustmentSpeed: number;
    readonly maxAbsoluteLogPriceMovePerTick: number;
    readonly targetInventoryCoverageTicks: number;
    readonly minimumPrice: number;
    readonly maximumPrice: number;
  },
): number {
  const D = effectiveDemand;
  const S = sellableSupply;
  const V = Math.max(D + S, quantityEpsilon);

  // If market is empty, price unchanged per spec
  if (D <= quantityEpsilon && S <= quantityEpsilon) {
    return currentPrice;
  }

  // Calculate excess ratio
  const excessRatio = Math.max(-1, Math.min(1, (D - S) / V));

  // Calculate expected use based on observation history
  const expectedUse = currentExpectation.observationCount === 0
    ? Math.max(D, quantityEpsilon)
    : Math.max(currentExpectation.expectedUseEma, quantityEpsilon);

  // Calculate inventory coverage and gap
  const inventoryCoverage = marketFacingStock / expectedUse;
  const targetCoverage = config.targetInventoryCoverageTicks;
  const inventoryGapRatio = Math.max(-1, Math.min(1, (targetCoverage - inventoryCoverage) / Math.max(targetCoverage, quantityEpsilon)));

  // Calculate pressure and log change
  const pressure = calculateMarketPressure(
    excessRatio,
    inventoryGapRatio,
    config.shortageSignalWeight,
    config.inventorySignalWeight,
  );

  const logChange = calculateLogPriceChange(
    pressure,
    config.basePriceAdjustmentSpeed,
    config.maxAbsoluteLogPriceMovePerTick,
  );

  // Apply log change and enforce bounds
  const newPrice = applyLogPriceChange(currentPrice, logChange, config.minimumPrice, config.maximumPrice);

  return newPrice;
}

/**
 * Update market expectations after Phase-8 MAIN clearing.
 * Returns updated MarketExpectationState with new EMA values.
 *
 * If both effectiveDemandQuantity ≤ quantityEpsilon and offeredQuantity ≤ quantityEpsilon,
 * no observation occurred; expectations remain unchanged.
 *
 * Otherwise, compute observed use, shortage/surplus rates, and update EMAs:
 * - If observationCount == 0: initialize EMAs directly
 * - Otherwise: apply alpha-weighted exponential moving average
 */
export function updateMarketExpectations(
  currentExpectation: MarketExpectationState,
  effectiveDemandQuantity: number,
  offeredQuantity: number,
  clearedQuantity: number,
  quantityEpsilon: number,
  expectationAlpha: number,
): MarketExpectationState {
  // No information if both demand and supply are near-zero
  if (effectiveDemandQuantity <= quantityEpsilon && offeredQuantity <= quantityEpsilon) {
    return currentExpectation;
  }

  const observedUse = effectiveDemandQuantity;
  const unmet = Math.max(0, effectiveDemandQuantity - clearedQuantity);
  const unsold = Math.max(0, offeredQuantity - clearedQuantity);
  const shortageRate = effectiveDemandQuantity > quantityEpsilon ? unmet / effectiveDemandQuantity : 0;
  const surplusRate = offeredQuantity > quantityEpsilon ? unsold / offeredQuantity : 0;

  if (currentExpectation.observationCount === 0) {
    // Initialize EMAs directly on first observation
    return {
      observationCount: 1,
      expectedUseEma: observedUse,
      shortageEma: shortageRate,
      surplusEma: surplusRate,
      lastEffectiveDemand: effectiveDemandQuantity,
      lastOfferedQuantity: offeredQuantity,
      lastClearedQuantity: clearedQuantity,
    };
  }

  // Update with alpha-weighted moving average
  const newExpectedUseEma = expectationAlpha * observedUse + (1 - expectationAlpha) * currentExpectation.expectedUseEma;
  const newShortageEma = expectationAlpha * shortageRate + (1 - expectationAlpha) * currentExpectation.shortageEma;
  const newSurplusEma = expectationAlpha * surplusRate + (1 - expectationAlpha) * currentExpectation.surplusEma;

  return {
    observationCount: currentExpectation.observationCount + 1,
    expectedUseEma: newExpectedUseEma,
    shortageEma: newShortageEma,
    surplusEma: newSurplusEma,
    lastEffectiveDemand: effectiveDemandQuantity,
    lastOfferedQuantity: offeredQuantity,
    lastClearedQuantity: clearedQuantity,
  };
}
