EXPANSION \+ SETTLEMENT IMPLEMENTATION CONTRACTS — Economic Simulation

Status: implementation-grade subsystem contract v1.  
Authority order: CORE\_SCHEMA\_AND\_LIFECYCLES \+ IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01 \> this document \> mature EXPANSION\_AND\_SETTLEMENT design. Compatible with POPULATION\_DEMOGRAPHY\_CLANS\_CONTRACTS, PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS, MARKETS\_TRADE\_FX\_CONTRACTS, STATE\_FISCAL\_LAWS\_CONTRACTS and MONETARY\_CURRENCY\_CONTRACTS.

1\. Scope and non-goals

This subsystem governs territorial settlement intensity, settlement projects, survey/discovery, frontier migration eligibility, market activation/dormancy, peaceful incorporation, minimal state formation and abandonment. It does not create population, goods, money, firms, roads, deposits or arbitrary territorial points.

Core v1 deliberately rejects: dynamic creation of Region objects; tile-level colonization; settler tokens; a second migration engine; a separate colonization currency; military conquest; automatic firm spawning; automatic currency creation at secession; and direct macro buffs from settlement.

Regions are stable coarse geographic units. Expansion changes their economic activation and jurisdiction while preserving all canonical stock owners.

2\. Canonical persistent schemas

Region extensions:  
\- id: RegionId, stable for entire run.  
\- controllerStateId: StateId | null.  
\- settlementLevel: float in \[0,1\].  
\- baseLandCapacityPeople: people.  
\- climateHabitability: float \[0,1\].  
\- terrainAccessibility: float \[0,1\].  
\- securityAccess: float \[0,1\].  
\- infrastructureAccessIndex: derived float, normally \[0,2\].  
\- durableSettlementFloor: float \[0,1\].  
\- discoveryStates: sparse map DepositId \-\> DiscoveryState.  
\- marketId: LocalMarketId, always present.  
\- controlHistory: append-only bounded history or telemetry reference; not authoritative for current control.

DiscoveryState enum: UNKNOWN | INDICATED | KNOWN.

SettlementProject:  
\- id: SettlementProjectId.  
\- sponsor: ActorRef restricted to State or Clan.  
\- targetRegionId: RegionId.  
\- status: PLANNED | ACTIVE | COMPLETE | CANCELLED.  
\- createdTick: Tick.  
\- committedCurrencyId: CurrencyId.  
\- committedCash: Money.  
\- remainingCashBudget: Money.  
\- requiredGoods: Inventory\<GoodId, Quantity\> containing only configured settlement-capital goods.  
\- acquiredGoods: Inventory\<GoodId, Quantity\>.  
\- consumedGoods: Inventory\<GoodId, Quantity\>.  
\- targetMigrantCount: people \>= 0\.  
\- remainingMigrantTarget: people \>= 0\.  
\- relocationSubsidyPerPerson: Money \>= 0\.  
\- progress: float \[0,1\].  
\- completionSettlementDelta: float (0,1\].  
\- plannedRouteId/path key: optional cached migration route reference; never authoritative if route becomes invalid.

SurveyProject:  
\- id: SurveyProjectId.  
\- sponsor: State | Clan | ProductionUnit owner actor.  
\- regionId: RegionId.  
\- cashBudget / remainingCashBudget.  
\- requiredServiceOrGoods inputs as configured.  
\- surveyEffort: normalized \[0,1\] after actual purchased inputs.  
\- status and timestamps.

StateFormationCandidate:  
\- predecessorStateId.  
\- regionIds: sorted connected RegionId list.  
\- consecutiveQualifiedReviews: integer \>=0.  
\- firstQualifiedTick: Tick | null.  
\- lastReviewedTick: Tick.  
This is candidate state only; new State creation occurs through PendingTransitions.

No duplicate persistent population, employment, firm, transport, public-infrastructure or treasury state is introduced here.

3\. Units and derived territorial capacity

