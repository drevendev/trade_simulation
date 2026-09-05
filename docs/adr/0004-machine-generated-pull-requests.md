# 4. A pull request no one authored merges on mechanical gates, with no agent in the path

Date: 2026-09-05
Status: Accepted

## Context

`spec-sync.yml` copies the allowlisted part of the Drive specification into
`docs/spec/mirror/` and proposes it. Nobody authors that change: the workflow copies
bytes from one place to another.

The ACCEPTOR reviewed those proposals under section 2a of its runbook. Its gates were:
every changed path inside `docs/spec/mirror/`, every path inside
`docs/zendev/spec-mirror-allowlist.txt`, no credential-shaped string, all required checks
green, and the head commit written by the sync workflow. Every one of them is a predicate
over the diff. No judgement was being exercised.

Measured over the 24 hours ending 2026-09-05T06:40Z: 6 of 29 merged pull requests were
mirror snapshots — 21% of merges. Each consumed one of roughly 24 daily review slots to
assert that a byte copy was a byte copy. Because the ACCEPTOR selects oldest-first, each
one also delayed the code pull request behind it by a full dispatch interval, then
25 minutes.

## Decision

**The gates become a required check, and branch protection performs the merge.**

`scripts/machine_pr_guard.py` decides the class and enforces it, inside the already
required `policy-guard` job. `spec-sync.yml` arms GitHub auto-merge on the pull request
it opens. `docs/zendev/MACHINE_PULL_REQUESTS.md` is the normative contract.

Four conditions, all mechanical, define the class: the head branch is exactly one named
in `MACHINE_CLASSES`; every changed path is inside the roots that class owns; every path
satisfies that class's allowlist; and the head commit is **committed** by the identity the
producing workflow writes under.

**The guard runs in both directions.** It also refuses any non-machine branch that writes
a machine-owned path. This is the half that makes the change a narrowing rather than a
widening: before it, `docs/spec/mirror/**` could be written from any branch and only a
reviewing agent stood in the way — and a reviewing agent is not a control against the
agents it sits beside. After it, the sync workflow is the only path in.

**The class leaves the review queue mechanically, not by instruction.**
`select_review_target.py` classifies the head branch through `machine_pr_guard.classify`
and rules it ineligible before the model starts. One definition of the class, used by
both the gate and the selector.

### What was rejected

*A new required status check.* Branch protection requires exactly `build-and-test`,
`typescript` and `policy-guard`. A newly required context that does not run on existing
pull requests blocks every one of them indefinitely. The guard lives inside
`policy-guard` for that reason, and needs no branch-protection change.

*Leaving the review in place and making it cheaper.* Nothing about it was expensive
except the run. The gates were already decidable; a faster model deciding them would have
been the same category error.

*Letting the ACCEPTOR merge the class by hand when a gate is red.* That restores exactly
the review dependency this removes, and it puts a role that may merge in front of a
control designed to work without one.

## Consequences

A mirror now merges in under a minute with no model run. Measured on #116: opened
09:31:39Z, merged 09:32:30Z, all four required checks green, no agent anywhere in the
path.

**A red gate has no automatic recovery, and that is the cost.** The ACCEPTOR may not
select it, no agent may push to the branch, and re-running the checks replays the
workflow definition the original run started with — so repairing the guard does not
release what it refused. The proposal must be closed and reproposed by the next sync. Both
guard defects found in the first hour (#110, #113) stalled the specification pipeline for
about half an hour each, and the procedure is written down in
`docs/zendev/MACHINE_PULL_REQUESTS.md` because it had to be worked out twice.

**Provenance is the committer, never the author.** The action defaults the author to
whoever triggered the run, so an operator-dispatched sync is authored by that person and
committed by the workflow. #113 records the refusal this caused.

**Acceptance of this class asserts less than a review did.** It asserts the snapshot is
confined, allowlisted, produced by its workflow and green — nothing about whether the
content is correct or current. That was already true of the review; it is now explicit.

**A human accepted the change itself.** `ACCEPTOR_RUNBOOK.md`'s hard limits forbid that
role from merging a policy change that alters automated authority, and this altered who
accepts a class of pull request.
