VISUALIZATION AND EXPLAINABILITY — Economic Simulation

Status  
Mature subsystem design. This document specifies the GitHub Pages experience and the browser-facing observation layer for the autonomous simulation. It does not redefine economics; it exposes the existing model faithfully, compactly, and causally.

1\. Design goal

The visualization must answer three questions at every tick:  
1\) What is happening?  
2\) Where is it happening?  
3\) Why did it happen?

The page is not a generic analytics dashboard and not a player-control surface. It is an explorable observatory for a deterministic world simulation. The existing repository already has the right seed of this idea: a static GitHub Pages page reads simulator-generated time-series data, shows prices through time, provides a turn scrubber, reconstructs trade flows, and keeps the deployment dependency-light. Preserve that directness, but replace the one-page toy presentation with a structured observation model that can explain regions, states, clans, markets, demography, fiscal/monetary policy, trade, expansion and shocks.

2\. Product principles

A. Observation, not control  
The default UI must not expose economic policy knobs as ordinary user controls. Simulation configuration may exist behind an explicit Scenario/Debug surface, visually separated from the observational experience.

B. One canonical selected tick  
All views bind to one selected tick T. Scrubbing the timeline changes map, dashboards, flows, event context and explanations atomically. No panel may silently show a different time window without labeling it.

C. Progressive disclosure  
The user should be able to move from world → state → region → clan/market/production detail without opening dozens of permanent panels. Global overview surfaces only decision-relevant aggregates; details appear via selection and drilldown.

D. Explain first-order causes, not invented stories  
Explanations must be derived from recorded deltas and model transactions. Never generate narrative claims from correlation alone. If the model cannot attribute a change, say that the cause is diffuse/multi-factor and show the strongest measurable contributors.

E. Preserve accounting identities in the UI  
Money, goods, population, debt and physical losses should reconcile between charts and drilldowns. A metric must have one canonical definition and unit across the application.

F. Static-host compatible  
GitHub Pages remains the deployment target. No server dependency is required for the core experience.

3\. Information architecture

The application uses a persistent shell with four areas:

Top bar  
\- simulation title/scenario  
\- seed  
\- current tick/date  
\- play/pause  
\- speed: 1x / 4x / 16x / max-safe  
\- step backward / forward  
\- timeline scrubber  
\- optional compare-to tick selector  
\- diagnostics indicator

Left navigation  
\- World  
\- States  
\- Regions  
\- Markets & Trade  
\- Population & Clans  
\- Production  
\- Fiscal & Monetary  
\- Events  
\- Diagnostics

Main canvas  
The active overview or entity page.

Context inspector  
A collapsible right-side panel showing the currently selected state/region/clan/good/route/event and causal explanation for the selected tick.

Mobile/narrow layouts collapse the left navigation and inspector into drawers. The main visualization remains usable at 1280×720 and scales cleanly downward; desktop is the primary analysis target. On narrow screens, stack charts and metric cards instead of shrinking labels below readability; keep units, selected tick, warning state and primary drill-down actions visible. Wide tables may scroll horizontally inside their own container rather than forcing the whole page wider.

4\. World view

The World view is the default landing page.

World header metrics at tick T:  
\- total population and annualized growth  
\- real final consumption per capita index (quantity-based; never sum nominal values across currencies)  
\- population-weighted inflation rate across states; do not display a synthetic world CPI level across different currencies  
\- unemployment rate  
\- trade activity: cross-region shipment count/volume by selected good or category; never sum nominal trade values across currencies without an explicit reporting-currency conversion  
\- active states / settled regions  
\- count of severe shortages  
\- fiscal stress count

Keep the World header to at most six primary cards at once. Each headline metric shows current value, delta vs T-1, compact sparkline, unit and a one-click explanation. Secondary alerts such as severe-shortage and fiscal-stress counts belong in the imbalance strip rather than competing with the primary macro cards.

The main world layout contains the map first, then the imbalance/timeline context, then compact state comparison. Clicking any state card or state-colored map region selects that State and exposes an explicit “Open state” action; clicking a Region exposes “Open region”. Breadcrumbs must preserve World → State → Region context, while direct navigation to a Region remains allowed.

The main world layout contains:  
\- spatial region map  
\- world timeline strip with important events and institutional changes  
\- compact state comparison cards  
\- top current imbalances: shortages, inflation spikes, unemployment, fiscal stress, route disruption

The page must favor abnormal change over sheer size. The largest economy should not permanently dominate attention if a smaller state is undergoing famine, monetary instability or rapid migration.

5\. Spatial map

Use the project’s coarse Region graph directly; do not invent geographic precision that the simulation does not model.

Render:  
\- Region nodes/polygons using the chosen authored world layout  
\- TransportLinks as edges  
\- state borders/jurisdiction by fill or outline  
\- settlement intensity  
\- optional resource/deposit layer  
\- optional population density layer  
\- optional prosperity layer  
\- optional price/shortage layer for selected good  
\- trade-flow overlay  
\- migration-flow overlay  
\- event/shock overlay

Only one quantitative thematic fill is active at a time. Flow overlays may coexist with it.

Map interactions:  
\- hover: concise tooltip  
\- click: select Region  
\- double click or explicit Open: Region detail  
\- clicking an edge selects TransportLink  
\- layer selector changes the metric without changing the selected tick

The map should use SVG for labels, hit targets and modest graph sizes. If route/flow counts exceed the tested SVG budget, draw high-volume animated/static flow geometry on Canvas while retaining HTML/SVG interaction overlays. Do not begin with WebGL.

6\. State dashboard

State detail must make fiscal, monetary, demographic and real-economy state legible together.

