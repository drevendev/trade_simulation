/**
 * Tests for Phase-6 price formation (REQ-MARKET-002).
 *
 * Validates:
 * - Bounded log-space repricing formula
 * - Price floor/ceiling enforcement
 * - Demand/supply pressure calculation
 * - Inventory gap calculation
 * - Expectation update logic
 * - Zero-flow market stability
 */

import { describe, it, expect } from "vitest";
import {
  calculateMarketPressure,
  calculateLogPriceChange,
  applyLogPriceChange,
  repriceGoodInPhase6,
  updateMarketExpectations,
} from "./marketPricing";
import type { MarketExpectationState } from "./worldState";

describe("Phase-6 Market Pricing", () => {
  const quantityEpsilon = 1e-9;
  const moneyEpsilon = 1e-9;

  describe("calculateMarketPressure", () => {
    it("should weight excess and inventory gap correctly", () => {
      const pressure = calculateMarketPressure(
        0.5, // excessRatio
        -0.3, // inventoryGapRatio (undersupply)
        0.6, // shortageSignalWeight
        0.4, // inventorySignalWeight
      );

      expect(pressure).toBeCloseTo(0.6 * 0.5 + 0.4 * -0.3, 10);
    });

    it("should sum weighted components without clamping", () => {
      // Per spec: excess and inventoryGap are clamped, but pressure is their weighted sum
      const highPressure = calculateMarketPressure(1, 1, 1, 1);
      const lowPressure = calculateMarketPressure(-1, -1, 1, 1);

      expect(highPressure).toBeCloseTo(2, 10); // 1*1 + 1*1
      expect(lowPressure).toBeCloseTo(-2, 10); // 1*(-1) + 1*(-1)
    });

    it("should handle zero weights", () => {
      const pressure = calculateMarketPressure(0.5, 0.5, 0, 0);
      expect(pressure).toBeCloseTo(0, 10);
    });
  });

  describe("calculateLogPriceChange", () => {
    it("should scale pressure by adjustment speed", () => {
      const logChange = calculateLogPriceChange(0.5, 0.1, 0.2);
      expect(logChange).toBeCloseTo(0.05, 10); // 0.1 * 0.5
    });

    it("should clamp log change to [-maxLogPriceStep, +maxLogPriceStep]", () => {
      const maxStep = 0.1;
      const largePressure = 10; // Would give 1.0 without clamping

      const logChange = calculateLogPriceChange(largePressure, 0.1, maxStep);
      expect(Math.abs(logChange)).toBeLessThanOrEqual(maxStep);
    });

    it("should handle negative pressure (price decrease)", () => {
      const logChange = calculateLogPriceChange(-0.5, 0.2, 0.5);
      expect(logChange).toBeLessThan(0); // Should be negative
      expect(logChange).toBeCloseTo(-0.1, 10);
    });
  });

  describe("applyLogPriceChange", () => {
    it("should apply exponential transformation", () => {
      const oldPrice = 10;
      const logChange = Math.log(1.1); // 10% increase
      const newPrice = applyLogPriceChange(oldPrice, logChange, 0, 100);

      expect(newPrice).toBeCloseTo(11, 9);
    });

    it("should enforce minimum price floor", () => {
      const oldPrice = 5;
      const logChange = -1; // Large decrease
      const newPrice = applyLogPriceChange(oldPrice, logChange, 2, 100);

      expect(newPrice).toBe(2); // Clamped to min
    });

    it("should enforce maximum price ceiling", () => {
      const oldPrice = 50;
      const logChange = 1; // Large increase
      const newPrice = applyLogPriceChange(oldPrice, logChange, 0, 100);

      expect(newPrice).toBe(100); // Clamped to max
    });

    it("should remain within bounds for zero change", () => {
      const oldPrice = 25;
      const newPrice = applyLogPriceChange(oldPrice, 0, 10, 40);
      expect(newPrice).toBeCloseTo(25, 9);
    });
  });

  describe("repriceGoodInPhase6", () => {
    const config = {
      shortageSignalWeight: 0.5,
      inventorySignalWeight: 0.5,
      basePriceAdjustmentSpeed: 0.1,
      maxAbsoluteLogPriceMovePerTick: 0.1,
      targetInventoryCoverageTicks: 1.0,
      minimumPrice: 1.0,
      maximumPrice: 100.0,
    };

    const emptyExpectation: MarketExpectationState = {
      observationCount: 0,
      expectedUseEma: 0,
      shortageEma: 0,
      surplusEma: 0,
      lastEffectiveDemand: 0,
      lastOfferedQuantity: 0,
      lastClearedQuantity: 0,
    };

    it("should leave price unchanged when demand and supply are zero", () => {
      const currentPrice = 10;
      const newPrice = repriceGoodInPhase6(
        currentPrice,
        0, // effectiveDemand
        0, // sellableSupply
        10, // marketFacingStock
        emptyExpectation,
        quantityEpsilon,
        config,
      );

      expect(newPrice).toBe(currentPrice);
    });

    it("should increase price under excess demand", () => {
      const currentPrice = 10;
      const newPrice = repriceGoodInPhase6(
        currentPrice,
        100, // high demand
        10, // low supply
        10, // modest stock
        emptyExpectation,
        quantityEpsilon,
        config,
      );

      expect(newPrice).toBeGreaterThan(currentPrice); // Price should rise
    });

    it("should decrease price under excess supply", () => {
      const currentPrice = 10;
      const newPrice = repriceGoodInPhase6(
        currentPrice,
        10, // low demand
        100, // high supply
        200, // abundant stock
        emptyExpectation,
        quantityEpsilon,
        config,
      );

      expect(newPrice).toBeLessThan(currentPrice); // Price should fall
    });

    it("should use current demand before first observation", () => {
      const currentPrice = 10;
      const highDemand = 100;
      const newPrice = repriceGoodInPhase6(
        currentPrice,
        highDemand,
        50,
        10, // low stock relative to demand
        emptyExpectation,
        quantityEpsilon,
        config,
      );

      // Should respond to current high demand
      expect(newPrice).toBeGreaterThan(currentPrice);
    });

    it("should respect price bounds", () => {
      const tightConfig = { ...config, minimumPrice: 5.0, maximumPrice: 15.0 };
      const currentPrice = 10;

      // Large positive pressure should hit ceiling
      const newPrice = repriceGoodInPhase6(
        currentPrice,
        1000, // huge excess demand
        1,
        1,
        emptyExpectation,
        quantityEpsilon,
        tightConfig,
      );

      expect(newPrice).toBeLessThanOrEqual(tightConfig.maximumPrice);
      expect(newPrice).toBeGreaterThanOrEqual(tightConfig.minimumPrice);
    });

    it("should handle inventory-gap-driven repricing", () => {
      const currentPrice = 10;
      const config2 = { ...config, inventorySignalWeight: 1.0, shortageSignalWeight: 0.0 };

      // Overstocked: inventory >> target coverage
      const newPrice = repriceGoodInPhase6(
        currentPrice,
        50, // normal demand
        50, // normal supply
        500, // huge stock
        emptyExpectation,
        quantityEpsilon,
        config2,
      );

      // Should decrease price to move inventory
      expect(newPrice).toBeLessThan(currentPrice);
    });
  });

  describe("updateMarketExpectations", () => {
    const baseExpectation: MarketExpectationState = {
      observationCount: 0,
      expectedUseEma: 0,
      shortageEma: 0,
      surplusEma: 0,
      lastEffectiveDemand: 0,
      lastOfferedQuantity: 0,
      lastClearedQuantity: 0,
    };

    it("should leave expectations unchanged if both demand and supply are near-zero", () => {
      const updated = updateMarketExpectations(
        baseExpectation,
        0, // effectiveDemandQuantity
        0, // offeredQuantity
        0, // clearedQuantity
        quantityEpsilon,
        0.2,
      );

      expect(updated).toEqual(baseExpectation);
    });

    it("should initialize EMAs on first observation", () => {
      const observedDemand = 100;
      const observedSupply = 80;
      const clearedQty = 80;

      const updated = updateMarketExpectations(
        baseExpectation,
        observedDemand,
        observedSupply,
        clearedQty,
        quantityEpsilon,
        0.2,
      );

      expect(updated.observationCount).toBe(1);
      expect(updated.expectedUseEma).toBe(observedDemand);
      expect(updated.shortageEma).toBeCloseTo((observedDemand - clearedQty) / observedDemand, 10);
      expect(updated.surplusEma).toBe(0); // No surplus when supply clears
      expect(updated.lastEffectiveDemand).toBe(observedDemand);
    });

    it("should apply alpha-weighted EMA on subsequent observations", () => {
      const alpha = 0.2;
      const priorExpectation: MarketExpectationState = {
        observationCount: 5,
        expectedUseEma: 100,
        shortageEma: 0.1,
        surplusEma: 0.0,
        lastEffectiveDemand: 100,
        lastOfferedQuantity: 100,
        lastClearedQuantity: 90,
      };

      const newDemand = 120;
      const newSupply = 110;
      const newCleared = 110;

      const updated = updateMarketExpectations(
        priorExpectation,
        newDemand,
        newSupply,
        newCleared,
        quantityEpsilon,
        alpha,
      );

      expect(updated.observationCount).toBe(6);
      expect(updated.expectedUseEma).toBeCloseTo(
        alpha * newDemand + (1 - alpha) * priorExpectation.expectedUseEma,
        10,
      );
    });

    it("should correctly calculate shortage rate", () => {
      const baseExp: MarketExpectationState = {
        observationCount: 1,
        expectedUseEma: 100,
        shortageEma: 0.2,
        surplusEma: 0,
        lastEffectiveDemand: 100,
        lastOfferedQuantity: 100,
        lastClearedQuantity: 100,
      };

      const demand = 100;
      const supply = 100;
      const cleared = 80; // 20% unmet

      const updated = updateMarketExpectations(
        baseExp,
        demand,
        supply,
        cleared,
        quantityEpsilon,
        0.5,
      );

      expect(updated.shortageEma).toBeCloseTo(0.5 * 0.2 + 0.5 * 0.2, 10); // alpha * 0.2 + (1-alpha) * 0.2
    });

    it("should correctly calculate surplus rate", () => {
      const baseExp: MarketExpectationState = {
        observationCount: 1,
        expectedUseEma: 100,
        shortageEma: 0,
        surplusEma: 0.1,
        lastEffectiveDemand: 100,
        lastOfferedQuantity: 100,
        lastClearedQuantity: 100,
      };

      const demand = 60;
      const supply = 100;
      const cleared = 60; // 40% unsold

      const updated = updateMarketExpectations(
        baseExp,
        demand,
        supply,
        cleared,
        quantityEpsilon,
        0.5,
      );

      expect(updated.surplusEma).toBeCloseTo(0.5 * 0.4 + 0.5 * 0.1, 10);
    });

    it("should handle zero demand correctly", () => {
      const updated = updateMarketExpectations(
        baseExpectation,
        0.001,
        100, // supply with no demand
        0,
        quantityEpsilon,
        0.2,
      );

      // Very little demand, high shortage rate
      expect(updated.observationCount).toBe(1);
      expect(updated.surplusEma).toBeCloseTo(1.0, 9); // 100% unsold
    });

    it("should handle zero supply correctly", () => {
      const updated = updateMarketExpectations(
        baseExpectation,
        100,
        0.001, // supply with no demand
        0,
        quantityEpsilon,
        0.2,
      );

      // Very little supply, high shortage rate
      expect(updated.observationCount).toBe(1);
      expect(updated.shortageEma).toBeCloseTo(1.0, 9); // 100% unmet
    });

    it("should track last observation values", () => {
      const demand = 75;
      const supply = 85;
      const cleared = 70;

      const updated = updateMarketExpectations(
        baseExpectation,
        demand,
        supply,
        cleared,
        quantityEpsilon,
        0.2,
      );

      expect(updated.lastEffectiveDemand).toBe(demand);
      expect(updated.lastOfferedQuantity).toBe(supply);
      expect(updated.lastClearedQuantity).toBe(cleared);
    });
  });

  describe("Integration: Full repricing cycle", () => {
    const config = {
      shortageSignalWeight: 0.6,
      inventorySignalWeight: 0.4,
      basePriceAdjustmentSpeed: 0.15,
      maxAbsoluteLogPriceMovePerTick: 0.2,
      targetInventoryCoverageTicks: 2.0,
      minimumPrice: 0.5,
      maximumPrice: 50.0,
    };

    it("should handle realistic demand/supply/price cycle", () => {
      // Scenario: shortage, then gradual price response
      let expectation: MarketExpectationState = {
        observationCount: 0,
        expectedUseEma: 0,
        shortageEma: 0,
        surplusEma: 0,
        lastEffectiveDemand: 0,
        lastOfferedQuantity: 0,
        lastClearedQuantity: 0,
      };

      let price = 10.0;
      const demandSeq: number[] = [100, 120, 130]; // Rising demand
      const supplySeq: number[] = [80, 90, 100]; // Rising supply but lagging
      const stockSeq: number[] = [10, 15, 20]; // Growing inventory

      for (let i = 0; i < demandSeq.length; i++) {
        const demand = demandSeq[i]!;
        const supply = supplySeq[i]!;
        const stock = stockSeq[i]!;

        const newPrice = repriceGoodInPhase6(
          price,
          demand,
          supply,
          stock,
          expectation,
          1e-9,
          config,
        );

        // Prices should rise when demand > supply
        if (demand > supply) {
          expect(newPrice).toBeGreaterThanOrEqual(price);
        }

        price = newPrice;

        // Update expectations after clearing
        expectation = updateMarketExpectations(
          expectation,
          demand,
          supply,
          Math.min(demand, supply),
          1e-9,
          0.2,
        );
      }

      // After multiple shortages, expectations should reflect scarcity
      expect(expectation.observationCount).toBe(3);
      expect(expectation.shortageEma).toBeGreaterThan(0); // Non-zero shortage signal
    });
  });
});
