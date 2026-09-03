Economic Simulation — Repository Migration & Milestone Gates

Purpose  
This document defines the ordered implementation path from the current trade\_simulation repository to the canonical autonomous economic simulation specified in Drive. It is not a subsystem design document. It exists to prevent a coding agent from attempting a big-bang rewrite, mixing legacy and canonical accounting, or implementing UI before the simulation spine is testable.

Migration strategy  
Use a strangler migration inside the existing solution. Preserve the repository, solution, CLI entry point and test project while introducing canonical namespaces/modules beside the current City/Pop/Market/Deal model. At each milestone the repository must compile, deterministic tests must pass, and the new path must be runnable through a narrow scenario. Legacy classes are deleted only after their responsibility is covered by canonical code and replacement tests.

Current repository facts that constrain the plan  
The current runtime is compact: TradeCraftSimulation contains City.cs, Pop.cs, Market.cs, Deal.cs, Storage.cs, Simulation.cs, SimulationConfig.cs, CsvLogger.cs and Program.cs. Simulation owns four hard-coded cities, one System.Random seeded from SimulationConfig, and a six-stage turn loop: begin turn, produce/need, update prices, intercity trade, local market, consume/spoil. Program is a CLI with \--turns, \--seed, \--csv, \--quiet and reflection-based SimulationConfig overrides. The test project already has focused Deal, LocalMarket, Market, Simulation and Storage tests. These are useful regression sentinels but do not define the target architecture.

Canonical destination  
The implementation must converge on the contracts in 05 \- Implementation Specs. The target runtime has explicit world registries, typed entities, explicit stocks and ledgers, deterministic keyed RNG, the canonical multi-phase tick pipeline, config/scenario/definition separation, local markets, route-constrained shipments, finite FX settlement, production/labor/capital, population/demography, clans, fiscal/laws, monetary/currency, expansion/settlement, bounded events, reconciliation and read-model snapshots for GitHub Pages.

Repository shape during migration  
Do not split into many projects initially. Keep one production project and one test project until the domain spine is stable. Introduce folders/namespaces inside TradeCraftSimulation approximately as follows:  
\- Domain/Core: identifiers, quantities, money, inventories, registries, lifecycle enums.  
\- Domain/World: Region, State, TransportLink, resource/deposit structures.  
\- Domain/Market: LocalMarket, intents, allocations, shipments, settlement, FX.  
\- Domain/Production: goods/recipes, ProductionUnit, labor plans, capital/investment.  
\- Domain/Population: PopulationCohort, needs, demography, migration.  
\- Domain/Clans: Clan, ClanStateRelation, ownership/cash-flow rules.  
\- Domain/Fiscal: State fiscal state, taxes, laws, procurement, debt.  
\- Domain/Monetary: Currency, MonetaryAuthority, CPI, policy, OMO, FX reconciliation.  
\- Domain/Expansion: settlement/survey projects, jurisdiction transitions.  
\- Domain/Events: definitions, instances, modifiers and physical-loss ledger.  
\- Simulation: WorldState, TickContext, phase orchestrator, reconciliation, keyed RNG.  
\- Config: RunOptions, SimulationConfig, ScenarioDefinition, DefinitionPack, validators.  
\- Diagnostics: accounting ledgers, invariant reports, benchmark snapshots.  
\- Presentation: immutable read models / ExplanationFacts only after the simulation spine is stable.  
Legacy City/Pop/Market/Deal may coexist temporarily under Legacy or their current namespace, but canonical code must never silently read/write the same stock through both models.

Non-negotiable migration rules  
1\. One authoritative owner per stock. During dual-running, legacy stocks and canonical stocks are separate worlds; do not mirror mutations bidirectionally.  
2\. No hidden compatibility magic. If an adapter exists, it converts at a boundary and has tests.  
3\. Determinism is a milestone gate, not final polish. Canonical code must not accept a shared mutable Random.  
4\. Accounting invariants arrive with the first canonical money/goods transfers, not after all subsystems exist.  
5\. Every milestone has one executable scenario that proves its new behavior end to end.  
6\. UI never mutates simulation state. Presentation consumes snapshots/read models.  
7\. Do not delete working legacy tests until equivalent canonical tests exist. Tests that assert obsolete economics may be quarantined/renamed as Legacy rather than rewritten to bless new behavior.  
8\. Do not preserve legacy formulas merely to minimize diff size. Preserve repository plumbing and useful concepts; replace obsolete economic mechanics explicitly.  
9\. No banks/private credit in core v1.  
10\. No multi-hop trade pathfinding or all-pairs routing in core v1; use explicit sparse TransportLinks.

