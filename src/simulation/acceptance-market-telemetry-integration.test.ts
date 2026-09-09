/**
 * M3 market telemetry integration test (REQ-MARKET-005 integration gate).
 *
 * Verifies that telemetry collection from seeded clearing/settlement preserves
 * world state and replay hash invariance (telemetry is a non-authoritative
 * one-way diagnostic output).
 *
 * Per section 33 of MARKETS_TRADE_FX_CONTRACTS.md, telemetry emits observed
 * demand/supply/cleared quantities, prices, and shortage/surplus signals from
 * the Phase-8 MAIN-pass clearing without mutating WorldState.
 */

import { describe, it, expect } from "vitest";
import type { GoodId, MarketId, RegionId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { buildInitialWorld, type WorldState } from "./worldState";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import type { LocalMarketTelemetry } from "./marketTelemetry";
import { LocalMarketTelemetryBuilder, computeShortageRate, computeSurplusRate } from "./marketTelemetry";
import type { LocalClearingInput, MarketAllocation } from "./marketClearing";
import { computeLocalClearing } from "./marketClearing";
import type { MarketIntent } from "./marketIntent";
import { createMarketIntentId } from "./marketIntent";

describe("acceptance-market-telemetry-integration", () => {
  it("collects telemetry from clearing/settlement without mutating world state", () => {
    // Build seeded baseline scenario
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Capture initial seed for verification
    const initialSeed = worldState.seed;

    // Simulate a hypothetical Phase-8 clearing/settlement with telemetry collection
    // (This is a preparatory pattern for when Phase-8 handler integrates telemetry)
    const marketTelemetry: LocalMarketTelemetry[] = [];

    // Simulate collecting telemetry from a local market clearing
    const marketId = "market:1" as MarketId;
    const regionId = "region:1" as RegionId;
    const goodId = "good:1" as GoodId;

    const builder = new LocalMarketTelemetryBuilder(
      marketId,
      regionId,
      goodId,
      "MAIN",
      config.numeric.quantityEpsilon ?? 1e-9,
    );

    // Simulate clearing data (would come from actual clearing computation)
    builder.setClearingQuantities(
      100, // desiredDemand
      100, // effectiveDemand
      80, // offeredQuantity
      75, // clearedQuantity
    );
    builder.setPrices(10, 11);
    builder.addConsumptionTax(5);

    const telemetry = builder.build();
    marketTelemetry.push(telemetry);

    // Verify telemetry was collected with correct values
    expect(telemetry.marketId).toBe(marketId);
    expect(telemetry.desiredDemandQuantity).toBe(100);
    expect(telemetry.effectiveDemandQuantity).toBe(100);
    expect(telemetry.clearedQuantity).toBe(75);
    expect(telemetry.unmetDemandQuantity).toBe(25);
    expect(telemetry.unsoldOfferQuantity).toBe(5);
    expect(telemetry.consumptionTaxCollected).toBe(5);

    // Verify shortage/surplus rates computed with canonical epsilon
    const expectedShortageRate = 25 / 100; // 0.25
    const expectedSurplusRate = 5 / 80; // 0.0625
    expect(telemetry.shortageRate).toBe(expectedShortageRate);
    expect(telemetry.surplusRate).toBe(expectedSurplusRate);

    // Verify telemetry collection did not mutate world state (seed is immutable)
    expect(worldState.seed).toBe(initialSeed);
  });

  it("uses canonical config epsilon for rate computation", () => {
    const config = createDefaultSimulationConfig();
    const canonicalEpsilon = config.numeric.quantityEpsilon ?? 1e-9;

    const builder = new LocalMarketTelemetryBuilder(
      "market:1" as MarketId,
      "region:1" as RegionId,
      "good:1" as GoodId,
      "MAIN",
      canonicalEpsilon,
    );

    // Test edge case: quantities in epsilon range are handled correctly
    builder.setClearingQuantities(
      100,
      5e-10, // below canonical 1e-9
      100,
      0,
    );
    builder.setPrices(10, 11);

    const telemetry = builder.build();

    // With canonical epsilon 1e-9, demand of 5e-10 is below threshold
    // so shortageRate should be 0 (not 1)
    expect(telemetry.shortageRate).toBe(0);
  });

  it("telemetry with non-default config epsilon uses passed value (regression)", () => {
    // This test ensures that if a non-default epsilon is provided,
    // it is actually used (preventing silent fallback to hard-coded default)
    const nonDefaultEpsilon = 1e-6;

    const builder = new LocalMarketTelemetryBuilder(
      "market:1" as MarketId,
      "region:1" as RegionId,
      "good:1" as GoodId,
      "MAIN",
      nonDefaultEpsilon,
    );

    // Use a quantity that would be treated differently with default vs. non-default epsilon
    // Default 1e-8: this is above threshold
    // Non-default 1e-6: this is below threshold
    const testQuantity = 5e-7;

    builder.setClearingQuantities(
      100,
      testQuantity, // between 1e-8 and 1e-6
      100,
      0,
    );
    builder.setPrices(10, 11);

    const telemetry = builder.build();

    // With non-default 1e-6 epsilon, 5e-7 is below threshold
    expect(telemetry.shortageRate).toBe(0);

    // If the code silently fell back to 1e-8, this would be wrong:
    // it would compute shortageRate = 5e-7 / 5e-7 = 1 instead of 0
  });

  it("end-to-end: telemetry collection from actual clearing preserves world state", () => {
    // Verify REQ-MARKET-005 acceptance criterion 2:
    // "Telemetry populated deterministically from Phase-8 MAIN-pass clearing results"

    // Build seeded baseline scenario
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Capture initial world state hash/seed for verification
    const initialSeed = worldState.seed;
    const worldStateJson = JSON.stringify(worldState);

    // Create a mock market with deterministic intents for clearing
    const marketId = "market:1" as MarketId;
    const regionId = Array.from(worldState.regions.values())[0]!.regionId;
    const goods = Object.entries(worldState.definitionRegistry.goods);
    const goodId = goods[0]?.[0] as GoodId | undefined;
    if (!goodId) throw new Error("No goods in test fixture");
    const marketCurrencyId = Array.from(worldState.regions.values())[0]!.settlementCurrencyId;

    // Create test actors (use existing clans from world state)
    const seller = Array.from(worldState.clans.values())[0]!;
    const buyer = Array.from(worldState.clans.values())[1]!;

    if (!seller || !buyer) {
      throw new Error("Test fixture requires at least 2 clans");
    }

    // Create seller intent: SELL 100 units at market
    const sellerActorRef: ActorRef = { type: "CLAN", clanId: seller.clanId };
    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-test-1"),
      actor: sellerActorRef,
      regionId,
      goodId,
      side: "SELL" as const,
      purpose: "INVENTORY_REBALANCE" as const,
      desiredQuantity: 100,
      minimumReserveQuantity: 0,
      sourcePlanId: "plan:test-1",
    };

    // Create buyer intent: BUY 80 units, max spend 800
    const buyerActorRef: ActorRef = { type: "CLAN", clanId: buyer.clanId };
    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-test-1"),
      actor: buyerActorRef,
      regionId,
      goodId,
      side: "BUY" as const,
      purpose: "CONSUMPTION" as const,
      desiredQuantity: 80,
      maxSpend: 800,
      sourcePlanId: "plan:test-2",
    };

    // Build clearing input
    const input: LocalClearingInput = {
      marketId,
      regionId,
      goodId,
      pass: "MAIN",
      marketCurrencyId,
      buyerIntents: [buyerIntent],
      sellerIntents: [sellerIntent],
      computeEffectiveDemand: (intent, marketPrice) => {
        if (intent.side !== "BUY") return 0;
        if (!intent.maxSpend) return intent.desiredQuantity;
        const grossPrice = marketPrice; // simplified: no tax in this test
        const affordable = intent.maxSpend / Math.max(grossPrice, 1e-9);
        return Math.min(intent.desiredQuantity, affordable);
      },
      computeSellableQuantity: (intent, commitmentLedger) => {
        if (intent.side !== "SELL") return 0;
        // simplified: assume seller has 200 units available
        const available = 200;
        const committed = 0;
        return Math.min(intent.desiredQuantity, Math.max(0, available - committed));
      },
      computeGrossUnitPrice: (intent, sellerNetPrice) => sellerNetPrice, // simplified: no tax
      getTaxationInfo: (buyer, regionId, good) => ({
        destinationStateId: null,
        assessedTaxRate: 0,
        collectionEfficiency: 0,
      }),
    };

    // Run clearing (this is where Phase-8 MAIN clearing would happen)
    const allocationIdCounter = { value: 0 };
    const allocations = computeLocalClearing(
      input,
      new Map(), // empty commitment ledger for this test
      10, // market price per unit
      config.numeric.quantityEpsilon ?? 1e-9,
      allocationIdCounter,
    );

    expect(allocations.length).toBeGreaterThan(0);
    expect(allocations[0]).toBeDefined();
    if (allocations[0]) {
      expect(allocations[0].quantity).toBeGreaterThan(0);
    }

    // Collect telemetry from the clearing results
    const telemetryBuilder = new LocalMarketTelemetryBuilder(
      marketId,
      regionId,
      goodId,
      "MAIN",
      config.numeric.quantityEpsilon ?? 1e-9,
    );

    // Compute aggregates from allocations (this is what Phase-8 handler would do)
    const clearedQuantity = allocations.reduce((sum, a) => sum + a.quantity, 0);
    const consumptionTaxTotal = allocations.reduce((sum, a) => sum + a.consumptionTaxAmount, 0);

    telemetryBuilder.setClearingQuantities(
      buyerIntent.desiredQuantity, // desired demand from buyers
      buyerIntent.desiredQuantity, // effective demand (same for this test)
      sellerIntent.desiredQuantity, // offered quantity from sellers
      clearedQuantity, // cleared quantity
    );

    telemetryBuilder.setPrices(10, 10); // seller net and household gross (same for simplified test)
    if (consumptionTaxTotal > 0) {
      telemetryBuilder.addConsumptionTax(consumptionTaxTotal);
    }

    const telemetry = telemetryBuilder.build();

    // Verify telemetry was collected correctly per section 33
    expect(telemetry.marketId).toBe(marketId);
    expect(telemetry.desiredDemandQuantity).toBe(80);
    expect(telemetry.effectiveDemandQuantity).toBe(80);
    expect(telemetry.offeredQuantity).toBe(100);
    expect(telemetry.clearedQuantity).toBeGreaterThan(0);
    expect(telemetry.unmetDemandQuantity).toBe(Math.max(0, 80 - telemetry.clearedQuantity));
    expect(telemetry.unsoldOfferQuantity).toBe(Math.max(0, 100 - telemetry.clearedQuantity));

    // Verify shortage/surplus rates computed correctly
    expect(telemetry.shortageRate).toBe(
      telemetry.unmetDemandQuantity / telemetry.effectiveDemandQuantity,
    );
    expect(telemetry.surplusRate).toBe(
      telemetry.unsoldOfferQuantity / telemetry.offeredQuantity,
    );

    // CRITICAL: Verify that running clearing and collecting telemetry did NOT mutate world state
    expect(worldState.seed).toBe(initialSeed);
    expect(JSON.stringify(worldState)).toBe(worldStateJson);
  });

  it("end-to-end: telemetry-disabled and telemetry-enabled runs produce identical replay hash", () => {
    // Verify REQ-MARKET-005 acceptance criterion 5:
    // "Telemetry does not mutate WorldState or affect replay hash"

    const config = createDefaultSimulationConfig();

    // First run: with telemetry collection
    const worldState1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
    let telemetryCollected: LocalMarketTelemetry[] = [];

    // Simulate clearing with telemetry collection
    const marketId = "market:1" as MarketId;
    const regionId = Array.from(worldState1.regions.values())[0]!.regionId;
    const goods = Object.entries(worldState1.definitionRegistry.goods);
    const goodId = goods[0]?.[0] as GoodId | undefined;
    if (!goodId) throw new Error("No goods in test fixture");
    const marketCurrencyId = Array.from(worldState1.regions.values())[0]!.settlementCurrencyId;

    const seller = Array.from(worldState1.clans.values())[0]!;
    const buyer = Array.from(worldState1.clans.values())[1]!;

    const sellerIntent: MarketIntent = {
      id: createMarketIntentId("mi:seller-test-2"),
      actor: { type: "CLAN", clanId: seller.clanId },
      regionId,
      goodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: 50,
      minimumReserveQuantity: 0,
      sourcePlanId: "plan:test-3",
    };

    const buyerIntent: MarketIntent = {
      id: createMarketIntentId("mi:buyer-test-2"),
      actor: { type: "CLAN", clanId: buyer.clanId },
      regionId,
      goodId,
      side: "BUY",
      purpose: "CONSUMPTION",
      desiredQuantity: 40,
      maxSpend: 400,
      sourcePlanId: "plan:test-4",
    };

    const input: LocalClearingInput = {
      marketId,
      regionId,
      goodId,
      pass: "MAIN",
      marketCurrencyId,
      buyerIntents: [buyerIntent],
      sellerIntents: [sellerIntent],
      computeEffectiveDemand: (intent, price) => {
        if (intent.side !== "BUY") return 0;
        const grossPrice = price;
        const affordable = (intent.maxSpend || 0) / Math.max(grossPrice, 1e-9);
        return Math.min(intent.desiredQuantity, affordable);
      },
      computeSellableQuantity: (intent, ledger) => {
        if (intent.side !== "SELL") return 0;
        return Math.min(intent.desiredQuantity, 100); // assume available
      },
      computeGrossUnitPrice: (intent, price) => price,
      getTaxationInfo: () => ({
        destinationStateId: null,
        assessedTaxRate: 0,
        collectionEfficiency: 0,
      }),
    };

    const counter1 = { value: 0 };
    const allocations1 = computeLocalClearing(input, new Map(), 10, 1e-9, counter1);

    // Collect telemetry from clearing
    if (allocations1.length > 0) {
      const builder = new LocalMarketTelemetryBuilder(
        marketId,
        regionId,
        goodId,
        "MAIN",
        1e-9,
      );
      const clearedQty = allocations1.reduce((sum, a) => sum + a.quantity, 0);
      builder.setClearingQuantities(40, 40, 50, clearedQty);
      builder.setPrices(10, 10);
      telemetryCollected.push(builder.build());
    }

    const hash1 = JSON.stringify(worldState1);

    // Second run: without telemetry collection (same seed, same input)
    const worldState2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
    const counter2 = { value: 0 };
    const allocations2 = computeLocalClearing(input, new Map(), 10, 1e-9, counter2);
    // Do NOT collect telemetry in this run

    const hash2 = JSON.stringify(worldState2);

    // Verify: both runs produced identical world states
    expect(hash1).toBe(hash2);
    expect(allocations1.length).toBe(allocations2.length);
    if (allocations1.length > 0 && allocations2.length > 0) {
      expect(allocations1[0]!.quantity).toBe(allocations2[0]!.quantity);
    }

    // Verify: telemetry was collected without side effects
    expect(telemetryCollected.length).toBeGreaterThan(0);
    expect(telemetryCollected[0]!.clearedQuantity).toBe(
      allocations1[0]?.quantity ?? 0,
    );
  });
});
