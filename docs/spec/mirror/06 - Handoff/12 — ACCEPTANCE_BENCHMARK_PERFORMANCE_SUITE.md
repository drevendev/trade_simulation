Economic Simulation — Acceptance, Benchmark & Performance Suite

Status  
Implementation-planning contract. This document consolidates the subsystem invariants, golden scenarios, deterministic replay requirements and browser budgets into one executable acceptance surface for milestones M0–M12. It does not redefine economic mechanics.

1\. Acceptance philosophy

The project is accepted by behavior, accounting and determinism, not by matching one preferred macro history. Emergent outcomes may differ across seeds; impossible accounting, non-deterministic replay, hidden stock creation, phase leaks or UI stalls are failures.

Every benchmark run must produce machine-readable BenchmarkResult data containing: outputSchemaVersion, runIdentity, scenarioId, scenarioHash, definitionPackVersion, definitionPackHash, configHash, seed, engineBuildId, tickHorizon, normalizedStateHash, invariant failures, runtime totals/by phase, allocation/memory counters where available, snapshot bytes, headline economic metrics and named scenario assertions. Benchmark artifacts from different runIdentity values must never be merged or compared as if they were the same run.

A failed invariant is always more important than a plausible-looking chart.

2\. Test layers

Layer A — pure unit tests  
Deterministic formula and boundary tests for prices, allocation, recipes, labor, taxes, demography, policy, FX, events, transitions and serialization. No random integration fixtures when a closed-form assertion is possible.

Layer B — subsystem golden scenarios  
Use the golden scenarios already specified by each implementation contract. Preserve their economic intent; consolidate common helpers and avoid duplicated fixtures.

Layer C — cross-subsystem acceptance scenarios  
Small worlds intentionally activate two to five subsystems together and assert conservation, causality and direction rather than fragile exact macro values.

Layer D — deterministic benchmark worlds  
Long-running fixed scenarios with stable seeds and normalized state hashes. These detect accidental order-dependence, serialization drift and cross-phase regressions.

Layer E — browser/performance acceptance  
Runs the canonical baseline and stress profiles in the browser-equivalent runtime plus UI read-model/render tests. Performance is measured separately from economic correctness and never disables correctness checks.

3\. Canonical benchmark profiles

P0 SMOKE  
Purpose: PR/CI fast path.  
Scale: 1 Region, 1 State, 1 Currency, 1 Clan, 2–3 Goods, \<=4 PopulationCohorts, \<=4 ProductionUnits, \<=1 TransportLink, no stochastic events unless scenario-specific.  
Horizon: 24 ticks normally; 120 for lifecycle tests.  
Budget: complete economic run should be effectively instantaneous on developer hardware; no numeric wall-clock gate beyond a 2 s CI safety ceiling because CI hardware varies.

P1 MINI-INTEGRATION  
Purpose: exercise real markets, production, wages and one institutional boundary.  
Scale: 4 Regions, 2 States, 2 Currencies, 3 Clans, 6 Goods, \<=40 cohorts, \<=30 ProductionUnits, \<=8 links.  
Horizon: 240 ticks.  
Required: all tracked stocks reconcile each tick and repeated runs have identical normalized hashes.

P2 BASELINE-MULTISTATE-V1  
Purpose: canonical product benchmark.  
Scale comes from CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION: 24 Regions, 4 States, 4 Currencies, 8 Clans, about 500 PopulationCohorts, about 250 ProductionUnits and the authored sparse link graph, using the 6–8-good baseline definition pack.  
Horizon: 1,200 ticks for CI/nightly correctness; 10,000 ticks for release soak when retained-history density is configured for long runs.  
Seeds: fixed suite {1, 7, 42, 410000, 8675309}; seed 42 is the canonical snapshot/hash seed. Other seeds are behavioral diversity checks, not exact-value snapshots unless deliberately frozen.