Milestone 0 — Baseline lock and migration scaffolding  
Goal: make the starting repository reproducible before structural change.  
Implementation:  
\- Record current default-branch test result and representative 30-turn seeded output/hash.  
\- Add a deterministic canonical test helper and snapshot/hash utility independent of console formatting.  
\- Add folders/namespaces for Config, Domain, Simulation and Diagnostics without moving legacy classes yet.  
\- Add a migration marker documenting which classes are legacy.  
\- Keep Program behavior unchanged.  
Gate M0:  
\- dotnet build succeeds.  
\- all existing tests pass unchanged.  
\- same legacy seed produces the same legacy snapshot across repeated runs on the same runtime.  
\- no canonical subsystem behavior has been introduced yet.  
Rollback point: repository state before canonical entities.

Milestone 1 — Canonical primitives, config and world genesis  
Goal: create the target data spine without markets or autonomous behavior.  
Implementation:  
\- Implement typed IDs and primitive value/domain types required by CORE\_SCHEMA\_AND\_LIFECYCLES.  
\- Implement RunOptions, SimulationConfig, ScenarioDefinition and DefinitionPack with validation.  
\- Implement stable registries for Region, State, Currency, Clan, PopulationCohort, ProductionUnit, LocalMarket, TransportLink and definitions, allowing initially empty/non-active subsystems where specified.  
\- Implement keyed deterministic RNG service. RNG keys must include seed \+ tick \+ phase \+ entity/event key as specified; iteration order must not alter results.  
\- Implement baseline definition pack and baseline-multistate-v1 scenario construction.  
\- Implement WorldGenesisLedger and initialization reconciliation.  
\- Keep legacy Simulation runnable separately.  
Gate M1:  
\- baseline world creates exactly the scenario-defined entity counts and IDs.  
\- repeated genesis with same seed is byte/field-equivalent after normalized ordering.  
\- bounded keyed variation changes only fields permitted by the world-generation contract.  
\- invalid cross-references/config ranges fail fast with useful diagnostics.  
\- opening money, goods, population, capital and resource stocks reconcile to WorldGenesisLedger.  
\- legacy test suite remains green.  
Deliverable state: CanonicalWorldBuilder can build but not yet advance the economy.

Milestone 2 — Canonical tick orchestrator and ledger framework  
Goal: establish causality and reconciliation before implementing economic richness.  
Implementation:  
\- Implement WorldState, TickContext and canonical phase orchestrator with no-op phase handlers.  
\- Implement PendingTransitions and deterministic phase barriers.  
\- Implement typed flow/ledger entries required for goods, money and physical losses.  
\- Implement phase-level invariant hooks and fail-fast diagnostic mode.  
\- Add canonical CLI mode behind an explicit switch or scenario argument; do not silently replace legacy default yet.  
Gate M2:  
\- 100+ no-op ticks preserve all stocks exactly except explicitly time-derived counters.  
\- phase order is asserted by a trace test.  
\- a handler cannot mutate a phase-owned future transition early.  
\- deterministic replay hash is stable for at least 100 ticks.  
\- zero-flow reconciliation passes for all tracked stock categories.

Milestone 3 — Local markets and transaction settlement  
Goal: prove the smallest complete goods-for-money loop before trade, FX, production or demography.  
Implementation:  
\- Implement MarketIntent, local seller/buyer allocation, affordability revalidation, transaction tax hooks, LocalMarket state and sticky bounded repricing.  
\- Implement atomic local settlement and market ledgers.  
\- Use seeded static inventories/wallets from a tiny test scenario; production and population decision logic may still be scripted fixtures.  
\- Preserve only useful conceptual behavior from legacy Market; do not adapt legacy Deal into the canonical transaction primitive.  
Gate M3:  
\- canonical local-market golden scenarios pass.  
\- no buyer spends below zero; no seller transfers unavailable goods.  
\- goods and transaction money reconcile exactly after every settlement.  
\- allocation is deterministic under shuffled input enumeration.  
\- price moves obey configured bounds and shortage/surplus direction.  
\- consumption tax reaches the explicit recipient and is never a sink.  
Migration consequence: legacy Market/LocalMarket tests remain legacy-only; new canonical tests become authoritative for new code.

