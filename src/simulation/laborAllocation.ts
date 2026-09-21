/**
 * Deterministic Phase-3 regional labor allocation (REQ-PRODUCTION-003, allocation slice).
 *
 * Implements Handoff/05 section 13 only. Phase-15 sticky wage-offer updates remain a
 * separate slice of the composite requirement; Phase-5 wage settlement is also separate.
 * Allocations are tick-scoped intent and never create persistent employer linkage.
 */

import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { CohortId, ProductionUnitId, RegionId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { LaborSupplyPlan } from "./laborSupplyPlanning";
import type { LaborDemandPlan } from "./productionPlanning";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import type { PendingTransitions, WorldState } from "./worldState";

export interface LaborAllocation {
  readonly allocationId: string;
  readonly tick: number;
  readonly regionId: RegionId;
  readonly laborCategory: string;
  readonly cohortId: CohortId;
  readonly unitId: ProductionUnitId;
  readonly workerEquivalents: number;
  readonly grossWagePerWorker: number;
  readonly grossWageObligation: number;
}

interface Phase3LaborAllocationAuthorityRecord {
  readonly tick: number;
  readonly laborAllocations: readonly LaborAllocation[];
}

/**
 * Runtime provenance for completed Phase-3 results. The key is the exact TickContext
 * object returned by the canonical Phase-3 handler; callers cannot manufacture an
 * accepted authority by copying `phase` and `laborAllocations` into another object.
 */
const phase3LaborAllocationAuthorities = new WeakMap<TickContext, Phase3LaborAllocationAuthorityRecord>();

interface ResolvedLaborAllocationConfig {
  readonly quantityEpsilon: number;
  readonly moneyEpsilon: number;
  readonly laborWageAttractivenessElasticity: number;
  readonly minWageWeight: number;
  readonly maxWageWeight: number;
  readonly startingReferenceWage: number;
}

interface WeightedCapacity<TId extends string> {
  readonly id: TId;
  readonly capacity: number;
  readonly weight: number;
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
    throw new Error(`${name} is required for Phase-3 labor allocation`);
  }
  return requireFinite(name, value);
}

function resolveLaborAllocationConfig(config: SimulationConfig): ResolvedLaborAllocationConfig {
  const defaults = createDefaultSimulationConfig();
  const quantityEpsilon = requirePositive(
    "SimulationConfig.numeric.quantityEpsilon",
    config.numeric.quantityEpsilon ?? defaults.numeric.quantityEpsilon!,
  );
  const moneyEpsilon = requirePositive(
    "SimulationConfig.numeric.moneyEpsilon",
    config.numeric.moneyEpsilon ?? defaults.numeric.moneyEpsilon!,
  );
  const laborWageAttractivenessElasticity = requireNonNegative(
    "LaborConfig.laborWageAttractivenessElasticity",
    requiredNumber(
      "LaborConfig.laborWageAttractivenessElasticity",
      config.labor.laborWageAttractivenessElasticity,
      defaults.labor.laborWageAttractivenessElasticity,
    ),
  );
  const minWageWeight = requirePositive(
    "LaborConfig.minWageWeight",
    requiredNumber("LaborConfig.minWageWeight", config.labor.minWageWeight, defaults.labor.minWageWeight),
  );
  const maxWageWeight = requirePositive(
    "LaborConfig.maxWageWeight",
    requiredNumber("LaborConfig.maxWageWeight", config.labor.maxWageWeight, defaults.labor.maxWageWeight),
  );
  if (minWageWeight > maxWageWeight) {
    throw new Error("LaborConfig minWageWeight must not exceed maxWageWeight");
  }
  const startingReferenceWage = requireNonNegative(
    "LaborConfig.startingReferenceWage",
    requiredNumber(
      "LaborConfig.startingReferenceWage",
      config.labor.startingReferenceWage,
      defaults.labor.startingReferenceWage,
    ),
  );
  return {
    quantityEpsilon,
    moneyEpsilon,
    laborWageAttractivenessElasticity,
    minWageWeight,
    maxWageWeight,
    startingReferenceWage,
  };
}

