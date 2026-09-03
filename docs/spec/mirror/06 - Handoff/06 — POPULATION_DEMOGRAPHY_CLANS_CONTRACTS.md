POPULATION, DEMOGRAPHY AND CLANS CONTRACTS — Economic Simulation

Status: implementation-grade subsystem contract v1. Authoritative together with CORE\_SCHEMA\_AND\_LIFECYCLES, MARKETS\_TRADE\_FX\_CONTRACTS and PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS. This document converts the mature POPULATION\_AND\_DEMOGRAPHY and CLANS\_AND\_SOCIETY designs into exact runtime contracts for cohort state, household demand, welfare/health, labor-supply inputs, wage receipts, demography, migration, social mobility, clan treasury, ownership funding, distributions, loyalty and influence. It does not redefine Phase-3 labor allocation, Phase-5 wage settlement, market clearing, fiscal policy formation, monetary policy or expansion feasibility.

1\. Implementation objective

Core v1 must make people economically consequential without simulating individual persons or households. PopulationCohort is the unique population-bearing stock owner. Clan is a persistent meso-level identity/ownership/political actor, not a second population system. State and Clan population totals are always derived from cohorts.

Repository/draft migration boundary: the historical drafts mix clan population, production, preferences, settlement and trade in several incompatible forms. Preserve clans as persistent population-bearing identities, geographic concentration, production ownership, wealth/influence, explicit production chains and migration/network effects; rework them into Cohort \+ Clan \+ ProductionUnit relations; reject mutable duplicate clan-population stocks, clan-direct production, arbitrary per-turn influence generation, direct productivity/birth-rate trait bonuses, individual households and bespoke shopping loops.

One tick \= one month. All rates in this document are per-tick unless explicitly annualized and converted. No stored or derived value may be NaN or Infinity.

2\. Canonical PopulationCohort schema

CORE\_SCHEMA PopulationCohortState is concretized as:

interface PopulationCohortState {  
  id: CohortId;  
  regionId: RegionId;  
  clanId: ClanId;  
  ageBand: 'CHILD' | 'WORKING' | 'ELDER';  
  stratum: 'VULNERABLE' | 'WORKING\_MIDDLE' | 'AFFLUENT';  
  laborCategory: string; // baseline GENERAL  
  population: number; // persons \>= 0  
  wallet: Wallet;  
  householdInventory: Inventory; // consumption carryover only  
  healthIndex: number; // \[0,1\]  
  prosperityEma: number; // \[0,1\]  
  essentialSatisfactionEma: number; // \[0,1\]  
  realIncomePerCapitaEma: number; // normalized \>=0  
  employmentRateEma: number; // \[0,1\]  
  migrationPressureEma: number; // bounded \[-1,1\]  
  mobilityAccumulator: number; // bounded \[-1,1\]  
  wageSignal: number; // settlement-currency units / worker-equivalent / tick  
}

Cohort identity key is exactly regionId × clanId × ageBand × stratum × laborCategory. Employer is never part of identity. Cohorts with identical identity key must be merged deterministically after all Phase-13 transitions. Zero-population cohorts are removed at close unless retained only by a migration target reservation in the same tick.

Population is an aggregate nonnegative real in core v1. Do not round births/deaths/migration each tick; rounding at cohort scale creates systematic small-population drift. UI may display rounded persons.

3\. Cohort accounting invariants

For each source cohort boundary in one tick:  
openingPopulation \+ births \+ inboundMigration \+ inboundReclassification \= closingPopulation \+ deaths \+ outboundMigration \+ outboundReclassification.

At world level:  
openingWorldPopulation \+ births \= closingWorldPopulation \+ deaths.

Migration and reclassification must cancel world-wide. No State, Clan or Region may own an independent mutable population stock.

Wallet and inventory transfers caused by migration are transfers between cohorts; they never create money or goods.

4\. Need categories and household demand

DefinitionRegistry.needCategories must support exactly four baseline categories:  
ESSENTIAL\_FOOD, BASIC\_GOODS, SERVICES, COMFORT.

interface NeedCategoryDefinition {  
  id: string;  
  perCapitaTarget: number;  
  priority: number;  
  minimumBudgetShare?: number;  
  substitutionGoods: Array\<{goodId: GoodId; basePreference: number; qualityFactor: number}\>;  
  priceSensitivity: number;  
  inventoryCarryoverTicks: number;  
}