Header:  
\- population  
\- real income/consumption per capita  
\- employment/unemployment  
\- CPI/inflation  
\- treasury cash  
\- debt and debt-service burden  
\- effective policy rate when State.effectiveCurrencyRegime.policyAuthorityId is non-null; label the controlling authority explicitly. For FOREIGN\_LEGAL\_TENDER show “No domestic monetary policy” instead of a zero or fake rate  
\- currency regime summary: currency used, regime type, currency issuer, policy authority (if any), monetary-union membership and relevant FX summary. Keep “currency issuer” and “policy authority” as separate labels; they are not interchangeable  
\- controlled regions

Core charts:  
\- population, births, deaths, net migration  
\- employment and real wage  
\- CPI/inflation and selected price contributors  
\- tax revenue vs spending vs balance  
\- treasury and debt  
\- imports/exports and trade balance by goods category  
\- clan influence/loyalty composition  
\- policy timeline: tax rates, transfers, tariffs, spending stance, monetary settings, legal/institutional changes

Each policy line is stepwise and visually distinct from endogenous economic series.

7\. Region dashboard

Region detail centers on local living conditions and productive structure.

Show:  
\- population by age/stratum  
\- employed/unemployed/out-of-labor-force  
\- clan composition  
\- prosperity/health  
\- local wage  
\- local market prices and shortage ratios  
\- inventory coverage by key good  
\- active ProductionUnits by sector  
\- output, capacity utilization and binding bottlenecks  
\- imports/exports by good  
\- TransportLink capacity utilization  
\- settlement level / carrying capacity  
\- discovered resources  
\- active/recent events

The most important derived panel is “Why is this region changing?” listing top positive and negative contributors to population, prosperity, employment and output changes.

8\. Markets and trade

The Market view has three modes.

A. Good explorer  
Select a good and show:  
\- local prices across regions  
\- effective household price including relevant taxes  
\- supply, affordable demand, cleared quantity  
\- shortage ratio / unmet demand  
\- inventories and inventory coverage  
\- imported/exported quantity  
\- price history and dispersion

B. Trade network  
For selected good or all goods:  
\- route volume  
\- origin/destination  
\- transport cost/loss/fee  
\- capacity utilization  
\- shipments currently in transit  
\- blocked or unprofitable links

C. Flow accounting  
A Sankey-style view is allowed only for aggregate, low-cardinality flows: production → intermediate use → household consumption → investment → public procurement → losses/exports. Never render hundreds of agents as Sankey nodes.

Trade arrows should encode quantity by width. Color encodes good/category; direction is indicated with arrowheads or animation only when animation remains readable. Zero/near-zero flows are suppressed by thresholding.

9\. Production view

Production is presented at sector level first, ProductionUnit second.

Sector overview:  
\- output  
\- capacity  
\- utilization  
\- employment  
\- wage bill  
\- revenue/cost/profit  
\- inventory  
\- investment  
\- depreciation

ProductionUnit inspector:  
\- owner (Clan/State)  
\- region  
\- recipe  
\- installed capital  
\- labor assigned  
\- input inventories  
\- planned vs realized output  
\- binding production constraint for the selected tick: labor, input X, capital/capacity, infrastructure or resource extraction  
\- realized sales  
\- investment pipeline  
\- cash wallet(s)

The UI should expose the Leontief bottleneck directly: “Planned 120; realized 72 because Tools input supported 72.” This is more valuable than decorative factory animation.

10\. Population and clans

Population page:  
\- pyramid or three-band age composition  
\- strata shares  
\- labor-force status  
\- real disposable income  
\- need satisfaction by category  
\- health and prosperity  
\- births/deaths  
\- migration origins/destinations  
\- social mobility transitions

Clan page:  
\- member population by state/region  
\- treasury/wealth  
\- owned ProductionUnits  
\- dividend income and member distributions  
\- preference axes  
\- state-specific loyalty and influence  
\- migration network strength  
\- political preference vs enacted policy distance

Do not imply that a clan is a homogeneous individual. All labels should call it a meso-level social/economic bloc.

11\. Fiscal and monetary view

Fiscal section:  
\- tax revenue by base  
\- transfers  
\- wages/procurement/infrastructure expenditure  
\- primary balance and overall balance  
\- treasury cash  
\- debt issuance/redemption  
\- debt service  
\- debt holders by broad holder type  
\- fiscal stress/default flags

Monetary section:  
\- currency money supply reconciliation  
\- CPI and inflation  
\- currency-regime identity: currency used, Currency.issuerAuthorityId, State.effectiveCurrencyRegime.policyAuthorityId and regime type, shown with human-readable labels  
\- policy rate and rule components at MonetaryAuthority level; State pages display the inherited effective rate only when policyAuthorityId is non-null  
\- MonetaryAuthority bond holdings  
\- money creation/destruction operations  
\- FX rates  
\- FX pool liquidity/reserves  
\- cross-currency settlement pressure

For monetary unions, the authority page must show all member states side by side so asymmetric shocks are visible. The same page must name the currency it issues and clearly distinguish authority membership from mere use of that currency by FOREIGN\_LEGAL\_TENDER states.

12\. Events and shocks

The event log is a first-class timeline, not pop-up flavor text.

Each event entry contains:  
\- tick/date  
\- event family  
\- severity  
\- affected regions  
\- direct ShockOperations actually applied  
\- direct physical losses  
\- temporary capacity/yield/carrying-capacity effects  
\- recovery status

The inspector then separates:  
Direct effects: changes explicitly applied by the event layer.  
Endogenous consequences: shortages, price changes, migration, fiscal stress, inflation, etc. observed afterward.

This distinction is mandatory because events must not be credited with macro effects they do not directly set.

13\. Timeline, replay and comparison

The simulation is deterministic, so replay is central.

Required controls:  
\- play/pause  
\- ±1 tick  
\- scrub to arbitrary retained tick  
\- jump to next/previous event  
\- speed controls  
\- compare current T against baseline tick B

