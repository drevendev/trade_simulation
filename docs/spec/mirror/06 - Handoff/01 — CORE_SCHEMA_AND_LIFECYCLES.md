# CORE SCHEMA AND LIFECYCLES — Economic Simulation

Status: implementation-grade core contract v1. This document is authoritative for entity identity, registry ownership, core state shape, lifecycle boundaries and tick order. Subsystem specs may extend entity-local fields but must not contradict these contracts.

1\. Purpose and implementation boundary

This spec converts the stable economic architecture into a concrete runtime schema for Codex/Claude. It does not redefine market, production, population, fiscal, monetary, expansion or event formulas. It fixes the common objects those systems read/write, when they may mutate them, and which fields are persistent stocks versus per-tick plans/telemetry.

Repository migration principle: preserve the current explicit turn-loop, deterministic seed/config approach, local Market concept, generic Storage idea, invariant-oriented tests and GitHub Pages pipeline. Replace fixed City\[4\], PopType-driven production and implicit object ownership with typed IDs, registries and explicit stocks.

Initial runtime recommendation: implement the canonical engine in TypeScript for browser execution, while keeping C\# golden scenarios during migration if useful. The schema below is language-neutral but intentionally TypeScript-shaped.

## 2\. Numeric and identity conventions

Persistent IDs are opaque strings with stable prefixes. They are never array indexes, never generated from map iteration order, and never reused within a run after an entity is retired or removed. An ID identifies one lifecycle instance for the entire run; allocators must reserve retired IDs so retained snapshots, transactions and explanations can never rebind an old reference to a newer entity.

type RegionId \= string;          // r:...  
type StateId \= string;           // s:...  
type ClanId \= string;            // c:...  
type CohortId \= string;          // pc:...  
type ProductionUnitId \= string;  // pu:...  
type MarketId \= string;          // m:...  
type TransportLinkId \= string;   // tl:...  
type CurrencyId \= string;        // cur:...  
type MonetaryAuthorityId \= string; // ma:...  
type ShipmentId \= string;        // sh:...  
type BondId \= string;            // bond:...  
type EventInstanceId \= string;   // ev:...  
type GoodId \= string;            // good:...

All quantities, money values and rates use finite IEEE-754 numbers in v1. Every configurable tolerance must be explicit. No NaN/Infinity may enter canonical state.

Units:  
\- population: persons represented by a cohort aggregate;  
\- goods: abstract good-units declared by GoodDefinition;  
\- money: currency minor/major units consistently per scenario; recommended normalized decimal major units;  
\- rates: fractions unless explicitly labeled percent;  
\- time: one canonical tick \= one month in core v1;  
\- annual parameters must be converted to monthly/tick rates before application.

Stable ordering rule: whenever results could depend on iteration order, sort by persistent ID (or a documented deterministic secondary key) before processing.

3\. Canonical root state

interface WorldState {  
  schemaVersion: number;  
  simulationVersion: string;  
  scenarioId: string;  
  seed: number;  
  tick: number;  
  nextDynamicStateSequence: number;

  regions: Record\<RegionId, RegionState\>;  
  states: Record\<StateId, StateState\>;  
  clans: Record\<ClanId, ClanState\>;  
  cohorts: Record\<CohortId, PopulationCohortState\>;  
  productionUnits: Record\<ProductionUnitId, ProductionUnitState\>;  
  markets: Record\<MarketId, LocalMarketState\>;  
  transportLinks: Record\<TransportLinkId, TransportLinkState\>;  
  currencies: Record\<CurrencyId, CurrencyState\>;  
  monetaryAuthorities: Record\<MonetaryAuthorityId, MonetaryAuthorityState\>;  
  shipments: Record\<ShipmentId, TradeShipmentState\>;  
  stateBonds: Record\<BondId, StateBondState\>;  
  eventInstances: Record\<EventInstanceId, EventInstanceState\>;

  pendingTransitions: PendingTransitions;  
  definitions: DefinitionRegistry;  
  config: SimulationConfig;  
}

Not canonical mutable state: GDP, CPI, unemployment rate, trade balance, prosperity summaries, clan wealth share, carrying capacity, crowding, dashboard aggregates and UI snapshots. These are derived from canonical stocks/flows.