SERVICES may be represented either by an explicit service good or by effectiveServiceCoverage supplied from the fiscal/production read model. Do not run two representations simultaneously in one scenario.

Phase-2 creates HouseholdConsumptionPlan for every positive-population cohort:

interface HouseholdConsumptionPlan {  
  planId: string;  
  cohortId: CohortId;  
  tick: number;  
  settlementCurrencyId: CurrencyId;  
  openingSpendableCash: number;  
  expectedCurrentTickIncome: number; // conservative; wages are not spendable until actually received  
  liquidityFloor: number;  
  categoryBudgets: Record\<string, number\>;  
  intendedUsefulConsumption: Record\<string, number\>;  
  marketIntentIds: MarketIntentId\[\];  
}

Phase-2 planning reads prior-close prices, prior employment/wage signals, opening wallet, current cohort size and effective policy. It must not spend current-tick wages before Phase 5 settlement.

The cohort reserves a liquidity floor first:  
liquidityFloor \= max(minHouseholdCashPerCapita × population, liquidityFloorShare × openingHomeCash)  
planningCashEnvelope \= max(0, openingHomeCash \+ conservativeExpectedTransferIncome \- liquidityFloor)

Baseline conservativeExpectedTransferIncome excludes uncertain Clan distributions and discretionary State transfers not already committed. It may include deterministic transfer entitlements if STATE\_FISCAL has already committed them before market planning.

Budget allocation is sequential across need categories only:  
1\) ESSENTIAL\_FOOD up to affordable target cost;  
2\) BASIC\_GOODS and SERVICES to configured minimum shares/targets;  
3\) remaining budget to COMFORT and optional small inventory replenishment.

This sequence must never determine buyer priority in market clearing. Every resulting purchase is a canonical BUY MarketIntent and participates in proportional clearing.

5\. Product substitution

For each need category c and candidate good g:  
weight\_g \= effectivePreference\_g × qualityFactor\_g / max(expectedGrossBuyerPrice\_g, moneyEpsilon)^priceSensitivity\_c  
share\_g \= weight\_g / Σ weight  
nominalDemand\_g \= categoryBudget\_c × share\_g  
quantityDemand\_g \= nominalDemand\_g / max(expectedGrossBuyerPrice\_g, moneyEpsilon)

effectivePreference\_g \= basePreference\_g × boundedClanTasteFactor where allowed by Section 18\.

ESSENTIAL\_FOOD must have weak or zero clan taste effects and high price sensitivity. COMFORT may have stronger bounded taste variation. No CES solver, discrete household basket search or order-dependent shopping loop exists in v1.

MarketIntent fields:  
actor \= Cohort  
regionId \= cohort.regionId  
goodId \= g  
side \= BUY  
purpose \= CONSUMPTION  
desiredQuantity \= quantityDemand\_g  
maxSpend \= nominalDemand\_g  
sourcePlanId \= HouseholdConsumptionPlan.planId

6\. Consumption and household inventory

Market purchases settle through MARKETS\_TRADE\_FX\_CONTRACTS. On receipt, consumer goods enter cohort.householdInventory. Phase 9 consumes goods from inventory up to useful need targets.

For category c:  
required\_c \= population × perCapitaTarget\_c  
realizedUsefulConsumption\_c \= Σ usefulEquivalent(g,c) consumed this tick  
coverage\_c \= min(1, realizedUsefulConsumption\_c / max(required\_c, quantityEpsilon))

Carryover is bounded by category inventoryCarryoverTicks. Excess perishable stock above maxCarryover \= required\_c × inventoryCarryoverTicks is physically spoiled in Phase 9 and recorded as HOUSEHOLD\_SPOILAGE goods destruction. Durable/basic carryover may use a larger configured window. Core v1 has no household resale market.

Essential coverage:  
essentialCoverage \= min(foodCoverage, 0.5 × foodCoverage \+ 0.5 × basicCoverage)

Comfort coverage is welfare-only and may not materially affect mortality.

7\. Phase-5 wage receipts and employment evidence

PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS owns LaborSupplyPlan, LaborDemandPlan, LaborAllocation and wage settlement. Population code consumes those outputs; it does not re-match jobs.

