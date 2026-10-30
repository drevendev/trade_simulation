/**
 * M5 / #673: derive Phase-7 opportunity quantities and actor evidence from
 * live post-Phase-4 residual MarketIntents and authoritative WorldState stocks.
 *
 * Phase-1/6 owners supply frozen legal, gross landed and FX evidence; the
 * destination NET price is hydrated only from canonical Phase-6/market state. This module deliberately does
 * not invent tariff/FX defaults or turn planned quantities into committed flows.
 * The canonical Phase-7 dispatcher remains the only writer.
 */
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
import { marketPriceKey } from "./phase6MarketPriceFormation";
import type { TickContext } from "./tickOrchestrator";
import type { Phase7CandidateEvidence } from "./tradeCandidateSelection";
import type { LocalMarketState, WorldState } from "./worldState";

/** Only economic quotes/legal decisions come from outside WorldState's stock owner. */
export type Phase7LiveOpportunityQuote = Omit<
  Phase7CandidateEvidence,
  "exportableQuantity" | "residualImportDemandQuantity" | "buyerRemainingBudgetDest"
>;
/** Caller-owned legal, gross landed, source invoice and FX evidence: never a net price. */
export type Phase7LiveQuoteWithoutDestinationNetPrice = Omit<
  Phase7LiveOpportunityQuote, "destinationReferenceNetUnitPrice"
>;

export interface Phase7LiveWorldPlanInput extends Pick<
  Phase7PreparedTradePlanInput,
  "scorePolicy" | "infrastructureFactors" | "eligibleDirectedLinkIdsAtPhase1" |
  "fxPairIdByTradePlanId"
> {
  /** Frozen legal/gross/FX quote per route; net market price comes only from Phase-6. */
  readonly opportunityQuotes: readonly Phase7LiveQuoteWithoutDestinationNetPrice[];
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
  context: Pick<TickContext, "phase" | "marketPrices">,
  input: Phase7LiveWorldPlanInput,
): Phase7PreparedTradePlanInput {
  // Hydrate before reservations: no caller-controlled market net price enters the plan.
  const pricedQuotes = derivePhase7DestinationNetPrices(world, context, input.opportunityQuotes);
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
  for (const quote of [...pricedQuotes].sort((a, b) =>
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

  const opportunities: Phase7CandidateEvidence[] = pricedQuotes.map((quote) => {
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
    ...(input.fxPairIdByTradePlanId !== undefined
      ? { fxPairIdByTradePlanId: input.fxPairIdByTradePlanId } : {}),
  };
}

/** Read-only Phase-7 preview using live goods and cash rather than caller stock claims. */
export function preparePhase7LiveWorldTradePlan(
  world: WorldState,
  context: Pick<TickContext, "phase" | "marketPrices">,
  input: Phase7LiveWorldPlanInput,
): Phase7PreparedTradePlan {
  return preparePhase7TradePlan(
    world, world.simulationConfig, buildPhase7LiveWorldPlanInput(world, context, input),
  );
}

/**
 * Derive the destination market's net reference price from the SAME Phase-6
 * evidence that Phase-8 will clear against. This removes a caller-controlled
 * price from the live Phase-7 opportunity builder while leaving tax-inclusive
 * gross quotes, source invoices, FX and legal decisions with their own owners.
 *
 * Only valid at the Phase-7 boundary. A Phase-6 price in TickContext takes
 * precedence over the live carried market price, matching Phase-8's rule.
 * Missing/ambiguous markets or malformed prices fail closed; there is no
 * invented default price and the supplied WorldState/context are untouched.
 */
export function derivePhase7DestinationNetPrices(
  world: Pick<WorldState, "regions" | "markets" | "transportLinks">,
  context: Pick<TickContext, "phase" | "marketPrices">,
  quotes: readonly Phase7LiveQuoteWithoutDestinationNetPrice[],
): readonly Phase7LiveOpportunityQuote[] {
  if (context.phase !== 7 || !(context.marketPrices instanceof Map)) {
    throw new Error("Phase-7 net price evidence requires live Phase-7 market prices");
  }
  const marketsByRegionKey = new Map<string, LocalMarketState[]>();
  for (const market of world.markets.values()) {
    const current = marketsByRegionKey.get(market.seed.regionKey) ?? [];
    current.push(market);
    marketsByRegionKey.set(market.seed.regionKey, current);
  }
  return [...quotes].sort((a, b) =>
    cmp(a.linkId, b.linkId) || cmp(a.goodId, b.goodId) || cmp(a.planId, b.planId))
    .map((quote) => {
      const destination = world.regions.get(quote.destinationRegionId);
      const link = world.transportLinks.get(quote.linkId);
      if (!destination || !link ||
          link.fromRegionId !== quote.originRegionId ||
          link.toRegionId !== quote.destinationRegionId) {
        throw new Error("Phase-7 net price quote references a mismatched directed link or Region");
      }
      const matching = marketsByRegionKey.get(destination.seed.key) ?? [];
      if (matching.length !== 1) {
        throw new Error("Phase-7 net price quote requires exactly one destination LocalMarket");
      }
      const market = matching[0]!;
      const key = marketPriceKey(market.marketId, quote.goodId);
      const netPrice = context.marketPrices.get(key) ?? market.priceByGood.get(quote.goodId);
      if (netPrice === undefined || !Number.isFinite(netPrice) || netPrice <= 0) {
        throw new Error("Phase-7 net price quote requires a finite positive canonical market price");
      }
      return { ...quote, destinationReferenceNetUnitPrice: netPrice };
    });
}
