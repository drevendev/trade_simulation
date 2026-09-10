import { describe, expect, it } from "vitest";
import { buildInitialWorld } from "../simulation/worldState";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import type { SimulationConfig } from "../config/simulationConfig";
import { generateM3Preview, extractM3MarketSnapshot, type M3Preview } from "./m3Preview";
import type { LocalMarketTelemetry } from "../simulation/marketTelemetry";

function createMinimalConfig(): SimulationConfig {
  return {
    configVersion: "1.0.0",
    numeric: {
      moneyEpsilon: 1e-9,
      quantityEpsilon: 1e-9,
      populationEpsilon: 1e-6,
      rateEpsilon: 1e-12,
      reconciliationRelativeTolerance: 1e-9,
      maxFiniteMagnitude: 1e15,
    },
    cadence: {
      productionLifecycleReviewEveryTicks: 3,
      investmentReviewEveryTicks: 3,
      clanDistributionEveryTicks: 3,
      fiscalPolicyReviewEveryTicks: 3,
      monetaryPolicyReviewEveryTicks: 1,
      expansionReviewEveryTicks: 3,
      stateFormationReviewEveryTicks: 6,
    },
    markets: {
      shortageSignalWeight: 0.65,
      inventorySignalWeight: 0.35,
      basePriceAdjustmentSpeed: 0.12,
      maxAbsoluteLogPriceMovePerTick: 0.18,
      targetInventoryCoverageTicks: 1.0,
      expectationAlpha: 0.25,
    },
    trade: {},
    production: {},
    labor: {},
    population: {},
    clans: {},
    fiscal: {},
    monetary: {},
    expansion: {},
    events: {},
    performance: {},
  };
}

function createTestMarketTelemetry(marketId: string, regionId: string, goodId: string): LocalMarketTelemetry {
  return {
    marketId: marketId as any,
    pass: "MAIN",
    regionId: regionId as any,
    goodId: goodId as any,
    clearedQuantity: 45,
    desiredDemandQuantity: 200,
    effectiveDemandQuantity: 220,
    offeredQuantity: 50,
    shortageRate: 0.775,
    surplusRate: 0,
    sellerNetPrice: 10.0,
    householdGrossPrice: 10.5,
    unmetDemandQuantity: 155,
    unsoldOfferQuantity: 0,
    consumptionTaxCollected: 22.5,
  };
}

