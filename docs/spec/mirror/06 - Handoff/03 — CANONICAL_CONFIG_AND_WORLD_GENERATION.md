# CANONICAL CONFIGURATION AND WORLD GENERATION — Economic Simulation

Status: implementation-grade configuration/world-initialization contract v1. Authoritative together with CORE\_SCHEMA\_AND\_LIFECYCLES and subsystem implementation contracts. This document owns configuration hierarchy, canonical defaults, scenario/world templates, initialization order, deterministic variation, validation and migration from the repository’s current SimulationConfig.cs. It does not redefine subsystem formulas.

1\. Design goals

The configuration system must satisfy four requirements simultaneously:  
\- every tunable value lives in one typed registry rather than being scattered through code;  
\- defaults are conservative baseline values, not hidden economic assumptions;  
\- scenario data describes starting stocks, geography and institutions, while SimulationConfig describes behavioral rules shared across scenarios;  
\- buildInitialWorld() is a pure deterministic constructor: same scenario version \+ config version \+ seed \=\> byte-equivalent canonical WorldState after normalized serialization.

No subsystem may introduce an unregistered magic number except local mathematical constants such as 0, 1, 2, or a documented unit conversion. All clamps, tolerances, cadences, EMA alphas, response strengths and thresholds that affect behavior must be configurable or definition-owned.

## 2\. Configuration hierarchy

Use exactly four layers:

interface RunOptions {  
  scenarioId: string;  
  seed: number;  
  maxTicks?: number;  
  diagnosticsLevel: 'OFF' | 'SUMMARY' | 'DEBUG';  
}

interface SimulationConfig {  
  configVersion: string;  
  numeric: NumericConfig;  
  cadence: CadenceConfig;  
  markets: MarketConfig;  
  trade: TradeConfig;  
  production: ProductionConfig;  
  labor: LaborConfig;  
  population: PopulationConfig;  
  clans: ClanConfig;  
  fiscal: FiscalConfig;  
  monetary: MonetaryConfig;  
  expansion: ExpansionConfig;  
  events: EventConfig;  
  performance: PerformanceConfig;  
}

interface ScenarioDefinition {  
  id: string;  
  version: string;  
  name: string;  
  description: string;  
  definitionPackId: string;  
  geography: RegionSeed\[\];  
  transportLinks: TransportLinkSeed\[\];  
  states: StateSeed\[\];  
  currencies: CurrencySeed\[\];  
  monetaryAuthorities: MonetaryAuthoritySeed\[\];  
  clans: ClanSeed\[\];  
  cohorts: CohortSeed\[\];  
  productionUnits: ProductionUnitSeed\[\];  
  markets?: MarketSeed\[\];  
  bonds?: BondSeed\[\];  
  initialEvents?: InitialEventSeed\[\];  
  variation?: ScenarioVariationConfig;  
}

interface DefinitionPack {  
  id: string;  
  version: string;  
  goods: Record\<GoodId, GoodDefinition\>;  
  recipes: Record\<string, RecipeDefinition\>;  
  eventDefinitions: Record\<string, EventDefinition\>;  
  metricDefinitions: Record\<string, MetricDefinition\>;  
}

Ownership rule:  
\- RunOptions chooses a run.  
\- SimulationConfig owns reusable behavioral tuning.  
\- ScenarioDefinition owns starting world stocks/topology/institutions.  
\- DefinitionPack owns immutable type definitions and recipes.  
\- WorldState stores resolved config/definitions or immutable references sufficient for deterministic replay.

Scenario-specific behavioral overrides are forbidden in core v1. If a scenario needs different rules, it must select a named config profile/version rather than patch arbitrary fields. This avoids impossible-to-reproduce bespoke worlds.

3\. Canonical numeric defaults

NumericConfig:  
\- moneyEpsilon \= 1e-9  
\- quantityEpsilon \= 1e-9  
\- populationEpsilon \= 1e-6 persons  
\- rateEpsilon \= 1e-12  
\- reconciliationRelativeTolerance \= 1e-9  
\- maxFiniteMagnitude \= 1e15

Any value outside finite bounds fails validation; do not silently coerce NaN/Infinity.

CadenceConfig, one tick \= one month:  
\- productionLifecycleReviewEveryTicks \= 3  
\- investmentReviewEveryTicks \= 3  
\- clanDistributionEveryTicks \= 3  
\- fiscalPolicyReviewEveryTicks \= 3  
\- monetaryPolicyReviewEveryTicks \= 1  
\- expansionReviewEveryTicks \= 3  
\- stateFormationReviewEveryTicks \= 6  
\- benchmarkSnapshotEveryTicks \= 1

Cadence offsets are deterministic and entity-keyed: shouldRun(entityId, tick, cadence) uses a stable hash offset so every entity does not review on the same tick. Policy entities that must coordinate globally may use offset 0\.

4\. Markets defaults

