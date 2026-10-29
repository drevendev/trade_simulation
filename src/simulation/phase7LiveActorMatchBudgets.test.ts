import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import {
  matchPhase7ActorIntents, phase7BuyerActorCashKey, phase7SellerEndpointKey,
  type Phase7ActorMatchRequest,
} from "./phase7IntentMatching";
import { buildPhase7LiveActorMatchBudgets } from "./phase7LiveActorMatchBudgets";
import type { Phase7TradePlanActors } from "./phase7TradePlan";
import { buildInitialWorld, type WorldState } from "./worldState";

const GOOD = "good:food" as GoodId;

function fixture() {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 53,
  );
  const [seller, buyer] = [...root.cohorts.values()];
  if (!seller || !buyer || seller.cohortId === buyer.cohortId) {
    throw new Error("baseline needs two distinct physical actor owners");
  }
  const source = [...root.regions.values()].find(r => r.seed.key === seller.seed.regionKey);
  const destination = [...root.regions.values()].find(r => r.seed.key === buyer.seed.regionKey);
  if (!source || !destination) throw new Error("baseline cohort region missing");
  const sellActor: ActorRef = { type: "COHORT", cohortId: seller.cohortId };
  const buyActor: ActorRef = { type: "COHORT", cohortId: buyer.cohortId };
  const buyingCurrency = destination.settlementCurrencyId;
  const world: WorldState = {
    ...root,
    cohorts: new Map(root.cohorts)
      .set(seller.cohortId, {
        ...seller,
        householdInventory: new Map(seller.householdInventory).set(GOOD, 9),
      })
      .set(buyer.cohortId, {
        ...buyer, wallet: new Map(buyer.wallet).set(buyingCurrency, 12.5),
      }),
  };
  const selling: MarketIntent = {
    id: createMarketIntentId("mi:7:live:one:sell"),
    actor: sellActor, regionId: source.regionId, goodId: GOOD,
    side: "SELL", purpose: "INVENTORY_REBALANCE", desiredQuantity: 40,
    minimumReserveQuantity: 0, sourcePlanId: "plan:7:live:one:sell",
  };
  const anotherSale: MarketIntent = {
    ...selling, id: createMarketIntentId("mi:7:live:two:sell"),
    sourcePlanId: "plan:7:live:two:sell",
  };
  const buying: MarketIntent = {
    id: createMarketIntentId("mi:7:live:one:buy"),
    actor: buyActor, regionId: destination.regionId, goodId: GOOD,
    side: "BUY", purpose: "CONSUMPTION", desiredQuantity: 40,
    maxSpend: 100, sourcePlanId: "plan:7:live:one:buy",
  };
  const anotherBuy: MarketIntent = {
    ...buying, id: createMarketIntentId("mi:7:live:two:buy"),
    sourcePlanId: "plan:7:live:two:buy",
  };
  const entries: ReadonlyMap<string, Phase7TradePlanActors> = new Map([
    ["plan:one", {
      sellers: [{ intent: selling, residualQuantity: 40 }],
      buyers: [{ intent: buying, residualQuantity: 40, remainingBuyerSpend: 100 }],
    }],
    ["plan:two", {
      sellers: [{ intent: anotherSale, residualQuantity: 40 }],
      buyers: [{ intent: anotherBuy, residualQuantity: 40, remainingBuyerSpend: 100 }],
    }],
  ]);
  const sellerKey = phase7SellerEndpointKey(selling);
  const buyerKey = phase7BuyerActorCashKey(buyActor, buyingCurrency);
  return { world, entries, sellerKey, buyerKey, selling, buying, seller, buyer, buyingCurrency };
}

