/**
 * M5 #670 — pure Phase-7 trade candidate selection, before shared reservations.
 *
 * Implements Handoff/04 §§15–16, 23–25 eligibility/scoring on explicitly
 * precomputed post-Phase-4 residuals, Phase-1 legal eligibility, and same-tick
 * landed-cost/FX quotes. This is NOT a shipment or reservation ledger.
 *
 * In particular, maximumOwnQuantity is a per-candidate upper bound: different
 * candidates can share goods, demand, budgets and directed-link capacity.
 * Callers MUST run ordered shared-capacity, goods, demand, cash and FX
 * reservations before treating any quantity as allocated or reducing Phase-8
 * local intents. Never use this helper's output to move goods or money.
 */
import type { SimulationConfig } from "../config/simulationConfig";
import type { GoodId, RegionId, TransportLinkId, CurrencyId } from "../domain/id";
import { effectiveTransportLinkCapacity, hasUsableTransportCapacity } from "./transportCapacity";
import type { WorldState } from "./worldState";

/** A pre-priced, legally assessed aggregate route/good opportunity. */
export interface Phase7CandidateEvidence {
  /** Stable unique semantic key; one aggregate request per directed link + good. */
  readonly planId: string;
  readonly linkId: TransportLinkId;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly goodId: GoodId;
  /** Explicit frozen Phase-1 route/goods/border permission, not a Phase-14 read. */
  readonly authorizedAtPhase1: boolean;
  /** Post-Phase-4/6 uncommitted aggregate source supply and destination demand. */
  readonly exportableQuantity: number;
  readonly residualImportDemandQuantity: number;
  /** Remaining destination-currency buyer budget, after existing commitments. */
  readonly buyerRemainingBudgetDest: number;
  readonly cargoWeightPerUnit: number;
  /** Destination-currency gross reference and full, tax-inclusive landed quote. */
  readonly destinationReferenceGrossUnitPrice: number;
  readonly landedGrossUnitCostDest: number;
  /** Handoff/04 TradeCandidate quote evidence, supplied by the respective owners. */
  readonly sourceSellerNetUnitPrice: number;
  readonly destinationReferenceNetUnitPrice: number;
  readonly estimatedTransportUnitCostDest: number;
  readonly estimatedTariffRate: number;
  readonly estimatedFxInputPerSourceCurrency: number;
  readonly shortageRateDestination: number;
  /** Explicit legal quantity limit. Omit when no policy limit applies. */
  readonly legalQuantityCap?: number;
  /**
   * Maximum feasible physical quantity under the same-tick FX quote and
   * shared-reserve preflight. Required for different currencies; 0 denies.
   * THIS is only one bound; the actual shared FX ledger is still required.
   */
  readonly fxFeasibleQuantity?: number;
}

/**
 * Handoff/04 §24 names these weights/thresholds but the existing TradeConfig
 * does not resolve their defaults. Require the calling pricing-policy owner
 * to supply them explicitly rather than silently inventing economics.
 */
export interface Phase7CandidateScorePolicy {
  readonly tradeProfitWeight: number;
  readonly shortageWeight: number;
  readonly minimumTradeScore: number;
  readonly maximumShortagePremiumShare: number;
}

/** Pure ranked opportunity, NOT a committed/allocated shipment. */
export interface Phase7EligibleTradeCandidate {
  readonly tradePlanId: string;
  readonly linkId: TransportLinkId;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly goodId: GoodId;
  readonly sourceCurrencyId: CurrencyId;
  readonly destinationCurrencyId: CurrencyId;
  readonly sourceSellerNetUnitPrice: number;
  readonly destinationReferenceNetUnitPrice: number;
  readonly estimatedTransportUnitCostDest: number;
  readonly estimatedTariffRate: number;
  readonly estimatedFxInputPerSourceCurrency: number;
  readonly shortageRateDestination: number;
  readonly score: number;
  /** Independent upper bound only; shared allocation may be much smaller. */
  readonly maximumOwnQuantity: number;
}

function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be non-negative and finite`);
  }
}
function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive and finite`);
  }
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareCanonicalIds(a: Phase7EligibleTradeCandidate, b: Phase7EligibleTradeCandidate): number {
  return cmp(a.originRegionId, b.originRegionId) ||
    cmp(a.destinationRegionId, b.destinationRegionId) ||
    cmp(a.goodId, b.goodId) ||
    cmp(a.linkId, b.linkId) ||
    cmp(a.tradePlanId, b.tradePlanId);
}

