import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ShipmentId, TransportLinkId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import {
  phase7RegionCashKey, phase7RegionGoodKey,
} from "./phase7AggregateReservation";
import {
  phase7BuyerActorCashKey, phase7SellerEndpointKey,
} from "./phase7IntentMatching";
import {
  executePreparedSameCurrencyTradePlan,
  type Phase7SameCurrencyExecutionInput,
} from "./phase7PreparedSameCurrencyExecution";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;
const config = createDefaultSimulationConfig();

function fixture() {
  const root = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 87);
  const cohorts = [...root.cohorts.values()];
  const link = [...root.transportLinks.values()].find((candidate) => {
    const from = root.regions.get(candidate.fromRegionId);
    const to = root.regions.get(candidate.toRegionId);
    return from && to && candidate.travelTicks !== undefined &&
      from.settlementCurrencyId === to.settlementCurrencyId &&
      to.controllerStateId !== null &&
      cohorts.some((c) => c.seed.regionKey === from.seed.key) &&
      cohorts.some((c) => c.seed.regionKey === to.seed.key);
  });
  if (!link || link.travelTicks === undefined) throw new Error("same-currency route fixture missing");
  const origin = root.regions.get(link.fromRegionId)!;
  const dest = root.regions.get(link.toRegionId)!;
  const sellerCohort = cohorts.find((c) => c.seed.regionKey === origin.seed.key)!;
  const buyerCohort = cohorts.find((c) => c.seed.regionKey === dest.seed.key)!;
  const receiver = cohorts.find((c) =>
    c.cohortId !== buyerCohort.cohortId && c.cohortId !== sellerCohort.cohortId)!;
  const seller: ActorRef = { type: "COHORT", cohortId: sellerCohort.cohortId };
  const buyer: ActorRef = { type: "COHORT", cohortId: buyerCohort.cohortId };
  const currency = dest.settlementCurrencyId;
  const cohortsNext = new Map(root.cohorts);
  cohortsNext.set(sellerCohort.cohortId, {
    ...sellerCohort,
    householdInventory: new Map(sellerCohort.householdInventory).set(GOOD, 10),
    wallet: new Map(sellerCohort.wallet).set(currency, 5),
  });
  cohortsNext.set(buyerCohort.cohortId, {
    ...buyerCohort,
    wallet: new Map(buyerCohort.wallet).set(currency, 100),
  });
  cohortsNext.set(receiver.cohortId, {
    ...receiver,
    wallet: new Map(receiver.wallet).set(currency, 1),
  });
  const world: WorldState = {
    ...root,
    cohorts: cohortsNext,
    transportLinks: new Map(root.transportLinks).set(link.linkId, {
      ...link, feeReceiver: { type: "COHORT", cohortId: receiver.cohortId },
    }),
  };
  const sellerIntent: MarketIntent = {
    id: createMarketIntentId("mi:87:sell"),
    actor: seller, regionId: origin.regionId, goodId: GOOD,
    side: "SELL", purpose: "INVENTORY_REBALANCE",
    desiredQuantity: 5, minimumReserveQuantity: 0,
    sourcePlanId: "plan:87:sell",
  };
  const buyerIntent: MarketIntent = {
    id: createMarketIntentId("mi:87:buy"),
    actor: buyer, regionId: dest.regionId, goodId: GOOD,
    side: "BUY", purpose: "CONSUMPTION",
    desiredQuantity: 5, maxSpend: 20, sourcePlanId: "plan:87:buy",
  };
  const planId = "plan:87:trade";
  const input: Phase7SameCurrencyExecutionInput = {
    tick: 87,
    planInput: {
      opportunities: [{
        planId, linkId: link.linkId, originRegionId: origin.regionId,
        destinationRegionId: dest.regionId, goodId: GOOD,
        authorizedAtPhase1: true,
        exportableQuantity: 2, residualImportDemandQuantity: 2,
        buyerRemainingBudgetDest: 20, cargoWeightPerUnit: 1,
        destinationReferenceGrossUnitPrice: 12,
        landedGrossUnitCostDest: 4,
        sourceSellerNetUnitPrice: 3, destinationReferenceNetUnitPrice: 12,
        estimatedTransportUnitCostDest: 0.5, estimatedTariffRate: 0.1,
        estimatedFxInputPerSourceCurrency: 1, shortageRateDestination: 0.2,
      }],
      scorePolicy: {
        tradeProfitWeight: 1, shortageWeight: 1,
        minimumTradeScore: 0.05, maximumShortagePremiumShare: 0.25,
      },
      infrastructureFactors: new Map([[link.linkId, 1]]),
      eligibleDirectedLinkIdsAtPhase1: new Set<TransportLinkId>([link.linkId]),
      aggregateBudgets: {
        exportableByOriginGood: new Map([
          [phase7RegionGoodKey(origin.regionId, GOOD), 2],
        ]),
        importDemandByDestinationGood: new Map([
          [phase7RegionGoodKey(dest.regionId, GOOD), 2],
        ]),
        buyerCashByDestinationCurrency: new Map([
          [phase7RegionCashKey(dest.regionId, currency), 20],
        ]),
        fxOutputByPairCurrency: new Map(),
      },
      actorBudgets: {
        sellerExportableByEndpoint: new Map([[phase7SellerEndpointKey(sellerIntent), 2]]),
        buyerCashByActorCurrency: new Map([
          [phase7BuyerActorCashKey(buyer, currency), 100],
        ]),
      },
      actorsByTradePlanId: new Map([[planId, {
        sellers: [{ intent: sellerIntent, residualQuantity: 5 }],
        buyers: [{ intent: buyerIntent, residualQuantity: 5, remainingBuyerSpend: 20 }],
      }]]),
    },
    termsByTradePlanId: new Map([[planId, {
      sellerNetUnitPrice: 3, transportFeePerUnitDest: 0.5,
      tariffPerUnitDest: 0.25, consumptionTaxPerUnitDest: 0.25,
    }]]),
    effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId]),
    ),
    remainingCargoWeightByLink: new Map([[link.linkId, 50]]),
    priorTransactions: [],
    phase8MainIntents: [sellerIntent, buyerIntent],
  };
  return { world, input, link, origin, dest, seller, buyer, sellerIntent, buyerIntent };
}

