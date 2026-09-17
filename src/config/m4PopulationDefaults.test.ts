import { describe, expect, it } from "vitest";
import { createDefaultPopulationConfig, M4_POPULATION_DEFAULTS } from "./m4PopulationDefaults";
import { createDefaultSimulationConfig } from "./simulationConfig";
import { validatePopulationConfig } from "./validation";

const CANONICAL_FIELDS = [
  "minHouseholdCashPerCapita", "liquidityFloorShare", "baseParticipationByStratum",
  "minParticipation", "maxParticipation", "minHealthParticipationFactor",
  "maxHealthParticipationFactor", "minWeakOpportunityFactor", "maxWeakOpportunityFactor",
  "wageSignalAdjustmentSpeed", "maxWageSignalStep", "essentialAlpha", "incomeAlpha",
  "employmentAlpha", "prosperityAlpha", "scenarioRealIncomeScale", "healthRecoveryRate",
  "healthMaintenanceThreshold", "serviceHealthRate", "serviceBaseline",
] as const;

describe("HANDOFF-REPAIR-M4-003 PopulationConfig defaults (REQ-CONFIG-007)", () => {
  it("pins the exact twenty-control M4 baseline", () => {
    expect(Object.keys(M4_POPULATION_DEFAULTS).sort()).toEqual([...CANONICAL_FIELDS].sort());
    expect(M4_POPULATION_DEFAULTS).toEqual({
      minHouseholdCashPerCapita: 2.5,
      liquidityFloorShare: 0.10,
      baseParticipationByStratum: { VULNERABLE: 0.70, WORKING_MIDDLE: 0.70, AFFLUENT: 0.70 },
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
    });
  });

  it("constructs validator-safe runtime defaults with no shared participation map", () => {
    const first = createDefaultPopulationConfig();
    const second = createDefaultPopulationConfig();

    expect(first).toEqual(M4_POPULATION_DEFAULTS);
    expect(second).toEqual(M4_POPULATION_DEFAULTS);
    expect(first).not.toBe(second);
    expect(first.baseParticipationByStratum).not.toBe(second.baseParticipationByStratum);
    expect(() => validatePopulationConfig(first)).not.toThrow();
  });

  it("requires the top-level default simulation config to materialize the canonical population baseline", () => {
    const first = createDefaultSimulationConfig();
    const second = createDefaultSimulationConfig();

    expect(first.population).toEqual(M4_POPULATION_DEFAULTS);
    expect(second.population).toEqual(M4_POPULATION_DEFAULTS);
    expect(first.population.baseParticipationByStratum).not.toBe(second.population.baseParticipationByStratum);
  });

  it("does not revive stale aliases or pull M8 controls forward", () => {
    for (const forbidden of [
      "workerEpsilon", "needSubstitutionElasticity", "consumptionBudgetShareLower",
      "consumptionBudgetShareMiddle", "consumptionBudgetShareUpper",
      "precautionaryCashFloorMonths", "healthEmaAlpha", "wageSignalAlpha",
      "baselineMonthlyBirthRate", "migrationReviewEveryTicks", "mobilityCadenceTicks",
    ]) {
      expect(createDefaultPopulationConfig()).not.toHaveProperty(forbidden);
    }
  });
});