One simulation tick is one month. Quarterly reviews occur every 3 ticks using the canonical cadence helper.

baselineCapacityPeople \= baseLandCapacityPeople \* climateHabitability \* resourceHabitabilityFactor.  
resourceHabitabilityFactor is scenario/config data and must not depend on undiscovered deposit quantities unless the resource affects physical habitability independently of economic knowledge.

infrastructureMultiplier \= clamp(0.5 \+ 0.5 \* infrastructureAccessIndex, 0.5, 1.5).

effectiveCarryingCapacityPeople \= max(minCapacityPeople, baselineCapacityPeople \* infrastructureMultiplier \* (0.25 \+ 0.75 \* settlementLevel)).

crowdingRatio \= regionPopulation / max(effectiveCarryingCapacityPeople, epsilonPeople).  
crowdingStress \= clamp((crowdingRatio \- 1\) / crowdingStressScale, 0, 1).

Expansion publishes crowdingStress as an input signal. Population decides how it affects migration/health/needs. Expansion never deletes excess population.

4\. Settlement eligibility

organizedSettlementEligible(sponsor, region, tickContext) is a pure gate evaluated in Phase 2 from prior-tick committed state. It returns false unless all are true:  
\- target Region exists and settlementLevel \< 1;  
\- at least one traversable configured TransportLink path exists from an economically active source region allowed for the sponsor;  
\- climateHabitability \>= minimumHabitability;  
\- State-led project: securityAccess \>= minimumAdministrativeAccess;  
\- applicable active laws/border policy permit settlement;  
\- sponsor can reserve the minimum project funding envelope without negative wallet balance;  
\- target passes sponsor-specific profitability/opportunity threshold supplied by existing Population/Production/Fiscal signals.

There is no canonical scalar opportunity(a,r) stored in world state. Each domain keeps its own decision model. Expansion exposes only shared primitives: carrying-capacity headroom, known-resource signal, market-access signal, route cost/capacity, policy friction, securityAccess and settlementLevel.

This implements the global simplicity-review decision and supersedes any earlier wording implying a universal colonization AI score.

5\. Settlement project funding and goods

A project is created in Phase 2 only after sponsor cash is reserved using the same budget-reservation discipline as other planned spending. Reservation is not money destruction.

Project procurement uses ordinary MarketIntents. It must not bypass market clearing, FX, tariffs, consumption/business taxes where applicable, transport cost or finite inventory.

Project goods are owned by the sponsor/project inventory until consumed. Goods bought abroad arrive only through canonical shipment semantics before they are available for Phase-12 project execution.

monthlyProgressRatio \= min over each required good g of remainingUsableAcquired\[g\] / max(requiredRemaining\[g\], epsilonQuantity), additionally capped by infrastructureExecutionCapacity and settlementBuildRate.

progressDelta \= clamp(monthlyProgressRatio \* settlementBuildRate, 0, 1 \- progress).

Goods consumed this tick are proportional to progressDelta / remainingProgress and move through an explicit CAPITAL\_FORMATION / SETTLEMENT\_INVESTMENT inventory transaction. No seller is paid in Phase 12 because payment already occurred at market settlement.

On progress reaching 1:  
settlementLevelNext \= clamp(settlementLevel \+ completionSettlementDelta, 0, 1).  
Project status becomes COMPLETE. Completion creates no people, firm, market cash, currency, transport link or deposit.

If a project is cancelled, unconsumed goods remain sponsor-owned and follow normal inventory/disposal rules; reserved unspent cash is released.

6\. Organized migration interface

SettlementProject never moves people itself.

During Phase 13, Population receives project relocation offers containing:  
\- projectId;  
\- targetRegionId;  
\- eligible source regions / route constraints;  
\- remainingMigrantTarget;  
\- relocationSubsidyPerPerson;  
\- destination clan-network signal if applicable.