MarketConfig baseline:  
\- basePriceAdjustmentSpeed \= 0.12 per tick in log-price space  
\- maxAbsoluteLogPriceMovePerTick \= 0.18  
\- shortageSignalWeight \= 0.65  
\- inventorySignalWeight \= 0.35  
\- expectationAlpha \= 0.25  
\- minimumPrice \= 0.01 currency units  
\- maximumPrice \= 1\_000\_000 currency units  
\- maxIntentBudgetShareOfWallet \= 1.0  
\- localClearingResidualTolerance \= quantityEpsilon  
\- affordabilityRevalidation \= true

Prices have no universal hard-coded “natural” price. GoodDefinition or Scenario MarketSeed supplies initial/reference prices. Clamps are safety rails only and must not be used as equilibrium targets.

The current repository’s BasicFoodPrice/BasicWoodPrice/BasicToolsPrice migrate into scenario MarketSeed initial prices; MaxPriceStep maps conceptually to maxAbsoluteLogPriceMovePerTick but must not be copied numerically because the clearing model changed. DemandElasticity/MinDemandMultiplier/MaxDemandMultiplier are not carried forward as one universal power curve; household substitution is owned by PopulationConfig and NeedDefinition weights.

5\. Trade and FX defaults

TradeConfig baseline:  
\- transportCapacityUtilizationTarget \= 0.80  
\- transportConditionMinimum \= 0.05  
\- shipmentMinimumQuantity \= 1e-6  
\- tradeOpportunityMinimumMarginShare \= 0.03  
\- tradeOpportunityMaximumRoutesPerGoodPerRegion \= 4  
\- maxExportShareOfAvailableSurplus \= 0.50  
\- defaultTransitTicksPerLink \= 1  
\- shipmentLossFromOrdinaryTrade \= 0; normal transport cost is explicit money/fee, while physical loss comes only from definitions/events unless a link explicitly declares ordinary attrition  
\- fxReservationSafetyShare \= 0.02  
\- fxRateAdjustmentSpeed \= 0.08  
\- fxMaxAbsoluteLogMovePerTick \= 0.12  
\- fxMinimumPoolReserve \= 1e-6

The repository’s TransportLossShare is rejected as the main cost mechanism because it destroys goods merely to avoid destroying money. Transport cost is now an explicit payment to the configured transport-fee receiver; physical losses are explicit shocks/attrition. TradePowerPerTrader and MaxDealsPerTurn are dropped because there is no separate trader-pop engine. MaxSurplusShareTraded maps to maxExportShareOfAvailableSurplus as a bounded safety control, not a profession mechanic.

6\. Production defaults

ProductionConfig baseline:  
\- baseTargetUtilization \= 0.70  
\- minTargetUtilization \= 0.10  
\- maxTargetUtilization \= 1.00  
\- targetSellThrough \= 0.80  
\- marginResponse \= 0.15  
\- sellThroughResponse \= 0.20  
\- inventoryResponse \= 0.25  
\- outputCoverageTicks \= 0.75  
\- inputCoverageTicks \= 1.0  
\- inputSafetyCoverageTicks \= 0.5  
\- productionSignalAlpha \= 0.25  
\- liquidityBufferShare \= 0.10  
\- minOperatingCash \= 0  
\- maxInputCriticality \= 4.0  
\- mothballAfterNonviableReviews \= 3  
\- reactivateAfterViableReviews \= 2  
\- closeAfterMothballedReviews \= 8  
\- minimumLifecycleScale \= 1e-6

Routine ProductionNoise from the current repository is dropped. Stochastic physical/economic disturbances belong to Events. SpecializationBonus and CapitalBonus are also dropped as generic multipliers: specialization must emerge from deposits, infrastructure, recipes, prices, labor and ownership decisions.

Recipe-owned defaults are not duplicated here: batchesPerCapitalUnit, input coefficients, laborPerBatch, investment goods, depreciation, resource extraction and infrastructure requirements belong to RecipeDefinition.

7\. Labor defaults

LaborConfig baseline:  
\- baselineParticipationRate \= 0.70 of WORKING population  
\- laborWageAttractivenessElasticity \= 0.50  
\- minWageWeight \= 0.50  
\- maxWageWeight \= 2.00  
\- wageAdjustmentSpeed \= 0.10  
\- maxWageMoveSharePerTick \= 0.10  
\- startingReferenceWage \= 10 currency units per worker-equivalent per tick unless ScenarioDefinition supplies a region-specific reference  
\- unemploymentWagePressure \= 0.40  
\- vacancyWagePressure \= 0.40  
\- minimumWorkingHealthFactor \= 0.50  
\- maximumWorkingHealthFactor \= 1.05

Core baseline has exactly one labor category GENERAL. Definition packs may add at most three broad categories in v1; adding recipe-specific professions requires a later design change.

8\. Population defaults