Comparison mode shows deltas for selected metrics and may overlay two series. It must not run a second simulation implicitly; it compares two retained snapshots from the same run unless a later Scenario Compare feature explicitly loads multiple runs. Both T and baseline B must be named visibly. Compare is available only when both snapshots are retained and the selected entity/metric exists at both ticks; if not, disable the delta and explain why rather than silently substituting a nearby tick. For nominal monetary values, show the currency at both ticks. If the entity changes currency regime between B and T, do not compute a nominal percentage delta across currencies unless a canonical reporting-currency conversion is explicitly available.

Timeline storage strategy:  
\- keep compact per-tick aggregate snapshots for all major entities/metrics  
\- keep event and transaction summaries needed for explanation  
\- do not retain every temporary order object forever  
\- allow rolling fine-grained detail plus durable aggregates if long-run memory requires it  
\- expose retention metadata to the UI as explicit retained tick coverage, not only min/max bounds. HistoryRetentionMetadata carries compact inclusive aggregateTickRanges and detailedTickRanges; earliestAggregateTick/latestAggregateTick remain convenience bounds, and earliestDetailedTick is nullable when no detailed blocks are retained  
\- bound the scrubber and compare selector to actually retained snapshots; never imply that evicted history can still be reconstructed exactly  
\- retention invalidation is explicit, not auto-correcting: if selected tick T loses detailed coverage but keeps aggregate coverage, keep T selected and degrade only detail/explanations; if T loses aggregate coverage, keep the requested tick label visible in an unavailable state and do not silently jump to a nearby/latest tick. Offer an explicit “Open latest retained tick” action while live-head progress may continue independently. If compare baseline B loses aggregate coverage, preserve B as an unavailable compare intent, disable deltas/overlays with a clear reason, and require the user to choose a new baseline or clear compare. A retention commit must never silently rewrite T or B.  
\- when an old tick retains aggregates but not detailed ExplanationFacts/transactions, keep the aggregate chart usable and show “Detailed causes no longer retained for this tick” in the inspector

13A. Share, export and deep links  
Shareable UI state is a navigation hint, never evidence of run identity or retained data. A deep link may encode the active view, stable entity type/id, selected tick T, optional compare baseline B, and lightweight presentation choices such as the selected good or map layer. It may also carry an expected runIdentity only as a compatibility guard. The URL must never construct, override or prove runIdentity; the loaded SimulationOutput remains authoritative.  
For GitHub Pages, deep links must work on static hosting without server-side route rewrites. Prefer query parameters and/or a URL fragment under the repository’s actual Pages base path, or an equivalent static-host-safe router. Do not require arbitrary path routes that return 404 when opened or refreshed directly. Asset URLs must respect the configured Pages base path rather than assuming deployment at domain root.  
A deep-linked tick or baseline is restored only when it exists in HistoryRetentionMetadata for the verified run. If the tick was evicted, the baseline is unavailable, the entity did not exist at that tick, or the expected runIdentity differs from the loaded run, do not silently choose a nearby tick/entity or splice another run. Keep the valid current/default view, show a concise notice such as “Linked tick is no longer retained” or “This link belongs to a different run”, and offer an explicit action to open the latest retained tick or clear the incompatible selection.  
A shared URL may point into a live browser run, but it is not a portable replay artifact. Portable export requires a self-contained observation package or replay manifest carrying outputSchemaVersion, runIdentity and the retained data/definitions required by that export. Import must validate schema and run identity before rendering any exported snapshot. Exported stale/error snapshots must preserve their stale/error provenance rather than being presented as live progress.

Portable export is bounded by the same observation-retention contract as the live UI. A self-contained package may include one compatible DefinitionBundle plus only the aggregate/detail blocks actually retained for the export's declared tick range. It must not reconstruct evicted history, include transient orders or mutable WorldState, or duplicate immutable definitions per tick/block. If the requested range or detail is no longer retained, export must fail with an explicit unavailable reason or require a narrower retained range; it must not silently expand storage or synthesize missing data. Export size therefore grows approximately with one definition block plus the retained exported observation blocks, not definitions multiplied by ticks.  
The Share action should copy a canonical, bounded URL for the current observational state; do not serialize large histories, DefinitionBundles, arbitrary JSON, or mutable runtime state into the URL. Unknown or unsupported URL parameters are ignored safely and must not change simulation state.

14\. Causal explainability model

Every important displayed metric must map to a MetricDefinition:  
\- metricId  
\- label  
\- unit  
\- aggregation  
\- source stocks/flows  
\- formula  
\- sign convention  
\- update phase  
\- explanation adapters

For each tick, subsystems emit compact ExplanationFact records for material deltas rather than free-form text.

Suggested shape:  
ExplanationFact {  
  tick,  
  subjectType,  
  subjectId,  
  metricId,  
  delta,  
  causeType,  
  causeId?,  
  contribution?,  
  evidence: \[{metricId, value, delta}\],  
  phase  
}

Examples:  
\- Region.population changed by \+82: births \+31, deaths \-18, net migration \+69.  
\- Food price changed \+4.2%: inventory coverage fell, affordable demand exceeded cleared supply, imports were route-capacity constrained.  
\- ProductionUnit.output fell 27%: Grain input was the binding bottleneck.  
\- State.treasury fell 900: transfers 500 \+ procurement 650 \+ debt service 100 exceeded tax revenue 350\.

Explanation assembly rules:  
1\. Prefer exact accounting decomposition where available.  
2\. Otherwise use direct model driver deltas emitted by the subsystem.  
3\. Sort by absolute contribution/materiality.  
4\. Merge tiny contributors into “other”.  
5\. Never assign causal percentages that the model did not compute.  
6\. Show “no single dominant cause” when appropriate.

15\. Data contracts for the UI

Do not make the UI traverse the entire live domain object graph.

SimulationOutput is the single browser-facing ownership boundary. It is immutable presentation data, not WorldState and not an alias over mutable domain objects. Every serialized output payload must carry outputSchemaVersion at its top level. v1 starts at outputSchemaVersion \= 1; consumers must reject an unsupported version before reading snapshots, history or definitions and show the existing recoverable runtime-error state rather than guessing field meanings.