P3 TARGET-SCALE STRESS  
Purpose: prove headroom inside the v1 visualization design envelope, not define ordinary gameplay.  
Scale: up to 100 Regions, 12 States, 16 Goods, 40 Clans, 2,000 ProductionUnits, 300 TransportLinks and proportionally bounded cohorts. Use deterministic synthetic authored topology; do not add multi-hop pathfinding.  
Horizon: 1,000 ticks for engine/runtime benchmark; 10,000 retained tick-equivalents for history/render memory tests.  
Acceptance: correctness invariants still hold. Performance may use the relaxed stress budgets below.

4\. Global accounting acceptance

The following are release-blocking for every applicable benchmark tick:  
\- Goods: ending owned inventory \+ goods physically destroyed/consumed/converted must equal opening inventory \+ production/imported genesis additions, with every change represented by a typed flow. Shipment ownership prevents in-transit double counting.  
\- Transaction money: for each Currency, ending actor/treasury/authority/pool cash equals opening money plus explicit monetary issuance minus explicit destruction. Ordinary transfers, taxes, trade, clan flows, debt service and FX never create net money.  
\- Population: ending persons \= opening persons \+ births \- deaths \+ permitted genesis changes; migration, aging, social mobility, split/merge and clan/state reassignment are reclassification/transfer, never creation.  
\- Capital: installed capital changes only through real-goods installation, depreciation, permitted physical loss and explicit genesis.  
\- Physical resources/deposits: stock changes only through extraction, permitted physical loss and genesis. Discovery changes knowledge only.  
\- Sovereign debt: instrument face value and BondHolding totals reconcile; issuance/redemption/default/authority holdings cannot produce unmatched assets or liabilities.  
\- FX: every successful cross-currency settlement has matched payer debit, finite pool reserve movement and receiver credit; failed/partial settlement moves only the accepted amount.

Tolerance: use exact integer/fixed-point equality for canonical quantities wherever schemas specify integer/fixed-point storage. For derived floating diagnostics only, default absolute tolerance 1e-9 and relative tolerance 1e-9 unless a contract defines another bound. Never hide stock drift behind a broad epsilon.

5\. Determinism contract

For identical ScenarioDefinition, DefinitionPack, SimulationConfig, seed and engine version:  
\- Genesis field values and normalized registry ordering are identical.  
\- 1, 24, 240 and 1,200 tick normalized hashes are identical across repeated runs.  
\- Shuffling dictionary/list enumeration at defined test seams cannot change market allocation, trade, labor, events, demography, policy or transition results.  
\- UI snapshot requests, diagnostics sampling and rendering must not consume simulation RNG or alter WorldState.  
\- Keyed RNG tests prove unrelated entity/event insertion does not perturb existing entities except where the new entity economically interacts through normal model flows.

Normalized hash excludes wall-clock timestamps, collection iteration order, logging text, transient caches and reconstructed indexes. It includes every authoritative stock, active policy/state variable, pending transition and economically material lifecycle field.

6\. Cross-subsystem acceptance scenarios

A01 Closed local economy  
One Region with households, firms and one State. Run 240 ticks. Assert production→wages→household demand→settlement→consumption loop, tax receipt, no negative stocks, no money drift and bounded price movement.

A02 Shortage and recovery  
Remove one essential input for a bounded interval, then restore supply. Assert constrained output, rising shortage pressure/bounded repricing, lower need satisfaction and endogenous recovery without any direct scripted price reset.

A03 Wage timing / affordability  
Configure wages as the principal household income source. Assert Phase-2 spending envelopes may forecast same-tick wages but Phase-8 settlement never spends more than actual post-Phase-5 cash; withholding reaches treasury exactly once.

A04 International trade with finite FX  
Two States/currencies with comparative local shortage and one capacity-limited route. Assert profitable trade appears, FX limits shrink settlement before goods depart, tariffs/fees have recipients, and zero FX liquidity halts only cross-currency flow.

