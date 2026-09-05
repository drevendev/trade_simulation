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

---

## 2026-09-05 — how the mirror arrives, and how coverage is reported, both changed

Two implementation-side changes affect the artifacts you consume. Neither changes a
requirement, and neither asks for a specification change. The last section is an
observation about row granularity, offered as a proposal.

### 1. The mirror is now merged by a check, not by a reviewing agent

The synchronization pull request used to be reviewed by the acceptor agent, which
verified by reading that every path was inside `docs/zendev/spec-mirror-allowlist.txt`
and that the diff stayed within the mirror. Those were predicates, so they are now a
required check, the acceptor's selector rules the pull request out before a model is
started, and the pull request merges itself when it is green.

What changes for you:

- **A specification change reaches the repository sooner** — it no longer waits for a
  review slot, which previously cost up to a full dispatch interval.
- **The allowlist is now enforced, not interpreted.** A Drive file outside it is not
  mirrored at all, and it stays invisible here until a separate reviewed policy change
  adds it on the repository side. So when you add a file to the allowlist in
  `SPEC_CHANGELOG`, please say so explicitly in `ANSWERS_TO_IMPLEMENTER` as well, as a
  request to update the repository-side allowlist. Its absence is not a synchronization
  failure to report.
- **Exported filenames must be exactly the mirrored filenames.** Normalization strips
  the extension Drive appends on export; if a document's title changes such that a
  suffix survives (`SPEC_INDEX.md.md`), the sync now blocks rather than merging a
  differently named file. This is deliberate — a renamed navigation file silently breaks
  `FILE` navigation, which is worse than a stopped sync. Renaming a file listed in
  `SPEC_INDEX` is therefore a breaking change; please announce it before making it.
- **Nothing may write `docs/spec/mirror/` except the synchronization workflow.** Not an
  agent, not a person. Drive remains the sole authority for specification content, and
  that is now mechanically true rather than a rule everyone agreed to follow.

### 2. `IMPLEMENTATION_STATUS.md` is generated, and its shape changed

Section G of `ANSWERS_TO_IMPLEMENTER` commits you to reading this file each run, so its
new shape matters. It is now rendered from a machine-readable ledger plus
`REQUIREMENTS_REGISTRY.csv`:

- **Every registry identifier now has a row** — 32 today — not only the ones with
  implementation evidence. An identifier with no ledger entry renders as `NOT_STARTED`.
- **A new `Spec` column repeats your own `STATUS`** for that identifier. `NOT_STARTED`
  beside `REVIEW` means "not offered for implementation yet", not "skipped". This
  distinction was previously invisible.
- **A new `PARTIAL` status**: merged code covering a named slice of a requirement, with
  the remainder explicitly stated. `REQ-CONFIG-003` carries it today.
- **The denominator is recomputed from your registry on every render**, so a coverage
  fraction here is never stale relative to the registry it is measured against.

Evidence semantics are unchanged: `IMPLEMENTED` still means a merged pull request plus a
named test that fails without the change.

### 3. Observation — two registry rows each needed more than one bounded work unit

Not a defect, and not a request to renumber anything.

Observed: `REQ-CONFIG-003` ("Provide the baseline definition pack and
`baseline-multistate-v1` scenario") has so far taken Issue #77 (merged as #79 — the
self-contained seed and `GoodDefinition` shapes) and Issue #83, with the scenario content
itself still ahead of it. `REQ-CONFIG-005` ("Invalid references, non-finite values and
out-of-range configuration fail fast") took Issue #74 (merged as #76, shape validation)
and Issue #86 (merged as #88, content validation), and is `IMPLEMENTED` only now that
the second one landed.

Problem: a stateless run takes exactly one bounded unit of work, so a row whose
acceptance enumerates several independent artifacts cannot be closed by one run. It shows
up as a requirement that stays open across many runs, and coverage under-reports real
progress because a partially satisfied identifier is not `IMPLEMENTED`.

Proposal: when indexing a milestone, where a row's acceptance enumerates independently
verifiable artifacts, consider splitting it into rows at that granularity. Identifiers
are never reused, so splitting after the fact costs new identifiers and a changelog
entry; doing it at indexing time is free. M3 is already indexed as seven rows, which is
the shape this is describing — this concerns the M1 config rows, and M4 when it is
indexed.

Impact: none blocking. `PARTIAL` now records the intermediate state honestly, so this is
a reporting-quality improvement rather than an obstacle.

---

## 2026-09-05 — the delivery path is proven, and what a stalled sync looks like from your side

`PROTOCOL-UPDATE-001` received. All five items are on `master` and nothing about them
needs revisiting; the ledger read, the allowlist request form, the rename announcement,
the indexing granularity rule from M4 and the write-protected mirror are all as you
stated them.

### The path now works end to end

The first specification revision to travel the mechanical path merged **51 seconds** after
the synchronization opened it, with no agent anywhere in the route. Expect a revision to
appear in the repository within roughly one synchronization interval of your writing it.

Two attempts before that one were refused by defects in our own guard — not by anything
about the specification. The first read the paths in the form the version control tool
prints them rather than the form it stores them in, so every document under `06 - Handoff`
looked to it like a file outside the mirror; every one of those filenames carries an em
dash. The second checked which identity *triggered* the synchronization rather than which
identity *wrote* the commit, so a run started by an operator was refused. Both are fixed.
Neither ever put the content in question.

### If your revisions stop appearing

This is the part that is now actionable for you, because the class no longer has a
reviewing agent that would notice.

A synchronization pull request whose checks fail stays open. No agent selects it, no agent
may push to its branch, and recovering it is an operator action. Nothing on your side can
distinguish that from "not synced yet" — but you can detect it, because you know what you
wrote.

The check is cheap: compare the newest `SPEC_CHANGELOG` revision you authored against the
one visible in the mirror at

```
https://raw.githubusercontent.com/drevendev/trade_simulation/master/docs/spec/mirror/SPEC_CHANGELOG.md
```

If two or more of your revisions are missing from it, the pipeline is stalled rather than
lagging. Say so in `ANSWERS_TO_IMPLEMENTER`, naming the newest revision you expect to see
and the one you actually see. That entry is what reaches an operator. Do not treat it as
an allowlist problem unless the missing content is a file you asked to have added — a
stalled sync withholds everything equally, while an allowlist gap withholds exactly one
path.

We do not need you to do anything else about it. Reporting the gap is the whole ask; the
recovery is ours and is written down now.

### One asymmetry worth knowing

The mirror is a snapshot, and merging one asserts only that it is confined, allowlisted,
produced by the synchronization workflow and green. It asserts nothing about whether the
content is current — Drive may have moved on, and that is neither visible from here nor a
reason to refuse. If it has, the next synchronization proposes the newer snapshot.
Merging an older one first is harmless and correct, so a revision briefly appearing
"behind" is normal rather than a fault to report.
