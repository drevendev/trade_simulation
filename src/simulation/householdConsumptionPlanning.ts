/**
 * Deterministic Phase-2 household consumption planning (REQ-POPULATION-001).
 *
 * Implements Handoff/06 sections 4-5. Planning is liquidity-first and reads only
 * tick-opening cohort cash plus prior-close local prices. Same-tick wages are not
 * spendable here: wage settlement occurs in Phase 5 and Phase 8 later revalidates
 * affordability against the actual post-wage wallet.
 */

import { BASELINE_NEED_CATEGORY_IDS, type NeedCategoryDefinition } from "../config/definitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CohortId, CurrencyId, GoodId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import {
  commitBudget,
  createMarketIntentId,
  validateMarketIntent,
  type BudgetCommitmentLedger,
  type MarketIntent,
  type MarketIntentId,
} from "./marketIntent";
import { createEmptyBudgetCommitmentLedger } from "./marketIntent";
import type { TaxPolicyProvider } from "./marketSettlement";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import type { CohortState, LocalMarketState, PendingTransitions, RegionState, WorldState } from "./worldState";

const HOUSEHOLD_BUDGET_ENVELOPE = "HOUSEHOLD_CONSUMPTION";

export interface HouseholdSubstitutionShare {
  readonly goodId: GoodId;
  readonly expectedGrossBuyerPrice: number;
  readonly share: number;
}

export interface HouseholdCategoryBudget {
  readonly categoryId: string;
  readonly budget: number;
  readonly targetUsefulConsumption: number;
  readonly intendedUsefulConsumption: number;
  readonly substitutionShares: readonly HouseholdSubstitutionShare[];
}

export interface HouseholdConsumptionPlan {
  readonly planId: string;
  readonly cohortId: CohortId;
  readonly tick: number;
  readonly settlementCurrencyId: CurrencyId;
  readonly openingSpendableCash: number;
  readonly expectedCurrentTickIncome: number;
  readonly liquidityFloor: number;
  readonly planningCashEnvelope: number;
  readonly categoryBudgets: Record<string, number>;
  readonly intendedUsefulConsumption: Record<string, number>;
  readonly categoryDetails: readonly HouseholdCategoryBudget[];
  readonly marketIntentIds: readonly MarketIntentId[];
}

export interface HouseholdConsumptionPlanningResult {
  readonly plans: readonly HouseholdConsumptionPlan[];
  readonly intents: readonly MarketIntent[];
  readonly budgetLedger: BudgetCommitmentLedger;
}

export interface HouseholdConsumptionPlanningOptions {
  readonly startingBudgetLedger?: BudgetCommitmentLedger;
  readonly taxPolicy?: TaxPolicyProvider | undefined;
}

