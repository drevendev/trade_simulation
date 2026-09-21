/**
 * Deterministic Phase-9 household consumption, spoilage, and economic evidence
 * (REQ-POPULATION-003).
 *
 * Phase 8 remains the only market-settlement path into Cohort.householdInventory.
 * During an immutable tick this module projects realized MAIN allocations onto the
 * opening household stock so Phase 9 can plan against post-market quantities. The
 * explicit persistence transition below deliberately requires its input WorldState to
 * already contain those settled quantities; it never replays market settlement itself.
 */

import { BASELINE_NEED_CATEGORY_IDS, type NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, GoodId, RegionId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { LaborAllocation } from "./laborAllocation";
import type { LaborSupplyPlan } from "./laborSupplyPlanning";
import { addLedgerRecord, type PhysicalLossRecord } from "./ledger";
import type { MarketAllocation } from "./marketClearing";
import {
  createTransactionId,
  type EconomicTransaction,
  type PhaseHandler,
  type TickContext,
} from "./tickOrchestrator";
import type { WageSettlement } from "./wageSettlement";
import type { CohortState, PendingTransitions, WorldState } from "./worldState";

export interface HouseholdNeedRealization {
  readonly categoryId: string;
  readonly requiredUsefulConsumption: number;
  readonly realizedUsefulConsumption: number;
  readonly coverage: number;
  readonly consumedByGood: Readonly<Record<GoodId, number>>;
  readonly spoiledByGood: Readonly<Record<GoodId, number>>;
}

export interface HouseholdEconomicEvidence {
  readonly cohortId: CohortId;
  readonly availableWorkerEquivalents: number;
  readonly employedWorkerEquivalents: number;
  readonly employmentRate: number;
  readonly grossWageIncome: number;
  readonly netWageReceipt: number;
  readonly wageTaxWithheld: number;
}

export interface HouseholdConsumptionExecution {
  readonly tick: number;
  readonly cohortId: CohortId;
  /** Projected stock after realized Phase-8 MAIN allocations and before Phase-9 losses. */
  readonly postMarketInventoryByGood: Readonly<Record<GoodId, number>>;
  readonly endingInventoryByGood: Readonly<Record<GoodId, number>>;
  readonly categories: readonly HouseholdNeedRealization[];
  readonly essentialCoverage: number;
  readonly consumedByGood: Readonly<Record<GoodId, number>>;
  readonly spoiledByGood: Readonly<Record<GoodId, number>>;
  readonly economic: HouseholdEconomicEvidence;
}

export interface HouseholdConsumptionExecutionResult {
  readonly executions: readonly HouseholdConsumptionExecution[];
  readonly transactions: readonly EconomicTransaction[];
  readonly physicalLosses: readonly PhysicalLossRecord[];
}

export interface HouseholdConsumptionPhase9Input {
  readonly world: WorldState;
  readonly tick: number;
  readonly marketAllocations: readonly MarketAllocation[];
  readonly laborSupplyPlans: readonly LaborSupplyPlan[];
  readonly laborAllocations: readonly LaborAllocation[];
  readonly wageSettlements: readonly WageSettlement[];
  readonly transactions: readonly EconomicTransaction[];
}

interface ResolvedControls {
  readonly quantityEpsilon: number;
  readonly moneyEpsilon: number;
}

interface CategoryRuntime {
  readonly definition: NeedCategoryDefinition;
  readonly candidates: readonly {
    readonly goodId: GoodId;
    readonly qualityFactor: number;
    readonly spoilageRatePerTick: number;
  }[];
}

function requireFinite(name: string, value: number): number {
  if (!isFiniteCanonicalNumber(value)) {
    throw new Error(`${name} must be finite, got ${String(value)}`);
  }
  return value;
}

function requireNonNegative(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0) throw new Error(`${name} must be >= 0, got ${String(value)}`);
  return value;
}

function requirePositive(name: string, value: number): number {
  requireFinite(name, value);
  if (value <= 0) throw new Error(`${name} must be > 0, got ${String(value)}`);
  return value;
}

function requireUnitInterval(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0 || value > 1) throw new Error(`${name} must be in [0, 1], got ${String(value)}`);
  return value;
}

function resolveControls(world: WorldState): ResolvedControls {
  const defaults = createDefaultSimulationConfig();
  return {
    quantityEpsilon: requirePositive(
      "NumericConfig.quantityEpsilon",
      world.simulationConfig.numeric.quantityEpsilon ?? defaults.numeric.quantityEpsilon ?? Number.NaN,
    ),
    moneyEpsilon: requirePositive(
      "NumericConfig.moneyEpsilon",
      world.simulationConfig.numeric.moneyEpsilon ?? defaults.numeric.moneyEpsilon ?? Number.NaN,
    ),
  };
}

function toOrderedRecord(values: ReadonlyMap<GoodId, number>): Readonly<Record<GoodId, number>> {
  const result: Record<string, number> = {};
  for (const [goodId, value] of stableOrderBy([...values.entries()], ([id]) => String(id))) {
    result[goodId] = value;
  }
  return result as Readonly<Record<GoodId, number>>;
}

function addQuantity(target: Map<GoodId, number>, goodId: GoodId, quantity: number): void {
  target.set(goodId, (target.get(goodId) ?? 0) + quantity);
}