PopulationConfig baseline:  
\- consumptionBudgetShareLower \= 0.90  
\- consumptionBudgetShareMiddle \= 0.80  
\- consumptionBudgetShareUpper \= 0.70  
\- precautionaryCashFloorMonths \= 0.25  
\- needSubstitutionElasticity \= 0.60  
\- healthEmaAlpha \= 0.20  
\- prosperityEmaAlpha \= 0.15  
\- wageSignalAlpha \= 0.20  
\- baselineMonthlyBirthRate \= 0.0014 per person, applied only through the canonical eligible-population formula  
\- baselineMonthlyDeathRateChild \= 0.00035  
\- baselineMonthlyDeathRateWorking \= 0.00020  
\- baselineMonthlyDeathRateElder \= 0.0030  
\- maximumMortalityMultiplier \= 8.0  
\- healthMortalitySensitivity \= 2.0  
\- hungerMortalitySensitivity \= 3.0  
\- agingChildToWorkingMonthlyShare \= 1 / 216  
\- agingWorkingToElderMonthlyShare \= 1 / 540  
\- migrationReviewEveryTicks \= 1  
\- maxMigratingSharePerTick \= 0.02  
\- migrationUtilitySensitivity \= 1.5  
\- migrationNetworkWeight \= 0.20  
\- migrationDistancePenalty \= 0.10  
\- socialMobilityMaxSharePerTick \= 0.005  
\- cohortMergeMoneyTolerancePerPerson \= 0.02  
\- cohortMergeHealthTolerance \= 0.02  
\- cohortMergeProsperityTolerance \= 0.02

Need quantities, nutrition/health contribution, spoilage and substitute groups belong to GoodDefinition/NeedDefinition, not global config. The old FoodPerCapita/WoodPerCapita/ToolsPerCapita and spoilage fields migrate into definitions. TraderShare disappears with the old trader population type.

9\. Clan defaults

ClanConfig baseline:  
\- loyaltyAdjustmentSpeed \= 0.05 per tick  
\- relationProsperityWeight \= 0.35  
\- relationTaxBurdenWeight \= 0.20  
\- relationEmploymentWeight \= 0.20  
\- relationPolicyAffinityWeight \= 0.25  
\- migrationNetworkMaximumUtilityBonus \= 0.20  
\- dividendDistributionShare \= 0.60 of distributable clan cash  
\- ownerInjectionMaximumTreasurySharePerReview \= 0.20  
\- ownershipInvestmentPreferenceStrength \= 0.25  
\- influenceWealthExponent \= 0.50  
\- influencePopulationExponent \= 0.50  
\- influenceCapPerState \= 1.0

Clan preference traits may shift existing decision coefficients only inside explicitly documented bounds. No clan definition may contain direct production multipliers, free goods, free money, direct fertility buffs or direct political-control changes.

10\. Fiscal defaults

FiscalConfig baseline:  
\- householdWageTaxRate \= 0.10  
\- consumptionTaxRate \= 0.05  
\- businessProfitTaxRate \= 0.15  
\- tariffRate \= 0.05  
\- minimumTaxRate \= 0  
\- maximumOrdinaryTaxRate \= 0.50  
\- transferTargetShareOfMedianSubsistence \= 0.20  
\- automaticTransferPhaseOut \= 0.50  
\- publicProcurementBudgetShare \= 0.10 of available ordinary spending envelope  
\- infrastructureBudgetShare \= 0.10  
\- treasuryLiquidityFloorMonths \= 1.0 of recent ordinary expenditure  
\- debtTargetRevenueMultiple \= 1.0  
\- softDebtStressRevenueMultiple \= 2.0  
\- hardDebtStressRevenueMultiple \= 4.0  
\- defaultBondMaturityTicks \= 60  
\- defaultBondCouponSpread \= 0.02 annualized above current relevant policy/reference rate  
\- policyAdjustmentStep \= 0.01 for rate-like tax parameters per fiscal review unless a subsystem field specifies another bound  
\- emergencySpendingMaximumRevenueShare \= 0.25

These are baseline starting policies, not immutable world rules. Scenario StateSeed may specify initial policy values within validation bounds. States change policy only through the fiscal/law contract and PendingTransitions.

11\. Monetary defaults

MonetaryConfig baseline:  
\- annualNeutralPolicyRate \= 0.03  
\- annualMinimumPolicyRate \= 0.00  
\- annualMaximumPolicyRate \= 0.20  
\- inflationTargetAnnual \= 0.02  
\- policyInflationResponse \= 1.25  
\- policyActivityResponse \= 0.25  
\- policyInertia \= 0.75  
\- maxAnnualizedPolicyRateMovePerMonthlyReview \= 0.02  
\- cpiMinimumObservedExpenditureShare \= 0.01  
\- cpiChainMinimumBasketWeight \= 1e-6  
\- omoMaximumOutstandingDebtSharePerReview \= 0.10  
\- omoLiquidityResponse \= 0.20  
\- fxPressureTradeWeight \= 1.0  
\- fxPressurePortfolioWeight \= 0.25

Rates stored on MonetaryAuthorityState are annualized unless the field is explicitly named perTick; formulas must convert before tick-level accrual. No private bank credit defaults exist in core v1.

12\. Expansion defaults