For cohort i:  
employedWorkers\_i \= Σ allocations workerEquivalents for cohort i  
availableWorkers\_i \= LaborSupplyPlan.availableWorkerEquivalents  
employmentRate\_i \= availableWorkers\_i \<= epsilon ? 0 : clamp01(employedWorkers\_i / availableWorkers\_i)

grossWageIncome\_i \= Σ allocations grossWageObligation  
netWageReceipt\_i \= Σ wage settlement cohortCredit  
wageTaxWithheld\_i \= grossWageIncome\_i \- netWageReceipt\_i, subject to explicit non-wage deductions if later modeled.

Population must validate that its net wage receipt equals the Phase-5 transaction ledger. It must not recompute tax.

8\. LaborSupplyPlan generation

Only WORKING cohorts submit normal labor supply. Population owns the following calculation consumed by Production:

potentialWorkers \= population × workingEligibility × participationRate  
availableWorkerEquivalents \= clamp(potentialWorkers, 0, population)

participationRate \= clamp(  
  baseParticipation\[stratum\]  
  × healthParticipationFactor(healthIndex)  
  × lawParticipationFactor  
  × weakOpportunityFactor,  
  minParticipation,  
  maxParticipation  
)

Recommended healthParticipationFactor range \[0.75,1.02\]. weakOpportunityFactor must be EMA-based and tightly bounded, e.g. \[0.9,1.05\], so participation does not become a volatile labor-leisure optimizer.

CHILD and ELDER normal labor supply is zero in baseline scenarios. Laws may alter workingEligibility but must not mutate ageBand.

Population emits the canonical LaborSupplyPlan already defined by PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS. No second labor-market object is introduced.

9\. Wage signal update

The cohort wageSignal is a planning/participation reference, not a contract wage.

For WORKING cohort:  
realizedGrossWagePerWorker \= grossWageIncome / max(employedWorkers, workerEpsilon)  
regionalReferenceWage \= weighted mean realized wage for compatible labor category, falling back to prior wage signal.

targetWageSignal \= employedWorkers \> epsilon ? realizedGrossWagePerWorker : regionalReferenceWage  
wageSignalNext \= wageSignal × exp(clamp(wageSignalAdjustmentSpeed × ln(max(targetWageSignal,moneyEpsilon)/max(wageSignal,moneyEpsilon)), \-maxWageSignalStep, \+maxWageSignalStep))

This signal must not override ProductionUnit wage offers.

10\. Welfare, real income and prosperity

Phase-15 statistics derive disposableNominalIncome from explicit wage, transfer, Clan distribution and tax transactions.

localEssentialBasketPriceIndex is a prior/close price-index input defined by the Statistics/Monetary layer.  
realIncomePcRaw \= disposableNominalIncome / max(localEssentialBasketPriceIndex × population, moneyEpsilon)  
normalizedRealIncomePc \= saturatingNormalize(realIncomePcRaw, scenarioRealIncomeScale)

P\_raw \= 0.35 × essentialCoverage  
      \+ 0.25 × normalizedRealIncomePc  
      \+ 0.15 × employmentRate  
      \+ 0.20 × healthIndex  
      \+ 0.05 × comfortCoverage

prosperityEmaNext \= ema(prosperityEma, clamp01(P\_raw), prosperityAlpha)  
essentialSatisfactionEmaNext \= ema(essentialSatisfactionEma, essentialCoverage, essentialAlpha)  
realIncomePerCapitaEmaNext \= ema(realIncomePerCapitaEma, normalizedRealIncomePc, incomeAlpha)  
employmentRateEmaNext \= ema(employmentRateEma, employmentRate, employmentAlpha)

Prosperity is diagnostic/decision state only. It is never spendable and never directly creates output, money or people.

11\. Health stock

healthNext \= clamp01(  
  healthIndex  
  \+ healthRecoveryRate × (essentialSatisfactionEmaNext \- healthMaintenanceThreshold)  
  \+ serviceHealthRate × (serviceCoverage \- serviceBaseline)  
  \- activeDiseaseShock  
  \- disasterHealthDamage  
)

Health feeds mortality and may feed the already bounded Production healthLaborProductivityFactor. It does not directly generate production.

12\. Demographic cadence and annual-to-monthly conversion

Births, deaths, aging, mobility and migration execute in Phase 13 after current-tick economic outcomes. They therefore affect demand/labor in the next tick.