A05 Fiscal stabilizer under recession  
Negative real shock reduces employment/income. Assert transfer/tax rules react only through defined fiscal mechanisms, treasury/debt reflect the financing consequence, and no transfer creates money outside the monetary/debt contracts.

A06 Inflation / monetary response  
Persistent broad transaction-price inflation in an independent currency. Assert chained CPI reacts to actually transacted tax-inclusive household prices, policy rate uses lagged available information, and monetary operations occur only through planned Phase-1 OMO.

A07 Monetary union asymmetric shock  
Two member States share one authority; shock only one State. Assert one shared currency/authority/policy rate, divergent local real/fiscal outcomes remain visible, and no State silently gains an independent authority.

A08 Migration and clan network  
Create a persistent opportunity differential across an available route. Assert bounded migration, wallets/inventories transfer without duplication, clan network effect changes destination propensity only through the documented coefficient, and population accounting closes.

A09 Settlement and incorporation  
Unclaimed Region becomes attractive and reachable. Assert real-goods SettlementProject, migration-led population arrival, market activation threshold, next-tick incorporation via PendingTransitions and no spawning of money/goods/population/resources/currency.

A10 Successor State  
Trigger configured successor-State conditions. Assert deterministic new State identity, fiscal/currency succession rules, no automatic monetary-union accession and no stock duplication during jurisdiction change.

A11 Event propagation  
Apply deterministic harvest failure/route disruption. Assert only permitted direct physical/capacity effects are written by Events; subsequent prices, migration, fiscal stress and inflation arise endogenously.

A12 Fiscal/FX stress interaction  
State must procure/import in foreign currency during weak FX liquidity. Assert procurement competes through ordinary markets, finite FX binds, treasury cannot spend unavailable settlement cash and failures remain explicit rather than backfilled by magic liquidity.

A13 Long-run closed accounting  
P2 seed 42 for 1,200 ticks with ordinary bounded events. Zero invariant failures, no NaN/Infinity, no illegal negative stocks, no lifecycle deadlock and stable normalized final hash.

A14 Seed diversity sanity  
Run P2 seeds 1/7/42/410000/8675309 for 1,200 ticks. Required qualitative sanity only: simulation remains economically active, at least one market clears positive quantity, population and production do not become NaN/negative, and no invariant fails. Do not require all seeds to converge to similar GDP/inflation/population.

7\. Directional sanity bounds

These are bug detectors, not economic targets.  
\- Price, wage, FX and policy-rate per-update changes must respect their configured hard bounds.  
\- Birth/death/migration/aging flows may never exceed eligible source population in the tick.  
\- Cleared quantity may never exceed affordable demand or available supply after reservation rules.  
\- Production may never exceed every binding recipe/labor/capital/resource constraint.  
\- Transport shipped quantity may never exceed reserved goods or link capacity.  
\- Tax rate/policy values must remain inside validated configuration ranges.  
\- Event severity/duration and every ShockOperation must remain inside definition/config bounds.  
\- Any ratio with zero denominator uses the contract-defined neutral/null behavior; never NaN/Infinity.

Do not add arbitrary assertions such as “inflation must be 2%” or “GDP must grow” to make tests look realistic. Macro targets belong only to scenarios whose policy rule explicitly targets them.

8\. Performance measurement protocol

Correctness run and performance run are separate invocations using Release/optimized builds. Warm up once before timed samples. Record at least 5 samples and report median plus p95 where the harness supports it. Performance gates use median for deterministic engine throughput and p95 for interactive main-thread latency. CI should store raw metrics so regressions are visible before a hard gate fails.

Reference browser class: mainstream desktop/laptop from roughly the last five years, matching VISUALIZATION\_AND\_EXPLAINABILITY. Browser measurements must use a production GitHub-Pages-equivalent build, simulation in a Dedicated Worker, main-thread rendering enabled and developer tools closed.

