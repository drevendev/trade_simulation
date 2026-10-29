import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import { phase7BuyerActorCashKey, phase7SellerEndpointKey } from "./phase7IntentMatching";
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
});
