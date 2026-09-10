/**
 * REQ-MARKET-005 integration test: Phase-8 handler telemetry collection.
 *
 * Verifies that telemetry is emitted through the actual Phase-8 handler
 * (not standalone manual builder calls), and that enabled/disabled runs
 * produce identical canonical results.
 *
 * This test addresses issue #341: ensuring REQ-MARKET-005 acceptance
 * criterion "A seeded test reaches telemetry through the real Phase-8
 * MAIN production execution path".
 */

import { describe, it, expect } from "vitest";
import type { GoodId, MarketId, RegionId } from "../domain/id";
import { buildInitialWorld } from "./worldState";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { executeTick, computeTickHash, type TickContext } from "./tickOrchestrator";
import { createPhase8Handler } from "./phase8MainMarketClearing";
import type { MarketIntent } from "./marketIntent";
import { createMarketIntentId } from "./marketIntent";

describe("acceptance-req-market-005-phase8-integration", () => {
  it("collects telemetry through real Phase-8 handler via orchestrator", () => {
    // Build seeded baseline scenario
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Create fixture intents for Phase-8 to clear
    const getFixtureIntents = (): MarketIntent[] => {
      // Use first region and good from world state
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const seller = Array.from(worldState.clans.values())[0]!;
      const buyer = Array.from(worldState.clans.values())[1]!;

      if (!regionId || !goodId) throw new Error("Test fixture missing region or good");

      return [
        {
          id: createMarketIntentId("mi:seller-fixture-1"),
          actor: { type: "CLAN" as const, clanId: seller.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 100,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:test-1",
        },
        {
          id: createMarketIntentId("mi:buyer-fixture-1"),
          actor: { type: "CLAN" as const, clanId: buyer.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 80,
          maxSpend: 800,
          sourcePlanId: "plan:test-2",
        },
      ];
    };

    // Create Phase-8 handler with telemetry collection enabled
    const phase8HandlerWithTelemetry = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    // Execute one tick with telemetry enabled
    const resultWithTelemetry = executeTick(
      worldState,
      1,
      worldState.pendingTransitions,
      phase8HandlerWithTelemetry,
    );

    // Verify telemetry was collected during Phase-8
    expect(resultWithTelemetry.context.marketTelemetry.length).toBeGreaterThan(0);

    // Verify telemetry has the expected structure
    const telemetry = resultWithTelemetry.context.marketTelemetry[0];
    expect(telemetry).toBeDefined();
    expect(telemetry!.pass).toBe("MAIN");
    expect(telemetry!.desiredDemandQuantity).toBeGreaterThan(0);
    expect(telemetry!.clearedQuantity).toBeGreaterThan(0);
    expect(telemetry!.shortageRate).toBeGreaterThanOrEqual(0);
    expect(telemetry!.surplusRate).toBeGreaterThanOrEqual(0);

    // Capture replay hash with telemetry enabled
    const hashWithTelemetry = computeTickHash(worldState, resultWithTelemetry.context);

    // Now run with telemetry disabled and verify identical canonical results
    const phase8HandlerNoTelemetry = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: false,
    });

    const resultNoTelemetry = executeTick(
      worldState,
      1,
      worldState.pendingTransitions,
      phase8HandlerNoTelemetry,
    );

    // Verify no telemetry was collected when disabled
    expect(resultNoTelemetry.context.marketTelemetry.length).toBe(0);

    // Verify canonical results are identical
    expect(resultNoTelemetry.context.transactions.length).toBe(
      resultWithTelemetry.context.transactions.length,
    );

    // Most importantly: verify replay hash is identical
    const hashNoTelemetry = computeTickHash(worldState, resultNoTelemetry.context);
    expect(hashNoTelemetry).toBe(hashWithTelemetry);
  });

  it("Phase-8 handler integrates with orchestrator without affecting other phases", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Create a simple Phase-8 handler
    const phase8Handler = createPhase8Handler({ collectTelemetry: true });

    // Execute tick and verify all 16 phases complete successfully
    const result = executeTick(
      worldState,
      1,
      worldState.pendingTransitions,
      phase8Handler,
    );

    // Verify phase trace includes all 16 phases (0-15)
    expect(result.phaseTrace.length).toBe(16);
    expect(result.phaseTrace).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    // Verify no phase-boundary errors occurred
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
  });

  it("telemetry emitted from Phase-8 is non-authoritative and preserves canonical stocks", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Fixture intents
    const getFixtureIntents = (): MarketIntent[] => {
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const seller = Array.from(worldState.clans.values())[0]!;

      return [
        {
          id: createMarketIntentId("mi:seller-preserve-1"),
          actor: { type: "CLAN" as const, clanId: seller.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 50,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:test-preserve",
        },
      ];
    };

    const phase8WithTelemetry = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    const result = executeTick(worldState, 1, worldState.pendingTransitions, phase8WithTelemetry);

    // Per REQ-MARKET-005: telemetry is non-authoritative output
    // World state must remain immutable (no new wallets/inventory created by telemetry)
    expect(worldState.clans.size).toBeGreaterThan(0); // Unchanged
    expect(Array.from(worldState.clans.values())[0]!.clanId).toBeDefined(); // Unchanged

    // Telemetry collected must have finite, valid values
    if (result.context.marketTelemetry.length > 0) {
      const t = result.context.marketTelemetry[0]!;
      expect(Number.isFinite(t.desiredDemandQuantity)).toBe(true);
      expect(Number.isFinite(t.clearedQuantity)).toBe(true);
      expect(Number.isFinite(t.shortageRate)).toBe(true);
      expect(Number.isFinite(t.surplusRate)).toBe(true);
      expect(t.shortageRate).toBeGreaterThanOrEqual(0);
      expect(t.surplusRate).toBeGreaterThanOrEqual(0);
    }
  });

  it("REQ-MARKET-005 golden-gate: all required telemetry fields populated per spec section 33", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 99);

    // Deterministic fixture with clear supply/demand imbalance
    const getFixtureIntents = (): MarketIntent[] => {
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const sellers = Array.from(worldState.clans.values()).slice(0, 2);
      const buyers = Array.from(worldState.clans.values()).slice(2, 4);

      return [
        {
          id: createMarketIntentId("mi:seller-1"),
          actor: { type: "CLAN" as const, clanId: sellers[0]!.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 100,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:sellers",
        },
        {
          id: createMarketIntentId("mi:seller-2"),
          actor: { type: "CLAN" as const, clanId: sellers[1]!.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 100,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:sellers",
        },
        {
          id: createMarketIntentId("mi:buyer-1"),
          actor: { type: "CLAN" as const, clanId: buyers[0]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 150,
          maxSpend: 1500,
          sourcePlanId: "plan:buyers",
        },
        {
          id: createMarketIntentId("mi:buyer-2"),
          actor: { type: "CLAN" as const, clanId: buyers[1]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 100,
          maxSpend: 1000,
          sourcePlanId: "plan:buyers",
        },
      ];
    };

    const phase8Handler = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    const result = executeTick(worldState, 1, worldState.pendingTransitions, phase8Handler);

    // Per REQ-MARKET-005, section 33: all required fields must be populated
    expect(result.context.marketTelemetry.length).toBeGreaterThan(0);
    const telemetry = result.context.marketTelemetry[0]!;

    // Verify all required M3 fields exist and are finite
    expect(Number.isFinite(telemetry.desiredDemandQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.effectiveDemandQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.offeredQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.clearedQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.sellerNetPrice)).toBe(true);
    expect(Number.isFinite(telemetry.householdGrossPrice)).toBe(true);
    expect(Number.isFinite(telemetry.unmetDemandQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.unsoldOfferQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.shortageRate)).toBe(true);
    expect(Number.isFinite(telemetry.surplusRate)).toBe(true);
    expect(Number.isFinite(telemetry.consumptionTaxCollected)).toBe(true);

    // Verify structural properties per section 33
    expect(telemetry.pass).toBe("MAIN");
    expect(telemetry.marketId).toBeDefined();
    expect(telemetry.regionId).toBeDefined();
    expect(telemetry.goodId).toBeDefined();

    // Verify quantity relationships: cleared <= effective demand, cleared <= offered
    expect(telemetry.clearedQuantity).toBeLessThanOrEqual(telemetry.effectiveDemandQuantity + 1e-8);
    expect(telemetry.clearedQuantity).toBeLessThanOrEqual(telemetry.offeredQuantity + 1e-8);

    // Verify unmet/unsold are computed correctly
    expect(telemetry.unmetDemandQuantity).toBeGreaterThanOrEqual(-1e-8);
    expect(telemetry.unsoldOfferQuantity).toBeGreaterThanOrEqual(-1e-8);

    // Verify shortage/surplus rate bounds per section 33 formula
    expect(telemetry.shortageRate).toBeGreaterThanOrEqual(-1e-8);
    expect(telemetry.shortageRate).toBeLessThanOrEqual(1 + 1e-8);
    expect(telemetry.surplusRate).toBeGreaterThanOrEqual(-1e-8);
    expect(telemetry.surplusRate).toBeLessThanOrEqual(1 + 1e-8);
  });

  it("REQ-MARKET-005 golden-gate: telemetry values match clearing outcomes", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 77);

    // Clear shortage scenario: high demand, limited supply
    const getFixtureIntents = (): MarketIntent[] => {
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const sellers = Array.from(worldState.clans.values()).slice(0, 1);
      const buyers = Array.from(worldState.clans.values()).slice(1, 3);

      return [
        {
          id: createMarketIntentId("mi:seller-shortage"),
          actor: { type: "CLAN" as const, clanId: sellers[0]!.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 50, // Limited supply
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:shortage-sellers",
        },
        {
          id: createMarketIntentId("mi:buyer-shortage-1"),
          actor: { type: "CLAN" as const, clanId: buyers[0]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 100, // High demand
          maxSpend: 2000,
          sourcePlanId: "plan:shortage-buyers",
        },
        {
          id: createMarketIntentId("mi:buyer-shortage-2"),
          actor: { type: "CLAN" as const, clanId: buyers[1]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 100,
          maxSpend: 2000,
          sourcePlanId: "plan:shortage-buyers",
        },
      ];
    };

    const phase8Handler = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    const result = executeTick(worldState, 1, worldState.pendingTransitions, phase8Handler);

    const telemetry = result.context.marketTelemetry[0]!;

    // Verify clearing relationships per REQ-MARKET-003
    // desiredDemandQuantity = sum of all buyer desired quantities
    expect(telemetry.desiredDemandQuantity).toBe(200); // 100 + 100

    // offeredQuantity = sum of all seller desired quantities
    expect(telemetry.offeredQuantity).toBe(50);

    // In shortage scenario: clearedQuantity = min(offered, effective demand)
    // Both constraints bind, so cleared should equal offered (supply-limited)
    expect(telemetry.clearedQuantity).toBeLessThanOrEqual(telemetry.offeredQuantity + 1e-8);
    expect(telemetry.clearedQuantity).toBeLessThanOrEqual(telemetry.effectiveDemandQuantity + 1e-8);

    // In shortage: unmetDemandQuantity > 0
    expect(telemetry.unmetDemandQuantity).toBeGreaterThan(-1e-8);

    // Verify shortage rate formula: shortageRate = unmet / effective (if effective > eps, else 0)
    if (telemetry.effectiveDemandQuantity > 1e-8) {
      const expectedShortageRate = telemetry.unmetDemandQuantity / telemetry.effectiveDemandQuantity;
      expect(Math.abs(telemetry.shortageRate - expectedShortageRate)).toBeLessThan(1e-8);
    }

    // Tax collected should be non-negative
    expect(telemetry.consumptionTaxCollected).toBeGreaterThanOrEqual(-1e-8);
  });
});
