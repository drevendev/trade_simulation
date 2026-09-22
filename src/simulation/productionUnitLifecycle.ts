/**
 * Deterministic Phase-14 ProductionUnit lifecycle (REQ-PRODUCTION-007).
 *
 * Lifecycle review is evidence-first: Phase 14 plans immutable review evidence from the
 * opening WorldState, an explicit persistence transition re-derives that evidence before
 * committing counters/pending changes, and status/removal effects activate at Phase 1 of
 * tick N+1. This keeps current-tick production causally closed while giving M4 exactly one
 * live lifecycle-status authority.
 */
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, ProductionUnitId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { ProductionUnitLifecycleStatus, ProductionSignalState } from "./productionUnitState";
import { validateProductionUnitPersistentState } from "./productionUnitState";
import type { PhaseHandler } from "./tickOrchestrator";
import type {
  PendingTransitions,
  ProductionUnitLifecycleTransition,
  ProductionUnitState,
  RegionState,
  WorldState,
} from "./worldState";

export interface ProductionUnitLifecycleReadiness {
  readonly ownerPresent: boolean;
  readonly infrastructureReady: boolean;
  readonly resourceReady: boolean;
  readonly capitalReady: boolean;
  readonly operatingCashReady: boolean;
  readonly ready: boolean;
}

export interface ProductionUnitLifecycleReview {
  readonly tick: number;
  readonly unitId: ProductionUnitId;
  readonly openingStatus: ProductionUnitLifecycleStatus;
  readonly readiness: ProductionUnitLifecycleReadiness;
  readonly nextSignals: ProductionSignalState;
  readonly nextLastLifecycleReviewTick: number;
  readonly transition?: ProductionUnitLifecycleTransition;
}

export interface ProductionUnitLifecyclePlanResult {
  readonly reviews: readonly ProductionUnitLifecycleReview[];
}

