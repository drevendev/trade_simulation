/**
 * Population-owned deterministic Phase-2 labor supply planning (REQ-POPULATION-002).
 *
 * Implements Handoff/06 section 8 and the shared LaborSupplyPlan contract in
 * Handoff/05 section 11. M4 supply is derived only from tick-opening cohort state and
 * PopulationConfig; Phase-3 allocation, employer choice and wage settlement are separate
 * requirements and cannot feed back into this planner.
 */

import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { CohortId, RegionId } from "../domain/id";
import { isFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import type { CohortState, PendingTransitions, WorldState } from "./worldState";

export interface LaborSupplyPlan {
  readonly planId: string;
  readonly cohortId: CohortId;
  readonly regionId: RegionId;
  readonly laborCategory: string;
  readonly availableWorkerEquivalents: number;
}

interface Phase2LaborSupplyAuthorityRecord {
  readonly tick: number;
  readonly world: WorldState;
  readonly laborSupplyPlans: readonly LaborSupplyPlan[];
}

/**
 * Runtime provenance for the exact supply batch emitted by the canonical Phase-2 handler.
 * Actor IDs alone are not authority: decision-bearing participation and availability values
 * must come from the handler that derived them from this exact opening WorldState.
 */
const phase2LaborSupplyAuthorities = new WeakMap<
  readonly LaborSupplyPlan[],
  Phase2LaborSupplyAuthorityRecord
>();

export function requireCanonicalPhase2LaborSupplyPlans(
  world: WorldState,
  laborSupplyPlans: readonly LaborSupplyPlan[],
  currentTick: number,
): void {
  const authority = phase2LaborSupplyAuthorities.get(laborSupplyPlans);
  if (
    authority === undefined ||
    authority.tick !== currentTick ||
    authority.world !== world ||
    authority.laborSupplyPlans !== laborSupplyPlans
  ) {
    throw new Error(
      `Phase-2 labor-supply evidence for tick ${currentTick} was not issued by the canonical Phase-2 handler for this WorldState`,
    );
  }
}

interface ResolvedLaborSupplyConfig {
  readonly baseParticipationByStratum: Readonly<Record<string, number>>;
  readonly minParticipation: number;
  readonly maxParticipation: number;
  readonly minHealthParticipationFactor: number;
  readonly maxHealthParticipationFactor: number;
  readonly minWeakOpportunityFactor: number;
  readonly maxWeakOpportunityFactor: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

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

function requireUnitInterval(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0 || value > 1) {
    throw new Error(`${name} must be in [0, 1], got ${String(value)}`);
  }
  return value;
}

function requiredNumber(name: string, configured: number | undefined, fallback: number | undefined): number {
  const value = configured ?? fallback;
  if (value === undefined) {
    throw new Error(`${name} is required for M4 labor supply planning`);
  }
  return requireFinite(name, value);
}

function resolveLaborSupplyConfig(config: SimulationConfig): ResolvedLaborSupplyConfig {
  const defaults = createDefaultSimulationConfig().population;
  const baseParticipationByStratum =
    config.population.baseParticipationByStratum ?? defaults.baseParticipationByStratum;
  if (baseParticipationByStratum === undefined) {
    throw new Error("PopulationConfig.baseParticipationByStratum is required for M4 labor supply planning");
  }

  const minParticipation = requireUnitInterval(
    "PopulationConfig.minParticipation",
    requiredNumber("PopulationConfig.minParticipation", config.population.minParticipation, defaults.minParticipation),
  );
  const maxParticipation = requireUnitInterval(
    "PopulationConfig.maxParticipation",
    requiredNumber("PopulationConfig.maxParticipation", config.population.maxParticipation, defaults.maxParticipation),
  );
  if (minParticipation > maxParticipation) {
    throw new Error("PopulationConfig minParticipation must not exceed maxParticipation");
  }

  const minHealthParticipationFactor = requireNonNegative(
    "PopulationConfig.minHealthParticipationFactor",
    requiredNumber(
      "PopulationConfig.minHealthParticipationFactor",
      config.population.minHealthParticipationFactor,
      defaults.minHealthParticipationFactor,
    ),
  );
  const maxHealthParticipationFactor = requireNonNegative(
    "PopulationConfig.maxHealthParticipationFactor",
    requiredNumber(
      "PopulationConfig.maxHealthParticipationFactor",
      config.population.maxHealthParticipationFactor,
      defaults.maxHealthParticipationFactor,
    ),
  );
  if (minHealthParticipationFactor > maxHealthParticipationFactor) {
    throw new Error(
      "PopulationConfig minHealthParticipationFactor must not exceed maxHealthParticipationFactor",
    );
  }

  const minWeakOpportunityFactor = requireNonNegative(
    "PopulationConfig.minWeakOpportunityFactor",
    requiredNumber(
      "PopulationConfig.minWeakOpportunityFactor",
      config.population.minWeakOpportunityFactor,
      defaults.minWeakOpportunityFactor,
    ),
  );
  const maxWeakOpportunityFactor = requireNonNegative(
    "PopulationConfig.maxWeakOpportunityFactor",
    requiredNumber(
      "PopulationConfig.maxWeakOpportunityFactor",
      config.population.maxWeakOpportunityFactor,
      defaults.maxWeakOpportunityFactor,
    ),
  );
  if (minWeakOpportunityFactor > maxWeakOpportunityFactor) {
    throw new Error(
      "PopulationConfig minWeakOpportunityFactor must not exceed maxWeakOpportunityFactor",
    );
  }

  return {
    baseParticipationByStratum,
    minParticipation,
    maxParticipation,
    minHealthParticipationFactor,
    maxHealthParticipationFactor,
    minWeakOpportunityFactor,
    maxWeakOpportunityFactor,
  };
}

/**
 * Build one cohort's M4 LaborSupplyPlan from opening/prior-close state only.
 * CHILD/ELDER and zero-population cohorts have no normal labor supply plan.
 */
export function planCohortLaborSupplyPhase2(args: {
  readonly tick: number;
  readonly cohort: CohortState;
  readonly regionId: RegionId;
  readonly config: SimulationConfig;
}): LaborSupplyPlan | null {
  const { tick, cohort, regionId, config } = args;
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`Labor supply planning tick must be a non-negative integer, got ${String(tick)}`);
  }

  const population = requireNonNegative(
    `Cohort ${String(cohort.cohortId)} population`,
    cohort.seed.population,
  );
  if (cohort.seed.ageBand !== "WORKING" || population === 0) {
    return null;
  }

  const resolved = resolveLaborSupplyConfig(config);
  const baseParticipation = resolved.baseParticipationByStratum[cohort.seed.stratum];
  if (baseParticipation === undefined) {
    throw new Error(
      `PopulationConfig.baseParticipationByStratum is missing stratum ${cohort.seed.stratum}`,
    );
  }
  requireUnitInterval(
    `PopulationConfig.baseParticipationByStratum.${cohort.seed.stratum}`,
    baseParticipation,
  );

  const healthScore = clamp01(
    requireFinite(`Cohort ${String(cohort.cohortId)} healthIndex`, cohort.seed.healthIndex),
  );
  const opportunityScore = clamp01(
    requireFinite(
      `Cohort ${String(cohort.cohortId)} employmentRateEma`,
      cohort.seed.employmentRateEma,
    ),
  );

  const healthParticipationFactor =
    resolved.minHealthParticipationFactor +
    healthScore * (resolved.maxHealthParticipationFactor - resolved.minHealthParticipationFactor);
  const weakOpportunityFactor =
    resolved.minWeakOpportunityFactor +
    opportunityScore * (resolved.maxWeakOpportunityFactor - resolved.minWeakOpportunityFactor);

  // M4 has neutral workingEligibility=1 and lawParticipationFactor=1. Mutable law and
  // eligibility institutions belong to later milestones and are intentionally absent here.
  const participationRate = clamp(
    baseParticipation * healthParticipationFactor * weakOpportunityFactor,
    resolved.minParticipation,
    resolved.maxParticipation,
  );
  const potentialWorkers = population * participationRate;
  const availableWorkerEquivalents = clamp(
    requireFinite("availableWorkerEquivalents", potentialWorkers),
    0,
    population,
  );

  if (cohort.seed.laborCategory.trim().length === 0) {
    throw new Error(`Cohort ${String(cohort.cohortId)} laborCategory must be non-empty`);
  }

  return {
    planId: `labor-supply:${tick}:${String(cohort.cohortId)}`,
    cohortId: cohort.cohortId,
    regionId,
    laborCategory: cohort.seed.laborCategory,
    availableWorkerEquivalents,
  };
}

