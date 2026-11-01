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
 * Concrete matched lots may have different effective fee/tax amounts on the
 * same route. Preserve actual quote terms by MATCHED LOT ORDINAL, without
 * averaging the charges into a per-plan price or changing FX ownership.
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
  type Phase7FxPriceTerms, type Phase7QuotedLotTerms,
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
  const domesticLots = new Map<number, Phase7QuotedLotTerms<Phase7SameCurrencyPriceTerms>>();
  const foreignLots = new Map<number, Phase7QuotedLotTerms<Phase7FxPriceTerms>>();
  for (const [ordinal, quote] of quoted.quotes.entries()) {
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
      domestic.set(quote.lot.tradePlanId, terms);
      domesticLots.set(ordinal, { terms, buyerDebitDest: quote.buyerDebitDest });
    } else {
      if (quote.originCurrencyId === quote.destinationCurrencyId) {
        throw new Error("Phase-7 live actual-lot same-currency route cannot use FX");
      }
      const terms = {
        sourceSellerNetUnitPrice: candidate.sourceSellerNetUnitPrice, ...charges,
      };
      foreign.set(quote.lot.tradePlanId, terms);
      foreignLots.set(ordinal, { terms, buyerDebitDest: quote.buyerDebitDest });
    }
  }
  return executePreparedMixedCurrencyTradePlan(world, {
    ...state,
    tick: context.tick,
    planInput: trustedPlanInput,
    termsByTradePlanId: foreign,
    sameCurrencyTermsByTradePlanId: domestic,
    quotedFxTermsByLotOrdinal: foreignLots,
    quotedSameCurrencyTermsByLotOrdinal: domesticLots,
  });
}
