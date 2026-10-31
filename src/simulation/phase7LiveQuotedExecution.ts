/**
 * M5 / #673: live actual-lot quotation -> existing atomic mixed dispatcher.
 *
 * Only the Phase-7 WorldState and current frozen Phase-1/6/7 evidence own
 * settlement pricing. Earlier prepared mixed execution accepted independently
 * supplied per-plan fee/tax terms; this opt-in entry point derives those terms
 * from actual owner-matched lot quantities instead. Caller still supplies the
 * current committed journal, directed-link residual capacity and separately
 * owned per-lot FX reservations, which the physical dispatcher revalidates.
 *
 * A legacy per-plan execution API cannot represent different effective unit
 * charges for two lots on the same route. In that case refuse before any
 * dispatch, rather than round one lot's charge into another's payment.
 */
import type {
  Phase7LivePricingContext, Phase7LiveWorldPlanInput,
} from "./phase7LiveWorldPlan";
import { buildPhase7LiveWorldPlanInput } from "./phase7LiveWorldPlan";
import { quotePhase7ActualMatchedLots } from "./phase7ActualLotQuote";
import {
  executePreparedMixedCurrencyTradePlan,
  type Phase7PreparedFxExecutionResult,
  type Phase7PreparedMixedExecutionInput,
  type Phase7FxPriceTerms,
} from "./phase7PreparedFxExecution";
import type { Phase7SameCurrencyPriceTerms } from "./phase7PreparedSameCurrencyExecution";
import type { WorldState } from "./worldState";

/** Prices, matched owners and tick are deliberately NOT caller inputs. */
export type Phase7LiveQuotedExecutionState = Omit<
  Phase7PreparedMixedExecutionInput,
  "tick" | "planInput" | "termsByTradePlanId" | "sameCurrencyTermsByTradePlanId"
>;

function requireEqualRate(a: number, b: number, epsilon: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= Math.min(
      epsilon, 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)),
    );
}

function checkSameTerms(
  previous: Phase7SameCurrencyPriceTerms,
  next: Phase7SameCurrencyPriceTerms,
  epsilon: number,
): void {
  if (!requireEqualRate(previous.sellerNetUnitPrice, next.sellerNetUnitPrice, epsilon) ||
      !requireEqualRate(previous.transportFeePerUnitDest, next.transportFeePerUnitDest, epsilon) ||
      !requireEqualRate(previous.tariffPerUnitDest, next.tariffPerUnitDest, epsilon) ||
      !requireEqualRate(previous.consumptionTaxPerUnitDest, next.consumptionTaxPerUnitDest, epsilon)) {
    throw new Error("Phase-7 live actual-lot domestic route has inconsistent per-lot price terms");
  }
}

function checkFxTerms(
  previous: Phase7FxPriceTerms,
  next: Phase7FxPriceTerms,
  epsilon: number,
): void {
  checkSameTerms(
    { sellerNetUnitPrice: previous.sourceSellerNetUnitPrice, ...previous },
    { sellerNetUnitPrice: next.sourceSellerNetUnitPrice, ...next },
    epsilon,
  );
}

/**
 * Quote every accepted match at its ACTUAL quantity, then use only these
 * quotes as the frozen terms for the existing fail-atomic mixed executor.
 * Failed quotes and mismatched policy/jurisdiction never expose any staged
 * WorldState, money, shipment, journal or Phase-8 residual.
 *
 * FX reservation creation is intentionally outside this function. That
 * reservation is a distinct tick-local owner; this function does not mint
 * or silently reconstruct FX promises.
 */
export function executePhase7LiveQuotedMixedTradePlan(
  world: WorldState,
  context: Phase7LivePricingContext,
  input: Phase7LiveWorldPlanInput,
  state: Phase7LiveQuotedExecutionState,
): Phase7PreparedFxExecutionResult {
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 ||
      context.phase !== 7 ||
      !(context.effectiveJurisdictionByRegion instanceof Map)) {
    throw new Error("Phase-7 live actual-lot execution requires current tick and jurisdiction");
  }
  const current = context.effectiveJurisdictionByRegion;
  const supplied = state.effectiveJurisdictionByRegion;
  if (!(supplied instanceof Map) || supplied.size !== current.size ||
      [...current].some(([regionId, controller]) =>
        !supplied.has(regionId) || supplied.get(regionId) !== controller)) {
    throw new Error("Phase-7 live actual-lot execution cannot replace current Phase-1 jurisdiction");
  }

  // Both functions reconstruct from the SAME live WorldState/context and do
  // not mutate it. The returned planInput is never supplied by the caller.
  const quoted = quotePhase7ActualMatchedLots(world, context, input);
  const trustedPlanInput = buildPhase7LiveWorldPlanInput(world, context, input);
  const candidates = new Map(
    quoted.preparedPlan.rankedCandidates.map(candidate =>
      [candidate.tradePlanId, candidate] as const),
  );
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  if (moneyEpsilon === undefined || !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0) {
    throw new Error("Phase-7 live actual-lot execution needs resolved money precision");
  }
  const domestic = new Map<string, Phase7SameCurrencyPriceTerms>();
  const foreign = new Map<string, Phase7FxPriceTerms>();
  for (const quote of quoted.quotes) {
    const candidate = candidates.get(quote.lot.tradePlanId);
    const quantity = quote.lot.quantity;
    if (!candidate || !Number.isFinite(quantity) || quantity <= 0 ||
        !requireEqualRate(quantity * candidate.sourceSellerNetUnitPrice,
          quote.sellerInvoiceSource, moneyEpsilon)) {
      throw new Error("Phase-7 live actual-lot invoice disagrees with matched seller");
    }
    const charges = {
      transportFeePerUnitDest: quote.transportFeeDest / quantity,
      tariffPerUnitDest: quote.importTariffDest / quantity,
      consumptionTaxPerUnitDest: quote.consumptionTaxDest / quantity,
    };
    if (!Object.values(charges).every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error("Phase-7 live actual-lot charges cannot be represented per unit");
    }
    if (quote.fxPairId === null) {
      if (quote.originCurrencyId !== quote.destinationCurrencyId) {
        throw new Error("Phase-7 live actual-lot cross-currency quote lacks FX");
      }
      const terms = {
        sellerNetUnitPrice: candidate.sourceSellerNetUnitPrice, ...charges,
      };
      const previous = domestic.get(quote.lot.tradePlanId);
      if (previous) checkSameTerms(previous, terms, moneyEpsilon);
      domestic.set(quote.lot.tradePlanId, terms);
    } else {
      if (quote.originCurrencyId === quote.destinationCurrencyId) {
        throw new Error("Phase-7 live actual-lot same-currency route cannot use FX");
      }
      const terms = {
        sourceSellerNetUnitPrice: candidate.sourceSellerNetUnitPrice, ...charges,
      };
      const previous = foreign.get(quote.lot.tradePlanId);
      if (previous) checkFxTerms(previous, terms, moneyEpsilon);
      foreign.set(quote.lot.tradePlanId, terms);
    }
  }
  return executePreparedMixedCurrencyTradePlan(world, {
    ...state,
    tick: context.tick,
    planInput: trustedPlanInput,
    termsByTradePlanId: foreign,
    sameCurrencyTermsByTradePlanId: domestic,
  });
}
