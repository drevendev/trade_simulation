/**
 * Market telemetry tests (REQ-MARKET-005).
 */

import { describe, it, expect } from "vitest";
import type { MarketId, RegionId, GoodId } from "../domain/id";
import {
  computeShortageRate,
  computeSurplusRate,
  LocalMarketTelemetryBuilder,
  type LocalMarketTelemetry,
} from "./marketTelemetry";

describe("marketTelemetry", () => {
  describe("computeShortageRate", () => {
    it("computes shortage rate as unmet / effective demand", () => {
      const rate = computeShortageRate(50, 100);
      expect(rate).toBe(0.5);
    });

    it("returns 0 when effective demand is zero", () => {
      const rate = computeShortageRate(50, 0);
      expect(rate).toBe(0);
    });

    it("returns 0 when effective demand is below epsilon", () => {
      const rate = computeShortageRate(50, 1e-9);
      expect(rate).toBe(0);
    });

    it("handles unmet demand equal to effective demand (complete shortage)", () => {
      const rate = computeShortageRate(100, 100);
      expect(rate).toBe(1);
    });

    it("handles zero unmet demand (no shortage)", () => {
      const rate = computeShortageRate(0, 100);
      expect(rate).toBe(0);
    });

    it("uses custom epsilon for zero check", () => {
      const rate = computeShortageRate(50, 1e-7, 1e-6);
      expect(rate).toBe(0);
    });
  });

  describe("computeSurplusRate", () => {
    it("computes surplus rate as unsold / offered quantity", () => {
      const rate = computeSurplusRate(30, 100);
      expect(rate).toBe(0.3);
    });

    it("returns 0 when offered quantity is zero", () => {
      const rate = computeSurplusRate(30, 0);
      expect(rate).toBe(0);
    });

    it("returns 0 when offered quantity is below epsilon", () => {
      const rate = computeSurplusRate(30, 1e-9);
      expect(rate).toBe(0);
    });

    it("handles unsold quantity equal to offered quantity (complete surplus)", () => {
      const rate = computeSurplusRate(100, 100);
      expect(rate).toBe(1);
    });

    it("handles zero unsold quantity (no surplus)", () => {
      const rate = computeSurplusRate(0, 100);
      expect(rate).toBe(0);
    });

    it("uses custom epsilon for zero check", () => {
      const rate = computeSurplusRate(30, 1e-7, 1e-6);
      expect(rate).toBe(0);
    });
  });

  describe("LocalMarketTelemetryBuilder", () => {
    it("initializes with market/region/good/pass keys", () => {
      const marketId = "market:1" as MarketId;
      const builder = new LocalMarketTelemetryBuilder(
        marketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      expect(builder.marketId).toBe(marketId);
      expect(builder.regionId).toBe("region:1");
      expect(builder.goodId).toBe("good:1");
      expect(builder.pass).toBe("MAIN");
    });

    it("initializes all quantities to zero", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      expect(builder.desiredDemandQuantity).toBe(0);
      expect(builder.effectiveDemandQuantity).toBe(0);
      expect(builder.offeredQuantity).toBe(0);
      expect(builder.clearedQuantity).toBe(0);
      expect(builder.sellerNetPrice).toBe(0);
      expect(builder.householdGrossPrice).toBe(0);
      expect(builder.unmetDemandQuantity).toBe(0);
      expect(builder.unsoldOfferQuantity).toBe(0);
      expect(builder.consumptionTaxCollected).toBe(0);
    });

    it("setClearingQuantities computes unmet and unsold quantities", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      builder.setClearingQuantities(100, 100, 80, 60);

      expect(builder.desiredDemandQuantity).toBe(100);
      expect(builder.effectiveDemandQuantity).toBe(100);
      expect(builder.offeredQuantity).toBe(80);
      expect(builder.clearedQuantity).toBe(60);
      expect(builder.unmetDemandQuantity).toBe(40); // 100 - 60
      expect(builder.unsoldOfferQuantity).toBe(20); // 80 - 60
    });

    it("setClearingQuantities clamps unmet/unsold to >= 0", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      // If cleared > effective demand or offered, unmet/unsold should still be 0
      builder.setClearingQuantities(100, 80, 100, 100);

      expect(builder.unmetDemandQuantity).toBe(0);
      expect(builder.unsoldOfferQuantity).toBe(0);
    });

    it("setPrices stores net and gross price", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      builder.setPrices(10, 12);

      expect(builder.sellerNetPrice).toBe(10);
      expect(builder.householdGrossPrice).toBe(12);
    });

    it("addConsumptionTax accumulates tax amount", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      builder.addConsumptionTax(10);
      builder.addConsumptionTax(5);
      builder.addConsumptionTax(3);

      expect(builder.consumptionTaxCollected).toBe(18);
    });

    it("build() computes shortage and surplus rates", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      builder.setClearingQuantities(100, 100, 80, 60);
      builder.setPrices(10, 12);
      builder.addConsumptionTax(15);

      const telemetry = builder.build();

      expect(telemetry.shortageRate).toBe(0.4); // (100-60) / 100
      expect(telemetry.surplusRate).toBe(0.25); // (80-60) / 80
      expect(telemetry.consumptionTaxCollected).toBe(15);
    });

    it("build() returns a valid LocalMarketTelemetry object", () => {
      const marketId = "market:1" as MarketId;
      const builder = new LocalMarketTelemetryBuilder(
        marketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "PRE_PRODUCTION",
      );

      builder.setClearingQuantities(150, 140, 100, 90);
      builder.setPrices(8, 10);
      builder.addConsumptionTax(20);

      const telemetry = builder.build();

      expect(telemetry.marketId).toBe(marketId);
      expect(telemetry.regionId).toBe("region:1");
      expect(telemetry.goodId).toBe("good:1");
      expect(telemetry.pass).toBe("PRE_PRODUCTION");
      expect(telemetry.desiredDemandQuantity).toBe(150);
      expect(telemetry.effectiveDemandQuantity).toBe(140);
      expect(telemetry.offeredQuantity).toBe(100);
      expect(telemetry.clearedQuantity).toBe(90);
      expect(telemetry.sellerNetPrice).toBe(8);
      expect(telemetry.householdGrossPrice).toBe(10);
      expect(telemetry.unmetDemandQuantity).toBe(50); // 140 - 90
      expect(telemetry.unsoldOfferQuantity).toBe(10); // 100 - 90
      expect(telemetry.shortageRate).toBeCloseTo(50 / 140); // (140-90) / 140
      expect(telemetry.surplusRate).toBeCloseTo(10 / 100); // (100-90) / 100
      expect(telemetry.consumptionTaxCollected).toBe(20);
    });

    it("build() computes zero rates when no demand or supply", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      builder.setClearingQuantities(0, 0, 0, 0);
      builder.setPrices(0, 0);

      const telemetry = builder.build();

      expect(telemetry.shortageRate).toBe(0);
      expect(telemetry.surplusRate).toBe(0);
    });

    it("rejects non-finite values in setClearingQuantities", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      expect(() => {
        builder.setClearingQuantities(Number.NaN, 100, 80, 60);
      }).toThrow();

      expect(() => {
        builder.setClearingQuantities(100, 100, Infinity, 60);
      }).toThrow();

      expect(() => {
        builder.setClearingQuantities(100, 100, 80, -Infinity);
      }).toThrow();
    });

    it("rejects non-finite values in setPrices", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      expect(() => {
        builder.setPrices(Number.NaN, 12);
      }).toThrow();

      expect(() => {
        builder.setPrices(10, Infinity);
      }).toThrow();
    });

    it("rejects non-finite values in addConsumptionTax", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      expect(() => {
        builder.addConsumptionTax(Number.NaN);
      }).toThrow();

      expect(() => {
        builder.addConsumptionTax(Infinity);
      }).toThrow();
    });

    it("handles multiple tax additions correctly", () => {
      const builder = new LocalMarketTelemetryBuilder(
        "market:1" as MarketId,
        "region:1" as RegionId,
        "good:1" as GoodId,
        "MAIN",
      );

      builder.setClearingQuantities(100, 100, 100, 100);
      builder.setPrices(10, 12);

      // Multiple allocations collect tax
      for (let i = 0; i < 5; i++) {
        builder.addConsumptionTax(2);
      }

      const telemetry = builder.build();
      expect(telemetry.consumptionTaxCollected).toBe(10);
    });
  });
});