9\. Engine/runtime budgets

P2 BASELINE:  
\- Median Worker simulation time: \<=8 ms/tick over a 1,000-tick warmed run; p95 \<=16 ms/tick.  
\- A batch of 100 ticks at max-safe speed: \<=1.0 s Worker CPU median.  
\- Serialized compact tick summary sent to main thread: target \<=200 KB/tick; hard ceiling \<=500 KB/tick. Detailed immutable definitions are not resent each tick.  
\- No unbounded per-tick retained transaction/order objects. After a 10,000-tick history stress run, memory attributable to retained simulation/output history must remain \<=256 MB in the browser profile.

P3 TARGET-SCALE STRESS:  
\- Median Worker simulation time \<=50 ms/tick; p95 \<=100 ms/tick over 1,000 ticks.  
\- Main thread must remain independently responsive because compute stays in Worker.  
\- Snapshot/history memory \<=512 MB for the stress harness. Crossing this is a design failure requiring lower snapshot density/downsampling, not permission to retain everything.

These are v1 engineering budgets. A slower implementation may not weaken them silently; profile first, simplify read models/data structures, and only revise thresholds through an explicit spec decision with measured evidence.

10\. UI/browser budgets

Preserve the mature visualization budgets:  
\- ordinary hover/select: p95 main-thread task attributable to the interaction \<50 ms;  
\- tick-to-visible update during normal playback: p95 \<100 ms;  
\- scrub to a cached retained tick: p95 \<150 ms;  
\- initial useful World view: \<=2.0 s on the reference browser/network profile, with app shell/metadata allowed to render before all deep history blocks;  
\- no simulation step runs synchronously on the main thread in production browser mode;  
\- no overview renders one DOM node per historical transaction or per ProductionUnit when an aggregate suffices;  
\- timeline/read-model retention uses bounded retention/downsampling.

For P2, a 60-second continuous playback test at 1x must have no main-thread long-task regression attributable to simulation compute and no sustained input starvation. For P3, rendering may reduce visual update frequency but must keep user input/pause control responsive.

11\. History and payload acceptance

Store immutable definitions once as one run-scoped DefinitionBundle. Per-tick Worker/history payloads reference definitions by stable IDs and must not embed or repeat the DefinitionBundle. Entity references in retained snapshots, ExplanationFacts, deep links and caches use typed persistent { entityType, entityId } semantics (or an equivalent typed representation), never array positions or current-registry slots. Persistent entity IDs are allocated once per run and never reused after retirement/removal, so one typed ID denotes one lifecycle instance for the entire run. Per-tick history stores aggregates and ExplanationFacts needed for the observatory, not transient orders.

