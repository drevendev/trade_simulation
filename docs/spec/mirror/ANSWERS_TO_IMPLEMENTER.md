# ANSWERS\_TO\_IMPLEMENTER

Append-only researcher/QA responses to the implementation team.

## 2026-09-03 — Initial implementation handshake

To the Claude implementation team:

I accept the file-based, stateless-agent workflow. The product/economic contracts remain specification authority; implementation feedback is evidence and may trigger the smallest corrective spec change when justified. The three repository feedback files are now mandatory inputs for each QA/research run, and semantic requirement changes must be recorded instead of silently edited.

### A. Public mirror allowlist

Mirror exactly these paths relative to the Economic Simulation specification root:

\- REQUIREMENTS\_REGISTRY.csv  
\- SPEC\_INDEX.md  
\- EXECUTION\_ORDER.md  
\- SPEC\_CHANGELOG.md  
\- ANSWERS\_TO\_IMPLEMENTER.md  
\- 06 \- Handoff/\*\*

06 \- Handoff currently contains the implementation package:  
\- START\_HERE — Economic Simulation Implementation Handoff  
\- 00 — MASTER\_IMPLEMENTATION\_INDEX  
\- 01 — CORE\_SCHEMA\_AND\_LIFECYCLES  
\- 02 — IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01  
\- 03 — CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION  
\- 04 — MARKETS\_TRADE\_FX\_CONTRACTS  
\- 05 — PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS  
\- 06 — POPULATION\_DEMOGRAPHY\_CLANS\_CONTRACTS  
\- 07 — STATE\_FISCAL\_LAWS\_CONTRACTS  
\- 08 — MONETARY\_CURRENCY\_CONTRACTS  
\- 09 — EXPANSION\_SETTLEMENT\_CONTRACTS  
\- 10 — EVENTS\_SHOCKS\_CONTRACTS  
\- 11 — REPOSITORY\_MIGRATION\_AND\_MILESTONE\_GATES  
\- 12 — ACCEPTANCE\_BENCHMARK\_PERFORMANCE\_SUITE  
\- 13 — VISUALIZATION\_AND\_EXPLAINABILITY  
\- 90 — USER\_DRAFT\_SYNTHESIS\_AND\_TRACEABILITY  
\- 91 — REPOSITORY\_AUDIT\_BASELINE  
\- 99 — PROJECT\_MANIFEST

Do not mirror:  
\- 00 \- Control/\*\*, including STATE\_AND\_QUEUE and the duplicate working PROJECT\_MANIFEST. Handoff/99 is the public implementation copy.  
\- 01 \- Inputs/\*\* (raw user drafts).  
\- 02 \- Research/\*\*.  
\- 03 \- Economic Model/\*\*.  
\- 04 \- Visualization/\*\* canonical working copies.  
\- 05 \- Implementation Specs/\*\* canonical working copies.  
\- 90 \- Reports/\*\*.  
\- Any future file not explicitly added to the allowlist in SPEC\_CHANGELOG.

Reason: 06 \- Handoff is deliberately self-contained and normalized. Mirroring working copies, research and reports would create duplicate authorities and increase drift risk.

I reviewed the proposed allowlist. I found no credentials, service-account material, personal notes, private operational data, or content that should remain non-public. The allowlisted package is intended for implementation and may be published in the public repository. Do not infer this permission for excluded paths.

### B. Source format and mirror export

The current Drive source is primarily native Google Docs. REQUIREMENTS\_REGISTRY.csv is a native Google Sheet created specifically so it can be exported deterministically as CSV. The four text control files are native Google Docs named with .md and should be exported as Markdown by the mirror. Handoff documents should also be exported to stable .md filenames. The repository copy is the implementation mirror; Drive remains specification authority.

### C. Requirement IDs and navigation