export interface ProductionUnitOwnerFundingRequest {
  readonly unitId: ProductionUnitId;
  /** Home/settlement-currency units. M4 performs no hidden FX. */
  readonly amount: number;
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

function requirePositiveInteger(name: string, value: number): number {
  requireFinite(name, value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1, got ${String(value)}`);
  }
  return value;
}

function resolveLifecycleConfig(world: WorldState) {
  const defaults = createDefaultSimulationConfig();
  const configured = world.simulationConfig.production;
  return {
    cadence: requirePositiveInteger(
      "ProductionConfig.lifecycleReviewCadenceTicks",
      configured.lifecycleReviewCadenceTicks ?? defaults.production.lifecycleReviewCadenceTicks!,
    ),
    mothballMarginThreshold: requireFinite(
      "ProductionConfig.mothballMarginThreshold",
      configured.mothballMarginThreshold ?? defaults.production.mothballMarginThreshold!,
    ),
    mothballUtilizationThreshold: requireNonNegative(
      "ProductionConfig.mothballUtilizationThreshold",
      configured.mothballUtilizationThreshold ?? defaults.production.mothballUtilizationThreshold!,
    ),
    mothballAfterReviews: requirePositiveInteger(
      "ProductionConfig.mothballAfterReviews",
      configured.mothballAfterReviews ?? defaults.production.mothballAfterReviews!,
    ),
    reactivateMarginThreshold: requireFinite(
      "ProductionConfig.reactivateMarginThreshold",
      configured.reactivateMarginThreshold ?? defaults.production.reactivateMarginThreshold!,
    ),
    reactivateAfterReviews: requirePositiveInteger(
      "ProductionConfig.reactivateAfterReviews",
      configured.reactivateAfterReviews ?? defaults.production.reactivateAfterReviews!,
    ),
    closeAfterReviews: requirePositiveInteger(
      "ProductionConfig.closeAfterReviews",
      configured.closeAfterReviews ?? defaults.production.closeAfterReviews!,
    ),
    closingGraceReviews: requirePositiveInteger(
      "ProductionConfig.closingGraceReviews",
      configured.closingGraceReviews ?? defaults.production.closingGraceReviews!,
    ),
    minimumLifecycleScale: requireNonNegative(
      "ProductionConfig.minimumLifecycleScale",
      configured.minimumLifecycleScale ?? defaults.production.minimumLifecycleScale!,
    ),
    minOperatingCash: requireNonNegative(
      "ProductionConfig.minOperatingCash",
      configured.minOperatingCash ?? defaults.production.minOperatingCash!,
    ),
    moneyEpsilon: requirePositive(
      "NumericConfig.moneyEpsilon",
      world.simulationConfig.numeric.moneyEpsilon ?? defaults.numeric.moneyEpsilon!,
    ),
    quantityEpsilon: requirePositive(
      "NumericConfig.quantityEpsilon",
      world.simulationConfig.numeric.quantityEpsilon ?? defaults.numeric.quantityEpsilon!,
    ),
  };
}

function regionForUnit(world: WorldState, unit: ProductionUnitState): RegionState {
  const matches = stableOrderBy(
    [...world.regions.values()].filter((candidate) => candidate.seed.key === unit.seed.regionKey),
    (candidate) => String(candidate.regionId),
  );
  if (matches.length !== 1) {
    throw new Error(
      `ProductionUnit ${String(unit.productionUnitId)} region ${unit.seed.regionKey} must resolve exactly once, got ${matches.length}`,
    );
  }
  return matches[0]!;
}

function ownerPresent(world: WorldState, unit: ProductionUnitState): boolean {
  if (unit.seed.owner.type === "CLAN") {
    return [...world.clans.values()].some((candidate) => candidate.seed.key === unit.seed.owner.key);
  }
  return [...world.states.values()].some((candidate) => candidate.seed.key === unit.seed.owner.key);
}

function lifecycleReadiness(world: WorldState, unit: ProductionUnitState): ProductionUnitLifecycleReadiness {
  const config = resolveLifecycleConfig(world);
  const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
  if (recipe === undefined) {
    throw new Error(`ProductionUnit ${String(unit.productionUnitId)} references unknown recipe ${unit.seed.recipeId}`);
  }
  const region = regionForUnit(world, unit);

  const infrastructureFactor = recipe.infrastructureCategory === undefined
    ? 1
    : requireNonNegative(
        `Region infrastructure[${recipe.infrastructureCategory}]`,
        region.seed.infrastructure[recipe.infrastructureCategory] ?? 0,
      );
  const minimumInfrastructureFactor = requireNonNegative(
    `Recipe ${recipe.id} minimumInfrastructureFactor`,
    recipe.minimumInfrastructureFactor ?? 0,
  );
  const infrastructureReady = infrastructureFactor + config.quantityEpsilon >= minimumInfrastructureFactor;

  const resourceReady = recipe.extractionResourceId === undefined
    ? true
    : region.seed.deposits.some(
        (candidate) => candidate.resourceId === recipe.extractionResourceId && candidate.initiallyKnown,
      ) && (region.resourceDeposits.get(recipe.extractionResourceId) ?? 0) > config.quantityEpsilon;

  const capitalReady =
    requireNonNegative(`ProductionUnit ${String(unit.productionUnitId)} installedCapital`, unit.installedCapital) +
      config.minimumLifecycleScale >=
    requireNonNegative(`Recipe ${recipe.id} minimumStartupCapital`, recipe.minimumStartupCapital);
  const homeCash = requireNonNegative(
    `ProductionUnit ${String(unit.productionUnitId)} home cash`,
    unit.wallet.get(region.settlementCurrencyId) ?? 0,
  );
  const operatingCashReady = homeCash + config.moneyEpsilon >= config.minOperatingCash;
  const hasOwner = ownerPresent(world, unit);
  const ready = hasOwner && infrastructureReady && resourceReady && capitalReady && operatingCashReady;

  return {
    ownerPresent: hasOwner,
    infrastructureReady,
    resourceReady,
    capitalReady,
    operatingCashReady,
    ready,
  };
}

function transitionFor(
  unit: ProductionUnitState,
  tick: number,
  target: ProductionUnitLifecycleStatus | "RETIRED",
): ProductionUnitLifecycleTransition {
  return {
    transitionId: `pu-lifecycle:${tick}:${String(unit.productionUnitId)}:${unit.status}->${target}`,
    unitId: unit.productionUnitId,
    fromStatus: unit.status,
    target,
    decisionTick: tick,
    activateTick: tick + 1,
  };
}

function dueAtTick(world: WorldState, tick: number): boolean {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Phase-14 lifecycle tick must be a non-negative integer, got ${String(tick)}`);
  }
  const { cadence } = resolveLifecycleConfig(world);
  return tick > 0 && tick % cadence === 0;
}

/**
 * A CLOSING unit may retire only when every persistent M4 stock owned by the unit is
 * materially empty and no other pending lifecycle reference keeps the unit live.
 */