/**
 * Score-first ranking with deterministic anchor-bounded epsilon tie bands.
 *
 * Handoff/04 §36 / HANDOFF-REPAIR-M5-001: sorting directly with an epsilon
 * comparator is non-transitive, but chaining adjacent near-ties can invert
 * two scores whose difference is greater than epsilon. First sort by exact
 * score descending (canonical IDs break exact-score ties). Anchor each band
 * at its highest remaining score; admit only scores within epsilon of that
 * anchor, then sort those members by IDs. Later bands retain score precedence
 * even if candidates on opposite sides of a boundary are epsilon-near.
 */
export function rankWithEpsilonTies(
  candidates: readonly Phase7EligibleTradeCandidate[],
  scoreEpsilon: number,
): Phase7EligibleTradeCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || compareCanonicalIds(a, b));
  const ranked: Phase7EligibleTradeCandidate[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[start]!.score - sorted[end]!.score <= scoreEpsilon) {
      end++;
    }
    ranked.push(...sorted.slice(start, end).sort(compareCanonicalIds));
    start = end;
  }
  return ranked;
}

/**
 * Reject malformed inputs before considering any opportunity. Excluding a
 * well-formed, ineligible request yields no candidate rather than authorizing
 * a trade on a missing or implicitly eligible route. All reads are pure.
 */
