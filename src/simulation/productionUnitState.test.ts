import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { buildInitialWorld } from "./worldState";
import {
  INITIAL_LIFECYCLE_REVIEW_TICK,
  createInitialProductionSignalState,
  deriveNameplateCapacity,
  validateProductionUnitPersistentState,
  type ProductionUnitPersistentStateView,
} from "./productionUnitState";

function baselineUnit() {
  const config = createDefaultSimulationConfig();
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
  const unit = Array.from(world.productionUnits.values())[0];
  expect(unit).toBeDefined();
  return { config, world, unit: unit! };
}

describe("REQ-PRODUCTION-001 persistent ProductionUnit state", () => {
  it("materializes deterministic neutral production signals and live installed capital at genesis", () => {
    const { config, unit } = baselineUnit();

    expect(unit.installedCapital).toBe(unit.seed.installedCapital);
    expect(unit.signals).toEqual({
      utilizationEma: config.production.baseTargetUtilization,
      sellThroughEma: config.production.targetSellThrough,
      marginSignalEma: 0,
      outputSalesEma: 0,
      inputUseEma: {},
      consecutiveNonviableReviews: 0,
      consecutiveViableReviews: 0,
    });
    expect(unit.lastLifecycleReviewTick).toBe(INITIAL_LIFECYCLE_REVIEW_TICK);
    expect(() => validateProductionUnitPersistentState(unit)).not.toThrow();
  });

  it("keeps INPUT, OUTPUT and INVESTMENT as three distinct authoritative physical stocks", () => {
    const { unit } = baselineUnit();

    expect(unit.inputInventory).not.toBe(unit.outputInventory);
    expect(unit.inputInventory).not.toBe(unit.investmentInventory);
    expect(unit.outputInventory).not.toBe(unit.investmentInventory);

    const aliased: ProductionUnitPersistentStateView = {
      ...unit,
      investmentInventory: unit.inputInventory,
    };
    expect(() => validateProductionUnitPersistentState(aliased)).toThrow(/must be distinct physical stocks/);
  });

  it("derives nameplate capacity only from live installed capital and the immutable recipe coefficient", () => {
    const { world, unit } = baselineUnit();
    const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
    expect(recipe).toBeDefined();

    const expected = unit.installedCapital * recipe!.batchesPerCapitalUnit;
    expect(deriveNameplateCapacity(unit, recipe!)).toBe(expected);

    const changedCapital = { ...unit, installedCapital: unit.installedCapital + 2 };
    expect(deriveNameplateCapacity(changedCapital, recipe!)).toBe(
      expected + 2 * recipe!.batchesPerCapitalUnit,
    );
    expect(unit.seed.installedCapital).not.toBe(changedCapital.installedCapital);
  });

  it("does not serialize a second mutable capacity authority", () => {
    const { unit } = baselineUnit();
    expect(Object.prototype.hasOwnProperty.call(unit, "capacity")).toBe(false);
    expect("capacity" in unit).toBe(false);
  });

  it("rejects non-finite/negative capital and inventory state", () => {
    const { world, unit } = baselineUnit();
    const goodId = Object.keys(world.definitionRegistry.goods)[0] as GoodId;

    expect(() =>
      validateProductionUnitPersistentState({ ...unit, installedCapital: Number.NaN }),
    ).toThrow(/installedCapital.*non-negative finite/);
    expect(() =>
      validateProductionUnitPersistentState({ ...unit, installedCapital: -1 }),
    ).toThrow(/installedCapital.*non-negative finite/);
    expect(() =>
      validateProductionUnitPersistentState({
        ...unit,
        investmentInventory: new Map([[goodId, Number.POSITIVE_INFINITY]]),
      }),
    ).toThrow(/investmentInventory.*non-negative finite/);
  });

  it("rejects invalid signal bounds, counters and lifecycle-review ticks", () => {
    const { unit } = baselineUnit();

    expect(() =>
      validateProductionUnitPersistentState({
        ...unit,
        signals: { ...unit.signals, utilizationEma: 1.01 },
      }),
    ).toThrow(/utilizationEma.*\[0,1\]/);
    expect(() =>
      validateProductionUnitPersistentState({
        ...unit,
        signals: { ...unit.signals, marginSignalEma: Number.NaN },
      }),
    ).toThrow(/marginSignalEma.*\[-1,1\]/);
    expect(() =>
      validateProductionUnitPersistentState({
        ...unit,
        signals: { ...unit.signals, consecutiveNonviableReviews: 0.5 },
      }),
    ).toThrow(/consecutiveNonviableReviews.*non-negative integer/);
    expect(() =>
      validateProductionUnitPersistentState({ ...unit, lastLifecycleReviewTick: -2 }),
    ).toThrow(/lastLifecycleReviewTick.*integer >= -1/);
  });

  it("keeps recipe capacity coefficients load-bearing at the derivation boundary", () => {
    const { unit } = baselineUnit();

    expect(() => deriveNameplateCapacity(unit, { batchesPerCapitalUnit: 0 })).toThrow(
      /batchesPerCapitalUnit.*positive finite/,
    );
    expect(() => deriveNameplateCapacity(unit, { batchesPerCapitalUnit: Number.POSITIVE_INFINITY })).toThrow(
      /batchesPerCapitalUnit.*positive finite/,
    );
  });

  it("requires configured neutral targets instead of silently inventing M4 signal defaults", () => {
    const config = createDefaultSimulationConfig();
    expect(() => createInitialProductionSignalState({ ...config.production, baseTargetUtilization: undefined })).toThrow(
      /baseTargetUtilization is required/,
    );
    expect(() => createInitialProductionSignalState({ ...config.production, targetSellThrough: undefined })).toThrow(
      /targetSellThrough is required/,
    );
  });
});
