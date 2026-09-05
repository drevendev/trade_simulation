# 5. Implementation coverage is rendered from an evidence ledger, not maintained as a status

Date: 2026-09-05
Status: Accepted

## Context

`docs/spec/IMPLEMENTATION_STATUS.md` answered "is the specification implemented?" as a
table of requirement identifiers, each with a status and the pull request that satisfied
it. It was written by hand inside pull requests.

A row recorded `IN_PROGRESS` with a pull request number. That pull request merged.
Nothing in the merge touched the row, so a later run had to notice and flip it — and
`AUTHOR_RUNBOOK.md` section 1 mandated exactly that, as a step before selecting work,
with an extra `gh pr list --state merged` in every run.

The cost was measurable. Reconciliation pull requests: #21, #26, #35, #47, #55, #66,
#105. Four of the 29 merges in the 24 hours ending 2026-09-05T06:40Z changed nothing but
this file — 14% of throughput — and each also consumed an ACCEPTOR run.

The cost was not the worst of it. #105 promoted `REQ-CONFIG-005` from `IN_PROGRESS` to
`IMPLEMENTED` while leaving the row's evidence untouched — evidence that opened "Covers
only the shape slice" and cited #76, never #88, which is what completed the requirement.
Every mechanical check passed: the cited pull request had merged and the counts added up.
**A stored status can be advanced independently of the evidence for it, and no arithmetic
over the document can tell.**

## Decision

**Store only what a change can assert about itself, and render the rest.**

`docs/spec/implementation_status.csv` is the ledger: `REQ_ID`, `STATUS`, `ISSUE`, `PR`,
an optional `MERGE_COMMIT`, `EVIDENCE`. One row per identifier, appended by the pull
request that earns it.

**A ledger row's presence on `master` is its merge evidence.** The row travels inside the
pull request it describes, so it appears on the default branch exactly when that work
merges. There is nothing for a later run to flip.

`scripts/implementation_status.py` renders `IMPLEMENTATION_STATUS.md` from the ledger plus
`REQUIREMENTS_REGISTRY.csv`, and `--check` regenerates and compares inside `policy-guard`.
It performs no network call: a generator whose output depended on when it ran could not be
a gate.

**`IN_PROGRESS` is not a ledger status.** Claimed work is a `status:in-progress` label on
an Issue — a live fact the forge already owns, and precisely the one this file kept
getting wrong. The statuses are `IMPLEMENTED`, `PARTIAL`, `BLOCKED`, `DEFERRED`,
`CONTESTED`; an identifier with no row renders as `NOT_STARTED`.

**A row may cite the pull request that carries it, and no other open one.** This reverses
the rule #102 introduced hours earlier, deliberately. That rule refused self-citation
because a pull request closed without merging would leave the claim false forever — which
was correct while *any* pull request could write *any* row, as #84 demonstrated. Once the
row and its subject travel together, a closed pull request takes its row with it: the
claim becomes true at the moment it becomes visible and false nowhere. `status_lint`'s
`--self` permits exactly that one citation; every other open citation is still refused,
and on a push event there is no self at all.

### What became of `status_lint`'s rules

| Rule from #97 / #102 | Fate |
| --- | --- |
| A requirement claimed by a merged pull request has no row | kept, retargeted at the ledger |
| A row cites a pull request that has not merged | kept, with the `--self` exception above |
| A malformed row | deleted — rows are CSV, and `validate` names a bad one offline |
| `IMPLEMENTED` citing no pull request | moved to `validate`; same decision, no network |
| Summary arithmetic | deleted — the summary is computed from the rows it counts |

### What was rejected

*Keeping the hand-maintained document and linting it harder.* That is what #97 did, and
it makes staleness loud without removing it: `master` goes red because something merged
elsewhere, and a reconciliation run is still required to clear it. The class persists.

*Deriving the status from the forge at render time.* An API call would make the output
depend on when it ran, which disqualifies it as a CI gate.

*Recording `IN_PROGRESS` in the ledger.* It is the one value the change cannot assert
about itself.

## Consequences

Coverage reads 11 of 32 implemented, 1 partial, and cannot disagree with the ledger it is
rendered from. The reconciliation class has no work left to do; #105 was closed rather
than rebased, and its requirement recorded against #88 with evidence naming the tests
that prove it.

**The table now lists every registry identifier**, with the specification's own status
beside it, so `NOT_STARTED` against a `REVIEW` row reads as "not offered for
implementation" rather than "skipped". The file is longer, and its diffs look larger than
the changes are.

**`PARTIAL` is load-bearing and could be abused.** It requires a merged pull request and
evidence, and its promotion to `IMPLEMENTED` is a deliberate act rather than a consequence
of a merge elsewhere — which is what makes it safe here and `IN_PROGRESS` unsafe.

**One instruction is known to be wrong.** Section 7 says to append a row; a requirement
that already has one — a `PARTIAL` being completed — needs the existing row updated, and
the validator refuses the duplicate. Recorded as #115.

**Nothing prompts a refresh when a later pull request advances a `PARTIAL` without
completing it.** `status_lint` only notices an identifier with no row at all.
`REQ-CONFIG-003` is the live instance: #91 merged more of it and the ledger still credits
#79. The status stays truthful; the evidence understates.
