EVENTS \+ SHOCKS CONTRACTS — Economic Simulation

Status: implementation-grade subsystem contract v1.  
Authority order: CORE\_SCHEMA\_AND\_LIFECYCLES \+ IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01 \> this document \> mature EVENTS\_AND\_SHOCKS design. This contract may extend event-local fields but may not alter the canonical 16-phase tick, ownership rules, accounting identities, Population mortality accounting, fiscal/monetary settlement, or Expansion jurisdiction semantics.

1\. Purpose and boundary

The event subsystem is intentionally thin. It schedules deterministic exogenous disturbances and translates them into a small typed vocabulary of direct mutations against already-existing canonical stocks/capacities. It must never directly assign GDP, CPI, prices, unemployment, migration, prosperity, loyalty, fiscal success, policy rates, jurisdiction, or money balances.

The implementation target is a data-driven engine with 6–10 initial EventDefinitions, sparse EventInstances, bounded effects, keyed RNG, explicit loss accounting, and enough explanation telemetry for the GitHub Pages observatory.

Hard exclusions for core v1: person-to-person epidemiology; war/combat; generic crime/theft; arbitrary welfare/wealth/influence buffs; infinite external relief; direct money creation/destruction; scripted macro-variable assignment; generic resilience stat; dynamic event subclasses containing bespoke business logic.

2\. Identity and definition registry

type EventDefinitionId \= string;   // ed:...  
type EventInstanceId \= string;     // ev:... (already canonical)  
type ShockOperationId \= string;    // op:... local stable key inside definition

type EventCategory \=  
  | 'DISASTER'  
  | 'EPIDEMIC'  
  | 'HARVEST'  
  | 'INFRASTRUCTURE'  
  | 'DISCOVERY'  
  | 'POLITICAL\_EXTERNAL';

type EventScopeKind \= 'REGION' | 'REGION\_CLUSTER' | 'TRANSPORT\_LINK' | 'STATE';

type DurationSpec \=  
  | { kind: 'FIXED'; ticks: number }  
  | { kind: 'TRIANGULAR'; minTicks: number; modeTicks: number; maxTicks: number };

type SeveritySpec \= {  
  min: number;  
  mode: number;  
  max: number;  
};

interface EventDefinition {  
  id: EventDefinitionId;  
  name: string;  
  category: EventCategory;  
  enabledByDefault: boolean;  
  scopeKind: EventScopeKind;  
  annualHazardRate: number;  
  cooldownTicks: number;  
  maxConcurrentInstances: number;  
  severity: SeveritySpec;  
  duration: DurationSpec;  
  eligibility: EventEligibilityRule;  
  spatial?: SpatialScopeRule;  
  operations: ShockOperationDefinition\[\];  
  uiSummaryTemplate: string;  
  tags: string\[\];  
}

EventDefinitions are immutable for a run and live in DefinitionRegistry.eventDefinitions. No mutable realized severity, cooldown counter, remaining duration, or current targets may be stored in a definition.

3\. Persistent EventInstanceState

Extend the minimal core schema to:

interface EventInstanceState {  
  id: EventInstanceId;  
  definitionId: EventDefinitionId;  
  startTick: number;  
  endTickExclusive: number;  
  epicenterRegionId?: RegionId;  
  targetRegionIds: RegionId\[\];  
  targetTransportLinkIds: TransportLinkId\[\];  
  targetStateIds: StateId\[\];  
  baseSeverity: number;                 // \[0,1\]  
  localSeverityByRegion: Record\<RegionId, number\>;  
  realizedOperations: RealizedShockOperation\[\];  
  rngKey: string;  
  status: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED';  
  completedTick?: number;  
}

