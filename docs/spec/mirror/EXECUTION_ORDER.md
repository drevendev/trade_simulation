# EXECUTION\_ORDER

Status: FROZEN  
Version: 1  
Updated: 2026-09-03

Rule: AUTHOR takes exactly one bounded unit from the earliest milestone whose dependencies and requirement statuses are satisfied. Only READY/FROZEN requirements are executable. A failed gate blocks promotion. Do not skip ahead because a later task looks easier.

## Dependency order

M0 Baseline lock/scaffolding — executable now. Depends only on existing repository and REQ-MIGRATION-001..004.  
M1 Canonical primitives/config/world genesis — after M0 gate. Read 00, 01, 02, 03 and M1 rows in REQUIREMENTS\_REGISTRY.  
M2 Tick/ledger spine — after M1 gate. Read 01, 02, 11 and M2 rows.  
M3 Local markets — after M2. Read 04 plus relevant config/acceptance rows.  
M4 Production/labor/population closed economy — after M3. Read 05, 06 plus relevant config/acceptance rows.  
M5 Transport/trade/FX — after M4. Read 04 and 08 interfaces plus relevant rows.  
M6 Fiscal/laws/clans/debt — after M5. Read 06, 07 plus relevant monetary debt interfaces.  
M7 Monetary/currency — after M6. Read 08\.  
M8 Demography/migration/expansion/succession — after M7. Read 06, 09\.  
M9 Events/shocks — after M8. Read 10\.  
M10 Whole-system acceptance/performance — after M9. Read 12 and all failing requirement evidence.  
M11 Browser/GitHub Pages observatory — after M10 simulation gate. Read 13, M11 section of 11 and relevant 12 gates.  
M12 Legacy removal/release candidate — after M11. Remove legacy responsibility only when canonical implementation and replacement tests prove coverage.

## First executable work

Start with M0. Do not wait for the registry to enumerate later milestone internals before beginning M0. The registry is bootstrapped with all M0-M2 requirements needed to reach the first canonical runnable spine. Before promoting into M3, the researcher/QA side must extend the registry with M3-specific rows and record that extension in SPEC\_CHANGELOG.

## Per-run AUTHOR protocol

1\. Read repository docs/spec/IMPLEMENTATION\_STATUS.md, FEEDBACK\_TO\_RESEARCHER.md and OPEN\_QUESTIONS.md.  
2\. Read REQUIREMENTS\_REGISTRY.csv and select one READY/FROZEN requirement in the earliest unblocked milestone.  
3\. Open the exact FILE \+ ANCHOR named by that row. Read at most one directly listed dependency document unless the requirement itself says otherwise.  
4\. Implement one bounded change, add/adjust proving tests, run the relevant suite and open a PR. Do not merge.  
5\. Update IMPLEMENTATION\_STATUS.md in the same PR with evidence. If blocked by the specification, append to OPEN\_QUESTIONS.md or FEEDBACK\_TO\_RESEARCHER.md instead of guessing.

## Per-run ACCEPTOR protocol

Review one PR against its REQ\_ID, acceptance criterion, canonical contract and tests. Merge only when the requirement is met and the build/tests are green. The acceptor may reject or request changes but does not author product code.  
