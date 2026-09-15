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

/** Concrete fields land with the cadence-scheduling requirement that owns them (section 3). */
export interface CadenceConfig {}

/** Concrete fields land with the markets requirement that owns them (section 4). */
export interface MarketConfig {
  readonly shortageSignalWeight?: number;
  readonly inventorySignalWeight?: number;
  readonly basePriceAdjustmentSpeed?: number;
  readonly maxAbsoluteLogPriceMovePerTick?: number;
  readonly targetInventoryCoverageTicks?: number;
  readonly expectationAlpha?: number;
}

/** Concrete fields land with the trade/FX requirement that owns them (section 5). */
export interface TradeConfig {}

/**
 * M4 production and capital controls (REQ-CONFIG-006).
 *
 * The field list is section 37 "Configuration surface" of
 * `06 - Handoff/05 — PRODUCTION_CAPITAL_LABOR_CONTRACTS.md`; the baseline values
 * are section 6 "Production defaults" of
 * `06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`, which
 * `HANDOFF-REPAIR-005`/`-010` establish as the sole owner of `SimulationConfig`
 * baseline numbers. Fields section 37 names but section 6 gives no value for are
 * declared here and left undefaulted — see `docs/spec/OPEN_QUESTIONS.md`,
 * REQ-CONFIG-006. They are validated when present; they are not guessed.
 *
 * Section 37: "Scenario RecipeDefinitions own recipe-specific coefficients and
 * depreciation. State policy owns minimum wage/taxes/ownership gates. MarketConfig
 * owns prices/clearing. Do not duplicate those values in ProductionConfig." The
 * quantity tolerance section 37 asks for is `NumericConfig.quantityEpsilon` and is
 * deliberately not restated here; `minimumLifecycleScale` is the capital tolerance.
 */
export interface ProductionConfig {
  /** Utilization a unit plans toward before margin/sell-through/inventory response. */
  readonly baseTargetUtilization?: number;
  /** Lower clamp on planned utilization. Must not exceed `maxTargetUtilization`. */
  readonly minTargetUtilization?: number;
  /** Upper clamp on planned utilization. */
  readonly maxTargetUtilization?: number;
  /** Sensitivity of planned utilization to realized margin. */
  readonly marginResponse?: number;
  /** Sensitivity of planned utilization to realized sell-through. */
  readonly sellThroughResponse?: number;
  /** Sensitivity of planned utilization to output inventory coverage. */
  readonly inventoryResponse?: number;
  /** Sell-through share a unit plans toward. */
  readonly targetSellThrough?: number;
  /** Ticks of output a unit plans to hold. */
  readonly outputCoverageTicks?: number;
  /** Ticks of inputs a unit plans to hold. */
  readonly inputCoverageTicks?: number;
  /** Extra ticks of input cover held as safety stock. */
  readonly inputSafetyCoverageTicks?: number;
  /** EMA smoothing factor for the production planning signal. */
  readonly productionSignalAlpha?: number;
  /** Cash a unit keeps before committing to labor or procurement. */
  readonly minOperatingCash?: number;
  /** Share of cash held back as a liquidity buffer. */
  readonly liquidityBufferShare?: number;
  /** Upper clamp on the input-criticality multiplier. */
  readonly maxInputCriticality?: number;

  /** Ticks between investment reviews. No value stated by section 6. */
  readonly investmentReviewCadenceTicks?: number;
  /** Utilization a unit must exceed to consider investing. No value stated by section 6. */
  readonly investmentUtilizationThreshold?: number;
  /** Margin a unit must exceed to consider investing. No value stated by section 6. */
  readonly minimumInvestmentMargin?: number;
  /** Share of eligible cash a unit directs to investment. No value stated by section 6. */
  readonly investmentPropensity?: number;
  /** Upper clamp on investment as a share of excess cash. No value stated by section 6. */
  readonly maxInvestmentShareOfExcessCash?: number;
  /** Upper clamp on capital growth per investment review. No value stated by section 6. */
  readonly maxCapitalGrowthPerReview?: number;

  /** Ticks between lifecycle reviews. No value stated by section 6. */
  readonly lifecycleReviewCadenceTicks?: number;
  /** Margin below which a review counts as nonviable. No value stated by section 6. */
  readonly mothballMarginThreshold?: number;
  /** Utilization below which a review counts as nonviable. No value stated by section 6. */
  readonly mothballUtilizationThreshold?: number;
  /** Consecutive nonviable reviews before mothballing. Section 6 `mothballAfterNonviableReviews`. */
  readonly mothballAfterReviews?: number;
  /** Margin above which a mothballed review counts as viable. No value stated by section 6. */
  readonly reactivateMarginThreshold?: number;
  /** Consecutive viable reviews before reactivating. Section 6 `reactivateAfterViableReviews`. */
  readonly reactivateAfterReviews?: number;
  /** Consecutive mothballed reviews before closing. Section 6 `closeAfterMothballedReviews`. */
  readonly closeAfterReviews?: number;
  /** Reviews a CLOSING unit is granted before removal. No value stated by section 6. */
  readonly closingGraceReviews?: number;

  /** Capital tolerance: scale below which a unit is lifecycle-negligible. */
  readonly minimumLifecycleScale?: number;
}

/**
 * M4 labor controls (REQ-CONFIG-006).
 *
 * Field list from section 37 of Handoff/05, baseline values from section 7
 * "Labor defaults" of Handoff/03. Section 37's `laborEpsilon` is deliberately
 * absent: labor is measured in worker-equivalents, a quantity, and
 * `NumericConfig.quantityEpsilon` already owns that tolerance. Section 37: State
 * policy owns minimum wage, taxes and ownership gates, so none appears here.
 */