4\. Shared stock containers

Use sparse maps so new currencies/goods do not require structural migrations.

type Wallet \= Record\<CurrencyId, number\>;  
type Inventory \= Record\<GoodId, number\>;

Rules:  
\- absent key means zero;  
\- values below \-epsilon are invalid;  
\- canonical serialization omits zero entries after normalization;  
\- every debit/credit validates sufficient balance unless an explicit authorized money-creation/destruction operation is being executed;  
\- cross-currency economic payments must call the single settleFx primitive exactly once; callers may not mutate two currency wallets independently as a shortcut.

5\. Entity registry and minimum persistent fields

5.1 RegionState

interface RegionState {  
  id: RegionId;  
  name: string;  
  controllerStateId: StateId | null;  
  pendingControllerStateId?: StateId | null;  
  marketId: MarketId;  
  settlementCurrencyId: CurrencyId;  
  settlementLevel: number;  
  marketStatus: 'ACTIVE' | 'DORMANT';  
  discoveryState: Record\<string, 'UNKNOWN' | 'KNOWN'\>;  
  resourceDeposits: Record\<string, ResourceDepositState\>;  
  infrastructure: Record\<string, InfrastructureState\>;  
  climateHabitabilityInputs: Record\<string, number\>;  
}

Binding rules:  
\- the set of Region IDs is fixed at scenario initialization and never changes during a run;  
\- controllerStateId is nullable and references zero or one live State;  
\- settlementLevel is built footprint not otherwise represented by named infrastructure and cannot be derived mechanically from population;  
\- carrying capacity is derived, not stored as a freely mutable stock.

5.2 StateState  
interface CurrencyRegimeState {  
  currencyId: CurrencyId;  
  regimeType: 'INDEPENDENT\_FLOAT' | 'MONETARY\_UNION' | 'FOREIGN\_LEGAL\_TENDER';  
  policyAuthorityId: MonetaryAuthorityId | null;  
}

Currency-regime ownership is State-specific. currencyId selects the State's effective legal-tender/default fiscal currency. INDEPENDENT\_FLOAT and MONETARY\_UNION require policyAuthorityId \= currencies\[currencyId\].issuerAuthorityId and membership in that MonetaryAuthority. FOREIGN\_LEGAL\_TENDER requires policyAuthorityId \= null and no membership; the Currency keeps its issuerAuthorityId unchanged.

interface StateState {  
  id: StateId;  
  name: string;  
  status: 'ACTIVE';  
  treasury: Wallet;  
  publicInventory: Inventory;  
  policy: StatePolicyState;  
  effectiveCurrencyRegime: CurrencyRegimeState;  
  createdTick: number;  
}

Region membership is derived from Region.controllerStateId, not duplicated as a mutable array on State.

Dynamic State creation is allowed only through the Phase-14 state-formation lifecycle and next-tick activation. New State IDs are allocated from WorldState.nextDynamicStateSequence or another deterministic scenario-defined function. State creation never creates geography, population, firms, private assets, goods or money.

5.3 ClanState

interface ClanState {  
  id: ClanId;  
  name: string;  
  treasury: Wallet;  
  preferences: ClanPreferenceState;  
  relationsByState: Record\<StateId, ClanStateRelation\>;  
  createdTick: number;  
}

Clan population is derived from cohorts with matching clanId. Clan does not own a duplicate population stock, labor system or household consumption inventory.

5.4 PopulationCohortState

interface PopulationCohortState {  
  id: CohortId;  
  regionId: RegionId;  
  clanId: ClanId;  
  ageBand: 'CHILD' | 'WORKING' | 'ELDER';  
  stratum: 'LOWER' | 'MIDDLE' | 'UPPER';  
  laborStatus: 'EMPLOYED' | 'UNEMPLOYED' | 'OUT\_OF\_LABOR\_FORCE';  
  population: number;  
  employedPersons: number;  
  wallet: Wallet;  
  inventory: Inventory;  
  health: number;  
  prosperity: number;  
  wageSignal: number;  
}

