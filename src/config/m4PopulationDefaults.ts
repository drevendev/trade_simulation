import type { PopulationConfig } from "./simulationConfig";

/**
 * Canonical M4 PopulationConfig defaults from HANDOFF-REPAIR-M4-003 / Handoff/03 §8.
 *
 * This object is deliberately limited to the M4 closed-economy slice. M8 demography,
 * migration and mobility controls do not belong here. Need-category substitution,
 * targets and carryover remain DefinitionPack-owned; quantity tolerance remains
 * NumericConfig.quantityEpsilon.
 */
export const M4_POPULATION_DEFAULTS = {
  minHouseholdCashPerCapita: 2.5,
  liquidityFloorShare: 0.10,
  baseParticipationByStratum: {
    VULNERABLE: 0.70,
    WORKING_MIDDLE: 0.70,
    AFFLUENT: 0.70,
  },
  minParticipation: 0.40,
  maxParticipation: 0.90,
  minHealthParticipationFactor: 0.75,
  maxHealthParticipationFactor: 1.02,
  minWeakOpportunityFactor: 0.90,
  maxWeakOpportunityFactor: 1.05,
  wageSignalAdjustmentSpeed: 0.20,
  maxWageSignalStep: Math.log(1.05),
  essentialAlpha: 0.25,
  incomeAlpha: 0.15,
  employmentAlpha: 0.20,
  prosperityAlpha: 0.15,
  scenarioRealIncomeScale: 10,
  healthRecoveryRate: 0.05,
  healthMaintenanceThreshold: 0.85,
  serviceHealthRate: 0.02,
  serviceBaseline: 0.50,
} as const satisfies PopulationConfig;

/**
 * Returns a fresh runtime config so callers cannot share the nested participation
 * map by reference. `createDefaultSimulationConfig()` is the intended consumer.
 */
export function createDefaultPopulationConfig(): PopulationConfig {
  return {
    ...M4_POPULATION_DEFAULTS,
    baseParticipationByStratum: { ...M4_POPULATION_DEFAULTS.baseParticipationByStratum },
  };
}
