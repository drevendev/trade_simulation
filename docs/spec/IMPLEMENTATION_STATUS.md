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

| REQ ID | Status | Issue | Merged in | Proving test |
| --- | --- | --- | --- | --- |
| REQ-MIGRATION-001 | `IMPLEMENTED` | #23 | #24, `7d732d1ffe3f73f202d63dc82baf8f3125a13ce9` | `dotnet build --configuration Release` (0 warnings, 0 errors) and the full `TradeCraftSimulation.Tests` suite (44/44 passed, 0 failed, 0 skipped) at revision `10af216915bd96f680ec6da4197f408175c96509`, matching Gate M0's "build succeeds and all existing tests pass unchanged" |
| REQ-MIGRATION-002 | `IMPLEMENTED` | #17 | #18, `2ee9a06633ad051887ec527acda1240f26557d0c` | `TradeCraftSimulation.Tests.LegacyBaselineSnapshotTests.The_same_seed_produces_the_same_normalized_snapshot_hash` (and `A_different_seed_produces_a_different_normalized_snapshot_hash` for the non-constant sanity check) |

**Summary: 2 of 19 requirements implemented; 0 in progress.** The other 17
requirement identifiers in `docs/spec/mirror/REQUIREMENTS_REGISTRY.csv` are not yet
mapped to this table; that mapping is separate follow-up work, not evidence that they
are unimplemented.

## Pre-existing behavior

The repository already contains a working simulation — four cities, three goods,
supply-and-demand pricing, merchant arbitrage, and (as of this update) 44 passing
tests including money and stock conservation invariants. Apart from
REQ-MIGRATION-002 above, none of it is yet mapped to requirement identifiers.
Mapping the rest of the existing code onto the registry remains follow-up work.