Milestone 4 — Production, labor, consumption and local closed economy  
Goal: make one Region economically autonomous without interregional trade.  
Implementation:  
\- Implement RecipeDefinition, ProductionUnit lifecycle, installedCapital, inventories, bottleneck production, input targets, output intents, investment/depreciation and finite extraction.  
\- Implement PopulationCohort needs/budgets, labor supply plans, regional aggregate labor allocation, gross wages, withholding, household demand, consumption and spoilage.  
\- Implement Clan ownership only to the minimum needed for ProductionUnit owner cash flows; deeper clan dynamics wait.  
\- Wire phases so wages earned at Phase 5 are available to Phase 8 through the canonical forecast/maxSpend \+ actual affordability contract.  
Gate M4:  
\- one-region golden economy runs at least 240 ticks without accounting failure, NaN/Infinity or negative stocks.  
\- production cannot exceed labor/input/capital/resource constraints.  
\- payroll and withholding reconcile.  
\- household purchases never exceed actual post-wage cash at settlement.  
\- capital installation consumes real goods and depreciation never creates goods.  
\- finite deposits only decline through recorded extraction.  
\- deterministic hash stable for the golden run.  
Migration consequence: legacy Pop production/consumption responsibilities are now superseded for canonical mode but legacy classes may remain for comparison until M6.

Milestone 5 — Transport, interregional trade and FX  
Goal: connect local economies using one canonical settlement path.  
Implementation:  
\- Implement explicit TransportLink capacity/cost, shipment lifecycle and beneficial ownership.  
\- Implement route-constrained international/interregional intent generation and shipment creation.  
\- Implement canonical pairwise finite FX liquidity pool, quoteFx/settleFx and reservation ledger.  
\- Apply tariffs, consumption tax and transport fee to explicit recipients.  
\- Implement Phase-11 FX reconciliation/update only after all same-tick settlement consumers complete.  
Gate M5:  
\- no shipment exceeds link capacity or transfers more than origin inventory.  
\- shipment shrinkage for insufficient FX occurs before goods leave the seller.  
\- cross-currency buyer debit, FX reserves and seller receipt reconcile exactly.  
\- tariffs/fees/taxes have named recipients.  
\- same sparse network and seed give identical allocations regardless of dictionary iteration order.  
\- closed-border/zero-capacity/zero-FX golden scenarios halt trade without corrupting local markets.  
Migration consequence: legacy Deal and City.Trade are functionally obsolete in canonical mode. Their tests may be moved to Legacy tests; do not call Deal from canonical code.

Milestone 6 — States, fiscal flows, laws, clans and sovereign debt  
Goal: introduce institutions once private/market accounting is stable.  
Implementation:  
\- Implement complete Clan/ClanStateRelation behavior, dividends, member distributions, owner injections and bounded preference/network effects.  
\- Implement State treasury, tax schedules, automatic transfers, procurement via ordinary markets, public infrastructure investment, State-owned ProductionUnits and fiscal policy rules.  
\- Implement law/policy gates as pure queries over active institutional state.  
\- Implement StateBond \+ BondHolding and Phase-1 planned issuance / Phase-10 debt service/default.  
\- Reuse settleFx for every cross-currency clan/fiscal/debt payment; no subsystem-local FX logic.  
Gate M6:  
\- treasury identity reconciles each tick.  
\- wage tax, consumption tax, tariffs and profit tax occur exactly once at their defined phases.  
\- public procurement cannot conjure goods or bypass market affordability.  
\- debt issuance creates matched cash/bond positions; service transfers or destroys money only according to holder type and monetary contract.  
\- clan transfers conserve money net of explicitly modeled monetary-authority operations.  
\- laws alter gates/parameters only through documented interfaces, not arbitrary direct stock edits.  
At M6 remove canonical dependencies on legacy City, Pop, Market and Deal entirely. Legacy runtime may now be archived or deleted after M6 gate plus canonical regression coverage.