export function isProductionUnitSafeForRetirement(
  world: WorldState,
  unitId: ProductionUnitId,
  ignoredTransitionId?: string,
): boolean {
  const unit = world.productionUnits.get(unitId);
  if (unit === undefined || unit.status !== "CLOSING") return false;
  const config = resolveLifecycleConfig(world);
  const materiallyPositive = (values: Iterable<number>, epsilon: number) =>
    [...values].some((value) => requireNonNegative("ProductionUnit retirement stock", value) > epsilon);

  if (materiallyPositive(unit.wallet.values(), config.moneyEpsilon)) return false;
  if (materiallyPositive(unit.inputInventory.values(), config.quantityEpsilon)) return false;
  if (materiallyPositive(unit.outputInventory.values(), config.quantityEpsilon)) return false;
  if (materiallyPositive(unit.investmentInventory.values(), config.quantityEpsilon)) return false;
  if (unit.installedCapital > config.quantityEpsilon) return false;

  return !(world.pendingTransitions.productionUnitLifecycleChanges ?? []).some(
    (candidate) =>
      candidate.unitId === unitId &&
      candidate.transitionId !== ignoredTransitionId,
  );
}

/** Plan every due Phase-14 review in stable ProductionUnitId order. */
export function planProductionUnitLifecyclePhase14(args: {
  readonly world: WorldState;
  readonly tick: number;
}): ProductionUnitLifecyclePlanResult {
  const { world, tick } = args;
  if (!dueAtTick(world, tick)) return { reviews: [] };
  const config = resolveLifecycleConfig(world);
  const reviews: ProductionUnitLifecycleReview[] = [];

  for (const unit of stableOrderBy(world.productionUnits.values(), (candidate) => String(candidate.productionUnitId))) {
    if (unit.lastLifecycleReviewTick >= tick) {
      throw new Error(
        `ProductionUnit ${String(unit.productionUnitId)} lifecycle review tick ${tick} is stale/replayed after ${unit.lastLifecycleReviewTick}`,
      );
    }
    const readiness = lifecycleReadiness(world, unit);
    let nextSignals = unit.signals;
    let transition: ProductionUnitLifecycleTransition | undefined;

    if (unit.status === "PLANNED") {
      nextSignals = {
        ...unit.signals,
        consecutiveNonviableReviews: 0,
        consecutiveViableReviews: 0,
      };
      if (readiness.ready) transition = transitionFor(unit, tick, "ACTIVE");
    } else if (unit.status === "ACTIVE") {
      const nonviable =
        unit.signals.marginSignalEma < config.mothballMarginThreshold &&
        unit.signals.utilizationEma < config.mothballUtilizationThreshold;
      const consecutiveNonviableReviews = nonviable
        ? unit.signals.consecutiveNonviableReviews + 1
        : 0;
      nextSignals = {
        ...unit.signals,
        consecutiveNonviableReviews,
        consecutiveViableReviews: 0,
      };
      if (consecutiveNonviableReviews >= config.mothballAfterReviews) {
        transition = transitionFor(unit, tick, "MOTHBALLED");
      }
    } else if (unit.status === "MOTHBALLED") {
      const viableForReactivation =
        unit.signals.marginSignalEma > config.reactivateMarginThreshold && readiness.ready;
      const consecutiveViableReviews = viableForReactivation
        ? unit.signals.consecutiveViableReviews + 1
        : 0;
      const consecutiveNonviableReviews = viableForReactivation
        ? 0
        : unit.signals.consecutiveNonviableReviews + 1;
      nextSignals = {
        ...unit.signals,
        consecutiveNonviableReviews,
        consecutiveViableReviews,
      };
      if (consecutiveViableReviews >= config.reactivateAfterReviews) {
        transition = transitionFor(unit, tick, "ACTIVE");
      } else if (consecutiveNonviableReviews >= config.closeAfterReviews) {
        transition = transitionFor(unit, tick, "CLOSING");
      }
    } else {
      const closingReviews = unit.signals.consecutiveNonviableReviews + 1;
      nextSignals = {
        ...unit.signals,
        consecutiveNonviableReviews: closingReviews,
        consecutiveViableReviews: 0,
      };
      if (closingReviews >= config.closingGraceReviews && isProductionUnitSafeForRetirement(world, unit.productionUnitId)) {
        transition = transitionFor(unit, tick, "RETIRED");
      }
    }

    reviews.push({
      tick,
      unitId: unit.productionUnitId,
      openingStatus: unit.status,
      readiness,
      nextSignals,
      nextLastLifecycleReviewTick: tick,
      ...(transition === undefined ? {} : { transition }),
    });
  }

  return { reviews };
}

function reviewEquals(left: ProductionUnitLifecycleReview, right: ProductionUnitLifecycleReview): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Persist Phase-14 counters and enqueue exact N+1 lifecycle transitions. Caller evidence is
 * never trusted: the complete review batch is re-derived from the opening WorldState.
 */