Population computes normal cohort migration decisions and returns MigrationTransfer records. Expansion may cap accepted project-associated migrants by:  
acceptedPeople \<= min(remainingMigrantTarget, routeMigrationCapacity, Population-approved movable headcount).

For each accepted person, subsidyPayment \= acceptedPeople \* relocationSubsidyPerPerson, bounded by remaining project cash and revalidated at settlement time. Payment is an ordinary sponsor-to-migrant transfer in the destination legal tender or through canonical settleFx if cross-currency.

If subsidy cash is insufficient, accepted project-associated migration is reduced before population transfer. No debt or negative wallet is created.

Migration then uses the canonical cohort split/merge and migrant-wallet/inventory handling from POPULATION\_DEMOGRAPHY\_CLANS\_CONTRACTS. remainingMigrantTarget decreases by actual acceptedPeople only.

7\. Spontaneous frontier migration

There is no second migration engine. Population may include frontier Regions among ordinary destination candidates only when Expansion publishes frontierEligibility=true.

frontierEligibility requires:  
\- traversable route;  
\- climate threshold;  
\- law/border eligibility;  
\- either an active market or configured minimal subsistence access;  
\- positive carrying-capacity headroom or sufficiently strong Production opportunity;  
\- no hard security exclusion.

Per target Region:  
spontaneousFrontierMigrationThisTick \<= spontaneousFrontierMigrationCapPeople.

After actual spontaneous migrant arrival:  
spontaneousSettlementDelta \= actualSpontaneousMigrants / settlersPerSettlementPoint \* spontaneousSettlementEfficiency.  
settlementLevel increases only after migrants have actually arrived, bounded to \[0,1\]. This stock-flow link is physical settlement formation, not population creation.

8\. Resource discovery

True ResourceDeposit objects and quantities are created only by scenario initialization/world generation. Expansion stores only knowledge state.

Quarterly Phase-14 discovery review considers eligible SurveyProjects and other explicitly configured funded survey effort.

pDiscovery \= clamp(baseSurveyRatePerQuarter \* surveyEffort \* terrainAccessibility \* technicalFactor, 0, maxDiscoveryProbabilityPerQuarter).

Use keyed deterministic RNG with a key containing at least worldSeed, reviewTick, regionId, depositId and surveyProjectId/sourceId. Iteration order must not affect the result.

At most one transition per deposit per review:  
UNKNOWN \-\> INDICATED \-\> KNOWN.

No discovery transition changes true quantity, quality or depletion. Production investment/extraction logic may use a deposit only at the knowledge level explicitly allowed by Production config; core v1 extraction requires KNOWN.

9\. LocalMarket activation/dormancy

Every Region has exactly one LocalMarket registry object. LocalMarket.status is the authoritative market lifecycle field.

At Phase 14:  
activate when regionPopulation \>= marketActivationPopulation OR at least one ACTIVE ProductionUnit in region exposes market intents/trade.

dormancyCandidate when regionPopulation \< marketDormancyPopulation AND no ACTIVE ProductionUnit requires the market.

Use hysteresis: marketDormancyPopulation \<= marketActivationPopulation. Optional marketDormancyWindow may require the candidate condition for N consecutive monthly reviews.

Activation/dormancy changes only market participation status. It does not delete price history, inventories, firms, money or shipments. Dormant-market read models remain visible for history/replay.

10\. Production and transport entry boundary

Settlement never automatically creates ProductionUnits. Production evaluates entry/relocation through its own profitability, labor, input, capital and ownership rules using Expansion-provided region signals.

Extraction entry additionally requires a KNOWN compatible deposit with remaining quantity \> 0\.

Settlement never creates magical adjacency. TransportLink topology is scenario-defined or altered only by explicit infrastructure construction contracts. Existing link capacity/friction may improve through infrastructure investment.

Migration routing may use cached shortest generalized-cost paths over adjacent links. Cache invalidation occurs when link topology, relevant policy/border access or material capacity class changes. Trade routing remains governed by MARKETS\_TRADE\_FX\_CONTRACTS; Expansion does not implement multi-hop goods arbitrage.