function groupKey(regionId: RegionId, laborCategory: string): string {
  return `${String(regionId)}\u0000${laborCategory}`;
}

/**
 * Deterministic capped proportional water-filling. The caller supplies already-stable IDs;
 * final floating residual correction walks those IDs lexically and never uses insertion order.
 */
function cappedProportionalAllocation<TId extends string>(
  target: number,
  source: readonly WeightedCapacity<TId>[],
  quantityEpsilon: number,
): ReadonlyMap<TId, number> {
  const ordered = stableOrderBy(source, (item) => String(item.id));
  const allocations = new Map<TId, number>(ordered.map((item) => [item.id, 0]));
  const capacities = new Map<TId, number>(ordered.map((item) => [item.id, item.capacity]));
  let remaining = target;
  let active = ordered.filter((item) => item.capacity > 0);

  while (remaining > 0 && active.length > 0) {
    const totalWeight = active.reduce((sum, item) => sum + item.weight, 0);
    if (!isFiniteCanonicalNumber(totalWeight) || totalWeight <= 0) {
      throw new Error("Phase-3 labor allocation requires positive finite active weight");
    }

    const capped: typeof active = [];
    for (const item of active) {
      const current = allocations.get(item.id) ?? 0;
      const capRemaining = (capacities.get(item.id) ?? 0) - current;
      const share = remaining * item.weight / totalWeight;
      if (share >= capRemaining - quantityEpsilon) capped.push(item);
    }

    if (capped.length === 0) {
      for (const item of active) {
        const current = allocations.get(item.id) ?? 0;
        allocations.set(item.id, current + remaining * item.weight / totalWeight);
      }
      remaining = 0;
      break;
    }

    const cappedIds = new Set(capped.map((item) => item.id));
    for (const item of stableOrderBy(capped, (candidate) => String(candidate.id))) {
      const current = allocations.get(item.id) ?? 0;
      const capRemaining = Math.max(0, (capacities.get(item.id) ?? 0) - current);
      allocations.set(item.id, current + capRemaining);
      remaining = Math.max(0, remaining - capRemaining);
    }
    active = active.filter((item) => !cappedIds.has(item.id));
  }

  let residual = target - [...allocations.values()].reduce((sum, value) => sum + value, 0);
  if (residual > 0) {
    for (const item of ordered) {
      if (residual <= 0) break;
      const current = allocations.get(item.id) ?? 0;
      const room = Math.max(0, item.capacity - current);
      const correction = Math.min(room, residual);
      allocations.set(item.id, current + correction);
      residual -= correction;
    }
  } else if (residual < 0) {
    let excess = -residual;
    for (const item of ordered) {
      if (excess <= 0) break;
      const current = allocations.get(item.id) ?? 0;
      const correction = Math.min(current, excess);
      allocations.set(item.id, current - correction);
      excess -= correction;
    }
  }

  return allocations;
}

/**
 * Allocate all Phase-2 supply/demand plans for one tick. Cohort wage signals must be
 * opening/prior-close signals keyed by persistent cohort ID; a missing signal uses the
 * canonical scenario starting wage as the section-13 fallback.
 */
