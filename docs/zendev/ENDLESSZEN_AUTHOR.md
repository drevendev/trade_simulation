# A pull request from outside the loop

From `scheme/7` the code is written by the researcher (EndlessZen) under the `drevendev`
account, not by an AUTHOR run: the active scheme declares the author role without a
model, and the dispatcher never starts `zendev-author.yml`. Nothing else changed. The
ACCEPTOR still judges every pull request, branch protection still requires the same
four checks, and the gates below are mechanical — they neither know nor care who pushed
the branch. This page is what an author outside the loop needs in order to get a pull
request accepted, in the order the gates read it. Sections 6 and 7 of
[AUTHOR_RUNBOOK.md](AUTHOR_RUNBOOK.md) remain the long form.

## Before the branch

- **Work from an Issue.** The pull request closes exactly one (`Closes #N` in the
  body), and that Issue carries exactly one `priority:*`, exactly one `type:*` and at
  least one `area:*` label; `issue-label-guard`, inside the required `policy-guard`
  check, refuses the pull request otherwise. Claim it with a comment (role, intended
  scope, branch name) and move it to `status:in-progress`.
- **Product or policy, never both.** Workflows, `scripts/`, `docs/zendev/` and
  `AGENTS.md` are control plane; `policy_guard` refuses a diff that mixes them with
  product code, and a product Issue is not `policy`.
- **Branch name:** anything but `claude/**` and the machine branches
  `scripts/machine_pr_guard.py` lists. `zen/issue-<N>-<slug>` is the suggestion.
  `claude/**` is the loop's own class: the forge merges `master` into such a branch
  when it falls behind and deletes it after the third refusal. Yours it leaves alone
  both ways — so **a branch that falls behind `master` is yours to update** (merge
  `master` in, or rebase and push); the red `mergeability` status says which it is,
  and the ACCEPTOR does not select a pull request while that status is red.
- **Read the slice, not the specification.** Registry, changelog, then the one document
  the Issue names. `docs/spec/mirror/**` is machine-owned and never edited by hand; a
  wrong specification is a dated entry in `docs/spec/FEEDBACK_TO_RESEARCHER.md` or
  `docs/spec/OPEN_QUESTIONS.md` inside the same pull request.

## In the pull request

The body follows [the pull request template](../../.github/PULL_REQUEST_TEMPLATE.md)
completely. Three parts of it are read by machines:

- `Closes #N` — the linked Issue.
- *Changed artifacts* names **every** path the diff touches, spelled exactly as
  `git diff --name-only origin/master...HEAD` prints it. `scope_guard` fails
  `policy-guard` on a path the body does not mention; editing the body re-runs the
  check without a commit.
- *Tested revision* — the head commit you actually verified.

The ledger travels inside the pull request. One row per requirement identifier in
`docs/spec/implementation_status.csv` — `REQ_ID,STATUS,ISSUE,PR,MERGE_COMMIT,EVIDENCE`,
`MERGE_COMMIT` left empty, `EVIDENCE` quoted whenever it holds a comma — then
`python scripts/implementation_status.py` to regenerate the table and
`python scripts/implementation_status.py --check` to prove it. `PR` is this pull
request's own number: open the pull request first if you need it, then add the row on
the same branch. Naming any other open pull request is refused by `status_lint`.

Before pushing: `npm run typecheck`, `npm test`, `npm run build`, and
`python -m unittest discover -s scripts/tests` whenever anything under `scripts/`
changed. Never cut a tag or a release; the tagger is mechanical and releases a milestone
only when every one of its rows reads `IMPLEMENTED` and carries its merge commit.

## What happens next

- The four required checks run on the head revision: `build-and-test`, `typescript`,
  `policy-guard`, `mergeability`. All four must be green; `pending` is not green.
- The ACCEPTOR run — every 25 minutes, on the oldest eligible pull request — posts a
  verdict comment (`## Verdict: ACCEPT` or `## Verdict: REQUEST_CHANGES`) and merges an
  accepted pull request itself. It reads the body, checks out the head and runs the
  checks the body names. Answer a refusal by pushing to the same branch; the next run
  judges the new head. The third refusal closes the pull request (the branch stays) and
  returns the Issue to `status:ready`.
- A pull request nothing has advanced for 24 hours, and that no run could select, is
  closed by the forge. A push, a verdict, or the author's own comment advances it;
  anyone else's comment is evidence, not progress.
- Reviews from other accounts — the QA voice, the researcher's own — are evidence for
  the next verdict, not rounds of the loop.

## What is measured

Every closed pull request is written to the private ledger (`pulls/` in
`zen-telemetry`) by `pr-ledger.yml`: who opened it and when, when it was first judged
and when it merged or closed, how many refusals it took, its size, the Issue and the
requirement identifiers it names, and the scheme it landed under. The ACCEPTOR's own
runs are recorded as before. That is how the speed and quality of this scheme compare
with the autonomous author's days — same gates, same judge, different author.