The top-level SimulationOutput owns RunMetadata, HistoryRetentionMetadata and the read-model payloads listed below. HistoryRetentionMetadata therefore travels with the same versioned output contract as the snapshots whose retained range it describes; it is not UI-local guessed state. RunMetadata must carry scenarioId, scenarioHash, seed, configHash, definitionPackHash and engineBuildId plus a deterministic composite runIdentity. scenarioHash/configHash/definitionPackHash use the canonical content-digest procedure owned by CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION; runIdentity is SHA-256 over a canonical named identity object containing those fields. A material scenario/config/definition-pack/build change must therefore create a different runIdentity, while declaration-order-only permutations that normalize to the same canonical input must not. TickSummary and entity snapshots identify their tick explicitly. Every payload, retained snapshot and cached DefinitionBundle admitted into one active UI run must match both outputSchemaVersion and runIdentity. A different runIdentity starts a new run and must never be appended to existing history. Immutable definition payloads may be transferred/cached separately for efficiency only when tied to the same runIdentity and compatible output version.

SimulationOutput should expose stable read models:  
\- RunMetadata  
\- TickSummary  
\- HistoryRetentionMetadata { earliestAggregateTick?, latestAggregateTick?, earliestDetailedTick?, aggregateTickRanges: TickRange\[\], detailedTickRanges: TickRange\[\], lifecycleCoverage: "REFERENCED\_ENTITIES\_ONLY" }. TickRange \= { startTick, endTick } inclusive and uses non-negative integer ticks with startTick \<= endTick. Each range list is in ascending order, strictly disjoint, and canonically coalesced: overlapping or directly adjacent serialized ranges are invalid rather than silently sorted/merged. detailedTickRanges must be a subset of aggregateTickRanges; detailed-only history is invalid. When aggregateTickRanges is non-empty, earliestAggregateTick/latestAggregateTick equal its first start/last end; when it is empty, both bounds are null/absent, detailedTickRanges is also empty, and earliestDetailedTick is null/absent. When detailedTickRanges is non-empty, earliestDetailedTick equals its first start. Tick availability is decided by range membership, never by assuming every tick between min/max survives downsampling/export. lifecycleCoverage states that EntityLifecycleRecord\[\] covers typed entities referenced by retained observation blocks; lifecycle lineage itself does not define a tick-retention range. Consumers validate this metadata before admitting history and must reject contradictory metadata rather than sorting, merging, clamping or filling ranges.

Retention coverage is also a completeness claim, not only a tick-membership claim. A tick may enter aggregateTickRanges only when the aggregate observation data required to render the v1 aggregate observatory at that tick is complete and admitted. A tick may enter detailedTickRanges only when aggregate coverage exists and the retained detail/explanation families promised by the v1 read-model contract for that tick are complete and admitted. An applicable collection with zero records is valid only when represented explicitly as an empty collection or equivalent complete-block marker; an omitted applicable block means unavailable/incomplete, not zero. Partial Worker chunks may stage records internally, but they must not advance aggregate/detail coverage until the corresponding tier is complete. Portable packages use the same rule: declared coverage must match the complete observation blocks actually present, and a tick-indexed block may not be silently orphaned outside the coverage that owns it. The concrete chunk/envelope framing is an engineering choice, but completeness must be machine-verifiable. Coverage/data disagreement is rejected atomically before a partial tick is appended or rendered.

Worker delivery is retry-safe and idempotent at the logical observation-commit boundary. The implementation must be able to distinguish a logical block by runIdentity \+ tick \+ observation tier/block family and must have enough delivery metadata to detect duplicate, stale or conflicting retries; the exact sequence/revision/digest/envelope fields are an engineering choice. Re-delivery of already committed identical content is a no-op, never a second append. Conflicting content for an already committed logical block is rejected as corruption rather than accepted by last-write-wins. Reordered or delayed chunks from an older delivery attempt may update only still-uncommitted staging and must never overwrite committed observations, regress retained coverage or resurrect detail that has already been evicted/downsampled. Retention ranges change atomically with a verified observation commit or an explicit local retention/eviction/downsampling commit, not merely because an older payload carries an older metadata projection. A retention/eviction/downsampling commit operates only on already committed compatible observations for the same run; uncommitted staging cannot be its source of truth. If downsampling derives a durable aggregate from finer detail, the replacement aggregate must be materialized and verified before the source detail is removed. Removing aggregate coverage for tick T removes any detailed coverage for T in the same atomic transition. The commit updates affected observation blocks, aggregateTickRanges/detailedTickRanges and reference-bounded EntityLifecycleRecord coverage as one externally consistent state. Such a retention commit may preserve or remove existing coverage but may not resurrect a tier; newly available data enters only through a verified observation commit. Delivery/retention ordering metadata must make a delayed payload unable to undo a later retention transition; the exact epoch/version/sequence encoding remains an engineering choice. Same-run Worker recovery may resend committed blocks only idempotently after outputSchemaVersion/runIdentity and content-identity checks; stale retry data cannot move the selected/live tick or make an evicted tier available again.

User-visible progress follows committed observation state, not Worker transport activity. Staged chunks, duplicate retries and reordered delivery may be reflected only in a neutral background processing/recovering indicator that does not claim a new simulation tick. The live/current tick, selected tick, timeline extent, event log, ExplanationFact notices, metric deltas and compare state change only after the corresponding verified logical observation commit is admitted. If the user has scrubbed away from live mode, a new commit may advance the live-head marker without moving the selected tick. Re-delivery of identical committed content must not replay notifications, flash charts, restart transitions or increment visible progress. Retry/recovery indicators should be monotonic at the semantic level—working, recovered, error—not tied to raw chunk counts that can move backward or flicker under retries. The UI may show simulation throughput separately, but it must label such telemetry as processing/runtime status rather than retained world state.  
\- WorldSnapshot  
\- StateSnapshot\[\]  
\- RegionSnapshot\[\]  
\- ClanSnapshot\[\]  
\- MarketSnapshot\[\]  
\- ProductionSnapshot\[\]  
\- RouteSnapshot\[\]  
\- CurrencySnapshot\[\]  
\- EventRecord\[\]  
\- ExplanationFact\[\]  
\- EntityLifecycleRecord\[\]