11\. Peaceful incorporation

Phase-14 incorporation evaluation may propose an unclaimed Region for a State only if:  
\- controllerStateId \== null;  
\- settled population \>= incorporationPopulationThreshold;  
\- threshold has persisted for incorporationWindowReviews if configured;  
\- State-linked resident share \>= minimumLinkedResidentShare;  
\- securityAccess \>= minimumAdministrativeAccess;  
\- a legal traversable connection to the State exists, unless configured maritime exception applies;  
\- fiscal eligibility predicate from State Fiscal passes;  
\- active laws permit incorporation.

For every eligible State, deterministic claimScore is computed from normalized components:  
claimScore \= cPopulation\*residentShareLinkedToState \+ cAccess\*administrativeAccessibility \+ cInvestment\*historicalStateInvestmentShare \+ cClan\*loyaltyWeightedClanSupport.

Weights are non-negative and normalized in config. Winner is highest score; ties within claimScoreEpsilon resolve by stable StateId ascending.

The winner does not mutate Region immediately. Phase 14 writes PendingJurisdictionTransition with effectiveTick \= tick \+ 1\.

On Phase-1 activation next tick, only controllerStateId and derived legal/border jurisdiction change. Private assets, cohort clans, ProductionUnit ownership, wallets, inventories and shipments keep their owners.

12\. Minimal state formation

State formation is reviewed quarterly and is intentionally rare. Candidate clusters must be connected under the configured administrative-connectivity graph and currently share one predecessor State.

A cluster qualifies for one review when all are true:  
\- clusterPopulation \>= minimumNewStatePopulation;  
\- at least one active LocalMarket;  
\- fiscalViability predicate from State Fiscal passes;  
\- administrativeDistanceFromCapital \>= stateFormationAdministrativeDistanceThreshold;  
\- population-weighted Clan loyalty to predecessor \<= secessionLoyaltyThreshold;  
\- weighted autonomy support \>= autonomySupportThreshold;  
\- active laws/regime do not hard-disable peaceful formation.

Candidate identity is canonical: hash/predecessorStateId \+ sorted RegionIds. consecutiveQualifiedReviews increments only on consecutive quarterly reviews; otherwise resets to 0\.

When consecutiveQualifiedReviews \>= stateFormationWindowReviews, Phase 14 schedules one PendingStateFormation effective tick+1.

PendingStateFormation payload must contain all deterministic data required for Phase-1 activation:  
\- newStateId derived from stable formation key, never RNG/order;  
\- predecessorStateId;  
\- sorted transferred RegionIds;  
\- public territorial asset transfer records;  
\- treasury cash/public inventory allocation values;  
\- initial fiscal-policy preset reference;  
\- initial legal regime preset/reference;  
\- effectiveCurrencyRegime \= { currencyId: predecessor settlement currency, regimeType: FOREIGN\_LEGAL\_TENDER, policyAuthorityId: null } by default;  
\- if scenario initialization explicitly preconfigures the successor as a policy member, effectiveCurrencyRegime.policyAuthorityId must reference that currency's issuerAuthorityId and the State must already be represented in the authority's scenario-stable memberStateIds;  
\- no automatic predecessor monetary-union membership.

Phase-1 activation follows the canonical successor-State rules from CONSISTENCY\_REVIEW\_03 and CORE schema:  
\- jurisdiction transfers;  
\- predecessor sovereign debt remains with predecessor in core v1;  
\- private ownership never transfers;  
\- transferred treasury/public inventory is subtracted once from predecessor and added once to successor;  
\- world population and per-currency transaction money are unchanged by formation itself;  
\- new State policy applies only from activation onward.

No new currency is created by formation.

13\. Abandonment and settlement decline

At Phase 14 a Region is an abandonment candidate when population \< abandonmentPopulationThreshold and no ACTIVE ProductionUnit remains.