describe("M5 / #673 prepared actor lots -> real same-currency settlements", () => {
  it("re-preflights live owners, commits one shipment and projects ONLY paid Phase-8 residuals", () => {
    const f = fixture();
    const result = executePreparedSameCurrencyTradePlan(f.world, f.input);
    const shipment = result.world.shipments?.get(result.committedLots[0]!.shipmentId as ShipmentId);
    expect(result.prepared.actorMatches.lots).toHaveLength(1);
    expect(result.committedLots).toHaveLength(1);
    expect(result.committedLots[0]).toMatchObject({
      sellerIntentId: f.sellerIntent.id, buyerIntentId: f.buyerIntent.id,
      dispatchedQuantity: 2, buyerTotalDebitDest: 8,
    });
    expect(shipment?.quantity).toBe(2);
    expect(shipment?.buyerGoodsPaymentAmount).toBe(6);
    expect(result.transactions.map(tx => tx.type)).toEqual([
      "TRADE_GOODS_SALE", "TRANSPORT_FEE", "IMPORT_TARIFF",
      "CONSUMPTION_TAX", "SHIPMENT_DISPATCH",
    ]);
    expect(readMarketActorInventory(result.world, f.seller, "GENERAL").get(GOOD)).toBe(8);
    expect(readActorWallet(result.world, f.buyer).get(f.dest.settlementCurrencyId)).toBe(92);
    expect(result.remainingCargoWeightByLink.get(f.link.linkId)).toBe(48);
    expect(result.phase8MainIntents).toEqual([
      { ...f.buyerIntent, desiredQuantity: 3, maxSpend: 12 },
      { ...f.sellerIntent, desiredQuantity: 3 },
    ].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(f.world.shipments?.size).toBe(0);
    expect(readMarketActorInventory(f.world, f.seller, "GENERAL").get(GOOD)).toBe(10);
    expect(f.input.priorTransactions).toEqual([]);
    expect(f.input.remainingCargoWeightByLink.get(f.link.linkId)).toBe(50);
  });

  it("replays with stable shipment/bundle IDs, independently of opening state mutation", () => {
    const f = fixture();
    const first = executePreparedSameCurrencyTradePlan(f.world, f.input);
    const replay = executePreparedSameCurrencyTradePlan(f.world, f.input);
    expect([...first.world.shipments!]).toEqual([...replay.world.shipments!]);
    expect(first.transactions).toEqual(replay.transactions);
    expect(first.phase8MainIntents).toEqual(replay.phase8MainIntents);
    expect(() => executePreparedSameCurrencyTradePlan(first.world, f.input))
      .toThrow(/duplicate shipment identity/);
  });

  it("refuses a quote that differs from the reserved buyer gross amount", () => {
    const f = fixture();
    const bad = {
      ...f.input,
      termsByTradePlanId: new Map([["plan:87:trade", {
        sellerNetUnitPrice: 3, transportFeePerUnitDest: 0.5,
        tariffPerUnitDest: 0.25, consumptionTaxPerUnitDest: 0,
      }]]),
    };
    expect(() => executePreparedSameCurrencyTradePlan(f.world, bad))
      .toThrow(/gross quote/);
    expect(f.world.shipments?.size).toBe(0);
    expect(readActorWallet(f.world, f.buyer).get(f.dest.settlementCurrencyId)).toBe(100);
  });

  it("rejects live cash/cargo deficits rather than trusting prepared reservations", () => {
    const f = fixture();
    const buyerCohort = f.buyer.type === "COHORT" ? f.world.cohorts.get(f.buyer.cohortId)! : null;
    if (!buyerCohort || f.buyer.type !== "COHORT") throw new Error("invalid fixture");
    const broke: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts).set(buyerCohort.cohortId, {
        ...buyerCohort,
        wallet: new Map(buyerCohort.wallet).set(f.dest.settlementCurrencyId, 7),
      }),
    };
    expect(() => executePreparedSameCurrencyTradePlan(broke, f.input))
      .toThrow();
    expect(() => executePreparedSameCurrencyTradePlan(f.world, {
      ...f.input, remainingCargoWeightByLink: new Map([[f.link.linkId, 1]]),
    })).toThrow(/insufficient transport capacity/);
    expect(broke.shipments?.size).toBe(0);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects same-region MAIN buyer actor substitution with an unchanged intent ID", () => {
    const f = fixture();
    const originalBuyerId = f.buyer.type === "COHORT" ? f.buyer.cohortId : null;
    const alternate = [...f.world.cohorts.values()].find((c) =>
      c.seed.regionKey === f.dest.seed.key && c.cohortId !== originalBuyerId);
    if (!alternate) throw new Error("alternate destination cohort missing");
    const forgedMainBuyer: MarketIntent = {
      ...f.buyerIntent,
      actor: { type: "COHORT", cohortId: alternate.cohortId },
    };
    expect(() => executePreparedSameCurrencyTradePlan(f.world, {
      ...f.input,
      phase8MainIntents: [f.sellerIntent, forgedMainBuyer],
    })).toThrow(/stale Phase-8 MAIN intent actor\/owner/);
    expect(f.world.shipments?.size).toBe(0);
    expect(readActorWallet(f.world, f.buyer).get(f.dest.settlementCurrencyId)).toBe(100);
    expect(f.input.remainingCargoWeightByLink.get(f.link.linkId)).toBe(50);
  });

  it("rejects same-region MAIN seller actor substitution with an unchanged intent ID", () => {
    const f = fixture();
    const originalSellerId = f.seller.type === "COHORT" ? f.seller.cohortId : null;
    const alternate = [...f.world.cohorts.values()].find((c) =>
      c.seed.regionKey === f.origin.seed.key && c.cohortId !== originalSellerId);
    if (!alternate) throw new Error("alternate origin cohort missing");
    const forgedMainSeller: MarketIntent = {
      ...f.sellerIntent,
      actor: { type: "COHORT", cohortId: alternate.cohortId },
    };
    expect(() => executePreparedSameCurrencyTradePlan(f.world, {
      ...f.input,
      phase8MainIntents: [forgedMainSeller, f.buyerIntent],
    })).toThrow(/stale Phase-8 MAIN intent actor\/owner/);
    expect(f.world.shipments?.size).toBe(0);
    expect(readMarketActorInventory(f.world, f.seller, "GENERAL").get(GOOD)).toBe(10);
    expect(f.input.priorTransactions).toEqual([]);
  });

  it("does not return a partial world if Phase-8 receipt/intent authentication fails", () => {
    const f = fixture();
    expect(() => executePreparedSameCurrencyTradePlan(f.world, {
      ...f.input, phase8MainIntents: [f.sellerIntent],
    })).toThrow(/stale Phase-8 MAIN intent/);
    expect(readMarketActorInventory(f.world, f.seller, "GENERAL").get(GOOD)).toBe(10);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("does not spend or consume MAIN intents when no eligible candidate is selected", () => {
    const f = fixture();
    const empty = executePreparedSameCurrencyTradePlan(f.world, {
      ...f.input,
      planInput: { ...f.input.planInput, opportunities: [] },
    });
    expect(empty.committedLots).toEqual([]);
    expect(empty.transactions).toEqual([]);
    expect(empty.world).toBe(f.world);
    expect(empty.phase8MainIntents).toEqual(
      [f.sellerIntent, f.buyerIntent].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  });
});
