# Legacy/canonical isolation boundary (REQ-MIGRATION-004)

M0 evidence for the non-negotiable migration rule
(`docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`,
"Non-negotiable migration rules", rule 1): "One authoritative owner per stock. During
dual-running, legacy stocks and canonical stocks are separate worlds; do not mirror
mutations bidirectionally."

## The two entry points, as they exist today

| Runtime | Entry point | Authoritative stocks |
| --- | --- | --- |
| Legacy (C# / .NET 9) | `TradeCraftSimulation/Program.cs` → `Simulation.RunTurn()` | `City.Population`, `Storage.All` (per `Market`), mutated in place across turns |
| Canonical (TypeScript) | `src/index.ts` → `toolchainStatus()` | none — `src/config`, `src/domain`, `src/simulation`, `src/diagnostics` are scaffolding only (`REQ-MIGRATION-003`); no mutable stock exists yet |

There is no shared process, no shared file, and no adapter between them. The two
runtimes cannot share memory: they are separate language toolchains invoked
independently (`dotnet test`, `npm test`), each producing its own build artifact
(`TradeCraftSimulation.Tests.dll`, `dist/canonical.js`). At M0 the canonical side owns
no stock at all, so "no bidirectional mirroring" holds trivially by absence — the
guard below exists so that stays true as canonical stocks arrive from M1 onward,
rather than being re-derived by inspection each time.

## What the automated guard checks

`src/diagnostics/isolationBoundary.ts` (tested by
`src/diagnostics/isolationBoundary.test.ts`) statically scans both source trees for
textual evidence that one side names the other's implementation:

- every `.ts` file under `src/` must not contain the substring `TradeCraftSimulation`
  (an import path, a namespace reference, a file read of legacy output);
- every `.cs` file under `TradeCraftSimulation/` must not contain `src/config`,
  `src/domain`, `src/simulation`, `src/diagnostics`, or `dist/canonical` (a read of
  canonical source or its build output).

The regression test `finds zero cross-runtime references in the current M0 source
trees` runs this scan against the real repository and asserts both violation lists
are empty — the actual current-state proof.

The negative-control tests (`rejects a canonical file that imports the legacy tree`,
`rejects a legacy file that reads canonical module output`) do not add a live bridge
to the repository. They construct an in-memory fixture file containing exactly the
kind of forbidden reference described above and assert the scanner's pure function,
`findCrossRuntimeReferences`, flags it with the correct file, line and marker. This is
what proves the guard is a real detector rather than a check that would pass
vacuously against an empty ruleset.

## Limits of this evidence

This is a source-level guard, not a runtime one:

- it proves no `.ts` file under `src/` and no `.cs` file under `TradeCraftSimulation/`
  currently *names* the other tree in source, not that no process-external bridge
  (a CI step, a generated file, a shared data file outside both trees) could exist;
- it runs as an ordinary `vitest` test today; it is not yet wired as a standalone CI
  gate distinct from `npm test` — the existing `build-and-test` required check already
  runs the full `npm test` suite, so this guard already gates every pull request, but
  a reviewer looking for it by name should look inside that check's output rather than
  a separately named job;
- it says nothing about *economic* correctness or accounting invariants — only about
  the structural rule that the two runtimes' stocks are not wired together;
- as canonical stocks arrive from M1 onward, the marker lists above may need
  extending (for example, a canonical adapter that legitimately reads a frozen legacy
  fixture file for parity testing would need a scoped exception, not a silent
  weakening of the guard) — that is future work, not claimed as covered here.
