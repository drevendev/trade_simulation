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
\- docs/spec/IMPLEMENTATION\_STATUS.md

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