export function applyProductionUnitLifecycleReviewTransition(
  world: WorldState,
  reviews: readonly ProductionUnitLifecycleReview[],
  currentTick: number,
): WorldState {
  const expected = planProductionUnitLifecyclePhase14({ world, tick: currentTick }).reviews;
  if (
    expected.length !== reviews.length ||
    expected.some((candidate, index) => reviews[index] === undefined || !reviewEquals(candidate, reviews[index]!))
  ) {
    throw new Error(`Phase-14 ProductionUnit lifecycle evidence for tick ${currentTick} does not match authoritative state`);
  }
  if (expected.length === 0) return world;

  const existingFutureUnits = new Set(
    (world.pendingTransitions.productionUnitLifecycleChanges ?? []).map((candidate) => String(candidate.unitId)),
  );
  for (const review of expected) {
    if (review.transition !== undefined && existingFutureUnits.has(String(review.unitId))) {
      throw new Error(`ProductionUnit ${String(review.unitId)} already has a pending lifecycle transition`);
    }
  }

  const nextUnits = new Map(world.productionUnits);
  const queued: ProductionUnitLifecycleTransition[] = [];
  for (const review of expected) {
    const unit = world.productionUnits.get(review.unitId);
    if (unit === undefined || unit.status !== review.openingStatus) {
      throw new Error(`Phase-14 lifecycle review references stale/wrong ProductionUnit ${String(review.unitId)}`);
    }
    const nextUnit: ProductionUnitState = {
      ...unit,
      signals: review.nextSignals,
      lastLifecycleReviewTick: review.nextLastLifecycleReviewTick,
    };
    validateProductionUnitPersistentState(nextUnit);
    nextUnits.set(review.unitId, nextUnit);
    if (review.transition !== undefined) queued.push(review.transition);
  }

  return {
    ...world,
    productionUnits: nextUnits,
    pendingTransitions: {
      ...world.pendingTransitions,
      productionUnitLifecycleChanges: [
        ...(world.pendingTransitions.productionUnitLifecycleChanges ?? []),
        ...queued,
      ],
    },
  };
}

/** Apply exact pending lifecycle effects at Phase 1 of their activation tick. */
export function applyProductionUnitLifecycleTransitionsAtPhase1(
  world: WorldState,
  currentTick: number,
): WorldState {
  if (!Number.isInteger(currentTick) || currentTick < 0) {
    throw new Error(`Phase-1 lifecycle activation tick must be a non-negative integer, got ${String(currentTick)}`);
  }
  const lifecycleChanges = world.pendingTransitions.productionUnitLifecycleChanges ?? [];
  const stale = lifecycleChanges.filter(
    (candidate) => candidate.activateTick < currentTick,
  );
  if (stale.length > 0) {
    throw new Error(`Stale ProductionUnit lifecycle transition ${stale[0]!.transitionId} was not activated on time`);
  }
  const due = stableOrderBy(
    lifecycleChanges.filter(
      (candidate) => candidate.activateTick === currentTick,
    ),
    (candidate) => `${String(candidate.unitId)}|${candidate.transitionId}`,
  );
  if (due.length === 0) return world;

  const seen = new Set<ProductionUnitId>();
  let nextUnits = new Map(world.productionUnits);
  for (const transition of due) {
    if (transition.decisionTick + 1 !== transition.activateTick) {
      throw new Error(`Lifecycle transition ${transition.transitionId} violates next-tick activation`);
    }
    if (seen.has(transition.unitId)) {
      throw new Error(`Duplicate lifecycle transition for ProductionUnit ${String(transition.unitId)}`);
    }
    seen.add(transition.unitId);

    const unit = nextUnits.get(transition.unitId);
    if (unit === undefined || unit.status !== transition.fromStatus) {
      throw new Error(`Lifecycle transition ${transition.transitionId} has stale/wrong unit status provenance`);
    }

    if (transition.target === "RETIRED") {
      if (transition.fromStatus !== "CLOSING") {
        throw new Error(`Only CLOSING ProductionUnits may retire`);
      }
      if (!isProductionUnitSafeForRetirement(world, transition.unitId, transition.transitionId)) {
        throw new Error(`ProductionUnit ${String(transition.unitId)} cannot retire with residual canonical stock/reference`);
      }
      nextUnits.delete(transition.unitId);
      continue;
    }

    const nextUnit: ProductionUnitState = {
      ...unit,
      status: transition.target,
      signals: {
        ...unit.signals,
        consecutiveNonviableReviews: 0,
        consecutiveViableReviews: 0,
      },
    };
    validateProductionUnitPersistentState(nextUnit);
    nextUnits.set(transition.unitId, nextUnit);
  }

  const activatedIds = new Set(due.map((candidate) => candidate.transitionId));
  return {
    ...world,
    productionUnits: nextUnits,
    pendingTransitions: {
      ...world.pendingTransitions,
      productionUnitLifecycleChanges: lifecycleChanges.filter(
        (candidate) => !activatedIds.has(candidate.transitionId),
      ),
    },
  };
}