After abandonmentWindowMonths of continuous qualification:  
\- LocalMarket may become DORMANT under market lifecycle rules;  
\- settlementLevel decays monthly while qualification persists:  
  settlementLevelNext \= max(durableSettlementFloor, settlementLevel \* (1 \- abandonmentDecayRatePerMonth));  
\- infrastructure continues its existing depreciation rules;  
\- controllerStateId remains unchanged unless a separate legal transition exists.

Abandonment never deletes deposits, inventories, cash, firms or private ownership. Empty durable infrastructure can lower future resettlement costs only through existing infrastructure signals.

14\. Canonical tick integration

Phase 1 — activate PendingJurisdictionTransition/PendingStateFormation and any other already-scheduled territorial legal changes.  
Phase 2 — quarterly State/Clan planning may create funding reservations, SettlementProjects and SurveyProjects; Population/Production read prior committed territorial signals.  
Phases 3-8 — ordinary labor/production/market/trade/FX settlement handles project procurement and economic activity; Expansion has no special clearing path.  
Phase 12 — consume actually acquired settlement/survey inputs, advance projects and physical settlementLevel from completed investment.  
Phase 13 — Population executes normal migration, including project relocation offers and frontier destinations; subsidy payments settle atomically with accepted migration.  
Phase 14 — deterministic discovery review, LocalMarket lifecycle, peaceful-incorporation proposals, abandonment counters/decay and quarterly state-formation counters. Legal changes are scheduled, not activated.  
Phase 15 — reconcile expansion invariants, emit telemetry and prepare read-model/next-tick planning inputs before deterministic close.  
Phase-15 close is the final tick stage; there is no Phase 16 and no territorial mutation after Phase 14\.

Any earlier domain design that allows same-tick incorporation to affect tax, border or FX rules is superseded.

15\. Configuration contract

ExpansionConfig must explicitly declare units/cadence for:  
\- minCapacityPeople  
\- crowdingStressScale  
\- minimumHabitability  
\- minimumAdministrativeAccess  
\- minimumLinkedResidentShare  
\- marketActivationPopulation  
\- marketDormancyPopulation  
\- marketDormancyWindowMonths  
\- spontaneousFrontierMigrationCapPeoplePerMonth  
\- spontaneousSettlementEfficiency  
\- settlersPerSettlementPoint  
\- settlementBuildRatePerMonth  
\- incorporationPopulationThreshold  
\- incorporationWindowReviews  
\- claimScore weights \+ epsilon  
\- baseSurveyRatePerQuarter  
\- maxDiscoveryProbabilityPerQuarter  
\- minimumNewStatePopulation  
\- stateFormationAdministrativeDistanceThreshold  
\- stateFormationWindowReviews  
\- secessionLoyaltyThreshold  
\- autonomySupportThreshold  
\- abandonmentPopulationThreshold  
\- abandonmentWindowMonths  
\- abandonmentDecayRatePerMonth  
\- default completionSettlementDelta / settlement package recipes

All probabilities/rates are bounded and validated at scenario load. Threshold hysteresis must be validated (dormancy \<= activation). No hidden hard-coded constants inside expansion algorithms.

16\. Complexity and browser budget

Let R \= Regions, L \= TransportLinks, P \= active settlement/survey projects, Dq \= deposits reviewed this quarter, C \= state-formation candidate clusters, S \= States.

Monthly non-routing work target: O(R \+ P \+ active migration transfers).  
Quarterly discovery: O(Dq).  
Incorporation: O(R\*S) worst-case but only unclaimed eligible Regions should be considered; target sparse candidate filtering makes practical cost O(eligible claims).  
State formation: do not enumerate arbitrary subsets. Candidate clusters are pre-defined by connected low-loyalty frontier/administrative partitions or a bounded deterministic cluster generator, target O(R \+ L) per predecessor State review.  
Migration pathfinding uses cached shortest paths and is not recomputed per cohort per tick.

