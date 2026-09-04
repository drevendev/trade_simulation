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
| REQ-MIGRATION-002 | `IN_PROGRESS` | #17 | #18 (partial), `2ee9a06633ad051887ec527acda1240f26557d0c` | PR #18 proves `TradeCraftSimulation.Tests.LegacyBaselineSnapshotTests.The_same_seed_produces_the_same_normalized_snapshot_hash` (and the non-constant `A_different_seed_produces_a_different_normalized_snapshot_hash` sanity check). Same-seed repeatability alone no longer closes this requirement: `SPEC_CHANGELOG.md` revision `CODE_RUNTIME_QA_02` strengthened the mirrored acceptance to require a fixed documented 30-turn seed with a checked-in **expected** normalized SHA-256, which is not yet asserted. Closing evidence still needed: a test that pins the expected hash value and fails if the baseline drifts. |

**Summary: 1 of 25 requirements implemented; 1 in progress.** The other 23
requirement identifiers in `docs/spec/mirror/REQUIREMENTS_REGISTRY.csv` — including
the newly mirrored `REQ-VISUALIZATION-002..005` — are not yet mapped to this table;
that mapping, and their own implementation evidence, is separate follow-up work, not
evidence that they are unimplemented or implemented.

`REQ-MIGRATION-003` is not listed here: it is claimed by open PR #29, which has not
yet merged. The normal post-merge reconciliation step (`AUTHOR_RUNBOOK.md` section 1)
will add it once that PR merges and names its merge commit and proving test.

## Pre-existing behavior

The repository already contains a working simulation — four cities, three goods,
supply-and-demand pricing, merchant arbitrage, and (as of this update) 44 passing
tests including money and stock conservation invariants. Apart from
REQ-MIGRATION-002 above, none of it is yet mapped to requirement identifiers.
Mapping the rest of the existing code onto the registry remains follow-up work.
