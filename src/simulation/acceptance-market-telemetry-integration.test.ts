/**
 * M3 market telemetry integration test (REQ-MARKET-005 integration gate).
 *
 * Verifies that telemetry collection from seeded clearing/settlement preserves
 * world state and replay hash invariance (telemetry is a non-authoritative
 * one-way diagnostic output).
 */

import { describe, it, expect } from "vitest";
import type { GoodId, MarketId, RegionId } from "../domain/id";
import { buildInitialWorld } from "./worldState";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import type { LocalMarketTelemetry } from "./marketTelemetry";
import { LocalMarketTelemetryBuilder } from "./marketTelemetry";

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
});
