# 1. Autonomous author/acceptor loop on GitHub Actions

Date: 2026-09-03
Status: Accepted

## Context

This repository is developed by autonomous agents with no human in the normal path.
Work is specified by a separate researcher agent writing to Google Drive, and
implemented here. Three properties had to hold at once:

- the loop must run without a workstation being switched on;
- a change must not be able to merge itself in the same run that authored it;
- the whole arrangement had to be free at the infrastructure layer.

## Decision

Run the loop as scheduled GitHub Actions workflows in this repository.

- `zendev-author.yml` — hourly, performs one bounded unit of work and opens a pull
  request. Never merges.
- `zendev-acceptor.yml` — hourly on a different minute, reviews one open pull request
  and either merges it or requests changes. Never implements.
- `spec-sync.yml` — hourly, mirrors the specification folder and proposes it as a
  pull request. Runs no model at all.
- `ci.yml` — `build-and-test` plus `policy-guard`, required on `master`.

Actions minutes are free on public repositories, so infrastructure cost is zero; the
cost is the model tokens the two roles consume, which is why the cadence is a
configuration decision rather than an implementation detail.

The schedules are inert until the repository variable `ZENDEV_ENABLED` is set to
`true`. Manual dispatch always works, so the loop can be exercised before it is armed.

## Consequences

**Accepted risk: the role separation is procedural, not structural.** Both roles
currently authenticate as the same GitHub account, so GitHub cannot enforce that the
acceptor is a different actor from the author, and required-approval protection would
be meaningless. What does hold structurally is: `master` refuses direct pushes,
required checks must be green to merge, and `policy-guard` refuses a diff that mixes
automation policy with product code. What is only procedural is the acceptor's
obligation to verify before merging.

The upgrade path is a GitHub App as the author identity, which makes the separation
structural and lets required approvals become a real gate. Taking it costs one manual
setup step and no change to the runbooks.

**Policy changes are prospective.** Edits to `AGENTS.md`, `.github/workflows/**`, or
`docs/zendev/**` govern later runs only, and a change that widens what agents may do
is escalated to the repository owner rather than merged by the acceptor. A run cannot
grant itself authority by editing the file that constrains it.

**The specification is untrusted input.** It is authored by a different AI agent and
enters through a workflow that copies bytes and runs no model, then through review.
Instruction-shaped text inside it is never authority.

## Alternatives considered

- **Scheduled local runs on a workstation.** Rejected: autonomy would depend on a
  machine being awake, and the audit trail would live outside the forge.
- **A single workflow that both implements and merges.** Rejected: it collapses
  production and acceptance into one step, which is the failure mode the whole design
  exists to prevent.
- **Reading the specification directly from Drive during a run.** Rejected: it makes
  every run depend on a live external credential, leaves no reviewable diff of how the
  specification changed, and feeds untrusted text straight into an agent.