Rules:  
\- EventInstance is immutable with respect to targets, baseSeverity and realized operation magnitudes after realization. Only lifecycle/status fields change.  
\- endTickExclusive means temporary effects are active for ticks startTick \<= tick \< endTickExclusive.  
\- COMPLETED instances may remain in canonical history for a configured retention horizon or move into an immutable event log/read model; replay semantics must be identical either way.  
\- SCHEDULED is used for benchmark/scenario injections. Stochastic events are normally realized directly into ACTIVE at Phase 1\.  
\- EventInstance IDs are deterministic and must not depend on registry insertion order. Recommended: \`ev:${tick}:${definitionId}:${targetKey}\` with deterministic collision suffix only if the scenario allows \>1 identical target event per tick.

4\. Eligibility rules

Do not store arbitrary executable predicates in scenario data. Use a small declarative rule vocabulary:

interface EventEligibilityRule {  
  requireRegionTags?: string\[\];  
  requireAnyRegionTags?: string\[\];  
  excludeRegionTags?: string\[\];  
  requiresPopulation?: boolean;  
  minPopulation?: number;  
  maxPopulation?: number;  
  minSettlementLevel?: number;  
  requiresKnownResourceTag?: string;  
  requiresHiddenResourceTag?: string;  
  requiresActiveMarket?: boolean;  
  requiresTransportLink?: boolean;  
  maxHealthIndex?: number;  
  minDensityIndex?: number;  
  controllerRequired?: boolean;  
}

Scenario validation rejects unsupported keys. Runtime eligibility reads only canonical/derived inputs available at Phase 1 and may not mutate state.

Hazard-tag ownership: world-generation/configuration owns stable \`hazardTags: string\[\]\` on RegionDefinition/Region static scenario data, not mutable RegionState. Examples: \`drought\_prone\`, \`flood\_plain\`, \`seismic\`, \`storm\_coast\`, \`dense\_urban\`. These tags affect eligibility or configured severity multipliers only; they do not themselves create losses.

5\. Occurrence scheduler

One tick \= one month. For annual hazard λ and T \= 12:

pTick \= 1 \- exp(-λ / T)

For every enabled definition and deterministic candidate target, draw:

u \= rng.float('events:occurrence', tick, definitionId, candidateTargetKey)  
trigger \= u \< clamp(pTick \* globalHazardScale \* eligibilityHazardMultiplier, 0, maxPerTargetTickProbability)

Candidate enumeration must be sorted by definitionId then target persistent ID. Because the RNG is keyed, reordering registries must still produce identical outcomes.

Cooldown: a definition-target pair is ineligible when any prior instance with the same definitionId and targetKey has \`tick \- startTick \< cooldownTicks\`. Maintain a derived cooldown index; do not persist a second authoritative cooldown counter.

World caps are checked after candidate realization in deterministic order:  
\- maxNewEventsPerTick  
\- maxConcurrentWorldEvents  
\- definition.maxConcurrentInstances

If a cap rejects otherwise-triggered candidates, rejected candidates are logged only in debug diagnostics, not as EventInstances.

Scenario mode bypasses stochastic occurrence but still routes through the same \`realizeEventInstance()\` and \`applyEventStart()\` code paths.

6\. Severity and duration realization

Severity uses bounded triangular draws:

severity \= triangular(min, mode, max, rng.float('events:severity', instanceKey))  
severity \= clamp(severity \* eventSeverityScale, 0, 1\)

Validation requires 0 \<= min \<= mode \<= max \<= 1\.

Duration:  
\- FIXED: durationTicks \= max(1, ticks)  
\- TRIANGULAR: deterministic integer draw in \[minTicks,maxTicks\], rounded using one documented global rule (recommended nearest integer, minimum 1).

endTickExclusive \= startTick \+ durationTicks.

No unbounded normal distributions in v1.

7\. Spatial scope

interface SpatialScopeRule {  
  maxGraphDistanceCost: number;  
  decayScale: number;  
  minLocalSeverity: number;  
  maxRegions: number;  
}

For REGION\_CLUSTER events, select one epicenter candidate deterministically, then compute shortest configured graph-distance cost over TransportLinks. Direct local severity:

localSeverity(r) \= baseSeverity \* exp(-distanceCost(epicenter,r) / decayScale)

Include only eligible regions with localSeverity \>= minLocalSeverity, ordered by \`(distanceCost, regionId)\`, truncated to \`maxRegions\`. This is direct scope only. No secondary contagion/damage propagation graph exists in v1.

For TRANSPORT\_LINK events, the link is the primary target and adjacent Regions may be included only for explanation context unless an explicit second ShockOperation targets them.

For STATE scope, enumerate that State's effective Phase-1 controlled Regions. A state event never changes jurisdiction.

8\. Typed shock operation vocabulary

type ShockOperationKind \=  
  | 'INVENTORY\_LOSS'  
  | 'CAPITAL\_DAMAGE'  
  | 'PRODUCTIVITY\_MODIFIER'  
  | 'INFRASTRUCTURE\_DAMAGE'  
  | 'TRANSPORT\_CAPACITY\_MODIFIER'  
  | 'TRANSPORT\_COST\_MODIFIER'  
  | 'HEALTH\_HAZARD'  
  | 'CARRYING\_CAPACITY\_MODIFIER'  
  | 'RESOURCE\_YIELD\_MODIFIER'  
  | 'RESOURCE\_DISCOVERY'  
  | 'DEMAND\_WEIGHT\_MODIFIER';

interface ShockOperationDefinition {  
  id: ShockOperationId;  
  kind: ShockOperationKind;  
  targetSelector: ShockTargetSelector;  
  baseMagnitude: number;  
  severityExponent: number;  
  cap: number;  
  persistence: 'IMMEDIATE' | 'TEMPORARY';  
  combineRule?: 'MULTIPLY' | 'ADD';  
}

realizedMagnitude \= clamp(baseMagnitude \* pow(localOrBaseSeverity, severityExponent), 0, cap)

Recommended severityExponent range 1.2–2.0 for damaging effects. Config validator allows broader positive values but rejects \<=0.

\`baseMagnitude\`, \`cap\`, and units are operation-specific; names must include unit semantics in comments/config schema.

9\. Canonical mutation contracts by operation

9.1 INVENTORY\_LOSS  
Target selectors may address Region-associated cohorts, ProductionUnits, State publicInventory, or explicitly eligible shipment cargo only if a future shipment-loss selector is enabled. Core v1 default excludes in-transit shipment destruction to avoid duplicating the existing transport-loss semantics.

For each selected inventory container and GoodId:  
loss \= min(availableQuantity, availableQuantity \* realizedFraction)  
container\[goodId\] \-= loss  
record EventPhysicalLoss { kind:'GOOD', goodId, quantity:loss, ownerRef, regionId, eventInstanceId }

Do not reduce reserved/sold quantities twice. Phase-1 event application happens before new TickContext reservations exist.

9.2 CAPITAL\_DAMAGE  
Target ACTIVE/MOTHBALLED/PLANNED ProductionUnits in target Regions as permitted by selector.  
loss \= min(installedCapital, installedCapital \* realizedFraction)  
installedCapital \-= loss  
Record capital event loss separately from Phase-12 depreciation. Capacity is derived from surviving installedCapital and other canonical modifiers; do not also decrement a duplicate capacity stock if installedCapital is authoritative.

9.3 PRODUCTIVITY\_MODIFIER  
Temporary multiplicative modifier consumed by Production Phase 5\. No persistent ProductionUnit field is mutated. Register an EventModifier in TickContext/effective modifier index.

9.4 INFRASTRUCTURE\_DAMAGE  
Only mutate an infrastructure stock/condition field that is authoritative in the Expansion/Public Infrastructure contract. Apply the physical stock reduction exactly once at Phase 1 and record the same amount as EventPhysicalLoss for reconciliation/telemetry. Later Phase-12 public-capital formation must read the already-damaged opening stock and must not subtract that EventPhysicalLoss again. Do not mutate settlementLevel unless the specific infrastructure contract declares settlementLevel itself destructible; core v1 recommendation: disasters damage named infrastructure first, while settlementLevel changes only through settlement/abandonment lifecycle.

9.5 TRANSPORT\_CAPACITY\_MODIFIER  
Temporary multiplier against \`effectiveCapacity \= baseCapacity \* conditionFactor \* product(activeCapacityModifiers)\` with floor 0\. It does not modify \`baseCapacity\`.

9.6 TRANSPORT\_COST\_MODIFIER  
Temporary multiplier against \`effectiveTransportCost \= baseTransportCost \* conditionCostFactor \* product(activeCostModifiers)\`. Default adverse cap \<=3x per operation; global combined cap is separately configured.

9.7 HEALTH\_HAZARD  
Temporary additive hazard consumed only by Population Phase 13 mortality/health update. It never removes population directly in Phase 1\.

additionalMortalityHazard \= clamp(sum(activeHealthHazards), 0, maxEventMortalityHazardPerTick)

Deaths remain normal Population flows with eventInstanceId attached as a causal ID.

9.8 CARRYING\_CAPACITY\_MODIFIER  
Temporary multiplicative modifier applied to the derived effective carrying-capacity function. It must not overwrite or persist a carryingCapacity stock because carrying capacity is derived.

9.9 RESOURCE\_YIELD\_MODIFIER  
Temporary multiplier on extraction yield for matching known deposits/recipes. It never changes reserve quantity except through ordinary extraction.

9.10 RESOURCE\_DISCOVERY  
Immediate transition only: \`discoveryState\[depositId\] UNKNOWN \-\> KNOWN\`. Underlying ResourceDeposit.reserveQuantity is unchanged. A repeated reveal is a deterministic no-op and produces no duplicate discovery effect.

9.11 DEMAND\_WEIGHT\_MODIFIER  
Temporary bounded multiplier on an existing need/category weight. The consumption planner renormalizes its normal need weights after all active modifiers. This operation cannot create a new need category or force expenditure.

10\. Modifier registry and combination order

Temporary modifiers are not new persistent economic stocks. Derive an active modifier index from ACTIVE EventInstances at Phase 1 and store it in TickContext for hot-loop access.

Recommended shape:  
interface EventModifierIndex {  
  productionByUnitOrRegion: ...;  
  transportCapacityByLink: ...;  
  transportCostByLink: ...;  
  healthHazardByRegion: ...;  
  carryingCapacityByRegion: ...;  
  resourceYieldByDepositOrRegion: ...;  
  demandWeightByRegionNeed: ...;  
}

Canonical combination order:  
1\. derive the subsystem's ordinary baseline from canonical state;  
2\. apply persistent non-event condition factors already owned by that subsystem;  
3\. apply all active event multiplicative modifiers in sorted \`(eventInstanceId, operationId)\` order by multiplication;  
4\. apply additive event hazards/weights in the same sorted order by addition;  
5\. clamp once to the subsystem-global hard bounds.

Because pure multiplication/addition is associative only approximately under floating point, sorted application order is mandatory for byte-stable replay.

Global default hard bounds are owned by the canonical configuration/default registry:  
\- combined productivity multiplier: \[0.10, 1.75\]  
\- combined transport capacity multiplier: \[0, 1.50\]  
\- combined transport cost multiplier: \[0.50, 4.00\]  
\- combined resource yield multiplier: \[0.10, 1.75\]  
\- combined carrying-capacity multiplier: \[0.25, 1.25\]  
\- demand-weight multiplier before renormalization: \[0.50, 2.00\]  
\- event mortality hazard: bounded by Population's canonical per-tick mortality cap.

11\. Tick timing and lifecycle

Phase 0 BeginTick:  
\- create TickContext and reset flow telemetry only. Do not mutate event stocks here beyond ordinary context setup.

Phase 1 Activate carried regime and scheduled operations:  
1\. mark ACTIVE instances with \`tick \>= endTickExclusive\` as COMPLETED before rebuilding modifiers;  
2\. activate SCHEDULED instances whose startTick \== tick;  
3\. evaluate stochastic candidates and realize bounded new ACTIVE instances;  
4\. apply each new instance's IMMEDIATE operations exactly once in sorted instance/operation/target order;  
5\. build active temporary modifier index from all instances where startTick \<= tick \< endTickExclusive;  
6\. emit direct-effect ExplanationFacts and event-start telemetry.

Phases 2–14:  
\- consumers read EventModifierIndex through pure query functions. Event subsystem performs no additional hidden mutations.  
\- Population Phase 13 may record deaths with causal event IDs; fiscal/market/monetary reactions remain ordinary endogenous flows.

Phase 15:  
\- reconcile physical event-loss ledgers;  
\- emit event status/read-model summaries and downstream ExplanationFacts generated by owning subsystems;  
\- optionally archive old COMPLETED instances according to deterministic retention policy after their immutable log representation is sealed.

An event starting in tick N therefore affects tick-N planning/production/markets because it activates in Phase 1 before Phase 2\. Policy responses decided at Phase 15 still activate no earlier than N+1.

12\. Immediate-loss accounting records

Extend TickContext telemetry with:

interface EventPhysicalLoss {  
  tick: number;  
  eventInstanceId: EventInstanceId;  
  operationId: ShockOperationId;  
  kind: 'GOOD' | 'CAPITAL' | 'INFRASTRUCTURE';  
  regionId?: RegionId;  
  owner?: ActorRef;  
  goodId?: GoodId;  
  quantity: number;  
  unitLabel: string;  
}

Immediate physical destruction is not an EconomicTransaction because no counterparty receives it. It is a typed sink included in Phase-15 goods/capital/infrastructure reconciliation.

Money is never included in EventPhysicalLoss in v1.

13\. Event explanation/read-model contract

For every EventInstance expose at minimum:  
\- id, definitionId, name/category;  
\- startTick/endTickExclusive/status;  
\- epicenter/target Regions, links and States;  
\- base and local severities;  
\- exact realized immediate losses;  
\- active temporary modifiers and remaining ticks;  
\- direct causal ExplanationFacts tagged \`EVENT\_DIRECT\`;  
\- related downstream facts by causalIds, tagged by owning subsystem such as \`MARKET\`, \`PRODUCTION\`, \`POPULATION\`, \`FISCAL\`, \`TRADE\`.

Example direct fact: “Storm destroyed 18.2 capital units in Coast Works.”  
Example downstream fact: “Tool price rose 27% after import capacity fell.”  
The event subsystem emits only the first; Markets/Trade emit the second while preserving the EventInstanceId as a causal link.

14\. Initial v1 definition catalog

Keep the catalog compact and data-driven:  
1\. drought / harvest failure — temporary staple/resource yield penalty; optional carrying-capacity penalty;  
2\. storm/flood/earthquake — bounded capital \+ named infrastructure damage, inventory loss, temporary transport disruption;  
3\. epidemic — health hazard plus optional temporary productivity penalty; no contagion model;  
4\. resource accident — extraction yield penalty and optional capital damage;  
5\. transport chokepoint disruption — link capacity/cost modifier;  
6\. resource discovery — reveal pre-generated hidden deposit;  
7\. favorable harvest/season — capped temporary yield increase.

A politically external shock may be added only when it maps to an existing concrete constraint (for example temporary border/transport restriction through an already-designed law transition). It may not become a generic “confidence” or GDP shock.

Exact parameter values belong in the canonical configuration/default registry, not hard-coded here.

15\. Fiscal, monetary, clan, expansion interaction boundaries

Fiscal: events may increase emergency priority signals, but State response uses existing treasury, debt issuance, transfers and ordinary market procurement. No free relief goods or money.

Monetary: events never change policyRate or money supply directly. CPI/output effects feed the normal Phase-15 policy rule and N+1 activation.

Clans: traits may affect subsequent investment/migration/political behavior through existing coefficients. No direct clan-specific damage resistance without a concrete owned asset/technology represented elsewhere.

Expansion: resource discovery changes knowledge only. Temporary carrying-capacity shocks feed ordinary migration/settlement pressure. Events never create Regions, settlements, States, ProductionUnits or jurisdiction transitions.

16\. Deterministic APIs

Required pure/query functions:  
\- \`getEligibleEventTargets(world, definition, tick): EventTargetKey\[\]\`  
\- \`isEventOnCooldown(world, definitionId, targetKey, tick): boolean\`  
\- \`computeTickHazard(definition, world, targetKey, config): number\`  
\- \`realizeSeverity(definition, rngKey, config): number\`  
\- \`resolveSpatialScope(world, definition, epicenter, severity): EventTargetScope\`  
\- \`realizeEventInstance(world, definition, scope, tick, rng): EventInstanceState\`  
\- \`buildEventModifierIndex(world, tick): EventModifierIndex\`

Required mutation functions:  
\- \`activateScheduledEvents(world, ctx)\`  
\- \`realizeStochasticEvents(world, ctx)\`  
\- \`applyEventStart(world, ctx, instance)\`  
\- \`completeExpiredEvents(world, ctx)\`

No subsystem may call random draws inside \`applyEventStart\`; all randomness is realized into EventInstanceState first so scenario-injected and stochastic instances with identical realized fields produce identical direct effects.

17\. Validation

Scenario/config validation must reject:  
\- invalid severity ordering/range;  
\- negative hazard/cooldown/duration;  
\- unsupported eligibility keys;  
\- operation with persistence inconsistent with kind;  
\- zero/negative severityExponent;  
\- operation cap outside kind-specific safe range;  
\- selector referencing unknown good/resource/tag;  
\- REGION\_CLUSTER without valid spatial rule;  
\- duplicate operation IDs inside one definition;  
\- event definition with no operations;  
\- scheduled instance referencing missing definition/target;  
\- startTick \>= endTickExclusive for pre-realized instance;  
\- NaN/Infinity anywhere.

Runtime CHEAP validation checks finite modifier values, valid references, no negative stocks, and valid lifecycle times. DEEP validation additionally rebuilds realized operation expectations where possible, verifies loss-ledger reconciliation and checks deterministic active-modifier reconstruction.

18\. Computational complexity and browser budget

Let E be event definitions (target \<=10 core v1), R Regions (tens–low hundreds), L links, and A active instances (normally sparse).

Occurrence candidate pass: worst O(E\*R \+ E\*L), but definitions are small and eligibility indexes can reduce this. Expensive eligibility lists may be rebuilt on a slow cadence only when their source topology/settlement state changes.  
Spatial attenuation: O(R log R \+ L) per cluster event with Dijkstra on small graph; alternatively precomputed distance matrices are acceptable if bounded world size justifies O(R²) memory. Do not run all-pairs pathfinding every tick.  
Immediate operations: O(number of selected canonical entities).  
Modifier build: O(A \* operations \* affectedTargets), expected small.

Target: event processing \<5% of simulation Worker tick time at default benchmark scale. No event calculation belongs on the UI thread.

19\. Repository migration mapping

Current repository has no event subsystem. \`Simulation.RunTurn()\` owns one explicit deterministic turn loop using a single mutable \`Random\` and currently runs produce \-\> price \-\> intercity trade \-\> local market \-\> consume \-\> spoil. Preserve the explicit orchestrator concept, but events enter the canonical migration only as Phase-1 work before planning/production. Do not bolt random damage calls into \`City.Produce\`, \`Market\`, \`Deal\`, or UI code.

Migration sequence for this subsystem:  
1\. after canonical WorldState \+ keyed RNG exist, add immutable EventDefinition types and scenario catalog;  
2\. add EventInstance registry and Phase-1 event scheduler with events disabled by default;  
3\. implement RESOURCE\_DISCOVERY and one temporary yield modifier first as low-risk vertical slice;  
4\. add physical-loss ledger and inventory/capital damage;  
5\. add transport/health/carrying-capacity/demand modifiers through subsystem query interfaces;  
6\. add deterministic benchmark schedules and explanation facts;  
7\. enable stochastic catalog only after conservation/replay tests pass.

The existing single \`Random\` must not be reused for event draws because adding/removing event definitions would perturb unrelated simulation randomness.

20\. User-draft disposition

All four user drafts have already been audited and incorporated at architecture level. This contract preserves/reworks the draft ideas that materially touch events: regional climate/terrain/resource conditions become eligibility inputs; harvest failures propagate through normal hunger/health/market mechanics; shortages and physical losses remain visible; resource discovery reveals pre-existing reserves; explicit update order is retained.

Explicitly rejected: generic warehouse theft as an unexplained sink; arbitrary Wealth/Welfare/Influence event modifiers; infinite rescue imports; random money creation/destruction; event scripts that directly set prices/GDP/unemployment/population; bespoke clan disaster buffs. No draft mechanism is silently reintroduced here.

21\. Invariants

EV-I1 Same seed/config/version/opening state yields identical event realization and effects.  
EV-I2 Registry insertion/iteration order cannot change EventInstances.  
EV-I3 Every EventInstance references one immutable definition and valid canonical targets.  
EV-I4 Immediate operation is applied at most once per instance/operation/target.  
EV-I5 Physical stocks never fall below tolerance from an event.  
EV-I6 Every event-destroyed good unit is recorded exactly once as EventPhysicalLoss.  
EV-I7 Every event-destroyed capital unit is recorded separately from depreciation.  
EV-I8 Resource discovery changes knowledge only, never reserve quantity.  
EV-I9 Event code never writes market price/CPI/GDP/unemployment/policy rate/jurisdiction fields.  
EV-I10 Event code never creates/destroys transaction money.  
EV-I11 Cohort deaths caused by hazards remain Population Phase-13 flows.  
EV-I12 Temporary modifiers are active exactly for startTick \<= tick \< endTickExclusive.  
EV-I13 Expired modifiers leave no persistent hidden scalar.  
EV-I14 Overlapping modifiers obey deterministic ordering and global hard caps.  
EV-I15 Transport disruption does not retroactively rewrite already-settled shipment routes/ownership.  
EV-I16 Event activation in tick N cannot trigger same-tick policy/law decisions before their normal cadence.  
EV-I17 State emergency spending has ordinary treasury/debt/market counterflows.  
EV-I18 Event damage never transfers private ownership.  
EV-I19 Positive yield/productivity effects are temporary and capped.  
EV-I20 Scenario-scheduled and stochastic instances with identical realized fields have identical direct effects.  
EV-I21 Turning visualization/explanation generation off does not change event or economic state.  
EV-I22 World goods reconciliation includes event loss exactly once.  
EV-I23 Active modifier index is reproducible solely from canonical EventInstances \+ definitions \+ tick.  
EV-I24 Event subsystem cannot create new Regions, States, ProductionUnits, Clans, cohorts, currencies or TransportLinks.

22\. Required tests

EV-T1 1200-tick same-seed replay produces byte-identical event log and canonical hashes.  
EV-T2 Reverse Region/Link registry insertion order; event outcomes unchanged.  
EV-T3 Occurrence probability conversion matches \`1-exp(-lambda/12)\` within tolerance.  
EV-T4 Cooldown blocks same definition-target until boundary tick, then permits it.  
EV-T5 Per-definition/world concurrency caps select deterministic winners.  
EV-T6 Triangular severity always remains configured bounds.  
EV-T7 Fixed and triangular duration produce valid endTickExclusive.  
EV-T8 Cluster local severity decreases monotonically with graph cost before threshold/truncation.  
EV-T9 Inventory loss clamps at available quantity and creates one loss record.  
EV-T10 Capital damage reduces installedCapital once and not depreciation ledger.  
EV-T11 Infrastructure damage reduces only authoritative infrastructure field.  
EV-T12 Productivity modifier affects Phase-5 output but leaves installedCapital unchanged.  
EV-T13 Transport capacity modifier cannot produce negative effective capacity.  
EV-T14 Transport cost overlap respects combined hard cap.  
EV-T15 Health hazard alone does not mutate population in Phase 1; Population Phase 13 performs deaths.  
EV-T16 Carrying-capacity modifier does not create persistent carryingCapacity field.  
EV-T17 Resource-yield modifier changes extraction yield, not reserve except normal extraction.  
EV-T18 Resource discovery reveals hidden deposit with identical reserve quantity.  
EV-T19 Repeated resource discovery is an idempotent no-op.  
EV-T20 Demand-weight modifier renormalizes existing household needs and cannot force spending above budget.  
EV-T21 Modifier expires exactly at endTickExclusive and next tick baseline is restored.  
EV-T22 Two overlapping multiplicative events apply in canonical sorted order and respect cap.  
EV-T23 Physical disaster with downstream systems disabled changes only declared direct stocks/modifiers.  
EV-T24 Harvest failure changes price only through later market phases, never event mutation.  
EV-T25 Transport shock cannot reroute/duplicate already IN\_TRANSIT shipment goods retroactively.  
EV-T26 Pure physical disaster leaves money reconciliation unchanged before ordinary fiscal/monetary response.  
EV-T27 Emergency procurement debits State treasury/financing and credits real sellers.  
EV-T28 Event targeting an unclaimed Region with controllerStateId=null executes without State dereference.  
EV-T29 Event on Region queued for N+1 jurisdiction change uses Phase-1 effective controller for tick N.  
EV-T30 Positive harvest cannot exceed combined yield cap.  
EV-T31 Scenario-scheduled and stochastic identical realized instance produce identical direct state diff.  
EV-T32 UI/event-log toggle leaves canonical state hash identical.  
EV-T33 Serialization round-trip with ACTIVE and COMPLETED instances continues deterministically.  
EV-T34 Mixed 600-tick benchmark with events \+ trade \+ FX \+ migration \+ expansion preserves all core identities.

23\. Golden scenarios

G1 Harvest failure — one agricultural Region, 40% temporary yield loss for 6 ticks. Expect lower output, shortage/price pressure, more feasible imports, worse essential satisfaction when imports are constrained, and later migration pressure. No direct price mutation.

G2 Chokepoint disruption — one high-volume link at 20% effective capacity for 4 ticks. Expect route substitution only where configured routes exist, bilateral price divergence and inventory shifts. Already in-transit ownership remains valid.

G3 Capital storm — prosperous Region loses 25% selected installed capital plus bounded infrastructure stock. Expect immediate capacity decline, reconstruction/investment demand, possible fiscal response and endogenous recovery only through real goods.

G4 Epidemic comparison — same realized health hazard in two Regions differing in baseline health/wealth/fiscal capacity. Direct event operation identical; mortality/recovery paths may diverge endogenously.

G5 Frontier discovery — reveal a pre-generated ore deposit in marginal settled Region. Geological reserve and world money/population unchanged at reveal; later investment/migration/trade may emerge.

G6 Double shock — harvest failure \+ transport disruption overlap. Validate capped modifier composition, no duplicated losses, natural shortage amplification and conservation.

G7 Fiscal-space comparison — identical storm in otherwise similar States with different treasury/debt capacity. Direct physical damage identical; reconstruction path diverges only through normal fiscal/market flows.

G8 Deterministic schedule equivalence — inject a fully realized benchmark EventInstance and compare with a stochastic run forced to realize the same fields. Direct Phase-1 state diff and modifier index must be identical.

24\. Acceptance gate

Events implementation is accepted only when:  
\- all EventDefinitions are data-driven and schema-validated;  
\- stochastic and scheduled paths converge on one realized-instance pipeline;  
\- immediate physical losses reconcile in Phase 15;  
\- temporary effects live only in reconstructable modifier indexes, not hidden subsystem scalars;  
\- all downstream macro effects arise through owning subsystems;  
\- EV-I1..EV-I24 hold in DEEP validation;  
\- EV-T1..EV-T34 pass;  
\- golden scenarios produce expected directional behavior without accounting violations;  
\- default-scale event processing stays within browser Worker performance budget;  
\- no hard v1 exclusion is introduced indirectly.

25\. Dependency note

Exact event catalog numbers and global hard bounds are defined in 03 — CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION. This event contract remains authoritative for event behavior and does not require any further architecture decision.  