function resolveCategories(world: WorldState): readonly CategoryRuntime[] {
  const declared = world.definitionRegistry.needCategories;
  if (declared === undefined) {
    throw new Error("DefinitionRegistry.needCategories is required for Phase-9 household consumption");
  }
  if (Object.keys(declared).length !== BASELINE_NEED_CATEGORY_IDS.length) {
    throw new Error(
      `DefinitionRegistry.needCategories must contain exactly ${BASELINE_NEED_CATEGORY_IDS.join(", ")}`,
    );
  }

  const categories = BASELINE_NEED_CATEGORY_IDS.map((id) => {
    const definition = declared[id];
    if (definition === undefined || definition.id !== id) {
      throw new Error(`DefinitionRegistry.needCategories is missing canonical category ${id}`);
    }
    requireNonNegative(`NeedCategory ${id} perCapitaTarget`, definition.perCapitaTarget);
    requireFinite(`NeedCategory ${id} priority`, definition.priority);
    requireNonNegative(`NeedCategory ${id} inventoryCarryoverTicks`, definition.inventoryCarryoverTicks);
    if (definition.substitutionGoods.length === 0) {
      throw new Error(`NeedCategory ${id} must declare at least one substitution good`);
    }

    const seenGoods = new Set<GoodId>();
    const candidates = stableOrderBy(definition.substitutionGoods, (candidate) => String(candidate.goodId)).map((candidate) => {
      if (seenGoods.has(candidate.goodId)) {
        throw new Error(`NeedCategory ${id} declares duplicate substitution good ${String(candidate.goodId)}`);
      }
      seenGoods.add(candidate.goodId);
      const good = world.definitionRegistry.goods[candidate.goodId];
      if (good === undefined) {
        throw new Error(`NeedCategory ${id} references unknown good ${String(candidate.goodId)}`);
      }
      return {
        goodId: candidate.goodId,
        qualityFactor: requirePositive(
          `NeedCategory ${id} ${String(candidate.goodId)} qualityFactor`,
          candidate.qualityFactor,
        ),
        spoilageRatePerTick: requireUnitInterval(
          `GoodDefinition ${String(candidate.goodId)} spoilageRatePerTick`,
          good.spoilageRatePerTick,
        ),
      };
    });
    return { definition, candidates };
  });

  return [...categories].sort(
    (left, right) =>
      right.definition.priority - left.definition.priority ||
      left.definition.id.localeCompare(right.definition.id),
  );
}