Snapshot records contain typed stable entity references and scalar/compact-vector values suitable for serialization. A browser-facing entity reference is { entityType, entityId } (or an equivalent typed representation) and resolves within the selected snapshot or retained lifecycle record, never through a mutable array position or by blindly looking up the current registry. Persistent entity IDs are never reused within a run. SimulationOutput must therefore expose EntityLifecycleRecord\[\] as browser-facing lifecycle truth rather than asking the UI to infer lifecycle from missing snapshots. Each record contains entityRef, status, startTick, optional endTick/effectiveTick, optional reasonCode/reasonText, and explicit predecessorRefs/successorRefs when the domain recorded lineage or succession. Missing optional reason/lineage data means unknown/not recorded, not zero or an inferred relationship. If an entity was not yet created or has left the live registry at tick T, the UI resolves the lifecycle record and retained historical snapshot where available, or shows an explicit lifecycle-unavailable state rather than rebinding the reference. DefinitionBundle is one run-scoped immutable block owned by the versioned SimulationOutput contract. RunMetadata carries its identity/hash metadata, while tick/history records reference definitions only by stable IDs. The bundle may be transferred separately and cached for efficiency, but it is sent at most once per active run or on an explicit compatible cache miss; it must never be copied into each tick snapshot/history block. A cached or imported DefinitionBundle must match outputSchemaVersion, runIdentity and definitionPackHash before use.

Lifecycle metadata follows the same bounded-retention boundary as the observation data it explains. EntityLifecycleRecord\[\] is not a permanent tombstone registry. A lifecycle record must be retained for every typed entity reference that still appears in a retained snapshot, ExplanationFact, EventRecord or other retained observation block. After the last retained observation referring to that entity is evicted, its lifecycle record may be evicted too unless another retained observation still requires it. predecessorRefs/successorRefs are informative links and do not recursively pin an unlimited lineage chain in memory. A deep link to an entity whose lifecycle record and observations have both been evicted therefore resolves to the existing explicit lifecycle-unavailable state; the UI must not reconstruct or infer the missing lifecycle.

Portable exports apply the same rule. They include lifecycle records for typed entity references actually present in the exported observation blocks. A predecessor/successor reference may point to an entity outside the exported retained range; that target is allowed to remain an opaque typed reference and must render as not included/unavailable if opened. Export must not recursively pull an unbounded predecessor/successor chain merely to make every lineage target navigable.

The current repository’s long CSV is acceptable as a migration bridge, but the mature UI should not depend on one gigantic CSV whose rows mix every future entity type. Prefer versioned JSON or compact columnar/typed-array friendly payloads split into metadata \+ time-series blocks. The exact schema belongs in 05 \- Implementation Specs.

16\. Browser execution architecture

Target:  
\- GitHub Pages static hosting  
\- simulation engine runs in a Dedicated Web Worker when simulation-in-browser is enabled  
\- main thread owns DOM and charts  
\- worker sends periodic snapshots/deltas to main thread  
\- large transferable buffers may be used later for heavy time-series blocks

Rationale: browser main-thread JavaScript also handles user input, layout and painting; long simulation ticks on that thread would directly damage responsiveness. Dedicated Workers are a widely supported standard mechanism for moving compute-intensive work off the UI thread.

For initial implementation, keep rendering technology boring:  
\- semantic HTML/CSS for layout  
\- SVG for modest line/bar charts and interactive labels  
\- Canvas for dense route/point layers only when benchmarks justify it  
\- no WebGL/WebGPU requirement in v1  
\- no framework requirement solely for charts

The existing repository’s dependency-free static page is worth preserving conceptually. A small modern build step is acceptable if it materially improves maintainability, but the deploy output must remain static.

17\. Performance budgets

Reference browser target: mainstream desktop/laptop from the last \~5 years.

Interaction budgets:  
\- ordinary hover/select response: \<50 ms perceived main-thread blocking  
\- tick-to-visible-update during playback: target \<100 ms at normal speeds  
\- timeline scrub to retained tick: target \<150 ms for cached data  
\- initial useful view: target \<2 s on a normal broadband connection for default scenario

Data/render budgets for v1 target scale:  
\- Regions: 20–100  
\- States: 2–12  
\- Clans: 5–40  
\- Goods: 8–16  
\- ProductionUnits: 100–2,000  
\- TransportLinks: 20–300  
\- retained ticks: 1,000–10,000 depending snapshot density

Rendering rules:  
\- never create one DOM node per historical transaction  
\- never render all ProductionUnits on every overview chart  
\- aggregate before drawing  
\- update changed selections/layers rather than rebuilding the whole page  
\- decimate long time series to pixel resolution for display while retaining exact values for tooltip lookup  
\- virtualize long tables/logs  
\- suppress visually negligible flows  
\- cache derived selectors by tick/entity/filter

Performance acceptance tests must measure both worker simulation throughput and main-thread frame responsiveness.

18\. Visual language

The existing page’s restrained neutral palette, light/dark adaptation, compact typography and unobtrusive panels are a good baseline. Preserve the analytical tone.

Use semantic encoding consistently:  
\- goods/categories: stable categorical colors  
\- states/clans: stable identity colors  
\- positive/negative delta: diverging treatment, not necessarily red/green only  
\- warning/stress: severity scale  
\- policy series: stepped/dashed visual grammar  
\- endogenous continuous series: solid lines  
\- event windows: translucent bands/markers

