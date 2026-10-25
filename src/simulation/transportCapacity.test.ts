/** Executable M5 #669 physical route-capacity contract; no shipment/FX settlement here. */
import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { buildInitialWorld, type TransportLinkState } from "./worldState";
import {
  cargoCapacityUse,
  effectiveTransportLinkCapacity,
  hasUsableTransportCapacity,
} from "./transportCapacity";

const config = createDefaultSimulationConfig();

function route(baseCapacity = 20, condition = 0.5): TransportLinkState {
  // Exercise an actual directed genesis route, preserving ID/endpoints.
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 7);
  const link = [...world.transportLinks.values()][0]!;
  return { ...link, seed: { ...link.seed, baseCapacity, condition } };
}

describe("M5 directed transport physical capacity (#669)", () => {
  it("derives capacity from base, condition and explicit infrastructure factor without mutating genesis", () => {
    const link = route();
    const original = link.seed.baseCapacity;
    expect(effectiveTransportLinkCapacity(link, 1)).toBe(10);
    expect(effectiveTransportLinkCapacity(link, 1.5)).toBe(15);
    expect(effectiveTransportLinkCapacity(link, 0)).toBe(0);
    expect(link.seed.baseCapacity).toBe(original);
    expect(link.seed.condition).toBe(0.5);
    // Utilization target (0.8) must not reduce the physical 10-unit maximum.
    expect(config.trade.transportCapacityUtilizationTarget).toBe(0.8);
  });

  it("rejects non-operational condition and epsilon-bound capacities without inventing routes", () => {
    expect(hasUsableTransportCapacity(route(20, 0.05), config, 1)).toBe(true);
    expect(hasUsableTransportCapacity(route(20, 0.049), config, 1)).toBe(false);
    expect(hasUsableTransportCapacity(route(0, 1), config, 1)).toBe(false);
    expect(hasUsableTransportCapacity(route(20, 1), config, 0)).toBe(false);
    const epsilon = config.numeric.quantityEpsilon;
    expect(hasUsableTransportCapacity(route(epsilon, 1), config, 1)).toBe(false);
    expect(hasUsableTransportCapacity(route(epsilon * 2, 1), config, 1)).toBe(true);
  });

  it("measures different goods using shared cargo-weight capacity, not item counts", () => {
    expect(cargoCapacityUse(3, 2)).toBe(6);
    expect(cargoCapacityUse(4, 1)).toBe(4);
    expect(cargoCapacityUse(0, 2)).toBe(0);
    const link = route();
    expect(cargoCapacityUse(3, 2) + cargoCapacityUse(4, 1))
      .toBe(effectiveTransportLinkCapacity(link, 1));
  });

  it("fails closed on invalid route, infrastructure and cargo inputs", () => {
    for (const factor of [-1, NaN, Infinity, -Infinity]) {
      expect(() => effectiveTransportLinkCapacity(route(), factor)).toThrow();
    }
    for (const capacity of [-1, NaN, Infinity]) {
      expect(() => effectiveTransportLinkCapacity(route(capacity, 1), 1)).toThrow();
    }
    for (const condition of [-1, 1.01, NaN, Infinity]) {
      expect(() => effectiveTransportLinkCapacity(route(20, condition), 1)).toThrow();
    }
    expect(() => effectiveTransportLinkCapacity(route(Number.MAX_VALUE, 1), 2)).toThrow();
    for (const quantity of [-1, NaN, Infinity]) {
      expect(() => cargoCapacityUse(quantity, 1)).toThrow();
    }
    for (const weight of [0, -1, NaN, Infinity]) {
      expect(() => cargoCapacityUse(1, weight)).toThrow();
    }
    expect(() => cargoCapacityUse(Number.MAX_VALUE, 2)).toThrow();
  });

  it("requires resolved operational controls instead of quietly using invented defaults", () => {
    // The old optional-config case must be a genuinely missing property,
    // not an explicit undefined (exactOptionalPropertyTypes).
    const trade = { ...config.trade };
    delete trade.transportConditionMinimum;
    const invalidTrade = { ...config, trade };
    expect(() => hasUsableTransportCapacity(route(), invalidTrade, 1)).toThrow();
    expect(() => hasUsableTransportCapacity(route(), {
      ...config,
      numeric: { ...config.numeric, quantityEpsilon: -1 },
    }, 1)).toThrow();
  });
});
