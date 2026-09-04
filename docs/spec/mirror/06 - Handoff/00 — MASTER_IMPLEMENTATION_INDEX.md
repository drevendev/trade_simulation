MASTER IMPLEMENTATION INDEX \+ PRE-HANDOFF REVIEW — Economic Simulation

Status: FINAL HANDOFF MASTER INDEX v1; canonical precedence, normalization, and implementation execution order.

1\. Purpose

This document is the master implementation index for Codex/Claude. It does not redefine subsystem economics. It establishes document precedence, the canonical reading order, the repository milestone sequence, known superseded wording, simplicity guardrails, and the rules that keep implementation aligned with the completed handoff.

The economic architecture and handoff are complete. Implementation should follow the canonical contracts and milestone gates rather than reopen product or economic design.

2\. Canonical authority and conflict precedence

When two implementation documents disagree, use this order:

1\) This MASTER\_IMPLEMENTATION\_INDEX\_AND\_PRE\_HANDOFF\_REVIEW for explicit conflict resolutions and reading order.  
2\) IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01 for the interfaces it explicitly normalized.  
3\) The most specific mature subsystem contract in 05 \- Implementation Specs for subsystem-local schemas, formulas, algorithms, parameters, edge cases, invariants and tests.  
4\) CORE\_SCHEMA\_AND\_LIFECYCLES for common identity, registry ownership, stock/flow discipline and the canonical tick skeleton, except where explicitly superseded by \#1 or \#2.  
5\) CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION for configuration ownership, defaults, scenario construction and genesis.  
6\) REPOSITORY\_MIGRATION\_AND\_MILESTONE\_GATES for implementation sequence and migration gates.  
7\) ACCEPTANCE\_BENCHMARK\_PERFORMANCE\_SUITE for executable acceptance, deterministic benchmark and browser-performance thresholds.  
8\) 03 \- Economic Model and 04 \- Visualization are design rationale/reference. They may clarify intent but must not silently override a later implementation contract.  
9\) 02 \- Research and 01 \- Inputs are evidence/intent, not implementation authority.

Rule: an implementation agent must never resolve a contradiction by averaging two formulas or inventing a third mechanic. If a conflict is not resolved by the precedence above, stop that milestone and treat it as a spec defect.

3\. Canonical implementation document set

Read in this order before starting M1–M2:

A. CORE\_SCHEMA\_AND\_LIFECYCLES — Economic Simulation  
Common IDs, registries, ownership boundaries, WorldState/TickContext, PendingTransitions, transaction discipline, deterministic RNG and tick causality.

B. IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01 — Economic Simulation  
Mandatory patches to stale core/schema wording and cross-contract timing/ownership rules.

C. CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION — Economic Simulation  
RunOptions, SimulationConfig, ScenarioDefinition, DefinitionPack, baseline defaults, world-gen validation and WorldGenesisLedger.

Then read subsystem contracts as their milestone becomes active:

D. MARKETS\_TRADE\_FX\_CONTRACTS — Economic Simulation  
Local market intents/clearing, sticky repricing, shipments, transport, finite FX, taxes/fees at settlement and market invariants.

E. PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS — Economic Simulation  
ProductionUnit lifecycle, recipes, inputs/outputs, labor demand/allocation, wages, installed capital, investment, depreciation and extraction.

F. POPULATION\_DEMOGRAPHY\_CLANS\_CONTRACTS — Economic Simulation  
Canonical cohort schema, household needs/demand, demographic flows, migration, social mobility, clan ownership/treasury/distributions/network effects.

G. STATE\_FISCAL\_LAWS\_CONTRACTS — Economic Simulation  
Treasury, tax bases/timing, transfers, procurement, infrastructure, State-owned units, laws, debt issuance/service/default and fiscal policy.

H. MONETARY\_CURRENCY\_CONTRACTS — Economic Simulation  
Currency/MonetaryAuthority schemas, CPI/inflation, policy-rate rule, money reconciliation, OMO, monetary unions/foreign legal tender and FX close.

