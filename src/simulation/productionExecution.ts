/**
 * Deterministic Phase-5 production/extraction execution (REQ-PRODUCTION-005).
 *
 * Handoff/05 sections 16, 17 and 26: planned production is bounded by live inputs,
 * actual Phase-3 labor, effective capital capacity and finite regional resources.
 * Physical deltas are planned without mutating WorldState, then persisted through an
 * explicit transition. Exact output enters the ProductionUnit OUTPUT inventory before
 * the canonical post-production SELL intent is constructed.
 */

import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { RecipeDefinition } from "../config/definitionPack";
import type { GoodId, ProductionUnitId, RegionId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { LaborAllocation } from "./laborAllocation";
import {
  createMarketIntentId,
  validateMarketIntent,
  type MarketIntent,
} from "./marketIntent";
import type { ProductionPlan } from "./productionPlanning";
import type { PhaseHandler } from "./tickOrchestrator";
import type { ProductionUnitState, RegionState, WorldState } from "./worldState";

export interface ProductionExecution {
  readonly tick: number;
  readonly productionPlanId: string;
  readonly unitId: ProductionUnitId;
  readonly regionId: RegionId;
  readonly recipeId: string;
  readonly plannedBatches: number;
  /** null means the dimension is structurally unbounded for this recipe. */
  readonly inputBoundBatches: number | null;
  /** null means the recipe requires no labor. */
  readonly laborBoundBatches: number | null;
  readonly capitalBoundBatches: number;
  /** null means the recipe is not extractive. */
  readonly resourceBoundBatches: number | null;
  readonly realizedBatches: number;
  readonly inputConsumedByGood: Readonly<Record<GoodId, number>>;
  readonly outputGoodId: GoodId;
  readonly outputProducedQuantity: number;
  readonly postProductionOutputQuantity: number;
  readonly allocatedWorkerEquivalents: number;
  readonly resourceConsumption?: {
    readonly resourceId: string;
    readonly quantity: number;
  };
}

export interface ProductionExecutionPlanResult {
  readonly executions: readonly ProductionExecution[];
}

export interface ProductionExecutionAuthority {
  readonly productionPlans: readonly ProductionPlan[];
  readonly laborAllocations: readonly LaborAllocation[];
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

function resolveRegionForUnit(world: WorldState, unit: ProductionUnitState): RegionState {
  const matches = stableOrderBy(
    [...world.regions.values()].filter((region) => region.seed.key === unit.seed.regionKey),
    (region) => String(region.regionId),
  );
  if (matches.length !== 1) {
    throw new Error(
      `ProductionUnit ${String(unit.productionUnitId)} region ${unit.seed.regionKey} must resolve exactly once, got ${matches.length}`,
    );
  }
  return matches[0]!;
}

/** Resolve authoritative remaining resource balances without mutating RegionState. */
export function resolveRegionResourceDeposits(region: RegionState): ReadonlyMap<string, number> {
  const live = new Map<string, number>();
  for (const [resourceId, quantity] of stableOrderBy([...region.resourceDeposits.entries()], ([id]) => id)) {
    live.set(resourceId, requireNonNegative(`Region ${String(region.regionId)} resource ${resourceId}`, quantity));
  }
  return live;
}

function validatePlan(plan: ProductionPlan, unit: ProductionUnitState, recipe: RecipeDefinition, tick: number): void {
  if (plan.tick !== tick) {
    throw new Error(`ProductionPlan ${plan.planId} is for tick ${plan.tick}, expected ${tick}`);
  }
  if (plan.unitId !== unit.productionUnitId) {
    throw new Error(`ProductionPlan ${plan.planId} unit provenance mismatch`);
  }
  if (plan.recipeId !== unit.seed.recipeId || plan.recipeId !== recipe.id) {
    throw new Error(`ProductionPlan ${plan.planId} recipe provenance mismatch`);
  }
  requireNonNegative(`ProductionPlan ${plan.planId} plannedBatches`, plan.plannedBatches);
  requireNonNegative(`ProductionPlan ${plan.planId} effectiveCapacityBatches`, plan.effectiveCapacityBatches);
}

function validateAllocation(
  allocation: LaborAllocation,
  tick: number,
  plan: ProductionPlan,
  region: RegionState,
  recipe: RecipeDefinition,
): number {
  if (allocation.tick !== tick) {
    throw new Error(`LaborAllocation ${allocation.allocationId} is for tick ${allocation.tick}, expected ${tick}`);
  }
  if (allocation.unitId !== plan.unitId) {
    throw new Error(`LaborAllocation ${allocation.allocationId} unit provenance mismatch`);
  }
  if (allocation.regionId !== region.regionId) {
    throw new Error(`LaborAllocation ${allocation.allocationId} region provenance mismatch`);
  }
  if (allocation.laborCategory !== recipe.laborCategory) {
    throw new Error(`LaborAllocation ${allocation.allocationId} labor-category provenance mismatch`);
  }
  return requireNonNegative(
    `LaborAllocation ${allocation.allocationId} workerEquivalents`,
    allocation.workerEquivalents,
  );
}

function inputBoundFor(unit: ProductionUnitState, recipe: RecipeDefinition): number | null {
  const inputs = stableOrderBy(Object.entries(recipe.inputsPerBatch) as [GoodId, number][], ([goodId]) => String(goodId));
  if (inputs.length === 0) return null;

  let bound = Number.POSITIVE_INFINITY;
  for (const [goodId, perBatch] of inputs) {
    requirePositive(`Recipe ${recipe.id} inputsPerBatch[${String(goodId)}]`, perBatch);
    const available = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} INPUT ${String(goodId)}`,
      unit.inputInventory.get(goodId) ?? 0,
    );
    bound = Math.min(bound, available / perBatch);
  }
  return requireNonNegative(`ProductionUnit ${String(unit.productionUnitId)} input bound`, bound);
}

function minimumFiniteBounds(bounds: readonly (number | null)[]): number {
  const finite = bounds.filter((value): value is number => value !== null);
  if (finite.length === 0) return 0;
  return Math.max(0, Math.min(...finite));
}

/**
 * Plan all Phase-5 physical production deltas in stable unit order.
 *
 * Shared finite deposits are reserved in an ephemeral working map as earlier unit IDs are
 * planned, so two units can never each consume the same opening resource quantity.
 */
export function planProductionExecutionsPhase5(args: {
  readonly world: WorldState;
  readonly tick: number;
  readonly productionPlans: readonly ProductionPlan[];
  readonly laborAllocations: readonly LaborAllocation[];
}): ProductionExecutionPlanResult {
  const { world, tick } = args;
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Phase-5 production tick must be a non-negative integer, got ${String(tick)}`);
  }

  const quantityEpsilon = requirePositive(
    "SimulationConfig.numeric.quantityEpsilon",
    world.simulationConfig.numeric.quantityEpsilon ?? createDefaultSimulationConfig().numeric.quantityEpsilon!,
  );

  const planByUnit = new Map<ProductionUnitId, ProductionPlan>();
  const planIds = new Set<string>();
  for (const plan of args.productionPlans) {
    if (planIds.has(plan.planId)) throw new Error(`Duplicate ProductionPlan id ${plan.planId}`);
    if (planByUnit.has(plan.unitId)) throw new Error(`Duplicate ProductionPlan for unit ${String(plan.unitId)}`);
    planIds.add(plan.planId);
    planByUnit.set(plan.unitId, plan);
  }

  const allocationIds = new Set<string>();
  const allocationsByUnit = new Map<ProductionUnitId, LaborAllocation[]>();
  for (const allocation of args.laborAllocations) {
    if (allocationIds.has(allocation.allocationId)) {
      throw new Error(`Duplicate LaborAllocation id ${allocation.allocationId}`);
    }
    allocationIds.add(allocation.allocationId);
    if (!planByUnit.has(allocation.unitId)) {
      throw new Error(`LaborAllocation ${allocation.allocationId} references unit without current ProductionPlan`);
    }
    const list = allocationsByUnit.get(allocation.unitId) ?? [];
    list.push(allocation);
    allocationsByUnit.set(allocation.unitId, list);
  }

  const resourceWorkingByRegion = new Map<RegionId, Map<string, number>>();
  const executions: ProductionExecution[] = [];

  for (const plan of stableOrderBy(args.productionPlans, (candidate) => String(candidate.unitId))) {
    const unit = world.productionUnits.get(plan.unitId);
    if (!unit) throw new Error(`ProductionPlan ${plan.planId} references unknown ProductionUnit ${String(plan.unitId)}`);
    const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
    if (!recipe) throw new Error(`ProductionUnit ${String(unit.productionUnitId)} references missing recipe ${unit.seed.recipeId}`);
    const region = resolveRegionForUnit(world, unit);
    validatePlan(plan, unit, recipe, tick);

    const allocations = stableOrderBy(allocationsByUnit.get(unit.productionUnitId) ?? [], (item) => item.allocationId);
    let allocatedWorkerEquivalents = 0;
    for (const allocation of allocations) {
      allocatedWorkerEquivalents += validateAllocation(allocation, tick, plan, region, recipe);
    }
    requireNonNegative(`ProductionUnit ${String(unit.productionUnitId)} allocated labor`, allocatedWorkerEquivalents);

    const outputGoodId = recipe.outputGoodId;
    const openingOutput = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} OUTPUT ${String(outputGoodId)}`,
      unit.outputInventory.get(outputGoodId) ?? 0,
    );

    if (unit.status !== "ACTIVE") {
      if (allocatedWorkerEquivalents > quantityEpsilon) {
        throw new Error(
          `Non-ACTIVE ProductionUnit ${String(unit.productionUnitId)} received positive Phase-3 labor allocation`,
        );
      }
      executions.push({
        tick,
        productionPlanId: plan.planId,
        unitId: unit.productionUnitId,
        regionId: region.regionId,
        recipeId: recipe.id,
        plannedBatches: plan.plannedBatches,
        inputBoundBatches: 0,
        laborBoundBatches: 0,
        capitalBoundBatches: 0,
        resourceBoundBatches: recipe.extractionResourceId === undefined ? null : 0,
        realizedBatches: 0,
        inputConsumedByGood: orderedRecord([]),
        outputGoodId,
        outputProducedQuantity: 0,
        postProductionOutputQuantity: openingOutput,
        allocatedWorkerEquivalents,
      });
      continue;
    }

    const inputBoundBatches = inputBoundFor(unit, recipe);
    const laborPerBatch = requireNonNegative(`Recipe ${recipe.id} laborPerBatch`, recipe.laborPerBatch);
    const laborBoundBatches = laborPerBatch === 0
      ? null
      : requireNonNegative(
        `ProductionUnit ${String(unit.productionUnitId)} labor bound`,
        allocatedWorkerEquivalents / Math.max(laborPerBatch, quantityEpsilon),
      );
    const capitalBoundBatches = requireNonNegative(
      `ProductionPlan ${plan.planId} effectiveCapacityBatches`,
      plan.effectiveCapacityBatches,
    );

    let resourceBoundBatches: number | null = null;
    let resourceId: string | undefined;
    let extractedResourcePerBatch: number | undefined;
    if (recipe.extractionResourceId !== undefined) {
      resourceId = recipe.extractionResourceId;
      extractedResourcePerBatch = requirePositive(
        `Recipe ${recipe.id} extractedResourcePerBatch`,
        recipe.extractedResourcePerBatch ?? Number.NaN,
      );
      let resources = resourceWorkingByRegion.get(region.regionId);
      if (!resources) {
        resources = new Map(resolveRegionResourceDeposits(region));
        resourceWorkingByRegion.set(region.regionId, resources);
      }
      const remaining = requireNonNegative(
        `Region ${String(region.regionId)} resource ${resourceId}`,
        resources.get(resourceId) ?? 0,
      );
      resourceBoundBatches = remaining / extractedResourcePerBatch;
    } else if (recipe.extractedResourcePerBatch !== undefined) {
      throw new Error(`Recipe ${recipe.id} has extractedResourcePerBatch without extractionResourceId`);
    }

    const realizedBatches = minimumFiniteBounds([
      requireNonNegative(`ProductionPlan ${plan.planId} plannedBatches`, plan.plannedBatches),
      inputBoundBatches,
      laborBoundBatches,
      capitalBoundBatches,
      resourceBoundBatches,
    ]);

    const inputEntries: (readonly [GoodId, number])[] = [];
    for (const [goodId, coefficient] of stableOrderBy(
      Object.entries(recipe.inputsPerBatch) as [GoodId, number][],
      ([goodId]) => String(goodId),
    )) {
      const consumed = requireNonNegative(
        `ProductionUnit ${String(unit.productionUnitId)} consumed ${String(goodId)}`,
        requirePositive(`Recipe ${recipe.id} inputsPerBatch[${String(goodId)}]`, coefficient) * realizedBatches,
      );
      const available = requireNonNegative(
        `ProductionUnit ${String(unit.productionUnitId)} INPUT ${String(goodId)}`,
        unit.inputInventory.get(goodId) ?? 0,
      );
      if (consumed > available + quantityEpsilon) {
        throw new Error(`ProductionUnit ${String(unit.productionUnitId)} input consumption exceeds live stock for ${String(goodId)}`);
      }
      inputEntries.push([goodId, consumed]);
    }

    let resourceConsumption: ProductionExecution["resourceConsumption"];
    if (resourceId !== undefined && extractedResourcePerBatch !== undefined) {
      const quantity = extractedResourcePerBatch * realizedBatches;
      const resources = resourceWorkingByRegion.get(region.regionId)!;
      const remaining = resources.get(resourceId) ?? 0;
      if (quantity > remaining + quantityEpsilon) {
        throw new Error(`ProductionUnit ${String(unit.productionUnitId)} resource consumption exceeds remaining deposit ${resourceId}`);
      }
      resources.set(resourceId, Math.max(0, remaining - quantity));
      resourceConsumption = { resourceId, quantity };
    }

    const outputProducedQuantity = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} output produced`,
      requirePositive(`Recipe ${recipe.id} outputPerBatch`, recipe.outputPerBatch) * realizedBatches,
    );

    executions.push({
      tick,
      productionPlanId: plan.planId,
      unitId: unit.productionUnitId,
      regionId: region.regionId,
      recipeId: recipe.id,
      plannedBatches: plan.plannedBatches,
      inputBoundBatches,
      laborBoundBatches,
      capitalBoundBatches,
      resourceBoundBatches,
      realizedBatches,
      inputConsumedByGood: orderedRecord(inputEntries),
      outputGoodId,
      outputProducedQuantity,
      postProductionOutputQuantity: openingOutput + outputProducedQuantity,
      allocatedWorkerEquivalents,
      ...(resourceConsumption === undefined ? {} : { resourceConsumption }),
    });
  }

  return { executions };
}