export function selectPhase7TradeCandidates(
  world: Pick<WorldState, "regions" | "transportLinks">,
  config: Pick<SimulationConfig, "trade" | "numeric">,
  evidence: readonly Phase7CandidateEvidence[],
  infrastructureFactors: ReadonlyMap<TransportLinkId, number>,
  eligibleDirectedLinkIdsAtPhase1: ReadonlySet<TransportLinkId>,
  policy: Phase7CandidateScorePolicy,
): readonly Phase7EligibleTradeCandidate[] {
  if (!infrastructureFactors || !eligibleDirectedLinkIdsAtPhase1) {
    throw new Error("Phase-7 candidate selection requires explicit route factors and Phase-1 eligibility");
  }
  nonnegative(policy.tradeProfitWeight, "tradeProfitWeight");
  nonnegative(policy.shortageWeight, "shortageWeight");
  nonnegative(policy.maximumShortagePremiumShare, "maximumShortagePremiumShare");
  if (!Number.isFinite(policy.minimumTradeScore)) {
    throw new Error("minimumTradeScore must be finite");
  }
  const epsilon = config.numeric.quantityEpsilon;
  const moneyEpsilon = config.numeric.moneyEpsilon;
  const scoreEpsilon = config.numeric.rateEpsilon;
  const minimumShipment = config.trade.shipmentMinimumQuantity;
  if (epsilon === undefined || moneyEpsilon === undefined ||
      scoreEpsilon === undefined || minimumShipment === undefined) {
    throw new Error("Phase-7 requires resolved numeric and shipment minimum config");
  }
  nonnegative(epsilon, "quantityEpsilon");
  positive(moneyEpsilon, "moneyEpsilon");
  positive(scoreEpsilon, "rateEpsilon");
  positive(minimumShipment, "shipmentMinimumQuantity");

  const seenIds = new Set<string>();
  const seenAggregateKeys = new Set<string>();
  const validated = evidence.map((request) => {
    if (typeof request.planId !== "string" || !request.planId.trim() || seenIds.has(request.planId)) {
      throw new Error("Phase-7 candidate planId must be unique and nonempty");
    }
    seenIds.add(request.planId);
    if (typeof request.goodId !== "string" || !request.goodId) {
      throw new Error("Phase-7 candidate requires a GoodId");
    }
    const groupKey = JSON.stringify([request.linkId, request.goodId]);
    if (seenAggregateKeys.has(groupKey)) {
      throw new Error("duplicate aggregate Phase-7 candidate for directed link and good");
    }
    seenAggregateKeys.add(groupKey);
    if (typeof request.authorizedAtPhase1 !== "boolean") {
      throw new Error("Phase-7 requires a frozen Phase-1 authorization decision");
    }
    for (const key of [
      "exportableQuantity", "residualImportDemandQuantity", "buyerRemainingBudgetDest",
      "destinationReferenceGrossUnitPrice", "landedGrossUnitCostDest",
      "sourceSellerNetUnitPrice", "destinationReferenceNetUnitPrice",
      "estimatedTransportUnitCostDest", "estimatedTariffRate", "shortageRateDestination",
    ] as const) {
      nonnegative(request[key], key);
    }
    positive(request.cargoWeightPerUnit, "cargoWeightPerUnit");
    positive(request.estimatedFxInputPerSourceCurrency, "estimatedFxInputPerSourceCurrency");
    if (request.estimatedTariffRate > 1 || request.shortageRateDestination > 1) {
      throw new Error("tariff and shortage rates must be within [0,1]");
    }
    if (request.legalQuantityCap !== undefined) {
      nonnegative(request.legalQuantityCap, "legalQuantityCap");
    }
    if (request.fxFeasibleQuantity !== undefined) {
      nonnegative(request.fxFeasibleQuantity, "fxFeasibleQuantity");
    }

    const link = world.transportLinks.get(request.linkId);
    if (!link || link.fromRegionId !== request.originRegionId ||
        link.toRegionId !== request.destinationRegionId) {
      throw new Error("Phase-7 candidate references an unknown/mismatched directed link");
    }
    const origin = world.regions.get(request.originRegionId);
    const destination = world.regions.get(request.destinationRegionId);
    if (!origin || !destination) {
      throw new Error("Phase-7 candidate references an unknown region");
    }
    if (!infrastructureFactors.has(request.linkId)) {
      throw new Error("Phase-7 candidate missing explicit infrastructure factor");
    }
    const factor = infrastructureFactors.get(request.linkId)!;
    const capacity = effectiveTransportLinkCapacity(link, factor);
    const physical = hasUsableTransportCapacity(link, config, factor);
    const sameCurrency = origin.settlementCurrencyId === destination.settlementCurrencyId;
    if (!sameCurrency && request.fxFeasibleQuantity === undefined) {
      throw new Error("cross-currency trade requires an explicit FX feasible quantity bound");
    }
    if (sameCurrency && request.fxFeasibleQuantity !== undefined) {
      throw new Error("same-currency candidate must not consume an FX capacity quote");
    }
    if (sameCurrency && request.estimatedFxInputPerSourceCurrency !== 1) {
      throw new Error("same-currency candidate FX conversion factor must equal 1");
    }

    const margin = (request.destinationReferenceGrossUnitPrice -
      request.landedGrossUnitCostDest) /
      Math.max(request.destinationReferenceGrossUnitPrice, moneyEpsilon);
    const score = policy.tradeProfitWeight * margin +
      policy.shortageWeight * request.shortageRateDestination;
    if (!Number.isFinite(score)) {
      throw new Error("Phase-7 candidate score is not finite");
    }
    const budgetBound = request.landedGrossUnitCostDest > 0
      ? request.buyerRemainingBudgetDest / request.landedGrossUnitCostDest
      : Number.POSITIVE_INFINITY;
    const maximumOwnQuantity = Math.min(
      request.exportableQuantity,
      request.residualImportDemandQuantity,
      capacity / request.cargoWeightPerUnit,
      budgetBound,
      request.legalQuantityCap ?? Number.POSITIVE_INFINITY,
      request.fxFeasibleQuantity ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(maximumOwnQuantity) || maximumOwnQuantity < 0) {
      throw new Error("Phase-7 own-bound quantity is not finite");
    }
    const withinPremium = request.landedGrossUnitCostDest <= request.destinationReferenceGrossUnitPrice ||
      (request.destinationReferenceGrossUnitPrice > 0 &&
       request.landedGrossUnitCostDest / request.destinationReferenceGrossUnitPrice <=
         1 + policy.maximumShortagePremiumShare);
    return { request, origin, destination, score, maximumOwnQuantity, physical, withinPremium };
  });

  const selected: Phase7EligibleTradeCandidate[] = [];
  for (const { request, origin, destination, score, maximumOwnQuantity, physical, withinPremium } of validated) {
    if (!request.authorizedAtPhase1 || !eligibleDirectedLinkIdsAtPhase1.has(request.linkId) ||
        !physical || score <= policy.minimumTradeScore || !withinPremium ||
        maximumOwnQuantity <= epsilon || maximumOwnQuantity < minimumShipment) {
      continue;
    }
    selected.push({
      tradePlanId: request.planId,
      linkId: request.linkId,
      originRegionId: request.originRegionId,
      destinationRegionId: request.destinationRegionId,
      goodId: request.goodId,
      sourceCurrencyId: origin.settlementCurrencyId,
      destinationCurrencyId: destination.settlementCurrencyId,
      sourceSellerNetUnitPrice: request.sourceSellerNetUnitPrice,
      destinationReferenceNetUnitPrice: request.destinationReferenceNetUnitPrice,
      estimatedTransportUnitCostDest: request.estimatedTransportUnitCostDest,
      estimatedTariffRate: request.estimatedTariffRate,
      estimatedFxInputPerSourceCurrency: request.estimatedFxInputPerSourceCurrency,
      shortageRateDestination: request.shortageRateDestination,
      score,
      maximumOwnQuantity,
    });
  }
  return rankWithEpsilonTies(selected, scoreEpsilon);
}