Cohort identity represents one homogeneous lifecycle bucket. Splits/merges are allowed only in Population Phase 13 and must conserve people, wallet balances by currency and inventories by good. Merge key must include all cohort dimensions required for behavior; do not merge cohorts merely because they share region/clan. A cohort retired by a split/merge keeps its CohortId reserved for historical references; newly created successor buckets receive fresh deterministic CohortIds and may link to predecessor IDs only as lineage metadata.

5.5 ProductionUnitState

interface ProductionUnitState {  
  id: ProductionUnitId;  
  regionId: RegionId;  
  owner: { type: 'CLAN'; id: ClanId } | { type: 'STATE'; id: StateId };  
  recipeId: string;  
  status: 'PLANNED' | 'ACTIVE' | 'MOTHBALLED' | 'CLOSING';  
  wallet: Wallet;  
  inputInventory: Inventory;  
  outputInventory: Inventory;  
  installedCapital: number;  
  condition: number;  
  capacity: number;  
  wageOffer: number;  
  createdTick: number;  
}

Ownership is exactly one Clan or State in core v1. No fractional equity and no cross-holdings.

ProductionUnit lifecycle:  
1\. Candidate evaluation: Production subsystem only, on configured slow cadence.  
2\. PLANNED creation: requires eligible region, recipe, expected profitability/location viability and explicit owner funding reservation/transfer.  
3\. Activation: only after required startup investment goods/capital conditions are satisfied.  
4\. ACTIVE: can hire, buy, produce, sell and invest.  
5\. MOTHBALLED: retains ownership, cash, inventory and capital but does not perform normal production; may reactivate when viability criteria recover.  
6\. CLOSING: no new expansion; Production resolves remaining cash/inventory/capital through explicit sale, transfer, scrap or destruction records.  
7\. Removal from registry is allowed only after all owned stocks are zero within tolerance and no shipment/debt/reference points to the unit.

Expansion/settlement may make a region eligible or provide subsidies but may never instantiate ProductionUnits directly.

5.6 LocalMarketState

interface LocalMarketState {  
  id: MarketId;  
  regionId: RegionId;  
  status: 'ACTIVE' | 'DORMANT';  
  priceByGood: Record\<GoodId, number\>;  
  expectationByGood: Record\<GoodId, MarketExpectationState\>;  
}

Market owns persistent price/expectation signals, not traded goods or cash. Per-tick supply/demand/clearing data belongs in TickContext/telemetry.

5.7 TransportLinkState

interface TransportLinkState {  
  id: TransportLinkId;  
  fromRegionId: RegionId;  
  toRegionId: RegionId;  
  enabled: boolean;  
  distance: number;  
  baseCapacity: number;  
  condition: number;  
  baseTransportCost: number;  
}

Trade uses only configured links; no all-pairs magical world market.

5.8 CurrencyState and MonetaryAuthorityState

interface CurrencyState {  
  id: CurrencyId;  
  code: string;  
  issuerAuthorityId: MonetaryAuthorityId | null;  
}

interface MonetaryAuthorityState {  
  id: MonetaryAuthorityId;  
  currencyId: CurrencyId;  
  wallet: Wallet;  
  memberStateIds: StateId\[\];  
  policyRate: number;  
  plannedPolicyRate?: number;  
  fxPools: Record\<string, FxLiquidityPoolState\>;  
}

memberStateIds are scenario-stable in core v1. State formation does not auto-enroll a successor State. A successor normally continues using the predecessor region settlement currency as FOREIGN\_LEGAL\_TENDER and has no independent issuance/OMO authority.

5.9 TradeShipmentState

interface TradeShipmentState {  
  id: ShipmentId;  
  goodId: GoodId;  
  quantity: number;  
  originRegionId: RegionId;  
  destinationRegionId: RegionId;  
  seller: ActorRef;  
  buyer: ActorRef;  
  routeLinkIds: TransportLinkId\[\];  
  departureTick: number;  
  arrivalTick: number;  
  status: 'IN\_TRANSIT';  
}

When shipment ownership begins, shipped quantity is removed/reserved from seller-local inventory and counted only in shipments until delivery/destruction. It may never be counted simultaneously at origin and destination.

5.10 StateBondState and BondHoldingState

interface StateBondState {  
  id: BondId;  
  issuerStateId: StateId;  
  currencyId: CurrencyId;  
  principalOutstanding: number;  
  couponRate: number;  
  issuedTick: number;  
  maturityTick: number;  
}

