/**
 * Deterministic Phase-12 real-goods capital formation and depreciation
 * (REQ-PRODUCTION-006).
 *
 * Purchased investment goods remain authoritative physical inventory until this phase.
 * Capital formation consumes those goods once, increases the sole installed-capital
 * authority once, and then recipe-owned depreciation reduces that post-formation stock
 * once. Planning is immutable; persistence is an explicit WorldState transition so the
 * resulting capacity cannot affect the already-completed Phase-5 production of this tick.
 */

import type { RecipeDefinition } from "../config/definitionPack";
import type { GoodId, ProductionUnitId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import { deriveNameplateCapacity, validateProductionUnitPersistentState } from "./productionUnitState";
import type { PhaseHandler } from "./tickOrchestrator";
import type { ProductionUnitState, WorldState } from "./worldState";

export interface CapitalFormationExecution {
  readonly tick: number;
  readonly unitId: ProductionUnitId;
  readonly recipeId: string;
  readonly openingInstalledCapital: number;
  readonly openingInvestmentQuantityByGood: Readonly<Record<GoodId, number>>;
  readonly possibleCapitalFromGoods: number;
  readonly capitalBuilt: number;
  readonly investmentGoodsConsumedByGood: Readonly<Record<GoodId, number>>;
  readonly postFormationInstalledCapital: number;
  readonly depreciationUnits: number;
  readonly installedCapitalNext: number;
  readonly nameplateCapacityNext: number;
}

export interface CapitalFormationPlanResult {
  readonly executions: readonly CapitalFormationExecution[];
}

function requireFinite(name: string, value: number): number {
  if (!isFiniteCanonicalNumber(value)) {
    throw new Error(`${name} must be finite, got ${String(value)}`);
  }
  return value;
}

function requireNonNegative(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0) {
    throw new Error(`${name} must be >= 0, got ${String(value)}`);
  }
  return value;
}

function requirePositive(name: string, value: number): number {
  requireFinite(name, value);
  if (value <= 0) {
    throw new Error(`${name} must be > 0, got ${String(value)}`);
  }
  return value;
}

function orderedRecord(entries: readonly (readonly [GoodId, number])[]): Readonly<Record<GoodId, number>> {
  const result: Record<string, number> = {};
  for (const [goodId, value] of stableOrderBy(entries, ([goodId]) => String(goodId))) {
    result[goodId] = value;
  }
  return result as Readonly<Record<GoodId, number>>;
}

function resolveQuantityEpsilon(world: WorldState): number {
  return requirePositive(
    "NumericConfig.quantityEpsilon",
    world.simulationConfig.numeric.quantityEpsilon ?? 1e-9,
  );
}

