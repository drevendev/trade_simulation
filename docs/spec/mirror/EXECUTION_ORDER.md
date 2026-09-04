# EXECUTION\_ORDER

Status: FROZEN  
Version: 3  
Updated: 2026-09-05

Rule: AUTHOR takes exactly one bounded unit from the earliest milestone whose dependencies and requirement statuses are satisfied. Only READY/FROZEN requirements are executable. A failed gate blocks promotion. Do not skip ahead because a later task looks easier. Every M0–M12 must also satisfy the cross-cutting visibility rule from Handoff/11: at least 5% of planned implementation units, rounded up with a minimum of one, are user-visible GitHub Pages visualization/presentation units.

## Dependency order

M0 Baseline lock/scaffolding — executable now. Complete REQ-MIGRATION-001..004, then REQ-VISUALIZATION-003 publishes the visible M0 Milestone Preview once its baseline/scaffolding dependencies are satisfied.  
M1 Canonical primitives/config/world genesis — after M0 gate. Read 00, 01, 02, 03 and M1 rows in REQUIREMENTS\_REGISTRY; REQ-VISUALIZATION-004 is the required world-gen Milestone Preview.  
M2 Tick/ledger spine — after M1 gate. Read 01, 02, 11 and M2 rows; REQ-VISUALIZATION-005 is the required phase/ledger Milestone Preview.  
M3 Local markets — indexed proactively as REQ-MARKET-001..005, REQ-ACCEPTANCE-004 and REQ-VISUALIZATION-006. After M2, read Handoff/04 plus the listed dependencies. These M3 rows are currently REVIEW, not executable, until the fresh-implementer handoff findings affecting their slices are adjudicated in separate repair runs and the rows are explicitly promoted to READY/FROZEN.  
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

M0-M2 remain governed by their existing executable rows. M3 is now pre-indexed as REQ-MARKET-001..005, REQ-ACCEPTANCE-004 and REQ-VISUALIZATION-006; its seven planned requirement-sized units include one user-visible Pages unit (1/7, above the \>=5% minimum). M3 rows remain REVIEW until their fresh-implementer handoff findings are resolved in separate repair runs and they are explicitly promoted. Before promoting into M4, the researcher/QA side must extend the registry with M4-specific rows and enough VISUALIZATION work to preserve the \>=5% share. Apply the same rule to every later milestone promotion.

## Per-run AUTHOR protocol

1\. Read repository docs/spec/IMPLEMENTATION\_STATUS.md, FEEDBACK\_TO\_RESEARCHER.md and OPEN\_QUESTIONS.md.  
2\. Read REQUIREMENTS\_REGISTRY.csv and select one READY/FROZEN requirement in the earliest unblocked milestone.  
3\. Open the exact FILE \+ ANCHOR named by that row. Read at most one directly listed dependency document unless the requirement itself says otherwise.  
4\. Implement one bounded change, add/adjust proving tests, run the relevant suite and open a PR. Do not merge.  
5\. Update IMPLEMENTATION\_STATUS.md in the same PR with evidence. If blocked by the specification, append to OPEN\_QUESTIONS.md or FEEDBACK\_TO\_RESEARCHER.md instead of guessing.

## Per-run ACCEPTOR protocol

Review one PR against its REQ\_ID, acceptance criterion, canonical contract and tests. Merge only when the requirement is met and the build/tests are green. The acceptor may reject or request changes but does not author product code.  