interface BondHoldingState {  
  bondId: BondId;  
  holder: { type: 'CLAN'; id: ClanId } | { type: 'MONETARY\_AUTHORITY'; id: MonetaryAuthorityId };  
  principalHeld: number;  
}

BondHolding may be stored in a separate registry or normalized nested map, but the liability/asset split is mandatory. Sum holdings for each bond equals principalOutstanding within tolerance. State formation does not change issuerStateId.

5.11 EventInstanceState

interface EventInstanceState {  
  id: EventInstanceId;  
  definitionId: string;  
  startTick: number;  
  endTick: number;  
  severity: number;  
  targetRegionIds: RegionId\[\];  
  status: 'SCHEDULED' | 'ACTIVE';  
}

Events may mutate only typed canonical physical/biological capacity inputs. They may not assign prices, GDP, CPI, unemployment, prosperity, migration count, loyalty or jurisdiction.

6\. Definition registry versus mutable state

interface DefinitionRegistry {  
  goods: Record\<GoodId, GoodDefinition\>;  
  recipes: Record\<string, RecipeDefinition\>;  
  eventDefinitions: Record\<string, EventDefinition\>;  
  metricDefinitions: Record\<string, MetricDefinition\>;  
}

Definitions are immutable for a run and scenario-versioned. Mutable quantities never live inside definitions.

7\. ActorRef and transaction contract

type ActorRef \=  
  | { type: 'COHORT'; id: CohortId }  
  | { type: 'PRODUCTION\_UNIT'; id: ProductionUnitId }  
  | { type: 'CLAN'; id: ClanId }  
  | { type: 'STATE'; id: StateId }  
  | { type: 'MONETARY\_AUTHORITY'; id: MonetaryAuthorityId };

Canonical transaction/debug record:

interface EconomicTransaction {  
  tick: number;  
  phase: number;  
  type: string;  
  source?: ActorRef;  
  destination?: ActorRef;  
  goodId?: GoodId;  
  currencyId?: CurrencyId;  
  quantity?: number;  
  unitPrice?: number;  
  moneyAmount?: number;  
  taxAmount?: number;  
  feeAmount?: number;  
  sourceRegionId?: RegionId;  
  destinationRegionId?: RegionId;  
  causalIds?: string\[\];  
}

Runtime may aggregate transactions after reconciliation, but debug/test mode must retain enough atomic records to trace invariant failures.

8\. TickContext: ephemeral per-tick state

Do not pollute WorldState with plans that should expire every tick.

interface TickContext {  
  tick: number;  
  effectiveJurisdictionByRegion: Record\<RegionId, StateId | null\>;  
  laborPlans: unknown;  
  productionPlans: unknown;  
  consumptionPlans: unknown;  
  procurementPlans: unknown;  
  tradePlans: unknown;  
  marketBooks: unknown;  
  laborAllocations: unknown;  
  transactions: EconomicTransaction\[\];  
  explanationFacts: ExplanationFact\[\];  
  diagnostics: TickDiagnostics;  
}

Plans are created in Phase 2 and are immutable intent for that tick where practical. They may reference current state but may not assume same-tick imports or late transfers.

9\. Pending transitions and one-tick legal causality

## PendingTransitions

interface PendingTransitions {  
  jurisdictionChanges: Array\<{ regionId: RegionId; nextControllerStateId: StateId | null; activateTick: number }\>;  
  stateCreations: PendingStateCreation\[\];  
  policyChanges: Array\<{ stateId: StateId; patch: unknown; activateTick: number }\>;  
  monetaryPolicyChanges: Array\<{ authorityId: MonetaryAuthorityId; patch: unknown; activateTick: number }\>;  
}

Phase-14 political decisions never mutate effective jurisdiction for the current tick. They enqueue changes with activateTick \= tick \+ 1\. Taxes, tariffs, domestic/international classification, legal-tender rules and FX requirements for tick N use jurisdiction effective at Phase 1 of tick N.

