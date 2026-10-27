/** M5 #670: pure actor-level Phase-7 intent matching and residual ledgers. */
import { describe, expect, it } from "vitest";
import type { CohortId, CurrencyId, GoodId, ProductionUnitId, RegionId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import type { Phase7EligibleTradeCandidate } from "./tradeCandidateSelection";
import type { Phase7AggregateReservation } from "./phase7AggregateReservation";
import {
  matchPhase7ActorIntents, phase7BuyerActorCashKey, phase7SellerEndpointKey,
  type Phase7ActorMatchRequest, type Phase7ActorResidualIntent, type Phase7ActorMatchBudgets,
} from "./phase7IntentMatching";

const origin = "r:source" as RegionId;
const dest = "r:destination" as RegionId;
const good = "good:wood" as GoodId;
const currency = "cur:gold" as CurrencyId;
const link = "link:source-destination" as TransportLinkId;

function seller(id: string, quantity: number, owner: string = id): Phase7ActorResidualIntent {
  const intent: MarketIntent = {
    id: createMarketIntentId("mi:" + id),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: ("pu:" + owner) as ProductionUnitId },
    regionId: origin, goodId: good, side: "SELL", purpose: "INVENTORY_REBALANCE",
    desiredQuantity: quantity, minimumReserveQuantity: 0, inventoryBucket: "OUTPUT",
    sourcePlanId: "plan:" + id,
  };
  return { intent, residualQuantity: quantity };
}
function buyer(id: string, quantity: number, owner: string = id): Phase7ActorResidualIntent {
  const intent: MarketIntent = {
    id: createMarketIntentId("mi:" + id),
    actor: { type: "COHORT", cohortId: ("coh:" + owner) as CohortId },
    regionId: dest, goodId: good, side: "BUY", purpose: "CONSUMPTION",
    desiredQuantity: quantity, maxSpend: 100, sourcePlanId: "plan:" + id,
  };
  return { intent, residualQuantity: quantity, remainingBuyerSpend: 100 };
}
function request(
  plan: string, quantity: number,
  sellers: readonly Phase7ActorResidualIntent[],
  buyers: readonly Phase7ActorResidualIntent[],
  overrides: Partial<Phase7ActorMatchRequest> = {},
): Phase7ActorMatchRequest {
  const candidate: Phase7EligibleTradeCandidate = {
    tradePlanId: plan, linkId: link,
    originRegionId: origin, destinationRegionId: dest, goodId: good,
    sourceCurrencyId: currency, destinationCurrencyId: currency,
    sourceSellerNetUnitPrice: 1, destinationReferenceNetUnitPrice: 2,
    estimatedTransportUnitCostDest: 0, estimatedTariffRate: 0,
    estimatedFxInputPerSourceCurrency: 1, shortageRateDestination: 0.2,
    score: plan === "a" ? 2 : 1, maximumOwnQuantity: 20,
  };
  const reservation: Phase7AggregateReservation = {
    tradePlanId: plan, linkId: link, goodId: good, allocatedQuantity: quantity,
    cargoWeightReserved: quantity, buyerCashReservedDest: quantity,
    fxPoolOutputReservedSource: 0, refusal: null,
  };
  return { candidate, reservation, sellers, buyers, landedGrossUnitCostDest: 1, ...overrides };
}
function budgets(
  sellers: readonly Phase7ActorResidualIntent[],
  buyers: readonly Phase7ActorResidualIntent[],
  physicalOverride?: number,
  buyerCashOverride?: number,
): Phase7ActorMatchBudgets {
  const endpoint = new Map<string, number>();
  for (const s of sellers) endpoint.set(phase7SellerEndpointKey(s.intent), physicalOverride ?? s.residualQuantity);
  const cash = new Map<string, number>();
  for (const b of buyers) cash.set(phase7BuyerActorCashKey(b.intent.actor, currency), buyerCashOverride ?? 100);
  return { sellerExportableByEndpoint: endpoint, buyerCashByActorCurrency: cash };
}
const match = (requests: readonly Phase7ActorMatchRequest[], b: Phase7ActorMatchBudgets) =>
  matchPhase7ActorIntents(requests, b, 1e-9, 1e-9, 1e-9);