I accept the permanent ID scheme \`REQ-\<AREA\>-\<NNN\>\` and the statuses DRAFT / REVIEW / READY / FROZEN / RETIRED.

Frozen AREA vocabulary:  
CORE, CONFIG, MARKET, PRODUCTION, POPULATION, CLAN, FISCAL, MONETARY, EXPANSION, EVENTS, VISUALIZATION, MIGRATION, ACCEPTANCE, PERFORMANCE, SCOPE.

IDs are never renumbered or reused. A removed requirement becomes RETIRED. A semantic change to a requirement must be recorded in SPEC\_CHANGELOG.md.

REQUIREMENTS\_REGISTRY.csv is now bootstrapped with the complete executable requirement set needed for M0-M2. This is intentional incremental indexing: AUTHOR may begin M0 immediately. Before promotion into M3, the registry will be extended with M3-specific rows; later milestone requirements are indexed before that milestone becomes executable. Do not block M0 on indexing future M3-M12 internals.

### D. Execution order

Yes, an implementation order already existed and is canonical: M0 through M12 in Handoff/11. EXECUTION\_ORDER.md now exposes it as the short stateless-agent navigation layer.

M0 baseline lock/scaffolding \-\> M1 canonical primitives/config/world genesis \-\> M2 tick/ledger spine \-\> M3 local markets \-\> M4 production/labor/population closed economy \-\> M5 transport/trade/FX \-\> M6 fiscal/laws/clans/debt \-\> M7 monetary/currency \-\> M8 demography/migration/expansion/succession \-\> M9 events/shocks \-\> M10 whole-system acceptance/performance \-\> M11 browser/GitHub Pages observatory \-\> M12 legacy removal/release candidate.

Only the earliest unblocked milestone may advance. A failed gate blocks promotion.

### E. Current project status/readiness

PROJECT\_STATUS: COMPLETE.  
CURRENT\_PHASE: COMPLETE handoff; implementation phase begins at M0.  
REVIEW\_STATUS: ACTIVE, now transitioning to code/runtime QA as implementation PRs appear.  
Specification/handoff readiness: approximately 98% for implementation. No known critical economic/product-design blocker exists. Remaining QA is primarily implementation-edge validation and code-vs-contract review, not prerequisite design work.

### F. Existing code versus new canonical work

Existing repository behavior that should be preserved or used as regression infrastructure where useful:  
\- .NET 9 solution/build/CLI plumbing;  
\- seeded legacy run capability;  
\- Storage/inventory concepts where semantics fit;  
\- local Market concept as a legacy reference, not as canonical settlement authority;  
\- focused unit-test structure;  
\- existing money/stock conservation tests;  
\- current repository/GitHub Pages/deployment plumbing where reusable.

Do not claim any canonical REQ\_ID IMPLEMENTED merely because similar legacy behavior exists. IMPLEMENTATION\_STATUS.md must map each requirement to merged code plus a proving test.

Most target-domain behavior is new canonical implementation: typed IDs/registries, WorldState/TickContext and 0-15 tick pipeline, explicit ledgers, canonical config/world genesis, cohorts/demography, ProductionUnits/capital/labor, clans, fiscal/debt, monetary authorities/currencies/finite FX, route-constrained shipments, expansion/succession, typed events/shocks, SimulationOutput/Worker/history semantics and the explanatory observatory.

### G. Repository feedback channel

At the start of each QA/research run I will read:  
\- docs/spec/FEEDBACK\_TO\_RESEARCHER.md  
\- docs/spec/OPEN\_QUESTIONS.md  
\- docs/spec/implementation\_status.csv

Current state on 2026-09-03: the channel is open; there are no substantive implementation feedback entries or open domain questions yet, and implementation coverage is 0/0 because the mirror/registry had not yet been synchronized. After this handshake, the registry gives the implementation side stable IDs to populate that table.

Answers to future blocking questions should be appended here with date \+ Q-ID \+ REQ\_ID. If I change requirement meaning, I will also update SPEC\_CHANGELOG.md and the canonical/handoff document in the same change set.

### H. Response to the four mirror questions

1\. TAKE: the five root files listed in section A and all of \`06 \- Handoff/\*\*\`.  
2\. DO NOT TAKE: all paths explicitly excluded in section A.  
3\. Folder revision: the project root contains research/history/working duplicates that are useful for QA but are intentionally excluded from public implementation mirroring. I found no accidental file inside the 06 \- Handoff allowlist that should be removed. The duplicate working copies outside Handoff should remain in Drive for QA, not be mirrored.  
4\. Publication confirmation: yes. I found nothing in the proposed allowlist that is prohibited or inappropriate to publish. This confirmation applies only to the explicit allowlist.

You may enable the mirror after exporting the Google Sheet as CSV and Google Docs as Markdown with stable paths. AUTHOR may begin M0 once the mirrored control files are visible in the repository.

### I. Important runtime clarification

I found one genuine ambiguity while reviewing your letter against the handoff: the repository is .NET 9, but the target must run autonomously on static GitHub Pages. Earlier documents mixed a TypeScript recommendation with C\#-centric migration folder examples. This is now resolved canonically.

M0 freezes and characterizes the existing C\#/.NET 9 baseline. Starting with M1, new canonical simulation behavior is implemented in TypeScript as the browser-capable engine. Keep C\# as a legacy/golden oracle while responsibilities migrate; do not implement canonical economics twice. M11 adds the Worker/SimulationOutput/observatory around that same TypeScript engine, not a second port. The master index, migration plan, START\_HERE, registry and changelog have been updated accordingly.

## 2026-09-03 — Mirror navigation normalization

To the Claude implementation team:

1\. Heading/ANCHOR export: accepted. Mirrored navigation must not depend on escaped literal Markdown markers. Google Docs paragraph styles are the source-side contract: document title \= Heading 1; implementation-addressable section headings \= Heading 2/Heading 3 as appropriate. Literal \`\#\`, \`\#\#\`, \`\#\#\#\` prefixes are not authoritative. The root control files are being normalized now, and every Handoff section referenced by REQUIREMENTS\_REGISTRY must have a real Heading style before that REQ\_ID becomes executable. This is a mirror/navigation repair only; no requirement meaning changes.

2\. FILE exact-name rule: use the exact mirrored filename, including extension. REQUIREMENTS\_REGISTRY FILE values are being normalized to \`.md\`; no importer-side implicit extension rule is part of the contract. SPEC\_INDEX uses exact mirror paths as well.

3\. Priority mapping: accepted exactly as proposed. P0 \-\> \`priority:high\`; P1 \-\> \`priority:normal\`. \`priority:critical\` is reserved by implementation operations for broken required checks, broken build, regressions, or equivalent stop-the-line failures. \`priority:low\` remains available for implementation housekeeping and does not correspond to an executable spec priority unless later introduced explicitly. Forge labels are workflow metadata and do not alter requirement PRIORITY.

4\. Toolchain ADR: accepted. There is no canonical requirement for a package manager or TypeScript test runner. npm, Vitest, and the current Node LTS are valid local engineering choices. Vite and TypeScript remain the specified browser/runtime direction. Record toolchain changes as ADRs; they do not require spec changes unless they affect observable contracts, determinism, browser support, performance gates, or GitHub Pages compatibility.

5\. Required TypeScript check: agreed. REQ-MIGRATION-003 already requires the canonical TypeScript scaffolding to build/test independently while legacy .NET remains green. It is correct to keep the schedule disabled until that required check is present; once it exists, AUTHOR may start M0 immediately.

6\. Registry timing: unchanged. M0-M2 are executable from the current registry. M3-specific requirements will be registered and changelogged before M3 promotion; implementation should not wait for M3 indexing to begin M0.

No economic mechanism changed in this normalization.

2026-09-03 — CODE\_RUNTIME\_QA\_02 — REQ-MIGRATION-002 baseline pin

PR \#18 correctly proves repeated-run determinism and is otherwise within M0 scope, but it does not yet freeze the legacy baseline. Both same-seed hashes are computed fresh inside the test, so a future deterministic legacy behavior change could alter both values and still pass. That defeats M0's purpose of recording a reproducible baseline/golden oracle.

Smallest correction: keep the current normalized snapshot utility and same-seed/different-seed tests, and add one checked-in expected SHA-256 for the representative 30-turn baseline using a fixed documented seed (seed 7 is acceptable if retained). The proving test must assert that the 30-turn run equals that exact expected digest. Update IMPLEMENTATION\_STATUS evidence after the corrective PR merges. This is a migration-evidence repair only; no legacy economic behavior or canonical economic mechanic should change.

Until that follow-up merges, treat REQ-MIGRATION-002 as not fully closed under the corrected acceptance. Do not discard the useful implementation from PR \#18.

## 2026-09-04 — CONSISTENCY/SIMPLICITY\_REVIEW — M0 mirror/status reconciliation

Cross-check result: Drive specification authority is internally consistent, but the repository-facing copies are stale. The authoritative Drive registry currently contains 21 requirements, including REQ-CORE-002, and REQ-MIGRATION-002 now requires a fixed documented 30-turn seed plus a checked-in expected normalized SHA-256. The repository mirror currently contains 20 requirement rows, omits REQ-CORE-002, and still carries the pre-repair REQ-MIGRATION-002 acceptance. IMPLEMENTATION\_STATUS.md separately says “2 of 19 requirements implemented” and marks REQ-MIGRATION-002 IMPLEMENTED using only the same-seed/different-seed tests from PR \#18.

Required reconciliation, without changing any economic mechanic: before the next AUTHOR requirement selection, refresh the allowlisted mirror from Drive and verify that the mirrored registry has 21 rows, includes REQ-CORE-002, and contains the pinned-digest acceptance for REQ-MIGRATION-002. Then reconcile IMPLEMENTATION\_STATUS.md against that refreshed registry. REQ-MIGRATION-001 may remain IMPLEMENTED on its existing build/test evidence. REQ-MIGRATION-002 must not remain IMPLEMENTED until a merged follow-up adds the fixed expected 30-turn SHA-256 assertion required by the current acceptance; preserve PR \#18 as partial evidence rather than discarding it. The coverage summary must be computed from the current mirrored registry rather than a hard-coded historical count.

This is a mirror/evidence consistency repair only. No requirement meaning was changed in this review and no SPEC\_CHANGELOG entry is needed beyond the already-recorded CODE\_RUNTIME\_QA\_02 semantic correction.

## 2026-09-04 — CODE\_RUNTIME\_QA\_03 — Issue \#27 evidence-state correction

## Issue \#27 correctly selects REQ-MIGRATION-003 as the next substantive M0 scaffolding unit, but its final acceptance bullet required the implementation pull request to record its own merge commit in IMPLEMENTATION\_STATUS.md. That is impossible before merge and contradicts the repository's already-established AUTHOR\_RUNBOOK reconciliation flow.

Smallest correction: in the implementation PR, add/update REQ-MIGRATION-003 as IN\_PROGRESS, name Issue \#27 and the proving tests, and leave Merged in as pending (or the repository's equivalent pre-merge marker). After the PR merges, the next bounded reconciliation step changes the row to IMPLEMENTED and records the actual merge commit. Only IMPLEMENTED is closing evidence. I posted this correction directly on Issue \#27 so the executable task contract is unambiguous before an AUTHOR run claims it.

No product/economic requirement, M0 scope, or acceptance test meaning changed. This is repository evidence-state/process repair only; SPEC\_CHANGELOG does not need a semantic-change row.

2026-09-05 — FRESH\_IMPLEMENTER\_HANDOFF\_REVIEW\_01  
Method: first-pass findings below were produced from REQUIREMENTS\_REGISTRY plus the self-contained 06 \- Handoff package before reading STATE\_AND\_QUEUE, prior QA history, working canonical copies or implementation rationale. These are findings only. Do not change requirement meaning from these notes; each repair must be decided in a separate bounded run.

HANDOFF-FRESH-001 — REQ-CONFIG-003, REQ-CORE-003 — M1 cohort seed schema is not self-consistent inside the handoff  
A fresh implementer following the M1 world-gen requirement can read Handoff/03 and find CohortSeed.stratum \= LOWER | MIDDLE | UPPER plus prosperityIndex, while Handoff/00 and Handoff/02 declare the mature persistent cohort model VULNERABLE | WORKING\_MIDDLE | AFFLUENT and prosperityEma-based state authoritative over the old aliases. The correct interpretation currently depends on remembering the precedence/normalization history rather than on the named world-gen slice being internally coherent. Risk: baseline genesis can serialize a stale cohort vocabulary and force an adapter or later migration that the requirement never asked for.  
Follow-up for a separate repair run: decide whether CohortSeed should use the mature vocabulary directly or define an explicit seed-to-runtime translation. Then patch the handoff and navigation/dependencies together. Do not guess during implementation.

HANDOFF-FRESH-002 — REQ-CORE-003, REQ-CONFIG-003, REQ-CONFIG-004 — direct FILE+ANCHOR navigation can expose superseded authoritative-looking state  
Handoff/01 still physically contains superseded fields such as RegionState.pendingControllerStateId, RegionState.marketStatus, the old PopulationCohort fields, and independently mutable ProductionUnit.capacity. Handoff/00 and Handoff/02 correctly override them, but the per-run AUTHOR protocol opens the exact FILE+ANCHOR and at most one directly listed dependency document. The READY registry rows that build registries/world genesis do not mechanically guarantee that the consistency-review override is the dependency slice the implementer will read. Risk: a stateless implementer can satisfy the named requirement while materializing state that the master later says must not exist.  
Follow-up for a separate repair run: either remove/mark the stale schema inline in Handoff/01 or make the relevant READY requirement navigation explicitly include the normalization source. Preserve the two-read navigation goal.

HANDOFF-FRESH-003 — REQ-ACCEPTANCE-001, REQ-CORE-006 — M2 reconciliation tolerance is not reachable from the executable dependency slice  
REQ-ACCEPTANCE-001 asks for exact/tolerance stock conservation and points to Gate M2, depending on REQ-CORE-004 and REQ-CORE-006. The actual numeric money/quantity/population/rate/reconciliation tolerances live in Handoff/03 NumericConfig, while the named M2 slice and listed dependency chain do not identify that source. A fresh implementer therefore has to remember Handoff/03 or choose a tolerance. That is a test-contract ambiguity, not merely code organization.  
Follow-up for a separate repair run: make the acceptance/dependency chain point to the canonical NumericConfig tolerance source or state the relevant tolerances directly in the M2 acceptance slice.

HANDOFF-FRESH-004 — REQ-CORE-006 — M2 “typed ledger/flow records” leaves the minimum ledger contract underdefined  
Gate M2 requires typed flow/ledger records for money, goods and physical losses plus fail-fast mismatch diagnostics. Handoff/01 defines the generic EconomicTransaction/accounting discipline, while the M2 requirement slice does not define the minimum record families/fields or the deliberately injected mismatch boundary needed by acceptance. The eventual market contract later defines richer transaction records, but M2 must exist before M3. A fresh implementer can make materially different ledger APIs and still claim the prose requirement.  
Follow-up for a separate repair run: decide whether M2 intentionally permits any equivalent typed representation; if yes, make the observable minimum semantics explicit. If no, define the small M2 ledger record set before further subsystems depend on it.

HANDOFF-FRESH-005 — REQ-MARKET-002, REQ-CONFIG-001 — Handoff/03 and Handoff/04 disagree on the canonical market baseline defaults  
Handoff/03 explicitly says it owns canonical defaults and gives MarketConfig baseline values such as basePriceAdjustmentSpeed \= 0.12, maxAbsoluteLogPriceMovePerTick \= 0.18, shortageSignalWeight \= 0.65 and inventorySignalWeight \= 0.35. Handoff/04's Phase-6 price section instead recommends priceSpeed \= 0.20, maxLogPriceStep \= ln(1.15), wExcess \= 0.70 and wInventory \= 0.30. Both are implementation-facing and the master precedence does not make it obvious whether a subsystem's “recommended starting defaults” override the configuration document that explicitly owns defaults. A fresh M3 implementer must choose values or names.  
Follow-up for a separate repair run: decide one canonical MarketConfig naming/value set, state whether Handoff/04 examples are historical/non-authoritative or update them to the config registry, and only then promote REQ-MARKET-002 from REVIEW.

HANDOFF-FRESH-006 — REQ-MARKET-004 — M3 local tax settlement calls an undefined collection-efficiency input at a milestone before fiscal implementation  
Handoff/04 makes buyer affordability and local-sale settlement depend on applicableConsumptionTaxRate(...) and collectionEfficiency(...), but the M3 local-market slice is scheduled before the M6 fiscal/law subsystem and does not define a minimal M3 fixture contract or fallback for collectionEfficiency. REQ-MARKET-004 must prove the collected tax transfer now, so a fresh implementer is forced to invent whether collection efficiency is 1, read a later fiscal contract, or build fiscal behavior early.  
Follow-up for a separate repair run: define the smallest M3 tax-policy fixture/query boundary (for example an explicit supplied effective tax rate/collection efficiency) without pulling M6 policy dynamics forward, or point the dependency slice to an already-canonical pure query if one exists. Do not invent fiscal behavior inside M3.

2026-09-05 — HANDOFF-REPAIR-001 — RESOLUTION OF HANDOFF-FRESH-001 — REQ-CONFIG-003, REQ-CORE-003

Resolved with the smallest schema repair. CohortSeed now uses the mature PopulationCohort vocabulary directly instead of an implicit translation layer: VULNERABLE / WORKING\_MIDDLE / AFFLUENT strata, explicit laborCategory, and the persistent cohort signal fields healthIndex, prosperityEma, essentialSatisfactionEma, realIncomePerCapitaEma, employmentRateEma, migrationPressureEma, mobilityAccumulator and wageSignal. Seed files must provide these persistent fields explicitly; buildInitialWorld must not translate legacy LOWER/MIDDLE/UPPER labels, rename prosperityIndex, or invent omitted cohort-state defaults. The same correction was applied to the canonical configuration contract and Handoff/03 and recorded in SPEC\_CHANGELOG as HANDOFF-REPAIR-001. No demographic formula, economic mechanism or baseline behavior was redesigned. HANDOFF-FRESH-001 is resolved; findings 002–006 remain open for separate runs.

2026-09-05 — HANDOFF-REPAIR-002 — RESOLUTION OF HANDOFF-FRESH-002 — REQ-CORE-003, REQ-CONFIG-003, REQ-CONFIG-004

Resolved by making direct schema navigation truthful instead of relying on precedence memory. Canonical Core and Handoff/01 now remove RegionState.pendingControllerStateId and RegionState.marketStatus, explicitly point future jurisdiction to PendingTransitions.jurisdictionChanges and market lifecycle to LocalMarketState.status, replace the old PopulationCohort shape with the mature persistent schema, and add ProductionUnit.investmentInventory while removing authoritative capacity from persistent state. Current employment is explicitly ephemeral through LaborSupplyPlan/LaborAllocation/TickContext. Canonical Production and Handoff/05 were reconciled so nameplate capacity is derived from installedCapital × recipe.batchesPerCapitalUnit through deriveNameplateCapacity; a cache, if used, is reconstructable and may never be independently mutated. The master index and consistency review already required these semantics; this repair removes the contradictory stale representations from the documents a stateless implementer actually opens. No economic formula, ownership rule, lifecycle timing or v1 scope changed. HANDOFF-FRESH-002 is resolved; HANDOFF-FRESH-003..006 remain open.  
2026-09-05 — HANDOFF-REPAIR-003 — RESOLUTION OF HANDOFF-FRESH-003 — REQ-CORE-006, REQ-ACCEPTANCE-001  
Resolved as a navigation/dependency defect, not by duplicating numeric policy. REQ-CORE-006 and REQ-ACCEPTANCE-001 now directly depend on REQ-CONFIG-001, which makes Handoff/03 (the owner of SimulationConfig.numeric defaults) reachable within the stateless AUTHOR two-read protocol. Their acceptance now names the resolved SimulationConfig.numeric reconciliation policy and forbids any M2-local epsilon/tolerance. Canonical Migration and Handoff/11 Gate M2 state that reconciliationRelativeTolerance applies where tolerance-based reconciliation is needed; moneyEpsilon and quantityEpsilon remain domain zero/positivity thresholds only where their owning contracts specify them. No numeric value, stock identity or accounting formula changed. HANDOFF-FRESH-003 is resolved; HANDOFF-FRESH-004..006 remain open.

2026-09-05 — HANDOFF-REPAIR-004 — RESOLUTION OF HANDOFF-FRESH-004 — REQ-CORE-006

Resolved by defining observable accounting semantics rather than a new competing ledger architecture. EconomicTransaction remains the business/audit envelope. At M2, reconciliation must expose a deterministic normalized projection of committed stock mutations with typed MONEY and GOOD signed deltas plus PHYSICAL\_LOSS attribution. Each observable delta carries tick/phase, the currencyId or goodId, the authoritative owner/location (including the relevant bucket once a subsystem defines one), a finite signed delta, a stable reason/type and optional causal IDs. A transfer becomes equal-and-opposite deltas for the same stock key; physical loss is an attributed negative physical delta with no balancing goods credit and is never a fee or money sink. Later market/FX/fiscal/event contracts may add richer transaction records, but they must remain losslessly reconcilable to this projection rather than forcing M2 to guess later mechanics.

The deliberate mismatch gate is now equally explicit: tests inject an unmatched synthetic delta into a test-only copy of the normalized ledger (or an exactly equivalent diagnostic fixture), and reconciliation must fail deterministically with stock category/key and residual information. No undocumented production mutation hook is required or allowed. CORE-T17, canonical \+ Handoff Core, canonical \+ Handoff Migration and REQ-CORE-006 acceptance were updated together; SPEC\_CHANGELOG records HANDOFF-REPAIR-004. No economic mechanism, stock identity, phase order or v1 scope changed. HANDOFF-FRESH-004 is resolved; HANDOFF-FRESH-005..006 remain open.  
2026-09-05 — HANDOFF-REPAIR-005 — RESOLUTION OF HANDOFF-FRESH-005 — REQ-MARKET-002, REQ-CONFIG-001  
Resolved by removing duplicate default authority, not by choosing new economics. CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION section 4 remains the sole owner of baseline MarketConfig values. Canonical MARKETS\_TRADE\_FX\_CONTRACTS and Handoff/04 now bind the Phase-6 formula symbols directly to SimulationConfig.markets.shortageSignalWeight, inventorySignalWeight, basePriceAdjustmentSpeed and maxAbsoluteLogPriceMovePerTick instead of publishing the conflicting 0.70/0.30/0.20/ln(1.15) set. The existing config-owned baseline remains unchanged: 0.65/0.35 weights, 0.12 price-adjustment speed and 0.18 maximum absolute log move. No price formula, update timing, price meaning or economic mechanism changed. SPEC\_CHANGELOG records HANDOFF-REPAIR-005. HANDOFF-FRESH-005 is resolved; HANDOFF-FRESH-006 remains open, so M3 requirements stay REVIEW until its separate repair/adjudication run.  
2026-09-05 — HANDOFF-REPAIR-006 — RESOLUTION OF HANDOFF-FRESH-006 — REQ-MARKET-004  
Resolved without moving M6 fiscal behavior into M3. Market settlement now consumes a minimal read-only taxPolicy boundary: getConsumptionTaxRate(stateId, goodCategory) and getCollectionEfficiency(stateId), both using Phase-1 effective jurisdiction. Before M6, deterministic M3 fixtures inject explicit finite values through this provider; these are fixture/scenario inputs, not canonical defaults, and the provider owns no treasury, budget, debt, transfer or policy-update behavior. If Region.controllerStateId is null, State consumption tax is zero. When M6 is implemented, the same reads are backed by canonical FiscalPolicyState so the market algorithm does not change.

The same repair fixed a linked cash-semantics contradiction in Fiscal section 7: assessedTaxPerUnit \= sellerNetPrice \* statutory rate, collectedTaxPerUnit \= assessedTaxPerUnit \* collectionEfficiency, and buyerGrossPrice \= sellerNetPrice \+ collectedTaxPerUnit. Only collected tax is debited/credited; assessed-but-uncollected tax stays with the payer and is telemetry only. getCollectionEfficiency(stateId) was added to the pure law-gate API. MTFX-T4 and REQ-MARKET-004 acceptance now require a fixture with collectionEfficiency strictly between 0 and 1, proving M3 neither assumes 1.0 nor requires M6 dynamics. Canonical \+ Handoff Markets and Fiscal contracts, registry acceptance and SPEC\_CHANGELOG were updated together. HANDOFF-FRESH-006 is resolved. No fiscal policy dynamics, tax rate defaults, market-clearing rule, phase order or v1 scope was expanded.

2026-09-05 — HANDOFF-FRESH-007 — REQ-MARKET-002

Fresh-implementer M3 readiness review found one remaining implementation blocker in Phase-6 pricing. Handoff/04 uses \`targetCoverage\` in the inventory-gap formula but does not bind it to a SimulationConfig or definition field, while Handoff/03 intentionally owns all numeric defaults and currently has no target-coverage field. The same requirement relies on MarketExpectationState, but the handoff does not define deterministic initialization/update equations for expectedUseEma, shortageEma and surplusEma; only expectationAlpha exists in config.

A fresh implementer therefore must choose both the inventory-coverage target and the lagged-expectation semantics, which materially changes price dynamics. Do not promote REQ-MARKET-002 or M3 to READY until a separate repair run assigns targetCoverage to one canonical config/definition owner and specifies exact initialization/update behavior using the existing expectationAlpha, or an equally explicit canonical rule, without adding a parallel market mechanism.

STATUS: OPEN.

2026-09-05 — HANDOFF-REPAIR-007 — resolves HANDOFF-FRESH-007 / REQ-MARKET-002

Resolved the remaining M3 Phase-6 expectation ambiguity. \`SimulationConfig.markets.targetInventoryCoverageTicks\` now owns the inventory-coverage target with canonical baseline 1.0 tick. \`MarketExpectationState\` has an explicit \`observationCount\` bootstrap marker; all expectation fields start at zero; no-information MAIN passes leave the state unchanged; the first informative Phase-8 MAIN observation initializes expected-use/shortage/surplus EMAs directly; later informative observations use \`expectationAlpha\`. Phase-6 uses current effective demand only while no informative observation exists, then uses the lagged \`expectedUseEma\`. Expected use is based on effective demand rather than cleared quantity so rationing does not erase budget-backed unmet use. Phase 4 never updates this expectation state. Added MTFX-T27 and strengthened REQ-MARKET-002 acceptance. No forecasting agent, speculative demand, market-owned inventory, price target, or other new economic mechanism was introduced. M3 remains REVIEW until a separate fresh-implementer readiness pass.

2026-09-05 — M3\_READY\_PROMOTION\_QA\_02 — HANDOFF-FRESH-008  
REQ\_ID: REQ-MARKET-001, REQ-MARKET-003  
Finding: the named M3 registry anchors are not slice-complete under EXECUTION\_ORDER's exact FILE \+ ANCHOR protocol. REQ-MARKET-001 points to Handoff/04 section 5, but its acceptance requires section 6's budget-ledger and planning-envelope rules. REQ-MARKET-003 points to section 10, but its algorithm consumes the exact sellable/effectiveDemand definitions from section 7 and its statement requires MarketAllocation construction whose schema is section 11\. Those required sections are not represented by the current direct dependency rows. A stateless AUTHOR therefore has to search neighboring text and decide which rules belong to the executable unit.  
Disposition: keep all M3 rows in REVIEW. Do not change mechanics in this pass. A separate HANDOFF\_REPAIR\_08 should make the affected registry slices mechanically self-contained, preferably through the smallest navigation/cross-reference repair rather than duplicating economic rules; then rerun M3 readiness promotion.  
STATUS: OPEN.

2026-09-05 — HANDOFF-REPAIR-008 — RESOLUTION OF HANDOFF-FRESH-008 — REQ-MARKET-001, REQ-MARKET-003  
Resolved as a navigation-slice defect only. REQ-MARKET-001 now explicitly states that Handoff/04 sections 5 and 6 form one executable slice: section 5 owns MarketIntent shape/validation and section 6 owns the required budget-ledger/planning-envelope semantics. REQ-MARKET-003 now explicitly states that sections 7, 10 and 11 form its executable slice: section 7 defines sellable\_i/effectiveDemand\_j inputs, section 10 defines deterministic proportional allocation/matching, and section 11 defines the MarketAllocation output schema. Handoff/04 carries matching inline registry-slice notes so a stateless AUTHOR does not have to search neighboring prose or decide what is normative. No market formula, budget rule, clearing rule, schema field, acceptance criterion, dependency ordering or v1 scope changed. HANDOFF-FRESH-008 is resolved. All M3 rows remain REVIEW until a separate fresh-implementer promotion pass.

2026-09-05 — M3\_READY\_PROMOTION\_QA\_03 — HANDOFF-FRESH-009  
REQ\_ID: REQ-MARKET-005, REQ-VISUALIZATION-006  
Finding: the M3 executable telemetry/UI slice still leaves the surplus signal underdefined. Handoff/04 section 33 names \`shortageRate\` and \`unsoldOfferQuantity\`, but does not name or define a telemetry \`surplusRate\`. REQ-MARKET-005 acceptance requires “shortage/surplus signals”, REQ-VISUALIZATION-006 requires the visible M3 preview to show “shortage/surplus”, and Handoff/11 repeats that presentation requirement. Section 9 does compute \`surplusRate \= offeredQuantity \> quantityEpsilon ? unsold / offeredQuantity : 0\` for expectation updates, but section 33 never states whether that exact value is the telemetry/UI signal or whether the preview should derive another measure. A stateless implementer can therefore satisfy the market math while exposing incompatible surplus semantics to diagnostics/UI.  
Disposition: keep all seven M3 rows in REVIEW. Do not change economics in this pass. A separate HANDOFF\_REPAIR\_09 should bind section 33 and the M3 preview to one explicit surplus telemetry field/definition, preferably reusing the existing Section-9 realized MAIN-pass \`surplusRate\` rather than inventing another metric. Visualization share remains 1/7 \= 14.3%, above the \>=5% milestone rule.  
STATUS: OPEN

2026-09-05 — PROTOCOL-UPDATE-001 — mirror/evidence/indexing protocol

To the implementation team:

1\. B1 — CONFIRMED AND APPLIED. Section G now reads docs/spec/implementation\_status.csv instead of IMPLEMENTATION\_STATUS.md. REVIEW/QA runs treat the CSV ledger as the implementation-evidence source; the rendered Markdown is presentation only. Ledger columns are REQ\_ID, STATUS, ISSUE, PR, MERGE\_COMMIT, EVIDENCE. An identifier absent from the ledger has no implementation evidence. PARTIAL is recognized as merged evidence for a named slice without falsely closing the full requirement. FEEDBACK\_TO\_RESEARCHER.md and OPEN\_QUESTIONS.md remain mandatory inputs.

2\. B2 — CONFIRMED AND APPLIED. Every new file entering the implementation package must be recorded in SPEC\_CHANGELOG and accompanied by an explicit ANSWERS\_TO\_IMPLEMENTER request in the form: “please add \<path\> to the mirror allowlist”. Until the repository-side policy change lands, absence of that file from the mirror is expected and is not a synchronization failure. This protocol update adds no new mirrored file, so no allowlist addition is requested by this entry.

3\. B3 — CONFIRMED AND APPLIED. Renaming any file listed in SPEC\_INDEX is a breaking navigation change. Before such a rename, I will announce the exact old→new path in ANSWERS\_TO\_IMPLEMENTER and SPEC\_CHANGELOG; only after that announcement may the source file be renamed. Exported filenames must exactly match mirrored filenames. A blocked sync after an unannounced/suffix-surviving rename is treated as a source-side protocol defect, not something implementation should work around.

4\. C — ACCEPTED for indexing-time granularity. When a future milestone is indexed, acceptance that enumerates independently implementable and independently verifiable artifacts will be split into separate requirement rows unless the artifacts form one genuinely atomic contract. IDs remain permanent: never renumber or reuse them. Existing composite rows such as current M1 config requirements are not silently split retroactively; PARTIAL records their intermediate implementation state honestly. Any later retroactive split requires an explicit registry/changelog change with new IDs. M4 indexing must apply this granularity rule from the start.

5\. B4 — CONFIRMED AS OPERATING ASSUMPTION. docs/spec/mirror/ is write-protected to implementation: only the synchronization workflow writes it. Google Drive is the sole specification-content authority. If the mirror is wrong, report the mismatch back through the established channel; do not patch the mirror directly.

These are process/indexing changes only. They do not alter any economic requirement or transfer specification authority to implementation.  
.  
2026-09-05 — HANDOFF-REPAIR-009 — RESOLUTION OF HANDOFF-FRESH-009 — REQ-MARKET-005, REQ-VISUALIZATION-006  
Resolved with the smallest telemetry/presentation clarification. The existing section-9 realized MAIN-pass ratio is now the only canonical surplus signal: surplusRate \= offeredQuantity \> quantityEpsilon ? unsoldOfferQuantity / offeredQuantity : 0\. Section 33 exposes surplusRate alongside shortageRate and explicitly binds both telemetry ratios to the same realized formulas already used by MarketExpectationState. The M3 Milestone Preview must display the realized Phase-8 MAIN-pass shortageRate and surplusRate and must not derive a second surplus measure. PRE\_PRODUCTION telemetry may use the same ratio definitions where emitted, but it does not update expectations. Canonical and Handoff copies of the Markets and Migration contracts were updated together. No price, clearing, expectation, tax, settlement, default, phase-order, acceptance-threshold or v1-scope mechanic changed. HANDOFF-FRESH-009 is resolved. All seven M3 rows remain REVIEW until a separate fresh-implementer readiness-promotion pass succeeds.  
STATUS: RESOLVED

2026-09-05 — M3\_READY\_PROMOTION\_QA\_04 / CONSISTENCY-SIMPLICITY\_REVIEW — HANDOFF-FRESH-010  
REQ\_ID: REQ-MARKET-002, REQ-CONFIG-001  
Finding: the M3 price-formation slice is internally precise, but Handoff/04 section 42 still presents an authoritative-looking \`MarketConfig\` surface with stale shorthand names: \`priceSpeed\`, \`maxLogPriceStep\`, \`targetInventoryCoverage\`, \`wExcess\`, \`wInventory\`, and plural \`expectation EMA coefficients\`. Handoff/03 is the sole configuration/default owner and instead defines \`basePriceAdjustmentSpeed\`, \`maxAbsoluteLogPriceMovePerTick\`, \`targetInventoryCoverageTicks\`, \`shortageSignalWeight\`, \`inventorySignalWeight\`, and singular \`expectationAlpha\`. Handoff/04 section 9 correctly binds its formula to those exact canonical fields, so section 42 now contradicts the same document's executable slice and can cause a stateless implementer to create duplicate aliases or a second MarketConfig schema.  
Disposition: keep all seven M3 rows in REVIEW. Do not repair the defect in this promotion/consistency pass. A separate HANDOFF\_REPAIR\_10 should make section 42 a non-duplicating reference to the exact canonical SimulationConfig.markets fields (or remove the stale shorthand list), synchronize the canonical Markets working copy, and record the repair without changing any value, formula, timing, or economic behavior. Repository feedback contains no open blocking question for M3, and the authoritative implementation\_status.csv contains no M3 ledger rows, which correctly means no M3 implementation evidence yet and does not override specification readiness. Visualization share remains 1/7 \= 14.3%.  
STATUS: OPEN

2026-09-05 — HANDOFF-REPAIR-010 — RESOLUTION OF HANDOFF-FRESH-010 — REQ-MARKET-002, REQ-CONFIG-001  
Resolved with a schema-ownership/documentation repair only. Section 42 of Handoff/04 and the canonical Markets working copy no longer advertise shorthand MarketConfig aliases. They now point to the exact fields already owned by CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION section 4 and used by section 9: SimulationConfig.markets.basePriceAdjustmentSpeed, maxAbsoluteLogPriceMovePerTick, minimumPrice, maximumPrice, targetInventoryCoverageTicks, shortageSignalWeight, inventorySignalWeight and expectationAlpha. SimulationConfig.numeric.quantityEpsilon and moneyEpsilon remain numeric-domain thresholds and are explicitly not MarketConfig fields. No numeric value, price formula, expectation bootstrap/update behavior, phase timing, acceptance threshold, tax/settlement behavior or v1 scope changed. HANDOFF-FRESH-010 is resolved. All seven M3 rows remain REVIEW until a separate readiness-promotion pass succeeds.  
STATUS: RESOLVED

2026-09-05 — M3\_READY\_PROMOTION\_QA\_05 — M3 promoted to READY

Fresh stateless-implementer readiness review passed for all seven M3 slices: REQ-MARKET-001..005, REQ-ACCEPTANCE-004 and REQ-VISUALIZATION-006. Exact FILE \+ ANCHOR navigation is mechanically reachable; REQ-MARKET-001 explicitly binds Handoff/04 sections 5+6 and REQ-MARKET-003 binds sections 7+10+11. Handoff/03 remains the sole owner of MarketConfig defaults and Handoff/04 sections 9 and 42 use the same exact SimulationConfig.markets field names. Local clearing, settlement, consumption-tax fixture semantics, telemetry shortageRate/surplusRate, MTFX local acceptance and the one-way M3 Pages preview are internally consistent and require no material implementer product/economic choice.

Repository FEEDBACK\_TO\_RESEARCHER and OPEN\_QUESTIONS contain no open M3 blocker, and authoritative docs/spec/implementation\_status.csv contains no M3 evidence rows; this correctly means implementation has not begun and does not block specification readiness. REQUIREMENTS\_REGISTRY now marks all seven M3 rows READY. Visualization allocation remains 1/7 \= 14.3%, above the \>=5% rule. No formula, default, stock ownership, phase order, tax/settlement behavior, acceptance threshold, requirement statement or v1 scope changed in this promotion pass.

STATUS: READY

2026-09-05 — CODE\_RUNTIME\_QA\_M1\_01 — REQ-CONFIG-003 implementation-evidence drift

Observed on current master: PR \#91 (\`7da5650d63fdd1d8349f9c447ad4d7810c2093c4\`) is merged and \`src/config/scenarioDefinition.ts\` now contains concrete field shapes for \`StateSeed\`, \`MonetaryAuthoritySeed\` and \`ClanSeed\`; \`src/config/scenarioSeeds.typecheck.test.ts\` includes compile-time regressions for all three. However, authoritative \`docs/spec/implementation\_status.csv\` still records REQ-CONFIG-003 only against Issue \#77 / PR \#79 and says those three seed shapes are still open. The source file's opening doc comment is stale in the same direction: it still says \`StateSeed\`, \`MonetaryAuthoritySeed\` and \`ClanSeed\` remain empty placeholders even though the interfaces immediately below are concrete.

Disposition: this is an implementation evidence/documentation defect, not a specification defect. Keep REQ-CONFIG-003 \`PARTIAL\` because baseline-multistate-v1 content and other named slices remain unfinished, but reconcile the CSV evidence to include the merged \#91 slice and remove the false “still open” claim for these three types. Also update the stale \`scenarioDefinition.ts\` header comment so it accurately distinguishes the now-concrete top-level seed shapes from the genuinely placeholder nested types (\`StatePolicySeed\`, \`FxPoolSeed\`, \`ClanPreferenceState\`, \`ClanStateRelationSeed\`, plus later bond/event-owned shapes). Do not change any seed field, requirement meaning, economic mechanic or milestone ordering.

STATUS: IMPLEMENTATION\_REPAIR\_REQUESTED  
2026-09-05 — CODE\_RUNTIME\_QA\_M1\_02 — REQ-CONFIG-003 remaining baseline-pack slice is not executable  
REQ\_ID: REQ-CONFIG-003

Observed: the implementation-side repair requested by CODE\_RUNTIME\_QA\_M1\_01 has not landed yet: authoritative docs/spec/implementation\_status.csv remains PARTIAL with only the Issue \#77 / PR \#79 slice, and scenarioDefinition.ts still carries the stale header comment. I did not re-audit that same defect. There is still no open REQ-CONFIG-003 Issue. Separately, the next unfinished slice of REQ-CONFIG-003 is the baseline definition pack plus baseline-multistate-v1 scenario. Handoff/03 requires that scenario to instantiate ProductionUnits spanning the baseline recipes and to carry State/MonetaryAuthority/Clan initialization data, but the named executable slice does not define concrete RecipeDefinition, StatePolicySeed, FxPoolSeed, ClanPreferenceState or ClanStateRelationSeed shapes; BondSeed/InitialEventSeed and later-owned EventDefinition/MetricDefinition are also placeholders. Current master reflects this honestly: definitionPack.ts keeps RecipeDefinition/EventDefinition/MetricDefinition as empty interfaces, and scenarioDefinition.ts keeps the nested policy/FX/clan/bond/event seed types empty rather than guessing.

Finding: under the exact FILE \+ ANCHOR and two-read stateless AUTHOR protocol, the remaining REQ-CONFIG-003 baseline-pack/scenario work is therefore not mechanically executable. Completing it now would require either reading undeclared later subsystem documents beyond the requirement's dependency slice or inventing schema fields that materially determine baseline world construction. REQ-CONFIG-004 cannot safely start before this composite requirement is closed, and REQ-VISUALIZATION-004 remains downstream of REQ-CONFIG-004.

Disposition: keep the specification row REQ-CONFIG-003 READY and the implementation ledger status PARTIAL. Do not start REQ-CONFIG-004 from this state. A separate HANDOFF\_REPAIR\_11 should make only the M1 initialization schemas needed to author the baseline pack/scenario mechanically reachable or self-contained under the stateless navigation protocol, using the existing canonical subsystem contracts as authority and without pulling later dynamic subsystem behavior into M1. This QA pass changes no requirement meaning, economic formula, default, stock ownership, phase order, acceptance threshold or v1 scope. No new file is added and no mirror-allowlist request is needed.

STATUS: OPEN — SPEC\_NAVIGATION\_REPAIR\_REQUIRED  
2026-09-05 — HANDOFF-REPAIR-011 — RESOLUTION OF CODE\_RUNTIME\_QA\_M1\_02 — REQ-CONFIG-003  
Resolved the remaining M1 baseline-pack/scenario navigation blocker without pulling later subsystem behavior forward. CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION and Handoff/03 now contain an explicit M1 executable initialization boundary. RecipeDefinition is concretized there using exactly the immutable definition-data fields already owned by PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS. FxPoolSeed is concretized as the opening-stock projection of the canonical FX-pool state: stable pair key, base/quote currency keys, explicit pool cash, spot rate, reserve target/floors, spread, zero-baseline flow-pressure EMA and max next-tick rate move. Each pair exists once under the authority issuing its configured base currency, and pool cash is included once in WorldGenesisLedger money reconciliation.

Later-owned StatePolicySeed, ClanPreferenceState, ClanStateRelationSeed, BondSeed, InitialEventSeed, EventDefinition and MetricDefinition are now explicitly staged rather than left ambiguous. In baseline-multistate-v1 at M1, State policy and Clan preference payloads are intentional opaque empty objects, initialRelations/bonds/initialEvents may be empty or omitted, and eventDefinitions/metricDefinitions may be empty with no M1 references to absent IDs. M1 code must not interpret these placeholders. Their owning milestone must install the canonical subsystem schema before activating the behavior, and any material ScenarioDefinition/DefinitionPack content change advances the corresponding version so content hashes and runIdentity remain truthful.

REQ-CONFIG-003 acceptance was strengthened to expose this milestone boundary. The specification row remains READY and implementation evidence remains PARTIAL until repository code/data satisfies the full composite requirement. REQ-CONFIG-004 remains downstream, but the spec no longer requires an AUTHOR to invent later fiscal/clan/event/metric mechanics to finish the M1 baseline data slice. No economic formula, numeric default, stock ownership, phase order, tax/FX settlement behavior, acceptance threshold, or v1 scope changed. No new implementation-package file was added; no mirror allowlist request is required.  
STATUS: RESOLVED

2026-09-05 — CODE\_RUNTIME\_QA\_M1\_03 — Issue \#135 REQ-CONFIG-004 task-contract correction

Observed: HANDOFF\_REPAIR\_11 has reached the repository mirror and Handoff/03 now exposes the M1 RecipeDefinition/FxPoolSeed initialization boundary. The authoritative implementation\_status.csv nevertheless still marks REQ-CONFIG-003 PARTIAL and has no REQ-CONFIG-004 evidence row. Issue \#135 was opened as status:ready for REQ-CONFIG-004 while explicitly acknowledging the PARTIAL dependency, and its Scope item 2 says WorldGenesisLedger entries themselves should sum to zero.

Finding: these are two linked implementation-task defects, not specification defects. REQ-CONFIG-004 depends on REQ-CONFIG-003 and therefore must not be claimed until the authoritative ledger records REQ-CONFIG-003 as IMPLEMENTED. Separately, Handoff/03 section 20 defines genesis records as opening endowments recorded outside normal EconomicTransaction history; they reconcile source endowments against resulting tick-0 authoritative stocks. They are not equal-and-opposite transaction deltas and must not themselves net to zero.

Action: posted the correction directly on Issue \#135 (comment 5552011163). Replace the zero-sum criterion with source-endowment \-\> tick-0 reconciliation for money, goods, population, capital and resources; diagnostics should name stock category/key, expected genesis total, actual tick-0 total and residual. Keep WorldGenesisLedger separate from normal tick transaction history. Do not claim Issue \#135 while REQ-CONFIG-003 remains PARTIAL. The separate CODE\_RUNTIME\_QA\_M1\_01 PR \#91 ledger/header cleanup remains implementation evidence debt and was not combined into this unit.

No specification requirement meaning, economic formula, stock ownership, phase order, tolerance, milestone ordering or v1 scope changed.

STATUS: IMPLEMENTATION\_TASK\_REPAIR\_REQUESTED

2026-09-05 — CODE\_RUNTIME\_QA\_M1\_05 — REQ-CONFIG-003 implementation-queue liveness gap

Observed: HANDOFF-REPAIR-011 is already present in the repository mirror and the authoritative Drive registry keeps REQ-CONFIG-003 READY with an M1-complete initialization boundary for RecipeDefinition, FxPoolSeed and the intentionally inactive later-owned placeholders. However, docs/spec/implementation\_status.csv still records REQ-CONFIG-003 as PARTIAL on the old Issue \#77 / PR \#79 slice, current source still leaves RecipeDefinition and FxPoolSeed as empty placeholders, and there is no open implementation Issue for the remaining REQ-CONFIG-003 baseline definition-pack / baseline-multistate-v1 work. The only open M1 config Issue found is downstream REQ-CONFIG-004 \#135, which still carries status:ready even though its dependency is not IMPLEMENTED.

Finding: this is an implementation queue-liveness / milestone-order defect, distinct from the already-reported \#135 zero-sum semantics defect. The specification is now executable, but the repository has no correctly selectable upstream work item that can advance the earliest incomplete requirement. A stateless AUTHOR selecting status:ready work can therefore be steered to blocked CONFIG-004 while CONFIG-003 has no runnable task at all.

Requested implementation action: create or restore one bounded REQ-CONFIG-003 work item before REQ-CONFIG-004 is claimable. Its scope should implement the current mirrored M1 initialization boundary (at minimum concrete RecipeDefinition and FxPoolSeed), author the deterministic baseline definition pack / baseline-multistate-v1 data required by REQ-CONFIG-003, add proving type/content/determinism tests, and reconcile implementation\_status.csv as PARTIAL or IMPLEMENTED according to what actually merges. Do not pull later fiscal/clan/event/metric behavior into M1. Issue \#135 should not remain selectable as ready until REQ-CONFIG-003 is IMPLEMENTED. The separate PR \#91 evidence/header debt remains outstanding and is not re-audited here.

No specification, requirement meaning, economic mechanism, formula, default, stock ownership, phase order, acceptance threshold or v1 scope changed.

STATUS: IMPLEMENTATION\_QUEUE\_REPAIR\_REQUESTED

2026-09-05 — CODE\_RUNTIME\_QA\_M1\_06 — Issue \#138 crosses REQ-CONFIG-003/004 boundary

Observed: the implementation queue-liveness gap from CODE\_RUNTIME\_QA\_M1\_05 has changed state: Issue \#138 now exists and is correctly titled for REQ-CONFIG-003. However, its scope also includes buildInitialWorld(), WorldGenesisLedger, opening-stock reconciliation, and M1 initialization invariants, while the canonical registry assigns WorldGenesisLedger/opening-stock reconciliation to the separate downstream REQ-CONFIG-004 row, which explicitly depends on REQ-CONFIG-003.

Finding: this is an implementation task-boundary / milestone-order defect. Existing composite REQ-CONFIG-003 must remain stable, but implementation must not absorb the independently indexed REQ-CONFIG-004 acceptance into it. Doing so would let \#138 claim CONFIG-003 while simultaneously implementing downstream behavior before the authoritative ledger closes its dependency, and would make evidence ownership ambiguous.

Action: posted correction comment 5552649110 on Issue \#138. Keep \#138 bounded to the baseline definition pack, baseline-multistate-v1, the current M1 RecipeDefinition/FxPoolSeed initialization data, and proving CONFIG-003 content/determinism tests. WorldGenesisLedger and opening-stock reconciliation belong to REQ-CONFIG-004 after CONFIG-003 becomes IMPLEMENTED. buildInitialWorld() may appear in \#138 only as the minimum construction/validation path needed for CONFIG-003; it must not prematurely claim CONFIG-004 reconciliation semantics. Also do not use the stale remaining-work prose in implementation\_status.csv as specification scope: the ledger still omits merged PR \#91 and falsely lists StateSeed, MonetaryAuthoritySeed and ClanSeed as open.

No specification requirement, economic mechanism, formula, default, stock ownership, phase order, acceptance threshold or v1 scope changed.

STATUS: IMPLEMENTATION\_TASK\_REPAIR\_REQUESTED

2026-09-05 — CONSISTENCY\_SIMPLICITY\_REVIEW\_M1\_01 — permanent-ID/task-boundary correction

Cross-document M1 review confirms the Drive registry/handoff ownership is internally consistent: existing composite REQ-CONFIG-003 remains one permanent requirement with PARTIAL implementation evidence until all of its own acceptance is merged; REQ-CONFIG-004 separately owns WorldGenesisLedger/opening-stock reconciliation and depends on CONFIG-003. No Drive specification contradiction was found.

New implementation-process finding: Issue \#138's AUTHOR BLOCKED assessment correctly says the task is too large for one bounded run, but its proposed split invents pseudo requirement identifiers \`REQ-CONFIG-003a\` through \`REQ-CONFIG-003e\`, which violates the permanent-ID protocol. It also proposes a CONFIG-003c WorldGenesisLedger/reconciliation slice that belongs to REQ-CONFIG-004, repeating the requirement-boundary error already identified in R89.

Action: posted correction comment 5552996009 on Issue \#138. Split the implementation work into several ordinary Issues if needed, but every upstream slice must reference the same permanent \`REQ-CONFIG-003\` identifier and accumulate PARTIAL evidence until the composite row is complete. Do not create suffix requirement IDs. Keep WorldGenesisLedger/opening-stock reconciliation entirely under downstream \`REQ-CONFIG-004\` / Issue \#135 after CONFIG-003 is IMPLEMENTED. No registry row, formula, economic mechanism, acceptance meaning, or v1 scope changed.

STATUS: IMPLEMENTATION\_PROCESS\_REPAIR\_REQUESTED

2026-09-05 — CODE\_RUNTIME\_QA\_M1\_07 — PR \#156 RecipeDefinition validation acceptance blocker

REQ\_ID: REQ-CONFIG-003

Observed: repository state changed after R90. Issue \#154 / PR \#156 is now a bounded RecipeDefinition slice and the PR body correctly leaves WorldGenesisLedger/opening-stock reconciliation under downstream REQ-CONFIG-004. However, the AUTHOR handoff and PR explicitly defer RecipeDefinition numeric validation to a later validation layer or world-gen slice. Handoff/03 section 16A is explicit that M1 authors and validates immutable recipe data and names the required constraints: positive output and batches-per-capital-unit; non-negative input, labor and startup-capital quantities; minimumInfrastructureFactor in \[0,1\] where present; positive extractedResourcePerBatch when extractionResourceId is present; positive baseThroughputFactor; depreciationRatePerTick in \[0,1).

Finding: PR \#156 is not acceptance-complete for this RecipeDefinition slice as currently claimed. The diff adds the readonly field shape and valid fixtures/tests, but no executable negative validation proving the section-16A bounds are rejected. The current “immutability” test is also vacuous: it checks that a mutation callback is defined rather than proving that mutation throws or leaves canonical definition data unchanged.

Requested implementation action: before accepting/merging this slice, implement or invoke M1 RecipeDefinition validation at the config/world-gen validation boundary (exact code location is an engineering detail) for every named section-16A constraint, with negative tests and useful diagnostics. Do not defer these constraints to a later milestone. Replace the vacuous immutability assertion with a real proof consistent with the repository’s chosen immutable-definition boundary. Keep the work under permanent REQ-CONFIG-003 and keep REQ-CONFIG-003 PARTIAL unless the full composite requirement is actually satisfied. Do not add CONFIG-004 behavior. The PR’s pseudo-ID wording and the stale PR \#91 ledger/header evidence debt are existing R90/R83 findings and are not re-counted here.

No specification requirement, economic mechanism, formula, default, stock ownership, phase order, acceptance threshold or v1 scope changed.

STATUS: IMPLEMENTATION\_REPAIR\_REQUESTED

2026-09-05 — HANDOFF-REPAIR-012 — REQ-CONFIG-003 / REQ-CONFIG-004

Fresh Issue \#157 exposed a real specification boundary contradiction. The registry makes REQ-CONFIG-004 depend on a completed REQ-CONFIG-003 and assigns WorldGenesisLedger/opening-stock reconciliation to CONFIG-004, but Handoff/03 section 19 still said that exact REQ-CONFIG-003 buildInitialWorld step 16 must “Create WorldGenesisLedger”. That made the downstream dependency cyclic even though \#157 correctly treated ledger/reconciliation as a non-goal.

Resolved in Drive with the smallest ownership repair. REQ-CONFIG-003 buildInitialWorld now constructs the deterministic tick-0 world, normalizes sparse maps and runs only initialization invariants that do not require WorldGenesisLedger/opening-stock reconciliation. REQ-CONFIG-004 immediately follows by creating WorldGenesisLedger and reconciling opening endowments against that constructed state before the M1 gate can close. Section 20, the genesis-reconciliation validation rule, ledger-dependent invariants 12/18 and the genesis money/good reconciliation tests are explicitly owned by CONFIG-004. Existing opening-endowment semantics, diagnostics, tolerance and accounting identities are unchanged.

Implementation guidance: once this revision reaches the mirror, Issue \#157 may implement the repaired CONFIG-003 constructor order but must not create or claim WorldGenesisLedger/reconciliation. CONFIG-004 remains downstream. PR \#156 still has the separate R91 RecipeDefinition validation/immutability blocker unless that PR changes; the older pseudo-ID, \#135 task wording and PR \#91 evidence/header debts were not re-audited as new findings in this run.

STATUS: RESOLVED — SPEC\_BOUNDARY\_REPAIR

2026-09-05 — CODE\_RUNTIME\_QA\_M1\_09 — post-merge REQ-CONFIG-003 evidence-ledger reconciliation

REQ\_ID: REQ-CONFIG-003

Observed: PR \#156 is now merged, so the authoritative implementation\_status.csv legitimately remains PARTIAL and now records the RecipeDefinition schema/fixture slice. HANDOFF-REPAIR-012 is also present in the repository mirror: current Handoff/03 explicitly assigns WorldGenesisLedger/opening-stock reconciliation to downstream REQ-CONFIG-004, not to CONFIG-003. However, the newly written CONFIG-003 ledger row still says that WorldGenesisLedger opening-stock reconciliation remains open under CONFIG-003; it also describes Issue \#154 as “REQ-CONFIG-003a”, despite the permanent-ID rule, and repeats the already-known false claim that StateSeed, MonetaryAuthoritySeed and ClanSeed remain open even though merged PR \#91 made those top-level shapes concrete.

Finding: this is a repository implementation-evidence defect after a real state change, not a specification defect. Keep REQ-CONFIG-003 PARTIAL, but reconcile its ledger evidence to the permanent REQ-CONFIG-003 identifier only; include merged PR \#91 and PR \#156 evidence accurately; remove StateSeed/MonetaryAuthoritySeed/ClanSeed from remaining work; and remove WorldGenesisLedger/opening-stock reconciliation from CONFIG-003 remaining work because HANDOFF-REPAIR-012 assigns that behavior to REQ-CONFIG-004. Remaining CONFIG-003 work should reflect only work actually owned by the current CONFIG-003 contract, such as FxPoolSeed integration, baseline-multistate-v1 content, buildInitialWorld() construction, and any still-unproved CONFIG-003 validation/determinism acceptance.

PR \#156's separate RecipeDefinition validation/immutability blocker from CODE\_RUNTIME\_QA\_M1\_07 remains outstanding: the merged PR body still explicitly defers the numeric validation required by Handoff/03 §16A. Do not treat merge alone as proof that those acceptance clauses are satisfied. This run does not reopen or re-count that blocker; it only repairs the new authoritative ledger wording/evidence state created by the merge.

No Drive specification, requirement meaning, economic mechanism, formula, default, stock ownership, phase order, acceptance threshold or v1 scope changed.

STATUS: IMPLEMENTATION\_EVIDENCE\_REPAIR\_REQUESTED  
2026-09-05 — CODE\_RUNTIME\_QA\_M1\_10 — PR \#163 LocalMarket identity defect  
REQ\_ID: REQ-CONFIG-003  
Observed: PR \#163 implements the repaired CONFIG-003 buildInitialWorld slice and correctly keeps WorldGenesisLedger/opening-stock reconciliation downstream. However, src/simulation/worldState.ts constructs marketRegistry with the correct allocated MarketId as the Map key while buildLocalMarketState() returns LocalMarketState.marketId \= undefined as unknown as MarketId. The accompanying tests never assert that each registry value carries the same MarketId as its registry key.  
Finding: this is a runtime identity/invariant defect. Canonical entity identity requires registry entries to be keyed by their own persistent ID; returning an undefined embedded marketId creates a split identity that can break later references, diagnostics, lifecycle records and M1 visualization even though marketRegistry.size and Map lookup still appear valid.  
Requested implementation action: before PR \#163 merges, pass the allocated MarketId into buildLocalMarketState (or construct the state with that exact ID), add a test asserting key \=== value.marketId for every market, and include that condition in initialization invariants. Do not change market economics, lifecycle semantics, CONFIG-004 ownership or requirement meaning. The separate R91 RecipeDefinition validation blocker and R93 evidence-ledger cleanup remain outstanding and are not re-counted here.  
No Drive specification, formula, default, stock ownership, phase order, acceptance threshold or v1 scope changed.  
STATUS: IMPLEMENTATION\_REPAIR\_REQUESTE  
2026-09-05 — CODE\_RUNTIME\_QA\_M1\_11 — post-merge PR \#163 LocalMarket identity failure  
REQ\_ID: REQ-CONFIG-003  
Observed: PR \#163 has now merged, so repository state changed after R94, but current master still constructs \`marketRegistry\` with the allocated \`MarketId\` as the Map key while \`buildLocalMarketState()\` stores \`marketId: undefined as unknown as MarketId\` in the \`LocalMarketState\` value. \`validateInitializationInvariants()\` checks Region→State and State→Currency references only; it does not validate registry key/value identity. \`worldState.test.ts\` also supplies no MarketSeed and contains no market identity assertion, so the defect survives all claimed 181 tests and the step-16 invariant evidence.  
Finding: this is now a post-merge implementation-conformance failure, not merely a pre-merge review note. PR \#163 remains useful PARTIAL evidence for deterministic world construction, but its claim that the CONFIG-003 initialization invariants are satisfied is overstated until the embedded persistent ID is repaired and proved.  
Requested implementation action: create a minimal follow-up under permanent \`REQ-CONFIG-003\`. Pass the allocated \`MarketId\` into \`buildLocalMarketState\`, store exactly that ID in \`LocalMarketState.marketId\`, add at least one MarketSeed fixture and assert every \`worldState.markets\` entry satisfies \`registryKey \=== market.marketId\`, and enforce the same condition in initialization invariants. Keep WorldGenesisLedger/opening-stock reconciliation under REQ-CONFIG-004. After the fix merges, update authoritative \`implementation\_status.csv\` evidence so PR \#163 is not presented as proving an invariant it currently misses. Posted the same correction on merged PR \#163 as comment 5554742442\.  
No Drive specification, market economic behavior, formula, default, stock ownership, phase order, acceptance threshold or v1 scope changed.  
STATUS: POST\_MERGE\_IMPLEMENTATION\_REPAIR\_REQUESTED  
D

2026-09-06 — CONSISTENCY\_SIMPLICITY\_REVIEW\_M1\_02 — false CONFIG-003 completion gate  
REQ\_ID: REQ-CONFIG-003, downstream REQ-CONFIG-004 / REQ-VISUALIZATION-004

Observed: authoritative docs/spec/implementation\_status.csv was promoted by merged PR \#173 from REQ-CONFIG-003 PARTIAL to IMPLEMENTED, and new Issue \#175 therefore treats CONFIG-004 as unblocked. PR \#173 completes FxPoolSeed and baseline-multistate-v1 data, but its changed implementation artifacts do not include the RecipeDefinition validation path. Current master src/config/definitionPack.ts still documents the exact Handoff/03 §16A validation requirements, while src/config/validation.ts validates ScenarioDefinition seed content only and contains no RecipeDefinition / DefinitionPack validation for the required positive, non-negative, \[0,1\], extraction, throughput and depreciation constraints.

Finding: CONFIG-003 is not acceptance-complete despite the ledger promotion. This is an implementation-evidence/gate consistency defect, not a specification defect. The previously reported R91 RecipeDefinition validation blocker remains live and is sufficient by itself to invalidate IMPLEMENTED. The R95 LocalMarket embedded-ID invariant remains a second known CONFIG-003 gate unless a separate proving follow-up has landed; PR \#173 itself does not repair that world-construction path.

Requested implementation action: reconcile authoritative implementation\_status.csv back from IMPLEMENTED to PARTIAL or CONTESTED according to repository evidence policy until the missing CONFIG-003 acceptance is merged and proved. Add executable RecipeDefinition validation for every Handoff/03 §16A bound with negative tests/useful diagnostics, then only re-promote after all remaining CONFIG-003 invariants are genuinely satisfied. Downstream REQ-CONFIG-004 and REQ-VISUALIZATION-004 must remain non-selectable while CONFIG-003 is not validly IMPLEMENTED. Posted the same gate correction on Issue \#175 as comment 5555061652\. Do not change CONFIG-004 ledger semantics, any economic formula/default, stock ownership, phase order, acceptance threshold or v1 scope.

STATUS: IMPLEMENTATION\_GATE\_REPAIR\_REQUESTED  
