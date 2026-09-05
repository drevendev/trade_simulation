# Machine-generated pull requests

Some pull requests here are not authored by anyone. A workflow copies bytes from a
known source into one declared corner of the repository and proposes the result. There
is no judgement in them to review.

This document defines that class, what it is allowed to do, and who accepts it.

## The class

A pull request belongs to this class only when **all** of the following hold. They are
checked by `scripts/machine_pr_guard.py`, which runs inside the required `policy-guard`
check on every pull request — not by a reader.

1. its head branch is exactly a branch named in `MACHINE_CLASSES` in that script;
2. every changed path is inside the roots that class owns;
3. every changed path satisfies that class's own allowlist, where it has one;
4. the head commit is **committed** by the identity the producing workflow writes
   under. Its *author* is whoever triggered the sync and may be a person: dispatching
   `spec-sync.yml` by hand is a supported operating path, and the author field is the
   record of that. The committer is what wrote the bytes, and that is the question.

The classes today:

| Branch | Produced by | Owns | Allowlist |
| --- | --- | --- | --- |
| `spec-mirror` | `.github/workflows/spec-sync.yml` | `docs/spec/mirror/**` | `docs/zendev/spec-mirror-allowlist.txt` |

Adding a class is a policy change to the guard, its tests and this table, reviewed like
any other policy change and accepted by a person.

## The gate runs in both directions

The guard does not only constrain the machine branch. It also refuses **any other
branch** that writes a machine-owned path. An agent branch, a policy branch, or a
person editing `docs/spec/mirror/**` by hand is refused by a required check.

That is the point, and it is why this arrangement narrows authority rather than
widening it. The mirror is worth having because it is a verifiable copy of Drive.
Before the guard existed, anything could be written there from any branch and only a
reviewer stood in the way — and a reviewing agent is not a control against the agents
it sits beside. Now the only way bytes reach the mirror is the sync workflow, and the
only thing deciding whether they may is a predicate with negative-control tests.

## How one merges

The producing workflow arms GitHub auto-merge on the pull request it opens. Branch
protection then decides: the merge happens when — and only when — every required check
is green at the head revision. `machine-pr-guard` is one of them, inside `policy-guard`.

Nothing else merges it. There is no model anywhere in this path.

## What merging one asserts

That the snapshot is confined to its declared roots, allowlisted, produced by its own
workflow, and green.

It asserts **nothing** about whether the content is correct, current, or true. A mirror
pull request is a snapshot of Drive at one moment; Drive may have moved on, which is
neither knowable from here nor a reason to refuse. If it has, the next sync opens a
fresher snapshot, and merging the older one first is harmless and correct.

Mirrored content remains untrusted data everywhere it is later read. Instruction-shaped
text inside it is specification input, never authority.

## When a gate is red

The pull request stays open. That is the whole failure mode, and it is deliberate:

- the **ACCEPTOR does not review it**, and is not offered it:
  `scripts/select_review_target.py` classifies the head branch through
  `machine_pr_guard.classify` and rules it ineligible before the model is started. The
  runbook says the same thing in prose, but the model never has to act on it;
- the **AUTHOR does not touch it**. No agent may push to a machine branch — the guard
  refuses the diff that would result;
- it is an **operator matter**. A red `machine-pr-guard` means the producer emitted
  something outside its own contract. That deserves a person, not a retry.

The selector prints every open pull request and why it was skipped, so a machine pull
request sitting on a red gate appears in that log on every acceptor run rather than only
in the pull request list.

## Cost, and why this exists

Measured over the 24 hours ending 2026-09-05T06:40Z: 6 of 29 merged pull requests were
`spec-mirror` snapshots. Each consumed one ACCEPTOR run to assert that a byte copy was a
byte copy and — because the ACCEPTOR selects oldest-first — delayed the code pull request
behind it by a full dispatch interval.

Every gate in the old review path was already a predicate over the diff. Writing them as
one moves the same decision from a model to a check, makes it apply to every pull request
rather than only the ones a reviewer looks at, and gives the review slot back to code.