Milestone 7 — Monetary authorities, currencies and monetary policy  
Goal: enable state-specific monetary regimes without adding a banking system.  
Implementation:  
\- Implement MonetaryAuthority, currency membership/legal tender rules, CPI baskets, chained CPI/inflation and bounded lagged policy rule.  
\- Implement planned Phase-1 sovereign-bond OMO and authority bond holdings.  
\- Implement exact per-currency transaction-money reconciliation, including issuance/destruction operations.  
\- Implement monetary union and foreign-legal-tender behavior.  
Gate M7:  
\- each currency's transaction money satisfies the monetary reconciliation identity each tick.  
\- CPI uses tax-inclusive actually transacted household prices/weights defined by contract.  
\- policy rate only reacts to lagged/available information.  
\- OMO cannot execute without a matching planned operation and eligible bond inventory/counterparty.  
\- monetary-union members share the authority exactly as configured; foreign legal tender does not confer policy membership.  
\- recession/inflation/OMO/FX-liquidity golden scenarios pass.

Milestone 8 — Demography, migration, expansion and state succession  
Goal: permit the world structure to evolve without changing entity identity rules.  
Implementation:  
\- Implement health/prosperity EMAs, births, deaths, aging, social mobility and deterministic cohort merge.  
\- Implement route-constrained migration carrying bounded population, wallets and inventories according to contract.  
\- Implement settlement/survey projects, knowledge-only resource discovery, market activation/dormancy, incorporation, abandonment and successor-State formation.  
\- Execute jurisdiction changes only via PendingTransitions at the specified boundary.  
Gate M8:  
\- world population reconciles births/deaths/migration/reclassification exactly.  
\- migration cannot teleport across unavailable routes or duplicate wallet/inventory stocks.  
\- survey/discovery never creates physical resource stock.  
\- settlement cannot spawn money, goods, population, firms, links or currency.  
\- jurisdiction transitions are deterministic and take effect only on the defined next-tick boundary.  
\- successor-State fiscal/currency initialization follows canonical succession rules and does not automatically join a monetary union.

Milestone 9 — Events and shocks  
Goal: add bounded exogenous disturbances only after endogenous propagation works.  
Implementation:  
\- Implement EventDefinition/EventInstance, eligibility, keyed hazard scheduler, severity/duration/spatial scope and the typed ShockOperations.  
\- Implement reconstructable EventModifierIndex and EventPhysicalLoss ledger.  
\- Apply immediate physical losses exactly once; temporary modifiers must be derivable from active events.  
Gate M9:  
\- event occurrence and severity are deterministic for a fixed seed and unaffected by unrelated iteration ordering.  
\- events never directly write prices, GDP, CPI, policy rate, jurisdiction or transaction money.  
\- all destroyed goods/capital/resources/population are attributed to permitted physical/demographic flows.  
\- overlapping modifiers combine according to the contract and expire cleanly.  
\- event golden scenarios demonstrate endogenous propagation through markets/fiscal/monetary/demographic systems.

Milestone 10 — Full reconciliation, benchmark scenarios and performance hardening  
Goal: convert subsystem correctness into whole-simulation confidence.  
Implementation:  
\- Run all subsystem invariants every tick in test/diagnostic builds and sampled/bounded checks in interactive release mode where needed.  
\- Add normalized world-state hashing and deterministic replay fixtures.  
\- Add canonical benchmark scenario runner producing machine-readable metrics.  
\- Profile allocations, phase runtime and snapshot size on baseline world.  
\- Remove reflection-based config override as the primary config API; retain a narrow compatibility parser only if useful for CLI experiments.  
Gate M10:  
\- all consolidated acceptance scenarios pass for target horizons.  
\- no unexplained money/goods/population/capital/resource drift.  
\- same input package \+ seed yields identical normalized state hash.  
\- baseline browser-equivalent workload meets the performance budget defined by the acceptance/performance spec.  
\- no per-tick unbounded history growth; histories use configured retention/downsampling.  
\- zero invariant failures over the canonical long benchmark.

