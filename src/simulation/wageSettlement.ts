/**
 * Deterministic Phase-5 gross wage settlement and withholding (REQ-PRODUCTION-004).
 *
 * Phase 3 fixes the gross obligation. Phase 5 converts that obligation into an atomic
 * transfer from the ProductionUnit wallet to the Cohort wallet plus, for a controlled
 * Region, the collected wage-tax leg to the controlling State treasury. M4 receives tax
 * facts only through the explicit read-only provider below; mutable fiscal policy is M6.
 */

import type { CohortId, CurrencyId, ProductionUnitId, RegionId, StateId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { actorRefKey } from "../domain/genesisLedger";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { LaborAllocation } from "./laborAllocation";
import type { LaborDemandPlan } from "./productionPlanning";
import {
  applyActorMoneyDeltas,
  readActorWallet,
  type ActorMoneyDelta,
} from "./marketSettlementTransition";
import {
  createTransactionBundleId,
  createTransactionId,
  type EconomicTransaction,
  type PhaseHandler,
  type TickContext,
  type TransactionBundleId,
  type TransactionId,
} from "./tickOrchestrator";
import type { PendingTransitions, WorldState } from "./worldState";

/** Explicit deterministic M4 fixture/scenario queries. M6 later backs the same semantics. */
export interface WageTaxPolicyProvider {
  assessWageIncomeTax(stateId: StateId, cohortId: CohortId, grossWage: number): number;
  getCollectionEfficiency(stateId: StateId): number;
}

export interface WagePaymentTransaction extends EconomicTransaction {
  readonly type: "WAGE_PAYMENT";
  readonly grossMoneyAmount: number;
  readonly assessedTaxAmount: number;
}

export interface WageTaxWithheldTransaction extends EconomicTransaction {
  readonly type: "WAGE_TAX_WITHHELD";
  readonly originatingTransactionId: TransactionId;
  readonly grossMoneyAmount: number;
  readonly assessedTaxAmount: number;
}

export interface WageSettlement {
  readonly settlementId: string;
  readonly allocationId: string;
  readonly tick: number;
  readonly regionId: RegionId;
  readonly cohortId: CohortId;
  readonly unitId: ProductionUnitId;
  readonly currencyId: CurrencyId;
  readonly controllerStateId: StateId | null;
  readonly grossWage: number;
  readonly assessedTax: number;
  readonly collectedTax: number;
  readonly uncollectedAssessedTax: number;
  readonly netWage: number;
  readonly bundleId: TransactionBundleId;
  readonly wagePaymentTransaction: WagePaymentTransaction;
  readonly wageTaxWithheldTransaction: WageTaxWithheldTransaction | undefined;
}

function requireFinite(name: string, value: number): number {
  if (!isFiniteCanonicalNumber(value)) throw new Error(`${name} must be finite, got ${String(value)}`);
  return value;
}

function requireNonNegative(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0) throw new Error(`${name} must be >= 0, got ${String(value)}`);
  return value;
}

function requireUnitRegion(world: WorldState, unitId: ProductionUnitId): RegionId {
  const unit = world.productionUnits.get(unitId);
  if (!unit) throw new Error(`Phase-5 wage settlement references unknown ProductionUnit ${String(unitId)}`);
  const matches = [...world.regions.values()].filter((region) => region.seed.key === unit.seed.regionKey);
  if (matches.length !== 1) {
    throw new Error(`ProductionUnit ${String(unitId)} regionKey ${unit.seed.regionKey} must resolve exactly once`);
  }
  return matches[0]!.regionId;
}

function requireCohortRegion(world: WorldState, cohortId: CohortId): RegionId {
  const cohort = world.cohorts.get(cohortId);
  if (!cohort) throw new Error(`Phase-5 wage settlement references unknown Cohort ${String(cohortId)}`);
  const matches = [...world.regions.values()].filter((region) => region.seed.key === cohort.seed.regionKey);
  if (matches.length !== 1) {
    throw new Error(`Cohort ${String(cohortId)} regionKey ${cohort.seed.regionKey} must resolve exactly once`);
  }
  return matches[0]!.regionId;
}

