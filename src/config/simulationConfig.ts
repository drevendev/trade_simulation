import { createDefaultPopulationConfig } from "./m4PopulationDefaults";

/**
 * SimulationConfig layer (REQ-CONFIG-001).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "SimulationConfig owns reusable behavioral tuning" shared across
 * scenarios. Each of the thirteen sub-config types below is a named placeholder —
 * its concrete field-level defaults (sections 3-14 of that document) land with the
 * requirement that owns the corresponding subsystem (M3-M10), not with this
 * scaffolding requirement. Declaring them now, rather than inlining `unknown`,
 * is what makes `SimulationConfig` a real distinct type today and lets later
 * requirements add fields without touching this file's shape.
 */

/** Concrete fields land with the numeric-tolerance requirement that owns them (section 3). */
export interface NumericConfig {
  readonly moneyEpsilon?: number;
  readonly quantityEpsilon?: number;
  readonly populationEpsilon?: number;
  readonly rateEpsilon?: number;
  readonly reconciliationRelativeTolerance?: number;
  readonly maxFiniteMagnitude?: number;
}
export interface CadenceConfig {}
export interface MarketConfig {
  readonly shortageSignalWeight?: number;
  readonly inventorySignalWeight?: number;
  readonly basePriceAdjustmentSpeed?: number;
  readonly maxAbsoluteLogPriceMovePerTick?: number;
  readonly targetInventoryCoverageTicks?: number;
  readonly expectationAlpha?: number;
}
export interface TradeConfig {}

/** M4 production and capital controls (REQ-CONFIG-006). */
export interface ProductionConfig {
  readonly baseTargetUtilization?: number;
  readonly minTargetUtilization?: number;
  readonly maxTargetUtilization?: number;
  readonly marginResponse?: number;
  readonly sellThroughResponse?: number;
  readonly inventoryResponse?: number;
  readonly targetSellThrough?: number;
  readonly outputCoverageTicks?: number;
  readonly inputCoverageTicks?: number;
  readonly inputSafetyCoverageTicks?: number;
  readonly productionSignalAlpha?: number;
  readonly minOperatingCash?: number;
  readonly liquidityBufferShare?: number;
  readonly maxInputCriticality?: number;
  readonly investmentReviewCadenceTicks?: number;
  readonly investmentUtilizationThreshold?: number;
  readonly minimumInvestmentMargin?: number;
  readonly investmentPropensity?: number;
  readonly maxInvestmentShareOfExcessCash?: number;
  readonly maxCapitalGrowthPerReview?: number;
  readonly lifecycleReviewCadenceTicks?: number;
  readonly mothballMarginThreshold?: number;
  readonly mothballUtilizationThreshold?: number;
  readonly mothballAfterReviews?: number;
  readonly reactivateMarginThreshold?: number;
  readonly reactivateAfterReviews?: number;
  readonly closeAfterReviews?: number;
  readonly closingGraceReviews?: number;
  readonly minimumLifecycleScale?: number;
}

/** M4 labor controls (REQ-CONFIG-006). */
export interface LaborConfig {
  readonly baselineParticipationRate?: number;
  readonly laborWageAttractivenessElasticity?: number;
  readonly minWageWeight?: number;
  readonly maxWageWeight?: number;
  readonly wageAdjustmentSpeed?: number;
  readonly startingReferenceWage?: number;
  readonly unemploymentWagePressure?: number;
  readonly vacancyWagePressure?: number;
  readonly minimumWorkingHealthFactor?: number;
  readonly maximumWorkingHealthFactor?: number;
  readonly allowedLaborCategories?: readonly string[];
  readonly maxLogWageStep?: number;
  readonly unitVacancyResponse?: number;
  readonly maxTightnessSignal?: number;
}

/** M4 household-demand, participation and welfare-signal controls (REQ-CONFIG-007). */
export interface PopulationConfig {
  readonly minHouseholdCashPerCapita?: number;
  readonly liquidityFloorShare?: number;
  readonly baseParticipationByStratum?: Readonly<Record<string, number>>;
  readonly minParticipation?: number;
  readonly maxParticipation?: number;
  readonly minHealthParticipationFactor?: number;
  readonly maxHealthParticipationFactor?: number;
  readonly minWeakOpportunityFactor?: number;
  readonly maxWeakOpportunityFactor?: number;
  readonly wageSignalAdjustmentSpeed?: number;
  readonly maxWageSignalStep?: number;
  readonly prosperityAlpha?: number;
  readonly essentialAlpha?: number;
  readonly incomeAlpha?: number;
  readonly employmentAlpha?: number;
  readonly scenarioRealIncomeScale?: number;
  readonly healthRecoveryRate?: number;
  readonly healthMaintenanceThreshold?: number;
  readonly serviceHealthRate?: number;
  readonly serviceBaseline?: number;
}

