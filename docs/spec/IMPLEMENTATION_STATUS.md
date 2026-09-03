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

## Coverage

| REQ ID | Status | Issue | Merged in | Proving test |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

**Summary: 0 of 0 requirements implemented.** The specification mirror is not yet
synchronized, so no requirement identifiers exist to track.

## Pre-existing behavior

The repository already contains a working simulation — four cities, three goods,
supply-and-demand pricing, merchant arbitrage, and 42 passing tests including money
and stock conservation invariants. None of it is yet mapped to requirement
identifiers. Mapping the existing code onto the registry is the first substantive
unit of work once the registry exists; until then the table above is empty by fact,
not by omission.