function validateExecutionPhysicalContract(
  execution: ProductionExecution,
  unit: ProductionUnitState,
  recipe: RecipeDefinition,
  quantityEpsilon: number,
): void {
  const realized = requireNonNegative("ProductionExecution.realizedBatches", execution.realizedBatches);
  const planned = requireNonNegative("ProductionExecution.plannedBatches", execution.plannedBatches);
  if (realized > planned + quantityEpsilon) {
    throw new Error(`ProductionExecution realized batches exceed planned batches for ${String(execution.unitId)}`);
  }
  const boundedBy = [
    ["input", execution.inputBoundBatches],
    ["labor", execution.laborBoundBatches],
    ["capital", execution.capitalBoundBatches],
    ["resource", execution.resourceBoundBatches],
  ] as const;
  for (const [name, bound] of boundedBy) {
    if (bound === null) continue;
    const normalized = requireNonNegative(`ProductionExecution ${name} bound`, bound);
    if (realized > normalized + quantityEpsilon) {
      throw new Error(`ProductionExecution realized batches exceed ${name} bound for ${String(execution.unitId)}`);
    }
  }
  if (unit.status !== "ACTIVE" && realized > quantityEpsilon) {
    throw new Error(`Non-ACTIVE ProductionUnit ${String(execution.unitId)} cannot realize production`);
  }

  if (execution.outputGoodId !== recipe.outputGoodId) {
    throw new Error(`ProductionExecution output good provenance mismatch for ${String(execution.unitId)}`);
  }
  const expectedOutput = requirePositive(`Recipe ${recipe.id} outputPerBatch`, recipe.outputPerBatch) * realized;
  const produced = requireNonNegative("ProductionExecution.outputProducedQuantity", execution.outputProducedQuantity);
  if (Math.abs(produced - expectedOutput) > quantityEpsilon) {
    throw new Error(`ProductionExecution output quantity does not equal recipe output × realized batches`);
  }

  const actualInputKeys = stableOrderBy(Object.keys(execution.inputConsumedByGood), String);
  const recipeInputKeys = stableOrderBy(Object.keys(recipe.inputsPerBatch), String);
  if (unit.status === "ACTIVE") {
    if (actualInputKeys.length !== recipeInputKeys.length || actualInputKeys.some((key, index) => key !== recipeInputKeys[index])) {
      throw new Error(`ProductionExecution input-good set does not match recipe ${recipe.id}`);
    }
    for (const goodKey of recipeInputKeys) {
      const goodId = goodKey as GoodId;
      const coefficient = requirePositive(
        `Recipe ${recipe.id} inputsPerBatch[${goodKey}]`,
        recipe.inputsPerBatch[goodId] ?? Number.NaN,
      );
      const actual = requireNonNegative(
        `ProductionExecution consumed ${goodKey}`,
        execution.inputConsumedByGood[goodId] ?? Number.NaN,
      );
      const expected = coefficient * realized;
      if (Math.abs(actual - expected) > quantityEpsilon) {
        throw new Error(`ProductionExecution input quantity for ${goodKey} does not equal recipe input × realized batches`);
      }
    }
  } else if (actualInputKeys.length !== 0) {
    throw new Error(`Non-ACTIVE ProductionUnit ${String(execution.unitId)} cannot consume production inputs`);
  }

  if (recipe.extractionResourceId === undefined) {
    if (execution.resourceConsumption !== undefined) {
      throw new Error(`Non-extraction recipe ${recipe.id} cannot consume a finite resource deposit`);
    }
  } else {
    const perBatch = requirePositive(
      `Recipe ${recipe.id} extractedResourcePerBatch`,
      recipe.extractedResourcePerBatch ?? Number.NaN,
    );
    const resource = execution.resourceConsumption;
    if (unit.status === "ACTIVE") {
      if (resource === undefined || resource.resourceId !== recipe.extractionResourceId) {
        throw new Error(`ProductionExecution extraction resource provenance mismatch for ${String(execution.unitId)}`);
      }
      const actual = requireNonNegative(`ProductionExecution resource ${resource.resourceId}`, resource.quantity);
      const expected = perBatch * realized;
      if (Math.abs(actual - expected) > quantityEpsilon) {
        throw new Error(`ProductionExecution resource quantity does not equal recipe extraction × realized batches`);
      }
    } else if (resource !== undefined) {
      throw new Error(`Non-ACTIVE ProductionUnit ${String(execution.unitId)} cannot deplete a resource deposit`);
    }
  }
}