I. EXPANSION\_SETTLEMENT\_CONTRACTS — Economic Simulation  
Stable Regions, settlement/survey projects, discovery, market activation/dormancy, incorporation, abandonment and successor-State formation.

J. EVENTS\_SHOCKS\_CONTRACTS — Economic Simulation  
Event definitions/instances, deterministic hazards, typed ShockOperations, modifier index, physical-loss ledger and propagation boundaries.

Cross-cutting implementation/planning documents:

K. ACCEPTANCE\_BENCHMARK\_PERFORMANCE\_SUITE — Economic Simulation  
P0–P3 profiles, A01–A14 scenarios, global accounting, determinism, CI tiers and numeric browser/runtime budgets.

L. REPOSITORY\_MIGRATION\_AND\_MILESTONE\_GATES — Economic Simulation  
M0–M12 strangler migration, legacy-to-canonical responsibility map, test migration policy, stop conditions and milestone promotion rules.

Visualization source of truth for the final M11 observatory (pre-M11 Milestone Preview work follows document L):

M. 04 \- Visualization / VISUALIZATION\_AND\_EXPLAINABILITY — Economic Simulation  
Read-model boundaries, observatory views, ExplanationFacts, timeline/replay, Worker/UI separation and GitHub Pages presentation behavior. Its performance targets are operationalized by document K.

4\. Canonical tick numbering — explicit normalization

The engine has SIXTEEN phases numbered 0 through 15\. This is the canonical numbering.

Phase 0 BeginTick.  
Phase 1 activate carried regime, due transitions, arrivals/scheduled operations/events.  
Phase 2 expectations and planning.  
Phase 3 labor allocation.  
Phase 4 pre-production procurement.  
Phase 5 production/extraction and wage settlement.  
Phase 6 main-market offer/price formation.  
Phase 7 interregional/international shipment planning and settlement.  
Phase 8 residual local main-market clearing.  
Phase 9 realized consumption and needs.  
Phase 10 fiscal settlement and income distribution.  
Phase 11 monetary/FX bookkeeping and reconciliation.  
Phase 12 depreciation/spoilage/investment/settlement construction.  
Phase 13 demography/social mobility/migration.  
Phase 14 slow territorial/lifecycle review and N+1 transition decisions.  
Phase 15 accounting, metrics, policy review, invariant close and snapshot/read-model generation.

Earlier pre-QA copies used “Phase 16” for invariant normalization/serialization close. That wording has been repaired in the current consistency document. Do NOT add a seventeenth phase: the canonical engine remains sixteen phases numbered 0–15, with invariant/serialization close inside Phase 15\.

5\. Canonical schema normalizations from the pre-handoff review

The following superseded core fields must not be implemented as authoritative state:

\- PopulationCohort: do not use LOWER/MIDDLE/UPPER \+ persistent laborStatus/employedPersons \+ generic inventory/health/prosperity from the early core draft. Use the mature cohort contract: VULNERABLE / WORKING\_MIDDLE / AFFLUENT, laborCategory, householdInventory, healthIndex, prosperityEma, essentialSatisfactionEma, realIncomePerCapitaEma, employmentRateEma, migrationPressureEma and mobilityAccumulator. Current employment is a TickContext/LaborAllocation flow, not a duplicated persistent stock.  
\- RegionState.marketStatus is not authoritative. LocalMarketState.status is the sole ACTIVE/DORMANT market lifecycle field.  
\- RegionState.pendingControllerStateId is not authoritative. PendingTransitions.jurisdictionChanges is the sole future-controller queue.  
\- ProductionUnit.capacity is not an independently mutable stock. installedCapital is authoritative; nameplate capacity is derived from installedCapital × recipe capacity coefficient, with condition/modifiers applied through defined functions.  
\- Generic Inventory remains a type/container concept, not one universal actor field. Use householdInventory, ProductionUnit input/output/investment inventories, State.publicInventory and typed accessors.  
\- TradeShipment must include the mature beneficial-owner and settlement/audit linkage required by the Markets/Trade contract, plus destinationInventoryBucket so delayed delivery reaches the intended INPUT / OUTPUT / INVESTMENT stock. Goods are never counted in origin inventory and shipment ownership simultaneously.

