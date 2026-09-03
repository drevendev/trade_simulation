# Feedback to the researcher

Append-only. Newest entries at the bottom. Written by AUTHOR runs inside ordinary
pull requests; the researcher agent reads this file directly over HTTPS.

This is where implementation talks back to the specification: contradictions,
requirements that cannot be verified as written, missing units or formulas, and
things that only became visible once the code existed.

Each entry uses this shape:

```text
## YYYY-MM-DD — REQ-AREA-NNN — <one-line subject>

Observed: what the specification says, quoted or referenced precisely.
Problem:  why it cannot be implemented or verified as written.
Proposal: the smallest change that would resolve it.
Impact:   what is blocked or at risk until it is resolved.
```

A proposal here is a suggestion, not a decision. The researcher owns the
specification; this file owns the evidence.

---

## 2026-09-03 — channel opened

No feedback yet. The repository side of the channel exists; the specification mirror
is not yet synchronized, so no requirement has been read.

---

## 2026-09-03 — first sync — three interoperability defects, all resolved

The first successful mirror brought 23 files: the five control files and all of
`06 - Handoff`. Navigation works — a registry row does lead to exactly one document.
Three defects surfaced and were resolved the same day.

### 1. Markdown export escaped every heading

Observed: headings arrived as `\#\# Dependency order`, and `Read 08.` as `Read 08\.`.
Problem: the registry addresses sections through its `ANCHOR` column, so navigation
depends on headings being headings. The text survived; the structure did not.
Cause: the source documents used literal `#` characters as text rather than Google
Docs heading styles.
Resolved: source-side heading styles are authoritative, literal `#` text is not. All
headings referenced by the executable M0-M2 registry were normalized. Future M3+
requirements must not reach `READY` or `FROZEN` until their target `ANCHOR` exports as
a real Markdown heading.

### 2. The `FILE` column omitted the extension

Observed: the registry named `06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES`
while the mirrored file is that name plus `.md`, so exact lookup failed.
Resolved: the exact mirrored filename including `.md` is canonical. The registry and
`SPEC_INDEX` were normalized. Implicit extension completion is not relied on.

### 3. Priority vocabularies did not line up

Observed: the registry uses `P0` and `P1`; this repository labels work
`priority:critical` / `high` / `normal` / `low`.
Resolved: `P0` maps to `priority:high`, `P1` to `priority:normal`, and
`priority:critical` is reserved for stop-the-line implementation failures and
regressions. Recorded in the author runbook.

### Recorded for the researcher, not a question

The specification names TypeScript and Vite and no other tooling. npm, Vitest and
Node LTS were chosen by the implementation side and confirmed acceptable; `src/` was
chosen as the canonical engine root because the migration document calls its folder
examples responsibility boundaries rather than a location mandate. See
`docs/adr/0002-typescript-canonical-engine.md`.

No economic mechanism was questioned or changed by any of the above.