function planOneUnit(
  unit: ProductionUnitState,
  recipe: RecipeDefinition,
  tick: number,
  quantityEpsilon: number,
): CapitalFormationExecution {
  if (unit.seed.recipeId !== recipe.id) {
    throw new Error(
      `ProductionUnit ${String(unit.productionUnitId)} recipe provenance mismatch: seed=${unit.seed.recipeId}, definition=${recipe.id}`,
    );
  }

  const openingInstalledCapital = requireNonNegative(
    `ProductionUnit ${String(unit.productionUnitId)} installedCapital`,
    unit.installedCapital,
  );
  const depreciationRate = requireFinite(
    `Recipe ${recipe.id} depreciationRatePerTick`,
    recipe.depreciationRatePerTick,
  );
  if (depreciationRate < 0 || depreciationRate >= 1) {
    throw new Error(
      `Recipe ${recipe.id} depreciationRatePerTick must be in [0,1), got ${String(depreciationRate)}`,
    );
  }

  const investmentGoods = stableOrderBy(
    Object.entries(recipe.investmentGoodsPerCapitalUnit) as [GoodId, number][],
    ([goodId]) => String(goodId),
  );
  const openingEntries: (readonly [GoodId, number])[] = [];
  const consumedEntries: (readonly [GoodId, number])[] = [];

  let possibleCapitalFromGoods = 0;
  if (investmentGoods.length > 0) {
    possibleCapitalFromGoods = Number.POSITIVE_INFINITY;
    for (const [goodId, coefficientValue] of investmentGoods) {
      const coefficient = requirePositive(
        `Recipe ${recipe.id} investmentGoodsPerCapitalUnit[${String(goodId)}]`,
        coefficientValue,
      );
      const available = requireNonNegative(
        `ProductionUnit ${String(unit.productionUnitId)} INVESTMENT ${String(goodId)}`,
        unit.investmentInventory.get(goodId) ?? 0,
      );
      openingEntries.push([goodId, available]);
      possibleCapitalFromGoods = Math.min(possibleCapitalFromGoods, available / coefficient);
    }
    possibleCapitalFromGoods = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} possibleCapitalFromGoods`,
      possibleCapitalFromGoods,
    );
  }

  // No separate maxCapitalBuildPerTick exists in the canonical M4 configuration.
  // Handoff/05 therefore defines the Phase-12 execution cap as +Infinity: every complete
  // real-goods bundle already present in INVESTMENT inventory may be converted this tick.
  const capitalBuilt = possibleCapitalFromGoods;

  for (const [goodId, coefficient] of investmentGoods) {
    const rawConsumed = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} consumed INVESTMENT ${String(goodId)}`,
      capitalBuilt * coefficient,
    );
    const opening = unit.investmentInventory.get(goodId) ?? 0;
    if (rawConsumed > opening && rawConsumed - opening > quantityEpsilon) {
      throw new Error(
        `ProductionUnit ${String(unit.productionUnitId)} capital formation consumes more ${String(goodId)} than INVESTMENT inventory`,
      );
    }
    // The limiting inventory/coefficient ratio can multiply back a few ulps above
    // the opening quantity (for example 0.7 / 0.3). Canonical quantity epsilon owns
    // that physical-stock tolerance; clamp only the within-epsilon overshoot so the
    // evidence and persisted remainder agree exactly and stock never becomes negative.
    const consumed = rawConsumed > opening ? opening : rawConsumed;
    consumedEntries.push([goodId, consumed]);
  }

  const postFormationInstalledCapital = requireNonNegative(
    `ProductionUnit ${String(unit.productionUnitId)} postFormationInstalledCapital`,
    openingInstalledCapital + capitalBuilt,
  );
  const depreciationUnits = requireNonNegative(
    `ProductionUnit ${String(unit.productionUnitId)} depreciationUnits`,
    postFormationInstalledCapital * depreciationRate,
  );
  const installedCapitalNext = requireNonNegative(
    `ProductionUnit ${String(unit.productionUnitId)} installedCapitalNext`,
    Math.max(0, postFormationInstalledCapital - depreciationUnits),
  );
  const nameplateCapacityNext = deriveNameplateCapacity(
    { installedCapital: installedCapitalNext },
    recipe,
  );

  return {
    tick,
    unitId: unit.productionUnitId,
    recipeId: recipe.id,
    openingInstalledCapital,
    openingInvestmentQuantityByGood: orderedRecord(openingEntries),
    possibleCapitalFromGoods,
    capitalBuilt,
    investmentGoodsConsumedByGood: orderedRecord(consumedEntries),
    postFormationInstalledCapital,
    depreciationUnits,
    installedCapitalNext,
    nameplateCapacityNext,
  };
}