These are mechanical schema normalizations, not economic redesign.

6\. Causality and settlement rules that must remain global

One stock, one authoritative owner. One realized transfer, one settlement path.

\- Same-tick wages: Phase-2 household plans may include a bounded forecast in maximum intent envelopes; actual wages enter the wallet in Phase 5; Phase-8 affordability is revalidated against actual post-wage cash. There is no second household planning/shopping loop and no household credit.  
\- Cross-currency payment: every trade, Clan, fiscal or debt payment uses the same finite settleFx primitive and the same pairwise liquidity pool. Liquidity consumed earlier in a tick remains consumed later in the tick.  
\- Fiscal timing: wage tax at payroll, consumption tax with transactions, tariff with international settlement, remaining realized-base business/profit taxes in Phase 10\. No tax may be charged twice during later reconciliation.  
\- Policy/jurisdiction causality: Phase-14/15 decisions queue N+1 effects. Current-tick taxes, borders, legal tender, tariffs and monetary-policy effects never change retroactively.  
\- Money: ordinary transactions merely transfer transaction money. Creation/destruction exists only in explicitly authorized monetary/genesis operations and reconciles by currency.  
\- Goods/capital/resources/population: every physical/biological change has a typed source/sink. Discovery changes knowledge only; settlement/state formation cannot create private assets or population.  
\- Events: may directly modify permitted physical/biological capacity inputs and record losses; they never assign prices, GDP, CPI, unemployment, policy rate, migration counts, jurisdiction or transaction money.  
\- UI: snapshots, metrics and ExplanationFacts are read models. Turning visualization/diagnostics on or off cannot alter canonical state or consume economic RNG.

7\. Master implementation execution order

Implement strictly through the existing M0–M12 gates. Do not collapse gates into a big-bang rewrite.  
Cross-cutting visibility rule: every milestone M0–M12 allocates at least 5% of planned implementation units, rounded up with a minimum of one, to user-visible visualization/presentation work on GitHub Pages. For M0–M10 this is a lightweight Milestone Preview fed by deterministic one-way diagnostic/golden output, not the final browser API; M11 replaces/absorbs those previews into the canonical SimulationOutput \+ Worker observatory; M12 removes obsolete preview/legacy wiring and leaves the canonical Pages experience. A visualization unit counts only when its acceptance includes a visible Pages change plus a basic build/render smoke check.

M0 Baseline lock/scaffolding — preserve current build/tests and legacy seeded baseline.  
M1 Canonical primitives/config/world genesis — typed IDs, registries, config split, keyed RNG, baseline scenario, GenesisLedger.  
M2 Tick/ledger spine — WorldState, TickContext, 0–15 orchestrator, PendingTransitions, ledgers, invariant hooks.  
M3 Local markets — smallest complete goods-for-money loop with atomic settlement and repricing.  
M4 Production/labor/population closed economy — one-region autonomous loop, wage timing, needs, production/capital/extraction.  
M5 Transport/trade/FX — explicit links, shipments, tariffs/fees and canonical finite settleFx.  
M6 Fiscal/laws/clans/debt — institutions only after private/market accounting is stable.  
M7 Monetary/currency — CPI, policy, OMO, currency regimes and exact per-currency reconciliation.  
M8 Demography/migration/expansion/succession — world evolution through existing stock-flow boundaries.  
M9 Events/shocks — exogenous shocks only after endogenous propagation works.  
M10 Whole-system acceptance/performance — P2/P3, A13/A14, long deterministic/accounting runs and profiling.  
M11 Browser/GitHub Pages observatory — immutable versioned SimulationOutput read models, Worker host, timeline/replay and explanatory visualization. SimulationOutput is the browser-facing ownership boundary: top-level outputSchemaVersion \= 1 for v1, and RunMetadata carries the canonical runIdentity. For v1, scenarioHash, configHash and definitionPackHash are SHA-256 digests of normalized canonical JSON; runIdentity is SHA-256 over the named canonical identity { scenarioId, scenarioHash, seed, configHash, definitionPackHash, engineBuildId }. Schema-defined unordered keyed collections are sorted by stable key/id, genuinely ordered arrays preserve order, and process-local hashes, insertion order, timestamps, random UUIDs or ambiguous build labels are forbidden identity inputs. HistoryRetentionMetadata travels with the observations it describes and exposes authoritative aggregateTickRanges/detailedTickRanges for retained tick membership; earliest/latest fields are convenience bounds only. These ranges are compact metadata projections of retained observations, not a second history store, and they never recreate evicted data. SimulationOutput also carries EntityLifecycleRecord\[\] as lifecycle truth for typed stable references; those records follow the same reference-bounded retention as retained observation data, and predecessor/successor links do not recursively pin old history. Every active-run payload, retained snapshot and cached DefinitionBundle must match both outputSchemaVersion and runIdentity; unsupported schemas fail before partial UI parsing, and a different run identity resets run-scoped history/selection/cache state before rendering. Share/deep-link URLs are navigation hints only: direct-open/refresh must remain GitHub-Pages-safe under the repository base path, and URL state may be restored only against retained data from a verified compatible run, never used to create, override or prove runIdentity.  
M12 Legacy removal/release candidate — one canonical simulation remains; clean-clone build/test/benchmark/Pages gates pass.