interface ResolvedNeedCategory {
  readonly definition: NeedCategoryDefinition;
  readonly substitutionShares: readonly HouseholdSubstitutionShare[];
  readonly targetUsefulConsumption: number;
  readonly targetCost: number;
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

function resolveHouseholdControls(world: WorldState): {
  readonly minHouseholdCashPerCapita: number;
  readonly liquidityFloorShare: number;
  readonly moneyEpsilon: number;
} {
  const defaults = createDefaultSimulationConfig();
  const minHouseholdCashPerCapita = requireNonNegative(
    "PopulationConfig.minHouseholdCashPerCapita",
    world.simulationConfig.population.minHouseholdCashPerCapita ?? defaults.population.minHouseholdCashPerCapita ?? Number.NaN,
  );
  const liquidityFloorShare = requireNonNegative(
    "PopulationConfig.liquidityFloorShare",
    world.simulationConfig.population.liquidityFloorShare ?? defaults.population.liquidityFloorShare ?? Number.NaN,
  );
  if (liquidityFloorShare > 1) {
    throw new Error(`PopulationConfig.liquidityFloorShare must be in [0, 1], got ${liquidityFloorShare}`);
  }
  const moneyEpsilon = requirePositive(
    "NumericConfig.moneyEpsilon",
    world.simulationConfig.numeric.moneyEpsilon ?? defaults.numeric.moneyEpsilon ?? Number.NaN,
  );
  return { minHouseholdCashPerCapita, liquidityFloorShare, moneyEpsilon };
}

function resolveNeedCategories(world: WorldState): readonly NeedCategoryDefinition[] {
  const categories = world.definitionRegistry.needCategories;
  if (categories === undefined) {
    throw new Error("DefinitionRegistry.needCategories is required for M4 household consumption planning");
  }

  const declaredIds = Object.keys(categories);
  if (declaredIds.length !== BASELINE_NEED_CATEGORY_IDS.length) {
    throw new Error(
      `DefinitionRegistry.needCategories must contain exactly ${BASELINE_NEED_CATEGORY_IDS.join(", ")}`,
    );
  }

  return BASELINE_NEED_CATEGORY_IDS.map((id) => {
    const category = categories[id];
    if (category === undefined || category.id !== id) {
      throw new Error(`DefinitionRegistry.needCategories is missing canonical category ${id}`);
    }
    return category;
  });
}

function resolveRegionForCohort(world: WorldState, cohort: CohortState): RegionState {
  const matches = [...world.regions.values()].filter((region) => region.seed.key === cohort.seed.regionKey);
  if (matches.length !== 1) {
    throw new Error(
      `Cohort ${String(cohort.cohortId)} regionKey ${cohort.seed.regionKey} must resolve to exactly one live RegionState, got ${matches.length}`,
    );
  }
  return matches[0]!;
}

function resolveMarketForRegion(world: WorldState, region: RegionState): LocalMarketState {
  const matches = [...world.markets.values()].filter((market) => market.seed.regionKey === region.seed.key);
  if (matches.length !== 1) {
    throw new Error(
      `Region ${String(region.regionId)} must resolve to exactly one prior-close LocalMarketState, got ${matches.length}`,
    );
  }
  return matches[0]!;
}

function resolveExpectedGrossBuyerPrice(args: {
  readonly region: RegionState;
  readonly goodId: GoodId;
  readonly sellerNetPrice: number;
  readonly moneyEpsilon: number;
  readonly taxPolicy?: TaxPolicyProvider | undefined;
}): number {
  const sellerNetPrice = requireNonNegative(
    `Prior-close price for ${String(args.goodId)}`,
    args.sellerNetPrice,
  );

  if (args.region.controllerStateId === null) {
    return Math.max(sellerNetPrice, args.moneyEpsilon);
  }
  if (args.taxPolicy === undefined) {
    throw new Error(
      `Controlled Region ${String(args.region.regionId)} requires an explicit TaxPolicyProvider for household gross-price planning`,
    );
  }

  const assessedTaxRate = requireNonNegative(
    `Consumption tax rate for ${String(args.goodId)}`,
    args.taxPolicy.getConsumptionTaxRate(args.region.controllerStateId, args.goodId),
  );
  if (assessedTaxRate > 1) {
    throw new Error(`Consumption tax rate for ${String(args.goodId)} must be in [0, 1], got ${assessedTaxRate}`);
  }
  const collectionEfficiency = requireNonNegative(
    `Consumption tax collection efficiency for ${String(args.region.controllerStateId)}`,
    args.taxPolicy.getCollectionEfficiency(args.region.controllerStateId),
  );
  if (collectionEfficiency > 1) {
    throw new Error(
      `Consumption tax collection efficiency for ${String(args.region.controllerStateId)} must be in [0, 1], got ${collectionEfficiency}`,
    );
  }

  // Match Phase-8 semantics exactly: only collected tax is part of buyer gross price.
  const grossPrice = requireNonNegative(
    `Expected gross buyer price for ${String(args.goodId)}`,
    sellerNetPrice * (1 + assessedTaxRate * collectionEfficiency),
  );
  return Math.max(grossPrice, args.moneyEpsilon);
}

function normalizedSubstitutionShares(args: {
  readonly category: NeedCategoryDefinition;
  readonly market: LocalMarketState;
  readonly region: RegionState;
  readonly moneyEpsilon: number;
  readonly taxPolicy?: TaxPolicyProvider | undefined;
}): readonly HouseholdSubstitutionShare[] {
  const { category, market, moneyEpsilon } = args;
  requireNonNegative(`NeedCategory ${category.id} perCapitaTarget`, category.perCapitaTarget);
  requireFinite(`NeedCategory ${category.id} priority`, category.priority);
  requireNonNegative(`NeedCategory ${category.id} priceSensitivity`, category.priceSensitivity);
  if (category.minimumBudgetShare !== undefined) {
    const share = requireNonNegative(`NeedCategory ${category.id} minimumBudgetShare`, category.minimumBudgetShare);
    if (share > 1) throw new Error(`NeedCategory ${category.id} minimumBudgetShare must be in [0, 1], got ${share}`);
  }
  if (category.substitutionGoods.length === 0) {
    throw new Error(`NeedCategory ${category.id} must declare at least one substitution good`);
  }

  const candidates = stableOrderBy(category.substitutionGoods, (candidate) => String(candidate.goodId));
  const logWeights = candidates.map((candidate) => {
    const preference = requirePositive(
      `NeedCategory ${category.id} ${String(candidate.goodId)} basePreference`,
      candidate.basePreference,
    );
    const quality = requirePositive(
      `NeedCategory ${category.id} ${String(candidate.goodId)} qualityFactor`,
      candidate.qualityFactor,
    );
    const observedPrice = market.priceByGood.get(candidate.goodId);
    if (observedPrice === undefined) {
      throw new Error(
        `NeedCategory ${category.id} good ${String(candidate.goodId)} has no prior-close market price`,
      );
    }
    const effectivePrice = resolveExpectedGrossBuyerPrice({
      region: args.region,
      goodId: candidate.goodId,
      sellerNetPrice: observedPrice,
      moneyEpsilon,
      taxPolicy: args.taxPolicy,
    });
    const logWeight = Math.log(preference) + Math.log(quality) - category.priceSensitivity * Math.log(effectivePrice);
    requireFinite(`NeedCategory ${category.id} ${String(candidate.goodId)} log substitution weight`, logWeight);
    return { candidate, effectivePrice, logWeight };
  });

  const maxLogWeight = Math.max(...logWeights.map((entry) => entry.logWeight));
  const scaledWeights = logWeights.map((entry) => {
    const weight = Math.exp(entry.logWeight - maxLogWeight);
    requireFinite(`NeedCategory ${category.id} scaled substitution weight`, weight);
    return { ...entry, weight };
  });
  const weightSum = requirePositive(
    `NeedCategory ${category.id} substitution weight sum`,
    scaledWeights.reduce((sum, entry) => sum + entry.weight, 0),
  );

  let accumulated = 0;
  return scaledWeights.map((entry, index) => {
    const share = index === scaledWeights.length - 1
      ? Math.max(0, 1 - accumulated)
      : entry.weight / weightSum;
    accumulated += share;
    return {
      goodId: entry.candidate.goodId,
      expectedGrossBuyerPrice: entry.effectivePrice,
      share,
    };
  });
}

function resolveNeedCategory(args: {
  readonly category: NeedCategoryDefinition;
  readonly population: number;
  readonly market: LocalMarketState;
  readonly region: RegionState;
  readonly moneyEpsilon: number;
  readonly taxPolicy?: TaxPolicyProvider | undefined;
}): ResolvedNeedCategory {
  const substitutionShares = normalizedSubstitutionShares(args);
  const targetUsefulConsumption = requireNonNegative(
    `NeedCategory ${args.category.id} target useful consumption`,
    args.category.perCapitaTarget * args.population,
  );
  const expectedUnitCost = requireNonNegative(
    `NeedCategory ${args.category.id} expected unit cost`,
    substitutionShares.reduce(
      (sum, candidate) => sum + candidate.share * candidate.expectedGrossBuyerPrice,
      0,
    ),
  );
  const targetCost = requireNonNegative(
    `NeedCategory ${args.category.id} target cost`,
    targetUsefulConsumption * expectedUnitCost,
  );
  return { definition: args.category, substitutionShares, targetUsefulConsumption, targetCost };
}

function allocateCategoryBudgets(
  resolved: ReadonlyMap<string, ResolvedNeedCategory>,
  planningCashEnvelope: number,
): ReadonlyMap<string, number> {
  const budgets = new Map<string, number>(BASELINE_NEED_CATEGORY_IDS.map((id) => [id, 0]));
  let remaining = planningCashEnvelope;

  const add = (categoryId: string, requested: number): void => {
    if (remaining <= 0 || requested <= 0) return;
    const current = budgets.get(categoryId) ?? 0;
    const target = resolved.get(categoryId)?.targetCost ?? 0;
    const amount = Math.min(remaining, Math.max(0, target - current), requested);
    budgets.set(categoryId, current + amount);
    remaining -= amount;
  };

  const essential = resolved.get("ESSENTIAL_FOOD")!;
  add("ESSENTIAL_FOOD", essential.targetCost);

  const middle = [resolved.get("BASIC_GOODS")!, resolved.get("SERVICES")!]
    .sort((left, right) =>
      right.definition.priority - left.definition.priority || left.definition.id.localeCompare(right.definition.id),
    );

  // Reserve configured minimum shares first, then use any remainder to approach each target.
  for (const category of middle) {
    add(
      category.definition.id,
      planningCashEnvelope * (category.definition.minimumBudgetShare ?? 0),
    );
  }
  for (const category of middle) {
    add(category.definition.id, category.targetCost);
  }

  const comfort = resolved.get("COMFORT")!;
  add("COMFORT", comfort.targetCost);
  return budgets;
}

function buildCohortPlan(args: {
  readonly world: WorldState;
  readonly cohort: CohortState;
  readonly tick: number;
  readonly startingBudgetLedger: BudgetCommitmentLedger;
  readonly categories: readonly NeedCategoryDefinition[];
  readonly taxPolicy?: TaxPolicyProvider | undefined;
}): { readonly plan: HouseholdConsumptionPlan; readonly intents: readonly MarketIntent[]; readonly budgetLedger: BudgetCommitmentLedger } | null {
  const { world, cohort, tick, categories } = args;
  const population = requireNonNegative(`Cohort ${String(cohort.cohortId)} population`, cohort.seed.population);
  if (population === 0) return null;

  const controls = resolveHouseholdControls(world);
  const region = resolveRegionForCohort(world, cohort);
  const market = resolveMarketForRegion(world, region);
  const openingSpendableCash = requireNonNegative(
    `Cohort ${String(cohort.cohortId)} opening spendable cash`,
    cohort.wallet.get(region.settlementCurrencyId) ?? 0,
  );

  // M4 has no explicit already-committed transfer entitlement surface. In particular,
  // wageSignal is prior-close planning evidence, not money. Same-tick wages settle in Phase 5.
  const expectedCurrentTickIncome = 0;
  const liquidityFloor = Math.max(
    controls.minHouseholdCashPerCapita * population,
    controls.liquidityFloorShare * openingSpendableCash,
  );
  requireNonNegative(`Cohort ${String(cohort.cohortId)} liquidity floor`, liquidityFloor);
  const planningCashEnvelope = Math.max(
    0,
    openingSpendableCash + expectedCurrentTickIncome - liquidityFloor,
  );

  const resolved = new Map<string, ResolvedNeedCategory>();
  for (const category of categories) {
    resolved.set(category.id, resolveNeedCategory({
      category,
      population,
      market,
      region,
      moneyEpsilon: controls.moneyEpsilon,
      taxPolicy: args.taxPolicy,
    }));
  }
  const budgets = allocateCategoryBudgets(resolved, planningCashEnvelope);
  const planId = `household-consumption:${tick}:${String(cohort.cohortId)}`;
  const actor = { type: "COHORT" as const, cohortId: cohort.cohortId };

  let budgetLedger = args.startingBudgetLedger;
  let committedAcrossCategories = 0;
  const intents: MarketIntent[] = [];
  const categoryBudgets: Record<string, number> = {};
  const intendedUsefulConsumption: Record<string, number> = {};
  const categoryDetails: HouseholdCategoryBudget[] = [];

  for (const categoryId of BASELINE_NEED_CATEGORY_IDS) {
    const category = resolved.get(categoryId)!;
    const budget = budgets.get(categoryId) ?? 0;
    const intendedUsefulConsumptionForCategory = budget <= 0
      ? 0
      : budget >= category.targetCost
        ? category.targetUsefulConsumption
        : category.targetUsefulConsumption * (budget / category.targetCost);
    const intentIds: MarketIntentId[] = [];

    let committedWithinCategory = 0;
    category.substitutionShares.forEach((candidate, index) => {
      const isLast = index === category.substitutionShares.length - 1;
      const nominalDemand = isLast
        ? Math.max(0, budget - committedWithinCategory)
        : budget * candidate.share;
      committedWithinCategory += nominalDemand;
      const remainingPlanningBudget = Math.max(0, planningCashEnvelope - committedAcrossCategories);
      const maxSpend = Math.min(nominalDemand, remainingPlanningBudget);
      committedAcrossCategories += maxSpend;
      if (maxSpend <= 0) return;

      const desiredQuantity = requireNonNegative(
        `Household desired quantity ${categoryId}/${String(candidate.goodId)}`,
        maxSpend / candidate.expectedGrossBuyerPrice,
      );
      const intent: MarketIntent = {
        id: createMarketIntentId(
          `mi:household:${tick}:${String(cohort.cohortId)}:${categoryId}:${String(candidate.goodId)}`,
        ),
        actor,
        regionId: region.regionId,
        goodId: candidate.goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity,
        maxSpend,
        sourcePlanId: planId,
      };
      validateMarketIntent(intent);
      const nextLedger = commitBudget(
        budgetLedger,
        actor,
        region.settlementCurrencyId,
        HOUSEHOLD_BUDGET_ENVELOPE,
        maxSpend,
        planningCashEnvelope,
      );
      if (typeof nextLedger === "string") {
        throw new Error(`Household budget overcommit for ${String(cohort.cohortId)}: ${nextLedger}`);
      }
      budgetLedger = nextLedger;
      intents.push(intent);
      intentIds.push(intent.id);
    });

    categoryBudgets[categoryId] = budget;
    intendedUsefulConsumption[categoryId] = intendedUsefulConsumptionForCategory;
    categoryDetails.push({
      categoryId,
      budget,
      targetUsefulConsumption: category.targetUsefulConsumption,
      intendedUsefulConsumption: intendedUsefulConsumptionForCategory,
      substitutionShares: category.substitutionShares,
    });
  }

  return {
    plan: {
      planId,
      cohortId: cohort.cohortId,
      tick,
      settlementCurrencyId: region.settlementCurrencyId,
      openingSpendableCash,
      expectedCurrentTickIncome,
      liquidityFloor,
      planningCashEnvelope,
      categoryBudgets,
      intendedUsefulConsumption,
      categoryDetails,
      marketIntentIds: intents.map((intent) => intent.id),
    },
    intents,
    budgetLedger,
  };
}

/** Generate complete M4 household plans/intents in stable CohortId order. */
export function planHouseholdConsumptionPhase2(
  world: WorldState,
  tick: number,
  options: HouseholdConsumptionPlanningOptions = {},
): HouseholdConsumptionPlanningResult {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Household consumption planning tick must be a non-negative integer, got ${String(tick)}`);
  }
  const categories = resolveNeedCategories(world);
  const cohorts = stableOrderBy([...world.cohorts.values()], (cohort) => String(cohort.cohortId));
  const plans: HouseholdConsumptionPlan[] = [];
  const intents: MarketIntent[] = [];
  let budgetLedger = options.startingBudgetLedger ?? createEmptyBudgetCommitmentLedger();

  for (const cohort of cohorts) {
    const result = buildCohortPlan({
      world,
      cohort,
      tick,
      startingBudgetLedger: budgetLedger,
      categories,
      taxPolicy: options.taxPolicy,
    });
    if (result === null) continue;
    plans.push(result.plan);
    intents.push(...result.intents);
    budgetLedger = result.budgetLedger;
  }

  return { plans, intents, budgetLedger };
}

/**
 * Real Phase-2 handler. Household plans and intents remain tick-scoped and the only
 * state carried forward here is the immutable planner budget commitment ledger.
 */
export function createPhase2HouseholdConsumptionPlanningHandler(options?: {
  readonly taxPolicy?: TaxPolicyProvider | undefined;
}): PhaseHandler {
  return (world: WorldState, context: TickContext, _pendingTransitions: PendingTransitions): TickContext => {
    if (context.phase !== 2) return context;
    const result = planHouseholdConsumptionPhase2(world, context.tick, {
      startingBudgetLedger: context.budgetLedger,
      taxPolicy: options?.taxPolicy,
    });
    return {
      ...context,
      budgetLedger: result.budgetLedger,
      householdConsumptionPlans: result.plans,
      householdMarketIntents: result.intents,
    };
  };
}

/** Exposed for focused ownership/commitment assertions without duplicating the envelope literal. */
export function getHouseholdBudgetEnvelopeName(): string {
  return HOUSEHOLD_BUDGET_ENVELOPE;
}