export function allocateLaborPhase3(args: {
  readonly tick: number;
  readonly config: SimulationConfig;
  readonly laborSupplyPlans: readonly LaborSupplyPlan[];
  readonly laborDemandPlans: readonly LaborDemandPlan[];
  readonly wageSignalByCohort: ReadonlyMap<CohortId, number>;
}): readonly LaborAllocation[] {
  const { tick, config, laborSupplyPlans, laborDemandPlans, wageSignalByCohort } = args;
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Phase-3 labor allocation tick must be a non-negative integer, got ${String(tick)}`);
  }
  const resolved = resolveLaborAllocationConfig(config);

  const seenSupplyPlanIds = new Set<string>();
  const seenCohorts = new Set<CohortId>();
  for (const plan of laborSupplyPlans) {
    if (plan.planId.trim().length === 0) throw new Error("LaborSupplyPlan.planId must be non-empty");
    if (seenSupplyPlanIds.has(plan.planId)) throw new Error(`Duplicate LaborSupplyPlan.planId ${plan.planId}`);
    if (seenCohorts.has(plan.cohortId)) throw new Error(`Duplicate LaborSupplyPlan cohort ${String(plan.cohortId)}`);
    seenSupplyPlanIds.add(plan.planId);
    seenCohorts.add(plan.cohortId);
    if (plan.laborCategory.trim().length === 0) throw new Error(`LaborSupplyPlan ${plan.planId} laborCategory must be non-empty`);
    requireNonNegative(`LaborSupplyPlan ${plan.planId} availableWorkerEquivalents`, plan.availableWorkerEquivalents);
    const wageSignal = wageSignalByCohort.get(plan.cohortId);
    if (wageSignal !== undefined) requireNonNegative(`Cohort ${String(plan.cohortId)} wageSignal`, wageSignal);
  }

  const seenDemandPlanIds = new Set<string>();
  const seenUnits = new Set<ProductionUnitId>();
  for (const plan of laborDemandPlans) {
    if (plan.planId.trim().length === 0) throw new Error("LaborDemandPlan.planId must be non-empty");
    if (seenDemandPlanIds.has(plan.planId)) throw new Error(`Duplicate LaborDemandPlan.planId ${plan.planId}`);
    if (seenUnits.has(plan.unitId)) throw new Error(`Duplicate LaborDemandPlan unit ${String(plan.unitId)}`);
    seenDemandPlanIds.add(plan.planId);
    seenUnits.add(plan.unitId);
    if (plan.laborCategory.trim().length === 0) throw new Error(`LaborDemandPlan ${plan.planId} laborCategory must be non-empty`);
    const requested = requireNonNegative(
      `LaborDemandPlan ${plan.planId} requestedWorkerEquivalents`,
      plan.requestedWorkerEquivalents,
    );
    const wage = requireNonNegative(`LaborDemandPlan ${plan.planId} grossWageOffer`, plan.grossWageOffer);
    const payrollCap = requireNonNegative(`LaborDemandPlan ${plan.planId} grossPayrollCap`, plan.grossPayrollCap);
    const requestedPayroll = requested * wage;
    requireFinite(`LaborDemandPlan ${plan.planId} requested payroll`, requestedPayroll);
    if (requestedPayroll > payrollCap + resolved.moneyEpsilon) {
      throw new Error(`LaborDemandPlan ${plan.planId} requested payroll exceeds grossPayrollCap`);
    }
  }

  const suppliesByGroup = new Map<string, LaborSupplyPlan[]>();
  const demandsByGroup = new Map<string, LaborDemandPlan[]>();
  const regionAndCategoryByGroup = new Map<string, { regionId: RegionId; laborCategory: string }>();

  for (const plan of laborSupplyPlans) {
    const key = groupKey(plan.regionId, plan.laborCategory);
    const bucket = suppliesByGroup.get(key) ?? [];
    bucket.push(plan);
    suppliesByGroup.set(key, bucket);
    regionAndCategoryByGroup.set(key, { regionId: plan.regionId, laborCategory: plan.laborCategory });
  }
  for (const plan of laborDemandPlans) {
    const key = groupKey(plan.regionId, plan.laborCategory);
    const bucket = demandsByGroup.get(key) ?? [];
    bucket.push(plan);
    demandsByGroup.set(key, bucket);
    regionAndCategoryByGroup.set(key, { regionId: plan.regionId, laborCategory: plan.laborCategory });
  }

  const allocations: LaborAllocation[] = [];
  for (const [key, descriptor] of stableOrderBy(regionAndCategoryByGroup.entries(), ([candidate]) => candidate)) {
    const supplies = stableOrderBy(suppliesByGroup.get(key) ?? [], (plan) => String(plan.cohortId));
    const demands = stableOrderBy(demandsByGroup.get(key) ?? [], (plan) => String(plan.unitId));
    const totalAvailable = supplies.reduce((sum, plan) => sum + plan.availableWorkerEquivalents, 0);
    const totalRequested = demands.reduce((sum, plan) => sum + plan.requestedWorkerEquivalents, 0);
    requireNonNegative(`Phase-3 total available ${key}`, totalAvailable);
    requireNonNegative(`Phase-3 total requested ${key}`, totalRequested);
    const matched = Math.min(totalAvailable, totalRequested);
    if (matched <= 0) continue;

    let weightedWageTotal = 0;
    let wageWeightTotal = 0;
    for (const supply of supplies) {
      if (supply.availableWorkerEquivalents <= 0) continue;
      const wageSignal = wageSignalByCohort.get(supply.cohortId) ?? resolved.startingReferenceWage;
      requireNonNegative(`Cohort ${String(supply.cohortId)} wageSignal`, wageSignal);
      weightedWageTotal += wageSignal * supply.availableWorkerEquivalents;
      wageWeightTotal += supply.availableWorkerEquivalents;
    }
    const regionalReferenceWage = wageWeightTotal > 0
      ? weightedWageTotal / wageWeightTotal
      : resolved.startingReferenceWage;
    requireNonNegative(`regionalReferenceWage ${key}`, regionalReferenceWage);

    const employerInputs: WeightedCapacity<ProductionUnitId>[] = demands
      .filter((plan) => plan.requestedWorkerEquivalents > 0)
      .map((plan) => {
        const rawWeight = Math.pow(
          plan.grossWageOffer / Math.max(regionalReferenceWage, resolved.moneyEpsilon),
          resolved.laborWageAttractivenessElasticity,
        );
        const wageWeight = clamp(
          requireFinite(`LaborDemandPlan ${plan.planId} wageWeight`, rawWeight),
          resolved.minWageWeight,
          resolved.maxWageWeight,
        );
        return {
          id: plan.unitId,
          capacity: plan.requestedWorkerEquivalents,
          weight: plan.requestedWorkerEquivalents * wageWeight,
        };
      });
    const employerAllocations = cappedProportionalAllocation(
      matched,
      employerInputs,
      resolved.quantityEpsilon,
    );

    const cohortInputs: WeightedCapacity<CohortId>[] = supplies
      .filter((plan) => plan.availableWorkerEquivalents > 0)
      .map((plan) => ({
        id: plan.cohortId,
        capacity: plan.availableWorkerEquivalents,
        weight: plan.availableWorkerEquivalents,
      }));
    const cohortAllocations = cappedProportionalAllocation(
      matched,
      cohortInputs,
      resolved.quantityEpsilon,
    );

    const cohortBuckets = stableOrderBy(
      supplies
        .map((plan) => ({ plan, remaining: cohortAllocations.get(plan.cohortId) ?? 0 }))
        .filter((entry) => entry.remaining > 0),
      (entry) => String(entry.plan.cohortId),
    );
    const employerBuckets = stableOrderBy(
      demands
        .map((plan) => ({ plan, remaining: employerAllocations.get(plan.unitId) ?? 0 }))
        .filter((entry) => entry.remaining > 0),
      (entry) => String(entry.plan.unitId),
    );

    let cohortIndex = 0;
    let employerIndex = 0;
    while (cohortIndex < cohortBuckets.length && employerIndex < employerBuckets.length) {
      const cohortBucket = cohortBuckets[cohortIndex]!;
      const employerBucket = employerBuckets[employerIndex]!;
      const workerEquivalents = Math.min(cohortBucket.remaining, employerBucket.remaining);
      if (workerEquivalents <= 0) {
        throw new Error(`Phase-3 two-pointer matcher stalled for ${key}`);
      }
      const grossWagePerWorker = employerBucket.plan.grossWageOffer;
      const grossWageObligation = requireNonNegative(
        "LaborAllocation.grossWageObligation",
        workerEquivalents * grossWagePerWorker,
      );
      allocations.push({
        allocationId: `labor-allocation:${tick}:${String(descriptor.regionId)}:${descriptor.laborCategory}:${String(cohortBucket.plan.cohortId)}:${String(employerBucket.plan.unitId)}`,
        tick,
        regionId: descriptor.regionId,
        laborCategory: descriptor.laborCategory,
        cohortId: cohortBucket.plan.cohortId,
        unitId: employerBucket.plan.unitId,
        workerEquivalents,
        grossWagePerWorker,
        grossWageObligation,
      });

      cohortBucket.remaining = Math.max(0, cohortBucket.remaining - workerEquivalents);
      employerBucket.remaining = Math.max(0, employerBucket.remaining - workerEquivalents);
      if (cohortBucket.remaining === 0) cohortIndex += 1;
      if (employerBucket.remaining === 0) employerIndex += 1;
    }

    const emitted = allocations
      .filter((allocation) => allocation.regionId === descriptor.regionId && allocation.laborCategory === descriptor.laborCategory)
      .reduce((sum, allocation) => sum + allocation.workerEquivalents, 0);
    if (Math.abs(emitted - matched) > resolved.quantityEpsilon) {
      throw new Error(`Phase-3 labor allocation residual ${String(emitted - matched)} exceeds quantityEpsilon for ${key}`);
    }
  }

  return stableOrderBy(
    allocations,
    (allocation) => `${String(allocation.regionId)}\u0000${allocation.laborCategory}\u0000${String(allocation.cohortId)}\u0000${String(allocation.unitId)}`,
  );
}

/**
 * Resolve a completeness-proven Phase-3 authority issued by the canonical handler.
 * Plain TickContext-shaped objects are deliberately insufficient authority even when
 * they claim phase 3 and carry a plausible allocation array.
 */
export function requireCompletePhase3LaborAllocationAuthority(
  context: TickContext,
  currentTick: number,
): readonly LaborAllocation[] {
  if (context.tick !== currentTick) {
    throw new Error(
      `Phase-3 labor-allocation authority is for tick ${context.tick}, expected authoritative Phase-5 tick ${currentTick}`,
    );
  }
  if (context.laborAllocations === undefined) {
    throw new Error(
      `Phase-5 wage persistence requires completed Phase-3 labor-allocation authority for tick ${currentTick}`,
    );
  }
  if (!Number.isInteger(context.phase) || context.phase < 3) {
    throw new Error(
      `Phase-3 labor-allocation authority for tick ${currentTick} is incomplete before Phase 3`,
    );
  }

  const authority = phase3LaborAllocationAuthorities.get(context);
  if (
    authority === undefined ||
    authority.tick !== currentTick ||
    authority.laborAllocations !== context.laborAllocations
  ) {
    throw new Error(
      `Phase-3 labor-allocation authority for tick ${currentTick} was not issued by the canonical Phase-3 handler`,
    );
  }
  return authority.laborAllocations;
}

/**
 * Prove that Phase 3 received complete current-tick Phase-2 labor planning batches.
 *
 * Handler provenance alone is insufficient: callers can invoke a public handler over an
 * incomplete TickContext. Completeness is therefore checked independently against the
 * live canonical actor set. Phase 2 emits exactly one LaborSupplyPlan for every positive
 * WORKING cohort and exactly one LaborDemandPlan for every ProductionUnit (inactive units
 * carry zero demand). Stable plan IDs bind both batches to this tick and actor identity.
 */
function requireCompletePhase2LaborPlanningEvidence(
  world: WorldState,
  context: TickContext,
): { readonly laborSupplyPlans: readonly LaborSupplyPlan[]; readonly laborDemandPlans: readonly LaborDemandPlan[] } {
  const laborSupplyPlans = context.laborSupplyPlans;
  const laborDemandPlans = context.laborDemandPlans;
  if (laborSupplyPlans === undefined || laborDemandPlans === undefined) {
    throw new Error(
      `Phase-3 labor-allocation authority for tick ${context.tick} requires complete Phase-2 labor supply and demand evidence`,
    );
  }

  const expectedCohorts = stableOrderBy(
    [...world.cohorts.values()].filter((cohort) => {
      if (!isFiniteCanonicalNumber(cohort.seed.population) || cohort.seed.population < 0) {
        throw new Error(`Cohort ${String(cohort.cohortId)} population must be finite and >= 0`);
      }
      return cohort.seed.ageBand === "WORKING" && cohort.seed.population > 0;
    }),
    (cohort) => String(cohort.cohortId),
  );
  if (laborSupplyPlans.length !== expectedCohorts.length) {
    throw new Error(
      `Phase-3 labor-allocation authority for tick ${context.tick} has incomplete Phase-2 labor-supply evidence: got ${laborSupplyPlans.length}, expected ${expectedCohorts.length}`,
    );
  }
  const supplyByCohort = new Map<CohortId, LaborSupplyPlan>();
  for (const plan of laborSupplyPlans) {
    if (supplyByCohort.has(plan.cohortId)) {
      throw new Error(`Phase-2 labor-supply evidence duplicates Cohort ${String(plan.cohortId)}`);
    }
    supplyByCohort.set(plan.cohortId, plan);
  }
  for (const cohort of expectedCohorts) {
    const plan = supplyByCohort.get(cohort.cohortId);
    if (plan === undefined) {
      throw new Error(`Phase-2 labor-supply evidence is missing Cohort ${String(cohort.cohortId)}`);
    }
    const expectedPlanId = `labor-supply:${context.tick}:${String(cohort.cohortId)}`;
    if (plan.planId !== expectedPlanId || plan.laborCategory !== cohort.seed.laborCategory) {
      throw new Error(
        `Phase-2 labor-supply evidence for Cohort ${String(cohort.cohortId)} does not match canonical current-tick identity`,
      );
    }
  }

  const expectedUnits = stableOrderBy(
    [...world.productionUnits.values()],
    (unit) => String(unit.productionUnitId),
  );
  if (laborDemandPlans.length !== expectedUnits.length) {
    throw new Error(
      `Phase-3 labor-allocation authority for tick ${context.tick} has incomplete Phase-2 labor-demand evidence: got ${laborDemandPlans.length}, expected ${expectedUnits.length}`,
    );
  }
  const demandByUnit = new Map<ProductionUnitId, LaborDemandPlan>();
  for (const plan of laborDemandPlans) {
    if (demandByUnit.has(plan.unitId)) {
      throw new Error(`Phase-2 labor-demand evidence duplicates ProductionUnit ${String(plan.unitId)}`);
    }
    demandByUnit.set(plan.unitId, plan);
  }
  for (const unit of expectedUnits) {
    const plan = demandByUnit.get(unit.productionUnitId);
    if (plan === undefined) {
      throw new Error(`Phase-2 labor-demand evidence is missing ProductionUnit ${String(unit.productionUnitId)}`);
    }
    const expectedPlanId = `labor-demand-plan:${context.tick}:${String(unit.productionUnitId)}`;
    const expectedProductionPlanId = `production-plan:${context.tick}:${String(unit.productionUnitId)}`;
    if (plan.planId !== expectedPlanId || plan.productionPlanId !== expectedProductionPlanId) {
      throw new Error(
        `Phase-2 labor-demand evidence for ProductionUnit ${String(unit.productionUnitId)} does not match canonical current-tick identity`,
      );
    }
  }

  return { laborSupplyPlans, laborDemandPlans };
}

/** Phase-3 handler: consume complete Phase-2 plans and expose only ephemeral labor allocations. */
export function createPhase3LaborAllocationHandler(): PhaseHandler {
  return (world: WorldState, context: TickContext, _pendingTransitions: PendingTransitions): TickContext => {
    if (context.phase !== 3) return context;

    const { laborSupplyPlans, laborDemandPlans } = requireCompletePhase2LaborPlanningEvidence(world, context);
    const wageSignalByCohort = new Map<CohortId, number>();
    for (const cohort of world.cohorts.values()) {
      wageSignalByCohort.set(cohort.cohortId, cohort.seed.wageSignal);
    }

    const laborAllocations = Object.freeze(
      allocateLaborPhase3({
        tick: context.tick,
        config: world.simulationConfig,
        laborSupplyPlans,
        laborDemandPlans,
        wageSignalByCohort,
      }).map((allocation) => Object.freeze({ ...allocation })),
    );
    const completedContext: TickContext = { ...context, laborAllocations };
    phase3LaborAllocationAuthorities.set(completedContext, {
      tick: context.tick,
      laborAllocations,
    });
    return completedContext;
  };
}