Accessibility and required interaction states:  
\- color cannot be the sole encoding  
\- keyboard-accessible timeline and navigation  
\- SVG/Canvas visualizations need readable labels/aria summaries where practical  
\- tooltips must be reachable by focus for key marks  
\- respect prefers-reduced-motion  
\- retain light/dark support  
\- loading: render the application shell and honest loading/skeleton states; never display missing values as zero  
\- no data: explain why a metric or series is unavailable at the selected tick and offer the nearest useful scope when possible  
\- not applicable: say so explicitly (for example, “No domestic monetary authority”) rather than rendering 0, blank space or a fake series  
\- Worker/runtime error: pause playback and preserve the last verified snapshot as read-only evidence, but mark it visibly as stale while recovery is pending. A Worker restart may resume the existing UI history only after the first new payload passes outputSchemaVersion and runIdentity checks. If recovery produces a different runIdentity, clear timeline/compare/entity-selection state atomically before rendering the new run; never splice old and new snapshots together. If no compatible payload arrives, keep the stale snapshot labeled and the runtime-error state visible rather than implying live simulation progress  
\- invariant failure: keep a persistent high-severity warning with the failing invariant and tick; diagnostics must remain reachable  
\- entity lifecycle changes: if a selected entity closes, becomes dormant, migrates jurisdiction, is merged/split or otherwise changes status, keep its typed stable reference and show the lifecycle change instead of silently switching selection. Historical selection resolves against the selected tick's retained record; retired IDs are never assigned to newer entities, and successor/predecessor lineage is shown only when explicitly recorded. Use one compact lifecycle treatment in the context inspector rather than a permanent lineage dashboard: a status badge (Active / Closed / Retired / Succeeded / Dormant as applicable), the effective tick, and one short human-readable sentence. ProductionUnit closure shows the closure tick and recorded reason when available; values after closure are not rendered as zero. PopulationCohort merge/split shows predecessor/successor links only when recorded, summarized as a small “Continued as …” / “Formed from …” row instead of a large graph. State succession keeps the historical State's own name and identity, marks when it ended, and may link to the explicit successor State; never relabel old State history with the successor's name. Current overview lists show entities existing at the selected tick by default; retired entities appear through historical selection/search/lineage rather than being mixed into current rankings. If a deep link names a valid retired entity at a tick outside its lifecycle, show an explicit lifecycle-unavailable notice; when retained data allows it, offer “Open last retained tick for this entity” and an explicit successor/predecessor link, but never redirect automatically.  
\- every chart must expose a readable title, axis/unit labeling, time basis, legend when more than one series is present, and the selected tick/range where ambiguity is possible; monetary charts must name the currency, percentages must state their denominator/time basis, and dual y-axes are avoided unless both scales are necessary and unmistakably labeled  
\- tooltips and metric help text must use plain English and define gross/net, nominal/real, per-capita, rate and stock/flow distinctions where relevant; unexplained internal identifiers or abbreviations are not acceptable

19\. Diagnostics view

Diagnostics is not optional developer clutter; it is how the simulation proves itself.

Show:  
\- deterministic seed and model/schema versions  
\- invariant status  
\- money-supply reconciliation by currency  
\- world goods conservation by good, including production/extraction, consumption, spoilage, transport/event losses and inventory delta  
\- population reconciliation  
\- government debt asset/liability reconciliation  
\- negative-stock / NaN / infinity guards  
\- market-clearing residuals  
\- performance: tick time, render time, memory estimate

Any invariant breach should surface a persistent banner with the failing metric and tick.

20\. Required visualization tests

1\. Same seed/run data produces identical displayed values.  
2\. Selecting tick T updates all panels to T.  
3\. Compare mode never mixes two timestamps unlabeled.  
4\. World population equals sum of region/state population under canonical jurisdiction rules.  
5\. State fiscal charts reconcile to treasury/debt deltas.  
6\. Currency money-supply chart reconciles to actor wallets plus authority-defined components.  
7\. Good-flow accounting displayed in diagnostics matches simulation invariants.  
8\. Direct event losses are not double-counted as endogenous losses.  
9\. Map route direction and quantities match RouteSnapshot.  
10\. Price chart uses canonical household-facing vs market price definitions explicitly.  
11\. Monetary-union member states show the shared policy authority and shared effective policy rate correctly; the UI never implies that each member owns a separate central bank.  
12\. Foreign-legal-tender states show the foreign currency and its issuer, but display no domestic policy authority or policy rate; they are not shown as members of the issuing MonetaryAuthority.  
13\. Region detail shows migration conservation between origins/destinations where applicable.  
14\. Production bottleneck explanation matches the production algorithm’s binding minimum.  
15\. Keyboard timeline controls work.  
16\. Reduced-motion mode removes nonessential animation.  
17\. Long history is decimated visually without changing tooltip exact values.  
18\. Dense flows cross the rendering threshold without freezing the main thread.  
19\. Worker failure produces recoverable error UI instead of corrupt state.  
20\. Any failed accounting invariant produces a visible diagnostic warning.  
21\. If baseline B is evicted, unavailable, or predates the selected entity, compare mode disables the affected delta and explains the reason; it never substitutes another tick silently.  
22\. If a State changes currency regime between B and T, nominal monetary values retain their currency labels and no cross-currency percentage delta is shown without an explicit canonical conversion.  
23\. Rolling-history degradation preserves aggregate charts for retained aggregate ticks while clearly marking unavailable fine-grained causal detail.  
24\. Narrow layouts keep units, selected tick, warning states and primary drill-down actions visible; wide tables scroll within their container without page-level overflow.  
25\. Every multi-series chart exposes a keyboard/focus-readable legend and exact-value tooltip or equivalent accessible value summary.  
26\. After a Worker/runtime failure, the last verified snapshot remains visible only with an explicit stale/error state; playback and live-progress indicators remain stopped until a compatible payload is verified.  
27\. A Worker restart with the same runIdentity may continue retained history only after schema/run checks pass; a restart with a different runIdentity clears timeline, compare baseline and entity-selection state before rendering the new run, with no mixed-run series or cached definitions.  
28\. Payloads with a matching outputSchemaVersion but mismatched runIdentity are rejected from the active history just as strictly as incompatible schema versions.  
29\. Run identity hashing is stable under declaration-order-only permutations of schema-defined unordered keyed collections but changes when material scenario/config/definition-pack/build content changes; Worker recovery never treats process-local or object-order-dependent hashes as same-run evidence.  
30\. A GitHub Pages deep link restores view/entity/tick/compare state only after the loaded SimulationOutput passes schema/run validation; URL parameters never create or override runIdentity.  
31\. Opening or refreshing a shared link under the repository Pages base path does not require server rewrites and does not produce a route 404; assets resolve correctly from the configured base path.  
32\. A link to an evicted tick, unavailable baseline, missing-at-that-tick entity or different runIdentity produces an explicit recoverable notice and never silently substitutes a nearby tick/entity or mixes runs.  
33\. Portable export/import validates outputSchemaVersion \+ runIdentity before rendering, contains the data needed for its advertised retained range, and preserves stale/error provenance when exported from a stale runtime state.  
34\. Per-tick Worker/history payloads do not repeat DefinitionBundle content; definition data is admitted once per active run or explicit compatible cache miss, and snapshots resolve definitions by stable IDs only after outputSchemaVersion/runIdentity/definitionPackHash validation.  
35\. Portable export size grows approximately with one DefinitionBundle plus the exported retained observation blocks. An export contains no evicted/transient state or repeated immutable definitions and explicitly refuses an unavailable requested tick/detail range instead of reconstructing or silently widening it.