ExpansionConfig baseline:  
\- maximumOrganizedSettlementPopulationSharePerProject \= 0.05 of sponsoring population pool  
\- maximumSpontaneousMigrationSharePerTick \= population.maxMigratingSharePerTick  
\- minimumSettlementProjectDurationTicks \= 3  
\- settlementInvestmentRetentionShare \= 1.0; goods used in settlement convert into settlementLevel/infrastructure according to explicit project recipe, not vanish without accounting  
\- marketActivationPopulationThreshold \= 50 persons  
\- marketDormancyPopulationThreshold \= 10 persons  
\- stateFormationMinimumPopulation \= 500 persons  
\- stateFormationMinimumSettlementLevel \= 1.0  
\- stateFormationMinimumIsolationTicks \= 24  
\- abandonmentPopulationThreshold \= 1 person  
\- surveyDiscoveryBaseProbabilityPerReview \= 0.20, conditional on a SurveyProject and only for already-existing deposits  
\- carryingCapacityMinimum \= 1 person

Region count is fixed by ScenarioDefinition. Expansion never generates new Region IDs at runtime.

13\. Event defaults

EventConfig baseline:  
\- globalHazardScale \= 1.0  
\- maximumNewStochasticEventsPerTick \= 3  
\- maximumConcurrentEventsPerRegion \= 4  
\- minimumSeverity \= 0.05  
\- maximumSeverity \= 1.0  
\- minimumDurationTicks \= 1  
\- maximumDurationTicks \= 24  
\- defaultSpatialDecayPerGraphHop \= 0.50  
\- sameDefinitionRegionCooldownTicks \= 12  
\- physicalLossTolerance \= quantityEpsilon

Actual hazard rates, severity distributions, durations, eligibility and ShockOperations belong to EventDefinition. Configuration only supplies global safety/budget controls.

14\. Performance defaults and hard budgets

PerformanceConfig baseline:  
\- targetRegions \= 24  
\- supportedRegionsSoftMax \= 64  
\- targetStates \= 4  
\- targetClans \= 8  
\- targetCohorts \= 500  
\- supportedCohortsSoftMax \= 2\_000  
\- targetProductionUnits \= 250  
\- supportedProductionUnitsSoftMax \= 1\_000  
\- targetGoods \= 8  
\- supportedGoodsSoftMax \= 16  
\- targetTransportLinks \= 60  
\- supportedTransportLinksSoftMax \= 256  
\- maximumLiveShipments \= 5\_000  
\- maximumAtomicDebugTransactionsPerTick \= 100\_000  
\- snapshotRetentionTicks \= 240 for UI/history unless persistent export is requested  
\- benchmarkCoreTickBudgetMs \= 50 at target scale in a modern desktop browser worker after warmup  
\- benchmarkP95TickBudgetMs \= 100 at target scale

Soft maxima trigger diagnostics, not economic behavior changes. Hard safety caps may abort a run with an explicit error but may never silently delete entities or skip transactions.

15\. Definition pack baseline

The canonical baseline definition pack should remain small: 6–8 goods and roughly 8–14 recipes. Recommended functional good roles:  
1\. FOOD — basic subsistence, perishable.  
2\. RAW\_MATERIAL — generic extractive/agricultural non-food input.  
3\. CONSTRUCTION\_MATERIAL — settlement/infrastructure/capital input.  
4\. TOOLS — intermediate productivity/capital-chain input.  
5\. BASIC\_CONSUMER\_GOOD — non-food household need.  
6\. CAPITAL\_GOOD — investment input.  
Optional only if benchmarks show clear value:  
7\. FUEL\_OR\_ENERGY\_INPUT.  
8\. LUXURY\_CONSUMER\_GOOD.

Do not encode one good per historical commodity. More variety should first come from region deposits, recipes, costs, clan ownership and policy rather than a large item taxonomy.

Each GoodDefinition must include:  
\- id, name, unitLabel;  
\- storage/spoilage rate per tick;  
\- consumer need category or null;  
\- necessityWeight and substitutionGroup where consumed by households;  
\- referencePrice used only for initialization/diagnostics, never as an equilibrium anchor;  
\- tradable flag;  
\- capital/infrastructure eligibility tags where relevant.

16\. Scenario seed schemas

interface RegionSeed {  
  key: string;  
  name: string;  
  controllerStateKey: string | null;  
  settlementCurrencyKey: string;  
  settlementLevel: number;  
  infrastructure: Record\<string, number\>;  
  climateHabitabilityInputs: Record\<string, number\>;  
  deposits: Array\<{ resourceId: string; initialQuantity: number; initiallyKnown: boolean }\>;  
}

interface TransportLinkSeed {  
  key: string;  
  fromRegionKey: string;  
  toRegionKey: string;  
  bidirectional?: boolean;  
  distance: number;  
  baseCapacity: number;  
  condition: number;  
  baseTransportCost: number;  
  transitTicks?: number;  
  feeReceiverStateKey?: string | null;  
}

