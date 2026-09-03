# SPEC\_INDEX

Status: FROZEN navigation index for the implementation mirror.  
Version: 1  
Updated: 2026-09-03

The public implementation mirror should contain only the files listed here plus the four root control files and ANSWERS\_TO\_IMPLEMENTER.md. The rest of Drive is research/history and is not implementation authority.

| FILE | DOMAIN | PURPOSE | STATUS | VERSION | UPDATED | DEPENDS\_ON |  
| \--- | \--- | \--- | \--- | \--- | \--- | \--- |  
| 06 \- Handoff/START\_HERE — Economic Simulation Implementation Handoff.md | SCOPE | Entry point, authority rules, product boundary and reading order | FROZEN | 1 | 2026-09-03 | — |  
| 06 \- Handoff/00 — MASTER\_IMPLEMENTATION\_INDEX.md | SCOPE | Conflict precedence, schema normalizations and execution authority | FROZEN | 1 | 2026-09-03 | START\_HERE |  
| 06 \- Handoff/01 — CORE\_SCHEMA\_AND\_LIFECYCLES.md | CORE | IDs, registries, stocks, lifecycle, TickContext and canonical tick | FROZEN | 1 | 2026-09-03 | 00 |  
| 06 \- Handoff/02 — IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01.md | CORE | Mandatory cross-contract normalizations | FROZEN | 1 | 2026-09-03 | 00,01 |  
| 06 \- Handoff/03 — CANONICAL\_CONFIG\_AND\_WORLD\_GENERATION.md | CONFIG | Config ownership, defaults, scenarios, world genesis and validation | FROZEN | 1 | 2026-09-03 | 01,02 |  
| 06 \- Handoff/04 — MARKETS\_TRADE\_FX\_CONTRACTS.md | MARKET | Market intents, clearing, trade, shipments, taxes/fees and FX settlement | FROZEN | 1 | 2026-09-03 | 01-03 |  
| 06 \- Handoff/05 — PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS.md | PRODUCTION | Production units, labor, inventories, capital and extraction | FROZEN | 1 | 2026-09-03 | 01-04 |  
| 06 \- Handoff/06 — POPULATION\_DEMOGRAPHY\_CLANS\_CONTRACTS.md | POPULATION/CLAN | Cohorts, needs, demography, migration and clan behavior | FROZEN | 1 | 2026-09-03 | 01-05 |  
| 06 \- Handoff/07 — STATE\_FISCAL\_LAWS\_CONTRACTS.md | FISCAL | Treasury, taxes, transfers, procurement, laws and sovereign debt | FROZEN | 1 | 2026-09-03 | 01-06 |  
| 06 \- Handoff/08 — MONETARY\_CURRENCY\_CONTRACTS.md | MONETARY | Currency, monetary authorities, CPI, policy, OMO and money reconciliation | FROZEN | 1 | 2026-09-03 | 01-07 |  
| 06 \- Handoff/09 — EXPANSION\_SETTLEMENT\_CONTRACTS.md | EXPANSION | Settlement, discovery, jurisdiction and successor states | FROZEN | 1 | 2026-09-03 | 01-08 |  
| 06 \- Handoff/10 — EVENTS\_SHOCKS\_CONTRACTS.md | EVENTS | Deterministic events, typed shocks and physical-loss accounting | FROZEN | 1 | 2026-09-03 | 01-09 |  
| 06 \- Handoff/11 — REPOSITORY\_MIGRATION\_AND\_MILESTONE\_GATES.md | MIGRATION | M0-M12 strangler migration and milestone gates | FROZEN | 1 | 2026-09-03 | 00-10 |  
| 06 \- Handoff/12 — ACCEPTANCE\_BENCHMARK\_PERFORMANCE\_SUITE.md | ACCEPTANCE/PERFORMANCE | Release-blocking tests, benchmarks and performance budgets | FROZEN | 1 | 2026-09-03 | 00-11 |  
| 06 \- Handoff/13 — VISUALIZATION\_AND\_EXPLAINABILITY.md | VISUALIZATION | Browser output, Worker, observatory UX, replay and explainability | FROZEN | 1 | 2026-09-03 | 01,11,12 |  
| 06 \- Handoff/90 — USER\_DRAFT\_SYNTHESIS\_AND\_TRACEABILITY.md | SCOPE | Traceability of user intent; evidence, not formula authority | FROZEN | 1 | 2026-09-03 | START\_HERE |  
| 06 \- Handoff/91 — REPOSITORY\_AUDIT\_BASELINE.md | MIGRATION | Baseline repository facts and reusable legacy behavior | FROZEN | 1 | 2026-09-03 | — |  
| 06 \- Handoff/99 — PROJECT\_MANIFEST.md | SCOPE | Mission, principles, QA/feedback protocol and decision rules | FROZEN | 1 | 2026-09-03 | — |  
| REQUIREMENTS\_REGISTRY.csv | SCOPE | Machine-readable permanent requirement IDs and acceptance pointers | FROZEN | 1 | 2026-09-03 | SPEC\_INDEX |  
| EXECUTION\_ORDER.md | MIGRATION | What can be implemented now and dependency order | FROZEN | 1 | 2026-09-03 | 11, REQUIREMENTS\_REGISTRY |  
| SPEC\_CHANGELOG.md | SCOPE | Append-only semantic requirement changes | FROZEN | 1 | 2026-09-03 | REQUIREMENTS\_REGISTRY |  
| ANSWERS\_TO\_IMPLEMENTER.md | SCOPE | Append-only answers to implementation questions and feedback | ACTIVE | 1 | 2026-09-03 | repository feedback channel |

## Frozen AREA vocabulary

CORE, CONFIG, MARKET, PRODUCTION, POPULATION, CLAN, FISCAL, MONETARY, EXPANSION, EVENTS, VISUALIZATION, MIGRATION, ACCEPTANCE, PERFORMANCE, SCOPE.

## Mirror rule

Do not mirror 01 \- Inputs, 02 \- Research, 03 \- Economic Model, 04 \- Visualization, 05 \- Implementation Specs, 90 \- Reports, or STATE\_AND\_QUEUE. Their necessary implementation content is already normalized into 06 \- Handoff. The only control-file exception outside 06 \- Handoff is the root navigation/feedback layer listed above.

## Mirror navigation conventions

FILE is the exact mirrored path including extension; no implicit \`.md\` completion is part of the contract. Google Docs Heading styles are authoritative for Markdown section structure and REQUIREMENTS\_REGISTRY ANCHOR navigation. Before a requirement becomes READY/FROZEN executable, its referenced ANCHOR must resolve to a real exported Markdown heading. Forge priority mapping is P0 \-\> priority:high and P1 \-\> priority:normal; priority:critical is reserved for stop-the-line implementation failures and does not redefine spec priority.