describe("M5 #670 Phase-7 real owner-intent decomposition", () => {
  it("proportionally splits both sides, emits O(S+B) stable matched lots and preserves ownership/buckets", () => {
    const sa = seller("sa", 6), sb = seller("sb", 4);
    const ba = buyer("ba", 2.5), bb = buyer("bb", 7.5);
    const input = request("a", 10, [sb, sa], [bb, ba]);
    const b = budgets([sa, sb], [ba, bb]);
    const out = match([input], b);
    expect(out.lots.map((l) => [l.sellerIntentId, l.buyerIntentId, l.quantity])).toEqual([
      ["mi:sa", "mi:ba", 2.5], ["mi:sa", "mi:bb", 3.5], ["mi:sb", "mi:bb", 4],
    ]);
    expect(out.lots.every((l) => l.sellerInventoryBucket === "OUTPUT" &&
      l.buyerInventoryBucket === "GENERAL" && l.tradePlanId === "a")).toBe(true);
    expect([...out.remainingSellerByIntent.values()]).toEqual([0, 0]);
    expect([...out.remainingBuyerByIntent.values()]).toEqual([0, 0]);
    expect([...b.sellerExportableByEndpoint.values()]).toEqual([6, 4]);
    expect([...b.buyerCashByActorCurrency.values()]).toEqual([100, 100]);
  });

  it("is independent of incoming actor/plan insertion order, preserving ranked priority", () => {
    const sa = seller("sa", 8), sb = seller("sb", 8);
    const ba = buyer("ba", 8), bb = buyer("bb", 8);
    const one = request("a", 4, [sa, sb], [ba, bb]);
    const two = request("b", 4, [sb, sa], [bb, ba]);
    const balance = budgets([sa, sb], [ba, bb]);
    const left = match([two, one], balance);
    const right = match([
      { ...one, sellers: [sb, sa], buyers: [bb, ba] },
      { ...two, sellers: [sa, sb], buyers: [ba, bb] },
    ], balance);
    expect(right.lots).toEqual(left.lots);
    expect(left.lots.map((x) => x.tradePlanId)).toEqual(["a", "a", "b", "b"]);
    expect([...left.remainingSellerByIntent.values()]).toEqual([4, 4]);
  });

  it("shares one actual physical endpoint even across multiple SELL intents", () => {
    const first = seller("a", 10, "same-unit");
    const second = seller("b", 10, "same-unit");
    const buy = buyer("buyer", 20);
    const b = budgets([first, second], [buy], 10);
    expect(() => match([request("a", 11, [first, second], [buy])], b))
      .toThrow("cannot cover aggregate reservation");
    expect(b.sellerExportableByEndpoint.get(phase7SellerEndpointKey(first.intent))).toBe(10);
    const out = match([request("a", 10, [second, first], [buy])], b);
    expect(out.lots.reduce((sum, lot) => sum + lot.quantity, 0)).toBe(10);
    // Same physical stock must be shared, not monopolized by the first ID.
    expect(out.lots.map((lot) => [lot.sellerIntentId, lot.quantity])).toEqual([
      ["mi:a", 5], ["mi:b", 5],
    ]);
    expect(out.remainingSellerByEndpoint.get(phase7SellerEndpointKey(first.intent))).toBe(0);
  });

  it("shares a buyer's actual wallet across multiple BUY intents, not only regional budget", () => {
    const sell = seller("s", 20);
    const first = buyer("a", 10, "same-cohort");
    const second = buyer("b", 10, "same-cohort");
    const b = budgets([sell], [first, second], undefined, 10);
    expect(() => match([request("a", 11, [sell], [first, second])], b))
      .toThrow("cannot cover aggregate reservation");
    const out = match([request("a", 10, [sell], [second, first])], b);
    // One actual wallet also splits the available spend pro rata.
    expect(out.lots.map((lot) => [lot.buyerIntentId, lot.quantity])).toEqual([
      ["mi:a", 5], ["mi:b", 5],
    ]);
    expect(out.remainingBuyerCashByActorCurrency.get(
      phase7BuyerActorCashKey(first.intent.actor, currency))).toBe(0);
  });

  it("capacity-bounds unequal shared-stock and shared-wallet shares independent of insertion order", () => {
    const sa = seller("sa", 9, "same-unit"), sb = seller("sb", 3, "same-unit");
    const ba = buyer("ba", 9, "same-cohort"), bb = buyer("bb", 3, "same-cohort");
    const balances = budgets([sa, sb], [ba, bb], 6, 6);
    const left = match([request("a", 6, [sb, sa], [bb, ba])], balances);
    const right = match([request("a", 6, [sa, sb], [ba, bb])], balances);
    expect(right.lots).toEqual(left.lots);
    expect(left.lots.map((lot) => [lot.sellerIntentId, lot.buyerIntentId, lot.quantity])).toEqual([
      ["mi:sa", "mi:ba", 4.5], ["mi:sb", "mi:bb", 1.5],
    ]);
    expect(left.remainingSellerByIntent.get(sa.intent.id)).toBe(4.5);
    expect(left.remainingSellerByIntent.get(sb.intent.id)).toBe(1.5);
    expect(left.remainingBuyerByIntent.get(ba.intent.id)).toBe(4.5);
    expect(left.remainingBuyerByIntent.get(bb.intent.id)).toBe(1.5);
    expect(left.remainingSellerByEndpoint.get(phase7SellerEndpointKey(sa.intent))).toBe(0);
    expect(left.remainingBuyerCashByActorCurrency.get(
      phase7BuyerActorCashKey(ba.intent.actor, currency))).toBe(0);
    // Planning cannot mutate its original owner-authored balances.
    expect(balances.sellerExportableByEndpoint.get(phase7SellerEndpointKey(sa.intent))).toBe(6);
    expect(balances.buyerCashByActorCurrency.get(phase7BuyerActorCashKey(ba.intent.actor, currency))).toBe(6);
  });

  it("carries Phase-8 residuals across plans without double-selling or double-buying", () => {
    const s = seller("s", 6), b = buyer("b", 6);
    const r1 = request("a", 4, [s], [b]);
    const r2 = request("b", 2, [s], [b]);
    const shared = budgets([s], [b]);
    const out = match([r2, r1], shared);
    expect(out.lots.map((l) => [l.tradePlanId, l.quantity])).toEqual([["a", 4], ["b", 2]]);
    expect(out.remainingSellerByIntent.get(s.intent.id)).toBe(0);
    expect(out.remainingBuyerByIntent.get(b.intent.id)).toBe(0);
    expect(() => match([r1, request("b", 4, [s], [b])], shared))
      .toThrow("cannot cover aggregate reservation");
    expect(shared.sellerExportableByEndpoint.get(phase7SellerEndpointKey(s.intent))).toBe(6);
  });

  it("fails closed when positive debit cannot change a large binary64 wallet", () => {
    const s = seller("s", 1), b = buyer("b", 1);
    const cash = budgets([s], [b], undefined, 1e18);
    expect(() => match([request("a", 1, [s], [b])], cash))
      .toThrow(/lost numeric precision/);
    expect(cash.buyerCashByActorCurrency.get(
      phase7BuyerActorCashKey(b.intent.actor, currency))).toBe(1e18);
  });

  it("rejects observed binary64 over-debits in all five actor and physical residual pools", () => {
    // 1e16 - 3 changes the stock, but the observable debit is 4, not 3.
    // Each of these residual maps would otherwise claim an uncommitted unit.
    const smallSeller = seller("s", 3), smallBuyer = buyer("b", 3);
    const original = request("a", 3, [smallSeller], [smallBuyer]);
    const cases: Array<{ name: string; r: Phase7ActorMatchRequest; b: Phase7ActorMatchBudgets }> = [
      {
        name: "seller intent quantity",
        r: request("a", 3, [seller("s", 1e16)], [smallBuyer]),
        b: budgets([seller("s", 1e16)], [smallBuyer], 3),
      },
      {
        name: "physical seller endpoint",
        r: original,
        b: budgets([smallSeller], [smallBuyer], 1e16),
      },
      {
        name: "buyer intent quantity",
        r: request("a", 3, [smallSeller], [buyer("b", 1e16)]),
        b: budgets([smallSeller], [buyer("b", 1e16)]),
      },
      {
        name: "buyer intent spend",
        r: request("a", 3, [smallSeller], [{
          ...smallBuyer, intent: { ...smallBuyer.intent, maxSpend: 1e16 },
          remainingBuyerSpend: 1e16,
        }]),
        b: budgets([smallSeller], [smallBuyer]),
      },
      {
        name: "physical buyer wallet",
        r: original,
        b: budgets([smallSeller], [smallBuyer], undefined, 1e16),
      },
    ];
    for (const { name, r, b } of cases) {
      const physicalBefore = [...b.sellerExportableByEndpoint.entries()];
      const cashBefore = [...b.buyerCashByActorCurrency.entries()];
      expect(() => match([r], b), name).toThrow(/lost numeric precision/);
      expect([...b.sellerExportableByEndpoint.entries()]).toEqual(physicalBefore);
      expect([...b.buyerCashByActorCurrency.entries()]).toEqual(cashBefore);
    }
  });

  it("accepts observable exact large debits and harmless decimal rounding", () => {
    const s = seller("s", 4), b = buyer("b", 4);
    const exact = match([request("a", 4, [s], [b])], budgets([s], [b], 1e16, 1e16));
    expect(exact.remainingSellerByEndpoint.get(phase7SellerEndpointKey(s.intent))).toBe(1e16 - 4);
    expect(exact.remainingBuyerCashByActorCurrency.get(
      phase7BuyerActorCashKey(b.intent.actor, currency))).toBe(1e16 - 4);
    const decimalSeller = seller("ds", 0.3), decimalBuyer = buyer("db", 0.3);
    const decimal = match(
      [request("a", 0.1, [decimalSeller], [decimalBuyer])],
      budgets([decimalSeller], [decimalBuyer], 0.3, 0.3),
    );
    expect(decimal.lots.reduce((sum, lot) => sum + lot.quantity, 0)).toBeCloseTo(0.1);
    expect(decimal.remainingSellerByEndpoint.get(
      phase7SellerEndpointKey(decimalSeller.intent))).toBeCloseTo(0.2);
  });

  it("rejects cumulative observable wallet drift across three individually legal buyers", () => {
    const q = 0.3 + 0.3 + 0.3;
    const s = seller("sum-s", q);
    const bs = [buyer("sum-b1", 0.3), buyer("sum-b2", 0.3), buyer("sum-b3", 0.3)];
    const b = budgets([s], bs, undefined, 10_000_000);
    const originalCash = [...b.buyerCashByActorCurrency.entries()];
    const originalStock = [...b.sellerExportableByEndpoint.entries()];
    const accepted = request("a", q, [s], bs);
    // 10_000_000 - (10_000_000 - 0.3) = 0.300000000745...
    // Each <1e-9 excess is legal in isolation, three exceed it in total.
    for (const buyers of [bs, [...bs].reverse()]) {
      expect(() => match([{ ...accepted, buyers }], b))
        .toThrow(/observable actor debits cannot reconcile aggregate reservation/);
    }
    expect([...b.buyerCashByActorCurrency.entries()]).toEqual(originalCash);
    expect([...b.sellerExportableByEndpoint.entries()]).toEqual(originalStock);
  });

  it("rejects cumulative observable stock drift across three individually legal sellers", () => {
    const q = 0.3 + 0.3 + 0.3;
    const ss = [seller("sum-s1", 0.3), seller("sum-s2", 0.3), seller("sum-s3", 0.3)];
    const b = buyer("sum-b", q);
    const balances = budgets(ss, [b], 10_000_000, 100);
    const originalStock = [...balances.sellerExportableByEndpoint.entries()];
    const originalCash = [...balances.buyerCashByActorCurrency.entries()];
    const accepted = request("a", q, ss, [b]);
    for (const sellers of [ss, [...ss].reverse()]) {
      expect(() => match([{ ...accepted, sellers }], balances))
        .toThrow(/observable actor debits cannot reconcile aggregate reservation/);
    }
    expect([...balances.sellerExportableByEndpoint.entries()]).toEqual(originalStock);
    expect([...balances.buyerCashByActorCurrency.entries()]).toEqual(originalCash);
  });

  it("accepts one actor's observable decimal drift within the absolute tolerance", () => {
    const s = seller("one-s", 0.3), b = buyer("one-b", 0.3);
    const balances = budgets([s], [b], 10_000_000, 10_000_000);
    const result = match([request("a", 0.3, [s], [b])], balances);
    const physicalDebit = balances.sellerExportableByEndpoint.get(phase7SellerEndpointKey(s.intent))! -
      result.remainingSellerByEndpoint.get(phase7SellerEndpointKey(s.intent))!;
    const walletDebit = balances.buyerCashByActorCurrency.get(
      phase7BuyerActorCashKey(b.intent.actor, currency))! -
      result.remainingBuyerCashByActorCurrency.get(phase7BuyerActorCashKey(b.intent.actor, currency))!;
    expect(Math.abs(physicalDebit - 0.3)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(walletDebit - 0.3)).toBeLessThanOrEqual(1e-9);
    expect(result.lots.map((lot) => lot.quantity)).toEqual([0.3]);
    expect([...balances.sellerExportableByEndpoint.values()]).toEqual([10_000_000]);
    expect([...balances.buyerCashByActorCurrency.values()]).toEqual([10_000_000]);
  });

  it("rejects drift accumulated over multiple otherwise legal reserved plans", () => {
    const ss = ["a", "b", "c"].map((id) => seller("multi-s-" + id, 0.3));
    const bs = ["a", "b", "c"].map((id) => buyer("multi-b-" + id, 0.3));
    const balances = budgets(ss, bs, 10_000_000, 10_000_000);
    const originalStock = [...balances.sellerExportableByEndpoint.entries()];
    const originalCash = [...balances.buyerCashByActorCurrency.entries()];
    const plans = ss.map((s, i) => request(["a", "b", "c"][i]!, 0.3, [s], [bs[i]!]));
    for (const incoming of [plans, [...plans].reverse()]) {
      expect(() => match(incoming, balances))
        .toThrow(/cumulative observable actor debits cannot reconcile reservations/);
    }
    expect([...balances.sellerExportableByEndpoint.entries()]).toEqual(originalStock);
    expect([...balances.buyerCashByActorCurrency.entries()]).toEqual(originalCash);
  });

  it("requires separately resolved quantity and money tolerances", () => {
    const s = seller("s", 2), b = buyer("b", 2), r = request("a", 1, [s], [b]);
    expect(() => matchPhase7ActorIntents([r], budgets([s], [b]), 1e-8, 1e-9, NaN))
      .toThrow(/requires resolved numeric epsilons/);
    expect(() => matchPhase7ActorIntents([r], budgets([s], [b]), 1e-8, 1e-9, -1))
      .toThrow(/requires resolved numeric epsilons/);
  });

  it("binds buyer actor charges to the accepted regional cash reservation", () => {
    const s = seller("s", 2), ba = buyer("ba", 1), bb = buyer("bb", 1);
    const seed = request("a", 2, [s], [ba, bb]);
    const accepted = {
      ...seed,
      landedGrossUnitCostDest: 2,
      reservation: { ...seed.reservation, buyerCashReservedDest: 4 },
    };
    const b = budgets([s], [ba, bb]);
    const out = match([accepted], b);
    expect(out.lots.map((lot) => [lot.buyerIntentId, lot.quantity])).toEqual([
      ["mi:ba", 1], ["mi:bb", 1],
    ]);
    expect([...out.remainingBuyerCashByActorCurrency.values()]).toEqual([98, 98]);

    // A stale actor quote must never spend more than the regional reservation,
    // even if the concrete buyer owns plenty of cash.
    const mismatched = [
      { ...accepted, reservation: { ...accepted.reservation, buyerCashReservedDest: 1 } },
      { ...accepted, reservation: { ...accepted.reservation, buyerCashReservedDest: 5 } },
      { ...accepted, landedGrossUnitCostDest: 3 },
      { ...accepted, reservation: { ...accepted.reservation, buyerCashReservedDest: NaN } },
      { ...accepted, reservation: { ...accepted.reservation, buyerCashReservedDest: -1 } },
      { ...accepted, reservation: { ...accepted.reservation, buyerCashReservedDest: Infinity } },
    ];
    const originalEndpoint = [...b.sellerExportableByEndpoint.entries()];
    const originalCash = [...b.buyerCashByActorCurrency.entries()];
    for (const bad of mismatched) {
      expect(() => match([bad], b)).toThrow(/reserved buyer cash|does not match accepted aggregate reservation/);
      expect([...b.sellerExportableByEndpoint.entries()]).toEqual(originalEndpoint);
      expect([...b.buyerCashByActorCurrency.entries()]).toEqual(originalCash);
    }
    // Refused or zero-allocation plans cannot carry even sub-epsilon cash
    // reservations: the upstream aggregate producer always emits exact zero.
    const zero = request("a", 0, [s], [ba]);
    const staleZero = {
      ...zero, reservation: { ...zero.reservation, buyerCashReservedDest: 5e-10 },
    };
    expect(() => match([staleZero], b)).toThrow(/does not match accepted aggregate reservation/);
    // Ordinary sub-epsilon binary64 cash rounding remains permissible.
    const rounded = {
      ...accepted, reservation: { ...accepted.reservation, buyerCashReservedDest: 4 + 5e-10 },
    };
    expect(match([rounded], b).lots).toEqual(out.lots);
  });

  it("requires the owner-verified post-Phase-4 unspent BUY commitment, not original maxSpend or wallet cash", () => {
    const s = seller("post4-s", 2);
    const original = buyer("post4-b", 4);
    const spentInPhase4 = {
      ...original,
      intent: { ...original.intent, maxSpend: 10 },
      residualQuantity: 2,
      remainingBuyerSpend: 2, // Phase 4 spent 8 of this intent's planned 10.
    };
    const base = request("a", 2, [s], [spentInPhase4]);
    const accepted = {
      ...base, landedGrossUnitCostDest: 2,
      reservation: { ...base.reservation, buyerCashReservedDest: 4 },
    };
    const shared = budgets([s], [spentInPhase4], undefined, 100);
    const beforeEndpoint = [...shared.sellerExportableByEndpoint.entries()];
    const beforeCash = [...shared.buyerCashByActorCurrency.entries()];
    // Two units at 2 each cannot fit the verified residual commitment of 2,
    // even though the actor still physically owns 100 currency units.
    expect(() => match([accepted], shared)).toThrow(/cannot cover aggregate reservation/);
    // Fail closed on absent, forged, or nonfinite owner evidence.
    for (const invalid of [
      { intent: spentInPhase4.intent, residualQuantity: spentInPhase4.residualQuantity },
      { ...spentInPhase4, remainingBuyerSpend: NaN },
      { ...spentInPhase4, remainingBuyerSpend: -1 },
      { ...spentInPhase4, remainingBuyerSpend: 11 },
    ]) {
      const plan = { ...accepted, buyers: [invalid] };
      expect(() => match([plan], shared)).toThrow(/remaining spend/);
    }
    expect([...shared.sellerExportableByEndpoint.entries()]).toEqual(beforeEndpoint);
    expect([...shared.buyerCashByActorCurrency.entries()]).toEqual(beforeCash);

    const unspent = { ...spentInPhase4, remainingBuyerSpend: 10 };
    const goodPlan = { ...accepted, buyers: [unspent] };
    const out = match([goodPlan], budgets([s], [unspent], undefined, 100));
    expect(out.lots.map((lot) => lot.quantity)).toEqual([2]);
    expect(out.remainingBuyerSpendByIntent.get(unspent.intent.id)).toBe(6);
  });

  it("spends the same verified BUY-intent envelope only once across ranked trade plans", () => {
    const s = seller("multi-s", 6);
    const original = buyer("multi-b", 6);
    const b = {
      ...original,
      intent: { ...original.intent, maxSpend: 10 },
      remainingBuyerSpend: 5,
    };
    const balances = budgets([s], [b], undefined, 100);
    const valid = match([
      request("b", 2, [s], [b]), request("a", 3, [s], [b]),
    ], balances);
    expect(valid.lots.map((lot) => [lot.tradePlanId, lot.quantity])).toEqual([
      ["a", 3], ["b", 2],
    ]);
    expect(valid.remainingBuyerByIntent.get(b.intent.id)).toBe(1);
    expect(valid.remainingBuyerSpendByIntent.get(b.intent.id)).toBe(0);
    expect(() => match([
      request("a", 3, [s], [b]), request("b", 3, [s], [b]),
    ], balances)).toThrow(/cannot cover aggregate reservation/);
    expect([...balances.buyerCashByActorCurrency.values()]).toEqual([100]);
  });

  it("rejects wrong-side/region, unknown endpoint and forged aggregate reservations before matching", () => {
    const s = seller("s", 10), b = buyer("b", 10);
    const valid = request("a", 3, [s], [b]);
    const balances = budgets([s], [b]);
    expect(() => match([{ ...valid, sellers: [b] }], balances))
      .toThrow("side, region, good or residual mismatch");
    expect(() => match([valid], { ...balances, sellerExportableByEndpoint: new Map() }))
      .toThrow("missing explicit seller endpoint");
    expect(() => match([{ ...valid, reservation: { ...valid.reservation, linkId: "link:wrong" as TransportLinkId } }], balances))
      .toThrow("does not match accepted aggregate reservation");
    expect(() => match([{ ...valid, reservation: { ...valid.reservation, refusal: "LINK_UNUSABLE" } }], balances))
      .toThrow("does not match accepted aggregate reservation");
  });

  it("keeps refused zero-quantity plans empty with untouched physical/cash balances", () => {
    const s = seller("s", 4), b = buyer("b", 4);
    const r = request("a", 0, [s], [b]);
    const refused = { ...r, reservation: { ...r.reservation, refusal: "INSUFFICIENT_SHARED_RESIDUAL" as const } };
    const balances = budgets([s], [b]);
    const out = match([refused], balances);
    expect(out.lots).toEqual([]);
    expect(out.remainingSellerByEndpoint).toEqual(balances.sellerExportableByEndpoint);
    expect(out.remainingBuyerCashByActorCurrency).toEqual(balances.buyerCashByActorCurrency);
  });
});