describe("M5 #673 live actor budgets for prepared cross-region plans", () => {
  it("uses one physical owner per endpoint/wallet, not the sum of intents, and is permutation-stable", () => {
    const f = fixture();
    const protectedStock = new Map([[f.sellerKey, 3]]);
    const beforeGoods = readMarketActorInventory(f.world, f.selling.actor, "GENERAL").get(GOOD);
    const beforeCash = readActorWallet(f.world, f.buying.actor).get(f.buyingCurrency);
    const result = buildPhase7LiveActorMatchBudgets(f.world, f.entries, protectedStock);
    const shuffled = buildPhase7LiveActorMatchBudgets(
      f.world, new Map([...f.entries].reverse()), protectedStock,
    );
    expect([...result.sellerExportableByEndpoint]).toEqual([[f.sellerKey, 6]]);
    expect([...result.buyerCashByActorCurrency]).toEqual([[f.buyerKey, 12.5]]);
    expect([...shuffled.sellerExportableByEndpoint]).toEqual([...result.sellerExportableByEndpoint]);
    expect([...shuffled.buyerCashByActorCurrency]).toEqual([...result.buyerCashByActorCurrency]);
    expect(readMarketActorInventory(f.world, f.selling.actor, "GENERAL").get(GOOD)).toBe(beforeGoods);
    expect(readActorWallet(f.world, f.buying.actor).get(f.buyingCurrency)).toBe(beforeCash);
    expect(protectedStock.get(f.sellerKey)).toBe(3);
    // Both intents request 40 goods, but this is a physical ceiling of six.
    expect(result.sellerExportableByEndpoint.get(f.sellerKey)).toBeLessThan(40);
  });

  it("requires explicit finite protected stock and rejects over-reserving without mutations", () => {
    const f = fixture();
    expect(() => buildPhase7LiveActorMatchBudgets(f.world, f.entries, new Map()))
      .toThrow("missing explicit protected stock");
    expect(() => buildPhase7LiveActorMatchBudgets(f.world, f.entries, new Map([[f.sellerKey, 10]])))
      .toThrow("exceeds live inventory");
    expect(() => buildPhase7LiveActorMatchBudgets(f.world, f.entries, new Map([[f.sellerKey, Number.NaN]])))
      .toThrow("finite and non-negative");
    expect(readMarketActorInventory(f.world, f.selling.actor, "GENERAL").get(GOOD)).toBe(9);
  });

  it("fails closed on non-finite live buyer money and missing actor instead of using maxSpend", () => {
    const f = fixture();
    const current = f.world.cohorts.get(f.buyer.cohortId)!;
    const corrupted: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts).set(f.buyer.cohortId, {
        ...current, wallet: new Map(current.wallet).set(f.buyingCurrency, Number.POSITIVE_INFINITY),
      }),
    };
    const protectedStock = new Map([[f.sellerKey, 0]]);
    expect(() => buildPhase7LiveActorMatchBudgets(corrupted, f.entries, protectedStock))
      .toThrow("live buyer cash must be finite and non-negative");
    expect(() => buildPhase7LiveActorMatchBudgets(
      f.world, new Map([["bad", {
        sellers: [{ intent: f.selling, residualQuantity: 40 }],
        buyers: [{ intent: { ...f.buying,
          actor: { type: "COHORT", cohortId: "cohort:missing" as typeof f.buyer.cohortId },
        }, residualQuantity: 40, remainingBuyerSpend: 100 }],
      }]]), protectedStock,
    )).toThrow("no CohortState");
  });

  it("rejects binary64 protected-stock subtraction that silently consumes more than requested", () => {
    const f = fixture();
    const current = f.world.cohorts.get(f.seller.cohortId)!;
    const huge: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts).set(f.seller.cohortId, {
        ...current, householdInventory: new Map(current.householdInventory).set(GOOD, 1e16),
      }),
    };
    expect(() => buildPhase7LiveActorMatchBudgets(
      huge, f.entries, new Map([[f.sellerKey, 3]]),
    )).toThrow("lost numeric precision");
  });

  it("accepts fractional protected stock within canonical quantity epsilon, without silently losing protection", () => {
    const f = fixture();
    const fractional = buildPhase7LiveActorMatchBudgets(
      f.world, f.entries, new Map([[f.sellerKey, 0.1]]),
    );
    expect(fractional.sellerExportableByEndpoint.get(f.sellerKey)).toBeCloseTo(8.9, 12);
    const seller = f.world.cohorts.get(f.seller.cohortId)!;
    const smaller: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts).set(f.seller.cohortId, {
        ...seller, householdInventory: new Map(seller.householdInventory).set(GOOD, 1.1),
      }),
    };
    expect(buildPhase7LiveActorMatchBudgets(
      smaller, f.entries, new Map([[f.sellerKey, 0.3]]),
    ).sellerExportableByEndpoint.get(f.sellerKey)).toBeCloseTo(0.8, 12);
    expect(readMarketActorInventory(f.world, f.selling.actor, "GENERAL").get(GOOD)).toBe(9);
    expect(readMarketActorInventory(smaller, f.selling.actor, "GENERAL").get(GOOD)).toBe(1.1);
  });

  it("shares one State public inventory across different legal origin regions through both budget builder and matcher", () => {
    const f = fixture();
    const state = [...f.world.states.values()][0]!;
    const [r1, r2] = [...f.world.regions.values()]
      .filter(r => r.controllerStateId === state.stateId);
    if (!r1 || !r2) throw new Error("baseline requires two regions controlled by one State");
    const world: WorldState = {
      ...f.world,
      states: new Map(f.world.states).set(state.stateId, {
        ...state, publicInventory: new Map(state.publicInventory).set(GOOD, 9),
      }),
    };
    const first: MarketIntent = {
      ...f.selling, id: createMarketIntentId("mi:7:state:region1"),
      sourcePlanId: "plan:7:state:region1",
      actor: { type: "STATE", stateId: state.stateId }, regionId: r1.regionId,
      inventoryBucket: "GENERAL",
    };
    const second: MarketIntent = {
      ...first, id: createMarketIntentId("mi:7:state:region2"),
      sourcePlanId: "plan:7:state:region2", regionId: r2.regionId,
    };
    const sellerKey = phase7SellerEndpointKey(first);
    expect(phase7SellerEndpointKey(second)).toBe(sellerKey);
    const group = (intent: MarketIntent): Phase7TradePlanActors => ({
      sellers: [{ intent, residualQuantity: 40 }],
      buyers: [{ intent: f.buying, residualQuantity: 40, remainingBuyerSpend: 100 }],
    });
    const entries = new Map<string, Phase7TradePlanActors>([
      ["plan:a", group(first)], ["plan:b", group(second)],
    ]);
    const protectedStock = new Map([[sellerKey, 0]]);
    const budgets = buildPhase7LiveActorMatchBudgets(world, entries, protectedStock);
    const reverse = buildPhase7LiveActorMatchBudgets(
      world, new Map([...entries].reverse()), protectedStock,
    );
    expect([...budgets.sellerExportableByEndpoint]).toEqual([[sellerKey, 9]]);
    expect([...reverse.sellerExportableByEndpoint]).toEqual([...budgets.sellerExportableByEndpoint]);
    expect([...budgets.buyerCashByActorCurrency]).toEqual([[f.buyerKey, 12.5]]);

    const linkId = "link:state-shared-fixture" as TransportLinkId;
    const destination = world.regions.get(f.buying.regionId)!;
    const request = (id: string, intent: MarketIntent, quantity: number, score: number):
      Phase7ActorMatchRequest => {
      const source = world.regions.get(intent.regionId)!;
      return {
        candidate: {
          tradePlanId: id, linkId, originRegionId: source.regionId,
          destinationRegionId: destination.regionId, goodId: GOOD,
          sourceCurrencyId: source.settlementCurrencyId,
          destinationCurrencyId: destination.settlementCurrencyId,
          sourceSellerNetUnitPrice: 1, destinationReferenceNetUnitPrice: 2,
          estimatedTransportUnitCostDest: 0, estimatedTariffRate: 0,
          estimatedFxInputPerSourceCurrency: 1, shortageRateDestination: 0.2,
          score, maximumOwnQuantity: 20,
        },
        reservation: {
          tradePlanId: id, linkId, goodId: GOOD, allocatedQuantity: quantity,
          cargoWeightReserved: quantity, buyerCashReservedDest: quantity,
          fxPoolOutputReservedSource: 0, refusal: null,
        },
        sellers: [{ intent, residualQuantity: 40 }],
        buyers: [{ intent: f.buying, residualQuantity: 40, remainingBuyerSpend: 100 }],
        landedGrossUnitCostDest: 1,
      };
    };
    const overdraw = [request("plan:a", first, 5, 2), request("plan:b", second, 5, 1)];
    expect(() => matchPhase7ActorIntents(overdraw, budgets, 1e-9, 1e-9, 1e-9))
      .toThrow("cannot cover aggregate reservation");
    const valid = [request("plan:a", first, 4, 2), request("plan:b", second, 5, 1)];
    const matched = matchPhase7ActorIntents(valid, budgets, 1e-9, 1e-9, 1e-9);
    const permuted = matchPhase7ActorIntents([...valid].reverse(), budgets, 1e-9, 1e-9, 1e-9);
    expect(permuted.lots).toEqual(matched.lots);
    expect(matched.lots.map(lot => [lot.tradePlanId, lot.quantity])).toEqual([
      ["plan:a", 4], ["plan:b", 5],
    ]);
    expect(matched.remainingSellerByEndpoint.get(sellerKey)).toBe(0);
    expect(matched.remainingBuyerCashByActorCurrency.get(f.buyerKey)).toBe(3.5);
    expect(readMarketActorInventory(world, first.actor, "GENERAL").get(GOOD)).toBe(9);
    expect(readActorWallet(world, f.buying.actor).get(f.buyingCurrency)).toBe(12.5);
    expect(protectedStock.get(sellerKey)).toBe(0);
  });

  it("keeps two distinct States' real public inventories independently spendable", () => {
    const f = fixture();
    const [first, second] = [...f.world.states.values()];
    if (!first || !second) throw new Error("baseline requires two States");
    const r1 = [...f.world.regions.values()].find(r => r.controllerStateId === first.stateId)!;
    const r2 = [...f.world.regions.values()].find(r => r.controllerStateId === second.stateId)!;
    const world: WorldState = {
      ...f.world,
      states: new Map(f.world.states)
        .set(first.stateId, { ...first, publicInventory: new Map(first.publicInventory).set(GOOD, 9) })
        .set(second.stateId, { ...second, publicInventory: new Map(second.publicInventory).set(GOOD, 9) }),
    };
    const one: MarketIntent = {
      ...f.selling, actor: { type: "STATE", stateId: first.stateId },
      id: createMarketIntentId("mi:7:state:owner1"), regionId: r1.regionId,
      inventoryBucket: "GENERAL",
    };
    const two: MarketIntent = {
      ...one, actor: { type: "STATE", stateId: second.stateId },
      id: createMarketIntentId("mi:7:state:owner2"), regionId: r2.regionId,
    };
    const oneKey = phase7SellerEndpointKey(one), twoKey = phase7SellerEndpointKey(two);
    expect(twoKey).not.toBe(oneKey);
    const group = (intent: MarketIntent): Phase7TradePlanActors => ({
      sellers: [{ intent, residualQuantity: 40 }],
      buyers: [{ intent: f.buying, residualQuantity: 40, remainingBuyerSpend: 100 }],
    });
    const result = buildPhase7LiveActorMatchBudgets(
      world, new Map([["plan:a", group(one)], ["plan:b", group(two)]]),
      new Map([[oneKey, 0], [twoKey, 0]]),
    );
    expect(result.sellerExportableByEndpoint.size).toBe(2);
    expect(result.sellerExportableByEndpoint.get(oneKey)).toBe(9);
    expect(result.sellerExportableByEndpoint.get(twoKey)).toBe(9);
    expect(result.buyerCashByActorCurrency.size).toBe(1);
    expect(readMarketActorInventory(world, one.actor, "GENERAL").get(GOOD)).toBe(9);
    expect(readMarketActorInventory(world, two.actor, "GENERAL").get(GOOD)).toBe(9);
  });

});
