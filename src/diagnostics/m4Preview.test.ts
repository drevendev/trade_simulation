/** REQ-VISUALIZATION-009: canonical M4 preview data and isolation regressions. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createM4PreviewWorld,
  generateM4Preview,
  M4_PREVIEW_TICKS,
  type M4Preview,
} from "./m4Preview";
import type { GoodId } from "../domain/id";
import { executeM4ClosedEconomyTick, type M4ClosedEconomyOptions } from "../simulation/m4ClosedEconomyOrchestrator";
import type { WorldState } from "../simulation/worldState";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const publishedPath = `${repoRoot}docs/m4-preview.json`;
const FOOD = "good:food" as GoodId;

function canonicalize(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [String(key), canonicalize(entry)] as const)
      .sort(([left], [right]) => left.localeCompare(right));
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function options(world: WorldState): M4ClosedEconomyOptions {
  const market = world.simulationConfig.markets;
  return {
    taxPolicy: { getConsumptionTaxRate: () => 0, getCollectionEfficiency: () => 1 },
    wageTaxPolicy: { assessWageIncomeTax: () => 0, getCollectionEfficiency: () => 1 },
    priceConfig: {
      shortageSignalWeight: market.shortageSignalWeight!,
      inventorySignalWeight: market.inventorySignalWeight!,
      basePriceAdjustmentSpeed: market.basePriceAdjustmentSpeed!,
      maxAbsoluteLogPriceMovePerTick: market.maxAbsoluteLogPriceMovePerTick!,
      targetInventoryCoverageTicks: market.targetInventoryCoverageTicks!,
      minimumPrice: 0.01,
      maximumPrice: 1_000_000,
    },
    collectMarketTelemetry: true,
  };
}

const generated = (): M4Preview => generateM4Preview(createM4PreviewWorld());

describe("REQ-VISUALIZATION-009: M4 preview generator", () => {
  it("projects a non-vacuous canonical closed-economy story with explicit units", () => {
    const preview = generated();
    expect(preview.milestone).toBe("M4");
    expect(preview.requirement).toBe("REQ-VISUALIZATION-009");
    expect(preview.scenario.ticksExecuted).toBe(M4_PREVIEW_TICKS);
    expect(preview.samples.length).toBeGreaterThan(2);
    expect(preview.region.currencyCode.length).toBeGreaterThan(0);
    expect(preview.region.goodsUnitLabel.length).toBeGreaterThan(0);
    expect(preview.totals.outputProduced).toBeGreaterThan(0);
    expect(preview.totals.grossWagesPaid).toBeGreaterThan(0);
    expect(preview.totals.capitalBuilt).toBeGreaterThan(0);
    expect(preview.totals.householdPurchaseQuantity).toBeGreaterThan(0);
    expect(preview.samples.some((sample) => sample.employedWorkers > 0)).toBe(true);
    expect(preview.samples.some((sample) => sample.essentialCoverage > 0)).toBe(true);
    expect(preview.samples.every((sample) => Number.isFinite(sample.foodInventory) && sample.foodInventory >= 0)).toBe(true);
    expect(preview.samples.every((sample) => Number.isFinite(sample.installedCapital) && sample.installedCapital >= 0)).toBe(true);
  });

  it("is deterministic for the same canonical fixture", () => {
    expect(JSON.stringify(generated())).toBe(JSON.stringify(generated()));
  });

  it("ignores foreign-State public food stock in the one-region projection", () => {
    const world = createM4PreviewWorld();
    const region = [...world.regions.values()][0]!;
    expect(region.controllerStateId).not.toBeNull();

    const mutatedStates = new Map(world.states);
    let mutatedForeignStates = 0;
    for (const [stateId, state] of world.states.entries()) {
      if (stateId === region.controllerStateId) continue;
      const publicInventory = new Map(state.publicInventory);
      publicInventory.set(FOOD, (publicInventory.get(FOOD) ?? 0) + 123_456);
      mutatedStates.set(stateId, { ...state, publicInventory });
      mutatedForeignStates += 1;
    }
    expect(mutatedForeignStates).toBeGreaterThan(0);

    const mutatedWorld: WorldState = { ...world, states: mutatedStates };
    expect(JSON.stringify(generateM4Preview(mutatedWorld))).toBe(JSON.stringify(generateM4Preview(world)));
  });

  it("does not mutate the caller's WorldState or advance any mutable RNG cursor", () => {
    const world = createM4PreviewWorld();
    const before = JSON.stringify(canonicalize(world));
    const control = executeM4ClosedEconomyTick(world, 0, options(world));

    generateM4Preview(world);

    expect(JSON.stringify(canonicalize(world))).toBe(before);
    const afterPreview = executeM4ClosedEconomyTick(world, 0, options(world));
    expect(JSON.stringify(canonicalize(afterPreview.world))).toBe(JSON.stringify(canonicalize(control.world)));
    expect(canonicalize(afterPreview.context)).toEqual(canonicalize(control.context));
  });

  it("keeps the checked-in Pages artifact byte-identical to the canonical generator", () => {
    const expected = `${JSON.stringify(generated(), null, 2)}\n`;
    const published = readFileSync(publishedPath, "utf8");
    if (published !== expected) {
      console.log("M4_PREVIEW_JSON_BEGIN");
      console.log(expected);
      console.log("M4_PREVIEW_JSON_END");
    }
    expect(published).toBe(expected);
  });
});