Core browser target: hundreds of Regions, not tens of thousands; Expansion must stay negligible relative to market/cohort processing.

17\. Mandatory accounting and lifecycle invariants

1\. Region registry size and RegionIds never change during a run.  
2\. Each Region has zero or one controller State.  
3\. settlementLevel is finite and in \[0,1\].  
4\. SettlementProject completion creates zero population.  
5\. SettlementProject completion creates zero money.  
6\. Settlement/survey input consumption cannot exceed actually acquired project inventory.  
7\. Global population is unchanged by interregional migration.  
8\. Migration subsidy debits equal migrant credits per currency after FX settlement records.  
9\. Discovery never changes true deposit quantity/quality/depletion.  
10\. UNKNOWN deposits cannot support core-v1 extraction.  
11\. LocalMarket.status is the sole authoritative market lifecycle flag.  
12\. Market dormancy deletes no financial/real stocks.  
13\. Settlement does not create ProductionUnits.  
14\. Settlement does not create TransportLinks except through a separate explicit infrastructure construction contract.  
15\. Incorporation changes no private ownership.  
16\. Jurisdiction changes affect economics only from their effective tick.  
17\. State formation preserves world population.  
18\. State formation preserves world goods except explicit ordinary consumption already recorded elsewhere.  
19\. State formation preserves per-currency transaction money except independent monetary operations.  
20\. Public asset/cash transfer at formation is debit-once/credit-once.  
21\. Predecessor sovereign debt is not duplicated or transferred in core v1.  
22\. New State does not automatically join predecessor monetary union.  
23\. New State does not automatically create a currency.  
24\. Abandonment deletes no deposits/private stocks.  
25\. All candidate/claim tie-breaking is deterministic and stable-order independent.  
26\. Keyed RNG discovery results are iteration-order independent.  
27\. No expansion operation bypasses MarketIntent, shipment, tax, tariff or settleFx rules when those apply.

18\. Required tests

1\. organized\_settlement\_requires\_route.  
2\. organized\_settlement\_requires\_funding\_reservation.  
3\. project\_procurement\_uses\_normal\_market\_intents.  
4\. project\_progress\_cannot\_consume\_unowned\_goods.  
5\. project\_completion\_changes\_settlement\_not\_population.  
6\. cancelled\_project\_releases\_unspent\_cash\_and\_keeps\_unconsumed\_goods.  
7\. project\_migration\_reduces\_source\_and\_increases\_destination\_exactly.  
8\. project\_migration\_is\_reduced\_when\_subsidy\_cash\_or\_fx\_is\_insufficient.  
9\. spontaneous\_frontier\_flow\_obeys\_monthly\_cap.  
10\. spontaneous\_settlement\_delta\_uses\_actual\_arrivals\_only.  
11\. unreachable\_frontier\_gets\_zero\_migrants.  
12\. crowding\_publishes\_pressure\_but\_does\_not\_delete\_people.  
13\. unknown\_deposit\_is\_invisible\_to\_extraction\_entry.  
14\. discovery\_advances\_max\_one\_state\_per\_quarter.  
15\. discovery\_preserves\_true\_deposit\_quantity.  
16\. keyed\_discovery\_is\_order\_independent.  
17\. market\_activation\_by\_population.  
18\. market\_activation\_by\_active\_production\_unit.  
19\. market\_dormancy\_hysteresis\_prevents\_one\_tick\_flapping.  
20\. market\_dormancy\_preserves\_history\_and\_stocks.  
21\. settlement\_does\_not\_spawn\_production\_unit.  
22\. incorporation\_requires\_unclaimed\_region.  
23\. competing\_claims\_choose\_deterministic\_highest\_score.  
24\. claim\_tie\_breaks\_by\_stable\_state\_id.  
25\. incorporation\_is\_pending\_until\_next\_tick.  
26\. incorporation\_preserves\_private\_ownership.  
27\. post\_incorporation\_tax\_border\_fx\_rules\_change\_only\_after\_activation.  
28\. state\_formation\_counter\_requires\_consecutive\_quarterly\_reviews.  
29\. arbitrary\_region\_subsets\_are\_not\_enumerated\_for\_formation.  
30\. formation\_new\_state\_id\_is\_deterministic.  
31\. formation\_preserves\_population\_goods\_and\_transaction\_money.  
32\. formation\_public\_transfer\_is\_exactly\_balanced.  
33\. formation\_keeps\_predecessor\_sovereign\_debt.  
34\. formation\_defaults\_to\_foreign\_legal\_tender\_with\_null\_policy\_authority\_preserved\_currency\_issuer\_and\_no\_union\_membership.  
35\. formation\_creates\_no\_currency.  
36\. abandonment\_decays\_settlement\_only\_after\_window.  
37\. abandonment\_preserves\_deposits\_private\_goods\_and\_controller.  
38\. resettlement\_can\_reactivate\_dormant\_market.  
39\. cached\_route\_invalidates\_on\_border\_policy\_change.  
40\. replay\_same\_seed\_and\_config\_produces\_identical\_expansion\_history.