A milestone may be subdivided into small PRs in the order schemas/types \-\> pure algorithms \-\> settlement/mutations \-\> orchestration \-\> invariants/tests \-\> golden scenario \-\> milestone preview \-\> cleanup. The \>=5% visualization-share rule from REPOSITORY\_MIGRATION\_AND\_MILESTONE\_GATES is part of milestone completion, not optional polish. A failed milestone gate blocks later milestone promotion.

8\. Final consistency review result

Result: PASS WITH NORMALIZATIONS; no material economic architecture redesign required.

The implementation package now has one coherent model for all required product domains: autonomous markets, multiple States/currencies, fiscal and monetary policy, population/demography/migration, Clans, production chains/capital/resources, local/international trade, laws, expansion/settlement/state formation, bounded shocks and explainable GitHub Pages visualization.

Material contradictions found in this pass were contract-document drift, not model instability:

\- 16 phases numbered 0–15 versus an accidental “Phase 16” close label: resolved to 0–15, invariant close inside Phase 15\.  
\- early core PopulationCohort fields versus mature population contract: mature population contract wins.  
\- duplicate Region/Market lifecycle flags: LocalMarket.status wins.  
\- duplicate current/pending jurisdiction representation: Region.controllerStateId \+ PendingTransitions wins.  
\- serialized mutable ProductionUnit.capacity versus installedCapital-derived capacity: installedCapital wins.

No additional bank/credit, individual-person, property, warfare, securities, speculative FX or general-equilibrium systems are required to satisfy the product brief.

9\. Simplicity review — hard v1 guardrails

Do not add during implementation unless a later explicit design change is approved with benchmark evidence:

\- commercial banks/private credit or household/firm borrowing;  
\- individuals instead of cohorts;  
\- fractional firm equity/private securities markets;  
\- high-frequency FX/order books or speculative FX agents;  
\- dynamic currency creation/redenomination or endogenous monetary-union membership;  
\- multi-hop route optimization/all-pairs pathfinding;  
\- land parcels/property/housing markets;  
\- detailed military conquest/warfare;  
\- dozens of goods or recipe explosion;  
\- persistent employer/worker matching matrices;  
\- a second market-clearing or household replanning loop to “fix” timing;  
\- arbitrary law/event modifiers to macro statistics;  
\- unrestricted autonomous firm creation outside the bounded ProductionUnit lifecycle;  
\- unbounded per-transaction browser history.

The target is emergent behavior from a compact set of composable stock-flow rules, not simulated completeness.

10\. Acceptance authority

The final implementation must use ACCEPTANCE\_BENCHMARK\_PERFORMANCE\_SUITE without inventing macro outcome targets. Accounting, determinism and causality are release-blocking. Plausible charts do not excuse invariant failures.