function validateProductionExecutionCoverage(
  world: WorldState,
  executions: readonly ProductionExecution[],
  currentTick: number,
): void {
  const expectedActiveUnitIds = stableOrderBy(
    [...world.productionUnits.values()]
      .filter((unit) => unit.status === "ACTIVE")
      .map((unit) => unit.productionUnitId),
    String,
  );
  const submittedActiveUnitIds = new Set<ProductionUnitId>();
  const seenUnitIds = new Set<ProductionUnitId>();

  for (const execution of executions) {
    if (execution.tick !== currentTick) {
      throw new Error(
        `ProductionExecution for ${String(execution.unitId)} is for tick ${execution.tick}, expected ${currentTick}`,
      );
    }
    if (seenUnitIds.has(execution.unitId)) {
      throw new Error(`Duplicate ProductionExecution for unit ${String(execution.unitId)}`);
    }
    seenUnitIds.add(execution.unitId);

    const unit = world.productionUnits.get(execution.unitId);
    if (!unit) throw new Error(`ProductionExecution references unknown unit ${String(execution.unitId)}`);
    const expectedPlanId = `production-plan:${currentTick}:${String(execution.unitId)}`;
    if (execution.productionPlanId !== expectedPlanId) {
      throw new Error(
        `ProductionExecution plan provenance mismatch for ${String(execution.unitId)}: expected ${expectedPlanId}`,
      );
    }
    if (unit.status === "ACTIVE") submittedActiveUnitIds.add(execution.unitId);
  }

  const missingActiveUnitIds = expectedActiveUnitIds.filter((unitId) => !submittedActiveUnitIds.has(unitId));
  if (missingActiveUnitIds.length > 0) {
    throw new Error(
      `Phase-5 production execution coverage is incomplete for tick ${currentTick}; missing ACTIVE units: ${missingActiveUnitIds
        .map(String)
        .join(", ")}`,
    );
  }
}

