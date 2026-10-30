/**
 * M5 / #673: derive Phase-7 opportunity quantities and actor evidence from
 * live post-Phase-4 residual MarketIntents and authoritative WorldState stocks.
 *
 * The calling Phase-1/6 policy and price owners STILL supply legally frozen,
 * fully priced route quotes and FX reservations. This module deliberately does
 * not invent tariff/FX defaults or turn planned quantities into committed flows.
 * The canonical Phase-7 dispatcher remains the only writer.
 */
import type { GoodId, RegionId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import { validateMarketIntent } from "./marketIntent";
import {
  phase7BuyerActorCashKey,
  phase7SellerEndpointKey,
  type Phase7ActorResidualIntent,
} from "./phase7IntentMatching";
import {
  phase7RegionCashKey,
  phase7RegionGoodKey,
  type Phase7AggregateBudgets,
} from "./phase7AggregateReservation";
import { buildPhase7LiveActorMatchBudgets } from "./phase7LiveActorMatchBudgets";
import {
  preparePhase7TradePlan,
  type Phase7PreparedTradePlan,
  type Phase7PreparedTradePlanInput,
  type Phase7TradePlanActors,
} from "./phase7TradePlan";
import type { Phase7CandidateEvidence } from "./tradeCandidateSelection";
import type { WorldState } from "./worldState";

/** Only economic quotes/legal decisions come from outside WorldState's stock owner. */
export type Phase7LiveOpportunityQuote = Omit<
  Phase7CandidateEvidence,
  "exportableQuantity" | "residualImportDemandQuantity" | "buyerRemainingBudgetDest"
>;

export interface Phase7LiveWorldPlanInput extends Pick<
  Phase7PreparedTradePlanInput,
  "scorePolicy" | "infrastructureFactors" | "eligibleDirectedLinkIdsAtPhase1" |
  "fxPairIdByTradePlanId"
> {
  /** One frozen Phase-1/6 quote per directed link+good, with NO caller stock claims. */
  readonly opportunityQuotes: readonly Phase7LiveOpportunityQuote[];
  /** Unique intents after Phase-4 commitments; never original unspent maxSpend. */
  readonly residualIntents: readonly Phase7ActorResidualIntent[];
  /** FX output already net of operational floors / earlier commitments. */
  readonly fxOutputByPairCurrency: ReadonlyMap<string, number>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Phase-7 live opportunity " + label + " must be finite and non-negative");
  }
}

function observedSum(current: number, increment: number, tolerance: number, label: string): number {
  const next = current + increment;
  if (!Number.isFinite(next) ||
      (increment > 0 && (next === current ||
        Math.abs((next - current) - increment) > tolerance))) {
    throw new Error("Phase-7 live opportunity " + label + " lost numeric precision");
  }
  return next;
}

function add(
  map: Map<string, number>, key: string, quantity: number, tolerance: number, label: string,
): void {
  map.set(key, observedSum(map.get(key) ?? 0, quantity, tolerance, label));
}

function ordered(entries: readonly Phase7ActorResidualIntent[]): Phase7ActorResidualIntent[] {
  return [...entries].sort((a, b) =>
    cmp(actorRefKey(a.intent.actor), actorRefKey(b.intent.actor)) ||
    cmp(a.intent.id, b.intent.id));
}

/**
 * Build actual owner-constrained stocks, aggregated regional upper bounds and
 * per-route actors in one deterministic pass. Same physical State inventory
 * may appear as an upper bound at different origin Regions, but is represented
 * by ONE global physical endpoint in actorBudgets. If such provisional regional
 * reservations overdraw it, preparePhase7TradePlan fails closed; no invented
 * per-region State stock is ever accepted as an economic commitment.
 */
