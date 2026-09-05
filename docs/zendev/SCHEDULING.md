# Hourly scheduling and recovery

## What changed

`zendev-watchdog.yml` is the only automatic cadence owner. It wakes at UTC minutes
11, 26, 41 and 56 and runs a small Python dispatcher, not a model. The three worker
workflows retain `workflow_dispatch`, their existing concurrency groups, roles,
timeouts and acceptance limits. Their former independent cron entries are removed
so a delayed native event cannot duplicate a recovery dispatch.

The fixed targets are `spec-sync.yml`, `zendev-author.yml` and
`zendev-acceptor.yml`, in the repository the watchdog runs in, branch `master` only.
The repository is read from the run, never compared to a name — see
[Renaming the repository](#renaming-the-repository). For each target the dispatcher:

1. Respects `ZENDEV_ENABLED` and refuses to re-enable a disabled workflow.
2. Checks all queued, running, pending, requested and waiting runs, including old
   approvals. If any exist, it leaves the workflow alone.
3. Checks runs created in the previous hour. Every attempt counts, including failed,
   cancelled and skipped runs; a permanent failure must not cause a paid retry storm.
4. Rechecks eligibility and submits one dispatch only if no run was created within
   the hour. Missed historical hours are not replayed.

All normal hourly workers have one producer, and watchdog concurrency serializes its
passes. An operator can still explicitly dispatch/re-run a worker at any time. The
API's read and dispatch operations are not atomic, so a simultaneous operator action
can race the last check; per-role concurrency prevents parallel execution, not an
extra queued unit. A re-run of an old run preserves its original creation timestamp:
it blocks dispatch while active but does not reset the creation-based hourly cooldown.

The three roles remain independent; dispatch submission order is not a promise that
sync finishes before author or author finishes before acceptor. Review always checks
the actual PR and its exact-head CI. A PR produced after an acceptor selection is
eligible at a later acceptor run, just as with the former independent schedules.

## Limits and diagnosis

This is **GitHub-only best-effort recovery**, not a guarantee of hourly delivery.
GitHub explicitly permits delayed/dropped scheduled events:
[GitHub troubleshooting](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflows-running-at-unexpected-times).
Multiple wakeups provide additional opportunities after a missed event. If delivered
normally, a due workflow is found on the next probe (up to about 15 minutes after its
one-hour cooldown). If all cron events stop arriving, this dispatcher also stops.
It cannot report its own absence or repair GitHub's internal scheduler.

On 2026-09-04, before the repair:

- author: 04:36 -> 09:41 UTC despite hourly cron;
- acceptor: 01:19 -> 06:30 UTC despite hourly cron;
- sync: 04:20 -> 09:31 UTC despite hourly cron;
- all workflows were active, `ZENDEV_ENABLED=true`, no intervening queued/active runs;
- manual sync [33863818038](https://github.com/drevendev/trade_simulation/actions/runs/33863818038)
  started within seconds and passed;
- manual author [33863856193](https://github.com/drevendev/trade_simulation/actions/runs/33863856193)
  produced PR #35, demonstrating that dispatch could resume useful work.

The observed fault is missing/delayed schedule delivery, not a five-hour job. Its
precise internal GitHub cause is unknown; no matching public incident was reported.
Changing a cron minute alone would not establish that the problem was repaired.

Distinguish three signals:

- **Cadence:** are worker run creation timestamps no more than roughly 60-75 minutes
  apart when no run is active? A longer gap needs investigation.
- **Execution:** did the workflow/job finish without a technical failure?
- **Progress:** did an issue advance or a PR get created/accepted? A green model
  invocation may honestly report a blocker and produce no product change.

The watchdog's summary lists `due`, `recent`, `active`, `disabled` or `dispatched`.
`dispatched` means the API accepted the request, not that the target completed.
An API error or incomplete history fails the watchdog visibly; it is never treated
as an empty queue. A dispatch timeout is not immediately retried because the server
may already have accepted it. A later pass reads current history again.

## Cadence

`ZENDEV_INTERVAL_MINUTES` is a repository variable holding the minimum gap between two
dispatches of the same workflow. Unset means 60. The accepted range is 15 to 360; a
missing, malformed or out-of-range value falls back to 60 and says so in the run
summary, because a typo must never widen the cadence silently.

This is the **only ceiling on how often paid model runs start**. Whatever wakes this
dispatcher — GitHub cron, a manual dispatch, an external timer — cannot make a target
run sooner than the interval allows. Set the cadence here; set the poke frequency
wherever the timer lives.

```sh
gh variable set ZENDEV_INTERVAL_MINUTES -R drevendev/trade_simulation --body "30"
```

Cost scales roughly linearly with it. Measured on 2026-09-04: an author run averaged
$0.96 and an acceptor run $0.42, so halving the interval roughly doubles the ceiling.
An idle acceptor is cheap (about $0.07); an idle author is not, because an empty queue
sends it to create one ready Issue rather than to stop.

## External timer

GitHub cron delivery has been unreliable for this repository, and the watchdog runs on
the same scheduler it is meant to repair. An external timer that pokes
`zendev-watchdog.yml` via `workflow_dispatch` removes that shared dependency.

The timer is deliberately dumb: it decides nothing and holds no cadence. Every
admission check — the `ZENDEV_ENABLED` switch, the interval cooldown, the active-run
check, fail-closed on API trouble — stays here, tested, in the repository. Poking more
often than `ZENDEV_INTERVAL_MINUTES` allows is harmless and changes nothing.

Before enabling one, record its owner, its least-authority credential, how overlap is
prevented, its retry bound, how to disable and revoke it, and the observation window
that will decide whether it worked. A timer that nobody can turn off is worse than a
missed schedule.

## Permissions and opt-out

The watchdog uses the ephemeral repository `GITHUB_TOKEN` with `actions: write` and
`contents: read`. It receives no model token, Drive credential or GitHub App key.
GitHub permits `workflow_dispatch` from `GITHUB_TOKEN` to create a new run:
[Triggering workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
The roles it dispatches act through their own GitHub Apps
([ADR 0006](../adr/0006-github-apps-as-loop-identities.md)); the workflow-file push
permission problem once tracked by Issue #33 is resolved by the AUTHOR app's Workflows
permission, not by anything the watchdog holds.

The Actions `vars` context supplies `ZENDEV_ENABLED` to the script; the default
`GITHUB_TOKEN` is not given extra access to the repository Variables API. Local
diagnostics instead query that API using the operator's existing `gh` login.

Set `ZENDEV_ENABLED=false` or disable the watchdog workflow to stop future automatic
dispatch. Already queued/running work is not cancelled. Explicit operator dispatches
retain their existing opt-out override for maintenance. Do not disable any worker
workflow expecting the watchdog to re-enable it: disabled targets stay disabled.

## Verification and recovery

Read-only local diagnostics (requires Python and authenticated GitHub CLI):

```sh
python scripts/schedule_watchdog.py
```

After the policy PR has been independently accepted into `master`:

```sh
# Read-only workflow smoke: no paid agent dispatches.
gh workflow run zendev-watchdog.yml -R drevendev/trade_simulation -r master -f dispatch=false
# Explicitly recover only due workers, using the same admission checks.
gh workflow run zendev-watchdog.yml -R drevendev/trade_simulation -r master -f dispatch=true
```

Inspect the returned run and its summary, then observe at least two **scheduled**
watchdog executions and subsequent worker timestamps. A manual smoke is not evidence
that cron is delivering events. The workflow deliberately refuses execution on a
PR branch; local unit tests/mock dispatches and dry-run diagnostics verify pre-merge
behavior without letting unaccepted scheduling policy launch agents.

Rollback is a reviewed revert restoring the three former cron entries and removing
the watchdog together. Do not run both automatic scheduling schemes concurrently.
An independent external timer is the next option if GitHub-only gaps persist; no
external service is installed or configured by this change.

## Renaming the repository

The repository's name is not load-bearing anywhere in the loop. Workflows read it from
`github.repository`; the dispatcher reads `GITHUB_REPOSITORY`; every script takes
`--repo` from the workflow. A test refuses a workflow condition or a script that compares
the name to a literal. This is the lesson of 2026-09-05, when a rename in case only —
`trade_simulation` to `Trade_Simulation` — made a strict comparison in the dispatcher
refuse every tick for as long as the spelling differed, while GitHub itself routed both
spellings to the same repository.

A rename therefore does not stop the loop, but it still touches things outside the
loop's control, and they are listed here so the next rename is a checklist rather than
a discovery:

- **GitHub Pages moves and does not redirect.** The site lives at
  `https://<owner>.github.io/<repository>/`; the old address answers 404 the moment the
  rename lands, even for a change of case. Links in `README.md` and `docs/spec/` that
  name the site must be edited.
- **Raw links held by the researcher.** The return channel is read over
  `raw.githubusercontent.com/<owner>/<repository>/master/docs/spec/...` from the
  researcher's own manifest. GitHub redirects web, git and API requests for a renamed
  repository; whether raw requests follow is not something to rely on. Tell the
  researcher through `FEEDBACK_TO_RESEARCHER.md` before renaming, with the new links.
- **The external timer.** Its `REPO` constant names this repository, and a
  `workflow_dispatch` is a POST: an HTTP client that turns a redirected POST into a GET
  pokes nothing. Update the constant when renaming.
- **Local clones and worktrees.** Git follows the redirect; updating the remote is
  hygiene, not repair.
- **Text.** Mentions in this document's examples, the ADRs and the telemetry
  repository's README are descriptions, not dependencies.

Unaffected: the three GitHub App installations (bound to the repository's id), secrets,
variables, branch protection, Issue and pull request numbers, run history, and the
`run_url` fields in the ledger, which redirect.

Order for a deliberate rename: rename; update the timer's constant; append the new links
to the researcher's channel; edit the Pages links; watch one watchdog tick and one mirror
sync. Nothing in this repository has to change first.