Annual probability/rate r in \[0,1) converts to monthly hazard:  
monthlyHazard \= 1 \- (1 \- r)^(1/12)

Rates larger than probability semantics must instead be stored as annual intensity and divided/converted explicitly. Definitions must declare which semantic they use.

13\. Births

For each WORKING cohort:  
reproductiveExposure \= population × reproductiveShare  
baselineBirths \= reproductiveExposure × monthlyBaselineBirthRate  
birthModifier \= clamp(  
  1  
  \+ fertilityProsperitySensitivity × (prosperityEma \- prosperityNeutral)  
  \- fertilityCrisisPenalty × max(0, crisisThreshold \- essentialSatisfactionEma),  
  minBirthModifier,  
  maxBirthModifier  
)  
births \= max(0, baselineBirths × birthModifier)

Births create population only; they create no cash/inventory. Newborns enter CHILD cohort with same regionId, clanId, stratum and baseline laborCategory. BirthTransaction records source parent cohort, target child identity and quantity.

Core v1 deliberately avoids fertility by exact age and parity.

14\. Deaths

For each cohort:  
baselineDeaths \= population × monthlyBaselineMortality\[ageBand\]  
mortalityMultiplier \= clamp(  
  1  
  \+ mortalityHealthSensitivity × max(0, healthReference \- healthIndex)  
  \+ starvationSensitivity × max(0, essentialMortalityThreshold \- essentialSatisfactionEma)  
  \+ epidemicShock  
  \+ disasterMortalityShock,  
  minMortalityMultiplier,  
  maxMortalityMultiplier  
)  
deaths \= min(populationAfterBirthInbound, baselineDeaths × mortalityMultiplier)

Deaths destroy population but not money. The deceased cohort's proportional cash and household inventory remain in the same aggregate cohort because PopulationCohort is not individual persons; dividing balances by fewer people automatically models inheritance within that cohort. No estate actor exists in v1.

Physical catastrophe events may supply explicit mortalityShock inputs, but all resulting deaths must still be recorded as DemographicTransaction.

15\. Aging

Use exponential-duration cohort flows:  
CHILD → WORKING monthly transition rate \= 1/(15×12)  
WORKING → ELDER monthly transition rate \= 1/(50×12)

agingFlow \= min(populationAvailable, populationAvailable × transitionRate)

Aging is a reclassification transfer. Proportional wallet and household inventory are moved with the reclassified population share to the target identity. This preserves per-capita balances and prevents wealth creation.

16\. Migration candidate generation and scoring

Migration is route-constrained and gradual. Expansion/transport supplies a bounded list of reachable destination Regions; Population must never score all world regions.

For working-age source cohort i and candidate d:  
attractiveness\_i,d \=  
  aW × deltaExpectedRealIncome  
\+ aE × deltaEmploymentOpportunity  
\+ aS × deltaEssentialAvailability  
\+ aN × clanNetworkAffinity(i.clanId,d)  
\+ aSafe × deltaSafety  
\- aC × migrationCost(origin,d)  
\- aB × borderLegalBarrier(origin,d)  
\- aCap × settlementCapacityPressure(d)

rawShare\_i,d \= maxMonthlyMigrationRate × sigmoid(attractiveness\_i,d / migrationScale)  
Normalize positive destination shares so Σ outboundWorking \<= eligiblePopulation × maxMonthlyMigrationRate.

Children and elders do not independently optimize migration. Dependent flows are attached to realized WORKING flows from the same clan/origin using dependencyAttachmentRateChild and dependencyAttachmentRateElder, each capped by source availability.

17\. Migration transaction and wallet/inventory preservation

interface MigrationFlow {  
  id: string;  
  tick: number;  
  sourceCohortId: CohortId;  
  destinationRegionId: RegionId;  
  destinationCohortKey: CohortIdentityKey;  
  persons: number;  
  walletTransfer: Wallet;  
  inventoryTransfer: Inventory;  
  transportCostByCurrency: Wallet;  
  reasonSignals: string\[\];  
}

For movedShare \= persons / sourcePopulationBeforeMove:  
walletTransfer\[currency\] \= source.wallet\[currency\] × movedShare  
inventoryTransfer\[g\] \= source.householdInventory\[g\] × movedShare