function resolveRegionIdBySeedKey(world: WorldState, regionKey: string): RegionId {
  let matched: RegionId | undefined;
  for (const region of world.regions.values()) {
    if (region.seed.key !== regionKey) continue;
    if (matched !== undefined) {
      throw new Error(`Duplicate live RegionState seed key ${regionKey}`);
    }
    matched = region.regionId;
  }
  if (matched === undefined) {
    throw new Error(`Cohort references missing live RegionState seed key ${regionKey}`);
  }
  return matched;
}

/** Generate the complete Phase-2 supply set in persistent cohort-id order. */
export function generateLaborSupplyPlansPhase2(world: WorldState, tick: number): readonly LaborSupplyPlan[] {
  const plans: LaborSupplyPlan[] = [];
  const cohorts = stableOrderBy([...world.cohorts.values()], (cohort) => String(cohort.cohortId));

  for (const cohort of cohorts) {
    const regionId = resolveRegionIdBySeedKey(world, cohort.seed.regionKey);
    const plan = planCohortLaborSupplyPhase2({
      tick,
      cohort,
      regionId,
      config: world.simulationConfig,
    });
    if (plan !== null) plans.push(plan);
  }

  return plans;
}

/**
 * Real Phase-2 handler for Population-owned labor supply. It writes only ephemeral plans
 * to TickContext and never mutates WorldState or persistent cohort/employer state.
 */
export function createPhase2LaborSupplyPlanningHandler(): PhaseHandler {
  return (world: WorldState, context: TickContext, _pendingTransitions: PendingTransitions): TickContext => {
    if (context.phase !== 2) {
      return context;
    }
    const laborSupplyPlans = Object.freeze(
      generateLaborSupplyPlansPhase2(world, context.tick).map((plan) => Object.freeze({ ...plan })),
    );
    phase2LaborSupplyAuthorities.set(laborSupplyPlans, {
      tick: context.tick,
      world,
      laborSupplyPlans,
    });
    return {
      ...context,
      laborSupplyPlans,
    };
  };
}
