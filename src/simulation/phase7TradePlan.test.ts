/** M5 #673: candidate -> shared reservations -> real-actor intent matching. */
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId, ProductionUnitId, TransportLinkId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import {
  phase7RegionCashKey, phase7RegionGoodKey,
  type Phase7AggregateBudgets,
} from "./phase7AggregateReservation";
import {
  phase7BuyerActorCashKey, phase7SellerEndpointKey,
  type Phase7ActorMatchBudgets,
  type Phase7ActorResidualIntent,
} from "./phase7IntentMatching";
import {
  preparePhase7TradePlan,
  type Phase7PreparedTradePlanInput,
} from "./phase7TradePlan";
import type { Phase7CandidateEvidence } from "./tradeCandidateSelection";
import { buildInitialWorld } from "./worldState";

const config = createDefaultSimulationConfig();
const base = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 77);
const originalLink = [...base.transportLinks.values()].find((link) =>
  base.regions.get(link.fromRegionId)!.settlementCurrencyId ===
  base.regions.get(link.toRegionId)!.settlementCurrencyId,
)!;
const foreignLink = [...base.transportLinks.values()].find((link) =>
  base.regions.get(link.fromRegionId)!.settlementCurrencyId !==
  base.regions.get(link.toRegionId)!.settlementCurrencyId,
)!;
if (!originalLink || !foreignLink) throw new Error("M5 fixture needs both currency routes");
const link = {
  ...originalLink,
  seed: { ...originalLink.seed, baseCapacity: 100, condition: 1 },
};
const world = { regions: base.regions, transportLinks: new Map([[link.linkId, link]]) };
const wood = "good:wood" as GoodId;
const iron = "good:iron" as GoodId;
const currency = base.regions.get(link.toRegionId)!.settlementCurrencyId;