36\. Stable-reference lifecycle test: retained snapshots, deep links and ExplanationFacts use typed stable entity references, never array positions or current-registry slots. After a ProductionUnit closes or a PopulationCohort is retired by merge/split, its ID is not reused; selecting an earlier tick still resolves that original lifecycle instance, while ticks where it does not exist show an explicit lifecycle-unavailable state rather than a newer entity.

37\. Lifecycle presentation test: a closed ProductionUnit remains inspectable at retained ticks where it existed, shows Closed with its effective tick and recorded reason when available, and never displays unavailable post-closure metrics as zero or silently selects another unit.  
38\. Lineage and succession presentation test: cohort merge/split and State succession preserve the historical entity's own label and typed ID, show only explicit predecessor/successor links in a compact inspector row, and never rename historical State records to the successor.  
39\. Lifecycle deep-link test: a link to an entity outside its lifecycle shows an explicit lifecycle-unavailable state. When a retained valid tick or explicit lineage target exists, navigation is offered as a user action; the UI does not silently redirect, substitute a nearby tick, or rebind to a current entity.  
40\. Lifecycle read-model contract test: SimulationOutput includes EntityLifecycleRecord\[\] with typed entityRef, status and lifecycle timing; optional reason and predecessor/successor refs are passed through only when recorded by the domain. The UI can render Active/Closed/Retired/Succeeded/Dormant and lifecycle-unavailable states without inferring them from missing snapshots, current registry membership or array positions.  
41\. Lifecycle-retention/export boundary test: EntityLifecycleRecord storage is reference-bounded, not a permanent tombstone log. Every typed entity referenced by a retained snapshot, retained ExplanationFact/EventRecord, or another retained observation block has a matching lifecycle record. When the last retained observation referring to an entity is evicted, its lifecycle record may also be evicted unless another retained observation still requires it. predecessorRefs/successorRefs do not by themselves pin an unlimited lineage chain. Portable exports include lifecycle records for entity references actually present in the exported observation blocks; lineage refs to entities outside the exported retained range may remain typed links but resolve to an explicit “not included in this export / no longer retained” state rather than forcing recursive history inclusion.  
42\. Retention-metadata validation test: reject negative/reversed TickRanges, unsorted/overlapping/adjacent uncoalesced ranges, detail coverage outside aggregate coverage, bounds that disagree with ranges, and any detailed-only history. Empty history is valid only with both range lists empty and all earliest/latest bounds null/absent. A malformed Worker payload or portable import is rejected atomically before history is appended/rendered; the consumer never silently normalizes it, and any previously verified live snapshot remains visibly stale/read-only under the existing recoverable runtime-error behavior.  
43\. Observation-completeness test: aggregateTickRanges never includes a tick whose required aggregate observation block is missing/incomplete; detailedTickRanges never includes a tick whose aggregate tier or required retained detail/explanation families are missing/incomplete. Explicitly empty applicable collections count as complete, omission does not. Partial Worker chunks do not advertise a tier before completion, portable imports/exports reject declared coverage that disagrees with included blocks, and no partial tick is rendered or appended.  
44\. Worker retry/idempotence test: duplicate, delayed and reordered deliveries for the same run/tick/tier cannot duplicate records, overwrite a committed observation, regress retention coverage or resurrect evicted detail. An identical committed block redelivered after a retry/restart is a no-op; conflicting content for that committed logical block is rejected. Older-attempt chunks may affect only uncommitted staging, and coverage changes only with the verified commit/eviction that owns the observation state.

