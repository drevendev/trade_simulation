import { describe, expect, it } from "vitest";
import type { CohortId, CurrencyId, GoodId, ProductionUnitId, RegionId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import {
  matchPhase7ActorIntents, previewPhase7PreFxActorDemand,
  phase7BuyerActorCashKey, phase7SellerEndpointKey,
  type Phase7ActorResidualIntent, type Phase7ActorMatchBudgets,
  type Phase7PreFxActorDemandRequest,
} from "./phase7IntentMatching";

const origin = "r:foreign" as RegionId;
const domestic = "r:domestic" as RegionId;
const dest = "r:destination" as RegionId;
const good = "good:wood" as GoodId;
const foreignCurrency = "cur:foreign" as CurrencyId;
const currency = "cur:local" as CurrencyId;
const eps = 1e-9;

function seller(id: string, region = origin): Phase7ActorResidualIntent {
  const intent: MarketIntent = {
    id: createMarketIntentId("mi:" + id),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: ("pu:" + id) as ProductionUnitId },
    regionId: region, goodId: good, side: "SELL", purpose: "INVENTORY_REBALANCE",
    desiredQuantity: 20, minimumReserveQuantity: 0, inventoryBucket: "OUTPUT",
    sourcePlanId: "plan:" + id,
  };
  return { intent, residualQuantity: 20 };
}

function buyer(id: string, spend = 100, residualQuantity = 20): Phase7ActorResidualIntent {
  const intent: MarketIntent = {
    id: createMarketIntentId("mi:" + id),
    actor: { type: "COHORT", cohortId: "coh:shared" as CohortId },
    regionId: dest, goodId: good, side: "BUY", purpose: "CONSUMPTION",
    desiredQuantity: 20, maxSpend: 100, sourcePlanId: "plan:" + id,
  };
  return { intent, residualQuantity, remainingBuyerSpend: spend };
}

function request(id: string, s: Phase7ActorResidualIntent, b: Phase7ActorResidualIntent,
  score = 1, desiredRegionalQuantity = 10): Phase7PreFxActorDemandRequest {
  return {
    candidate: {
      tradePlanId: id, linkId: ("link:" + id) as TransportLinkId,
      originRegionId: s.intent.regionId, destinationRegionId: dest, goodId: good,
      sourceCurrencyId: s.intent.regionId === domestic ? currency : foreignCurrency,
      destinationCurrencyId: currency, sourceSellerNetUnitPrice: 1,
      destinationReferenceNetUnitPrice: 2, estimatedTransportUnitCostDest: 0,
      estimatedTariffRate: 0, estimatedFxInputPerSourceCurrency: 1,
      shortageRateDestination: 0.2, score, maximumOwnQuantity: 20,
    },
    sellers: [s], buyers: [b], landedGrossUnitCostDest: 1, desiredRegionalQuantity,
  };
}

function budgets(sellers: readonly Phase7ActorResidualIntent[], b: Phase7ActorResidualIntent,
  stock: number, cash: number): Phase7ActorMatchBudgets {
  return {
    sellerExportableByEndpoint: new Map(sellers.map(s => [phase7SellerEndpointKey(s.intent), stock])),
    buyerCashByActorCurrency: new Map([[phase7BuyerActorCashKey(b.intent.actor, currency), cash]]),
  };
}

const preview = (requests: readonly Phase7PreFxActorDemandRequest[], b: Phase7ActorMatchBudgets,
  minimum = 1) => previewPhase7PreFxActorDemand(requests, b, eps, eps, eps, minimum);