Transport/migration costs are then explicitly paid from the moving wallet portion to the configured transport/state receiver. Foreign denominations remain foreign denominations. No automatic FX conversion occurs. If a required cross-currency fee exists, it uses the canonical finite FX settlement primitive.

Destination cohort receives remaining wallet/inventory exactly. Border denial, no route, no settlement capacity or unaffordable migration cost yields zero flow; never negative balances.

18\. Clan entity and preferences

interface ClanState {  
  id: ClanId;  
  name: string;  
  homeRegionId: RegionId;  
  foundingStateId?: StateId;  
  wallet: Wallet; // clan treasury  
  preferenceAxes: {  
    traditionInnovation: number;  
    hierarchyEgalitarianism: number;  
    localismExpansionism: number;  
    militarismCivilianism: number;  
  }; // each \[-1,+1\]  
  ownerStrategy: ClanOwnerStrategy;  
  historicalTags: string\[\];  
}

interface ClanOwnerStrategy {  
  payoutTarget: number;  
  memberDistributionRate: number;  
  liquidityReserveShare: number;  
  ownerInjectionRateCap: number;  
  externalInvestmentPreference: number;  
}

Clan population, household wealth, employment, production and geographic presence are always derived.

Trait/tag effects are permitted only through configured bounded coefficients on existing decisions. Forbidden examples: direct \+production, \+births, \+influence-per-tick or free trade capacity.

Clan taste effect for eligible non-essential goods:  
effectivePreference \= basePreference × clamp(1 \+ clanTasteWeight × configuredAffinity, minTasteFactor, maxTasteFactor)

19\. ClanStateRelation

interface ClanStateRelation {  
  clanId: ClanId;  
  stateId: StateId;  
  loyalty: number; // \[0,1\]  
  politicalCapitalEma: number; // \[0,1\]  
  recentPolicySatisfactionEma: number; // \[-1,1\]  
  recognitionStatus?: string;  
}

Relations exist only when a clan has material population/assets/history in a state. Removing the last presence does not immediately delete historical relation; archive after relationRetentionTicks if no assets/population remain.

20\. Clan ownership and dividends

ProductionUnit.ownerType is CLAN or STATE in core v1; Clan ownership is single-owner. No fractional equity, stock market or cross-holding.

At Phase 10, a Clan-owned ProductionUnit may distribute:  
distributableCash \= max(0, unitHomeCash \- workingCapitalTarget \- committedInvestmentCash \- mandatoryNearTermReserves)  
dividend \= distributableCash × clamp(payoutTargetAdjusted, minPayout, maxPayout)

Atomic transfer: ProductionUnit wallet debit → Clan wallet credit in the unit settlement currency.

Cross-border ownership does not force conversion. Clan wallets are sparse multi-currency wallets.

21\. Clan member distributions

At quarterly cadence only:  
availableDistributionCash\_currency \= max(0, clanWallet\[currency\] \- clanLiquidityReserve\_currency \- committedOwnerInvestment\_currency)  
distributionPool\_currency \= availableDistributionCash\_currency × memberDistributionRate

Eligible member cohorts are clan cohorts. Baseline weight:  
weight\_i \= population\_i × stratumDistributionWeight(hierarchyEgalitarianism, stratum\_i)

Keep stratumDistributionWeight bounded tightly, recommended \[0.75,1.25\].  
transfer\_i \= distributionPool × weight\_i / Σweight

Transfers are Clan → Cohort wallet transactions in the same currency. Cross-currency recipient convenience conversion is forbidden; a cohort may receive foreign currency and later use canonical FX when actually needed.

22\. Owner capital injection

At quarterly owner-decision cadence, Clan may fund owned ProductionUnits.

eligible if:  
\- unit owner is clan;  
\- clan available wallet after reserves is positive;  
\- unit has explicit working-capital/investment funding gap;  
\- candidate expected-return/strategic score is positive;  
\- property/jurisdiction permits ownership.

candidateScore \= economicWeight × normalizedExpectedReturn  
  \+ expansionWeight × strategicExpansionValue  
  \+ homeAffinityWeight × homeRegionAffinity

Allocate a capped ownerInjectionBudget across positive candidates with deterministic proportional water-filling, capped at each funding gap.

Same-currency transfer is atomic. Cross-currency funding must use canonical settleFx before the unit receives local settlement currency. Failed/partial FX settlement proportionally reduces injection. Owner funding is equity-like cash transfer, not debt; no repayment or interest claim is created.

