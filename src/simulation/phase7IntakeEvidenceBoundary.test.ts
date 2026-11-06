/**
 * Issue #673: untrusted Phase-7 route builders must not rewrite authentic
 * Phase-2/4/5 intent/allocation evidence, even on a no-trade tick.
 */
import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { createMarketIntentId, type MarketIntent } from "./marketIntent";
import { executeM5CanonicalIntakeTradeTick } from "./m5LiveQuotedTradeTick";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import { buildInitialWorld } from "./worldState";

function scenario() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const cohort = [...world.cohorts.values()][0]!;
  const region = [...world.regions.values()].find(
    value => value.seed.key === cohort.seed.regionKey,
  )!;
  const good = Object.keys(world.definitionRegistry.goods)[0]! as GoodId;
  const actor = { type: "COHORT" as const, cohortId: cohort.cohortId };
  const seller: MarketIntent = {
    id: createMarketIntentId("mi:phase7:evidence:seller"),
    actor, regionId: region.regionId, goodId: good, side: "SELL",
    purpose: "INVENTORY_REBALANCE", desiredQuantity: 2,
    sourcePlanId: "plan:phase7:evidence:seller",
  };
  const buyer: MarketIntent = {
    id: createMarketIntentId("mi:phase7:evidence:buyer"),
    actor, regionId: region.regionId, goodId: good, side: "BUY",
    purpose: "CONSUMPTION", desiredQuantity: 2, maxSpend: 10,
    sourcePlanId: "plan:phase7:evidence:buyer",
  };
  const handler: PhaseHandler = (_world, context) => {
    if (context.phase === 2) {
      return { ...context, productionMarketIntents: [seller], householdMarketIntents: [buyer] };
    }
    if (context.phase === 4) return { ...context, phase4MarketAllocations: [] };
    return context;
  };
  return { world, seller, buyer, handler };
}

describe("M5 #673 immutable Phase-2/4/5 evidence at Phase-7 request boundary", () => {
  it("preserves the full no-trade sixteen-phase tick when the builder is read-only", () => {
    const { world, handler } = scenario();
    const result = executeM5CanonicalIntakeTradeTick(
      world, 7, handler, (_phase, current) => current, () => null,
    );
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.world.shipments?.size ?? 0).toBe(0);
    expect(world.shipments?.size ?? 0).toBe(0);
  });

  const attacks: Array<{
    name: string;
    mutate: (context: TickContext) => void;
  }> = [
    {
      name: "in-place production seller quantity",
      mutate: context => {
        (context.productionMarketIntents![0] as unknown as { desiredQuantity: number })
          .desiredQuantity = 200;
      },
    },
    {
      name: "nested production seller actor identity",
      mutate: context => {
        (context.productionMarketIntents![0]!.actor as unknown as { cohortId: string })
          .cohortId = "cohort:forged";
      },
    },
    {
      name: "household buyer budget",
      mutate: context => {
        (context.householdMarketIntents![0] as unknown as { maxSpend: number }).maxSpend = 10_000;
      },
    },
    {
      name: "replaced household intent array",
      mutate: context => {
        (context as { householdMarketIntents?: readonly MarketIntent[] }).householdMarketIntents = [];
      },
    },
    {
      name: "forged realized Phase-4 pre-production allocation",
      mutate: context => {
        (context.phase4MarketAllocations as unknown as unknown[]).push({ id: "ma:forged" });
      },
    },
  ];

  for (const attack of attacks) {
    it("rejects " + attack.name + " even if the builder returns null", () => {
      const { world, seller, buyer, handler } = scenario();
      const originalSeller = { ...seller, actor: { ...seller.actor } };
      const originalBuyer = { ...buyer, actor: { ...buyer.actor } };
      expect(() => executeM5CanonicalIntakeTradeTick(
        world, 7, handler, (_phase, current) => current,
        (_live, context) => { attack.mutate(context); return null; },
      )).toThrow("cannot modify Phase-2/4/5");
      expect(seller).toEqual(originalSeller);
      expect(buyer).toEqual(originalBuyer);
      expect(world.shipments?.size ?? 0).toBe(0);
    });
  }
});
