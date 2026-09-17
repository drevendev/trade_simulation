# A pull request from outside the loop

From `scheme/8` no model runs at all. The researcher (EndlessZen) writes the code under
the `drevendev` account, SLOPSTER reviews it under `andy-zen-dev` and owns the verdict,
and the operator merges. The active scheme declares both model roles without a model,
and the dispatcher starts neither `zendev-author.yml` nor `zendev-acceptor.yml`. What
stays is everything that costs no tokens: branch protection with its four required
checks, the `mergeability` status and the branch sweep, the specification mirror, and
both ledgers. The gates below are mechanical — they neither know nor care who pushed
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
  when it falls behind. Yours it leaves alone — so **a branch that falls behind
  `master` is yours to update** (merge `master` in, or rebase and push); the red
  `mergeability` status says whether it is behind or in conflict, and branch protection
  does not merge while it is red.
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
- **SLOPSTER judges** the head and owns the verdict, as `AGENTS.md` says: a comment
  starting `## Verdict: ACCEPT` or `## Verdict: REQUEST_CHANGES` that names the exact
  head it judged. It never posts a formal review — a formal refusal from an account
  without write access would hold the merge until someone with authority cleared it —
  and it never labels or merges. Its QA findings stay what they were,
  `## SLOPSTER QA: FINDING` comments; a finding that blocks acceptance comes with a
  `## Verdict: REQUEST_CHANGES`. Answer a refusal by pushing to the same branch; the
  verdict on the old head says nothing about the new one.
- **A clean head** — nothing to find — gets `## Verdict: ACCEPT` on that head. That
  comment, together with the four checks green on the same head, is the whole of what
  the operator needs.
- **The operator merges** an accepted pull request (squash, as every merge here), and
  closes the Issue through `Closes #N`. Nothing merges by itself.
- **Nothing closes a pull request by itself either.** The rework bound (three refusals)
  and the unreachable-pull-request rule (24 idle hours) lived in the ACCEPTOR's workflow
  and are not enforced under this scheme; a pull request that is going nowhere is closed
  by a person, and its Issue returned to `status:ready` by hand.

## What is measured

Every closed pull request is written to the private ledger (`pulls/` in
`zen-telemetry`) by `pr-ledger.yml`: who opened it and when, when it was first judged
and when it merged or closed, how many refusals it took — SLOPSTER's `## Verdict:` comments
are the verdicts now — its size, the Issue and the requirement
identifiers it names, its QA findings, and the scheme it landed under. That is how the
speed and quality of this scheme compare with the autonomous author's days: same gates,
a different author and a different judge, and no token cost on either side.
