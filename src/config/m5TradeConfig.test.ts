/** M5 / #669: explicit trade defaults and fail-fast genesis validation, not settlement. */
import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "./fixtures/baselineDefinitionPack";
import { baselineScenario } from "./fixtures/baselineScenario";
import {
  createDefaultSimulationConfig,
  validateTradeConfig,
  type TradeConfig,
} from "./simulationConfig";
import { buildInitialWorld } from "../simulation/worldState";

const EXPECTED_M5_TRADE_DEFAULTS = {
  transportCapacityUtilizationTarget: 0.80,
  transportConditionMinimum: 0.05,
  shipmentMinimumQuantity: 1e-6,
  tradeOpportunityMinimumMarginShare: 0.03,
  tradeOpportunityMaximumRoutesPerGoodPerRegion: 4,
  maxExportShareOfAvailableSurplus: 0.50,
  defaultTransitTicksPerLink: 1,
  shipmentLossFromOrdinaryTrade: 0,
} as const satisfies TradeConfig;

describe("M5 TradeConfig canonical baseline and numeric bounds (#669)", () => {
  it("materializes exactly the Handoff/03 section 5 trade defaults, stably", () => {
    expect(createDefaultSimulationConfig().trade).toEqual(EXPECTED_M5_TRADE_DEFAULTS);
    expect(createDefaultSimulationConfig().trade).toEqual(createDefaultSimulationConfig().trade);
    expect(() => validateTradeConfig(createDefaultSimulationConfig().trade)).not.toThrow();
  });

  it("preserves legacy optional controls and valid boundary values", () => {
    expect(() => validateTradeConfig({})).not.toThrow();
    expect(() => validateTradeConfig({
      transportCapacityUtilizationTarget: 0,
      transportConditionMinimum: 1,
      shipmentMinimumQuantity: Number.MIN_VALUE,
      tradeOpportunityMinimumMarginShare: 0,
      tradeOpportunityMaximumRoutesPerGoodPerRegion: 1,
      maxExportShareOfAvailableSurplus: 1,
      defaultTransitTicksPerLink: 0,
      shipmentLossFromOrdinaryTrade: 0,
    })).not.toThrow();
    expect(() => validateTradeConfig({
      tradeOpportunityMaximumRoutesPerGoodPerRegion: Number.MAX_SAFE_INTEGER,
      defaultTransitTicksPerLink: Number.MAX_SAFE_INTEGER,
      shipmentLossFromOrdinaryTrade: 0.999,
    })).not.toThrow();
  });

  it("rejects every negative, non-finite or out-of-range share", () => {
    const shareKeys = [
      "transportCapacityUtilizationTarget",
      "transportConditionMinimum",
      "maxExportShareOfAvailableSurplus",
      "shipmentLossFromOrdinaryTrade",
    ] as const satisfies readonly (keyof TradeConfig)[];
    for (const key of shareKeys) {
      for (const bad of [-0.01, 1.01, Number.NaN, Infinity, -Infinity]) {
        expect(() => validateTradeConfig({ [key]: bad }), `${key}=${bad}`)
          .toThrow(`TradeConfig.${key}`);
      }
    }
    expect(() => validateTradeConfig({ shipmentLossFromOrdinaryTrade: 1 }))
      .toThrow("TradeConfig.shipmentLossFromOrdinaryTrade");
  });

  it("rejects invalid positive quantities, bounded route counts and transit ticks", () => {
    for (const bad of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(() => validateTradeConfig({ shipmentMinimumQuantity: bad }))
        .toThrow("TradeConfig.shipmentMinimumQuantity");
    }
    for (const bad of [-1, Number.NaN, Infinity, -Infinity]) {
      expect(() => validateTradeConfig({ tradeOpportunityMinimumMarginShare: bad }))
        .toThrow("TradeConfig.tradeOpportunityMinimumMarginShare");
    }
    for (const bad of [0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1, Infinity, Number.NaN]) {
      expect(() => validateTradeConfig({ tradeOpportunityMaximumRoutesPerGoodPerRegion: bad }))
        .toThrow("TradeConfig.tradeOpportunityMaximumRoutesPerGoodPerRegion");
    }
    for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, Number.NaN]) {
      expect(() => validateTradeConfig({ defaultTransitTicksPerLink: bad }))
        .toThrow("TradeConfig.defaultTransitTicksPerLink");
    }
  });

  it("fails at world genesis on an invalid trade setting, before a shipment exists", () => {
    const defaults = createDefaultSimulationConfig();
    const invalidConfig = {
      ...defaults,
      trade: { ...defaults.trade, defaultTransitTicksPerLink: 1.5 },
    };
    expect(() => buildInitialWorld(baselineScenario, baselineDefinitionPack, invalidConfig, 7))
      .toThrow("TradeConfig.defaultTransitTicksPerLink");
  });
});