interface StateSeed {  
  key: string;  
  name: string;  
  treasury: Record\<string, number\>;  
  publicInventory: Record\<string, number\>;  
  policy: StatePolicySeed;  
  effectiveCurrencyRegime: CurrencyRegimeSeed;  
}

interface CurrencyRegimeSeed {  
  currencyKey: string;  
  regimeType: 'INDEPENDENT\_FLOAT' | 'MONETARY\_UNION' | 'FOREIGN\_LEGAL\_TENDER';  
  policyAuthorityKey: string | null;  
}

interface CurrencySeed {  
  key: string;  
  code: string;  
  issuerAuthorityKey: string | null;  
}

interface MonetaryAuthoritySeed {  
  key: string;  
  currencyKey: string;  
  memberStateKeys: string\[\];  
  wallet: Record\<string, number\>;  
  policyRateAnnual?: number;  
  fxPools: FxPoolSeed\[\];  
}

interface ClanSeed {  
  key: string;  
  name: string;  
  treasury: Record\<string, number\>;  
  preferences: ClanPreferenceState;  
  initialRelations?: Record\<string, ClanStateRelationSeed\>;  
}

interface CohortSeed {  
  key: string;  
  regionKey: string;  
  clanKey: string;  
  ageBand: 'CHILD' | 'WORKING' | 'ELDER';  
  stratum: 'VULNERABLE' | 'WORKING\_MIDDLE' | 'AFFLUENT';  
  laborCategory: string; // baseline GENERAL  
  population: number;  
  wallet: Record\<string, number\>;  
  householdInventory: Record\<string, number\>;  
  healthIndex: number; // \[0,1\]  
  prosperityEma: number; // \[0,1\]  
  essentialSatisfactionEma: number; // \[0,1\]  
  realIncomePerCapitaEma: number; // normalized \>= 0  
  employmentRateEma: number; // \[0,1\]  
  migrationPressureEma: number; // bounded \[-1,1\]  
  mobilityAccumulator: number; // bounded \[-1,1\]  
  wageSignal: number; // settlement-currency units / worker-equivalent / tick  
}

interface ProductionUnitSeed {  
  key: string;  
  regionKey: string;  
  owner: { type: 'CLAN'; key: string } | { type: 'STATE'; key: string };  
  recipeId: string;  
  status: 'ACTIVE' | 'PLANNED' | 'MOTHBALLED';  
  wallet: Record\<string, number\>;  
  inputInventory: Record\<string, number\>;  
  outputInventory: Record\<string, number\>;  
  investmentInventory?: Record\<string, number\>;  
  installedCapital: number;  
  condition: number;  
  wageOffer?: number;  
}

interface MarketSeed {  
  regionKey: string;  
  initialPriceByGood: Record\<string, number\>;  
}

CohortSeed uses the same mature cohort vocabulary as PopulationCohortState. Seed files must provide every persistent cohort signal listed above explicitly; world generation must not translate legacy LOWER/MIDDLE/UPPER strata, rename prosperity fields, or invent omitted cohort-state defaults. Human-readable seed keys are converted to persistent IDs with deterministic prefixes during world construction. Scenario files must never embed runtime sequence-dependent IDs.

17\. Default baseline world profile

## Canonical baseline scenario

Provide one checked-in scenario named baseline-multistate-v1 used for demos and most golden tests:  
\- 24 fixed Regions arranged as a sparse connected graph, not a complete graph;  
\- 4 initial States controlling most but not necessarily all Regions;  
\- 4 currencies and 4 MonetaryAuthorities in the baseline profile so state-specific policy/FX are exercised from tick 1;  
\- 8 Clans distributed across more than one State, with at least two cross-border diaspora patterns;  
\- approximately 400–600 starting cohorts after grouping;  
\- 150–300 ProductionUnits spanning all baseline recipes;  
\- at least one resource-rich peripheral Region, one trade chokepoint, one diversified urban Region and one sparsely settled frontier Region;  
\- no starting event by default;  
\- enough initial inventories/cash for 2–3 months of ordinary operations so bootstrap failure is not guaranteed, but not enough to mask shortages;  
\- positive trade incentives at initialization without making every route profitable.

The baseline must be hand-authored/topology-authored data with bounded seeded numeric variation, not a fully procedural random map. This produces intelligible regression failures and reproducible visual stories.

18\. Deterministic bounded scenario variation

Optional variation exists to prevent every seed from being identical while preserving scenario identity.

interface ScenarioVariationConfig {  
  enabled: boolean;  
  populationFactorRange?: \[number, number\];  
  depositQuantityFactorRange?: \[number, number\];  
  startingInventoryFactorRange?: \[number, number\];  
  startingCashFactorRange?: \[number, number\];  
  infrastructureFactorRange?: \[number, number\];  
}

Recommended baseline ranges when enabled:  
\- populationFactorRange \= \[0.95, 1.05\]  
\- depositQuantityFactorRange \= \[0.90, 1.10\]  
\- startingInventoryFactorRange \= \[0.95, 1.05\]  
\- startingCashFactorRange \= \[0.95, 1.05\]  
\- infrastructureFactorRange \= \[0.98, 1.02\]