function validateProductionExecutionAuthority(
  world: WorldState,
  executions: readonly ProductionExecution[],
  currentTick: number,
  authority: ProductionExecutionAuthority,
  quantityEpsilon: number,
): void {
  const canonicalExecutions = planProductionExecutionsPhase5({
    world,
    tick: currentTick,
    productionPlans: authority.productionPlans,
    laborAllocations: authority.laborAllocations,
  }).executions;
  const canonicalByUnit = new Map(
    canonicalExecutions.map((execution) => [execution.unitId, execution] as const),
  );

  for (const execution of stableOrderBy(executions, (candidate) => String(candidate.unitId))) {
    const canonical = canonicalByUnit.get(execution.unitId);
    if (!canonical) {
      throw new Error(
        `ProductionExecution for ${String(execution.unitId)} has no authoritative current-tick ProductionPlan`,
      );
    }
    if (execution.productionPlanId !== canonical.productionPlanId) {
      throw new Error(
        `ProductionExecution plan identity for ${String(execution.unitId)} does not match authoritative ProductionPlan`,
      );
    }

    const submittedPlannedBatches = requireNonNegative(
      `ProductionExecution planned batches for ${String(execution.unitId)}`,
      execution.plannedBatches,
    );
    if (Math.abs(submittedPlannedBatches - canonical.plannedBatches) > quantityEpsilon) {
      throw new Error(
        `ProductionExecution planned batches for ${String(execution.unitId)} do not match authoritative ProductionPlan`,
      );
    }

    const submittedCapitalBound = requireNonNegative(
      `ProductionExecution capital bound for ${String(execution.unitId)}`,
      execution.capitalBoundBatches,
    );
    if (Math.abs(submittedCapitalBound - canonical.capitalBoundBatches) > quantityEpsilon) {
      throw new Error(
        `ProductionExecution capital bound for ${String(execution.unitId)} does not match authoritative ProductionPlan`,
      );
    }

    if (canonical.laborBoundBatches === null) {
      if (execution.laborBoundBatches !== null) {
        throw new Error(
          `ProductionExecution labor bound for ${String(execution.unitId)} does not match authoritative Phase-3 labor evidence`,
        );
      }
    } else {
      if (execution.laborBoundBatches === null) {
        throw new Error(
          `ProductionExecution labor bound for ${String(execution.unitId)} does not match authoritative Phase-3 labor evidence`,
        );
      }
      const submittedLaborBound = requireNonNegative(
        `ProductionExecution labor bound for ${String(execution.unitId)}`,
        execution.laborBoundBatches,
      );
      if (Math.abs(submittedLaborBound - canonical.laborBoundBatches) > quantityEpsilon) {
        throw new Error(
          `ProductionExecution labor bound for ${String(execution.unitId)} does not match authoritative Phase-3 labor evidence`,
        );
      }
    }

    const submittedAllocatedLabor = requireNonNegative(
      `ProductionExecution allocated labor for ${String(execution.unitId)}`,
      execution.allocatedWorkerEquivalents,
    );
    if (Math.abs(submittedAllocatedLabor - canonical.allocatedWorkerEquivalents) > quantityEpsilon) {
      throw new Error(
        `ProductionExecution allocated labor for ${String(execution.unitId)} does not match authoritative Phase-3 labor evidence`,
      );
    }

    const submittedRealizedBatches = requireNonNegative(
      `ProductionExecution realized batches for ${String(execution.unitId)}`,
      execution.realizedBatches,
    );
    if (Math.abs(submittedRealizedBatches - canonical.realizedBatches) > quantityEpsilon) {
      throw new Error(
        `ProductionExecution realized batches for ${String(execution.unitId)} do not match authoritative Phase-5 recomputation`,
      );
    }
  }
}