export interface ClanConfig {}
export interface FiscalConfig {}
export interface MonetaryConfig {}
export interface ExpansionConfig {}
export interface EventConfig {}
export interface PerformanceConfig {}

export const SIMULATION_CONFIG_BEHAVIORAL_KEYS = [
  "numeric", "cadence", "markets", "trade", "production", "labor", "population",
  "clans", "fiscal", "monetary", "expansion", "events", "performance",
] as const satisfies readonly (keyof Omit<SimulationConfig, "configVersion">)[];

export interface SimulationConfig {
  readonly configVersion: string;
  readonly numeric: NumericConfig;
  readonly cadence: CadenceConfig;
  readonly markets: MarketConfig;
  readonly trade: TradeConfig;
  readonly production: ProductionConfig;
  readonly labor: LaborConfig;
  readonly population: PopulationConfig;
  readonly clans: ClanConfig;
  readonly fiscal: FiscalConfig;
  readonly monetary: MonetaryConfig;
  readonly expansion: ExpansionConfig;
  readonly events: EventConfig;
  readonly performance: PerformanceConfig;
}

export function createDefaultSimulationConfig(): SimulationConfig {
  return {
    configVersion: "1.0.0",
    numeric: { moneyEpsilon: 1e-9, quantityEpsilon: 1e-9, populationEpsilon: 1e-6, rateEpsilon: 1e-12, reconciliationRelativeTolerance: 1e-9, maxFiniteMagnitude: 1e15 },
    cadence: {},
    markets: { shortageSignalWeight: 0.65, inventorySignalWeight: 0.35, basePriceAdjustmentSpeed: 0.12, maxAbsoluteLogPriceMovePerTick: 0.18, targetInventoryCoverageTicks: 1.0, expectationAlpha: 0.25 },
    trade: {},
    production: {
      baseTargetUtilization: 0.7, minTargetUtilization: 0.1, maxTargetUtilization: 1.0,
      targetSellThrough: 0.8, marginResponse: 0.15, sellThroughResponse: 0.2,
      inventoryResponse: 0.25, outputCoverageTicks: 0.75, inputCoverageTicks: 1.0,
      inputSafetyCoverageTicks: 0.5, productionSignalAlpha: 0.25, liquidityBufferShare: 0.1,
      minOperatingCash: 0, maxInputCriticality: 4.0, investmentReviewCadenceTicks: 3,
      investmentUtilizationThreshold: 0.75, minimumInvestmentMargin: 0.05,
      investmentPropensity: 0.35, maxInvestmentShareOfExcessCash: 0.5,
      maxCapitalGrowthPerReview: 0.25, lifecycleReviewCadenceTicks: 3,
      mothballMarginThreshold: -0.1, mothballUtilizationThreshold: 0.25,
      mothballAfterReviews: 3, reactivateMarginThreshold: 0.05, reactivateAfterReviews: 2,
      closeAfterReviews: 8, closingGraceReviews: 4, minimumLifecycleScale: 1e-6,
    },
    labor: {
      baselineParticipationRate: 0.7, laborWageAttractivenessElasticity: 0.5,
      minWageWeight: 0.5, maxWageWeight: 2.0, wageAdjustmentSpeed: 0.1,
      startingReferenceWage: 10, unemploymentWagePressure: 0.4, vacancyWagePressure: 0.4,
      minimumWorkingHealthFactor: 0.5, maximumWorkingHealthFactor: 1.05,
      allowedLaborCategories: ["GENERAL"], maxLogWageStep: Math.log(1.05),
      unitVacancyResponse: 0.02, maxTightnessSignal: 2.0,
    },
    population: createDefaultPopulationConfig(),
    clans: {}, fiscal: {}, monetary: {}, expansion: {}, events: {}, performance: {},
  };
}
