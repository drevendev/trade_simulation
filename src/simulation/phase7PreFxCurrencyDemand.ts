/**
 * M5 #671: currency-valued evidence from detached pre-FX actor lots.
 * This is not a complete original demand set until shared regional and actor
 * allocation is integrated. No reservation or settlement authority escapes.
 */
import type { Phase7PreFxActorDemandLot } from "./phase7IntentMatching";
import type { Phase7PreFxRankedCandidate } from "./tradeCandidateSelection";
import type { Phase7DesiredFxFlow } from "./phase7AutoFxReservations";
import { quoteFx } from "./fxWorldPoolAuthority";
import type { WorldState } from "./worldState";

export type Phase7ValuedPreFxDemandLot = Readonly<
  Phase7PreFxActorDemandLot & Phase7DesiredFxFlow
>;

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Phase-7 desired FX " + label + " must be finite and positive");
  }
  return value;
}

/**
 * The candidate and pair evidence must be the same owner-resolved quote
 * inputs used to construct the actor preview. The source NET price values
 * the seller invoice; transport and taxes are not currency-pool demand.
 *
 * Preserve input lot order (canonical matching order), not dispatch ordinals.
 * A zero input cap prevents the quote's feasible leg from being used as
 * demand; only the desired fields leave this function.
 */
export function valuePhase7PreFxActorDemand(
  world: WorldState,
  tick: number,
  lots: readonly Phase7PreFxActorDemandLot[],
  candidates: readonly Phase7PreFxRankedCandidate[],
  pairByPlan: ReadonlyMap<string, string>,
): readonly Phase7ValuedPreFxDemandLot[] {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new Error("Phase-7 desired FX invalid tick");
  }
  const byPlan = new Map<string, Phase7PreFxRankedCandidate>();
  for (const candidate of candidates) {
    if (!candidate.tradePlanId || byPlan.has(candidate.tradePlanId)) {
      throw new Error("Phase-7 desired FX duplicate or missing candidate ID");
    }
    byPlan.set(candidate.tradePlanId, candidate);
  }
  const seen = new Set<string>();
  return Object.freeze(lots.map(lot => {
    const candidate = byPlan.get(lot.tradePlanId);
    const pair = pairByPlan.get(lot.tradePlanId);
    if (!candidate || !pair || !lot.sellerIntentId || !lot.buyerIntentId ||
        lot.sourceCurrencyId === lot.destinationCurrencyId ||
        lot.sourceCurrencyId !== candidate.sourceCurrencyId ||
        lot.destinationCurrencyId !== candidate.destinationCurrencyId) {
      throw new Error("Phase-7 desired FX missing or mismatched route evidence");
    }
    const key = JSON.stringify([lot.tradePlanId, lot.sellerIntentId, lot.buyerIntentId]);
    if (seen.has(key)) throw new Error("Phase-7 desired FX duplicate lot provenance");
    seen.add(key);
    const quantity = positive(lot.desiredQuantity, "quantity");
    if (quantity > positive(candidate.desiredOwnQuantity, "candidate bound")) {
      throw new Error("Phase-7 desired FX lot exceeds candidate bound");
    }
    const invoice = positive(quantity *
      positive(candidate.sourceSellerNetUnitPrice, "source NET price"), "invoice");
    const q = quoteFx(world, pair, lot.destinationCurrencyId, lot.sourceCurrencyId,
      invoice, { maxInputAmount: 0 });
    const required = positive(q.requiredInputAmountAtDesiredOutput, "required input");
    return Object.freeze({
      tradePlanId: lot.tradePlanId,
      sellerIntentId: lot.sellerIntentId,
      buyerIntentId: lot.buyerIntentId,
      sourceCurrencyId: lot.sourceCurrencyId,
      destinationCurrencyId: lot.destinationCurrencyId,
      desiredQuantity: quantity,
      tick, pairId: q.pairId, direction: q.direction,
      desiredOutputAmount: invoice, requiredInputAmountAtDesiredOutput: required,
    });
  }));
}