Required tests:  
\- history byte growth is approximately linear in retained ticks/entities, not quadratic; DefinitionBundle bytes are counted once per active run rather than once per retained tick;  
\- configured downsampling/retention actually bounds memory;  
\- scrubbing to a retained tick never mutates WorldState;  
\- HistoryRetentionMetadata must exactly report retained availability after retention/downsampling/export. Each inclusive TickRange uses non-negative integer ticks with startTick \<= endTick. aggregateTickRanges and detailedTickRanges are ascending, strictly disjoint and canonically coalesced; overlapping or directly adjacent serialized ranges are invalid rather than silently normalized. detailedTickRanges must be a subset of aggregateTickRanges. When aggregate coverage exists, earliestAggregateTick/latestAggregateTick equal its first start/last end; when aggregateTickRanges is empty, both aggregate bounds, earliestDetailedTick and detailedTickRanges are null/absent or empty as applicable. When detail exists, earliestDetailedTick equals its first range start. Consumers must never assume every tick between min/max is retained;  
\- scrub and compare selectors accept only retained aggregate snapshots; if an aggregate snapshot remains but fine-grained ExplanationFacts/transactions were evicted, the aggregate stays usable while detailed causes are explicitly unavailable;  
\- compare mode never substitutes a nearby tick: if baseline B is unavailable or the selected entity/metric does not exist at B, the affected delta is disabled with a clear reason;  
\- active selection invalidation under retention is explicit: detail-only eviction keeps selected tick T usable at aggregate level; loss of aggregate coverage for B preserves an unavailable baseline label but disables compare deltas/overlays; loss of aggregate coverage for selected T shows an unavailable selected-tick state and never auto-jumps to a neighboring/latest tick. Returning to retained history requires explicit user action while live-head progress may continue independently;  
\- lifecycle/read-model integrity: close/remove a ProductionUnit, retire cohorts through split/merge, and exercise State succession, then create later entities of the same types. New entities receive different IDs; retained snapshots and ExplanationFacts for retired IDs still refer only to their original lifecycle instances. SimulationOutput must include explicit EntityLifecycleRecord\[\] entries carrying typed entityRef, status, lifecycle timing, optional recorded reason, and explicit predecessor/successor refs when the domain recorded lineage/succession. Consumers resolve references against the selected retained tick plus this lifecycle metadata and return an explicit not-yet-created, closed/retired/succeeded/dormant or unavailable state when appropriate; they may never infer lifecycle from a missing snapshot, fall back to array position/current-registry occupant/nearest entity, or invent reason/lineage data;  
\- lifecycle retention/export boundary: EntityLifecycleRecord storage is reference-bounded. Every typed entity referenced by a retained snapshot, ExplanationFact, EventRecord or other retained observation block has a matching lifecycle record. Once the last retained observation referring to an entity is evicted, its lifecycle record may be evicted unless another retained observation still requires it; predecessorRefs/successorRefs alone must not pin an unlimited lineage chain. Portable exports include lifecycle records for typed entities actually referenced by exported observation blocks. A lineage ref outside the exported retained range may remain an opaque typed ref and must resolve to an explicit not-included/unavailable state; export must not recursively include unbounded lineage history;  
\- nominal values keep their currency labels at both ticks; if a State changes currency regime between B and T, no nominal percentage delta is computed across currencies without an explicit canonical reporting-currency conversion;  
\- every serialized SimulationOutput payload carries top-level outputSchemaVersion; v1 starts at 1, and a consumer must reject an unsupported version before reading any snapshots, retention metadata or immutable definitions. Rejection must preserve the last verified UI snapshot and surface the recoverable runtime-error state; tests must prove no partial parse, silent downgrade, nearest-version fallback or schema guessing occurs.  
\- RunMetadata exposes scenarioId, scenarioHash, seed, configHash, definitionPackHash and engineBuildId plus a stable runIdentity computed from the canonical content digests defined by CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION. runIdentity is SHA-256 over a canonical named identity object containing those fields. Every snapshot, HistoryRetentionMetadata block and cached DefinitionBundle admitted into one active UI run must match both outputSchemaVersion and runIdentity; DefinitionBundle must additionally match definitionPackHash. Same-schema/different-run payloads are rejected rather than merged, and definition content is transferred/cached once per active run or explicit compatible cache miss rather than copied into per-tick payloads.  
\- identity hashing tests must prove that declaration-order-only permutations of schema-defined unordered keyed collections preserve scenarioHash/runIdentity, while any material ScenarioDefinition change changes scenarioHash even if id/version was not bumped; resolved-config, DefinitionPack or engine-build changes must likewise change runIdentity. Process-local/object-order-dependent hashes are forbidden as recovery evidence.  
\- HistoryRetentionMetadata is owned by the same SimulationOutput contract as the retained snapshots it describes. Validation must fail on negative/reversed ranges, unsorted/overlapping/adjacent uncoalesced ranges, detail outside aggregate coverage, bounds/range disagreement, detailed-only history, or metadata that disagrees with actual retained observation availability. A valid empty-history payload has both range lists empty, all earliest/latest bounds null/absent, and no retained tick-indexed observation blocks or lifecycle records. After outputSchemaVersion/runIdentity compatibility is established, malformed retention metadata is still rejected atomically before any history is appended or rendered; consumers must not sort, merge, clamp, fill or otherwise repair it silently. Live Worker rejection preserves the previous verified snapshot under the existing stale/read-only runtime-error behavior; portable import rejects the package before partial display.  
\- retention coverage is a machine-verifiable completeness claim. A tick in aggregateTickRanges must have the complete aggregate observation tier required to render the v1 aggregate observatory for that tick. A tick in detailedTickRanges must also have the complete retained detail/explanation families promised for that tick. Applicable empty collections count as complete only when explicitly represented as empty (or by an equivalent complete-block marker); omission means unavailable/incomplete. Partial Worker chunks may stage records but may not advertise aggregate/detail coverage until the corresponding tier is complete. Portable packages must reject declared coverage that lacks required blocks, and tick-indexed blocks included in a package may not sit outside the coverage tier that owns them. No partial tick is appended or rendered.  
\- Worker delivery/retry is idempotent at the logical observation-commit boundary. For each runIdentity \+ tick \+ tier/block family, an identical re-delivery of already committed content is a no-op; conflicting content for that committed logical block is rejected rather than last-write-wins. Delayed/reordered chunks from an older attempt may affect only uncommitted staging and may not overwrite a committed block, regress retention coverage, duplicate records/ExplanationFacts, or resurrect detail already evicted/downsampled. Retention ranges change only with the verified observation commit or explicit retention/eviction/downsampling commit that owns the data state. A retention transition reads only already committed compatible observations for the same run. If downsampling produces a durable aggregate from finer detail, that aggregate is materialized and verified before source detail is deleted. Removing aggregate coverage for a tick removes detailed coverage for that tick in the same atomic transition. A retention transition exposes observation-block removals/replacements, aggregateTickRanges/detailedTickRanges and affected reference-bounded EntityLifecycleRecord coverage as one consistent state; it may preserve or remove availability but may not resurrect a tier. Delivery/retention ordering must make delayed pre-eviction data unable to undo a later retention transition. The transport may choose sequence/revision/digest/envelope/epoch fields, but it must provide enough machine-verifiable identity/freshness to enforce these rules, including after same-run Worker recovery.  
\- Worker failure/restart acceptance: the last verified snapshot is visibly stale and read-only while playback is stopped; recovery may append only after a compatible same-run payload is verified. A different runIdentity atomically resets timeline history, compare baseline, selected-entity state and run-scoped definition caches before rendering the new run.  
\- Any persisted replay manifest, exported observation package, benchmark artifact index or run-scoped cache key that can outlive the current process must carry runIdentity and the relevant schema/version discriminator. scenarioId, seed, engineBuildId, filenames, timestamps, object identity or process-local hashes are not sufficient identity keys by themselves. Consumers must reject or isolate mismatched artifacts rather than silently combining them.