function actorForUnit(unitId: ProductionUnitId): ActorRef {
  return { type: "PRODUCTION_UNIT", productionUnitId: unitId };
}

function actorForCohort(cohortId: CohortId): ActorRef {
  return { type: "COHORT", cohortId };
}

function actorForState(stateId: StateId): ActorRef {
  return { type: "STATE", stateId };
}

function settlementOrderKey(allocation: LaborAllocation): string {
  return `${String(allocation.unitId)}\u0000${String(allocation.cohortId)}\u0000${allocation.allocationId}`;
}

/**
 * Validate and materialize all Phase-5 wage bundles before any authoritative stock changes.
 * If any bundle is invalid the function throws and nothing has been applied.
 */
export function planWageSettlementsPhase5(args: {
  readonly tick: number;
  readonly world: WorldState;
  readonly laborDemandPlans: readonly LaborDemandPlan[];
  readonly laborAllocations: readonly LaborAllocation[];
  readonly effectiveJurisdictionByRegion: ReadonlyMap<RegionId, StateId | null>;
  readonly taxPolicy: WageTaxPolicyProvider;
}): readonly WageSettlement[] {
  const { tick, world, laborDemandPlans, laborAllocations, effectiveJurisdictionByRegion, taxPolicy } = args;
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Phase-5 wage settlement tick must be a non-negative integer, got ${String(tick)}`);
  }
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  if (!isFiniteCanonicalNumber(moneyEpsilon) || moneyEpsilon <= 0) {
    throw new Error(`SimulationConfig.numeric.moneyEpsilon must be finite and > 0, got ${String(moneyEpsilon)}`);
  }
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
  if (!isFiniteCanonicalNumber(quantityEpsilon) || quantityEpsilon <= 0) {
    throw new Error(`SimulationConfig.numeric.quantityEpsilon must be finite and > 0, got ${String(quantityEpsilon)}`);
  }

  const demandByUnit = new Map<ProductionUnitId, LaborDemandPlan>();
  const seenDemandIds = new Set<string>();
  for (const demand of laborDemandPlans) {
    if (demand.planId.trim().length === 0) throw new Error("LaborDemandPlan.planId must be non-empty");
    if (seenDemandIds.has(demand.planId)) throw new Error(`Duplicate LaborDemandPlan.planId ${demand.planId}`);
    if (demandByUnit.has(demand.unitId)) throw new Error(`Duplicate LaborDemandPlan unit ${String(demand.unitId)}`);
    seenDemandIds.add(demand.planId);
    const unit = world.productionUnits.get(demand.unitId);
    if (!unit) throw new Error(`LaborDemandPlan ${demand.planId} references unknown ProductionUnit ${String(demand.unitId)}`);
    const liveRegionId = requireUnitRegion(world, demand.unitId);
    if (liveRegionId !== demand.regionId) {
      throw new Error(`LaborDemandPlan ${demand.planId} region does not match its ProductionUnit`);
    }
    const requested = requireNonNegative(`LaborDemandPlan ${demand.planId} requestedWorkerEquivalents`, demand.requestedWorkerEquivalents);
    const wage = requireNonNegative(`LaborDemandPlan ${demand.planId} grossWageOffer`, demand.grossWageOffer);
    const cap = requireNonNegative(`LaborDemandPlan ${demand.planId} grossPayrollCap`, demand.grossPayrollCap);
    const requestedPayroll = requireNonNegative(`LaborDemandPlan ${demand.planId} requested payroll`, requested * wage);
    if (requestedPayroll > cap + moneyEpsilon) {
      throw new Error(`LaborDemandPlan ${demand.planId} requested payroll exceeds grossPayrollCap`);
    }
    if (unit.seed.status !== "ACTIVE" && requested > 0) {
      throw new Error(`LaborDemandPlan ${demand.planId} requests positive labor for non-ACTIVE ProductionUnit ${String(demand.unitId)}`);
    }
    demandByUnit.set(demand.unitId, demand);
  }

  const settlements: WageSettlement[] = [];
  const seenAllocationIds = new Set<string>();
  const allocatedWorkersByUnit = new Map<ProductionUnitId, number>();
  const grossPayrollByUnit = new Map<ProductionUnitId, number>();

  for (const allocation of stableOrderBy(laborAllocations, settlementOrderKey)) {
    if (allocation.allocationId.trim().length === 0) throw new Error("LaborAllocation.allocationId must be non-empty");
    if (seenAllocationIds.has(allocation.allocationId)) throw new Error(`Duplicate LaborAllocation.allocationId ${allocation.allocationId}`);
    seenAllocationIds.add(allocation.allocationId);
    if (allocation.tick !== tick) {
      throw new Error(`LaborAllocation ${allocation.allocationId} tick ${allocation.tick} does not match Phase-5 tick ${tick}`);
    }

    const demand = demandByUnit.get(allocation.unitId);
    if (!demand) throw new Error(`LaborAllocation ${allocation.allocationId} references unknown demand unit ${String(allocation.unitId)}`);
    const unit = world.productionUnits.get(allocation.unitId)!;
    if (unit.seed.status !== "ACTIVE") {
      throw new Error(`LaborAllocation ${allocation.allocationId} targets non-ACTIVE ProductionUnit ${String(allocation.unitId)}`);
    }
    if (demand.regionId !== allocation.regionId || demand.laborCategory !== allocation.laborCategory) {
      throw new Error(`LaborAllocation ${allocation.allocationId} crosses its demand region/laborCategory group`);
    }
    if (requireUnitRegion(world, allocation.unitId) !== allocation.regionId) {
      throw new Error(`LaborAllocation ${allocation.allocationId} region does not match its ProductionUnit`);
    }
    if (requireCohortRegion(world, allocation.cohortId) !== allocation.regionId) {
      throw new Error(`LaborAllocation ${allocation.allocationId} region does not match its Cohort`);
    }

    const workers = requireNonNegative(`LaborAllocation ${allocation.allocationId} workerEquivalents`, allocation.workerEquivalents);
    const allocatedWorkers = requireNonNegative(
      `Phase-5 allocated workers ${String(allocation.unitId)}`,
      (allocatedWorkersByUnit.get(allocation.unitId) ?? 0) + workers,
    );
    allocatedWorkersByUnit.set(allocation.unitId, allocatedWorkers);
    if (allocatedWorkers > demand.requestedWorkerEquivalents + quantityEpsilon) {
      throw new Error(`Phase-5 allocated workers for ${String(allocation.unitId)} exceed LaborDemandPlan requestedWorkerEquivalents`);
    }
    const wagePerWorker = requireNonNegative(`LaborAllocation ${allocation.allocationId} grossWagePerWorker`, allocation.grossWagePerWorker);
    const gross = requireNonNegative(`LaborAllocation ${allocation.allocationId} grossWageObligation`, allocation.grossWageObligation);
    const recomputedGross = requireNonNegative(`LaborAllocation ${allocation.allocationId} recomputed gross`, workers * wagePerWorker);
    if (Math.abs(recomputedGross - gross) > moneyEpsilon) {
      throw new Error(`LaborAllocation ${allocation.allocationId} grossWageObligation does not equal workers × wage`);
    }
    if (Math.abs(wagePerWorker - demand.grossWageOffer) > moneyEpsilon) {
      throw new Error(`LaborAllocation ${allocation.allocationId} wage does not match its LaborDemandPlan`);
    }

    const unitGross = requireNonNegative(
      `Phase-5 gross payroll ${String(allocation.unitId)}`,
      (grossPayrollByUnit.get(allocation.unitId) ?? 0) + gross,
    );
    grossPayrollByUnit.set(allocation.unitId, unitGross);
    if (unitGross > demand.grossPayrollCap + moneyEpsilon) {
      throw new Error(`Phase-5 gross payroll for ${String(allocation.unitId)} exceeds grossPayrollCap`);
    }

    const region = world.regions.get(allocation.regionId);
    if (!region) throw new Error(`LaborAllocation ${allocation.allocationId} references unknown Region ${String(allocation.regionId)}`);
    if (!effectiveJurisdictionByRegion.has(allocation.regionId)) {
      throw new Error(`Missing Phase-1 effective jurisdiction for Region ${String(allocation.regionId)}`);
    }
    const controllerStateId = effectiveJurisdictionByRegion.get(allocation.regionId) ?? null;
    let assessedTax = 0;
    let collectionEfficiency = 0;
    if (controllerStateId !== null) {
      if (!world.states.has(controllerStateId)) {
        throw new Error(`Effective controller ${String(controllerStateId)} has no StateState`);
      }
      assessedTax = requireNonNegative(
        `assessed wage tax ${allocation.allocationId}`,
        taxPolicy.assessWageIncomeTax(controllerStateId, allocation.cohortId, gross),
      );
      if (assessedTax > gross + moneyEpsilon) {
        throw new Error(`Assessed wage tax for ${allocation.allocationId} exceeds gross wage`);
      }
      collectionEfficiency = requireFinite(
        `wage tax collection efficiency ${String(controllerStateId)}`,
        taxPolicy.getCollectionEfficiency(controllerStateId),
      );
      if (collectionEfficiency < 0 || collectionEfficiency > 1) {
        throw new Error(`Wage tax collection efficiency must be in [0, 1], got ${collectionEfficiency}`);
      }
    }

    const collectedTax = requireNonNegative(`collected wage tax ${allocation.allocationId}`, assessedTax * collectionEfficiency);
    const netWage = requireNonNegative(`net wage ${allocation.allocationId}`, gross - collectedTax);
    const uncollectedAssessedTax = requireNonNegative(
      `uncollected assessed wage tax ${allocation.allocationId}`,
      assessedTax - collectedTax,
    );
    if (Math.abs(gross - (netWage + collectedTax)) > moneyEpsilon) {
      throw new Error(`Wage bundle ${allocation.allocationId} violates gross = net + collected tax`);
    }

    const bundleId = createTransactionBundleId(`tb:${tick}:5:wage:${allocation.allocationId}`);
    const wagePaymentId = createTransactionId(`tx:${tick}:5:wage-payment:${allocation.allocationId}`);
    const wagePaymentTransaction: WagePaymentTransaction = {
      tick,
      phase: 5,
      type: "WAGE_PAYMENT",
      transactionId: wagePaymentId,
      bundleId,
      source: actorForUnit(allocation.unitId),
      destination: actorForCohort(allocation.cohortId),
      currencyId: region.settlementCurrencyId,
      moneyAmount: netWage,
      grossMoneyAmount: gross,
      assessedTaxAmount: assessedTax,
      taxAmount: collectedTax,
      sourceRegionId: allocation.regionId,
      destinationRegionId: allocation.regionId,
      amount: netWage,
      reason: allocation.allocationId,
    };

    let wageTaxWithheldTransaction: WageTaxWithheldTransaction | undefined;
    if (controllerStateId !== null && collectedTax > 0) {
      wageTaxWithheldTransaction = {
        tick,
        phase: 5,
        type: "WAGE_TAX_WITHHELD",
        transactionId: createTransactionId(`tx:${tick}:5:wage-tax:${allocation.allocationId}`),
        bundleId,
        originatingTransactionId: wagePaymentId,
        source: actorForUnit(allocation.unitId),
        destination: actorForState(controllerStateId),
        currencyId: region.settlementCurrencyId,
        moneyAmount: collectedTax,
        grossMoneyAmount: gross,
        assessedTaxAmount: assessedTax,
        taxAmount: collectedTax,
        sourceRegionId: allocation.regionId,
        destinationRegionId: allocation.regionId,
        amount: collectedTax,
        reason: allocation.allocationId,
      };
    }

    settlements.push({
      settlementId: `wage-settlement:${tick}:${allocation.allocationId}`,
      allocationId: allocation.allocationId,
      tick,
      regionId: allocation.regionId,
      cohortId: allocation.cohortId,
      unitId: allocation.unitId,
      currencyId: region.settlementCurrencyId,
      controllerStateId,
      grossWage: gross,
      assessedTax,
      collectedTax,
      uncollectedAssessedTax,
      netWage,
      bundleId,
      wagePaymentTransaction,
      wageTaxWithheldTransaction,
    });
  }

  // Whole-tick employer cash preflight: no earlier bundle may consume cash another bundle needs.
  for (const [unitId, grossPayroll] of grossPayrollByUnit) {
    const demand = demandByUnit.get(unitId)!;
    const region = world.regions.get(demand.regionId)!;
    const available = readActorWallet(world, actorForUnit(unitId)).get(region.settlementCurrencyId) ?? 0;
    requireNonNegative(`ProductionUnit ${String(unitId)} available payroll cash`, available);
    if (grossPayroll > available + moneyEpsilon) {
      throw new Error(`Phase-5 gross payroll for ${String(unitId)} exceeds available settlement-currency cash`);
    }
  }

  return settlements;
}

function moneyDeltasForSettlement(settlement: WageSettlement): readonly ActorMoneyDelta[] {
  const deltas: ActorMoneyDelta[] = [
    { actor: actorForUnit(settlement.unitId), currencyId: settlement.currencyId, delta: -settlement.grossWage },
    { actor: actorForCohort(settlement.cohortId), currencyId: settlement.currencyId, delta: settlement.netWage },
  ];
  if (settlement.controllerStateId !== null && settlement.collectedTax > 0) {
    deltas.push({
      actor: actorForState(settlement.controllerStateId),
      currencyId: settlement.currencyId,
      delta: settlement.collectedTax,
    });
  }
  return deltas;
}

/** Persist all accepted Phase-5 wage bundles exactly once for one authoritative tick. */
export function applyWageSettlementTransition(
  world: WorldState,
  settlements: readonly WageSettlement[],
  currentTick: number,
  phase3LaborAllocations: readonly LaborAllocation[],
): WorldState {
  if (!Number.isInteger(currentTick) || currentTick < 0) {
    throw new Error(`Phase-5 wage settlement transition tick must be a non-negative integer, got ${String(currentTick)}`);
  }
  const lastAppliedTick = world.lastWageSettlementTransitionTick ?? -1;
  if (!Number.isInteger(lastAppliedTick) || lastAppliedTick < -1) {
    throw new Error(
      `WorldState.lastWageSettlementTransitionTick must be an integer >= -1, got ${String(lastAppliedTick)}`,
    );
  }
  if (lastAppliedTick >= currentTick) {
    throw new Error(
      `Phase-5 wage settlement transition for tick ${currentTick} cannot persist after tick ${lastAppliedTick}; each canonical tick may persist wages once`,
    );
  }

  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  if (!isFiniteCanonicalNumber(moneyEpsilon) || moneyEpsilon <= 0) {
    throw new Error(`SimulationConfig.numeric.moneyEpsilon must be finite and > 0, got ${String(moneyEpsilon)}`);
  }

  const allocationById = new Map<string, LaborAllocation>();
  for (const allocation of phase3LaborAllocations) {
    if (allocation.tick !== currentTick) {
      throw new Error(
        `LaborAllocation ${allocation.allocationId} is for tick ${allocation.tick}, expected authoritative Phase-5 tick ${currentTick}`,
      );
    }
    if (allocationById.has(allocation.allocationId)) {
      throw new Error(`Duplicate canonical LaborAllocation ${allocation.allocationId} at Phase-5 persistence`);
    }
    requireNonNegative(
      `LaborAllocation ${allocation.allocationId} grossWageObligation`,
      allocation.grossWageObligation,
    );
    allocationById.set(allocation.allocationId, allocation);
  }

  const persistedAllocationIds = new Set<string>();
  for (const settlement of settlements) {
    if (settlement.tick !== currentTick) {
      throw new Error(
        `WageSettlement ${settlement.settlementId} is for tick ${settlement.tick}, expected ${currentTick}`,
      );
    }
    if (persistedAllocationIds.has(settlement.allocationId)) {
      throw new Error(`Duplicate WageSettlement for LaborAllocation ${settlement.allocationId}`);
    }
    const allocation = allocationById.get(settlement.allocationId);
    if (!allocation) {
      throw new Error(
        `WageSettlement ${settlement.settlementId} has no canonical current-tick LaborAllocation ${settlement.allocationId}`,
      );
    }
    if (
      settlement.unitId !== allocation.unitId ||
      settlement.cohortId !== allocation.cohortId ||
      settlement.regionId !== allocation.regionId
    ) {
      throw new Error(
        `WageSettlement ${settlement.settlementId} identity does not match canonical LaborAllocation ${allocation.allocationId}`,
      );
    }
    if (Math.abs(settlement.grossWage - allocation.grossWageObligation) > moneyEpsilon) {
      throw new Error(
        `WageSettlement ${settlement.settlementId} gross wage does not match canonical LaborAllocation ${allocation.allocationId}`,
      );
    }
    persistedAllocationIds.add(settlement.allocationId);
  }

  for (const allocation of allocationById.values()) {
    if (
      allocation.grossWageObligation > moneyEpsilon &&
      !persistedAllocationIds.has(allocation.allocationId)
    ) {
      throw new Error(
        `Phase-5 wage settlement batch is missing canonical LaborAllocation ${allocation.allocationId} with gross wage obligation ${allocation.grossWageObligation}`,
      );
    }
  }

  const transitionedWorld = applyActorMoneyDeltas(
    world,
    settlements.flatMap((settlement) => moneyDeltasForSettlement(settlement)),
    "Phase-5 wage settlement",
  );
  return {
    ...transitionedWorld,
    lastWageSettlementTransitionTick: currentTick,
  };
}

/**
 * Current-tick post-wage balance projection for later affordability checks (notably Phase 8).
 * This reads the same canonical wallet endpoint as persistence and overlays only accepted
 * Phase-5 wage deltas, so WorldState itself remains immutable during executeTick().
 */
export function getPostWageSpendableBalance(
  world: WorldState,
  settlements: readonly WageSettlement[],
  actor: ActorRef,
  currencyId: CurrencyId,
): number {
  const key = actorRefKey(actor);
  let balance = readActorWallet(world, actor).get(currencyId) ?? 0;
  for (const settlement of settlements) {
    for (const delta of moneyDeltasForSettlement(settlement)) {
      if (delta.currencyId === currencyId && actorRefKey(delta.actor) === key) balance += delta.delta;
    }
  }
  return requireNonNegative(`post-wage spendable balance ${key}:${String(currencyId)}`, balance);
}

/** Phase-5 handler: create settlement evidence and transactions without mutating WorldState. */
export function createPhase5WageSettlementHandler(options: {
  readonly taxPolicy: WageTaxPolicyProvider;
}): PhaseHandler {
  return (world: WorldState, context: TickContext, _pendingTransitions: PendingTransitions): TickContext => {
    if (context.phase !== 5) return context;
    const wageSettlements = planWageSettlementsPhase5({
      tick: context.tick,
      world,
      laborDemandPlans: context.laborDemandPlans ?? [],
      laborAllocations: context.laborAllocations ?? [],
      effectiveJurisdictionByRegion: context.effectiveJurisdictionByRegion,
      taxPolicy: options.taxPolicy,
    });
    const wageTransactions: EconomicTransaction[] = [];
    for (const settlement of wageSettlements) {
      wageTransactions.push(settlement.wagePaymentTransaction);
      if (settlement.wageTaxWithheldTransaction) wageTransactions.push(settlement.wageTaxWithheldTransaction);
    }
    return {
      ...context,
      wageSettlements,
      transactions: [...context.transactions, ...wageTransactions],
    };
  };
}