23\. Clan migration network effect

For clan c in destination d:  
networkPresence \= clanPopulation(c,d) / max(totalPopulation(d), populationEpsilon)  
networkAffinity \= networkStrength × networkPresence / (networkPresence \+ networkHalfSaturation)

This only enters migration attractiveness and optionally bounded startup candidate scoring. It cannot bypass transport, borders, settlement capacity or cash constraints.

24\. Loyalty and policy alignment

For each active ClanStateRelation:  
policyAlignment \= 1 \- weightedMean\_j(clamp01(abs(policy\_j \- preferredPosition\_cj) / maxDistance\_j))

loyaltyTarget \= clamp01(  
  baseLoyalty  
  \+ wProsperity × relativeClanProsperitySignal  
  \+ wPolicy × mapToSigned(policyAlignment)  
  \+ wFiscal × perceivedFiscalBalanceSignal  
  \+ wSecurity × securitySignal  
  \+ explicitLegalStatusModifier  
)  
loyaltyNext \= loyalty \+ loyaltyAdjustmentRate × (loyaltyTarget \- loyalty)

loyaltyAdjustmentRate must be slow, recommended monthly equivalent producing multi-year adaptation. Loyalty has no direct productivity/tax multiplier.

25\. Political influence

Influence is derived primarily from measurable presence and institutional access rather than accumulated magic points.

rawInfluence\_c,s \=  
  populationInfluenceWeight × populationShare\_c,s  
  \+ assetInfluenceWeight × productiveAssetShare\_c,s  
  \+ taxInfluenceWeight × taxableIncomeShare\_c,s  
  \+ politicalCapitalWeight × politicalCapitalEma\_c,s

currentInfluence \= normalizeAcrossClans(rawInfluence) subject to recognition/legal constraints.

politicalCapitalEma may change only from explicit recorded institutional access, political contribution or exclusion events. It must not increase simply because a tick passed.

STATE\_FISCAL consumes currentInfluence when aggregating policy support; Clan does not directly mutate law.

26\. Social mobility / stratum transitions

Stratum is a slow cohort classification, not a direct function of current cash.

mobilitySignal \=  
  mP × (prosperityEma \- prosperityNeutral)  
  \+ mR × (realIncomePerCapitaEma \- incomeNeutral)  
  \+ mE × (employmentRateEma \- employmentNeutral)

mobilityAccumulatorNext \= clamp(mobilityAccumulator \+ mobilityAdjustmentRate × mobilitySignal \- persistenceDecay × mobilityAccumulator, \-1, 1\)

At quarterly review:  
\- if accumulator \> upwardThreshold, move at most maxQuarterlyMobilityShare one step VULNERABLE→WORKING\_MIDDLE or WORKING\_MIDDLE→AFFLUENT;  
\- if accumulator \< downwardThreshold, move at most maxQuarterlyMobilityShare one step downward;  
\- no direct VULNERABLE↔AFFLUENT jump.

Reclassification transfers proportional wallet/inventory and population exactly. Clan hierarchy/egalitarian preference may weakly shift thresholds within tight configured bounds; it may not force a stratum change.

27\. Phase ownership / tick integration

Canonical interfaces by phase:  
Phase 2: Population emits HouseholdConsumptionPlan and LaborSupplyPlan using opening stocks/prior-close signals. Clan may only emit already-scheduled quarterly owner/member plans here; no settlement yet.  
Phase 3: Production/Labor allocator creates LaborAllocation. Population is read-only.  
Phase 4: Production input/local market settlement; household consumption does not settle yet unless canonical market implementation combines all local intents in its designated pass.  
Phase 5: Production consumes labor; wage \+ withholding transactions settle. Cohort wallet changes are authoritative before household affordability settlement.  
Phase 6/8: canonical household consumption intents are affordability-revalidated against actual wallet and settle through market clearing. Desired quantities may be rationed; no replanning loop.  
Phase 9: household inventory consumption/spoilage; coverage metrics created.  
Phase 10: fiscal transfers, Clan dividends/member distributions/owner injections where scheduled and legally valid; each explicit transaction only once.  
Phase 13: births, deaths, aging, migration and stratum reclassification; deterministic cohort merge.  
Phase 15: health/prosperity/employment/wage/migration EMAs, Clan loyalty/influence read models and diagnostics update.

