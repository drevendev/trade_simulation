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