function opportunity(name: string, goodId: GoodId, referenceGross: number): Phase7CandidateEvidence {
  return {
    planId: name, linkId: link.linkId,
    originRegionId: link.fromRegionId, destinationRegionId: link.toRegionId,
    goodId, authorizedAtPhase1: true,
    exportableQuantity: 10, residualImportDemandQuantity: 10,
    buyerRemainingBudgetDest: 10, cargoWeightPerUnit: 1,
    destinationReferenceGrossUnitPrice: referenceGross,
    landedGrossUnitCostDest: 2,
    sourceSellerNetUnitPrice: 1, destinationReferenceNetUnitPrice: referenceGross,
    estimatedTransportUnitCostDest: 1, estimatedTariffRate: 0,
    estimatedFxInputPerSourceCurrency: 1, shortageRateDestination: 0.2,
  };
}
function seller(name: string, goodId: GoodId): Phase7ActorResidualIntent {
  const intent: MarketIntent = {
    id: createMarketIntentId("mi:seller-" + name),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: ("pu:" + name) as ProductionUnitId },
    regionId: link.fromRegionId, goodId, side: "SELL", purpose: "INVENTORY_REBALANCE",
    desiredQuantity: 10, minimumReserveQuantity: 0, inventoryBucket: "OUTPUT",
    sourcePlanId: "plan:seller-" + name,
  };
  return { intent, residualQuantity: 10 };
}
function buyer(name: string, goodId: GoodId): Phase7ActorResidualIntent {
  const intent: MarketIntent = {
    id: createMarketIntentId("mi:buyer-" + name),
    actor: { type: "COHORT", cohortId: ("coh:" + name) as CohortId },
    regionId: link.toRegionId, goodId, side: "BUY", purpose: "CONSUMPTION",
    desiredQuantity: 10, maxSpend: 20, sourcePlanId: "plan:buyer-" + name,
  };
  return { intent, residualQuantity: 10, remainingBuyerSpend: 20 };
}
function fixture(reverse = false): Phase7PreparedTradePlanInput {
  const high = opportunity("plan:high", wood, 20);
  const low = opportunity("plan:low", iron, 4);
  const ws = seller("high", wood), wi = seller("low", iron);
  const bw = buyer("high", wood), bi = buyer("low", iron);
  const groups = [
    [high.planId, { sellers: [ws], buyers: [bw] }],
    [low.planId, { sellers: [wi], buyers: [bi] }],
  ] as const;
  const aggregateBudgets: Phase7AggregateBudgets = {
    exportableByOriginGood: new Map([
      [phase7RegionGoodKey(link.fromRegionId, wood), 10],
      [phase7RegionGoodKey(link.fromRegionId, iron), 10],
    ]),
    importDemandByDestinationGood: new Map([
      [phase7RegionGoodKey(link.toRegionId, wood), 10],
      [phase7RegionGoodKey(link.toRegionId, iron), 10],
    ]),
    buyerCashByDestinationCurrency: new Map([
      [phase7RegionCashKey(link.toRegionId, currency), 10],
    ]),
    fxOutputByPairCurrency: new Map(),
  };
  const actorBudgets: Phase7ActorMatchBudgets = {
    sellerExportableByEndpoint: new Map([
      [phase7SellerEndpointKey(ws.intent), 10], [phase7SellerEndpointKey(wi.intent), 10],
    ]),
    buyerCashByActorCurrency: new Map([
      [phase7BuyerActorCashKey(bw.intent.actor, currency), 10],
      [phase7BuyerActorCashKey(bi.intent.actor, currency), 10],
    ]),
  };
  return {
    opportunities: reverse ? [low, high] : [high, low],
    scorePolicy: {
      tradeProfitWeight: 1, shortageWeight: 1,
      minimumTradeScore: 0.05, maximumShortagePremiumShare: 0.25,
    },
    infrastructureFactors: new Map([[link.linkId, 1]]),
    eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>([link.linkId]),
    aggregateBudgets, actorBudgets,
    actorsByTradePlanId: new Map(reverse ? [...groups].reverse() : groups),
  };
}
describe("M5 Phase-7 prepared deterministic trade plan (#673)", () => {
  it("ranks before reserving shared buyer cash and produces concrete owner-bound lots", () => {
    const input = fixture(true);
    const result = preparePhase7TradePlan(world, config, input);
    expect(result.rankedCandidates.map((candidate) => candidate.tradePlanId))
      .toEqual(["plan:high", "plan:low"]);
    expect(result.aggregate.reservations.map((reservation) =>
      [reservation.tradePlanId, reservation.allocatedQuantity]))
      .toEqual([["plan:high", 5], ["plan:low", 0]]);
    expect(result.actorMatches.lots.map((lot) =>
      [lot.tradePlanId, lot.sellerInventoryBucket, lot.buyerInventoryBucket, lot.quantity]))
      .toEqual([["plan:high", "OUTPUT", "GENERAL", 5]]);
    expect(result.aggregate.remainingBuyerCashByDestinationCurrency.get(
      phase7RegionCashKey(link.toRegionId, currency))).toBe(0);
    expect(input.aggregateBudgets.buyerCashByDestinationCurrency.get(
      phase7RegionCashKey(link.toRegionId, currency))).toBe(10);
    expect(input.actorBudgets.buyerCashByActorCurrency.size).toBe(2);
    expect(base.shipments?.size ?? 0).toBe(0);
  });

  it("is independent of candidate and actor-group map insertion order", () => {
    const a = preparePhase7TradePlan(world, config, fixture(false));
    const b = preparePhase7TradePlan(world, config, fixture(true));
    expect(a.rankedCandidates).toEqual(b.rankedCandidates);
    expect(a.aggregate.reservations).toEqual(b.aggregate.reservations);
    expect(a.actorMatches.lots).toEqual(b.actorMatches.lots);
  });

  it("fails closed if a regional reservation has no real actor cash or seller stock", () => {
    const input = fixture();
    const first = input.actorsByTradePlanId.get("plan:high")!;
    const key = phase7SellerEndpointKey(first.sellers[0]!.intent);
    const shortStock = {
      ...input, actorBudgets: {
        ...input.actorBudgets,
        sellerExportableByEndpoint: new Map([[key, 2],
          ...[...input.actorBudgets.sellerExportableByEndpoint].filter(([k]) => k !== key)]),
      },
    };
    expect(() => preparePhase7TradePlan(world, config, shortStock))
      .toThrow("cannot cover aggregate reservation");
    expect(input.actorBudgets.sellerExportableByEndpoint.get(key)).toBe(10);
    const noBuyerCash = {
      ...input, actorBudgets: {
        ...input.actorBudgets, buyerCashByActorCurrency: new Map(),
      },
    };
    expect(() => preparePhase7TradePlan(world, config, noBuyerCash))
      .toThrow("missing explicit buyer actor cash");
  });

  it("rejects missing selected-plan actor evidence without making any reservation canonical", () => {
    const input = fixture();
    const bad = {
      ...input,
      actorsByTradePlanId: new Map([["plan:low", input.actorsByTradePlanId.get("plan:low")!]]),
    };
    expect(() => preparePhase7TradePlan(world, config, bad))
      .toThrow("lacks reservation or actor residual evidence");
    expect(input.aggregateBudgets.buyerCashByDestinationCurrency.get(
      phase7RegionCashKey(link.toRegionId, currency))).toBe(10);
  });
});
