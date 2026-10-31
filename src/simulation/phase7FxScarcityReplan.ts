/**
 * M5 / #673: pure, bounded Phase-7 FX scarcity replanning input.
 *
 * This only narrows an existing tick-local output promise; it neither mints an
 * FX reservation nor reuses a partially funded lot as a dispatch receipt.
 * Callers must rerun canonical actor matching and ACTUAL lot quotation before
 * strict reservation/atomic settlement.
 */
import type { Phase7FxScarcityCaps } from "./phase7AutoFxReservations";
import type { Phase7LiveWorldPlanInput } from "./phase7LiveWorldPlan";

/**
 * Strict decrease of at least one already-authorized pair/currency cap is
 * required. An unchanged result would cause an infinite retry, while a new
 * key would silently create currency authority not present in Phase-7 input.
 */
export function reducePhase7LiveFxBudgetCaps(
  input: Phase7LiveWorldPlanInput,
  scarcity: Phase7FxScarcityCaps,
): Phase7LiveWorldPlanInput {
  if (!scarcity.requiresShrink || scarcity.reducedOutputByPairCurrency.size === 0) {
    throw new Error("Phase-7 FX scarcity replan has no smaller output cap");
  }
  const remaining = new Map(input.fxOutputByPairCurrency);
  let changed = false;
  for (const [key, limit] of [...scarcity.reducedOutputByPairCurrency].sort(
    ([a], [b]) => a < b ? -1 : a > b ? 1 : 0,
  )) {
    const previous = remaining.get(key);
    if (previous === undefined || !Number.isFinite(previous) || previous < 0 ||
        !Number.isFinite(limit) || limit < 0 || limit >= previous) {
      throw new Error("Phase-7 FX scarcity replan cannot reduce authorized output");
    }
    remaining.set(key, limit);
    changed = true;
  }
  if (!changed) {
    throw new Error("Phase-7 FX scarcity replan made no progress");
  }
  return { ...input, fxOutputByPairCurrency: remaining };
}