/** Persist exact Phase-5 physical deltas without mutating the input WorldState. */
export function applyProductionExecutionTransition(
  world: WorldState,
  executions: readonly ProductionExecution[],
  currentTick: number,
  authority: ProductionExecutionAuthority,
): WorldState {
  if (!Number.isInteger(currentTick) || currentTick < 0) {
    throw new Error(`Phase-5 production transition tick must be a non-negative integer, got ${String(currentTick)}`);
  }
  const lastAppliedTick = world.lastProductionExecutionTransitionTick;
  if (!Number.isInteger(lastAppliedTick) || lastAppliedTick < -1) {
    throw new Error(
      `WorldState.lastProductionExecutionTransitionTick must be an integer >= -1, got ${String(lastAppliedTick)}`,
    );
  }
  if (lastAppliedTick >= currentTick) {
    throw new Error(
      `Phase-5 production transition for tick ${currentTick} cannot persist after tick ${lastAppliedTick}; each canonical tick may persist Phase 5 once`,
    );
  }

  validateProductionExecutionCoverage(world, executions, currentTick);

  const quantityEpsilon = requirePositive(
    "SimulationConfig.numeric.quantityEpsilon",
    world.simulationConfig.numeric.quantityEpsilon ?? createDefaultSimulationConfig().numeric.quantityEpsilon!,
  );
  validateProductionExecutionAuthority(world, executions, currentTick, authority, quantityEpsilon);
  const productionUnits = new Map(world.productionUnits);
  const regions = new Map(world.regions);
  const seenUnits = new Set<ProductionUnitId>();

  for (const execution of stableOrderBy(executions, (candidate) => String(candidate.unitId))) {
    if (execution.tick !== currentTick) {
      throw new Error(
        `ProductionExecution for ${String(execution.unitId)} is for tick ${execution.tick}, expected ${currentTick}`,
      );
    }
    if (seenUnits.has(execution.unitId)) throw new Error(`Duplicate ProductionExecution for unit ${String(execution.unitId)}`);
    seenUnits.add(execution.unitId);
    const unit = productionUnits.get(execution.unitId);
    if (!unit) throw new Error(`ProductionExecution references unknown unit ${String(execution.unitId)}`);
    const region = regions.get(execution.regionId);
    if (!region) throw new Error(`ProductionExecution references unknown region ${String(execution.regionId)}`);
    if (region.seed.key !== unit.seed.regionKey) {
      throw new Error(`ProductionExecution region provenance mismatch for ${String(execution.unitId)}`);
    }
    if (unit.seed.recipeId !== execution.recipeId) throw new Error(`ProductionExecution recipe provenance mismatch for ${String(execution.unitId)}`);
    const recipe = world.definitionRegistry.recipes[execution.recipeId];
    if (!recipe) throw new Error(`ProductionExecution references missing recipe ${execution.recipeId}`);
    validateExecutionPhysicalContract(execution, unit, recipe, quantityEpsilon);

    const nextInput = new Map(unit.inputInventory);
    for (const [goodId, quantity] of stableOrderBy(
      Object.entries(execution.inputConsumedByGood) as [GoodId, number][],
      ([goodId]) => String(goodId),
    )) {
      const consumed = requireNonNegative(`ProductionExecution consumed ${String(goodId)}`, quantity);
      const current = requireNonNegative(
        `ProductionUnit ${String(unit.productionUnitId)} INPUT ${String(goodId)}`,
        nextInput.get(goodId) ?? 0,
      );
      if (consumed > current + quantityEpsilon) {
        throw new Error(`ProductionExecution would overdraw INPUT ${String(goodId)} for ${String(unit.productionUnitId)}`);
      }
      nextInput.set(goodId, Math.max(0, current - consumed));
    }

    const nextOutput = new Map(unit.outputInventory);
    const openingOutput = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} OUTPUT ${String(execution.outputGoodId)}`,
      nextOutput.get(execution.outputGoodId) ?? 0,
    );
    const produced = requireNonNegative("ProductionExecution outputProducedQuantity", execution.outputProducedQuantity);
    const expectedPostProductionOutput = openingOutput + produced;
    const declaredPostProductionOutput = requireNonNegative(
      "ProductionExecution.postProductionOutputQuantity",
      execution.postProductionOutputQuantity,
    );
    if (Math.abs(declaredPostProductionOutput - expectedPostProductionOutput) > quantityEpsilon) {
      throw new Error(`ProductionExecution post-production OUTPUT does not match opening + produced quantity`);
    }
    nextOutput.set(execution.outputGoodId, expectedPostProductionOutput);

    productionUnits.set(execution.unitId, {
      ...unit,
      inputInventory: nextInput,
      outputInventory: nextOutput,
    });

    if (execution.resourceConsumption !== undefined) {
      const liveResources = new Map(resolveRegionResourceDeposits(region));
      const current = requireNonNegative(
        `Region ${String(region.regionId)} resource ${execution.resourceConsumption.resourceId}`,
        liveResources.get(execution.resourceConsumption.resourceId) ?? 0,
      );
      const consumed = requireNonNegative(
        `ProductionExecution resource ${execution.resourceConsumption.resourceId}`,
        execution.resourceConsumption.quantity,
      );
      if (consumed > current + quantityEpsilon) {
        throw new Error(`ProductionExecution would overdraw resource ${execution.resourceConsumption.resourceId}`);
      }
      liveResources.set(execution.resourceConsumption.resourceId, Math.max(0, current - consumed));
      regions.set(execution.regionId, { ...region, resourceDeposits: liveResources });
    }
  }

  return {
    ...world,
    productionUnits,
    regions,
    lastProductionExecutionTransitionTick: currentTick,
  };
}

/** Build Section-17 canonical OUTPUT SELL intents from post-production stock. */
export function buildProductionOutputSellIntentsPhase5(
  worldAfterProduction: WorldState,
  executions: readonly ProductionExecution[],
): readonly MarketIntent[] {
  const defaults = createDefaultSimulationConfig();
  const outputCoverageTicks = requireNonNegative(
    "ProductionConfig.outputCoverageTicks",
    worldAfterProduction.simulationConfig.production.outputCoverageTicks ?? defaults.production.outputCoverageTicks!,
  );
  const intents: MarketIntent[] = [];

  for (const execution of stableOrderBy(executions, (candidate) => String(candidate.unitId))) {
    const unit = worldAfterProduction.productionUnits.get(execution.unitId);
    if (!unit) throw new Error(`ProductionExecution references unknown unit ${String(execution.unitId)}`);
    if (unit.status !== "ACTIVE" && unit.status !== "CLOSING") continue;
    const region = worldAfterProduction.regions.get(execution.regionId);
    if (!region) throw new Error(`ProductionExecution references unknown region ${String(execution.regionId)}`);
    const outputQuantity = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} post-production OUTPUT`,
      unit.outputInventory.get(execution.outputGoodId) ?? 0,
    );
    const reserve = requireNonNegative(
      `ProductionUnit ${String(unit.productionUnitId)} target output reserve`,
      unit.signals.outputSalesEma * outputCoverageTicks,
    );
    const intent: MarketIntent = {
      id: createMarketIntentId(`mi:output:${execution.tick}:${String(execution.unitId)}`),
      actor: { type: "PRODUCTION_UNIT", productionUnitId: execution.unitId },
      regionId: execution.regionId,
      goodId: execution.outputGoodId,
      side: "SELL",
      purpose: "INVENTORY_REBALANCE",
      desiredQuantity: Math.max(0, outputQuantity - reserve),
      minimumReserveQuantity: reserve,
      sourcePlanId: execution.productionPlanId,
      inventoryBucket: "OUTPUT",
    };
    validateMarketIntent(intent);
    intents.push(intent);
  }

  return intents;
}

/** Phase-5 handler: records physical execution and output intents in TickContext only. */
export function createPhase5ProductionExecutionHandler(): PhaseHandler {
  return (world, context) => {
    if (context.phase !== 5) return context;
    const productionPlans = context.productionPlans ?? [];
    const laborAllocations = context.laborAllocations ?? [];
    const { executions } = planProductionExecutionsPhase5({
      world,
      tick: context.tick,
      productionPlans,
      laborAllocations,
    });
    const projectedWorld = applyProductionExecutionTransition(world, executions, context.tick, {
      productionPlans,
      laborAllocations,
    });
    const outputIntents = buildProductionOutputSellIntentsPhase5(projectedWorld, executions);
    return {
      ...context,
      productionExecutions: executions,
      productionOutputIntents: outputIntents,
      productionMarketIntents: [...(context.productionMarketIntents ?? []), ...outputIntents],
    };
  };
}
