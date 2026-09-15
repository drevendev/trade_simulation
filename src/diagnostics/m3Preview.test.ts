/**
 * REQ-VISUALIZATION-006: the M3 Milestone Preview generator and its published artifact.
 *
 * These tests both prove the generator and produce `docs/m3-preview.json`, the artifact
 * the consolidated M3 Pages experience fetches. The page's own rendering is covered by
 * `m3-pages-render.test.ts`; this file covers the data behind it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildInitialWorld, type WorldState } from "../simulation/worldState";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { generateM3Preview, m3GoldenRunFixture, type M3Preview } from "./m3Preview";
import { computeShortageRate, computeSurplusRate } from "../simulation/marketTelemetry";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function buildWorld(seed = 42): WorldState {
  return buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), seed);
}

let preview: M3Preview;

beforeAll(() => {
  const world = buildWorld();
  preview = generateM3Preview(world, m3GoldenRunFixture(world));
  writeFileSync(`${repoRoot}docs/m3-preview.json`, `${JSON.stringify(preview, null, 2)}\n`);
});

describe("REQ-VISUALIZATION-006: M3 preview generator", () => {
  it("identifies the milestone, requirement and the deterministic scenario it was generated from", () => {
    expect(preview.milestone).toBe("M3");
    expect(preview.requirement).toBe("REQ-VISUALIZATION-006");
    expect(preview.scenario.scenarioId).toBe("baseline-multistate-v1");
    expect(preview.scenario.seed).toBe(42);
    expect(preview.scenario.configVersion).toBe("1.0.0");
    expect(preview.scenario.ticksExecuted).toBe(preview.ticks.length);
    expect(preview.ticks.length).toBeGreaterThan(1);
  });

  it("names the market slice, its units and its tax destination so the page never has to invent a label", () => {
    expect(preview.market.pass).toBe("MAIN");
    expect(preview.market.regionName).toBe("Alpha Farmland");
    expect(preview.market.goodName).toBe("Food");
    expect(preview.market.quantityUnitLabel).toBe("units");
    // Acceptance criterion 3: a monetary axis must name its currency, so the code has to
    // be in the artifact rather than assumed by the page.
    expect(preview.market.currencyCode).toBe("ALP");
    expect(preview.market.destinationStateName).toBe("State Alpha");
    expect(preview.market.sellerCount).toBe(3);
    expect(preview.market.buyerCount).toBe(3);
  });

  it("every tick carries all required headline metrics as finite numbers", () => {
    for (const tick of preview.ticks) {
      for (const [field, value] of Object.entries(tick)) {
        expect(Number.isFinite(value), `${field} on tick ${tick.tick}`).toBe(true);
      }
      expect(tick.householdGrossPrice).toBeGreaterThanOrEqual(tick.sellerNetPrice);
      expect(tick.effectiveDemandQuantity).toBeLessThanOrEqual(tick.desiredDemandQuantity + 1e-9);
      expect(tick.clearedQuantity).toBeLessThanOrEqual(tick.offeredQuantity + 1e-9);
      expect(tick.clearedQuantity).toBeLessThanOrEqual(tick.effectiveDemandQuantity + 1e-9);
    }
    expect(preview.ticks.map((tick) => tick.tick)).toEqual(
      preview.ticks.map((_, index) => index + 1),
    );
  });

  it("stays inside the Phase-6 price bounds and per-tick log-move cap it publishes", () => {
    const { minimumPrice, maximumPrice, maxAbsoluteLogPriceMovePerTick } = preview.priceBounds;
    let previous: number | null = null;
    for (const tick of preview.ticks) {
      expect(tick.sellerNetPrice).toBeGreaterThanOrEqual(minimumPrice - 1e-9);
      expect(tick.sellerNetPrice).toBeLessThanOrEqual(maximumPrice + 1e-9);
      if (previous !== null) {
        expect(Math.abs(Math.log(tick.sellerNetPrice / previous))).toBeLessThanOrEqual(
          maxAbsoluteLogPriceMovePerTick + 1e-9,
        );
      }
      previous = tick.sellerNetPrice;
    }
  });

  it("reports the canonical realized Phase-8 MAIN shortage/surplus rates rather than a second metric", () => {
    // HANDOFF-REPAIR-009 forbids deriving a second surplus metric. Recomputing both rates
    // here with the canonical functions from the preview's own unmet/unsold and
    // effective-demand/offered quantities proves the published values are those functions'
    // output and not a parallel definition that happens to look similar.
    for (const tick of preview.ticks) {
      expect(tick.shortageRate).toBeCloseTo(
        computeShortageRate(tick.unmetDemandQuantity, tick.effectiveDemandQuantity),
        12,
      );
      expect(tick.surplusRate).toBeCloseTo(
        computeSurplusRate(tick.unsoldOfferQuantity, tick.offeredQuantity),
        12,
      );
    }
  });

  it("tells the local-shortage story the fixture stages: short and dear first, then rationed to a standstill", () => {
    const first = preview.ticks[0]!;
    const last = preview.ticks[preview.ticks.length - 1]!;
    expect(first.shortageRate).toBeGreaterThan(0.2);
    expect(first.offeredQuantity).toBeLessThan(first.desiredDemandQuantity);
    // The rising gross price rations effective demand against fixed buyer cash, so the
    // run ends in surplus rather than shortage.
    expect(last.surplusRate).toBeGreaterThan(first.surplusRate);
    expect(last.shortageRate).toBeLessThan(first.shortageRate);
  });

  it("settles what it draws: buyer-gross cost equals seller-net receipt plus collected tax", () => {
    const identity = preview.settlementIdentity;
    expect(identity.buyerGrossCost).toBeCloseTo(identity.sellerNetReceiptPlusTax, 9);
    expect(Math.abs(identity.residual)).toBeLessThanOrEqual(identity.moneyEpsilon);
    expect(identity.buyerGrossCost).toBe(preview.totals.buyerGrossCost);
    expect(identity.sellerNetReceiptPlusTax).toBeCloseTo(
      preview.totals.sellerNetReceipt + preview.totals.consumptionTaxCollected,
      9,
    );
    expect(preview.totals.consumptionTaxCollected).toBeGreaterThan(0);
  });

  it("totals are the sum of the per-tick rows the page tabulates", () => {
    const sum = (pick: (tick: M3Preview["ticks"][number]) => number): number =>
      preview.ticks.reduce((accumulator, tick) => accumulator + pick(tick), 0);
    expect(preview.totals.clearedQuantity).toBeCloseTo(sum((tick) => tick.clearedQuantity), 9);
    expect(preview.totals.sellerNetReceipt).toBeCloseTo(sum((tick) => tick.sellerNetReceipt), 9);
    expect(preview.totals.buyerGrossCost).toBeCloseTo(sum((tick) => tick.buyerGrossCost), 9);
    expect(preview.totals.consumptionTaxCollected).toBeCloseTo(
      sum((tick) => tick.consumptionTaxCollected),
      9,
    );
    expect(preview.totals.allocationCount).toBe(sum((tick) => tick.allocationCount));
  });

  it("is deterministic: the same scenario and seed regenerate a byte-identical artifact", () => {
    const world = buildWorld();
    const again = generateM3Preview(world, m3GoldenRunFixture(world));
    expect(JSON.stringify(again)).toBe(JSON.stringify(preview));
  });

  it("does not mutate the world it was given, so enabling the preview cannot change canonical state", () => {
    // Acceptance criterion 9. The generator settles allocations onto its own forward copy
    // of the world; the caller's `WorldState` must be indistinguishable afterwards.
    const world = buildWorld();
    const before = JSON.stringify(canonicalize(world));
    generateM3Preview(world, m3GoldenRunFixture(world));
    expect(JSON.stringify(canonicalize(world))).toBe(before);
  });

  it("publishes docs/m3-preview.json matching the generator output", () => {
    const published = JSON.parse(
      readFileSync(`${repoRoot}docs/m3-preview.json`, "utf8"),
    ) as M3Preview;
    expect(published).toEqual(preview);
  });
});

/** Stable, JSON-comparable projection of a WorldState, including its nested Maps. */
function canonicalize(value: unknown): unknown {
  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([key, entry]) => [String(key), canonicalize(entry)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