/**
 * Explicit M4 owner-to-unit startup funding primitive. The amount is denominated only in
 * the unit Region's settlement currency; cross-currency requests must use the later
 * canonical FX path rather than a hidden production converter.
 */
export function applyProductionUnitOwnerFundingTransition(
  world: WorldState,
  request: ProductionUnitOwnerFundingRequest,
): WorldState {
  const amount = requirePositive("ProductionUnit owner funding amount", request.amount);
  const unit = world.productionUnits.get(request.unitId);
  if (unit === undefined) {
    throw new Error(`Owner funding references unknown ProductionUnit ${String(request.unitId)}`);
  }
  if (unit.status !== "PLANNED" && unit.status !== "MOTHBALLED") {
    throw new Error(`Owner startup funding is only valid for PLANNED/MOTHBALLED units`);
  }
  const region = regionForUnit(world, unit);
  const currencyId: CurrencyId = region.settlementCurrencyId;
  const moneyEpsilon = resolveLifecycleConfig(world).moneyEpsilon;
  const nextUnitWallet = new Map(unit.wallet);
  const openingUnitCash = requireNonNegative(
    `ProductionUnit ${String(unit.productionUnitId)} wallet[${String(currencyId)}]`,
    nextUnitWallet.get(currencyId) ?? 0,
  );

  let nextStates = world.states;
  let nextClans = world.clans;
  let openingOwnerCash: number;
  if (unit.seed.owner.type === "STATE") {
    const matches = stableOrderBy(
      [...world.states.values()].filter((candidate) => candidate.seed.key === unit.seed.owner.key),
      (candidate) => String(candidate.stateId),
    );
    if (matches.length !== 1) throw new Error(`ProductionUnit owner State ${unit.seed.owner.key} must resolve exactly once`);
    const owner = matches[0]!;
    openingOwnerCash = requireNonNegative(
      `State owner treasury[${String(currencyId)}]`,
      owner.treasury.get(currencyId) ?? 0,
    );
    if (amount > openingOwnerCash + moneyEpsilon) throw new Error(`ProductionUnit owner funding would overdraw State treasury`);
    const treasury = new Map(owner.treasury);
    treasury.set(currencyId, Math.max(0, openingOwnerCash - amount));
    const states = new Map(world.states);
    states.set(owner.stateId, { ...owner, treasury });
    nextStates = states;
  } else {
    const matches = stableOrderBy(
      [...world.clans.values()].filter((candidate) => candidate.seed.key === unit.seed.owner.key),
      (candidate) => String(candidate.clanId),
    );
    if (matches.length !== 1) throw new Error(`ProductionUnit owner Clan ${unit.seed.owner.key} must resolve exactly once`);
    const owner = matches[0]!;
    openingOwnerCash = requireNonNegative(
      `Clan owner treasury[${String(currencyId)}]`,
      owner.treasury.get(currencyId) ?? 0,
    );
    if (amount > openingOwnerCash + moneyEpsilon) throw new Error(`ProductionUnit owner funding would overdraw Clan treasury`);
    const treasury = new Map(owner.treasury);
    treasury.set(currencyId, Math.max(0, openingOwnerCash - amount));
    const clans = new Map(world.clans);
    clans.set(owner.clanId, { ...owner, treasury });
    nextClans = clans;
  }

  nextUnitWallet.set(currencyId, openingUnitCash + amount);
  const nextUnit: ProductionUnitState = { ...unit, wallet: nextUnitWallet };
  validateProductionUnitPersistentState(nextUnit);
  const nextUnits = new Map(world.productionUnits);
  nextUnits.set(unit.productionUnitId, nextUnit);

  return {
    ...world,
    states: nextStates,
    clans: nextClans,
    productionUnits: nextUnits,
  };
}

/** Phase-14 handler records immutable lifecycle-review evidence; persistence stays explicit. */
export function createPhase14ProductionUnitLifecycleHandler(): PhaseHandler {
  return (world, context) => {
    if (context.phase !== 14) return context;
    const { reviews } = planProductionUnitLifecyclePhase14({ world, tick: context.tick });
    return {
      ...context,
      productionUnitLifecycleReviews: reviews,
    };
  };
}