Use keyed deterministic draws such as rng(seed, 'worldgen', scenarioId, entityKey, fieldName). Never advance one global mutable RNG through scenario arrays. Variation may scale declared numeric seed values only. It may not randomly add/remove States, Regions, Clans, currencies, recipes, transport links or ownership relationships in baseline v1.

19\. buildInitialWorld canonical order

buildInitialWorld(runOptions, configProfile, scenario, definitionPack) executes exactly:  
1\. Validate schema versions, uniqueness, references, finite values and config bounds, including complete CurrencySeed ↔ MonetaryAuthoritySeed ↔ StateSeed.effectiveCurrencyRegime consistency.  
2\. Resolve stable runtime IDs from sorted human keys. Reserve nextDynamicStateSequence after static State IDs.  
3\. Instantiate Currency and MonetaryAuthority registries, preserving the issuer and member-State links already validated from scenario seeds.  
4\. Instantiate Regions with deposits/infrastructure/settlement state but no derived carrying-capacity cache.  
5\. Instantiate TransportLinks and expand bidirectional seeds into two explicit directed links with deterministic IDs.  
6\. Instantiate States, resolve StateSeed.effectiveCurrencyRegime keys to canonical IDs, and apply starting jurisdiction from RegionSeed. Region.controllerStateId is the sole canonical jurisdiction stock.  
7\. Instantiate Clans and state relations.  
8\. Instantiate Cohorts, applying bounded keyed variation and normalized sparse wallets/inventories.  
9\. Instantiate LocalMarkets; each Region receives exactly one market. Missing MarketSeed prices fall back to GoodDefinition.referencePrice.  
10\. Instantiate ProductionUnits; derive capacity from installedCapital × recipe.batchesPerCapitalUnit and initialize neutral signal EMAs.  
11\. Instantiate bonds/holdings if declared; otherwise debt starts at zero.  
12\. Instantiate FX pools and validate that both reserve sides are explicit money stocks owned by the authority/pool contract.  
13\. Instantiate explicitly scheduled starting events only; no stochastic event is realized during construction.  
14\. Initialize empty shipments and PendingTransitions.  
15\. Build immutable DefinitionRegistry and resolved SimulationConfig.  
16\. Create WorldGenesisLedger, normalize all sparse maps and run every core/subsystem initialization invariant.  
17\. Compute the first derived diagnostic snapshot without mutating canonical economic stocks.

No Phase 0–15 economic tick runs during initialization. Tick 0 is the post-genesis, pre-first-month state.

20\. WorldGenesisLedger and opening accounting

Starting assets are scenario endowments, not unexplained runtime creation. The constructor records them separately from normal EconomicTransaction history:

interface GenesisRecord {  
  type: 'MONEY\_ENDOWMENT' | 'GOOD\_ENDOWMENT' | 'POPULATION\_ENDOWMENT' | 'CAPITAL\_ENDOWMENT' | 'RESOURCE\_ENDOWMENT' | 'BOND\_OPENING\_POSITION';  
  owner?: ActorRef;  
  regionId?: RegionId;  
  currencyId?: CurrencyId;  
  goodId?: GoodId;  
  amount: number;  
  sourceSeedKey: string;  
}

Genesis records explain opening balance-sheet stocks but do not pretend that a historical counterparty transaction occurred before tick 0\. For every currency, sum actor/pool opening balances must exactly equal opening transaction money reported by the monetary diagnostic. For every good, opening inventories \+ capital-converted goods already represented as capital \+ shipments(0) must match genesis goods after documented conversion. Resource deposits are natural endowments and are not market inventory.

## 21\. Validation rules

Configuration validation fails fast on:  
\- negative rates/quantities where forbidden;  
\- min \> max;  
\- EMA alpha outside (0,1\];  
\- probability/share outside \[0,1\] unless explicitly allowed;  
\- cadence \< 1;  
\- soft maxima below target values;  
\- unknown Good/Recipe/Event/Metric IDs;  
\- any scenario reference to missing Region/State/Clan/Currency/Authority key;  
\- duplicate keys;  
\- Region without exactly one LocalMarket seed/resolution;  
\- Market price \<= 0;  
\- ProductionUnit installedCapital \< 0 or condition outside \[0,1\];  
\- recipe extraction referring to a resource absent from all eligible regions when the baseline expects that recipe to operate;  
\- authority issuing more than one currency unless a future explicit contract permits it;  
\- State effectiveCurrencyRegime.currencyKey missing or inconsistent with the referenced Currency/Authority;  
\- FOREIGN\_LEGAL\_TENDER with non-null policyAuthorityKey or with the State present in any MonetaryAuthoritySeed.memberStateKeys;  
\- INDEPENDENT\_FLOAT or MONETARY\_UNION whose policyAuthorityKey does not equal the referenced CurrencySeed.issuerAuthorityKey, or whose State is absent from that authority's memberStateKeys;  
\- any State listed in more than one MonetaryAuthoritySeed.memberStateKeys, or any authority member whose State effectiveCurrencyRegime points to a different currency/authority;  
\- bond holdings not summing to principal;  
\- cohort population \<= 0 after normalization;  
\- inaccessible controlled Region with no graph path when scenario declares it economically connected;  
\- initial money/goods stocks that fail genesis reconciliation.

