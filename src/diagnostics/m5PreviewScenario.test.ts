/** #677: real 16-phase M5 preview generation, determinism and fail-closed checks. */
import { describe, expect, it } from "vitest";
import {
  createM5PreviewScenario, generateM5Preview, serializeM5Preview, M5_PREVIEW_TICK,
} from "./m5PreviewScenario";
import { executeM5AutonomousRegionalTradeTick } from "../simulation/m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "../simulation/tickOrchestrator";

function canonical(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value].map(([k, v]) => [String(k), canonical(v)] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  }
  if (value instanceof Set) return [...value].map(canonical).sort();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, canonical(val)]));
  }
  return value;
}

const upstream: PhaseHandler = (world, context) =>
  context.phase === 1 ? {
    ...context,
    effectiveJurisdictionByRegion: new Map([...world.regions].map(
      ([id, region]) => [id, region.controllerStateId] as const,
    )),
  } : context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;

describe("M5 #677 source-backed Pages generator", () => {
  it("projects paid cross-currency dispatch, real fees, FX reserves and Phase-15 rate movement", () => {
    const preview = generateM5Preview(createM5PreviewScenario());
    expect(preview.milestone).toBe("M5");
    expect(preview.tick).toBe(M5_PREVIEW_TICK);
    const routes = preview.routes.filter(route => route.departures.length > 0);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.status).toBe("PAID_DISPATCH");
    expect(routes[0]!.capacityWeightUnits).toBeGreaterThan(0);
    expect(routes[0]!.dispatchedWeightUnits).toBeGreaterThan(0);
    expect(routes[0]!.dispatchedWeightUnits).toBeLessThanOrEqual(routes[0]!.capacityWeightUnits);
    const cargo = routes[0]!.departures[0]!;
    expect(cargo.quantity).toBeGreaterThan(0);
    expect(cargo.fxSettlementId).not.toBeNull();
    expect(cargo.invoiceCurrency).not.toBe(cargo.buyerCurrency);
    expect(cargo.buyerGoodsPaymentAmount).toBeGreaterThan(0);
    expect(cargo.tariffAmount).toBeGreaterThan(0);
    expect(cargo.transportFeeAmount).toBeGreaterThan(0);
    expect(preview.fxPools.some(pool =>
      pool.baseReserve > 0 && pool.quoteReserve > 0 &&
      pool.spotBefore > 0 && pool.spotAfter > 0 &&
      pool.spotBefore !== pool.spotAfter)).toBe(true);
  });

  it("serializes source-backed data byte-for-byte deterministically", () => {
    const first = serializeM5Preview(createM5PreviewScenario());
    const second = serializeM5Preview(createM5PreviewScenario());
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(JSON.parse(first)).toEqual(generateM5Preview(createM5PreviewScenario()));
  });

  it("does not mutate the opening world or consume an extra economic replay", () => {
    const scenario = createM5PreviewScenario();
    const before = JSON.stringify(canonical(scenario.opening));
    const control = executeM5AutonomousRegionalTradeTick(
      scenario.opening, M5_PREVIEW_TICK, upstream,
      (_phase, world) => world, scenario.options,
    );
    const projected = generateM5Preview(scenario);
    const after = executeM5AutonomousRegionalTradeTick(
      scenario.opening, M5_PREVIEW_TICK, upstream,
      (_phase, world) => world, scenario.options,
    );
    expect(projected.routes[0]?.departures.length).toBeGreaterThan(0);
    expect(JSON.stringify(canonical(scenario.opening))).toBe(before);
    expect(canonical(after.world)).toEqual(canonical(control.world));
    expect(canonical(after.context.transactions)).toEqual(canonical(control.context.transactions));
  });

  it("refuses to publish an unauthorized route instead of inventing a trade", () => {
    const scenario = createM5PreviewScenario();
    const denied = {
      ...scenario,
      options: { ...scenario.options, phase1TradeLawProvider: () => undefined },
    };
    expect(() => generateM5Preview(denied)).toThrow(
      /fixture lacks paid FX cargo/,
    );
    expect(scenario.opening.shipments?.size ?? 0).toBe(0);
  });

  it("fails closed if actual infrastructure factors are not provided", () => {
    const scenario = createM5PreviewScenario();
    expect(() => generateM5Preview({
      ...scenario,
      options: { ...scenario.options, infrastructureFactors: new Map() },
    })).toThrow();
    expect(scenario.opening.shipments?.size ?? 0).toBe(0);
  });
});
