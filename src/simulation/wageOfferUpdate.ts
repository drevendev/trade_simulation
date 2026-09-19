/**
 * Deterministic Phase-15 sticky wage-offer updates (REQ-PRODUCTION-003, closing slice).
 *
 * Handoff/05 §14 adjusts ACTIVE ProductionUnit wage offers from this tick's Phase-2/3
 * labor evidence, but the offer is authoritative persistent state for tick N+1. The
 * Phase-15 handler therefore emits tick-scoped updates only; applyWageOfferStateTransition
 * is the explicit between-tick persistence boundary, preserving WorldState immutability
 * during executeTick(). Phase-5 payroll settlement is deliberately out of scope.
 */

import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { ProductionUnitId, RegionId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { LaborAllocation } from "./laborAllocation";
import type { LaborSupplyPlan } from "./laborSupplyPlanning";
import type { LaborDemandPlan } from "./productionPlanning";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import type { PendingTransitions, ProductionUnitState, WorldState } from "./worldState";

export interface WageOfferUpdate {
  readonly updateId: string;
  readonly tick: number;
  readonly unitId: ProductionUnitId;
  readonly regionId: RegionId;
  readonly laborCategory: string;
  readonly requestedWorkerEquivalents: number;
  readonly allocatedWorkerEquivalents: number;
  readonly availableWorkerEquivalents: number;
  readonly regionalTightness: number;
  readonly regionalWageGrowth: number;
  readonly vacancyRate: number;
  readonly priorOffer: number;
  readonly effectiveMinimumWageFloor: number;
  readonly nextOffer: number;
}

interface ResolvedWageUpdateConfig {
  readonly quantityEpsilon: number;
  readonly wageAdjustmentSpeed: number;
  readonly maxLogWageStep: number;
  readonly unitVacancyResponse: number;
  readonly maxTightnessSignal: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

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

function requiredNumber(name: string, configured: number | undefined, fallback: number | undefined): number {
  const value = configured ?? fallback;
  if (value === undefined) {
    throw new Error(`${name} is required for Phase-15 wage-offer updates`);
  }
  return requireFinite(name, value);
}

function resolveConfig(config: SimulationConfig): ResolvedWageUpdateConfig {
  const defaults = createDefaultSimulationConfig();
  return {
    quantityEpsilon: requirePositive(
      "SimulationConfig.numeric.quantityEpsilon",
      config.numeric.quantityEpsilon ?? defaults.numeric.quantityEpsilon!,
    ),
    wageAdjustmentSpeed: requireNonNegative(
      "LaborConfig.wageAdjustmentSpeed",
      requiredNumber("LaborConfig.wageAdjustmentSpeed", config.labor.wageAdjustmentSpeed, defaults.labor.wageAdjustmentSpeed),
    ),
    maxLogWageStep: requireNonNegative(
      "LaborConfig.maxLogWageStep",
      requiredNumber("LaborConfig.maxLogWageStep", config.labor.maxLogWageStep, defaults.labor.maxLogWageStep),
    ),
    unitVacancyResponse: requireNonNegative(
      "LaborConfig.unitVacancyResponse",
      requiredNumber("LaborConfig.unitVacancyResponse", config.labor.unitVacancyResponse, defaults.labor.unitVacancyResponse),
    ),
    maxTightnessSignal: requireNonNegative(
      "LaborConfig.maxTightnessSignal",
      requiredNumber("LaborConfig.maxTightnessSignal", config.labor.maxTightnessSignal, defaults.labor.maxTightnessSignal),
    ),
  };
}

function groupKey(regionId: RegionId, laborCategory: string): string {
  return `${String(regionId)}\u0000${laborCategory}`;
}

/**
 * Compute Handoff/05 §14 wage offers from the exact Phase-2/3 labor evidence of tick N.
 * No persistent object is mutated here; every returned update is for tick N+1.
 */
export function planWageOfferUpdatesPhase15(args: {
  readonly tick: number;
  readonly config: SimulationConfig;
  readonly productionUnits: ReadonlyMap<ProductionUnitId, ProductionUnitState>;
  readonly laborSupplyPlans: readonly LaborSupplyPlan[];
  readonly laborDemandPlans: readonly LaborDemandPlan[];
  readonly laborAllocations: readonly LaborAllocation[];
  readonly effectiveMinimumWageFloorByUnit: ReadonlyMap<ProductionUnitId, number>;
}): readonly WageOfferUpdate[] {
  const {
    tick,
    config,
    productionUnits,
    laborSupplyPlans,
    laborDemandPlans,
    laborAllocations,
    effectiveMinimumWageFloorByUnit,
  } = args;
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Phase-15 wage update tick must be a non-negative integer, got ${String(tick)}`);
  }
  const resolved = resolveConfig(config);

  const availableByGroup = new Map<string, number>();
  const seenSupplyPlanIds = new Set<string>();
  const seenCohorts = new Set<string>();
  for (const plan of laborSupplyPlans) {
    if (plan.planId.trim().length === 0) throw new Error("LaborSupplyPlan.planId must be non-empty");
    if (seenSupplyPlanIds.has(plan.planId)) throw new Error(`Duplicate LaborSupplyPlan.planId ${plan.planId}`);
    if (seenCohorts.has(String(plan.cohortId))) throw new Error(`Duplicate LaborSupplyPlan cohort ${String(plan.cohortId)}`);
    if (plan.laborCategory.trim().length === 0) throw new Error(`LaborSupplyPlan ${plan.planId} laborCategory must be non-empty`);
    seenSupplyPlanIds.add(plan.planId);
    seenCohorts.add(String(plan.cohortId));
    const available = requireNonNegative(
      `LaborSupplyPlan ${plan.planId} availableWorkerEquivalents`,
      plan.availableWorkerEquivalents,
    );
    const key = groupKey(plan.regionId, plan.laborCategory);
    availableByGroup.set(key, requireNonNegative(`Phase-15 available labor ${key}`, (availableByGroup.get(key) ?? 0) + available));
  }

  const demandByUnit = new Map<ProductionUnitId, LaborDemandPlan>();
  const requestedByGroup = new Map<string, number>();
  const seenDemandPlanIds = new Set<string>();
  for (const plan of laborDemandPlans) {
    if (plan.planId.trim().length === 0) throw new Error("LaborDemandPlan.planId must be non-empty");
    if (seenDemandPlanIds.has(plan.planId)) throw new Error(`Duplicate LaborDemandPlan.planId ${plan.planId}`);
    if (demandByUnit.has(plan.unitId)) throw new Error(`Duplicate LaborDemandPlan unit ${String(plan.unitId)}`);
    if (plan.laborCategory.trim().length === 0) throw new Error(`LaborDemandPlan ${plan.planId} laborCategory must be non-empty`);
    seenDemandPlanIds.add(plan.planId);
    const requested = requireNonNegative(
      `LaborDemandPlan ${plan.planId} requestedWorkerEquivalents`,
      plan.requestedWorkerEquivalents,
    );
    requireNonNegative(`LaborDemandPlan ${plan.planId} grossWageOffer`, plan.grossWageOffer);
    requireNonNegative(`LaborDemandPlan ${plan.planId} grossPayrollCap`, plan.grossPayrollCap);
    demandByUnit.set(plan.unitId, plan);
    const key = groupKey(plan.regionId, plan.laborCategory);
    requestedByGroup.set(key, requireNonNegative(`Phase-15 requested labor ${key}`, (requestedByGroup.get(key) ?? 0) + requested));
  }

  const allocatedByUnit = new Map<ProductionUnitId, number>();
  const allocatedByGroup = new Map<string, number>();
  const seenAllocationIds = new Set<string>();
  for (const allocation of laborAllocations) {
    if (allocation.allocationId.trim().length === 0) throw new Error("LaborAllocation.allocationId must be non-empty");
    if (seenAllocationIds.has(allocation.allocationId)) throw new Error(`Duplicate LaborAllocation.allocationId ${allocation.allocationId}`);
    seenAllocationIds.add(allocation.allocationId);
    const demand = demandByUnit.get(allocation.unitId);
    if (demand === undefined) {
      throw new Error(`LaborAllocation ${allocation.allocationId} references unknown demand unit ${String(allocation.unitId)}`);
    }
    if (demand.regionId !== allocation.regionId || demand.laborCategory !== allocation.laborCategory) {
      throw new Error(`LaborAllocation ${allocation.allocationId} crosses its demand region/laborCategory group`);
    }
    const workers = requireNonNegative(
      `LaborAllocation ${allocation.allocationId} workerEquivalents`,
      allocation.workerEquivalents,
    );
    allocatedByUnit.set(
      allocation.unitId,
      requireNonNegative(`Phase-15 allocated labor ${String(allocation.unitId)}`, (allocatedByUnit.get(allocation.unitId) ?? 0) + workers),
    );
    const key = groupKey(allocation.regionId, allocation.laborCategory);
    allocatedByGroup.set(key, requireNonNegative(`Phase-15 allocated labor ${key}`, (allocatedByGroup.get(key) ?? 0) + workers));
  }

  const groupKeys = new Set<string>([...availableByGroup.keys(), ...requestedByGroup.keys(), ...allocatedByGroup.keys()]);
  for (const key of groupKeys) {
    const available = availableByGroup.get(key) ?? 0;
    const requested = requestedByGroup.get(key) ?? 0;
    const allocated = allocatedByGroup.get(key) ?? 0;
    const matched = Math.min(available, requested);
    if (Math.abs(allocated - matched) > resolved.quantityEpsilon) {
      throw new Error(`Phase-15 labor evidence for ${key} has allocated ${allocated}, expected matched ${matched}`);
    }
  }

  const updates: WageOfferUpdate[] = [];
  for (const plan of stableOrderBy(laborDemandPlans, (candidate) => String(candidate.unitId))) {
    const unit = productionUnits.get(plan.unitId);
    if (unit === undefined) {
      throw new Error(`LaborDemandPlan ${plan.planId} references unknown ProductionUnit ${String(plan.unitId)}`);
    }
    const allocated = allocatedByUnit.get(plan.unitId) ?? 0;
    if (allocated > plan.requestedWorkerEquivalents + resolved.quantityEpsilon) {
      throw new Error(`Phase-15 allocated labor exceeds demand for ${String(plan.unitId)}`);
    }
    if (unit.seed.status !== "ACTIVE") continue;

    const currentOffer = requireNonNegative(`ProductionUnit ${String(plan.unitId)} wageOffer`, unit.wageOffer);
    const floor = effectiveMinimumWageFloorByUnit.get(plan.unitId);
    if (floor === undefined) {
      throw new Error(`Missing next-tick minimum wage floor for ACTIVE ProductionUnit ${String(plan.unitId)}`);
    }
    const effectiveMinimumWageFloor = requireNonNegative(
      `effectiveMinimumWageFloorByUnit[${String(plan.unitId)}]`,
      floor,
    );

    const key = groupKey(plan.regionId, plan.laborCategory);
    const requestedLabor = requestedByGroup.get(key) ?? 0;
    const availableLabor = availableByGroup.get(key) ?? 0;
    const rawTightness = Math.log(
      (requestedLabor + resolved.quantityEpsilon) / (availableLabor + resolved.quantityEpsilon),
    );
    const regionalTightness = clamp(
      requireFinite(`Phase-15 regional tightness ${key}`, rawTightness),
      -resolved.maxTightnessSignal,
      resolved.maxTightnessSignal,
    );
    const regionalWageGrowth = clamp(
      resolved.wageAdjustmentSpeed * regionalTightness,
      -resolved.maxLogWageStep,
      resolved.maxLogWageStep,
    );
    const vacancyRate = Math.max(0, plan.requestedWorkerEquivalents - allocated) /
      Math.max(plan.requestedWorkerEquivalents, resolved.quantityEpsilon);
    const unitPressure = regionalWageGrowth + resolved.unitVacancyResponse * vacancyRate;
    const boundedPressure = clamp(
      requireFinite(`Phase-15 unit wage pressure ${String(plan.unitId)}`, unitPressure),
      -resolved.maxLogWageStep,
      resolved.maxLogWageStep,
    );
    const unconstrainedNextOffer = requireNonNegative(
      `Phase-15 unconstrained next wage offer ${String(plan.unitId)}`,
      currentOffer * Math.exp(boundedPressure),
    );
    const nextOffer = Math.max(unconstrainedNextOffer, effectiveMinimumWageFloor);
    requireNonNegative(`Phase-15 next wage offer ${String(plan.unitId)}`, nextOffer);

    updates.push({
      updateId: `wage-offer:${tick}:${String(plan.unitId)}`,
      tick,
      unitId: plan.unitId,
      regionId: plan.regionId,
      laborCategory: plan.laborCategory,
      requestedWorkerEquivalents: plan.requestedWorkerEquivalents,
      allocatedWorkerEquivalents: allocated,
      availableWorkerEquivalents: availableLabor,
      regionalTightness,
      regionalWageGrowth,
      vacancyRate,
      priorOffer: currentOffer,
      effectiveMinimumWageFloor,
      nextOffer,
    });
  }

  return updates;
}

/** Phase-15 handler: derive N+1 offers without mutating WorldState during the tick. */
export function createPhase15WageOfferUpdateHandler(options: {
  readonly effectiveMinimumWageFloorByUnit: ReadonlyMap<ProductionUnitId, number>;
}): PhaseHandler {
  return (world: WorldState, context: TickContext, _pendingTransitions: PendingTransitions): TickContext => {
    if (context.phase !== 15) return context;
    const wageOfferUpdates = planWageOfferUpdatesPhase15({
      tick: context.tick,
      config: world.simulationConfig,
      productionUnits: world.productionUnits,
      laborSupplyPlans: context.laborSupplyPlans ?? [],
      laborDemandPlans: context.laborDemandPlans ?? [],
      laborAllocations: context.laborAllocations ?? [],
      effectiveMinimumWageFloorByUnit: options.effectiveMinimumWageFloorByUnit,
    });
    return { ...context, wageOfferUpdates };
  };
}

/** Persist tick N's Phase-15 output into the authoritative wage offers read by tick N+1. */
export function applyWageOfferStateTransition(world: WorldState, context: TickContext): WorldState {
  const updates = context.wageOfferUpdates ?? [];
  if (updates.length === 0) return world;

  const updatedUnits = new Map(world.productionUnits);
  const seenUnits = new Set<ProductionUnitId>();
  for (const update of stableOrderBy(updates, (candidate) => String(candidate.unitId))) {
    if (seenUnits.has(update.unitId)) {
      throw new Error(`Duplicate WageOfferUpdate unit ${String(update.unitId)}`);
    }
    seenUnits.add(update.unitId);
    if (update.tick !== context.tick) {
      throw new Error(`WageOfferUpdate ${update.updateId} tick ${update.tick} does not match context tick ${context.tick}`);
    }
    const unit = updatedUnits.get(update.unitId);
    if (unit === undefined) {
      throw new Error(`WageOfferUpdate ${update.updateId} references unknown ProductionUnit ${String(update.unitId)}`);
    }
    if (unit.seed.status !== "ACTIVE") {
      throw new Error(`WageOfferUpdate ${update.updateId} targets non-ACTIVE ProductionUnit ${String(update.unitId)}`);
    }
    if (unit.wageOffer !== update.priorOffer) {
      throw new Error(`WageOfferUpdate ${update.updateId} is stale for ProductionUnit ${String(update.unitId)}`);
    }
    requireNonNegative(`WageOfferUpdate ${update.updateId} nextOffer`, update.nextOffer);
    updatedUnits.set(update.unitId, { ...unit, wageOffer: update.nextOffer });
  }

  return { ...world, productionUnits: updatedUnits };
}
