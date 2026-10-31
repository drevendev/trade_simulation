import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { actorRefKey } from "../domain/genesisLedger";
import type { GoodId } from "../domain/id";
import { createMarketAllocationId, type MarketAllocation } from "./marketClearing";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { derivePhase7PostProcurementIntents } from "./phase7PostProcurementIntents";
import { initializeTickContext, type TickContext } from "./tickOrchestrator";
import { buildInitialWorld } from "./worldState";

const GOOD = "good:food" as GoodId;

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 43,
  );
  const unit = [...world.productionUnits.values()][0]!;
  const region = [...world.regions.values()]
    .find(candidate => candidate.seed.key === unit.seed.regionKey)!;
  const state = world.states.get(region.controllerStateId!)!;
  const cohort = [...world.cohorts.values()]
    .find(candidate => candidate.seed.regionKey === region.seed.key)!;
  const market = [...world.markets.values()]
    .find(candidate => candidate.seed.regionKey === region.seed.key)!;
  const buyer: MarketIntent = {
    id: createMarketIntentId("mi:m5:phase4:input"),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId },
    regionId: region.regionId, goodId: GOOD, side: "BUY", purpose: "INPUT",
    desiredQuantity: 8, maxSpend: 30,
    sourcePlanId: "plan:m5:input", inventoryBucket: "INPUT",
  };
  const seller: MarketIntent = {
    id: createMarketIntentId("mi:m5:phase4:seller"),
    actor: { type: "STATE", stateId: state.stateId },
    regionId: region.regionId, goodId: GOOD, side: "SELL",
    purpose: "INVENTORY_REBALANCE", desiredQuantity: 10,
    minimumReserveQuantity: 1, sourcePlanId: "plan:m5:seller",
    inventoryBucket: "GENERAL",
  };
  const output: MarketIntent = {
    id: createMarketIntentId("mi:m5:phase5:output"),
    actor: { type: "PRODUCTION_UNIT", productionUnitId: unit.productionUnitId },
    regionId: region.regionId, goodId: GOOD, side: "SELL",
    purpose: "INVENTORY_REBALANCE", desiredQuantity: 2,
    minimumReserveQuantity: 0, sourcePlanId: "plan:m5:output",
    inventoryBucket: "OUTPUT",
  };
  const consumption: MarketIntent = {
    id: createMarketIntentId("mi:m5:phase2:consumption"),
    actor: { type: "COHORT", cohortId: cohort.cohortId },
    regionId: region.regionId, goodId: GOOD, side: "BUY",
    purpose: "CONSUMPTION", desiredQuantity: 4, maxSpend: 20,
    sourcePlanId: "plan:m5:consumption",
  };
  const allocation = (id: string, quantity: number): MarketAllocation => ({
    id: createMarketAllocationId("ma:m5:phase4:" + id),
    marketId: market.marketId, regionId: region.regionId,
    goodId: GOOD, pass: "PRE_PRODUCTION",
    sellerIntentId: seller.id, buyerIntentId: buyer.id,
    seller: seller.actor, buyer: buyer.actor,
    quantity, sellerNetUnitPrice: 2, buyerGrossUnitPrice: 2,
    marketCurrencyId: region.settlementCurrencyId,
    consumptionTaxAmount: 0, destinationStateId: region.controllerStateId,
    sellerInventoryBucket: "GENERAL", buyerInventoryBucket: "INPUT",
  });
  const context: TickContext = {
    ...initializeTickContext(7, world.seed),
    phase: 7, productionMarketIntents: [buyer, seller, output],
    householdMarketIntents: [consumption],
    phase4MarketAllocations: [allocation("first", 1), allocation("second", 2)],
  };
  return { world, context, buyer, seller, output, consumption, allocation };
}