Warnings, not failures:  
\- target-scale performance budget exceeded by scenario size;  
\- initial market price more than 10× Definition referencePrice;  
\- a State starts with zero fiscal revenue base;  
\- a good has no producer or no consumer anywhere;  
\- graph contains isolated unclaimed frontier Region by intentional scenario design.

22\. Canonical config serialization and overrides

Configuration and scenario files should be JSON or TypeScript data validated at startup with a schema library. Identity hashes must use one canonical content-digest procedure, not runtime/object hash behavior. First normalize schema-defined unordered keyed collections by stable key/id while preserving arrays whose order is semantically meaningful; normalize \-0 to 0 and exclude transient/runtime-only fields. Then serialize canonical JSON with lexicographically ordered object keys and deterministic JSON number/string encoding (RFC 8785/JCS or an exactly equivalent implementation) and compute SHA-256 over the UTF-8 bytes. Compute scenarioHash from the full validated ScenarioDefinition, configHash from the fully resolved frozen SimulationConfig after overrides, and definitionPackHash from the full validated DefinitionPack. Declaration-order-only changes must not change these hashes, but any material content change must. Never use process-local GetHashCode/Object.hashCode, insertion order, memory addresses, wall-clock values or random UUIDs for persisted run identity. Every run records:  
\- configVersion and configHash;  
\- scenario id/version and scenarioHash;  
\- definitionPack id/version and definitionPackHash;  
\- seed;  
\- engineBuildId (stable version/commit/source-build identity).

RunMetadata.runIdentity is SHA-256 over a canonical named identity object containing scenarioId, scenarioHash, seed, configHash, definitionPackHash and engineBuildId. Do not concatenate raw values without field names/separators. A build identity must be deterministic for the executable/source being run. Release/CI builds should use version plus commit SHA; a local dirty build needs a deterministic source fingerprint or must be treated as non-resumable across Worker restarts rather than pretending that "dirty" identifies identical code.

Developer/test overrides use a deep partial ConfigOverride only before world creation. The resolved config is frozen afterward. UI may expose preset selection and seed, but core v1 UI must not live-edit economic constants mid-run; changing config starts a new run.

23\. Repository migration

Current SimulationConfig.cs contains valuable discipline: nearly every tunable number is centralized. Preserve that principle, but not the old semantics.

Migration mapping:  
\- Seed \-\> RunOptions.seed.  
\- ProductionNoise \-\> DROP; Events owns stochastic shocks.  
\- SpecializationBonus, CapitalBonus \-\> DROP; replace with explicit deposits/infrastructure/recipes.  
\- FoodPerCapita/WoodPerCapita/ToolsPerCapita \-\> Good/Need definitions.  
\- FoodSpoilage/WoodSpoilage/ToolsSpoilage \-\> GoodDefinition spoilage.  
\- Basic\*Price \-\> baseline Scenario MarketSeed / GoodDefinition referencePrice.  
\- MaxPriceStep \-\> MarketConfig log-price move bound, recalibrated.  
\- MinPrice/MaxPrice \-\> MarketConfig safety clamps.  
\- DemandElasticity and min/max demand multipliers \-\> Population need substitution/budget rules; do not mechanically map values.  
\- StartingMoneyPerCapita \-\> Scenario CohortSeed wallets or a scenario helper that materializes explicit opening balances.  
\- TraderCapitalMultiplier, TraderShare, TradePowerPerTrader, MaxDealsPerTurn \-\> DROP with trader-pop engine.  
\- TransportLossShare \-\> DROP as generic money-conservation workaround; explicit fee receiver/event physical losses replace it.  
\- MaxSurplusShareTraded \-\> TradeConfig.maxExportShareOfAvailableSurplus.  
\- Epsilon \-\> NumericConfig typed tolerances.

Do not retain both old and new config paths after migration. Temporary compatibility adapters are allowed only behind tests and must be deleted by the milestone that switches the canonical engine.

24\. Required initialization invariants

