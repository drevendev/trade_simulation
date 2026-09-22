import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ProductionUnitId } from "../domain/id";
import {
  applyProductionUnitLifecycleReviewTransition,
  applyProductionUnitLifecycleTransitionsAtPhase1,
  applyProductionUnitOwnerFundingTransition,
  isProductionUnitSafeForRetirement,
  planProductionUnitLifecyclePhase14,
} from "./productionUnitLifecycle";
import { buildInitialWorld, type ProductionUnitState, type WorldState } from "./worldState";

function baselineWorld(): WorldState {
  return buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
}

function activeUnit(world: WorldState): ProductionUnitState {
  const unit = [...world.productionUnits.values()].find((candidate) => candidate.status === "ACTIVE");
  expect(unit).toBeDefined();
  return unit!;
}

function withUnit(world: WorldState, unit: ProductionUnitState): WorldState {
  const productionUnits = new Map(world.productionUnits);
  productionUnits.set(unit.productionUnitId, unit);
  return { ...world, productionUnits };
}

function withProductionConfig(world: WorldState, patch: Record<string, number>): WorldState {
  return {
    ...world,
    simulationConfig: {
      ...world.simulationConfig,
      production: { ...world.simulationConfig.production, ...patch },
    },
  };
}

function regionFor(world: WorldState, unit: ProductionUnitState) {
  const region = [...world.regions.values()].find((candidate) => candidate.seed.key === unit.seed.regionKey);
  expect(region).toBeDefined();
  return region!;
}

function review(world: WorldState, tick: number): WorldState {
  const result = planProductionUnitLifecyclePhase14({ world, tick });
  return applyProductionUnitLifecycleReviewTransition(world, result.reviews, tick);
}