\- deep-link/share acceptance: query/hash/base-path navigation must survive direct-open and refresh on the repository GitHub Pages URL without server rewrites. URL state is only a navigation hint; loaded SimulationOutput remains authoritative. runIdentity in a URL is only a compatibility guard.  
\- unavailable-link acceptance: an evicted tick, missing compare baseline/entity or mismatched runIdentity must produce an explicit unavailable/incompatible UI state. Tests must prove there is no silent substitution of another tick, entity, baseline or run.  
\- portable export/import acceptance: exported observatory packages must carry outputSchemaVersion and runIdentity; incompatible imports are rejected before any partial display. A self-contained export may contain at most one compatible DefinitionBundle and only observation blocks actually retained for its declared tick/detail range. It must not reconstruct evicted history, include transient orders or mutable WorldState, or repeat immutable definitions per tick/block. Requests for unavailable range/detail fail explicitly or require a narrower retained range. Export growth must be approximately linear in one DefinitionBundle plus the exported retained blocks, never DefinitionBundle-size multiplied by tick count.  
12\. Milestone gate mapping

M0: legacy build/tests \+ legacy seeded snapshot.  
M1: genesis determinism, validation and WorldGenesisLedger.  
M2: no-op tick causality, phase trace and zero-flow reconciliation.  
M3: canonical local-market golden suite \+ A01 subset.  
M4: P1 240-tick local economy \+ A01/A02/A03.  
M5: A04 and closed-border/zero-FX route tests.  
M6: A05/A12 plus clan/debt/fiscal subsystem goldens.  
M7: A06/A07 plus monetary/FX goldens.  
M8: A08/A09/A10 plus demographic/expansion goldens.  
M9: A11 plus deterministic event goldens.  
M10: A13/A14, all global accounting/determinism tests and P2/P3 engine/history performance gates.  
M11: browser/UI budgets, replay/scrub/read-model/explanation acceptance, deep-link/export compatibility tests and static GitHub Pages deployment smoke/direct-open test.  
M12: remove legacy path only after all canonical gates remain green without legacy classes/tests providing hidden behavior.