describe("M5 pre-FX actor demand preview", () => {
  it("feeds back domestic and refused routes before matching the next regional ceiling", () => {
    const d = seller("local", domestic), f = seller("foreign");
    const b = buyer("shared");
    const base = budgets([d, f], b, 20, 12);
    const balance: Phase7ActorMatchBudgets = {
      ...base,
      sellerExportableByEndpoint: new Map([
        [phase7SellerEndpointKey(d.intent), 2],
        [phase7SellerEndpointKey(f.intent), 20],
      ]),
    };
    const local = request("local", d, b, 4);
    const tiny = request("tiny", f, b, 3);
    const zero = request("zero", f, b, 2);
    const foreign = request("foreign", f, b, 1);
    const before = JSON.stringify(Object.values(balance).map(map => [...map]));
    const run = (requests: readonly Phase7PreFxActorDemandRequest[]) => {
      let regionalRemaining = 8;
      const trace: [string, string, number][] = [];
      const lots = previewPhase7PreFxActorDemand(requests, balance, eps, eps, eps, 1, {
        resolveRegionalCeiling: (id, ownCeiling) => {
          trace.push(["resolve", id, regionalRemaining]);
          return Math.min(ownCeiling, regionalRemaining, id === "tiny" ? 0.5 :
            id === "zero" ? 0 : Infinity);
        },
        recordMatchedQuantity: (id, quantity) => {
          trace.push(["record", id, quantity]);
          regionalRemaining -= quantity;
        },
      });
      return { lots, trace, regionalRemaining };
    };
    const result = run([foreign, tiny, local, zero]);
    expect(result.trace).toEqual([
      ["resolve", "local", 8], ["record", "local", 2],
      ["resolve", "tiny", 6], ["record", "tiny", 0],
      ["resolve", "zero", 6], ["record", "zero", 0],
      ["resolve", "foreign", 6], ["record", "foreign", 6],
    ]);
    expect(result.regionalRemaining).toBe(0);
    expect(result.lots.map(lot => [lot.tradePlanId, lot.desiredQuantity])).toEqual([["foreign", 6]]);
    expect(run([local, zero, foreign, tiny])).toEqual(result);
    expect(JSON.stringify(Object.values(balance).map(map => [...map]))).toBe(before);
    expect(preview([local, foreign], balance).map(lot => lot.desiredQuantity)).toEqual([10]);
  });

  it("reports a zero actor match and carries shared wallet residuals into subsequent routes", () => {
    const s = seller("s"), b = buyer("b");
    const balance = budgets([s], b, 20, 3);
    const trace: [string, number][] = [];
    const lots = previewPhase7PreFxActorDemand([
      request("later", s, b, 1), request("first", s, b, 2),
    ], balance, eps, eps, eps, 1, {
      resolveRegionalCeiling: (_id, cap) => cap,
      recordMatchedQuantity: (id, quantity) => { trace.push([id, quantity]); },
    });
    expect(trace).toEqual([["first", 3], ["later", 0]]);
    expect(lots.map(lot => [lot.tradePlanId, lot.desiredQuantity])).toEqual([["first", 3]]);
  });

  it.each([-1, NaN, Infinity, 11])("rejects invalid or enlarged feedback ceiling %s", cap => {
    const s = seller("s"), b = buyer("b");
    const balance = budgets([s], b, 20, 20);
    const before = JSON.stringify(Object.values(balance).map(map => [...map]));
    const records: number[] = [];
    expect(() => previewPhase7PreFxActorDemand([request("a", s, b)], balance,
      eps, eps, eps, 1, {
        resolveRegionalCeiling: () => cap,
        recordMatchedQuantity: (_id, quantity) => { records.push(quantity); },
      })).toThrow(/feedback regional ceiling/);
    expect(records).toEqual([]);
    expect(JSON.stringify(Object.values(balance).map(map => [...map]))).toBe(before);
  });

  it.each([
    { stock: 12, cash: 100, spend: 100, demand: 20 },
    { stock: 100, cash: 12, spend: 100, demand: 20 },
    { stock: 100, cash: 100, spend: 12, demand: 20 },
    { stock: 100, cash: 100, spend: 100, demand: 12 },
  ])("shares independent actor limits across ranked plans (%j)", ({ stock, cash, spend, demand }) => {
    const s = seller("seller"), b = buyer("buyer", spend, demand);
    const balance = budgets([s], b, stock, cash);
    const a = request("a", s, b, 2), z = request("z", s, b);
    const before = JSON.stringify(Object.values(balance).map(map => [...map]));
    const lots = preview([z, a], balance);
    expect(lots.map(l => [l.tradePlanId, l.desiredQuantity])).toEqual([["a", 10], ["z", 2]]);
    expect(lots[0]).toEqual({
      tradePlanId: "a", sellerIntentId: s.intent.id, buyerIntentId: b.intent.id,
      sourceCurrencyId: foreignCurrency, destinationCurrencyId: currency, desiredQuantity: 10,
    });
    expect(Object.isFrozen(lots)).toBe(true);
    expect(Object.isFrozen(lots[0])).toBe(true);
    expect(preview([a, z], balance)).toEqual(lots);
    expect(JSON.stringify(Object.values(balance).map(map => [...map]))).toBe(before);
  });

  it("domestic demand competes for a shared wallet but never emits foreign evidence", () => {
    const d = seller("domestic", domestic), f = seller("foreign");
    const b = buyer("foreign-buyer"), other = buyer("domestic-buyer");
    const balance = budgets([d, f], b, 20, 12);
    const foreign = request("foreign", f, b), local = request("local", d, other, 2);
    expect(preview([foreign, local], balance).map(l => [l.tradePlanId, l.desiredQuantity]))
      .toEqual([["foreign", 2]]);
    expect(preview([local, foreign], balance, 3)).toEqual([]);
    expect(preview([foreign], budgets([f], b, 20, 0))).toEqual([]);
  });

  it.each([
    { cash: 1.08, spend: 100 },
    { cash: 100, spend: 1.08 },
  ])("clips fractional cash or intent spend without relaxing strict production (%j)", ({ cash, spend }) => {
    const s = seller("s"), b = buyer("b", spend);
    const balance = budgets([s], b, 20, cash);
    const before = JSON.stringify(Object.values(balance).map(map => [...map]));
    const r = { ...request("foreign", s, b), landedGrossUnitCostDest: 1.07 };
    const cap = Math.min(cash, spend);
    const unsafe = cap / r.landedGrossUnitCostDest;
    expect(unsafe * r.landedGrossUnitCostDest).toBeGreaterThan(cap);
    const lots = preview([r], balance);
    expect(lots).toHaveLength(1);
    const quantity = lots[0]!.desiredQuantity;
    expect(quantity).toBeGreaterThanOrEqual(1);
    expect(quantity).toBeCloseTo(unsafe, 12);
    expect(quantity * r.landedGrossUnitCostDest).toBeLessThanOrEqual(cap);
    // The next lower representable quantity falls below this minimum.
    expect(preview([r], balance, unsafe)).toEqual([]);
    expect(() => matchPhase7ActorIntents([{
      ...r, reservation: {
        tradePlanId: r.candidate.tradePlanId, linkId: r.candidate.linkId, goodId: good,
        allocatedQuantity: unsafe, cargoWeightReserved: unsafe,
        buyerCashReservedDest: unsafe * r.landedGrossUnitCostDest,
        fxPoolOutputReservedSource: unsafe, refusal: null,
      },
    }], balance, eps, eps, eps)).toThrow("overdraw");
    expect(JSON.stringify(Object.values(balance).map(map => [...map]))).toBe(before);
  });

  it("rechecks grouped wallet payments after proportional splitting", () => {
    const s = seller("s"), a = buyer("a"), b = buyer("b");
    const balance = budgets([s], a, 20, 2.16);
    const r = { ...request("foreign", s, a), buyers: [b, a], landedGrossUnitCostDest: 1.07 };
    const before = JSON.stringify(Object.values(balance).map(map => [...map]));
    const unsafe = 2.16 / r.landedGrossUnitCostDest;
    const unsafePayment = (unsafe / 2) * r.landedGrossUnitCostDest;
    expect(unsafePayment + unsafePayment).toBeGreaterThan(2.16);
    const lots = preview([r], balance);
    expect(lots).toHaveLength(2);
    const quantity = lots.reduce((sum, lot) => sum + lot.desiredQuantity, 0);
    const payment = lots.reduce((sum, lot) => sum + lot.desiredQuantity * r.landedGrossUnitCostDest, 0);
    expect(quantity).toBeCloseTo(unsafe, 12);
    expect(payment).toBeLessThanOrEqual(2.16);
    expect(lots.every(lot => lot.desiredQuantity >= 1)).toBe(true);
    expect(preview([{ ...r, buyers: [a, b] }], balance)).toEqual(lots);
    expect(JSON.stringify(Object.values(balance).map(map => [...map]))).toBe(before);
  });

  it("rounds shared seller endpoint fills down without relaxing strict production", () => {
    const a = seller("a"), rawB = seller("b"), rawC = seller("c");
    const b = { ...rawB, intent: { ...rawB.intent, actor: a.intent.actor } };
    const c = { ...rawC, intent: { ...rawC.intent, actor: a.intent.actor } };
    const buyerIntent = buyer("buyer");
    const stock = 1.05;
    const balance = budgets([a, b, c], buyerIntent, stock, 100);
    const before = JSON.stringify(Object.values(balance).map(map => [...map]));
    const r = { ...request("foreign", a, buyerIntent), sellers: [c, a, b] };
    const share = stock * (20 / 60);
    const unsafe = (share + (stock - (share + share + share))) + share + share;
    expect(unsafe).toBeGreaterThan(stock);
    const lots = preview([r], balance);
    expect(lots).toHaveLength(3);
    const quantity = lots.reduce((sum, lot) => sum + lot.desiredQuantity, 0);
    expect(quantity).toBeGreaterThanOrEqual(1);
    expect(quantity).toBeCloseTo(stock, 12);
    expect(quantity).toBeLessThanOrEqual(stock);
    expect(preview([{ ...r, sellers: [a, b, c] }], balance)).toEqual(lots);
    expect(preview([r], balance, unsafe)).toEqual([]);
    expect(() => matchPhase7ActorIntents([{
      ...r, reservation: {
        tradePlanId: r.candidate.tradePlanId, linkId: r.candidate.linkId, goodId: good,
        allocatedQuantity: unsafe, cargoWeightReserved: unsafe,
        buyerCashReservedDest: unsafe, fxPoolOutputReservedSource: unsafe, refusal: null,
      },
    }], balance, eps, eps, eps)).toThrow("seller physical endpoint overdraw");
    expect(JSON.stringify(Object.values(balance).map(map => [...map]))).toBe(before);
  });

  it("never relaxes the production matcher's strict aggregate reservation", () => {
    const s = seller("s"), b = buyer("b");
    const balance = budgets([s], b, 3, 100);
    const r = request("foreign", s, b);
    expect(preview([r], balance)[0]?.desiredQuantity).toBe(3);
    expect(() => matchPhase7ActorIntents([{
      ...r, reservation: {
        tradePlanId: r.candidate.tradePlanId, linkId: r.candidate.linkId, goodId: good,
        allocatedQuantity: 10, cargoWeightReserved: 10, buyerCashReservedDest: 10,
        fxPoolOutputReservedSource: 10, refusal: null,
      },
    }], balance, eps, eps, eps)).toThrow("cannot cover aggregate reservation");
  });
});