/** Plan immutable Phase-12 capital evidence in stable ProductionUnitId order. */
export function planCapitalFormationPhase12(args: {
  readonly world: WorldState;
  readonly tick: number;
}): CapitalFormationPlanResult {
  const { world, tick } = args;
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Phase-12 capital tick must be a non-negative integer, got ${String(tick)}`);
  }

  const quantityEpsilon = resolveQuantityEpsilon(world);
  const executions: CapitalFormationExecution[] = [];
  for (const unit of stableOrderBy(world.productionUnits.values(), (candidate) => String(candidate.productionUnitId))) {
    const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
    if (!recipe) {
      throw new Error(
        `ProductionUnit ${String(unit.productionUnitId)} references missing recipe ${unit.seed.recipeId}`,
      );
    }
    executions.push(planOneUnit(unit, recipe, tick, quantityEpsilon));
  }
  return { executions };
}

function recordsEqual(
  left: Readonly<Record<GoodId, number>>,
  right: Readonly<Record<GoodId, number>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index];
    return rightEntry !== undefined && key === rightEntry[0] && Object.is(value, rightEntry[1]);
  });
}

function executionMatches(expected: CapitalFormationExecution, actual: CapitalFormationExecution): boolean {
  return (
    expected.tick === actual.tick &&
    expected.unitId === actual.unitId &&
    expected.recipeId === actual.recipeId &&
    Object.is(expected.openingInstalledCapital, actual.openingInstalledCapital) &&
    recordsEqual(expected.openingInvestmentQuantityByGood, actual.openingInvestmentQuantityByGood) &&
    Object.is(expected.possibleCapitalFromGoods, actual.possibleCapitalFromGoods) &&
    Object.is(expected.capitalBuilt, actual.capitalBuilt) &&
    recordsEqual(expected.investmentGoodsConsumedByGood, actual.investmentGoodsConsumedByGood) &&
    Object.is(expected.postFormationInstalledCapital, actual.postFormationInstalledCapital) &&
    Object.is(expected.depreciationUnits, actual.depreciationUnits) &&
    Object.is(expected.installedCapitalNext, actual.installedCapitalNext) &&
    Object.is(expected.nameplateCapacityNext, actual.nameplateCapacityNext)
  );
}

/** Persist exact Phase-12 goods/capital deltas without mutating the input WorldState. */
export function applyCapitalFormationTransition(
  world: WorldState,
  executions: readonly CapitalFormationExecution[],
  currentTick: number,
): WorldState {
  if (!Number.isInteger(currentTick) || currentTick < 0) {
    throw new Error(`Phase-12 capital transition tick must be a non-negative integer, got ${String(currentTick)}`);
  }
  const quantityEpsilon = resolveQuantityEpsilon(world);
  const executionByUnit = new Map<ProductionUnitId, CapitalFormationExecution>();
  for (const execution of executions) {
    if (executionByUnit.has(execution.unitId)) {
      throw new Error(`Duplicate Phase-12 capital execution for ProductionUnit ${String(execution.unitId)}`);
    }
    executionByUnit.set(execution.unitId, execution);
  }

  if (executionByUnit.size !== world.productionUnits.size) {
    throw new Error(
      `Phase-12 capital transition must cover every ProductionUnit exactly once: expected ${world.productionUnits.size}, got ${executionByUnit.size}`,
    );
  }
  for (const unitId of world.productionUnits.keys()) {
    if (!executionByUnit.has(unitId)) {
      throw new Error(
        `Phase-12 capital transition must cover every ProductionUnit exactly once; missing ${String(unitId)}`,
      );
    }
  }

  const nextProductionUnits = new Map(world.productionUnits);
  for (const execution of stableOrderBy(executions, (candidate) => String(candidate.unitId))) {
    const unit = world.productionUnits.get(execution.unitId);
    if (!unit) {
      throw new Error(`Phase-12 capital execution references unknown ProductionUnit ${String(execution.unitId)}`);
    }
    const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
    if (!recipe) {
      throw new Error(
        `ProductionUnit ${String(unit.productionUnitId)} references missing recipe ${unit.seed.recipeId}`,
      );
    }

    const expected = planOneUnit(unit, recipe, currentTick, quantityEpsilon);
    if (!executionMatches(expected, execution)) {
      throw new Error(
        `Phase-12 capital execution for ProductionUnit ${String(execution.unitId)} does not match current authoritative stock/evidence`,
      );
    }

    const nextInvestmentInventory = new Map(unit.investmentInventory);
    for (const [goodId, consumed] of Object.entries(execution.investmentGoodsConsumedByGood) as [GoodId, number][]) {
      const opening = requireNonNegative(
        `ProductionUnit ${String(unit.productionUnitId)} INVESTMENT ${String(goodId)}`,
        nextInvestmentInventory.get(goodId) ?? 0,
      );
      if (consumed > opening && consumed - opening > quantityEpsilon) {
        throw new Error(
          `Phase-12 capital execution over-consumes ${String(goodId)} for ProductionUnit ${String(unit.productionUnitId)}`,
        );
      }
      const remaining = opening - consumed;
      nextInvestmentInventory.set(goodId, remaining < 0 ? 0 : remaining);
    }

    const nextUnit: ProductionUnitState = {
      ...unit,
      investmentInventory: nextInvestmentInventory,
      installedCapital: execution.installedCapitalNext,
    };
    validateProductionUnitPersistentState(nextUnit);
    nextProductionUnits.set(unit.productionUnitId, nextUnit);
  }

  return {
    ...world,
    productionUnits: nextProductionUnits,
  };
}

/** Phase-12 handler: records capital evidence only; persistence is an explicit transition. */
export function createPhase12CapitalFormationHandler(): PhaseHandler {
  return (world, context) => {
    if (context.phase !== 12) return context;
    const { executions } = planCapitalFormationPhase12({ world, tick: context.tick });
    return {
      ...context,
      capitalFormationExecutions: executions,
    };
  };
}