At minimum test these invariants on every scenario build:  
1\. Same scenario/config/seed serializes identically.  
2\. Different seed changes only fields declared variable by ScenarioVariationConfig.  
3\. All IDs are unique and reference-valid.  
4\. Region registry cardinality never depends on seed.  
5\. Every Region owns exactly one LocalMarket.  
6\. Every controlled Region points to one live State.  
7\. Every cohort belongs to one Region and one Clan.  
8\. Cohort population, wallet and inventories are non-negative finite stocks.  
9\. Production capacity exactly matches installedCapital × recipe coefficient within tolerance.  
10\. Production owner references exactly one Clan or State.  
11\. Sum bond holdings equals bond principal.  
12\. Each currency’s opening money diagnostic equals all opening balances under its money-supply contract.  
13\. FX pool reserves are included once, not duplicated in authority wallet and pool accounting.  
14\. No initial shipment exists unless ScenarioDefinition explicitly declares a future extension that supports it; baseline starts with zero.  
15\. PendingTransitions is empty at tick 0\.  
16\. No stochastic EventInstance is realized during world generation.  
17\. Resource discovery never alters deposit quantity.  
18\. Good genesis reconciliation closes.  
19\. Definition registry is immutable after construction.  
20\. Resolved SimulationConfig is immutable after construction.  
21\. Dynamic State sequence cannot collide with static IDs.  
22\. Directed transport-link expansion is deterministic.  
23\. No UI snapshot or derived metric mutates WorldState.  
24\. Tick 0 has no normal EconomicTransaction records.  
25\. Every State.effectiveCurrencyRegime resolves to an existing Currency; policyAuthorityId is null exactly for FOREIGN\_LEGAL\_TENDER in core v1.  
26\. Every policy-member State appears exactly once in the matching MonetaryAuthority.memberStateIds and uses that authority's currency; every FOREIGN\_LEGAL\_TENDER State appears in none.  
27\. Currency.issuerAuthorityId and MonetaryAuthority.currencyId are reciprocal when an issuer exists; foreign-legal-tender use never changes the Currency issuer.

25\. Required tests

Unit tests:  
\- rejects duplicate scenario keys;  
\- rejects missing references;  
\- rejects invalid config share/rate/alpha/cadence bounds;  
\- stable ID generation independent of declaration order;  
\- sparse zero normalization;  
\- market-price fallback to referencePrice;  
\- capacity derivation from installed capital;  
\- bidirectional link expansion;  
\- authority/currency/State effective-regime consistency validation;  
\- rejects FOREIGN\_LEGAL\_TENDER with non-null policy authority or authority membership;  
\- rejects duplicate State membership across authorities or membership mismatched to the Currency issuer;  
\- foreign-legal-tender successor-compatible scenario validation;  
\- genesis money reconciliation;  
\- genesis good reconciliation;  
\- keyed variation independence from array order;  
\- canonical scenario/config/definition-pack hashes are declaration-order independent for schema-defined unordered keyed collections;  
\- changing any material ScenarioDefinition field changes scenarioHash even if id/version is accidentally unchanged;  
\- changing resolved config or DefinitionPack content changes configHash/definitionPackHash and therefore runIdentity;  
\- canonical identity hashes are stable across process/runtime enumeration order and never depend on process-local hash functions;  
\- seed changes only authorized variable fields;  
\- config freeze after construction;  
\- definition freeze after construction.

Golden scenarios:  
A. one-region closed economy — no FX/trade, all identities close at tick 0\.  
B. two-state/two-currency trade pair — finite FX pools initialized correctly.  
C. resource-specialized three-region chain — explicit comparative starting conditions without a specialization bonus.  
D. monetary union scenario — multiple States, one authority/currency, no contradictory regime.  
E. foreign-legal-tender frontier — controlled/uncontrolled regions and settlement currency remain valid.  
F. opening sovereign debt — StateBond and multiple BondHolding assets reconcile.  
G. same-seed replay — normalized tick-0 state is byte-identical.  
H. declaration-order permutation — shuffled scenario arrays produce byte-identical state.

26\. Complexity

World construction complexity should be O(R \+ L \+ S \+ C \+ H \+ U \+ G \+ B \+ F), where R regions, L links, S states, C clans, H cohorts, U production units, G goods and definitions referenced, B bonds/holdings and F FX pools. Validation may add O(L \+ R) graph traversal. No all-pairs shortest-path computation is required at genesis; route algorithms operate over sparse links later.

At baseline target scale, world generation and validation should complete well below one normal UI interaction frame budget on desktop, but correctness is more important than startup micro-optimization. Heavy benchmark validation may run in test/debug mode.

27\. User-draft disposition in this unit

The four user drafts are already globally incorporated by USER\_DRAFT\_SYNTHESIS; this configuration unit preserves their useful intent while preventing draft-era mechanics from leaking back as constants:  
\- production chains remain explicit recipes and resource-dependent initial geography;  
\- clans remain world seeds with preferences, wealth and diaspora distributions;  
\- clan/location distinctions come from population placement, ownership, resource access and bounded preferences, not arbitrary clan production buffs;  
\- trade remains route/local-market driven but trader-pop capacity, order-dependent deals and universal trade bonuses are rejected;  
\- scenario data may create asymmetric starting conditions, but all post-tick-0 advantages must propagate through normal economic stocks/flows.

28\. Definition of done for implementation

This configuration/world-generation layer is complete when Codex/Claude can add a new deterministic scenario by editing data only, run schema validation, construct tick-0 WorldState, obtain a genesis accounting report, and start the canonical Phase 0–15 simulation without modifying subsystem code or deciding new economic mechanics.  