19\. Golden benchmark scenarios

A. Crowded core, reachable empty frontier: outbound migration gradually settles frontier; world population conserved.  
B. Rich but unreachable deposit: no settlement/extraction until transport access exists; discovery alone does not bypass route constraints.  
C. State-funded frontier: project buys real goods, completes gradually, subsidizes actual migrants, then activates market without spawning firms.  
D. Rival peaceful claims: two States qualify; deterministic claim scoring selects one and legal effects begin next tick.  
E. Secession cluster: low loyalty \+ administrative distance persists across required quarterly window; deterministic successor forms with balanced public transfers, predecessor debt retained, predecessor currency used as foreign legal tender.  
F. Frontier bust: mine depletes, firms close, population leaves, market becomes dormant and settlement stock slowly decays without deleting infrastructure/deposits.  
G. FX-constrained cross-border clan settlement: project goods/subsidies are reduced by finite FX liquidity; no negative wallets or phantom settlement progress.  
H. Mixed replay: settlement \+ discovery \+ disaster-damaged infrastructure \+ migration \+ incorporation produce deterministic identical snapshots and satisfy all global stock invariants.

20\. Migration from current repository

The existing repository’s fixed City graph maps naturally to fixed Region \+ TransportLink configuration. Preserve deterministic turn orchestration and adjacency concepts; do not begin by implementing dynamic map topology.

Migration sequence inside this subsystem:  
1\. Introduce Region settlement/control fields and dormant LocalMarket lifecycle while retaining existing city identifiers through migration mapping.  
2\. Add pure derived carrying-capacity/frontier signal helpers.  
3\. Add SettlementProject/SurveyProject registries without yet enabling autonomous creation.  
4\. Route project procurement through existing/new canonical market intents.  
5\. Integrate project physical progress in Phase 12\.  
6\. Expose project/frontier migration offers to Population Phase 13\.  
7\. Add Phase-14 discovery and market lifecycle.  
8\. Add peaceful incorporation via PendingTransitions.  
9\. Add minimal state formation last, behind golden-scenario tests.

Do not couple initial expansion migration work to new currency creation or political warfare.

21\. Acceptance criteria

This subsystem is implementation-ready when Codex/Claude can implement it without deciding: what a Region owns, how settlement creates population, how project goods are funded/consumed, how migrants move, how resource discovery differs from resource creation, when markets activate, how jurisdiction becomes effective, what transfers at state formation, which debt/currency regime follows a new State, or how abandonment behaves.

The implementation must pass all mandatory tests plus the eight golden scenarios and global cross-spec invariants. Any change that introduces a separate colonization resource, separate population stock, same-tick jurisdiction effects, automatic firm/currency creation, or unaccounted goods/money is a contract violation.  