Canonical profiles:  
\- P0 Smoke for fast PR/unit integration.  
\- P1 Mini-Integration for 240-tick cross-domain checks.  
\- P2 baseline-multistate-v1 as the canonical product benchmark, including seed 42 hash and five-seed diversity runs.  
\- P3 target-scale stress for performance/headroom.

Canonical M10/M11 engineering budgets include P2 Worker \<=8 ms/tick median and \<=16 ms p95, P3 \<=50/100 ms, bounded snapshot/history memory, main-thread interaction p95 \<50 ms, tick-to-visible p95 \<100 ms, cached scrub p95 \<150 ms and initial useful World view \<=2 s under the defined reference environment.

11\. Coding-agent decision boundary

Codex/Claude MAY choose normal engineering details that do not change observable contracts: file/class names inside the recommended repository shape, internal pure-function decomposition, data-structure implementation when semantics/order are preserved, test helper layout, cache strategy when caches are reconstructable/non-authoritative, and equivalent UI component composition.

Codex/Claude MUST NOT choose or change: economic formulas/parameters whose defaults are specified, stock ownership, tick causality, tax timing, FX settlement semantics, monetary creation/destruction rules, demographic accounting, state succession semantics, event write boundaries, milestone order, acceptance thresholds or v1 exclusions.

If a coding task reaches such a missing choice, classify it as a spec blocker rather than silently designing inside implementation.

12\. Final handoff readiness

The final HANDOFF\_AUDIT passed. The package was verified against the following conditions:

\- every required domain has an implementation-grade source and is reachable from this index;  
\- all four user drafts have a traceable KEEP/REWORK/DROP rationale in the source synthesis and their retained intent is represented in mature contracts;  
\- config/defaults/schema ownership is canonical and no stale duplicate field is presented as authoritative;  
\- the 0–15 tick order and every cross-domain phase boundary are unambiguous;  
\- all M0–M12 milestones map to named tests/goldens/acceptance gates;  
\- visualization/read-model/Worker/GitHub Pages requirements are sufficiently concrete for M11;  
\- no implementation document forces the coding agent to invent a material economic/product decision;  
\- 06 \- Handoff contains a self-contained entry point/master execution package rather than requiring agents to infer Drive history;  
\- final package clearly identifies superseded research/design wording and v1 exclusions.

The audit passed and PROJECT\_STATUS is COMPLETE. These conditions remain release-facing guardrails for implementation.

13\. Implementation start point

Begin implementation with M0, then proceed through M1–M12 in order. Use this index and START\_HERE as navigation; treat any unresolved material economic/product choice as a specification defect rather than inventing a new mechanic.

13\. Runtime-language resolution — implementation handshake 2026-09-03

This resolves earlier C\#-versus-browser wording and is authoritative over stale repository-shape recommendations.

\- M0 stays in the existing .NET 9 solution and freezes the legacy baseline/golden outputs.  
\- Starting with M1, the canonical simulation runtime is TypeScript, built as the browser-capable engine that will ultimately run behind the GitHub Pages Worker/UI boundary.  
\- Do not implement new canonical economics in C\# merely to port the same behavior to TypeScript later. The C\# runtime becomes a legacy/reference oracle and may retain parity/golden tests while responsibilities migrate.  
\- Strangler migration means responsibility moves incrementally from the legacy C\# model to the canonical TypeScript model while both remain testable; it does not mean bidirectional stock mirroring or duplicate canonical subsystem implementations.  
\- M11 adds the Worker host, SimulationOutput/read-model boundary and observatory around the same canonical TypeScript engine. M11 is not a second engine port.  
\- Ordinary TypeScript build tooling (Vite or equivalent static-host-compatible bundling), test runner and folder decomposition are engineering details as long as GitHub Pages/static-hosting and the acceptance budgets are met.

Any earlier text recommending new canonical Domain/Core/... namespaces inside TradeCraftSimulation should be read as a conceptual module layout, not as a requirement to implement the canonical engine in C\#.  