describe("REQ-PRODUCTION-007 ProductionUnit lifecycle", () => {
  it("initializes the sole live lifecycle status from immutable seed status", () => {
    const world = baselineWorld();
    for (const unit of world.productionUnits.values()) {
      expect(unit.status).toBe(unit.seed.status);
    }
  });

  it("keeps PLANNED startup unready without real capital and activates only on the next tick when ready", () => {
    let world = baselineWorld();
    const opening = activeUnit(world);
    const recipe = world.definitionRegistry.recipes[opening.seed.recipeId]!;
    const region = regionFor(world, opening);
    const planned: ProductionUnitState = {
      ...opening,
      status: "PLANNED",
      installedCapital: 0,
    };
    world = withUnit(world, planned);

    const notReady = planProductionUnitLifecyclePhase14({ world, tick: 3 });
    const reviewEvidence = notReady.reviews.find((candidate) => candidate.unitId === planned.productionUnitId)!;
    expect(reviewEvidence.readiness.capitalReady).toBe(false);
    expect(reviewEvidence.transition).toBeUndefined();

    const readyUnit: ProductionUnitState = {
      ...planned,
      installedCapital: recipe.minimumStartupCapital,
      wallet: new Map(planned.wallet).set(
        region.settlementCurrencyId,
        Math.max(
          planned.wallet.get(region.settlementCurrencyId) ?? 0,
          world.simulationConfig.production.minOperatingCash ?? 0,
        ),
      ),
    };
    const readyWorld = withUnit(world, readyUnit);
    const readyPlan = planProductionUnitLifecyclePhase14({ world: readyWorld, tick: 3 });
    const afterPhase14 = applyProductionUnitLifecycleReviewTransition(readyWorld, readyPlan.reviews, 3);

    expect(afterPhase14.productionUnits.get(readyUnit.productionUnitId)!.status).toBe("PLANNED");
    expect(afterPhase14.pendingTransitions.productionUnitLifecycleChanges).toHaveLength(1);
    const nextTick = applyProductionUnitLifecycleTransitionsAtPhase1(afterPhase14, 4);
    expect(nextTick.productionUnits.get(readyUnit.productionUnitId)!.status).toBe("ACTIVE");
    expect(readyUnit.seed.status).toBe(opening.seed.status);
  });

  it("requires three configured consecutive nonviable ACTIVE reviews and resets on a viable review", () => {
    let world = baselineWorld();
    const opening = activeUnit(world);
    world = withUnit(world, {
      ...opening,
      signals: { ...opening.signals, marginSignalEma: -0.2, utilizationEma: 0.1 },
    });

    world = review(world, 3);
    expect(world.productionUnits.get(opening.productionUnitId)!.signals.consecutiveNonviableReviews).toBe(1);

    const viable = world.productionUnits.get(opening.productionUnitId)!;
    world = withUnit(world, {
      ...viable,
      signals: { ...viable.signals, marginSignalEma: 0, utilizationEma: 0.7 },
    });
    world = review(world, 6);
    expect(world.productionUnits.get(opening.productionUnitId)!.signals.consecutiveNonviableReviews).toBe(0);

    const nonviableAgain = world.productionUnits.get(opening.productionUnitId)!;
    world = withUnit(world, {
      ...nonviableAgain,
      signals: { ...nonviableAgain.signals, marginSignalEma: -0.2, utilizationEma: 0.1 },
    });
    world = review(world, 9);
    world = review(world, 12);
    world = review(world, 15);
    expect(world.productionUnits.get(opening.productionUnitId)!.status).toBe("ACTIVE");
    expect(world.pendingTransitions.productionUnitLifecycleChanges).toHaveLength(1);

    world = applyProductionUnitLifecycleTransitionsAtPhase1(world, 16);
    expect(world.productionUnits.get(opening.productionUnitId)!.status).toBe("MOTHBALLED");
    expect(world.productionUnits.get(opening.productionUnitId)!.signals.consecutiveNonviableReviews).toBe(0);
  });

  it("reactivates MOTHBALLED only after configured viable reviews plus readiness", () => {
    let world = baselineWorld();
    const opening = activeUnit(world);
    const recipe = world.definitionRegistry.recipes[opening.seed.recipeId]!;
    const mothballed: ProductionUnitState = {
      ...opening,
      status: "MOTHBALLED",
      installedCapital: Math.max(opening.installedCapital, recipe.minimumStartupCapital),
      signals: { ...opening.signals, marginSignalEma: 0.2, consecutiveNonviableReviews: 0, consecutiveViableReviews: 0 },
    };
    world = withUnit(world, mothballed);

    world = review(world, 3);
    expect(world.productionUnits.get(opening.productionUnitId)!.signals.consecutiveViableReviews).toBe(1);
    expect(world.pendingTransitions.productionUnitLifecycleChanges).toHaveLength(0);

    world = review(world, 6);
    expect(world.pendingTransitions.productionUnitLifecycleChanges?.[0]?.target).toBe("ACTIVE");
    world = applyProductionUnitLifecycleTransitionsAtPhase1(world, 7);
    expect(world.productionUnits.get(opening.productionUnitId)!.status).toBe("ACTIVE");
  });

  it("moves prolonged nonviable MOTHBALLED units to CLOSING only on configured due reviews", () => {
    let world = withProductionConfig(baselineWorld(), { closeAfterReviews: 2 });
    const opening = activeUnit(world);
    world = withUnit(world, {
      ...opening,
      status: "MOTHBALLED",
      signals: { ...opening.signals, marginSignalEma: -0.2, consecutiveNonviableReviews: 0, consecutiveViableReviews: 0 },
    });

    const offCadence = planProductionUnitLifecyclePhase14({ world, tick: 2 });
    expect(offCadence.reviews).toHaveLength(0);

    world = review(world, 3);
    world = review(world, 6);
    expect(world.pendingTransitions.productionUnitLifecycleChanges?.[0]?.target).toBe("CLOSING");
    world = applyProductionUnitLifecycleTransitionsAtPhase1(world, 7);
    expect(world.productionUnits.get(opening.productionUnitId)!.status).toBe("CLOSING");
  });

  it("refuses CLOSING retirement with residual stock and retires only after safe clearance", () => {
    let world = withProductionConfig(baselineWorld(), { closingGraceReviews: 1 });
    const opening = activeUnit(world);
    const closing: ProductionUnitState = { ...opening, status: "CLOSING" };
    world = withUnit(world, closing);
    expect(isProductionUnitSafeForRetirement(world, closing.productionUnitId)).toBe(false);
    world = review(world, 3);
    expect(world.pendingTransitions.productionUnitLifecycleChanges).toHaveLength(0);

    const cleared: ProductionUnitState = {
      ...closing,
      wallet: new Map(),
      inputInventory: new Map(),
      outputInventory: new Map(),
      investmentInventory: new Map(),
      installedCapital: 0,
      signals: { ...closing.signals, consecutiveNonviableReviews: 0, consecutiveViableReviews: 0 },
      lastLifecycleReviewTick: -1,
    };
    let safeWorld = withUnit(withProductionConfig(baselineWorld(), { closingGraceReviews: 1 }), cleared);
    expect(isProductionUnitSafeForRetirement(safeWorld, cleared.productionUnitId)).toBe(true);
    safeWorld = review(safeWorld, 3);
    expect(safeWorld.pendingTransitions.productionUnitLifecycleChanges?.[0]?.target).toBe("RETIRED");
    safeWorld = applyProductionUnitLifecycleTransitionsAtPhase1(safeWorld, 4);
    expect(safeWorld.productionUnits.has(cleared.productionUnitId)).toBe(false);
  });

  it("moves owner funding exactly from the owner treasury into PLANNED home cash without changing capital", () => {
    let world = baselineWorld();
    const opening = activeUnit(world);
    const unit: ProductionUnitState = { ...opening, status: "PLANNED" };
    world = withUnit(world, unit);
    const region = regionFor(world, unit);
    expect(unit.seed.owner.type).toBe("CLAN");
    if (unit.seed.owner.type !== "CLAN") throw new Error("baseline fixture expected Clan-owned unit");
    const owner = [...world.clans.values()].find((candidate) => candidate.seed.key === unit.seed.owner.key)!;
    const ownerBefore = owner.treasury.get(region.settlementCurrencyId) ?? 0;
    const unitBefore = unit.wallet.get(region.settlementCurrencyId) ?? 0;
    const capitalBefore = unit.installedCapital;
    const amount = Math.min(10, ownerBefore / 2);
    expect(amount).toBeGreaterThan(0);

    const funded = applyProductionUnitOwnerFundingTransition(world, {
      unitId: unit.productionUnitId,
      amount,
    });
    const ownerAfter = funded.clans.get(owner.clanId)!;
    const unitAfter = funded.productionUnits.get(unit.productionUnitId)!;
    expect(ownerAfter.treasury.get(region.settlementCurrencyId)).toBeCloseTo(ownerBefore - amount, 12);
    expect(unitAfter.wallet.get(region.settlementCurrencyId)).toBeCloseTo(unitBefore + amount, 12);
    expect(unitAfter.installedCapital).toBe(capitalBefore);
    expect((ownerBefore + unitBefore) - ((ownerAfter.treasury.get(region.settlementCurrencyId) ?? 0) + (unitAfter.wallet.get(region.settlementCurrencyId) ?? 0))).toBeCloseTo(0, 12);
    expect(world.clans.get(owner.clanId)!.treasury.get(region.settlementCurrencyId)).toBe(ownerBefore);
    expect(world.productionUnits.get(unit.productionUnitId)!.wallet.get(region.settlementCurrencyId)).toBe(unitBefore);
  });

  it("rejects owner funding above exact available cash even when the excess is below money epsilon", () => {
    let world = baselineWorld();
    const opening = activeUnit(world);
    const unit: ProductionUnitState = { ...opening, status: "PLANNED" };
    world = withUnit(world, unit);
    const region = regionFor(world, unit);
    expect(unit.seed.owner.type).toBe("CLAN");
    if (unit.seed.owner.type !== "CLAN") throw new Error("baseline fixture expected Clan-owned unit");
    const owner = [...world.clans.values()].find((candidate) => candidate.seed.key === unit.seed.owner.key)!;
    const ownerBefore = owner.treasury.get(region.settlementCurrencyId) ?? 0;
    const unitBefore = unit.wallet.get(region.settlementCurrencyId) ?? 0;
    const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
    expect(ownerBefore).toBeGreaterThan(0);

    expect(() =>
      applyProductionUnitOwnerFundingTransition(world, {
        unitId: unit.productionUnitId,
        amount: ownerBefore + moneyEpsilon / 2,
      }),
    ).toThrow(/overdraw Clan treasury/);
    expect(world.clans.get(owner.clanId)!.treasury.get(region.settlementCurrencyId)).toBe(ownerBefore);
    expect(world.productionUnits.get(unit.productionUnitId)!.wallet.get(region.settlementCurrencyId)).toBe(unitBefore);
  });

  it("is deterministic under registry insertion order and rejects tampered/wrong-unit review evidence", () => {
    let world = baselineWorld();
    const opening = activeUnit(world);
    world = withUnit(world, {
      ...opening,
      signals: { ...opening.signals, marginSignalEma: -0.2, utilizationEma: 0.1 },
    });
    const reversed = {
      ...world,
      productionUnits: new Map([...world.productionUnits.entries()].reverse()),
    };
    const canonical = planProductionUnitLifecyclePhase14({ world, tick: 3 });
    const reordered = planProductionUnitLifecyclePhase14({ world: reversed, tick: 3 });
    expect(reordered).toEqual(canonical);

    const otherId = [...world.productionUnits.keys()].find((candidate) => candidate !== canonical.reviews[0]!.unitId)!;
    const forged = canonical.reviews.map((candidate, index) =>
      index === 0 ? { ...candidate, unitId: otherId as ProductionUnitId } : candidate,
    );
    expect(() => applyProductionUnitLifecycleReviewTransition(world, forged, 3)).toThrow(/does not match authoritative state/);
    expect(world.productionUnits.get(opening.productionUnitId)!.lastLifecycleReviewTick).toBe(-1);
  });
});
