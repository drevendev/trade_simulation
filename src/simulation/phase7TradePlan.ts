/**
 * M5 / #673 — pure, deterministic Phase-7 PREPARED trade plan.
 *
 * Compose three existing independent ownership boundaries in canonical order:
 * Phase-1 legal/price candidate selection -> shared regional/FX reservations ->
 * actual seller/buyer intent matching. Every input budget is caller-verified
 * post-Phase-4 evidence; this preview never spends cash, moves goods, reduces
 * Phase-8 intents or creates shipments.
 *
 * IMPORTANT: a successful prepared plan is NOT a committed trade. Phase-8 may
 * consume only actual successful dispatch receipts, never these reservations.
 * The atomic same-currency/FX dispatchers remain the sole economic writers.
 */
import type { SimulationConfig } from "../config/simulationConfig";
import type { TransportLinkId } from "../domain/id";
import {
  selectPhase7TradeCandidates,
  type Phase7CandidateEvidence,
  type Phase7CandidateScorePolicy,
  type Phase7EligibleTradeCandidate,
} from "./tradeCandidateSelection";
import {
  reservePhase7AggregateTrades,
  type Phase7AggregateBudgets,
  type Phase7AggregateReservationResult,
  type Phase7AggregateReservationRequest,
} from "./phase7AggregateReservation";
import {
  matchPhase7ActorIntents,
  type Phase7ActorMatchBudgets,
  type Phase7ActorMatchResult,
  type Phase7ActorResidualIntent,
  type Phase7ActorMatchRequest,
} from "./phase7IntentMatching";
import type { WorldState } from "./worldState";

export interface Phase7TradePlanActors {
  readonly sellers: readonly Phase7ActorResidualIntent[];
  readonly buyers: readonly Phase7ActorResidualIntent[];
}

export interface Phase7PreparedTradePlanInput {
  /** Frozen Phase-1 legally assessed, post-Phase-4/6 priced opportunities. */
  readonly opportunities: readonly Phase7CandidateEvidence[];
  readonly scorePolicy: Phase7CandidateScorePolicy;
  readonly infrastructureFactors: ReadonlyMap<TransportLinkId, number>;
  readonly eligibleDirectedLinkIdsAtPhase1: ReadonlySet<TransportLinkId>;
  /** Post-prior-commit regional resource balances; not a second stock owner. */
  readonly aggregateBudgets: Phase7AggregateBudgets;
  /** Owner-verified physical endpoints and real spendable buyer wallets. */
  readonly actorBudgets: Phase7ActorMatchBudgets;
  /** Complete seller/buyer post-Phase-4 residual intents for each selected plan. */
  readonly actorsByTradePlanId: ReadonlyMap<string, Phase7TradePlanActors>;
  /** Explicit FX pair association for mixed-currency opportunities only. */
  readonly fxPairIdByTradePlanId?: ReadonlyMap<string, string>;
}

export interface Phase7PreparedTradePlan {
  readonly rankedCandidates: readonly Phase7EligibleTradeCandidate[];
  readonly aggregate: Phase7AggregateReservationResult;
  readonly actorMatches: Phase7ActorMatchResult;
}

/**
 * Fail closed if regional reservations cannot be represented by real actor
 * residuals. All intermediate debits are ephemeral and discarded on failure.
 * The eventual dispatch executor must re-preflight each lot against live state.
 */
export function preparePhase7TradePlan(
  world: Pick<WorldState, "regions" | "transportLinks">,
  config: Pick<SimulationConfig, "numeric" | "trade">,
  input: Phase7PreparedTradePlanInput,
): Phase7PreparedTradePlan {
  const rankedCandidates = selectPhase7TradeCandidates(
    world, config, input.opportunities, input.infrastructureFactors,
    input.eligibleDirectedLinkIdsAtPhase1, input.scorePolicy,
  );
  const originalByPlanId = new Map(input.opportunities.map((entry) => [entry.planId, entry]));
  const reservationRequests: Phase7AggregateReservationRequest[] = rankedCandidates.map((candidate) => {
    const original = originalByPlanId.get(candidate.tradePlanId);
    if (!original) throw new Error("Phase-7 selected candidate has no original quote");
    return {
      candidate,
      cargoWeightPerUnit: original.cargoWeightPerUnit,
      landedGrossUnitCostDest: original.landedGrossUnitCostDest,
      ...(input.fxPairIdByTradePlanId?.has(candidate.tradePlanId)
        ? { fxPoolPairId: input.fxPairIdByTradePlanId.get(candidate.tradePlanId)! }
        : {}),
    };
  });
  const aggregate = reservePhase7AggregateTrades(
    world, config, reservationRequests, input.aggregateBudgets,
    input.infrastructureFactors, input.eligibleDirectedLinkIdsAtPhase1,
  );
  const reservationsByPlanId = new Map(
    aggregate.reservations.map((reservation) => [reservation.tradePlanId, reservation]),
  );
  const matchRequests: Phase7ActorMatchRequest[] = reservationRequests.map(({ candidate, landedGrossUnitCostDest }) => {
    const reservation = reservationsByPlanId.get(candidate.tradePlanId);
    const actors = input.actorsByTradePlanId.get(candidate.tradePlanId);
    if (!reservation || !actors) {
      throw new Error("Phase-7 selected trade lacks reservation or actor residual evidence");
    }
    return {
      candidate, reservation,
      sellers: actors.sellers, buyers: actors.buyers, landedGrossUnitCostDest,
    };
  });
  const { rateEpsilon, quantityEpsilon, moneyEpsilon } = config.numeric;
  if (rateEpsilon === undefined || quantityEpsilon === undefined || moneyEpsilon === undefined) {
    throw new Error("Phase-7 prepared trade plan requires resolved numeric tolerances");
  }
  const actorMatches = matchPhase7ActorIntents(
    matchRequests, input.actorBudgets, rateEpsilon, quantityEpsilon, moneyEpsilon,
  );
  return { rankedCandidates, aggregate, actorMatches };
}