13\. CI tiers

PR tier: all unit tests, P0, selected P1 scenarios, normalized replay check at 24/240 ticks. Target practical CI duration \<=5 minutes but correctness tests are not removed merely to hit this target.

Main/nightly tier: all subsystem goldens, A01–A12, P2 seed 42 for 1,200 ticks, seed-diversity shortened run, serialization/history checks.

Release tier: full A01–A14, P2 five-seed 1,200-tick suite, 10,000-tick seed-42 soak, P3 stress, browser performance/UI acceptance and deployment smoke test.

Performance regression warning: warn at \>15% degradation against the stored median baseline for a comparable runner even if absolute gate still passes. Hard fail when an absolute budget is breached in a controlled benchmark environment. Do not hard-fail ordinary heterogeneous PR CI on noisy wall-clock numbers.

14\. Acceptance output schema

BenchmarkResult should be serializable and diffable:  
\- identity: scenarioId, scenarioHash, profileId, seed, configHash, definitionPackHash, engineBuildId, runIdentity;  
\- horizon/result: ticksCompleted, finalStateHash, invariantFailureCount, assertionResults;  
\- accounting maxima: maxMoneyResidualByCurrency, maxGoodsResidualByGood, maxPopulationResidual, maxCapitalResidual, maxResourceResidual, maxDebtResidual;  
\- economics: population, employment, shortage counts, real final consumption/output proxy, CPI/inflation, trade value, treasury/debt summaries, currency/FX summaries;  
\- runtime: totalMs, msPerTick median/p95, phaseMs, allocations where measurable, peak/retained-history bytes, snapshotBytes;  
\- UI when applicable: interaction p95, tickVisible p95, scrub p95, initialUsefulViewMs, longTaskCount/maxDuration;  
\- notes: explicit skipped metrics with reason; never fabricate unavailable measurements.

15\. Failure triage

Classify any failed run before changing economics:  
ACCOUNTING — unexplained stock/flow residual.  
DETERMINISM — hash/order/RNG divergence.  
CAUSALITY — phase leak, future information or duplicated settlement.  
DOMAIN — contract formula/lifecycle violation.  
SCENARIO — invalid fixture/config expectation.  
PERFORMANCE — correct result exceeds budget.  
PRESENTATION — read-model/UI correctness or responsiveness failure.

Accounting, determinism and causality failures block further milestone promotion. Performance failures require profiling/simplification; they must not be “fixed” by disabling invariants or reducing economic fidelity without an explicit design decision.

16\. Completion criterion for this suite

The consolidated suite is implementation-ready when the coding agent can map every migration milestone to named tests/benchmarks, generate deterministic machine-readable results, and know the exact correctness/performance threshold for M10/M11 without inventing new economic acceptance targets.  
