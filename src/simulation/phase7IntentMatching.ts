/**
 * M5 #670 — read-only Phase-7 decomposition of an accepted regional trade
 * reservation into concrete seller/buyer intent lots.
 *
 * Inputs are post-Phase-4 residual, owner-verified MarketIntents; endpoint
 * physical balances and actor cash have explicit independent owners. This
 * helper NEVER moves inventory, spends cash, creates shipments, or settles FX.
 * Phase-8 local intents must consume the returned intent/endpoint residuals
 * only after atomic Phase-7 dispatch commits the same lots.
 */
import type { CurrencyId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { validateMarketIntent, type MarketIntent, type MarketIntentId } from "./marketIntent";
import type { Phase7AggregateReservation } from "./phase7AggregateReservation";
import { rankWithEpsilonTies, type Phase7EligibleTradeCandidate } from "./tradeCandidateSelection";

export interface Phase7ActorResidualIntent {
  readonly intent: MarketIntent;
  /** Quantity still eligible after Phase 4 and every earlier commitment. */
  readonly residualQuantity: number;
}

export interface Phase7ActorMatchRequest {
  readonly candidate: Phase7EligibleTradeCandidate;
  readonly reservation: Phase7AggregateReservation;
  readonly sellers: readonly Phase7ActorResidualIntent[];
  readonly buyers: readonly Phase7ActorResidualIntent[];
  /** Same pre-priced aggregate quote as the accepted Phase-7 reservation. */
  readonly landedGrossUnitCostDest: number;
}

export interface Phase7ActorMatchBudgets {
  /** Explicit physical exportability above maximum endpoint reserve. */
  readonly sellerExportableByEndpoint: ReadonlyMap<string, number>;
  /** Available actual cash per buyer actor + destination currency. */
  readonly buyerCashByActorCurrency: ReadonlyMap<string, number>;
}

export interface Phase7ActorMatchLot {
  readonly tradePlanId: string;
  readonly sellerIntentId: MarketIntentId;
  readonly buyerIntentId: MarketIntentId;
  readonly seller: ActorRef;
  readonly buyer: ActorRef;
  readonly sellerInventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
  readonly buyerInventoryBucket: "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";
  readonly quantity: number;
}

export interface Phase7ActorMatchResult {
  readonly lots: readonly Phase7ActorMatchLot[];
  readonly remainingSellerByIntent: ReadonlyMap<MarketIntentId, number>;
  readonly remainingBuyerByIntent: ReadonlyMap<MarketIntentId, number>;
  readonly remainingSellerByEndpoint: ReadonlyMap<string, number>;
  readonly remainingBuyerCashByActorCurrency: ReadonlyMap<string, number>;
  readonly remainingBuyerSpendByIntent: ReadonlyMap<MarketIntentId, number>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function validNonnegative(n: number, label: string): void {
  if (!Number.isFinite(n) || n < 0) throw new Error(label + " must be finite and non-negative");
}
function mustHave(map: ReadonlyMap<string, number>, key: string, label: string): number {
  if (!map.has(key)) throw new Error("missing explicit " + label + " for " + key);
  const value = map.get(key)!;
  validNonnegative(value, label);
  return value;
}
function consume(balance: number, use: number, label: string): number {
  validNonnegative(balance, label + " balance");
  validNonnegative(use, label + " use");
  if (use > balance) throw new Error(label + " overdraw");
  if (use === 0) return balance;
  const after = balance - use;
  if (!Number.isFinite(after) || after < 0 || after === balance) {
    throw new Error(label + " lost numeric precision");
  }
  return after;
}
function bucket(intent: MarketIntent): Phase7ActorMatchLot["sellerInventoryBucket"] {
  return intent.inventoryBucket ?? "GENERAL";
}

/** Canonical identity for the ONE physical inventory endpoint, not each SELL intent. */
export function phase7SellerEndpointKey(intent: MarketIntent): string {
  return JSON.stringify([actorRefKey(intent.actor), intent.regionId, intent.goodId, bucket(intent)]);
}
export function phase7BuyerActorCashKey(actor: ActorRef, currency: CurrencyId): string {
  return JSON.stringify([actorRefKey(actor), currency]);
}
function ordered(entries: readonly Phase7ActorResidualIntent[]): Phase7ActorResidualIntent[] {
  return [...entries].sort((a, b) =>
    cmp(actorRefKey(a.intent.actor), actorRefKey(b.intent.actor)) ||
    cmp(a.intent.id, b.intent.id));
}
function fingerprint(entry: Phase7ActorResidualIntent): string {
  const i = entry.intent;
  return JSON.stringify([
    actorRefKey(i.actor), i.id, i.regionId, i.goodId, i.side, i.purpose,
    i.desiredQuantity, i.maxSpend ?? null, i.minimumReserveQuantity ?? null,
    i.sourcePlanId, bucket(i), entry.residualQuantity,
  ]);
}
interface Cap {
  readonly evidence: Phase7ActorResidualIntent;
  readonly cap: number;
}
interface Fill extends Cap {
  readonly fill: number;
}

/** Proportional, capacity bounded, stable-key residual correction. */
function proportional(caps: readonly Cap[], quantity: number, epsilon: number): Fill[] {
  const total = caps.reduce((acc, c) => acc + c.cap, 0);
  if (!Number.isFinite(total) || quantity > total) {
    throw new Error("Phase-7 actor residual cannot cover aggregate reservation");
  }
  const fills = caps.map((c) => ({
    ...c,
    fill: quantity === total ? c.cap : Math.min(c.cap, quantity * (c.cap / total)),
  }));
  let delta = quantity - fills.reduce((acc, c) => acc + c.fill, 0);
  if (!Number.isFinite(delta)) throw new Error("Phase-7 actor fill sum not finite");
  // IDs are already stable ordered. Correct the first actor with available
  // room; no insertion-order-dependent residual allocation is permitted.
  for (const entry of fills) {
    if (delta === 0) break;
    const change = delta > 0
      ? Math.min(delta, Math.max(0, entry.cap - entry.fill))
      : Math.max(delta, -entry.fill);
    const next = entry.fill + change;
    if (change !== 0 && next === entry.fill) {
      throw new Error("Phase-7 actor share lost numeric precision");
    }
    entry.fill = next;
    delta -= change;
  }
  if (Math.abs(delta) > epsilon) {
    throw new Error("Phase-7 actor share cannot reconcile requested quantity");
  }
  return fills;
}

/**
 * Match in deterministic anchored candidate order. Complexity is sorting
 * plus O(S+B) per accepted candidate, not an actor Cartesian product.
 *
 * A reservation that cannot be represented by current actor-level physical,
 * demand AND cash residuals fails closed. It must be resized before atomic
 * dispatch; this function may not silently grant a different trade quantity.
 */
export function matchPhase7ActorIntents(
  requests: readonly Phase7ActorMatchRequest[],
  budgets: Phase7ActorMatchBudgets,
  scoreEpsilon: number,
  quantityEpsilon: number,
): Phase7ActorMatchResult {
  if (!Number.isFinite(scoreEpsilon) || scoreEpsilon <= 0 ||
      !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0) {
    throw new Error("Phase-7 actor matcher requires resolved numeric epsilons");
  }
  const endpoint = new Map(budgets.sellerExportableByEndpoint);
  const actorCash = new Map(budgets.buyerCashByActorCurrency);
  for (const [key, value] of [...endpoint, ...actorCash]) validNonnegative(value, key);
  const sellerRemain = new Map<MarketIntentId, number>();
  const buyerRemain = new Map<MarketIntentId, number>();
  const buyerSpend = new Map<MarketIntentId, number>();
  const signatures = new Map<MarketIntentId, string>();
  const byPlan = new Map<string, Phase7ActorMatchRequest>();

  const register = (entry: Phase7ActorResidualIntent, side: "BUY" | "SELL",
    candidate: Phase7EligibleTradeCandidate): void => {
    validateMarketIntent(entry.intent);
    validNonnegative(entry.residualQuantity, "Phase-7 actor residual");
    if (entry.intent.side !== side || entry.intent.goodId !== candidate.goodId ||
        entry.intent.regionId !== (side === "SELL" ? candidate.originRegionId : candidate.destinationRegionId) ||
        entry.residualQuantity > entry.intent.desiredQuantity) {
      throw new Error("Phase-7 actor intent side, region, good or residual mismatch");
    }
    const sign = fingerprint(entry);
    const prior = signatures.get(entry.intent.id);
    if (prior !== undefined && prior !== sign) {
      throw new Error("Phase-7 intent ID reused with conflicting ownership or quantities");
    }
    signatures.set(entry.intent.id, sign);
    const target = side === "SELL" ? sellerRemain : buyerRemain;
    if (!target.has(entry.intent.id)) target.set(entry.intent.id, entry.residualQuantity);
    if (side === "BUY" && !buyerSpend.has(entry.intent.id)) {
      buyerSpend.set(entry.intent.id, entry.intent.maxSpend!);
    }
  };

  for (const request of requests) {
    const c = request.candidate;
    const r = request.reservation;
    if (typeof c.tradePlanId !== "string" || !c.tradePlanId ||
        byPlan.has(c.tradePlanId) || !Number.isFinite(c.score)) {
      throw new Error("Phase-7 actor matcher requires unique plan IDs and finite scores");
    }
    validNonnegative(r.allocatedQuantity, "Phase-7 reserved quantity");
    validNonnegative(c.maximumOwnQuantity, "Phase-7 candidate own bound");
    validNonnegative(request.landedGrossUnitCostDest, "Phase-7 landed quote");
    if (r.tradePlanId !== c.tradePlanId || r.linkId !== c.linkId ||
        r.goodId !== c.goodId || r.allocatedQuantity > c.maximumOwnQuantity ||
        (r.refusal !== null && r.allocatedQuantity !== 0)) {
      throw new Error("Phase-7 actor request does not match accepted aggregate reservation");
    }
    const seen = new Set<string>();
    for (const entry of request.sellers) {
      if (seen.has(entry.intent.id)) throw new Error("duplicate Phase-7 actor intent in plan");
      seen.add(entry.intent.id);
      register(entry, "SELL", c);
      mustHave(endpoint, phase7SellerEndpointKey(entry.intent), "seller endpoint");
    }
    for (const entry of request.buyers) {
      if (seen.has(entry.intent.id)) throw new Error("duplicate Phase-7 actor intent in plan");
      seen.add(entry.intent.id);
      register(entry, "BUY", c);
      mustHave(actorCash, phase7BuyerActorCashKey(entry.intent.actor, c.destinationCurrencyId), "buyer actor cash");
    }
    byPlan.set(c.tradePlanId, request);
  }

  const lots: Phase7ActorMatchLot[] = [];
  const ranked = rankWithEpsilonTies(requests.map((r) => r.candidate), scoreEpsilon);
  for (const c of ranked) {
    const request = byPlan.get(c.tradePlanId)!;
    const quantity = request.reservation.allocatedQuantity;
    if (quantity === 0) continue;
    const quote = request.landedGrossUnitCostDest;
    const sellerShadow = new Map(endpoint);
    const buyerShadow = new Map(actorCash);
    const sellers: Cap[] = ordered(request.sellers).map((e) => {
      const key = phase7SellerEndpointKey(e.intent);
      const cap = Math.min(sellerRemain.get(e.intent.id)!, sellerShadow.get(key)!);
      sellerShadow.set(key, consume(sellerShadow.get(key)!, cap, "provisional seller endpoint"));
      return { evidence: e, cap };
    });
    const buyers: Cap[] = ordered(request.buyers).map((e) => {
      const key = phase7BuyerActorCashKey(e.intent.actor, c.destinationCurrencyId);
      const cap = Math.min(
        buyerRemain.get(e.intent.id)!, quote > 0 ? buyerSpend.get(e.intent.id)! / quote : Number.POSITIVE_INFINITY,
        quote > 0 ? buyerShadow.get(key)! / quote : Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(cap) || cap < 0) throw new Error("Phase-7 buyer quantity bound invalid");
      const provisionalCash = cap * quote;
      if (!Number.isFinite(provisionalCash) || (quote > 0 && cap > 0 && provisionalCash === 0)) {
        throw new Error("Phase-7 buyer provisional payment lost numeric precision");
      }
      buyerShadow.set(key, consume(buyerShadow.get(key)!, provisionalCash, "provisional buyer cash"));
      return { evidence: e, cap };
    });
    const sellerFills = proportional(sellers, quantity, quantityEpsilon);
    const buyerFills = proportional(buyers, quantity, quantityEpsilon);
    // Stage every actor mutation in local copies. Nothing in canonical WorldState
    // or an external intent/budget Map changes on error.
    const nextEndpoints = new Map(endpoint);
    const nextCash = new Map(actorCash);
    const nextSeller = new Map(sellerRemain);
    const nextBuyer = new Map(buyerRemain);
    const nextSpend = new Map(buyerSpend);
    for (const s of sellerFills) {
      const id = s.evidence.intent.id;
      const key = phase7SellerEndpointKey(s.evidence.intent);
      nextSeller.set(id, consume(nextSeller.get(id)!, s.fill, "seller intent"));
      nextEndpoints.set(key, consume(nextEndpoints.get(key)!, s.fill, "seller physical endpoint"));
    }
    for (const b of buyerFills) {
      const id = b.evidence.intent.id;
      const key = phase7BuyerActorCashKey(b.evidence.intent.actor, c.destinationCurrencyId);
      const payment = b.fill * quote;
      if (!Number.isFinite(payment) || (b.fill > 0 && quote > 0 && payment === 0)) {
        throw new Error("Phase-7 buyer payment lost numeric precision");
      }
      nextBuyer.set(id, consume(nextBuyer.get(id)!, b.fill, "buyer intent"));
      nextSpend.set(id, consume(nextSpend.get(id)!, payment, "buyer intent spend"));
      nextCash.set(key, consume(nextCash.get(key)!, payment, "buyer actor cash"));
    }

    const planned: Phase7ActorMatchLot[] = [];
    let s = 0, b = 0;
    let sLeft = sellerFills[0]?.fill ?? 0, bLeft = buyerFills[0]?.fill ?? 0;
    while (s < sellerFills.length && b < buyerFills.length) {
      if (sLeft === 0) { s++; sLeft = sellerFills[s]?.fill ?? 0; continue; }
      if (bLeft === 0) { b++; bLeft = buyerFills[b]?.fill ?? 0; continue; }
      const amount = Math.min(sLeft, bLeft);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Phase-7 invalid matched lot");
      const se = sellerFills[s]!.evidence.intent, be = buyerFills[b]!.evidence.intent;
      planned.push({
        tradePlanId: c.tradePlanId, sellerIntentId: se.id, buyerIntentId: be.id,
        seller: se.actor, buyer: be.actor,
        sellerInventoryBucket: bucket(se), buyerInventoryBucket: bucket(be), quantity: amount,
      });
      sLeft -= amount; bLeft -= amount;
    }
    const totalLots = planned.reduce((acc, lot) => acc + lot.quantity, 0);
    if (!Number.isFinite(totalLots) || Math.abs(totalLots - quantity) > quantityEpsilon) {
      throw new Error("Phase-7 concrete lots cannot reconcile accepted reservation");
    }
    lots.push(...planned);
    sellerRemain.clear(); for (const [k, v] of nextSeller) sellerRemain.set(k, v);
    buyerRemain.clear(); for (const [k, v] of nextBuyer) buyerRemain.set(k, v);
    buyerSpend.clear(); for (const [k, v] of nextSpend) buyerSpend.set(k, v);
    endpoint.clear(); for (const [k, v] of nextEndpoints) endpoint.set(k, v);
    actorCash.clear(); for (const [k, v] of nextCash) actorCash.set(k, v);
  }
  return {
    lots,
    remainingSellerByIntent: sellerRemain,
    remainingBuyerByIntent: buyerRemain,
    remainingSellerByEndpoint: endpoint,
    remainingBuyerCashByActorCurrency: actorCash,
    remainingBuyerSpendByIntent: buyerSpend,
  };
}
