# Implementation status

The measurable answer to "is the specification implemented?" — a set of requirement
identifiers, each with the evidence that closes it. Maintained by AUTHOR runs inside
the pull request that changes a requirement's status.

An identifier moves to `IMPLEMENTED` only when code satisfies it **and** a test
proves it. "The code looks right" is not evidence.

## Legend

| Status | Meaning |
| --- | --- |
| `NOT_STARTED` | Present in the registry, no work begun |
| `IN_PROGRESS` | Claimed by an open Issue or pull request |
| `IMPLEMENTED` | Merged, with a named test that fails without the change |
| `BLOCKED` | Cannot proceed; the blocking question is in `OPEN_QUESTIONS.md` |
| `DEFERRED` | Deliberately out of scope for now, with a recorded reason |
| `CONTESTED` | Implementable only after the researcher resolves a contradiction |

Only `IMPLEMENTED` rows are evidence: a merge commit plus a named test that fails
without it. Every other status, including a row not yet present in this table, is a
claim without a proving merge.

## Coverage

The denominator below is the current mirrored `docs/spec/mirror/REQUIREMENTS_REGISTRY.csv`
data-row count (25 as of `SPEC_CHANGELOG.md` revision `VIS-CADENCE-001`, which added
`REQ-VISUALIZATION-002..005`). Recompute it from the registry itself whenever either
file changes; never carry a historical total forward independently of the registry.

| REQ ID | Status | Issue | Merged in | Proving test |
| --- | --- | --- | --- | --- |
| REQ-MIGRATION-001 | `IMPLEMENTED` | #23 | #24, `7d732d1ffe3f73f202d63dc82baf8f3125a13ce9` | `dotnet build --configuration Release` (0 warnings, 0 errors) and the full `TradeCraftSimulation.Tests` suite (44/44 passed, 0 failed, 0 skipped) at revision `10af216915bd96f680ec6da4197f408175c96509`, matching Gate M0's "build succeeds and all existing tests pass unchanged" |
| REQ-MIGRATION-002 | `IMPLEMENTED` | #39 | #40, `6063ed9151d86e1650f53a36441bcd9aa64ddeb2` | `TradeCraftSimulation.Tests.LegacyBaselineSnapshotTests.The_seed_7_thirty_turn_baseline_matches_the_frozen_expected_hash`, pinning the seed-7/30-turn normalized hash documented in `docs/spec/LEGACY_BASELINE.md` against a checked-in expected SHA-256, satisfying the strengthened `CODE_RUNTIME_QA_02` acceptance; 45/45 `TradeCraftSimulation.Tests` passed at the merge commit |
| REQ-MIGRATION-003 | `IMPLEMENTED` | #27 | #29, `1fb089368434abc2d875a553225f6f73d042da41` | `src/config/index.test.ts`, `src/domain/index.test.ts`, `src/simulation/index.test.ts`, `src/diagnostics/index.test.ts` (one per new module area) and `src/index.test.ts`'s `canonicalScaffolding` assertion; `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `dotnet build --configuration Release` and `dotnet test --configuration Release` all green in the same pull request |
| REQ-MIGRATION-004 | `IMPLEMENTED` | #41 | #43, `33683dd4224cac869d2eac982f756ae8fdb6ea7f` | `src/diagnostics/isolationBoundary.test.ts` — `finds zero cross-runtime references in the current M0 source trees` audits the real `src/` and `TradeCraftSimulation/` trees for textual cross-references; two negative-control tests (`rejects a canonical file that imports the legacy tree`, `rejects a legacy file that reads canonical module output`) prove the underlying scan actually rejects a fixture-only prohibited reference; a third negative-control test (`auditRepositoryIsolationBoundary rejects a similarly-named-but-distinct file that the guard-module exclusion must not swallow`) proves, through the real `auditRepositoryIsolationBoundary` traversal rather than the pure scan alone, that the guard's own file-exclusion is an exact path match and does not silently exempt unrelated similarly-named files (closing a false-negative operator QA and ACCEPTOR review both reproduced against an earlier revision of this pull request). Documented in `docs/spec/MIGRATION_BOUNDARY.md`. |
| REQ-VISUALIZATION-003 | `IMPLEMENTED` | #42 | #45, `d27a94e63580a2d7d0da005a245ae36fec5560fd` | `src/diagnostics/m0Preview.test.ts` — asserts `docs/m0-preview.json`'s legacy baseline seed/turns/hash match `docs/spec/LEGACY_BASELINE.md` exactly, its canonical-scaffolding flag matches the real `toolchainStatus()` in `src/index.ts`, and `docs/index.html` fetches the static artifact without referencing any canonical or legacy runtime module path. Manual build/render smoke check (headless-Chromium screenshots at 1280×1000, 360×900, and a full-page 1100×1900 capture) against a local static server, described in `docs/spec/M0_PREVIEW.md`; 7 files / 16 tests passed and both runtime suites green at merge commit `d27a94e63580a2d7d0da005a245ae36fec5560fd`. Actual production GitHub Pages deployment was explicitly out of AUTHOR scope in #45 and has not been independently re-verified by this reconciliation, which is bounded to `gh pr list` and the merged pull request's own body per `AUTHOR_RUNBOOK.md` section 1. |
| REQ-CORE-001 | `IN_PROGRESS` | #46 | pending — implemented on branch `claude/issue-46-canonical-typed-ids`, not yet merged | `src/domain/id.test.ts` (13-kind prefix table, per-kind sequential allocation, duplicate-creation-key rejection, cross-run replay determinism, stable creation-key-order contract independent of array/Map build order, and `CORE-T16` retirement/non-reuse including wrong-kind and double-retire rejection) plus `src/domain/id.typecheck.test.ts` (`tsc --noEmit` regressions proving distinct ID kinds and bare strings are not mutually assignable). See `docs/adr/0003-canonical-identity-and-allocation.md` for the design. Not yet mergeable evidence: promote to `IMPLEMENTED` only once a pull request referencing this row actually merges. |

**Summary: 5 of 25 requirements implemented; 1 in progress.** The other 19
requirement identifiers in `docs/spec/mirror/REQUIREMENTS_REGISTRY.csv` — including
the remaining `REQ-VISUALIZATION-002, 004, 005` — are not yet mapped to this table;
that mapping, and their own implementation evidence, is separate follow-up work, not
evidence that they are unimplemented or implemented.

## Pre-existing behavior

The repository already contains a working simulation — four cities, three goods,
supply-and-demand pricing, merchant arbitrage, and (as of this update) 44 passing
tests including money and stock conservation invariants. Apart from
REQ-MIGRATION-002 above, none of it is yet mapped to requirement identifiers.
Mapping the rest of the existing code onto the registry remains follow-up work.