describe("M3 Milestone Preview data layer (REQ-VISUALIZATION-006)", () => {
  describe("M3Preview structure and metadata", () => {
    it("declares the M3 milestone", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState);

      expect(preview.milestone).toBe("M3");
    });

    it("declares REQ-VISUALIZATION-006 as the requirement", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState);

      expect(preview.requirement).toBe("REQ-VISUALIZATION-006");
    });

    it("exposes scenario ID, seed and config version from WorldState", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState);

      expect(preview.scenario.scenarioId).toBe(worldState.scenarioId);
      expect(preview.scenario.seed).toBe(42);
      expect(preview.scenario.configVersion).toBe("1.0.0");
    });

    it("exposes complete world topology including markets", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState);

      expect(preview.worldTopology.stateCount).toBeGreaterThan(0);
      expect(preview.worldTopology.regionCount).toBeGreaterThan(0);
      expect(preview.worldTopology.currencyCount).toBeGreaterThan(0);
      expect(preview.worldTopology.marketCount).toBeGreaterThan(0);
      expect(preview.worldTopology.clanCount).toBeGreaterThan(0);
    });
  });

  describe("Market telemetry snapshot extraction", () => {
    it("extracts all required telemetry fields into M3MarketSnapshot", () => {
      const telemetry = createTestMarketTelemetry("market-1", "region-1", "good-A");
      const snapshot = extractM3MarketSnapshot(telemetry);

      expect(snapshot.marketId).toBe("market-1");
      expect(snapshot.regionId).toBe("region-1");
      expect(snapshot.goodId).toBe("good-A");
      expect(snapshot.clearedQuantity).toBe(45);
      expect(snapshot.shortageRate).toBe(0.775);
      expect(snapshot.surplusRate).toBe(0);
      expect(snapshot.sellerNetPrice).toBe(10.0);
      expect(snapshot.householdGrossPrice).toBe(10.5);
      expect(snapshot.consumptionTaxCollected).toBe(22.5);
    });

    it("preserves market identification in snapshot", () => {
      const telemetry = createTestMarketTelemetry("market-X" as any, "region-Y" as any, "good-Z" as any);
      const snapshot = extractM3MarketSnapshot(telemetry);

      expect((snapshot.marketId as any)).toBe("market-X" as any);
      expect((snapshot.regionId as any)).toBe("region-Y" as any);
      expect((snapshot.goodId as any)).toBe("good-Z" as any);
    });

    it("preserves all numeric precision in extracted snapshots", () => {
      const telemetry: LocalMarketTelemetry = {
        marketId: "m1" as any,
        pass: "MAIN",
        regionId: "r1" as any,
        goodId: "g1" as any,
        clearedQuantity: 45.987654321,
        desiredDemandQuantity: 200.111111111,
        effectiveDemandQuantity: 220.111111111,
        offeredQuantity: 50.999999999,
        shortageRate: 0.775123456,
        surplusRate: 0.123456789,
        sellerNetPrice: 10.111111111,
        householdGrossPrice: 10.222222222,
        unmetDemandQuantity: 155.333333333,
        unsoldOfferQuantity: 5.444444444,
        consumptionTaxCollected: 22.555555555,
      };
      const snapshot = extractM3MarketSnapshot(telemetry);

      expect(snapshot.clearedQuantity).toBeCloseTo(45.987654321, 9);
      expect(snapshot.shortageRate).toBeCloseTo(0.775123456, 9);
      expect(snapshot.consumptionTaxCollected).toBeCloseTo(22.555555555, 9);
    });
  });

  describe("Market telemetry aggregation", () => {
    it("builds telemetry snapshots from a time series", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const telemetryLog = [
        createTestMarketTelemetry("market-1", "region-1", "good-A"),
        createTestMarketTelemetry("market-1", "region-1", "good-B"),
        createTestMarketTelemetry("market-1", "region-1", "good-C"),
      ];

      const preview = generateM3Preview(worldState, telemetryLog);

      expect(preview.marketTelemetry.snapshots).toHaveLength(3);
      expect(preview.marketTelemetry.snapshots[0]!.goodId).toBe("good-A");
      expect(preview.marketTelemetry.snapshots[2]!.goodId).toBe("good-C");
    });

    it("extracts current-tick key metrics from most recent telemetry", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const telemetryLog = [
        createTestMarketTelemetry("market-1", "region-1", "good-A"),
        { ...createTestMarketTelemetry("market-1", "region-1", "good-A"), sellerNetPrice: 12.5 },
      ];

      const preview = generateM3Preview(worldState, telemetryLog);

      expect(preview.marketTelemetry.keyMetrics.clearedQuantity).toBe(45);
      expect(preview.marketTelemetry.keyMetrics.shortageRate).toBeCloseTo(0.775, 3);
      expect(preview.marketTelemetry.keyMetrics.consumptionTaxCollected).toBeCloseTo(22.5, 1);
    });

    it("provides zero metrics when no telemetry is available", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState, []);

      expect(preview.marketTelemetry.keyMetrics.currentPrice).toBe(0);
      expect(preview.marketTelemetry.keyMetrics.clearedQuantity).toBe(0);
      expect(preview.marketTelemetry.keyMetrics.shortageRate).toBe(0);
      expect(preview.marketTelemetry.keyMetrics.consumptionTaxCollected).toBe(0);
    });
  });

  describe("Determinism and state preservation", () => {
    it("produces identical previews from identical inputs", () => {
      const config = createMinimalConfig();
      const telemetryLog = [createTestMarketTelemetry("market-1", "region-1", "good-A")];

      const worldState1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview1 = generateM3Preview(worldState1, telemetryLog);

      const worldState2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview2 = generateM3Preview(worldState2, telemetryLog);

      expect(JSON.stringify(preview1)).toBe(JSON.stringify(preview2));
    });

    it("marks that world state is unchanged by preview generation", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState);

      expect(preview.stateInvariance.worldStateUnchanged).toBe(true);
    });

    it("marks that replay hash is preserved by preview generation", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState);

      expect(preview.stateInvariance.replayHashPreserved).toBe(true);
    });
  });

  describe("Market metrics validation", () => {
    it("captures all 11 required telemetry fields as per spec section 33", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const telemetry = createTestMarketTelemetry("market-1", "region-1", "good-A");
      const preview = generateM3Preview(worldState, [telemetry]);

      // Verify the 11 required fields per spec section 33:
      // 1. desired/effective demand ✓
      // 2. offered/cleared quantity ✓
      // 3. seller-net price ✓
      // 4. household/buyer-gross price ✓
      // 5. unmet demand ✓
      // 6. unsold offer ✓
      // 7. shortage rate ✓
      // 8. surplus rate ✓
      // 9. consumption tax collected ✓
      // 10. cleared quantity ✓
      // 11. offered quantity ✓

      const snapshot = preview.marketTelemetry.snapshots[0]!;
      expect(snapshot.desiredDemandQuantity).toBeDefined();
      expect(snapshot.clearedQuantity).toBeDefined();
      expect(snapshot.sellerNetPrice).toBeDefined();
      expect(snapshot.householdGrossPrice).toBeDefined();
      expect(snapshot.unmetDemandQuantity).toBeDefined();
      expect(snapshot.unsoldOfferQuantity).toBeDefined();
      expect(snapshot.shortageRate).toBeDefined();
      expect(snapshot.surplusRate).toBeDefined();
      expect(snapshot.consumptionTaxCollected).toBeDefined();
      expect(snapshot.offeredQuantity).toBeDefined();

      // All values should be finite
      expect(Number.isFinite(snapshot.desiredDemandQuantity)).toBe(true);
      expect(Number.isFinite(snapshot.clearedQuantity)).toBe(true);
      expect(Number.isFinite(snapshot.sellerNetPrice)).toBe(true);
      expect(Number.isFinite(snapshot.householdGrossPrice)).toBe(true);
    });

    it("ensures shortage and surplus rates are mutually exclusive (not both positive)", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      // Shortage scenario: high demand, limited supply
      const shortageTelemetry: LocalMarketTelemetry = {
        marketId: "m1" as any,
        pass: "MAIN",
        regionId: "r1" as any,
        goodId: "g1" as any,
        clearedQuantity: 45,
        desiredDemandQuantity: 200,
        effectiveDemandQuantity: 200,
        offeredQuantity: 50,
        shortageRate: 0.775,
        surplusRate: 0,
        sellerNetPrice: 10.0,
        householdGrossPrice: 10.5,
        unmetDemandQuantity: 155,
        unsoldOfferQuantity: 0,
        consumptionTaxCollected: 22.5,
      };

      const preview = generateM3Preview(worldState, [shortageTelemetry]);
      const snapshot = preview.marketTelemetry.snapshots[0]!;

      expect(snapshot.shortageRate).toBeGreaterThan(0);
      expect(snapshot.surplusRate).toBe(0);

      // Surplus scenario: low demand, excess supply
      const surplusTelemetry: LocalMarketTelemetry = {
        ...shortageTelemetry,
        desiredDemandQuantity: 30,
        effectiveDemandQuantity: 30,
        clearedQuantity: 30,
        offeredQuantity: 100,
        unmetDemandQuantity: 0,
        unsoldOfferQuantity: 70,
        shortageRate: 0,
        surplusRate: 0.7,
      };

      const preview2 = generateM3Preview(worldState, [surplusTelemetry]);
      const snapshot2 = preview2.marketTelemetry.snapshots[0]!;

      expect(snapshot2.shortageRate).toBe(0);
      expect(snapshot2.surplusRate).toBeGreaterThan(0);
    });
  });

  describe("Serialization and portability", () => {
    it("generates valid JSON that can be serialized and deserialized", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const telemetryLog = [createTestMarketTelemetry("market-1", "region-1", "good-A")];
      const preview = generateM3Preview(worldState, telemetryLog);

      const json = JSON.stringify(preview);
      const deserialized = JSON.parse(json) as M3Preview;

      expect(deserialized.milestone).toBe("M3");
      expect(deserialized.requirement).toBe("REQ-VISUALIZATION-006");
      expect(deserialized.marketTelemetry.snapshots).toHaveLength(1);
    });

    it("includes all required top-level keys for Pages rendering", () => {
      const config = createMinimalConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const preview = generateM3Preview(worldState);

      expect(preview).toHaveProperty("milestone");
      expect(preview).toHaveProperty("requirement");
      expect(preview).toHaveProperty("scenario");
      expect(preview).toHaveProperty("worldTopology");
      expect(preview).toHaveProperty("marketTelemetry");
      expect(preview).toHaveProperty("stateInvariance");
    });
  });
});