Milestone 11 — Read models, browser host and GitHub Pages observatory  
Goal: expose the simulation without coupling visualization to mutable domain objects.  
Implementation:  
\- Implement immutable/snapshot read models and ExplanationFacts from canonical metric owners behind one browser-facing SimulationOutput contract. Every serialized SimulationOutput carries top-level outputSchemaVersion \= 1 for v1; it owns RunMetadata and HistoryRetentionMetadata alongside the snapshot/read-model payload. RunMetadata carries the canonical runIdentity. For v1, scenarioHash, configHash and definitionPackHash are SHA-256 digests of normalized canonical JSON; runIdentity is SHA-256 over the named canonical identity { scenarioId, scenarioHash, seed, configHash, definitionPackHash, engineBuildId }. Schema-defined unordered keyed collections are sorted by stable key/id; genuinely ordered arrays preserve order. Process-local hashes, insertion order, timestamps, random UUIDs and ambiguous build labels are not valid identity inputs. Every active-run payload, retained snapshot and cached DefinitionBundle must match both outputSchemaVersion and runIdentity. Unsupported versions fail before partial parsing, preserve the last verified snapshot as stale/read-only evidence and surface the recoverable runtime-error state.  
\- Host simulation in a browser Worker (or equivalent isolated execution path chosen by the visualization spec). On same-run recovery, resume only after schema/run-identity compatibility checks. If the Worker reports a different runIdentity, atomically clear timeline history, compare baseline, selection state and run-scoped caches before rendering that run. For same-run delivery, logical observation commits must be idempotent across retry/reorder: identical committed blocks are no-ops, conflicting committed content is rejected, and stale chunks may affect only uncommitted staging. The concrete transport fields are implementation-defined, but they must prove enough block identity/freshness to prevent duplicate append, committed-data overwrite, coverage regression or resurrection of evicted detail.  
\- Build world map, state, region, market, production, population, clan, fiscal, monetary, event and diagnostic views in the order specified by VISUALIZATION\_AND\_EXPLAINABILITY.  
\- Implement timeline controls, deterministic reset/replay and bounded history/downsampling. HistoryRetentionMetadata exposes explicit retained tick coverage through canonical aggregateTickRanges/detailedTickRanges. TickRanges use non-negative integer ticks, are sorted, strictly disjoint and coalesced; detailed coverage is a subset of aggregate coverage. Empty history has both range lists empty and nullable aggregate/detail bounds absent; aggregate-only history has no earliestDetailedTick. Scrub/compare/deep-link/import availability is decided from this metadata plus explicit EntityLifecycleRecord coverage, never from min/max assumptions or missing snapshot arrays. The range lists are metadata projections, not a second history store. Validate them after schema/run compatibility but before admitting history; malformed or contradictory metadata is rejected atomically and is never silently sorted, merged, clamped or filled. Retention coverage is also a completeness claim: a tick enters aggregate coverage only after its required aggregate observation tier is complete, and enters detailed coverage only after aggregate coverage plus its required retained detail/explanation families are complete. Explicit empty collections may prove valid zero-record blocks; omitted applicable blocks mean incomplete/unavailable. Partial Worker chunks may stage data but must not advance coverage early, and portable packages whose declared coverage disagrees with included blocks are rejected before partial display.  
\- Emit EntityLifecycleRecord\[\] as browser-facing lifecycle truth for typed stable entity references. Keep a lifecycle record while any retained snapshot, ExplanationFact, EventRecord or other retained observation refers to that entity; once the last such observation is evicted, the record may be evicted. predecessorRefs/successorRefs are informative only and must not recursively pin an unbounded lineage chain.  
\- Store DefinitionBundle as one run-scoped immutable block separate from per-tick history. Tick/history payloads reference definitions only by stable IDs and must not duplicate definition content. Portable export may include at most one compatible DefinitionBundle plus only observation blocks actually retained for its declared range; it must not reconstruct evicted history, serialize transient orders/mutable WorldState or silently widen retention.  
\- Preserve existing docs/GitHub Pages deployment plumbing where useful, replacing the old static page incrementally. Implement share/deep-link state only as a navigation hint: view, stable entity id/type, selected tick, compare baseline and lightweight filters may be encoded; runIdentity may appear only as a compatibility guard and never as the source of run truth. Use GitHub-Pages-safe query/hash/base-path semantics rather than server-dependent SPA routes.  
Gate M11:  
\- UI cannot mutate WorldState except through explicit run-control commands.  
\- Worker restart/recovery never appends a different runIdentity into retained history; stale last-verified data remains visibly read-only until compatible same-run output resumes, and different-run output resets all run-scoped UI state before rendering.  
\- pausing/replaying from the same seed and config reproduces state hashes.  
\- HistoryRetentionMetadata exactly matches actual retained aggregate/detail coverage after eviction, downsampling and portable import/export. Range membership is authoritative even when retained ticks are non-contiguous; old aggregate ticks may remain viewable after detailed causes expire, aggregate-only imports may have no earliestDetailedTick, and evicted/non-exported ticks are not selectable. Negative/reversed, unsorted, overlapping, adjacent-uncoalesced, bounds-inconsistent or detail-outside-aggregate ranges fail the gate. Empty history is valid only with empty range lists and null/absent bounds; malformed Worker/import metadata is rejected before partial append/display. Coverage also fails the gate if it advertises a tick before the required aggregate/detail observation tier is complete, or if a portable package contains tick-indexed blocks inconsistent with the tier coverage it declares; partial chunks may not make incomplete ticks selectable/renderable.  
\- Worker retry/reordering is idempotent at the logical observation-commit boundary. Exact re-delivery of an already committed run/tick/tier block does not append duplicate snapshots, ExplanationFacts or lifecycle data; conflicting content for that committed block fails the gate. Delayed older-attempt chunks cannot overwrite committed data, roll coverage backward or make already-evicted detail retained again. Coverage changes atomically with the verified observation commit or explicit retention/eviction/downsampling commit. A retention transition reads only committed same-run observations; any aggregate derived from finer detail is materialized and verified before source detail is removed. Removing aggregate coverage also removes detail coverage for that tick. Observation-block replacements/removals, retention ranges and affected reference-bounded lifecycle records become visible as one consistent transition, and delayed pre-eviction payloads cannot undo it. Retention/downsampling may preserve or remove availability but never resurrect it.  
\- Lifecycle/read-model retention is reference-bounded: every typed entity referenced by retained observation data has a matching EntityLifecycleRecord, retired lifecycle records are evicted when no retained observation needs them, and export does not recursively pull external lineage history.  
\- compare mode never substitutes another baseline tick; unavailable baselines/entities disable the affected delta with a reason, and nominal cross-currency percentage deltas are suppressed unless a canonical conversion exists.  
\- every headline metric can expose its canonical definition/source and, where specified, causal explanation facts.  
\- UI remains responsive under baseline and stress acceptance worlds.  
\- per-tick Worker/history payloads do not duplicate immutable definitions. A portable export is bounded to its declared retained range plus at most one compatible DefinitionBundle; unavailable history/detail is refused explicitly rather than reconstructed or silently retained.  
\- production build deploys successfully to GitHub Pages with no server dependency; direct-open and refresh of supported share/deep links work under the repository Pages base path. A URL requesting an evicted tick, unavailable baseline/entity or mismatched runIdentity must show an explicit unavailable/incompatible state and must not silently substitute another tick, entity or run.