If the canonical CORE\_SCHEMA phase labels differ in naming, implementation must preserve this causal ordering rather than create a second timeline.

28\. Deterministic cohort merge discipline

After Phase 13, group cohorts by exact identity key. For each group in stable cohortId order:  
\- population \= sum;  
\- wallet and inventories \= exact sums by currency/good;  
\- bounded continuous states \= population-weighted means;  
\- wageSignal \= working-population-weighted mean, fallback deterministic prior value;  
\- mobilityAccumulator and migrationPressureEma \= population-weighted means;  
\- resulting id \= deterministic identity-derived ID or the lexicographically smallest surviving canonical ID, according to CORE\_SCHEMA ID rule.

Never average cash/inventory totals.

29\. Complexity and browser budget

Let C \= cohorts, Rdeg \= bounded reachable migration candidates per working cohort, Gc \= substitutable goods in cohort need categories, U \= ProductionUnits, K \= clans, KS \= active ClanStateRelations.

Household demand: O(C × Gc), with Gc expected \<= 8–12 total baseline consumer goods.  
Labor supply: O(C).  
Demography/mobility: O(C).  
Migration: O(C × Rdeg), with Rdeg bounded by adjacency/shortlist; never O(C × Regions).  
Clan aggregation: O(C \+ U \+ KS).  
Clan quarterly allocation: O(U\_clan \+ C\_clan) over active candidates/members.

Recommended browser target: \<= 2,000 active cohorts, \<= 500 ProductionUnits, \<= 50 clans, \<= 100 Regions, and \<= 8 migration candidates per cohort for baseline interactive runs. No per-person arrays, cohort×unit persistent matrices or clan×region relation matrix.

30\. Required accounting and behavioral invariants

1\) world population changes only by births minus deaths.  
2\) migration/reclassification conserve world population exactly within epsilon.  
3\) cohort population/wallet/inventory never negative.  
4\) State/Clan/Region population equals cohort aggregation, never independent mutable truth.  
5\) aging/migration/mobility transfer proportional wallet/inventory without creating money/goods.  
6\) household purchases can only occur through canonical market settlement.  
7\) household spending cannot exceed current wallet after actual Phase-5 receipts/earlier commitments.  
8\) wage income/tax are read from Phase-5 ledger, never recomputed into duplicate transfers.  
9\) household spoilage is explicit goods destruction.  
10\) births create no cash or inventories.  
11\) deaths do not delete aggregate cohort cash/inventory.  
12\) clan treasury transactions reconcile sender/receiver wallets.  
13\) cross-currency Clan funding/distributions never use implicit conversion.  
14\) Clan owns no population/inventory belonging to cohorts and no productive inventory belonging to ProductionUnits.  
15\) Clan preference/traits never create goods, money, people, capacity or transport directly.  
16\) political influence is derived from explicit shares/access and normalized deterministically.  
17\) loyalty does not directly alter production or tax collection.  
18\) mobility moves only one adjacent stratum step per review.  
19\) dependent migration is capped by available CHILD/ELDER cohorts.  
20\) migration cannot bypass route, border or settlement-capacity gates.  
21\) all cohort merges preserve exact aggregate population/cash/inventory.  
22\) every demographic/Clan transaction has deterministic ID and tick/source/reason metadata.

31\. Required tests

A. Cohort identity and merge  
1\. identical identity cohorts merge with exact stock sums and weighted state means.  
2\. different clan/age/stratum/region cohorts never merge.  
3\. zero population cleanup leaves no orphan wallet/inventory balance.

B. Consumption  
4\. essential budget receives priority without giving the cohort clearing priority.  
5\. substitution shares sum to one and remain finite at very low prices.  
6\. affordability revalidation after wage settlement cannot overspend.  
7\. shortage rationing lowers coverage without negative inventory.  
8\. perishable excess creates explicit spoilage and goods reconciliation closes.

C. Labor/wages  
9\. only WORKING eligible population emits LaborSupplyPlan.  
10\. labor supply never exceeds cohort population.  
11\. wage receipt equals Phase-5 ledger and wage tax is not charged twice.  
12\. unemployment/employment rates reconcile to available worker equivalents.

