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
| REQ-MIGRATION-002 | `IN_PROGRESS` | #39 | #18 (partial), `2ee9a06633ad051887ec527acda1240f26557d0c`; pending PR for #39 | PR #18 proved same-seed repeatability and the non-constant different-seed sanity check, but not the strengthened `CODE_RUNTIME_QA_02` acceptance (a checked-in **expected** normalized SHA-256). Issue #39 adds `TradeCraftSimulation.Tests.LegacyBaselineSnapshotTests.The_seed_7_thirty_turn_baseline_matches_the_frozen_expected_hash`, pinning the seed-7/30-turn hash documented in `docs/spec/LEGACY_BASELINE.md`, on a branch not yet merged as of this update — do not treat this row as `IMPLEMENTED` until that pull request merges and this row is updated with its merge commit. |
| REQ-MIGRATION-003 | `IMPLEMENTED` | #27 | #29, `1fb089368434abc2d875a553225f6f73d042da41` | `src/config/index.test.ts`, `src/domain/index.test.ts`, `src/simulation/index.test.ts`, `src/diagnostics/index.test.ts` (one per new module area) and `src/index.test.ts`'s `canonicalScaffolding` assertion; `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `dotnet build --configuration Release` and `dotnet test --configuration Release` all green in the same pull request |

**Summary: 2 of 25 requirements implemented; 1 in progress.** The other 22
requirement identifiers in `docs/spec/mirror/REQUIREMENTS_REGISTRY.csv` — including
the newly mirrored `REQ-VISUALIZATION-002..005` — are not yet mapped to this table;
that mapping, and their own implementation evidence, is separate follow-up work, not
evidence that they are unimplemented or implemented.

## Pre-existing behavior

The repository already contains a working simulation — four cities, three goods,
supply-and-demand pricing, merchant arbitrage, and (as of this update) 44 passing
tests including money and stock conservation invariants. Apart from
REQ-MIGRATION-002 above, none of it is yet mapped to requirement identifiers.
Mapping the rest of the existing code onto the registry remains follow-up work.