State formation activation transaction, executed at Phase 1:  
\- create State from deterministic pending payload;  
\- change founding Region.controllerStateId;  
\- transfer configured qualifying territorial public cash denomination-by-denomination;  
\- transfer qualifying public inventories good-by-good;  
\- re-associate territorial public infrastructure administration without changing physical quantity;  
\- leave private ProductionUnit/Clan ownership unchanged;  
\- leave predecessor StateBond issuer/debt unchanged;  
\- initialize successor policy deterministically;  
\- retain predecessor settlement currency as FOREIGN\_LEGAL\_TENDER unless scenario explicitly says otherwise;  
\- do not change MonetaryAuthority.memberStateIds;  
\- do not create balancing money if successor treasury is poor.

10\. Canonical 16-phase tick order

One tick \= one month. Slow systems use cadence gates inside this single clock.

Phase 0 — BeginTick  
Increment tick; create TickContext; reset flow telemetry; derive deterministic RNG substreams from seed \+ tick \+ subsystem key.

Phase 1 — Activate carried regime and scheduled operations  
Apply pending jurisdiction/law/policy changes; activate policy rate and spot FX carried from prior close; execute planned regular sovereign auctions and eligible OMO; activate scheduled event shocks; execute due state-formation activation transactions.

Phase 2 — Expectations and planning  
Read only prior-close state plus Phase-1 effective regime. Build cohort consumption/labor plans, ProductionUnit output/input/labor/investment intentions, State procurement/transfers/public investment intentions and trade candidate signals. Plans cannot assume same-tick imported inputs.

Phase 3 — Labor allocation  
Deterministically allocate regional labor supply to labor demand; record employment and wage obligations; no worker/person may be allocated twice.

Phase 4 — Pre-production procurement  
Clear required ProductionUnit/State pre-production purchases using pre-existing locally available inventory only. Shipments arriving during this tick do not feed Phase-5 production unless they were already in transit from an earlier tick and their arrival semantics place delivery before Phase 4\.

Phase 5 — Production/extraction and wage settlement  
Consume actual inputs/labor; produce capped output; reduce finite deposits; settle gross wages with atomic wage-tax withholding. Wage cash is available for household purchases in Phase 8\.

Phase 6 — Main-market offer/price formation  
Form seller offers from post-production inventory above reserves/targets; form effective demands; update bounded sticky prices from canonical market signals.

Phase 7 — Interregional/international shipment planning and settlement  
Plan feasible shipments through TransportLinks; execute seller/buyer money settlement, transport fees, tariffs and settleFx where required; move goods into TradeShipment ownership. No shipment goods remain in local seller inventory.

Phase 8 — Residual local main-market clearing  
Deterministically clear local supply/demand including household consumption purchases; transfer goods and money atomically; record unmet demand.

Phase 9 — Realized consumption and needs  
Consume owned household/public final goods; update need satisfaction, health/prosperity inputs and realized consumption telemetry. Unmet nominal demand is not consumption.

Phase 10 — Fiscal settlement and income distribution  
Settle remaining taxes on realized bases, automatic transfers/subsidies, profit/dividend distributions and due debt service. Transfers paid here affect purchasing only from next tick.

Phase 11 — Monetary bookkeeping/reconciliation  
No second FX market exists. Reconcile per-currency ledgers and monetary operations not already settled in Phase 1/transactions; assert authorized money creation/destruction identities.

Phase 12 — Depreciation, spoilage, investment and settlement construction  
Apply spoilage/depreciation/damage aftermath; execute funded private/public investment and settlement projects using actually acquired real goods; no free capacity creation.

Phase 13 — Demography, social mobility and migration  
Apply births/deaths/aging/mobility; migrate people between cohorts/regions while moving wallets denomination-by-denomination and preserving goods/money/population identities; merge/split cohorts deterministically.

Phase 14 — Slow territorial/lifecycle review  
Apply discovery transitions; market activation/dormancy; settlement abandonment; Production lifecycle cadence decisions; jurisdiction/state-formation review. Legal effects are queued for N+1, not applied retroactively.

Phase 15 — Accounting, metrics, policy review and snapshot  
Reconcile goods/population/money/debt; compute derived metrics; calculate policy decisions for N+1; close FX pressure/reference updates; emit ExplanationFacts/event logs; then generate UI snapshot/read model. UI telemetry must not mutate canonical state.

