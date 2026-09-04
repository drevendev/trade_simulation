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