45\. Staging/live-progress presentation test: partial, duplicate, delayed or reordered Worker deliveries never move the selected tick, live-head tick, timeline extent, event log, ExplanationFact notices, metric deltas or compare state before a verified logical commit is admitted. Identical committed re-delivery produces no duplicate notification, animation or progress increment. When the user is viewing an older retained tick, a newly committed live tick advances only the live-head marker and does not pull the selection forward. Background processing/recovery status may change, but raw chunk/retry counts do not create visible progress flicker or imply committed simulation state.  
46\. Retention/downsampling atomicity test: a retention transition reads only committed same-run observations. When fine detail is downsampled, any replacement aggregate is verified before source detail is deleted; removing aggregate coverage also removes detailed coverage for that tick. Observation blocks, retention ranges and affected lifecycle records become visible atomically, and a delayed pre-eviction payload cannot restore a tier removed by the newer retention transition. Retention/downsampling itself never creates new availability; only a verified observation commit can do that.  
47\. Active-selection retention invalidation test: while the user is viewing retained tick T with compare baseline B, apply retention transitions that first remove only T detail, then remove B aggregate coverage, then remove T aggregate coverage. T remains selected through detail-only degradation; B becomes visibly unavailable and all compare deltas/overlays disable without substitution; when T aggregate coverage disappears, the UI shows an explicit unavailable selected-tick state and does not jump to another tick. Live-head progress may continue independently, and returning to a retained tick requires an explicit user action.  
21\. Benchmark scenarios for UI acceptance

A. Stable trade world  
Demonstrates specialization, converging local prices and persistent route flows without alert spam.

B. Food shock  
Shows direct event damage, inventory fall, price rise, substitution, imports, health effect and later recovery as a causal chain.

C. Regional boom  
Shows investment, labor demand, wage rise, migration and settlement pressure without scripting a “boom” label.

D. Fiscal stress  
Shows weak revenue, transfers/procurement/debt service, treasury depletion, debt issuance and stress indicators.

E. FX reserve exhaustion  
Shows cross-currency flow pressure, FX movement, declining liquidity and constrained settlement.

F. Monetary-union asymmetric shock  
Shows one shared policy rate with divergent member-state inflation/unemployment conditions.

G. Frontier settlement  
Shows settlement investment, migration, market activation, infrastructure growth and eventual political incorporation/state formation when applicable.

22\. Explicit simplifications and rejections

Rejected for core v1:  
\- 3D globe or terrain rendering  
\- continuous geographic simulation beyond coarse Region graph  
\- animated individual people, carts, factories or coins  
\- force-directed layout recomputation every tick  
\- giant universal Sankey of all transactions  
\- chart-per-metric dashboard walls  
\- AI-generated causal prose not grounded in recorded model facts  
\- full transaction-history retention for every order/payment  
\- WebGL/WebGPU as a mandatory dependency  
\- real-time multiplayer/server backend

These features add spectacle or implementation cost without improving the core goal: understanding emergent economic behavior.

23\. Migration from current GitHub Pages page

Preserve:  
\- static GitHub Pages deployment  
\- deterministic replay framing  
\- existing play/scrub interaction concept  
\- restrained visual style  
\- direct simulator-output-to-visualization pipeline  
\- small dependency footprint

Replace gradually:  
1\. Extract the current single-file UI into app shell \+ data adapter \+ reusable chart/map modules.  
2\. Keep reading legacy run.csv through an adapter while new read models are introduced.  
3\. Add canonical timeline store and selected-entity store.  
4\. Replace hard-coded four-city coordinates/resources with Region/Good definitions.  
5\. Introduce World, Region and Market views first.  
6\. Add State, Population/Clan, Production, Fiscal/Monetary and Events views as their snapshots stabilize.  
7\. Move simulation execution to a Dedicated Worker when the browser-native engine milestone arrives.  
8\. Retire legacy CSV only after schema-versioned output and regression snapshots are proven.

24\. Implementation complexity

Let R=regions, S=states, C=clans, G=goods, P=production units, L=transport links, T=retained ticks.

Overview rendering should be approximately O(R \+ L \+ S \+ G) per selected tick, not O(P \+ all transactions).  
Entity detail may be O(P\_region) or O(C\_region) for selected scope.  
Time-series retrieval is O(1) indexed access for a tick plus O(K) for the plotted series length after decimation.  
Explanation rendering is O(E\_subject) for pre-indexed ExplanationFacts.

The UI must never require O(T×P) reconstruction during ordinary scrubbing. Historical aggregates must be stored in a form that supports direct indexed selection.

25\. Readiness and unresolved implementation choices

Implementation readiness: high. The UI/UX architecture is final for core v1.  
The global consistency/simplicity review and final handoff audit have passed. M11 may implement this specification directly, subject to the canonical read-model contracts and document 12 acceptance/performance gates.

Engineering choices intentionally left to implementation:  
\- exact physical JSON/columnar encoding within the canonical outputSchemaVersion \= 1 contract; changing field meanings or compatibility rules requires a schema-version change  
\- additional derived macro metrics beyond the explicitly required headline metrics; any addition must have a canonical MetricDefinition before it appears in UI  
\- exact chart library choice, if any  
\- concrete file/module layout  
\- exact SVG→Canvas switch thresholds from benchmarks  
\- history retention/decimation format  
\- Worker message transport/framing/retry fields may be engineered freely, but the transport must implement the canonical idempotent logical-commit semantics above: duplicate/stale/conflicting delivery must be detectable, committed observations are immutable, and retry/reordering cannot mutate retention truth  
\- acceptance-test harness and performance fixtures

These choices must not alter metric definitions, causal semantics, history/replay behavior, accessibility requirements or acceptance/performance budgets. None requires reopening economic or product design.

26\. Source notes

Repository evidence: the current project already deploys a dependency-free GitHub Pages page from docs/, reads the simulator’s run.csv directly, plots per-city prices, replays trade flows with a timeline scrubber, and documents deterministic replay. This implementation should be treated as a migration base rather than discarded.

Browser engineering evidence: MDN documents that main-thread JavaScript shares the thread with event handling/layout/painting and that long-running work can make pages unresponsive; Dedicated Web Workers allow compute-heavy scripts to execute off the main thread and communicate with the UI via messages. These properties support using a worker for the simulation engine while retaining rendering on the main thread.

Visualization-library note: mature libraries such as D3/Observable Plot demonstrate concise declarative statistical charting and interaction patterns, but the product does not require adopting a specific library until implementation benchmarking. The architecture is intentionally library-neutral.  