export interface LaborConfig {
  /** Share of the WORKING population that participates in the labor market. */
  readonly baselineParticipationRate?: number;
  /** Elasticity of labor supply to relative wage attractiveness. */
  readonly laborWageAttractivenessElasticity?: number;
  /** Lower clamp on the wage weight. Must not exceed `maxWageWeight`. */
  readonly minWageWeight?: number;
  /** Upper clamp on the wage weight. */
  readonly maxWageWeight?: number;
  /** Speed at which a sticky wage offer closes on its target. */
  readonly wageAdjustmentSpeed?: number;
  /** Reference wage per worker-equivalent per tick when no scenario value applies. */
  readonly startingReferenceWage?: number;
  /** Regional wage pressure from unemployment. */
  readonly unemploymentWagePressure?: number;
  /** Regional wage pressure from vacancies. */
  readonly vacancyWagePressure?: number;
  /** Lower clamp on the working health factor. Must not exceed `maximumWorkingHealthFactor`. */
  readonly minimumWorkingHealthFactor?: number;
  /** Upper clamp on the working health factor. */
  readonly maximumWorkingHealthFactor?: number;
  /** Labor categories the core baseline allows. Section 7 permits at most three in v1. */
  readonly allowedLaborCategories?: readonly string[];

  /**
   * Upper clamp on a single log wage step. No value stated by section 7, which
   * instead states `maxWageMoveSharePerTick = 0.10` — a bound on a proportional
   * move, not on a log step. Not mapped; see `docs/spec/OPEN_QUESTIONS.md`.
   */
  readonly maxLogWageStep?: number;
  /** Unit-level wage response to its own vacancies. No value stated by section 7. */
  readonly unitVacancyResponse?: number;
  /** Upper clamp on the labor-market tightness signal. No value stated by section 7. */
  readonly maxTightnessSignal?: number;
}

/** Concrete fields land with the population requirement that owns them (section 8). */
export interface PopulationConfig {}

/** Concrete fields land with the clans requirement that owns them (section 9). */
export interface ClanConfig {}

/** Concrete fields land with the fiscal requirement that owns them (section 10). */
export interface FiscalConfig {}

/** Concrete fields land with the monetary requirement that owns them (section 11). */
export interface MonetaryConfig {}

/** Concrete fields land with the expansion requirement that owns them (section 12). */
export interface ExpansionConfig {}

/** Concrete fields land with the events requirement that owns them (section 13). */
export interface EventConfig {}

/** Concrete fields land with the performance requirement that owns them (section 14). */
export interface PerformanceConfig {}

/**
 * The thirteen behavioral-tuning keys `SimulationConfig` owns, exactly as named
 * in section 2. Scenario data may never carry one of these keys directly — see
 * `./validation.ts`'s `assertNoBehavioralOverrides`.
 */
export const SIMULATION_CONFIG_BEHAVIORAL_KEYS = [
  "numeric",
  "cadence",
  "markets",
  "trade",
  "production",
  "labor",
  "population",
  "clans",
  "fiscal",
  "monetary",
  "expansion",
  "events",
  "performance",
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
    numeric: {
      moneyEpsilon: 1e-9,
      quantityEpsilon: 1e-9,
      populationEpsilon: 1e-6,
      rateEpsilon: 1e-12,
      reconciliationRelativeTolerance: 1e-9,
      maxFiniteMagnitude: 1e15,
    },
    cadence: {},
    markets: {
      shortageSignalWeight: 0.65,
      inventorySignalWeight: 0.35,
      basePriceAdjustmentSpeed: 0.12,
      maxAbsoluteLogPriceMovePerTick: 0.18,
      targetInventoryCoverageTicks: 1.0,
      expectationAlpha: 0.25,
    },
    trade: {},
    // Handoff/03 section 6 "Production defaults". Controls section 37 names but
    // section 6 gives no value for are absent, not guessed: REQ-CONFIG-006 is a
    // PARTIAL row and `docs/spec/OPEN_QUESTIONS.md` carries the list.
    production: {
      baseTargetUtilization: 0.7,
      minTargetUtilization: 0.1,
      maxTargetUtilization: 1.0,
      targetSellThrough: 0.8,
      marginResponse: 0.15,
      sellThroughResponse: 0.2,
      inventoryResponse: 0.25,
      outputCoverageTicks: 0.75,
      inputCoverageTicks: 1.0,
      inputSafetyCoverageTicks: 0.5,
      productionSignalAlpha: 0.25,
      liquidityBufferShare: 0.1,
      minOperatingCash: 0,
      maxInputCriticality: 4.0,
      mothballAfterReviews: 3,
      reactivateAfterReviews: 2,
      closeAfterReviews: 8,
      minimumLifecycleScale: 1e-6,
    },
    // Handoff/03 section 7 "Labor defaults". `maxLogWageStep`,
    // `unitVacancyResponse` and `maxTightnessSignal` have no stated value.
    labor: {
      baselineParticipationRate: 0.7,
      laborWageAttractivenessElasticity: 0.5,
      minWageWeight: 0.5,
      maxWageWeight: 2.0,
      wageAdjustmentSpeed: 0.1,
      startingReferenceWage: 10,
      unemploymentWagePressure: 0.4,
      vacancyWagePressure: 0.4,
      minimumWorkingHealthFactor: 0.5,
      maximumWorkingHealthFactor: 1.05,
      allowedLaborCategories: ["GENERAL"],
    },
    population: {},
    clans: {},
    fiscal: {},
    monetary: {},
    expansion: {},
    events: {},
    performance: {},
  };
}
