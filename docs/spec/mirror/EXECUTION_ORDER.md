# EXECUTION\_ORDER

Status: FROZEN  
Version: 5  
Updated: 2026-09-10

Rule: AUTHOR takes exactly one bounded unit from the earliest milestone whose dependencies and requirement statuses are satisfied. Only READY/FROZEN requirements are executable. A failed gate blocks promotion. Do not skip ahead because a later task looks easier. The baseline cross-cutting visibility rule remains at least 5% per milestone. OWNER OVERRIDE 2026-09-10: M3 has a hard \>=30% representation/documentation allocation and may not close until REQ-VISUALIZATION-006, REQ-VISUALIZATION-007 and REQ-VISUALIZATION-008 are all IMPLEMENTED.

## Dependency order

M0 Baseline lock/scaffolding — executable now. Complete REQ-MIGRATION-001..004, then REQ-VISUALIZATION-003 publishes the visible M0 Milestone Preview once its baseline/scaffolding dependencies are satisfied.  
M1 Canonical primitives/config/world genesis — after M0 gate. Read 00, 01, 02, 03 and M1 rows in REQUIREMENTS\_REGISTRY; REQ-VISUALIZATION-004 is the required world-gen Milestone Preview.  
M2 Tick/ledger spine — after M1 gate. Read 01, 02, 11 and M2 rows; REQ-VISUALIZATION-005 is the required phase/ledger Milestone Preview.  
M3 Local markets — indexed as nine permanent rows: REQ-MARKET-001..005, REQ-ACCEPTANCE-004 and REQ-VISUALIZATION-006..008. After M2, read Handoff/04 plus the listed dependencies and Handoff/11 for the representation package. All nine registry rows are READY; implementation selection still respects each row's declared dependencies. REQ-VISUALIZATION-007/008 may proceed while market correctness repairs continue. REQ-VISUALIZATION-006 remains dependent on the completed M3 telemetry/acceptance surface. M3 is not complete until all three representation rows are IMPLEMENTED.  
M4 Production/labor/population closed economy — indexed as fifteen permanent rows: REQ-CONFIG-006..007, REQ-PRODUCTION-001..008, REQ-POPULATION-001..003, REQ-ACCEPTANCE-005 and REQ-VISUALIZATION-009. Read Handoff/05 and 06 plus Handoff/11 for the integrated gate/preview. All M4 rows are READY in the registry but remain non-executable until the complete M3 gate passes. M4 deliberately stops at the one-region closed economy: no M5 trade/FX, no M6 institutional Clan/fiscal dynamics and no M8 demography/migration.  
M5 Transport/trade/FX — after M4. Read 04 and 08 interfaces plus relevant rows.  
M6 Fiscal/laws/clans/debt — after M5. Read 06, 07 plus relevant monetary debt interfaces.  
M7 Monetary/currency — after M6. Read 08\.  
M8 Demography/migration/expansion/succession — after M7. Read 06, 09\.  
M9 Events/shocks — after M8. Read 10\.  
M10 Whole-system acceptance/performance — after M9. Read 12 and all failing requirement evidence.  
M11 Browser/GitHub Pages observatory — after M10 simulation gate. Read 13, M11 section of 11 and relevant 12 gates.  
M12 Legacy removal/release candidate — after M11. Remove legacy responsibility only when canonical implementation and replacement tests prove coverage.

## First executable work

M0-M2 remain governed by their existing executable rows. M3 is indexed as nine permanent requirement-sized units: REQ-MARKET-001..005, REQ-ACCEPTANCE-004 and REQ-VISUALIZATION-006..008. The three representation/documentation rows are 3/9 \= 33.3%, satisfying the owner's \>=30% M3 focus requirement. Treat them as first-class completion work: polished Pages, current README/public texts, and at least two public explainers. M4 is now pre-indexed as fifteen bounded READY rows so the AUTHOR queue can transition without an indexing gap once M3 closes: two config, eight production, three population, one integrated acceptance and one Pages-preview row. The M4 visualization share is 1/15 \= 6.7%, above the baseline \>=5% rule. M4 rows remain blocked by milestone order until all nine M3 rows have truthful closing evidence. Before promoting into M5, the researcher/QA side must index M5-specific rows.

## Per-run AUTHOR protocol

1\. Read repository docs/spec/implementation\_status.csv, FEEDBACK\_TO\_RESEARCHER.md and OPEN\_QUESTIONS.md. The CSV is the authoritative implementation-evidence ledger; rendered IMPLEMENTATION\_STATUS.md is presentation only.  
2\. Read REQUIREMENTS\_REGISTRY.csv and select one READY/FROZEN requirement in the earliest unblocked milestone.  
3\. Open the exact FILE \+ ANCHOR named by that row. Read at most one directly listed dependency document unless the requirement itself says otherwise.  
4\. Implement one bounded change, add/adjust proving tests, run the relevant suite and open a PR. Do not merge.  
5\. Update docs/spec/implementation\_status.csv truthfully in the PR according to the evidence protocol and regenerate rendered IMPLEMENTATION\_STATUS.md. If blocked by the specification, append to OPEN\_QUESTIONS.md or FEEDBACK\_TO\_RESEARCHER.md instead of guessing.

## Per-run ACCEPTOR protocol

Review one PR against its REQ\_ID, acceptance criterion, canonical contract and tests. Merge only when the requirement is met and the build/tests are green. The acceptor may reject or request changes but does not author product code.  