describe("M5 #673 authoritative Phase-2/4/5 residual intake", () => {
  it("subtracts realized Phase-4 input quantities and gross spend exactly once", () => {
    const f = fixture();
    const initialWorld = f.world;
    const result = derivePhase7PostProcurementIntents(f.world, f.context);
    const byId = new Map(result.residualIntents.map(x => [x.intent.id, x]));
    expect(byId.get(f.buyer.id)?.residualQuantity).toBe(5);
    expect(byId.get(f.buyer.id)?.remainingBuyerSpend).toBe(24);
    expect(byId.get(f.seller.id)?.residualQuantity).toBe(7);
    expect(byId.get(f.output.id)?.residualQuantity).toBe(2);
    expect(byId.get(f.consumption.id)?.residualQuantity).toBe(4);
    expect(byId.get(f.consumption.id)?.remainingBuyerSpend).toBe(20);
    const reducedBuyer = result.phase8MainIntents.find(x => x.id === f.buyer.id)!;
    expect(reducedBuyer.desiredQuantity).toBe(5);
    expect(reducedBuyer.maxSpend).toBe(24);
    expect(f.buyer.desiredQuantity).toBe(8);
    expect(f.buyer.maxSpend).toBe(30);
    expect(f.world).toBe(initialWorld);
    expect(f.context.phase4MarketAllocations?.length).toBe(2);
    expect(actorRefKey(byId.get(f.output.id)!.intent.actor)).toBe(actorRefKey(f.output.actor));
  });

  it("is deterministic under every source-intent and realized-allocation order", () => {
    const f = fixture();
    const projected = derivePhase7PostProcurementIntents(f.world, f.context);
    const permuted: TickContext = {
      ...f.context,
      productionMarketIntents: [...f.context.productionMarketIntents!].reverse(),
      householdMarketIntents: [...f.context.householdMarketIntents!].reverse(),
      phase4MarketAllocations: [...f.context.phase4MarketAllocations!].reverse(),
    };
    expect(derivePhase7PostProcurementIntents(f.world, permuted)).toEqual(projected);
  });

  it("refuses duplicate IDs, uncommitted/forged region and overdraw evidence", () => {
    const f = fixture();
    const bad = (context: TickContext) =>
      expect(() => derivePhase7PostProcurementIntents(f.world, context)).toThrow();
    bad({ ...f.context, phase: 6 });
    const missingPhase4 = { ...f.context };
    delete missingPhase4.phase4MarketAllocations;
    bad(missingPhase4);
    bad({
      ...f.context,
      productionMarketIntents: [...f.context.productionMarketIntents!, f.buyer],
    });
    bad({
      ...f.context,
      phase4MarketAllocations: [f.allocation("first", 1), f.allocation("first", 1)],
    });
    bad({
      ...f.context,
      phase4MarketAllocations: [f.allocation("too-much", 9)],
    });
    bad({
      ...f.context,
      phase4MarketAllocations: [{
        ...f.allocation("forged", 1), buyer: f.seller.actor,
      }],
    });
    bad({
      ...f.context,
      phase4MarketAllocations: [{
        ...f.allocation("wrong-pass", 1), pass: "MAIN",
      }],
    });
    bad({
      ...f.context,
      phase4MarketAllocations: [{
        ...f.allocation("wrong-bucket", 1), buyerInventoryBucket: "OUTPUT",
      }],
    });
    expect(f.buyer.maxSpend).toBe(30);
    expect(f.seller.desiredQuantity).toBe(10);
    expect(f.context.phase4MarketAllocations).toHaveLength(2);
  });

  it("rejects cumulative binary64 loss, not one epsilon allowance per fill", () => {
    const f = fixture();
    const precisionWorld = {
      ...f.world,
      simulationConfig: {
        ...f.world.simulationConfig,
        numeric: { ...f.world.simulationConfig.numeric, quantityEpsilon: 1e-9 },
      },
    };
    const largeBuyer: MarketIntent = {
      ...f.buyer, desiredQuantity: 10_000_000_000_000_000, maxSpend: 10_000_000_000_000_000,
    };
    const largeSeller: MarketIntent = {
      ...f.seller, desiredQuantity: 10_000_000_000_000_000,
    };
    const contexts: TickContext = {
      ...f.context,
      productionMarketIntents: [largeBuyer, largeSeller, f.output],
      phase4MarketAllocations: [
        f.allocation("a", 0.3), f.allocation("b", 0.3),
      ],
    };
    expect(() => derivePhase7PostProcurementIntents(precisionWorld, contexts))
      .toThrow(/precision/);
    expect(largeBuyer.desiredQuantity).toBe(10_000_000_000_000_000);
  });

  it("does not invent an intent or sale when Phase-4 had no fills", () => {
    const f = fixture();
    const result = derivePhase7PostProcurementIntents(f.world, {
      ...f.context, phase4MarketAllocations: [],
    });
    expect(result.phase8MainIntents).toHaveLength(4);
    expect(result.phase8MainIntents.find(x => x.id === f.buyer.id)?.maxSpend).toBe(30);
    expect(result.phase8MainIntents.find(x => x.id === f.seller.id)?.desiredQuantity).toBe(10);
    expect(f.world.shipments?.size).toBe(0);
  });
});