function resolveRegionIdForCohort(world: WorldState, cohort: CohortState): RegionId {
  const matches = stableOrderBy(
    [...world.regions.values()].filter((region) => region.seed.key === cohort.seed.regionKey),
    (region) => String(region.regionId),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Cohort ${String(cohort.cohortId)} regionKey ${cohort.seed.regionKey} must resolve exactly once, got ${matches.length}`,
    );
  }
  return matches[0]!.regionId;
}

/**
 * Project the household's post-Phase-8 physical stock without performing market settlement.
 * The persistence transition later checks that canonical settlement actually produced this
 * stock before Phase-9 losses are allowed to commit.
 */
function projectPostMarketInventory(
  cohort: CohortState,
  allocations: readonly MarketAllocation[],
): Map<GoodId, number> {
  const projected = new Map<GoodId, number>();
  for (const [goodId, quantity] of stableOrderBy([...cohort.householdInventory.entries()], ([id]) => String(id))) {
    projected.set(
      goodId,
      requireNonNegative(`Cohort ${String(cohort.cohortId)} householdInventory ${String(goodId)}`, quantity),
    );
  }

  for (const allocation of stableOrderBy(allocations, (item) => String(item.id))) {
    if (allocation.pass !== "MAIN") continue;
    const quantity = requireNonNegative(`MarketAllocation ${String(allocation.id)} quantity`, allocation.quantity);
    if (allocation.seller.type === "COHORT" && allocation.seller.cohortId === cohort.cohortId && quantity > 0) {
      throw new Error(
        `MarketAllocation ${String(allocation.id)} attempts household resale from Cohort ${String(cohort.cohortId)}; ` +
          "REQ-POPULATION-003 forbids a household resale loop",
      );
    }
    if (allocation.buyer.type !== "COHORT" || allocation.buyer.cohortId !== cohort.cohortId || quantity === 0) {
      continue;
    }
    if (allocation.buyerInventoryBucket !== "GENERAL") {
      throw new Error(
        `MarketAllocation ${String(allocation.id)} buyer Cohort ${String(cohort.cohortId)} must settle to GENERAL/householdInventory`,
      );
    }
    addQuantity(projected, allocation.goodId, quantity);
  }
  return projected;
}

function buildEconomicEvidence(args: {
  readonly world: WorldState;
  readonly cohort: CohortState;
  readonly tick: number;
  readonly laborSupplyPlans: readonly LaborSupplyPlan[];
  readonly laborAllocations: readonly LaborAllocation[];
  readonly wageSettlements: readonly WageSettlement[];
  readonly transactions: readonly EconomicTransaction[];
  readonly controls: ResolvedControls;
}): HouseholdEconomicEvidence {
  const { cohort, tick, controls } = args;
  const regionId = resolveRegionIdForCohort(args.world, cohort);
  const supply = args.laborSupplyPlans.filter((plan) => plan.cohortId === cohort.cohortId);
  const allocations = stableOrderBy(
    args.laborAllocations.filter((allocation) => allocation.cohortId === cohort.cohortId),
    (allocation) => allocation.allocationId,
  );

  // REQ-POPULATION-002 deliberately emits no normal LaborSupplyPlan for CHILD/ELDER
  // cohorts. Phase 9 still consumes their household inventory, so their economic
  // evidence is the explicit zero-employment case rather than a missing-plan error.
  // Any labor/wage artifact against a non-WORKING cohort is contradictory evidence.
  if (cohort.seed.ageBand !== "WORKING") {
    const settlements = args.wageSettlements.filter((settlement) => settlement.cohortId === cohort.cohortId);
    const wageTransactions = args.transactions.filter(
      (transaction) =>
        transaction.type === "WAGE_PAYMENT" &&
        transaction.destination?.type === "COHORT" &&
        transaction.destination.cohortId === cohort.cohortId,
    );
    if (supply.length !== 0 || allocations.length !== 0 || settlements.length !== 0 || wageTransactions.length !== 0) {
      throw new Error(
        `Non-WORKING Cohort ${String(cohort.cohortId)} must not have LaborSupplyPlan, LaborAllocation, WageSettlement, or WAGE_PAYMENT evidence`,
      );
    }
    return {
      cohortId: cohort.cohortId,
      availableWorkerEquivalents: 0,
      employedWorkerEquivalents: 0,
      employmentRate: 0,
      grossWageIncome: 0,
      netWageReceipt: 0,
      wageTaxWithheld: 0,
    };
  }

  if (supply.length !== 1) {
    throw new Error(`Cohort ${String(cohort.cohortId)} must have exactly one current LaborSupplyPlan, got ${supply.length}`);
  }
  const supplyPlan = supply[0]!;
  const expectedSupplyPlanId = `labor-supply:${tick}:${String(cohort.cohortId)}`;
  if (supplyPlan.planId !== expectedSupplyPlanId) {
    throw new Error(
      `LaborSupplyPlan ${supplyPlan.planId} is not the canonical current plan ${expectedSupplyPlanId}`,
    );
  }
  if (supplyPlan.regionId !== regionId) {
    throw new Error(`LaborSupplyPlan ${supplyPlan.planId} region does not match Cohort ${String(cohort.cohortId)}`);
  }
  if (supplyPlan.laborCategory !== cohort.seed.laborCategory) {
    throw new Error(
      `LaborSupplyPlan ${supplyPlan.planId} labor category does not match Cohort ${String(cohort.cohortId)}`,
    );
  }
  const availableWorkerEquivalents = requireNonNegative(
    `LaborSupplyPlan ${supplyPlan.planId} availableWorkerEquivalents`,
    supplyPlan.availableWorkerEquivalents,
  );
  const allocationIds = new Set<string>();
  let employedWorkerEquivalents = 0;
  let grossWageIncome = 0;
  for (const allocation of allocations) {
    if (allocationIds.has(allocation.allocationId)) {
      throw new Error(`Duplicate LaborAllocation ${allocation.allocationId} for Cohort ${String(cohort.cohortId)}`);
    }
    allocationIds.add(allocation.allocationId);
    if (allocation.tick !== tick || allocation.regionId !== regionId) {
      throw new Error(`LaborAllocation ${allocation.allocationId} tick/region provenance mismatch`);
    }
    if (allocation.laborCategory !== supplyPlan.laborCategory) {
      throw new Error(
        `LaborAllocation ${allocation.allocationId} labor category does not match LaborSupplyPlan ${supplyPlan.planId}`,
      );
    }
    employedWorkerEquivalents += requireNonNegative(
      `LaborAllocation ${allocation.allocationId} workerEquivalents`,
      allocation.workerEquivalents,
    );
    grossWageIncome += requireNonNegative(
      `LaborAllocation ${allocation.allocationId} grossWageObligation`,
      allocation.grossWageObligation,
    );
  }
  if (employedWorkerEquivalents > availableWorkerEquivalents + controls.quantityEpsilon) {
    throw new Error(`Cohort ${String(cohort.cohortId)} employed workers exceed available workers`);
  }

  const settlements = stableOrderBy(
    args.wageSettlements.filter((settlement) => settlement.cohortId === cohort.cohortId),
    (settlement) => settlement.allocationId,
  );
  const settlementByAllocation = new Map<string, WageSettlement>();
  for (const settlement of settlements) {
    if (settlement.tick !== tick || settlement.regionId !== regionId) {
      throw new Error(`WageSettlement ${settlement.settlementId} tick/region provenance mismatch`);
    }
    if (settlementByAllocation.has(settlement.allocationId)) {
      throw new Error(`Duplicate WageSettlement for allocation ${settlement.allocationId}`);
    }
    settlementByAllocation.set(settlement.allocationId, settlement);
  }
  if (settlementByAllocation.size !== allocationIds.size) {
    throw new Error(`Cohort ${String(cohort.cohortId)} wage settlements do not match its Phase-3 allocations`);
  }

  let settlementGross = 0;
  let settlementNet = 0;
  let settlementTax = 0;
  let transactionNet = 0;
  for (const allocation of allocations) {
    const settlement = settlementByAllocation.get(allocation.allocationId);
    if (settlement === undefined) {
      throw new Error(`Missing WageSettlement for LaborAllocation ${allocation.allocationId}`);
    }
    const gross = requireNonNegative(`WageSettlement ${settlement.settlementId} grossWage`, settlement.grossWage);
    const net = requireNonNegative(`WageSettlement ${settlement.settlementId} netWage`, settlement.netWage);
    const tax = requireNonNegative(`WageSettlement ${settlement.settlementId} collectedTax`, settlement.collectedTax);
    if (Math.abs(gross - allocation.grossWageObligation) > controls.moneyEpsilon) {
      throw new Error(`WageSettlement ${settlement.settlementId} gross wage does not match Phase-3 obligation`);
    }
    if (Math.abs(gross - (net + tax)) > controls.moneyEpsilon) {
      throw new Error(`WageSettlement ${settlement.settlementId} violates gross = net + collected tax`);
    }

    const matchingTransactions = args.transactions.filter(
      (transaction) => transaction.transactionId === settlement.wagePaymentTransaction.transactionId,
    );
    if (matchingTransactions.length !== 1) {
      throw new Error(
        `WageSettlement ${settlement.settlementId} must have exactly one matching WAGE_PAYMENT transaction, got ${matchingTransactions.length}`,
      );
    }
    const canonicalPayment = settlement.wagePaymentTransaction;
    if (
      canonicalPayment.type !== "WAGE_PAYMENT" ||
      canonicalPayment.tick !== settlement.tick ||
      canonicalPayment.phase !== 5 ||
      canonicalPayment.bundleId !== settlement.bundleId ||
      canonicalPayment.source?.type !== "PRODUCTION_UNIT" ||
      canonicalPayment.source.productionUnitId !== settlement.unitId ||
      canonicalPayment.destination?.type !== "COHORT" ||
      canonicalPayment.destination.cohortId !== settlement.cohortId ||
      canonicalPayment.currencyId !== settlement.currencyId ||
      canonicalPayment.sourceRegionId !== settlement.regionId ||
      canonicalPayment.destinationRegionId !== settlement.regionId ||
      canonicalPayment.reason !== settlement.allocationId
    ) {
      throw new Error(`WageSettlement ${settlement.settlementId} canonical WAGE_PAYMENT provenance mismatch`);
    }

    const transaction = matchingTransactions[0]!;
    if (
      transaction.type !== "WAGE_PAYMENT" ||
      transaction.tick !== settlement.tick ||
      transaction.phase !== 5 ||
      transaction.bundleId !== settlement.bundleId ||
      transaction.source?.type !== "PRODUCTION_UNIT" ||
      transaction.source.productionUnitId !== settlement.unitId ||
      transaction.destination?.type !== "COHORT" ||
      transaction.destination.cohortId !== settlement.cohortId ||
      transaction.currencyId !== settlement.currencyId ||
      transaction.sourceRegionId !== settlement.regionId ||
      transaction.destinationRegionId !== settlement.regionId ||
      transaction.reason !== settlement.allocationId
    ) {
      throw new Error(`WAGE_PAYMENT ${String(transaction.transactionId)} provenance mismatch`);
    }
    const canonicalTransactionAmount = requireNonNegative(
      `canonical WAGE_PAYMENT ${String(canonicalPayment.transactionId)} moneyAmount`,
      canonicalPayment.moneyAmount ?? Number.NaN,
    );
    const canonicalTransactionGross = requireNonNegative(
      `canonical WAGE_PAYMENT ${String(canonicalPayment.transactionId)} grossMoneyAmount`,
      canonicalPayment.grossMoneyAmount,
    );
    const canonicalAssessedTax = requireNonNegative(
      `canonical WAGE_PAYMENT ${String(canonicalPayment.transactionId)} assessedTaxAmount`,
      canonicalPayment.assessedTaxAmount,
    );
    const canonicalTransactionTax = requireNonNegative(
      `canonical WAGE_PAYMENT ${String(canonicalPayment.transactionId)} taxAmount`,
      canonicalPayment.taxAmount ?? Number.NaN,
    );
    const canonicalRecordedAmount = requireNonNegative(
      `canonical WAGE_PAYMENT ${String(canonicalPayment.transactionId)} amount`,
      canonicalPayment.amount,
    );
    if (
      Math.abs(canonicalTransactionAmount - net) > controls.moneyEpsilon ||
      Math.abs(canonicalTransactionGross - gross) > controls.moneyEpsilon ||
      Math.abs(canonicalAssessedTax - settlement.assessedTax) > controls.moneyEpsilon ||
      Math.abs(canonicalTransactionTax - tax) > controls.moneyEpsilon ||
      Math.abs(canonicalRecordedAmount - net) > controls.moneyEpsilon
    ) {
      throw new Error(`WageSettlement ${settlement.settlementId} canonical WAGE_PAYMENT does not match settlement evidence`);
    }

    const transactionAmount = requireNonNegative(
      `WAGE_PAYMENT ${String(transaction.transactionId)} moneyAmount`,
      transaction.moneyAmount ?? Number.NaN,
    );
    const transactionGross = requireNonNegative(
      `WAGE_PAYMENT ${String(transaction.transactionId)} grossMoneyAmount`,
      transaction.grossMoneyAmount ?? Number.NaN,
    );
    const transactionAssessedTax = requireNonNegative(
      `WAGE_PAYMENT ${String(transaction.transactionId)} assessedTaxAmount`,
      transaction.assessedTaxAmount ?? Number.NaN,
    );
    const transactionTax = requireNonNegative(
      `WAGE_PAYMENT ${String(transaction.transactionId)} taxAmount`,
      transaction.taxAmount ?? Number.NaN,
    );
    const transactionRecordedAmount = requireNonNegative(
      `WAGE_PAYMENT ${String(transaction.transactionId)} amount`,
      transaction.amount,
    );
    if (
      Math.abs(transactionAmount - canonicalTransactionAmount) > controls.moneyEpsilon ||
      Math.abs(transactionGross - canonicalTransactionGross) > controls.moneyEpsilon ||
      Math.abs(transactionAssessedTax - canonicalAssessedTax) > controls.moneyEpsilon ||
      Math.abs(transactionTax - canonicalTransactionTax) > controls.moneyEpsilon ||
      Math.abs(transactionRecordedAmount - canonicalRecordedAmount) > controls.moneyEpsilon
    ) {
      throw new Error(`WAGE_PAYMENT ${String(transaction.transactionId)} does not match Phase-5 settlement evidence`);
    }

    settlementGross += gross;
    settlementNet += net;
    settlementTax += tax;
    transactionNet += transactionAmount;
  }

  if (Math.abs(settlementGross - grossWageIncome) > controls.moneyEpsilon) {
    throw new Error(`Cohort ${String(cohort.cohortId)} gross wage evidence does not reconcile to Phase-3 allocations`);
  }
  if (Math.abs(transactionNet - settlementNet) > controls.moneyEpsilon) {
    throw new Error(`Cohort ${String(cohort.cohortId)} net wage receipt does not reconcile to Phase-5 transaction evidence`);
  }
  if (Math.abs((grossWageIncome - transactionNet) - settlementTax) > controls.moneyEpsilon) {
    throw new Error(`Cohort ${String(cohort.cohortId)} wage withholding does not reconcile to Phase-5 settlement evidence`);
  }

  const employmentRate = availableWorkerEquivalents <= controls.quantityEpsilon
    ? 0
    : Math.min(1, Math.max(0, employedWorkerEquivalents / availableWorkerEquivalents));

  return {
    cohortId: cohort.cohortId,
    availableWorkerEquivalents,
    employedWorkerEquivalents,
    employmentRate,
    grossWageIncome,
    netWageReceipt: transactionNet,
    wageTaxWithheld: grossWageIncome - transactionNet,
  };
}

function consumeCategory(args: {
  readonly cohortId: CohortId;
  readonly runtime: CategoryRuntime;
  readonly population: number;
  readonly workingInventory: Map<GoodId, number>;
  readonly quantityEpsilon: number;
}): { readonly required: number; readonly realized: number; readonly coverage: number; readonly consumed: Map<GoodId, number> } {
  const required = requireNonNegative(
    `NeedCategory ${args.runtime.definition.id} required useful consumption`,
    args.population * args.runtime.definition.perCapitaTarget,
  );
  const usefulAvailable = args.runtime.candidates.reduce(
    (sum, candidate) =>
      sum + requireNonNegative(
        `Cohort ${String(args.cohortId)} ${String(candidate.goodId)} working inventory`,
        args.workingInventory.get(candidate.goodId) ?? 0,
      ) * candidate.qualityFactor,
    0,
  );
  const usefulTarget = Math.min(required, usefulAvailable);
  const scale = usefulAvailable <= args.quantityEpsilon ? 0 : usefulTarget / usefulAvailable;
  const consumed = new Map<GoodId, number>();
  let realized = 0;

  for (const candidate of args.runtime.candidates) {
    const available = requireNonNegative(
      `Cohort ${String(args.cohortId)} ${String(candidate.goodId)} working inventory`,
      args.workingInventory.get(candidate.goodId) ?? 0,
    );
    const physical = Math.min(available, Math.max(0, available * scale));
    if (physical > args.quantityEpsilon) {
      consumed.set(candidate.goodId, physical);
      args.workingInventory.set(candidate.goodId, Math.max(0, available - physical));
      realized += physical * candidate.qualityFactor;
    }
  }

  const coverage = Math.min(1, realized / Math.max(required, args.quantityEpsilon));
  requireUnitInterval(`NeedCategory ${args.runtime.definition.id} coverage`, coverage);
  return { required, realized, coverage, consumed };
}

function spoilExcessCarryover(args: {
  readonly cohortId: CohortId;
  readonly runtime: CategoryRuntime;
  readonly required: number;
  readonly workingInventory: Map<GoodId, number>;
  readonly claimedGoods: Set<GoodId>;
  readonly quantityEpsilon: number;
}): Map<GoodId, number> {
  const candidates = args.runtime.candidates.filter((candidate) => !args.claimedGoods.has(candidate.goodId));
  for (const candidate of candidates) args.claimedGoods.add(candidate.goodId);

  const maxCarryoverUseful = requireNonNegative(
    `NeedCategory ${args.runtime.definition.id} max useful carryover`,
    args.required * args.runtime.definition.inventoryCarryoverTicks,
  );
  const totalUseful = candidates.reduce(
    (sum, candidate) => sum + (args.workingInventory.get(candidate.goodId) ?? 0) * candidate.qualityFactor,
    0,
  );
  const excessUseful = Math.max(0, totalUseful - maxCarryoverUseful);
  if (excessUseful <= args.quantityEpsilon) return new Map();

  const perishable = candidates.filter((candidate) => candidate.spoilageRatePerTick > 0);
  const perishableUseful = perishable.reduce(
    (sum, candidate) => sum + (args.workingInventory.get(candidate.goodId) ?? 0) * candidate.qualityFactor,
    0,
  );
  const spoilUseful = Math.min(excessUseful, perishableUseful);
  if (spoilUseful <= args.quantityEpsilon || perishableUseful <= args.quantityEpsilon) return new Map();

  const scale = spoilUseful / perishableUseful;
  const spoiled = new Map<GoodId, number>();
  for (const candidate of perishable) {
    const available = requireNonNegative(
      `Cohort ${String(args.cohortId)} ${String(candidate.goodId)} carryover inventory`,
      args.workingInventory.get(candidate.goodId) ?? 0,
    );
    const physical = Math.min(available, Math.max(0, available * scale));
    if (physical <= args.quantityEpsilon) continue;
    spoiled.set(candidate.goodId, physical);
    args.workingInventory.set(candidate.goodId, Math.max(0, available - physical));
  }
  return spoiled;
}

function lossEvidence(args: {
  readonly tick: number;
  readonly cohortId: CohortId;
  readonly categoryId: string;
  readonly kind: "CONSUMPTION" | "SPOILAGE";
  readonly quantities: ReadonlyMap<GoodId, number>;
}): { readonly transactions: EconomicTransaction[]; readonly losses: PhysicalLossRecord[] } {
  const transactions: EconomicTransaction[] = [];
  const losses: PhysicalLossRecord[] = [];
  for (const [goodId, quantity] of stableOrderBy([...args.quantities.entries()], ([id]) => String(id))) {
    if (quantity <= 0) continue;
    const type = args.kind === "CONSUMPTION" ? "HOUSEHOLD_CONSUMPTION" : "HOUSEHOLD_SPOILAGE";
    transactions.push({
      tick: args.tick,
      phase: 9,
      type,
      transactionId: createTransactionId(
        `tx:${args.tick}:9:${type.toLowerCase()}:${String(args.cohortId)}:${args.categoryId}:${String(goodId)}`,
      ),
      source: { type: "COHORT", cohortId: args.cohortId },
      goodId,
      quantity,
      amount: quantity,
      reason: args.categoryId,
    });
    losses.push({
      tick: args.tick,
      phase: 9,
      type: "PHYSICAL_LOSS",
      resourceType: "good",
      resourceId: String(goodId),
      locationKey: args.cohortId,
      amount: quantity,
      cause: args.kind === "CONSUMPTION" ? "consumption" : "spoilage",
      reason: `${type}:${args.categoryId}`,
      causalPhase: 9,
    });
  }
  return { transactions, losses };
}

/** Plan complete Phase-9 population evidence without mutating WorldState. */
export function planHouseholdConsumptionPhase9(input: HouseholdConsumptionPhase9Input): HouseholdConsumptionExecutionResult {
  if (!Number.isInteger(input.tick) || input.tick < 0) {
    throw new Error(`Phase-9 household consumption tick must be a non-negative integer, got ${String(input.tick)}`);
  }
  const controls = resolveControls(input.world);
  const categories = resolveCategories(input.world);
  const executions: HouseholdConsumptionExecution[] = [];
  const transactions: EconomicTransaction[] = [];
  const physicalLosses: PhysicalLossRecord[] = [];

  for (const cohort of stableOrderBy([...input.world.cohorts.values()], (item) => String(item.cohortId))) {
    const population = requireNonNegative(`Cohort ${String(cohort.cohortId)} population`, cohort.seed.population);
    if (population === 0) continue;

    const workingInventory = projectPostMarketInventory(cohort, input.marketAllocations);
    const postMarketInventoryByGood = toOrderedRecord(workingInventory);
    const economic = buildEconomicEvidence({
      world: input.world,
      cohort,
      tick: input.tick,
      laborSupplyPlans: input.laborSupplyPlans,
      laborAllocations: input.laborAllocations,
      wageSettlements: input.wageSettlements,
      transactions: input.transactions,
      controls,
    });

    const categoryWork: {
      runtime: CategoryRuntime;
      required: number;
      realized: number;
      coverage: number;
      consumed: Map<GoodId, number>;
      spoiled: Map<GoodId, number>;
    }[] = [];
    for (const runtime of categories) {
      const consumed = consumeCategory({
        cohortId: cohort.cohortId,
        runtime,
        population,
        workingInventory,
        quantityEpsilon: controls.quantityEpsilon,
      });
      categoryWork.push({ runtime, ...consumed, spoiled: new Map() });
    }

    // A good eligible for several need categories gets one carryover owner, chosen by the
    // same deterministic category priority used for consumption. This prevents the same
    // remaining physical stock from being assessed against multiple carryover caps.
    const claimedCarryoverGoods = new Set<GoodId>();
    for (const item of categoryWork) {
      item.spoiled = spoilExcessCarryover({
        cohortId: cohort.cohortId,
        runtime: item.runtime,
        required: item.required,
        workingInventory,
        claimedGoods: claimedCarryoverGoods,
        quantityEpsilon: controls.quantityEpsilon,
      });
    }

    const consumedByGood = new Map<GoodId, number>();
    const spoiledByGood = new Map<GoodId, number>();
    const realizedCategories: HouseholdNeedRealization[] = [];
    for (const item of categoryWork) {
      for (const [goodId, quantity] of item.consumed) addQuantity(consumedByGood, goodId, quantity);
      for (const [goodId, quantity] of item.spoiled) addQuantity(spoiledByGood, goodId, quantity);
      realizedCategories.push({
        categoryId: item.runtime.definition.id,
        requiredUsefulConsumption: item.required,
        realizedUsefulConsumption: item.realized,
        coverage: item.coverage,
        consumedByGood: toOrderedRecord(item.consumed),
        spoiledByGood: toOrderedRecord(item.spoiled),
      });
      const consumptionEvidence = lossEvidence({
        tick: input.tick,
        cohortId: cohort.cohortId,
        categoryId: item.runtime.definition.id,
        kind: "CONSUMPTION",
        quantities: item.consumed,
      });
      transactions.push(...consumptionEvidence.transactions);
      physicalLosses.push(...consumptionEvidence.losses);
      const spoilageEvidence = lossEvidence({
        tick: input.tick,
        cohortId: cohort.cohortId,
        categoryId: item.runtime.definition.id,
        kind: "SPOILAGE",
        quantities: item.spoiled,
      });
      transactions.push(...spoilageEvidence.transactions);
      physicalLosses.push(...spoilageEvidence.losses);
    }

    const coverageByCategory = new Map(realizedCategories.map((category) => [category.categoryId, category.coverage]));
    const foodCoverage = coverageByCategory.get("ESSENTIAL_FOOD") ?? 0;
    const basicCoverage = coverageByCategory.get("BASIC_GOODS") ?? 0;
    const essentialCoverage = Math.min(foodCoverage, 0.5 * foodCoverage + 0.5 * basicCoverage);
    requireUnitInterval(`Cohort ${String(cohort.cohortId)} essentialCoverage`, essentialCoverage);

    executions.push({
      tick: input.tick,
      cohortId: cohort.cohortId,
      postMarketInventoryByGood,
      endingInventoryByGood: toOrderedRecord(workingInventory),
      categories: realizedCategories,
      essentialCoverage,
      consumedByGood: toOrderedRecord(consumedByGood),
      spoiledByGood: toOrderedRecord(spoiledByGood),
      economic,
    });
  }

  return { executions, transactions, physicalLosses };
}

interface CanonicalHouseholdLossRealization {
  readonly categories: readonly HouseholdNeedRealization[];
  readonly essentialCoverage: number;
  readonly consumedByGood: Readonly<Record<GoodId, number>>;
  readonly spoiledByGood: Readonly<Record<GoodId, number>>;
  readonly endingInventoryByGood: Readonly<Record<GoodId, number>>;
}

function recomputeCanonicalHouseholdLossRealization(
  world: WorldState,
  cohort: CohortState,
  quantityEpsilon: number,
): CanonicalHouseholdLossRealization {
  const population = requireNonNegative(`Cohort ${String(cohort.cohortId)} population`, cohort.seed.population);
  const workingInventory = new Map<GoodId, number>();
  for (const [goodId, quantity] of stableOrderBy([...cohort.householdInventory.entries()], ([id]) => String(id))) {
    workingInventory.set(
      goodId,
      requireNonNegative(`Cohort ${String(cohort.cohortId)} settled householdInventory ${String(goodId)}`, quantity),
    );
  }

  const categoryWork: {
    runtime: CategoryRuntime;
    required: number;
    realized: number;
    coverage: number;
    consumed: Map<GoodId, number>;
    spoiled: Map<GoodId, number>;
  }[] = [];
  for (const runtime of resolveCategories(world)) {
    const consumed = consumeCategory({
      cohortId: cohort.cohortId,
      runtime,
      population,
      workingInventory,
      quantityEpsilon,
    });
    categoryWork.push({ runtime, ...consumed, spoiled: new Map() });
  }

  const claimedCarryoverGoods = new Set<GoodId>();
  for (const item of categoryWork) {
    item.spoiled = spoilExcessCarryover({
      cohortId: cohort.cohortId,
      runtime: item.runtime,
      required: item.required,
      workingInventory,
      claimedGoods: claimedCarryoverGoods,
      quantityEpsilon,
    });
  }

  const consumedByGood = new Map<GoodId, number>();
  const spoiledByGood = new Map<GoodId, number>();
  const realizedCategories: HouseholdNeedRealization[] = [];
  for (const item of categoryWork) {
    for (const [goodId, quantity] of item.consumed) addQuantity(consumedByGood, goodId, quantity);
    for (const [goodId, quantity] of item.spoiled) addQuantity(spoiledByGood, goodId, quantity);
    realizedCategories.push({
      categoryId: item.runtime.definition.id,
      requiredUsefulConsumption: item.required,
      realizedUsefulConsumption: item.realized,
      coverage: item.coverage,
      consumedByGood: toOrderedRecord(item.consumed),
      spoiledByGood: toOrderedRecord(item.spoiled),
    });
  }

  const coverageByCategory = new Map(realizedCategories.map((category) => [category.categoryId, category.coverage]));
  const foodCoverage = coverageByCategory.get("ESSENTIAL_FOOD") ?? 0;
  const basicCoverage = coverageByCategory.get("BASIC_GOODS") ?? 0;
  const essentialCoverage = Math.min(foodCoverage, 0.5 * foodCoverage + 0.5 * basicCoverage);
  requireUnitInterval(`Cohort ${String(cohort.cohortId)} essentialCoverage`, essentialCoverage);

  return {
    categories: realizedCategories,
    essentialCoverage,
    consumedByGood: toOrderedRecord(consumedByGood),
    spoiledByGood: toOrderedRecord(spoiledByGood),
    endingInventoryByGood: toOrderedRecord(workingInventory),
  };
}

function assertCanonicalQuantityRecord(
  label: string,
  submitted: Readonly<Record<GoodId, number>>,
  canonical: Readonly<Record<GoodId, number>>,
  quantityEpsilon: number,
): void {
  const submittedMap = new Map(Object.entries(submitted) as [GoodId, number][]);
  const canonicalMap = new Map(Object.entries(canonical) as [GoodId, number][]);
  const keys = new Set<GoodId>([...submittedMap.keys(), ...canonicalMap.keys()]);
  for (const goodId of stableOrderBy([...keys], String)) {
    const actual = requireNonNegative(`${label} ${String(goodId)}`, submittedMap.get(goodId) ?? 0);
    const expected = requireNonNegative(
      `canonical ${label} ${String(goodId)}`,
      canonicalMap.get(goodId) ?? 0,
    );
    if (Math.abs(actual - expected) > quantityEpsilon) {
      throw new Error(
        `${label} for ${String(goodId)} does not match canonical Phase-9 need realization: actual=${actual} expected=${expected}`,
      );
    }
  }
}

function validateHouseholdLossAuthority(
  world: WorldState,
  cohort: CohortState,
  execution: HouseholdConsumptionExecution,
  quantityEpsilon: number,
): void {
  const canonical = recomputeCanonicalHouseholdLossRealization(world, cohort, quantityEpsilon);
  if (execution.categories.length !== canonical.categories.length) {
    throw new Error(
      `Cohort ${String(cohort.cohortId)} Phase-9 category count does not match canonical Phase-9 need realization`,
    );
  }

  for (let index = 0; index < canonical.categories.length; index += 1) {
    const submitted = execution.categories[index]!;
    const expected = canonical.categories[index]!;
    if (submitted.categoryId !== expected.categoryId) {
      throw new Error(
        `Cohort ${String(cohort.cohortId)} Phase-9 category order does not match canonical Phase-9 need realization`,
      );
    }
    const numericEvidence: readonly [string, number, number][] = [
      ["requiredUsefulConsumption", submitted.requiredUsefulConsumption, expected.requiredUsefulConsumption],
      ["realizedUsefulConsumption", submitted.realizedUsefulConsumption, expected.realizedUsefulConsumption],
      ["coverage", submitted.coverage, expected.coverage],
    ];
    for (const [field, actual, expectedValue] of numericEvidence) {
      requireNonNegative(`HouseholdNeedRealization ${submitted.categoryId} ${field}`, actual);
      if (Math.abs(actual - expectedValue) > quantityEpsilon) {
        throw new Error(
          `HouseholdNeedRealization ${submitted.categoryId} ${field} does not match canonical Phase-9 need realization`,
        );
      }
    }
    assertCanonicalQuantityRecord(
      `HouseholdNeedRealization ${submitted.categoryId} consumedByGood`,
      submitted.consumedByGood,
      expected.consumedByGood,
      quantityEpsilon,
    );
    assertCanonicalQuantityRecord(
      `HouseholdNeedRealization ${submitted.categoryId} spoiledByGood`,
      submitted.spoiledByGood,
      expected.spoiledByGood,
      quantityEpsilon,
    );
  }

  requireUnitInterval(`Cohort ${String(cohort.cohortId)} submitted essentialCoverage`, execution.essentialCoverage);
  if (Math.abs(execution.essentialCoverage - canonical.essentialCoverage) > quantityEpsilon) {
    throw new Error(
      `Cohort ${String(cohort.cohortId)} essentialCoverage does not match canonical Phase-9 need realization`,
    );
  }
  assertCanonicalQuantityRecord(
    `Cohort ${String(cohort.cohortId)} consumedByGood`,
    execution.consumedByGood,
    canonical.consumedByGood,
    quantityEpsilon,
  );
  assertCanonicalQuantityRecord(
    `Cohort ${String(cohort.cohortId)} spoiledByGood`,
    execution.spoiledByGood,
    canonical.spoiledByGood,
    quantityEpsilon,
  );
  assertCanonicalQuantityRecord(
    `Cohort ${String(cohort.cohortId)} endingInventoryByGood`,
    execution.endingInventoryByGood,
    canonical.endingInventoryByGood,
    quantityEpsilon,
  );
}

/**
 * Persist Phase-9 household losses after canonical Phase-8 settlement has been applied.
 * The declared projected opening inventory is checked exactly (within quantity epsilon),
 * so calling this transition against an un-settled opening WorldState fails rather than
 * re-crediting purchases or creating a second settlement path.
 */
export function applyHouseholdConsumptionTransition(
  worldAfterMarketSettlement: WorldState,
  executions: readonly HouseholdConsumptionExecution[],
  currentTick: number,
): WorldState {
  if (!Number.isInteger(currentTick) || currentTick < 0) {
    throw new Error(`Phase-9 household transition tick must be a non-negative integer, got ${String(currentTick)}`);
  }
  const lastAppliedTick = worldAfterMarketSettlement.lastHouseholdConsumptionTransitionTick ?? -1;
  if (!Number.isInteger(lastAppliedTick) || lastAppliedTick < -1) {
    throw new Error(
      `WorldState.lastHouseholdConsumptionTransitionTick must be an integer >= -1, got ${String(lastAppliedTick)}`,
    );
  }
  if (lastAppliedTick >= currentTick) {
    throw new Error(
      `Phase-9 household transition for tick ${currentTick} cannot persist after tick ${lastAppliedTick}; each canonical tick may persist Phase 9 once`,
    );
  }

  const requiredCohortIds = stableOrderBy(
    [...worldAfterMarketSettlement.cohorts.values()]
      .filter(
        (cohort) =>
          requireNonNegative(`Cohort ${String(cohort.cohortId)} population`, cohort.seed.population) > 0,
      )
      .map((cohort) => cohort.cohortId),
    String,
  );
  const requiredCohortSet = new Set(requiredCohortIds);
  const executionByCohort = new Map<CohortId, HouseholdConsumptionExecution>();
  for (const execution of executions) {
    if (execution.tick !== currentTick) {
      throw new Error(
        `HouseholdConsumptionExecution for Cohort ${String(execution.cohortId)} execution tick ${execution.tick} does not match authoritative tick ${currentTick}`,
      );
    }
    if (executionByCohort.has(execution.cohortId)) {
      throw new Error(`Duplicate HouseholdConsumptionExecution for Cohort ${String(execution.cohortId)}`);
    }
    const cohort = worldAfterMarketSettlement.cohorts.get(execution.cohortId);
    if (cohort === undefined) {
      throw new Error(`HouseholdConsumptionExecution references unknown Cohort ${String(execution.cohortId)}`);
    }
    if (!requiredCohortSet.has(execution.cohortId)) {
      throw new Error(
        `HouseholdConsumptionExecution references non-positive-population Cohort ${String(execution.cohortId)}`,
      );
    }
    executionByCohort.set(execution.cohortId, execution);
  }
  if (executionByCohort.size !== requiredCohortIds.length) {
    throw new Error(
      `Phase-9 household transition must cover every positive-population Cohort exactly once: expected ${requiredCohortIds.length}, got ${executionByCohort.size}`,
    );
  }
  for (const cohortId of requiredCohortIds) {
    if (!executionByCohort.has(cohortId)) {
      throw new Error(
        `Phase-9 household transition must cover every positive-population Cohort exactly once; missing ${String(cohortId)}`,
      );
    }
  }

  const quantityEpsilon = resolveControls(worldAfterMarketSettlement).quantityEpsilon;
  const cohorts = new Map(worldAfterMarketSettlement.cohorts);

  for (const execution of stableOrderBy(executions, (item) => String(item.cohortId))) {
    const cohort = cohorts.get(execution.cohortId)!;

    const declaredOpening = new Map(
      Object.entries(execution.postMarketInventoryByGood) as [GoodId, number][],
    );
    const keys = new Set<GoodId>([
      ...cohort.householdInventory.keys(),
      ...declaredOpening.keys(),
    ]);
    for (const goodId of stableOrderBy([...keys], String)) {
      const live = requireNonNegative(
        `Cohort ${String(cohort.cohortId)} settled householdInventory ${String(goodId)}`,
        cohort.householdInventory.get(goodId) ?? 0,
      );
      const declared = requireNonNegative(
        `HouseholdConsumptionExecution postMarketInventory ${String(goodId)}`,
        declaredOpening.get(goodId) ?? 0,
      );
      if (Math.abs(live - declared) > quantityEpsilon) {
        throw new Error(
          `Cohort ${String(cohort.cohortId)} Phase-9 transition requires canonical Phase-8 settlement first; ` +
            `${String(goodId)} live=${live} projected=${declared}`,
        );
      }
    }

    const declaredEnding = new Map(
      Object.entries(execution.endingInventoryByGood) as [GoodId, number][],
    );
    const consumed = new Map(
      Object.entries(execution.consumedByGood) as [GoodId, number][],
    );
    const spoiled = new Map(
      Object.entries(execution.spoiledByGood) as [GoodId, number][],
    );
    const deltaKeys = new Set<GoodId>([
      ...declaredOpening.keys(),
      ...declaredEnding.keys(),
      ...consumed.keys(),
      ...spoiled.keys(),
    ]);
    for (const goodId of stableOrderBy([...deltaKeys], String)) {
      const opening = requireNonNegative(
        `HouseholdConsumptionExecution postMarketInventory ${String(goodId)}`,
        declaredOpening.get(goodId) ?? 0,
      );
      const consumedQuantity = requireNonNegative(
        `HouseholdConsumptionExecution consumedByGood ${String(goodId)}`,
        consumed.get(goodId) ?? 0,
      );
      const spoiledQuantity = requireNonNegative(
        `HouseholdConsumptionExecution spoiledByGood ${String(goodId)}`,
        spoiled.get(goodId) ?? 0,
      );
      const endingQuantity = requireNonNegative(
        `HouseholdConsumptionExecution endingInventory ${String(goodId)}`,
        declaredEnding.get(goodId) ?? 0,
      );
      const expectedEnding = opening - consumedQuantity - spoiledQuantity;
      if (expectedEnding < -quantityEpsilon) {
        throw new Error(
          `Cohort ${String(cohort.cohortId)} Phase-9 declared losses exceed settled inventory for ${String(goodId)}: ` +
            `opening=${opening} consumed=${consumedQuantity} spoiled=${spoiledQuantity}`,
        );
      }
      const normalizedExpectedEnding = Math.max(0, expectedEnding);
      if (Math.abs(endingQuantity - normalizedExpectedEnding) > quantityEpsilon) {
        throw new Error(
          `Cohort ${String(cohort.cohortId)} Phase-9 ending inventory does not match declared consumption/spoilage for ` +
            `${String(goodId)}: ending=${endingQuantity} expected=${normalizedExpectedEnding}`,
        );
      }
    }

    validateHouseholdLossAuthority(
      worldAfterMarketSettlement,
      cohort,
      execution,
      quantityEpsilon,
    );

    const ending = new Map<GoodId, number>();
    for (const [goodId, quantity] of stableOrderBy([...declaredEnding.entries()], ([id]) => String(id))) {
      ending.set(goodId, quantity);
    }
    cohorts.set(execution.cohortId, { ...cohort, householdInventory: ending });
  }

  return {
    ...worldAfterMarketSettlement,
    cohorts,
    lastHouseholdConsumptionTransitionTick: currentTick,
  };
}

/** Phase-9 handler: emits execution/economic/loss evidence into TickContext only. */
export function createPhase9HouseholdConsumptionHandler(): PhaseHandler {
  return (world: WorldState, context: TickContext, _pendingTransitions: PendingTransitions): TickContext => {
    if (context.phase !== 9) return context;
    const result = planHouseholdConsumptionPhase9({
      world,
      tick: context.tick,
      marketAllocations: context.marketAllocations,
      laborSupplyPlans: context.laborSupplyPlans ?? [],
      laborAllocations: context.laborAllocations ?? [],
      wageSettlements: context.wageSettlements ?? [],
      transactions: context.transactions,
    });
    let ledger = context.currentLedger;
    for (const loss of result.physicalLosses) ledger = addLedgerRecord(ledger, loss);
    return {
      ...context,
      householdConsumptionExecutions: result.executions,
      transactions: [...context.transactions, ...result.transactions],
      currentLedger: ledger,
    };
  };
}