Milestone 12 — Legacy removal and release candidate  
Goal: leave one coherent implementation, not two simulations.  
Implementation:  
\- Delete or archive legacy City, Pop, Market, Deal and any obsolete SimulationConfig properties once no canonical code/test depends on them.  
\- Replace Program's legacy wording and seed description; make canonical scenario execution the default.  
\- Keep useful CLI controls for seed, turns, scenario/config and benchmark/export modes.  
\- Update README architecture/run/test/deploy instructions.  
\- Remove dead compatibility adapters and obsolete legacy tests after replacement coverage is demonstrated.  
Gate M12:  
\- repository grep/dependency inspection finds no production references to legacy economic classes.  
\- clean clone: restore, build, test, benchmark smoke and Pages build all succeed.  
\- default CLI run and Pages run use the same canonical simulation package and deterministic semantics.  
\- documentation points only to current commands/configuration.  
\- HANDOFF acceptance suite is green.

Milestone dependency order  
M0 \-\> M1 \-\> M2 \-\> M3 \-\> M4 \-\> M5 \-\> M6 \-\> M7 \-\> M8 \-\> M9 \-\> M10 \-\> M11 \-\> M12.  
Parallel work is allowed only inside a milestone when modules do not share mutable contracts. In particular, do not implement M7 monetary policy before M5 finite FX and M6 sovereign debt contracts exist; do not implement M8 migration before population wallets/inventories and routes are stable; do not implement M11 UI against legacy domain objects.

Recommended commit/PR granularity for Codex/Claude  
Each milestone should normally be 2–6 small commits/PR-sized changes, not one giant patch. Preferred sequence inside a milestone: schemas/types \-\> pure algorithms \-\> settlement/mutations \-\> orchestration \-\> invariants/tests \-\> scenario/golden test \-\> cleanup. A coding agent may subdivide further but must not move a later subsystem across a failed gate.