11\. Deterministic RNG contract

Never keep one mutable global RNG whose call count depends on unrelated iteration details. Expose keyed draws, e.g. rng.float('events', tick, eventDefinitionId, regionId) or deterministic subsystem streams derived from seed/tick/key. Same scenario \+ seed \+ simulationVersion must reproduce the same canonical snapshot sequence within declared floating tolerances.

12\. Core invariants required after every Phase 15

I1 Region registry fixed: regionId set equals initialization set.  
I2 Region controller valid: controllerStateId is null or a live State.  
I3 Population: opening \+ births \+ inbound \= closing \+ deaths \+ outbound, accounting for cohort split/merge as zero-sum restructuring.  
I4 Goods: opening \+ production/extraction/import arrival \= closing local \+ consumption \+ intermediate use \+ spoilage/destruction \+ export departure \+ net in-transit change.  
I5 Money per currency: opening \+ authorized creation \= closing \+ authorized destruction; internal transfers cancel.  
I6 No actor wallet below \-moneyEpsilon unless the operation is rejected/rolled back.  
I7 No physical inventory/deposit below \-quantityEpsilon.  
I8 Shipment uniqueness: each shipped unit is in exactly one ownership/location state.  
I9 Labor uniqueness: employed allocation never exceeds working population and no person is double allocated.  
I10 Bond matching: sum BondHolding.principalHeld \== StateBond.principalOutstanding within debtEpsilon.  
I11 State formation conservation: no change to world population/private assets/world money from formation itself; public succession transfers balance source/destination exactly.  
I12 No monetary-union auto-accession from state formation.  
I13 Political lag: Phase-14 transition cannot change tax/FX/border treatment of tick-N transactions.  
I14 Production closure conservation: registry removal only after all owned canonical stocks/claims are resolved.  
I15 Event causality: event code cannot write forbidden derived macro fields because such fields do not exist in canonical mutable state.  
I16 UI non-interference: snapshot/explanation generation enabled vs disabled yields same canonical state hash/aggregate outputs.  
I17 Stable policy causality: Phase-15 policy decisions activate no earlier than N+1.  
I18 Single FX primitive: every cross-currency payment has exactly one settleFx trace/reconciliation entry.

13\. Required core tests

CORE-T1 Same seed/config/version \=\> same canonical serialized state sequence for 120 ticks.  
CORE-T2 Reordering registry insertion order does not change results.  
CORE-T3 Frontier region with controllerStateId=null runs without invalid State dereference.  
CORE-T4 Attempted dynamic Region creation after initialization fails validation.  
CORE-T5 State formation produces deterministic ID/activation tick and preserves private ownership.  
CORE-T6 Successor uses FOREIGN\_LEGAL\_TENDER with effectiveCurrencyRegime.policyAuthorityId=null, preserves Currency.issuerAuthorityId, and does not enter predecessor MonetaryAuthority.memberStateIds.  
CORE-T7 Phase-14 jurisdiction change becomes economic only in N+1.  
CORE-T8 Cross-currency payment cannot bypass settleFx.  
CORE-T9 Cohort migration preserves each currency denomination and total people.  
CORE-T10 ProductionUnit close with residual stock is rejected until explicit disposition completes.  
CORE-T11 Shipment departure removes source-local inventory exactly once; delivery adds destination inventory exactly once.  
CORE-T12 StateBond holdings reconcile before/after issuance, service and OMO.  
CORE-T13 UI telemetry toggle leaves canonical simulation hash unchanged.  
CORE-T14 Mixed 600-tick benchmark with trade \+ FX \+ disasters \+ migration \+ expansion \+ state formation satisfies all conservation identities.  
CORE-T15 Serialization round-trip of canonical state preserves IDs, sparse wallets/inventories and deterministic continuation.  
CORE-T16 Entity ID allocators never reuse retired IDs; retained references to a closed/merged entity resolve only to that original lifecycle instance or an explicit historical-unavailable state, never to a newer entity.

14\. Validation and serialization

Create validateWorldState(world, mode) with CHEAP and DEEP modes. CHEAP runs every tick for finite values, references, non-negative stocks and key accounting residuals. DEEP runs in tests/benchmarks and checks complete cross-registry references, bond holdings, transaction reconciliation, shipment ownership and canonical serialization.