export function buildPhase7LiveWorldPlanInput(
  world: WorldState,
  input: Phase7LiveWorldPlanInput,
): Phase7PreparedTradePlanInput {
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  if (quantityEpsilon === undefined || moneyEpsilon === undefined ||
      !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0 ||
      !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0) {
    throw new Error("Phase-7 live opportunity requires resolved numeric tolerances");
  }

  const seenIntentIds = new Set<string>();
  const sellers = new Map<string, Phase7ActorResidualIntent[]>();
  const buyers = new Map<string, Phase7ActorResidualIntent[]>();
  const protectedByEndpoint = new Map<string, number>();
  const demand = new Map<string, number>();
  const actorSpendByRegionCurrency = new Map<string, Map<string, number>>();
  const sellDemandByRegionEndpoint = new Map<string, Map<string, number>>();

  for (const entry of ordered(input.residualIntents)) {
    const intent = entry.intent;
    validateMarketIntent(intent);
    if (seenIntentIds.has(intent.id)) {
      throw new Error("Phase-7 live opportunity duplicate residual intent ID");
    }
    seenIntentIds.add(intent.id);
    if (!world.regions.has(intent.regionId)) {
      throw new Error("Phase-7 live opportunity references an unknown intent Region");
    }
    requireNonnegative(entry.residualQuantity, "residual quantity");
    if (entry.residualQuantity > intent.desiredQuantity) {
      throw new Error("Phase-7 live opportunity residual exceeds original intent");
    }
    const groupKey = phase7RegionGoodKey(intent.regionId, intent.goodId);
    if (intent.side === "SELL") {
      if (entry.remainingBuyerSpend !== undefined) {
        throw new Error("Phase-7 live SELL must not carry buyer spend");
      }
      const endpoint = phase7SellerEndpointKey(intent);
      protectedByEndpoint.set(
        endpoint,
        Math.max(protectedByEndpoint.get(endpoint) ?? 0, intent.minimumReserveQuantity ?? 0),
      );
      const group = sellers.get(groupKey) ?? [];
      group.push(entry);
      sellers.set(groupKey, group);
      const endpointDemand = sellDemandByRegionEndpoint.get(groupKey) ?? new Map<string, number>();
      add(endpointDemand, endpoint, entry.residualQuantity, quantityEpsilon, "seller residual");
      sellDemandByRegionEndpoint.set(groupKey, endpointDemand);
    } else {
      if (entry.remainingBuyerSpend === undefined) {
        throw new Error("Phase-7 live BUY requires post-Phase-4 remaining spend");
      }
      requireNonnegative(entry.remainingBuyerSpend, "buyer remaining spend");
      if (entry.remainingBuyerSpend > (intent.maxSpend ?? 0)) {
        throw new Error("Phase-7 live BUY spend exceeds original maxSpend");
      }
      const group = buyers.get(groupKey) ?? [];
      group.push(entry);
      buyers.set(groupKey, group);
      add(demand, groupKey, entry.residualQuantity, quantityEpsilon, "import demand");

      const currency = world.regions.get(intent.regionId)!.settlementCurrencyId;
      const regionCashKey = phase7RegionCashKey(intent.regionId, currency);
      const actorCashKey = phase7BuyerActorCashKey(intent.actor, currency);
      const spendByActor = actorSpendByRegionCurrency.get(regionCashKey) ?? new Map<string, number>();
      add(spendByActor, actorCashKey, entry.remainingBuyerSpend, moneyEpsilon, "actor spend");
      actorSpendByRegionCurrency.set(regionCashKey, spendByActor);
    }
  }

  const actorsByTradePlanId = new Map<string, Phase7TradePlanActors>();
  const seenPlans = new Set<string>();
  const seenLinkGoods = new Set<string>();
  for (const quote of [...input.opportunityQuotes].sort((a, b) =>
    cmp(a.linkId, b.linkId) || cmp(a.goodId, b.goodId) || cmp(a.planId, b.planId))) {
    if (seenPlans.has(quote.planId) ||
        seenLinkGoods.has(JSON.stringify([quote.linkId, quote.goodId]))) {
      throw new Error("Phase-7 live opportunity duplicate plan or link/good");
    }
    seenPlans.add(quote.planId);
    seenLinkGoods.add(JSON.stringify([quote.linkId, quote.goodId]));
    const link = world.transportLinks.get(quote.linkId);
    if (!link || link.fromRegionId !== quote.originRegionId ||
        link.toRegionId !== quote.destinationRegionId) {
      throw new Error("Phase-7 live opportunity references a mismatched directed link");
    }
    actorsByTradePlanId.set(quote.planId, {
      sellers: sellers.get(phase7RegionGoodKey(quote.originRegionId, quote.goodId)) ?? [],
      buyers: buyers.get(phase7RegionGoodKey(quote.destinationRegionId, quote.goodId)) ?? [],
    });
  }
  const actorBudgets = buildPhase7LiveActorMatchBudgets(
    world, actorsByTradePlanId, protectedByEndpoint,
  );

  const exportableByOriginGood = new Map<string, number>();
  for (const [regionGood, endpointDemands] of [...sellDemandByRegionEndpoint].sort(([a], [b]) => cmp(a, b))) {
    let total = 0;
    for (const [endpoint, requested] of [...endpointDemands].sort(([a], [b]) => cmp(a, b))) {
      const physical = actorBudgets.sellerExportableByEndpoint.get(endpoint);
      // An intent without a quoted route does not have to become a matcher input.
      // Its region/good bound is still computed only if the endpoint is actually quoted.
      if (physical !== undefined) {
        total = observedSum(total, Math.min(requested, physical), quantityEpsilon, "export supply");
      }
    }
    exportableByOriginGood.set(regionGood, total);
  }

  const buyerCashByDestinationCurrency = new Map<string, number>();
  for (const [regionCurrency, byActor] of [...actorSpendByRegionCurrency].sort(([a], [b]) => cmp(a, b))) {
    let cash = 0;
    for (const [actorKey, spend] of [...byActor].sort(([a], [b]) => cmp(a, b))) {
      const physical = actorBudgets.buyerCashByActorCurrency.get(actorKey);
      if (physical !== undefined) {
        cash = observedSum(cash, Math.min(spend, physical), moneyEpsilon, "regional buyer cash");
      }
    }
    buyerCashByDestinationCurrency.set(regionCurrency, cash);
  }

  const fxOutputByPairCurrency = new Map<string, number>();
  for (const [key, balance] of input.fxOutputByPairCurrency) {
    requireNonnegative(balance, "FX available output");
    fxOutputByPairCurrency.set(key, balance);
  }
  const aggregateBudgets: Phase7AggregateBudgets = {
    exportableByOriginGood, importDemandByDestinationGood: demand,
    buyerCashByDestinationCurrency, fxOutputByPairCurrency,
  };

  const opportunities: Phase7CandidateEvidence[] = input.opportunityQuotes.map((quote) => {
    const sourceKey = phase7RegionGoodKey(quote.originRegionId, quote.goodId);
    const destinationKey = phase7RegionGoodKey(quote.destinationRegionId, quote.goodId);
    const currency = world.regions.get(quote.destinationRegionId)?.settlementCurrencyId;
    if (!currency) throw new Error("Phase-7 live opportunity destination currency missing");
    return {
      ...quote,
      exportableQuantity: exportableByOriginGood.get(sourceKey) ?? 0,
      residualImportDemandQuantity: demand.get(destinationKey) ?? 0,
      buyerRemainingBudgetDest: buyerCashByDestinationCurrency.get(
        phase7RegionCashKey(quote.destinationRegionId, currency),
      ) ?? 0,
    };
  });
  return {
    opportunities, scorePolicy: input.scorePolicy,
    infrastructureFactors: input.infrastructureFactors,
    eligibleDirectedLinkIdsAtPhase1: input.eligibleDirectedLinkIdsAtPhase1,
    aggregateBudgets, actorBudgets, actorsByTradePlanId,
    fxPairIdByTradePlanId: input.fxPairIdByTradePlanId,
  };
}

/** Read-only Phase-7 preview using live goods and cash rather than caller stock claims. */
export function preparePhase7LiveWorldTradePlan(
  world: WorldState,
  input: Phase7LiveWorldPlanInput,
): Phase7PreparedTradePlan {
  return preparePhase7TradePlan(
    world, world.simulationConfig, buildPhase7LiveWorldPlanInput(world, input),
  );
}