D. Demography  
13\. baseline stable scenario follows configured birth/death hazards.  
14\. sustained essential deprivation raises mortality only within cap.  
15\. births enter CHILD same-clan target and create no cash.  
16\. aging conserves population/cash/inventory.  
17\. world population identity closes after simultaneous births/deaths/migration/mobility.

E. Migration  
18\. unreachable destination receives zero migration despite higher wages.  
19\. clan network raises attractiveness but cannot bypass closed border.  
20\. outbound normalization respects maxMonthlyMigrationRate.  
21\. migrant multi-currency wallet preserves denominations.  
22\. migration fee/FX shortage reduces or blocks flow without negative balances.  
23\. dependent migration never exceeds source CHILD/ELDER availability.

F. Clans  
24\. Clan population equals cohort aggregation across multiple states.  
25\. unit dividend transfers cash exactly once and respects working-capital reserve.  
26\. quarterly member distribution conserves each currency and deterministic residual allocation.  
27\. cross-border owner injection uses finite FX and partially settles when liquidity is insufficient.  
28\. trait configuration attempting direct productivity/birth/influence bonus fails validation.  
29\. loyalty moves gradually toward target and stays \[0,1\].  
30\. influence normalization is stable under deterministic ordering.  
31\. mobility only moves adjacent strata and preserves stocks.  
32\. removing all clan presence eventually archives relation without deleting Clan history.

G. Determinism/performance  
33\. same seed/config gives byte-equivalent cohort/clan close state and transaction IDs.  
34\. shuffled registry iteration order produces same results.  
35\. benchmark with 2,000 cohorts and 8 migration candidates stays within browser performance budget and allocates no per-person structures.

32\. Golden benchmark scenarios

G1 — Subsistence equilibrium: one region, one clan, stable food/basic supply, replacement-ish fertility/mortality. Verify bounded prosperity/health and no demographic drift beyond calibration target.

G2 — Food shock: temporary food supply collapse. Verify shortage → lower essential coverage → health deterioration → bounded mortality increase; no scripted GDP/population deletion.

G3 — Industrial pull migration: two connected regions, destination has tighter labor market and higher real wage. Verify gradual working-age migration, attached dependents, wage response and declining but persistent regional gap.

G4 — Closed border: same as G3 with border gate closed. Verify zero cross-border migration and no route bypass.

G5 — Clan diaspora path dependence: equal economic destinations but one has existing same-clan presence. Verify bounded network advantage without eliminating economic-price effects.

G6 — Clan wealth transmission: profitable Clan-owned units pay dividends; quarterly Clan distribution raises member cohort cash/consumption while unit reserves remain protected and total money conserved.

G7 — Cross-currency owner funding: Clan has currency A, owned unit needs B. Verify finite FX pool, partial funding under reserve shortage and no implicit conversion.

G8 — Social mobility cycle: long prosperity followed by recession. Verify slow one-step upward then downward mobility, no instantaneous cash-class mapping.

33\. Configuration surface

PopulationConfig must centralize: participation bounds, health factors, need category definitions, substitution price sensitivities, liquidity floor, EMA alphas, annual fertility/mortality definitions, fertility/mortality sensitivities and caps, aging rates, migration rate/weights/scale/candidate cap/dependent attachment, mobility cadence/thresholds/rate, household inventory carryover and spoilage rules.

ClanConfig must centralize: preference-axis bounds, allowed trait-to-coefficient mappings, payout/member-distribution/owner-injection cadence and caps, liquidity reserve rules, network strength/half-saturation, loyalty weights/adjustment, influence weights and relation retention.

Scenario files may override values but may not introduce new bespoke formulas without schema version change.

34\. Acceptance criteria for this subsystem

This contract is implementation-ready when code can instantiate cohorts/clans, generate household and LaborSupply plans, consume Phase-3/5 labor results, settle consumption, update welfare, execute Phase-13 demography/migration/mobility, execute quarterly Clan cash flows, derive loyalty/influence, pass all invariants/tests and reproduce golden scenarios without inventing a household, clan-production or second labor-market subsystem.

Deferred beyond core v1 unless benchmark evidence requires them: individual households, exact-age population pyramids, fertility-by-age/parity, professions, household borrowing, private inheritance/estates, fractional equity, clan internal taxation, explicit lobbying industry, endogenous cultural mutation, religion/ethnicity subsystems and per-person migration choice.  
