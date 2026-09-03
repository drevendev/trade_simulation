# 2. TypeScript is the canonical engine; C# becomes a reference oracle

Date: 2026-09-03
Status: Accepted

## Context

The repository began as a C# / .NET 9 simulation. The specification requires the
finished product to run unattended on static GitHub Pages, which .NET cannot do
without a runtime the page would have to ship.

Earlier specification documents were ambiguous about this: they recommended
TypeScript while also showing `Domain/Core`, `Domain/World`, `Simulation`, `Config`
and `Diagnostics` folder examples underneath the C# project. The researcher agent
resolved that ambiguity on 2026-09-03 and updated the master index, the migration
plan, START_HERE, the registry and the changelog accordingly.

This is a specification decision, not an implementer decision. It is recorded here
because it changes how every future run verifies its work.

## Decision

**Canonical simulation behavior is implemented in TypeScript, under `src/`.** From M1
onward every canonical subsystem lands there. M0 puts the scaffolding in place
(`REQ-MIGRATION-003`).

**The C# project stays as a legacy reference oracle** until M12, useful for normalized
golden and parity evidence while responsibilities migrate. No canonical subsystem is
implemented in C# and then ported: responsibility moves one tested slice at a time,
and authoritative mutable stocks are never mirrored in both runtimes at once.

**M11 builds the Worker host and the observatory around this same engine**, not around
a second port.

The specification names TypeScript and Vite and nothing else. These were therefore
implementer choices, and the researcher confirmed on 2026-09-03 that no conflicting
requirement exists:

| Choice | Origin |
| --- | --- |
| TypeScript | specification |
| Vite | specification (`REQ-MIGRATION-003`) |
| `src/` as the canonical root | implementer — the migration document calls its folder examples responsibility boundaries, not a location mandate |
| npm | implementer |
| Vitest | implementer, for its Vite integration |
| Node LTS, `>= 22` | implementer |

## Consequences

**Two required checks, not one.** `typescript` and `build-and-test` both gate `master`.
A canonical change that leaves the legacy build red fails `REQ-MIGRATION-003`, which
demands canonical evidence *while* legacy stays green — so the legacy suite is a
migration requirement rather than a courtesy.

**`policy_guard` had to learn `src/`.** Without that, a policy change could have ridden
along inside a canonical diff, which is the single thing that guard exists to prevent.

**The real risk is implementing twice.** The cheapest way to waste this project is to
build a subsystem in C#, then rebuild it in TypeScript. `AGENTS.md` states the rule;
nothing enforces it structurally, so it stays a review responsibility.

**Legacy removal is gated, not scheduled.** M12 removes a legacy responsibility only
once canonical code and its tests demonstrably cover it.

## Alternatives considered

- **Stay on C# and ship a WebAssembly runtime.** Rejected by the specification: the
  observatory has to be a static page, and the payload and startup cost defeat the
  point.
- **Rewrite everything in TypeScript immediately.** Rejected: it throws away the
  working baseline and the golden-run evidence that makes migration checkable at all.
- **Keep both runtimes canonical, syncing state between them.** Rejected explicitly by
  the migration contract, and it is the classic way to end up with two economies that
  disagree and no authority to settle it.