Legacy-to-canonical responsibility map  
\- Simulation.cs: preserve the idea of one top-level orchestrator; replace hard-coded city world and six-step loop with WorldState \+ canonical phase pipeline.  
\- SimulationConfig.cs: preserve centralized tunables; split into RunOptions/SimulationConfig/ScenarioDefinition/DefinitionPack and delete obsolete trader/noise/specialization knobs.  
\- City.cs: decompose into Region \+ LocalMarket \+ cohorts \+ production units \+ jurisdiction/transport references. Do not create a canonical City aggregate owning all stocks.  
\- Pop.cs: split population cohort, household demand/labor behavior and ProductionUnit ownership/production responsibilities.  
\- Market.cs: retain bounded sticky price intuition only where it matches the canonical contract; replace market state/clearing interfaces.  
\- Deal.cs: do not evolve it into the new trade engine. Replace with allocations \+ atomic settlement \+ Shipment \+ settleFx.  
\- Storage.cs: preserve tested inventory-safety concepts where compatible, but move to typed inventories and canonical reserve semantics.  
\- CsvLogger.cs: treat as transitional diagnostics. Later export from canonical snapshots/benchmark metrics rather than traversing legacy Cities.  
\- Program.cs: preserve CLI usefulness; migrate construction and options late enough that developers always retain a runnable harness.  
\- docs/: preserve GitHub Pages/deployment infrastructure where valid; replace presentation only after read models exist.

Test migration policy  
Create canonical test namespaces/folders rather than editing every existing test in place. Classify tests as: LEGACY\_REGRESSION (protects pre-migration behavior temporarily), CANONICAL\_UNIT, CANONICAL\_INVARIANT, GOLDEN\_SCENARIO, DETERMINISM, and PERFORMANCE. A legacy test may be removed only when the production responsibility it guards has been deleted or when an equivalent canonical test proves the retained property. Never rewrite an old expected value solely to make a new formula pass.

Definition of a passed milestone  
A milestone is passed only when all of the following are true: production build compiles; tests for previous passed milestones still pass; new required tests pass; deterministic replay check passes; relevant accounting invariants pass; its golden scenario runs through the public canonical orchestrator; no TODO requires a material economic/product-design choice; and repository documentation or migration notes identify any intentionally retained legacy surface.

Stop/repair conditions  
Stop forward implementation and repair the current milestone if any of these occur: unexplained stock drift; order-dependent deterministic failures; two writers for one stock; direct subsystem-specific FX transfer logic; UI mutation of domain state; a phase reads future-tick information; config value ownership is ambiguous; scenario initialization bypasses GenesisLedger; or a coding agent must invent a material formula not specified in the implementation contracts. These are architecture failures, not acceptable technical debt.

What is explicitly postponed beyond core v1  
Commercial banks/private credit; securities beyond sovereign bonds and their holdings; detailed individual agents; multi-hop route optimization; unconstrained firm entry with complex entrepreneurship; automatic central-bank profit remittance; high-frequency order books; dozens of goods; military conquest/war simulation. Add only through a later design/benchmark decision, never opportunistically during migration.

Planning status  
This migration plan is final and is paired with ACCEPTANCE\_BENCHMARK\_PERFORMANCE\_SUITE. Use M0–M12 here as implementation checkpoints and that suite as the authority for numeric correctness, history/replay, browser-performance and UI acceptance gates.

Runtime implementation resolution — 2026-09-03

This section resolves stale repository-shape wording above and is authoritative for M0-M12 execution.

M0 is the only milestone whose canonical work remains entirely inside the existing .NET 9 baseline: freeze build/tests, record deterministic legacy golden outputs, and establish migration scaffolding.

From M1 onward, implement the canonical simulation engine in TypeScript as the browser-capable runtime. Keep the existing C\# simulation runnable as a legacy/reference oracle while responsibilities migrate, but do not implement each new canonical subsystem in C\# and then port it again to TypeScript. Any earlier Domain/Core, Domain/World, Simulation, Config or Diagnostics folder examples under TradeCraftSimulation are conceptual responsibility boundaries, not a mandate to place the canonical implementation in the C\# project.

The strangler boundary is behavioral responsibility: migrate one tested responsibility at a time from the C\# legacy path to the canonical TypeScript path, using normalized golden/parity evidence where useful. Never mirror authoritative mutable stocks bidirectionally between runtimes.

M11 adds the dedicated Worker host, immutable SimulationOutput/read-model transport and GitHub Pages observatory around the same TypeScript engine built since M1. M11 must not trigger a second engine rewrite or port.  