Canonical serialization rules:  
\- schemaVersion required;  
\- registry keys sorted before hash/export;  
\- sparse zero entries removed;  
\- no functions/classes/prototypes required for persisted state; use plain serializable data;  
\- ephemeral TickContext is not part of replay checkpoint except optional debug fixture;  
\- scenario definitions/config are versioned and referenced or embedded consistently;  
\- migration code must be explicit when schemaVersion changes.

15\. Browser/performance constraints

Target scale: tens to low hundreds of Regions, tens of States, tens/hundreds of Clans, hundreds to low thousands of Cohorts and ProductionUnits, compact Good set. Canonical registries should support O(1) ID lookup. Hot-loop secondary indexes (entities by region, cohorts by clan, units by owner) may be derived/cache structures rebuilt deterministically; they are not independent sources of truth.

Do not use recursive object graphs with back-references between entities. Store IDs. This reduces serialization cost, avoids cycles and makes Worker transfer/replay straightforward.

16\. Migration mapping from current repository

Preserve:  
\- Simulation.RunTurn as the conceptual orchestrator, expanded from six implicit steps to the canonical 16 phases;  
\- SimulationConfig as centralized scenario/config input;  
\- deterministic Seed contract, replacing mutable global Random usage with keyed/subsystem RNG;  
\- City as the conceptual precursor to Region;  
\- Market as persistent region-local price/clearing state;  
\- Storage as the precursor to sparse Inventory containers;  
\- proportional deterministic clearing primitives and invariant tests;  
\- existing CSV/time-series outputs as temporary adapters to the new snapshot/read-model schema.

Replace/generalize:  
\- City\[4\] \-\> Record\<RegionId, RegionState\> initialized from scenario;  
\- NeighbourCities object references \-\> TransportLink registry \+ IDs;  
\- Pop enum/type role mixing \-\> PopulationCohort \+ ProductionUnit separation;  
\- Pop-owned production \-\> ProductionUnit recipes;  
\- single money scalar/closed-world TotalMoney assumption \-\> sparse Wallets \+ per-currency reconciliation \+ authorized monetary operations;  
\- trader Pop/Deal ownership shortcuts \-\> TradeShipment \+ explicit seller/buyer/fee/tariff settlement;  
\- direct console/CSV domain reads \-\> canonical Phase-15 metric/snapshot read models.

17\. Hard v1 exclusions

Do not add during implementation of this spec: individual persons; banks/private credit; private securities markets; fractional firm equity; FX order books/speculation; dynamic currencies/redenomination; endogenous monetary-union entry/exit; warfare/conquest; land parcels/property markets; detailed housing stocks; microscopic tiles; general-equilibrium solver; household portfolio optimization; tax evasion/corruption/lobbying simulation; direct law/event macro-stat modifiers.

18\. Acceptance gate for subsystem implementation specs

A subsystem spec may extend this core only if:  
\- every new persistent mutable stock has exactly one owner/location;  
\- every transfer has explicit source/destination and phase;  
\- no duplicate Region/State/Clan/population ownership field is introduced;  
\- lifecycle creation/removal cannot silently create/delete stocks;  
\- references use canonical IDs;  
\- derived metrics stay out of mutable domain state;  
\- all cross-currency settlement uses settleFx;  
\- timing fits the 16-phase order or explicitly proves a non-conflicting amendment;  
\- deterministic ordering and tests are specified;  
\- browser complexity remains within mesoscopic targets.

19\. Immediate next spec-writing sequence

1\. Markets \+ trade \+ FX settlement contracts and transaction schemas.  
2\. Production \+ capital \+ labor interface and full ProductionUnit lifecycle formulas/defaults.  
3\. Population \+ demography \+ clans schemas/formulas/cadence.  
4\. State fiscal \+ laws \+ debt \+ monetary policy schemas/formulas/defaults.  
5\. Expansion \+ events \+ territorial succession implementation contracts.  
6\. Metrics/snapshot schema and visualization interface.  
7\. Cross-domain config/defaults, migration plan and acceptance benchmark pack.

This document is the common dependency for all of the above. Subsystem specs should reference it rather than redefining entity identity or tick order.  
