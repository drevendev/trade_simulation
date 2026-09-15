"""Recover missed ZenDev dispatches; dry-run unless --dispatch is explicit.

Only the repository this runs in, its master branch and three existing workflows are
allowed. No model runs here. A model role the active scheme declares without a model
is never dispatched: the descriptor is the switch. A successful dispatch is not a successful unit of product
work. A run that GitHub lists as queued but never starts is abandoned after
STALE_QUEUE, so a role frozen by the forge thaws on its own instead of waiting for
an operator.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlencode

import schemes

# The repository this dispatcher acts on. Inside Actions it is the one the workflow
# runs in, read from the environment, so renaming the repository changes nothing here.
# A literal once did the opposite: on 2026-09-05 a rename in case only turned every
# tick into a refusal for as long as the spelling differed (#171). Outside Actions the
# caller names it with --repo; the default is a developer convenience for this project,
# and nothing else depends on it.
DEFAULT_REPOSITORY = "drevendev/trade_simulation"
REPOSITORY = os.environ.get("GITHUB_REPOSITORY") or DEFAULT_REPOSITORY
BRANCH = "master"
# Model-running targets alternate, at most one dispatched per pass. spec-sync runs no
# model and stays outside that rotation, dispatched every pass like before.
MODEL_TARGETS = ("zendev-author.yml", "zendev-acceptor.yml")
TARGETS = ("spec-sync.yml",) + MODEL_TARGETS
# The role each model target runs, as the scheme descriptor names it.
ROLE_OF = {"zendev-author.yml": "author", "zendev-acceptor.yml": "acceptor"}
ACTIVE_STATUSES = ("queued", "in_progress", "waiting", "pending", "requested")
# A run listed as queued, pending or requested that has not started after this long
# is not going to. No job on this repository legitimately waits an hour for a
# runner, and the longest a run can wait behind its own concurrency group is the
# 45-minute job timeout of its predecessor. On 2026-09-13 the AUTHOR run dispatched
# inside a GitHub incident (09:16Z-10:44Z, Actions degraded) stayed `queued` with no
# jobs for days, and because every nonterminal status counted as activity the AUTHOR
# was never dispatched again: a frozen role, reported as a busy one. `waiting` (an
# approval gate, a human decision) and `in_progress` (bounded by the job timeout)
# are deliberately not on this list.
STALE_STATUSES = ("queued", "pending", "requested")
STALE_QUEUE = timedelta(minutes=60)

# Minimum gap between two dispatches of the same workflow. This is the only ceiling
# on how often paid model runs start: an external timer may poke this dispatcher as
# often as it likes and cannot make a target run sooner than this.
INTERVAL = timedelta(hours=1)
# Operator range. Below the floor a slow run would be overtaken by its own successor;
# above the ceiling the loop is not usefully scheduled at all.
MIN_INTERVAL = timedelta(minutes=15)
MAX_INTERVAL = timedelta(hours=6)


def api(path: str, *, payload: dict | None = None):
    command = ["gh", "api", "--hostname", "github.com", path]
    data = None
    if payload is not None:
        command += ["--method", "POST", "--input", "-"]
        data = json.dumps(payload)
    result = subprocess.run(
        command,
        input=data,
        capture_output=True,
        text=True,
        timeout=30,
        # See the note in machine_pr_guard.py: decoding by locale turns a non-ASCII
        # byte in a forge response into a failure several frames away from its cause.
        encoding="utf-8",
    )
    if result.returncode:
        # Never echo token-bearing command environments or arbitrary server output.
        raise RuntimeError(f"GitHub API request failed (gh exit {result.returncode})")
    if payload is not None:
        return None  # Successful dispatch responses may have no body.
    return json.loads(result.stdout)


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("GitHub timestamp must include a timezone")
    return parsed


def read_runs(endpoint: str, **filters) -> list[dict]:
    """Return a complete filtered list, or fail closed on truncation/schema drift."""
    runs = []
    for page in range(1, 11):
        query = urlencode({"branch": BRANCH, "per_page": 100, "page": page, **filters})
        response = api(f"{endpoint}/runs?{query}")
        total = response["total_count"]
        batch = response["workflow_runs"]
        if not isinstance(total, int) or total < 0 or not isinstance(batch, list):
            raise ValueError("Invalid workflow history response")
        runs.extend(batch)
        if len(runs) >= total:
            return runs
        if not batch:
            break
    raise RuntimeError("Incomplete workflow history; refusing to dispatch")


def stale_runs(runs: list[dict], now: datetime) -> list[dict]:
    """Runs GitHub lists as not yet started for longer than STALE_QUEUE."""
    return [run for run in runs
            if run["status"] in STALE_STATUSES
            and now - timestamp(run["created_at"]) >= STALE_QUEUE]


def abandon_run(run_id: int) -> str:
    """Ask GitHub to end a run that never started, and say what happened either way.

    A plain cancel is refused for a run GitHub already considers finished while it
    still lists it as queued (the 2026-09-13 ghost answered "Cannot cancel a workflow
    run that is completed"); force-cancel exists for exactly that state. Neither
    refusal is a reason to keep the role frozen: the outcome is reported and the run
    is left out of the picture regardless. The target's own concurrency group
    serialises a duplicate, so dispatching next to a ghost can at worst wait, never
    run twice at once.
    """
    for verb in ("cancel", "force-cancel"):
        try:
            api(f"repos/{REPOSITORY}/actions/runs/{run_id}/{verb}", payload={})
        except RuntimeError:
            continue
        return f"{verb} requested"
    return "GitHub refused both cancel and force-cancel; left out of the picture"


def inspect_target(target: str, now: datetime, interval: timedelta = INTERVAL,
                   *, recover: bool = False) -> dict:
    if target not in TARGETS:
        raise ValueError("Workflow is not allowlisted")
    endpoint = f"repos/{REPOSITORY}/actions/workflows/{target}"
    workflow = api(endpoint)
    if workflow["state"] != "active":
        return {"workflow": target, "decision": "disabled"}

    # Query every nonterminal state, including approvals and old queued runs.
    # Filtering by a recent date alone could overlook an old waiting job.
    active = []
    for status in ACTIVE_STATUSES:
        active.extend(read_runs(endpoint, status=status))
    for run in active:
        if run["head_branch"] != BRANCH or run["workflow_id"] != workflow["id"]:
            raise ValueError("Workflow history is outside the requested target")

    # A run stuck in the queue is not activity. A dry run reports it; a recovery
    # pass abandons it, so the target is judged on the runs that can still happen.
    stale = stale_runs(active, now)
    abandoned = []
    if stale and recover:
        for run in stale:
            outcome = abandon_run(run["id"])
            abandoned.append({"run_id": run["id"], "outcome": outcome})
            print(f"::warning::{target}: run {run['id']} has been {run['status']} since "
                  f"{run['created_at']} without starting; {outcome}", flush=True)
        left_out = {entry["run_id"] for entry in abandoned}
        active = [run for run in active if run["id"] not in left_out]

    def done(result: dict) -> dict:
        if abandoned:
            result["abandoned"] = abandoned
        return result

    if active:
        result = {"workflow": target, "decision": "active", "run_ids": [r["id"] for r in active]}
        if stale and not recover:
            result["stale_run_ids"] = [r["id"] for r in stale]
        return done(result)

    # Failed/cancelled attempts count too: do not turn a permanent failure into
    # a paid retry storm. No historic catch-up; at most one dispatch per target.
    recent = read_runs(endpoint, created=">=" + (now - interval).isoformat())
    for run in recent:
        if run["head_branch"] != BRANCH or run["workflow_id"] != workflow["id"]:
            raise ValueError("Workflow history is outside the requested target")
    left_out = {entry["run_id"] for entry in abandoned}
    recent = [run for run in recent if run["id"] not in left_out]
    for run in recent:
        if run["status"] != "completed":
            return done({"workflow": target, "decision": "active", "run_ids": [run["id"]]})
    latest = max(recent, key=lambda r: timestamp(r["created_at"]), default=None)
    if latest is not None and now - timestamp(latest["created_at"]) < interval:
        return done({"workflow": target, "decision": "recent", "run_id": latest["id"],
                     "created_at": latest["created_at"], "conclusion": latest["conclusion"]})
    return done({"workflow": target, "decision": "due"})


def last_run_time(target: str) -> datetime | None:
    """The most recent run of `target` on the trusted branch, of any status.

    Used only to break a tie between two simultaneously due model targets — never to
    decide whether a target itself is due, which stays `inspect_target`'s job.
    """
    endpoint = f"repos/{REPOSITORY}/actions/workflows/{target}"
    query = urlencode({"branch": BRANCH, "per_page": 1, "page": 1})
    response = api(f"{endpoint}/runs?{query}")
    batch = response.get("workflow_runs") if isinstance(response, dict) else None
    if not isinstance(batch, list):
        raise ValueError("Invalid workflow history response")
    if not batch:
        return None
    run = batch[0]
    if run["head_branch"] != BRANCH:
        raise ValueError("Workflow history is outside the requested target")
    return timestamp(run["created_at"])


def select_model_target(candidates: list[str]) -> str:
    """Among due model targets, choose the one run least recently.

    No turn is stored: each pass recomputes the choice from actual run history, so
    consecutive passes alternate for as long as both stay due. A target that has never
    run sorts oldest. A genuine tie (including "neither has ever run") breaks by
    `MODEL_TARGETS` declaration order, deterministically.
    """
    ages = {target: last_run_time(target) for target in candidates}
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    return min(
        candidates,
        key=lambda target: (ages[target] or epoch, MODEL_TARGETS.index(target)),
    )


def active_scheme():
    """The active descriptor in docs/zendev/schemes.json, or None when it cannot be read."""
    try:
        return schemes.active(schemes.load())
    except (OSError, ValueError):
        return None


def model_targets_off(scheme) -> dict[str, str]:
    """The model targets the active scheme does not run, each with its reason. Pure.

    A scheme names the model each role runs. A role declared without one — the AUTHOR
    under scheme/7, where the researcher writes the code as a person would — has no run
    to dispatch, and dispatching it anyway would start a paid run to discover that. So
    the descriptor is the switch, not a repository variable: it is reviewed, tagged, and
    carried by every telemetry record, so a window sliced by scheme also says which
    roles were running in it.

    Fails closed. A descriptor that cannot be read switches every model target off and
    says so in the report. A frozen loop shows in the next pass; a role resurrected by a
    malformed file is a day of spend nobody asked for.
    """
    if not scheme:
        reason = "the active scheme could not be read; no model role runs until it can"
        return {target: reason for target in MODEL_TARGETS}
    roles = scheme.get("roles") or {}
    off = {}
    for target in MODEL_TARGETS:
        role = ROLE_OF[target]
        declared = roles.get(role)
        if not isinstance(declared, dict):
            off[target] = f"{scheme.get('id')} names no {role} role"
        elif not declared.get("model"):
            off[target] = f"{scheme.get('id')} runs no model for the {role}"
    return off


def resolve_interval() -> timedelta:
    """Read the operator cadence, falling back to the default on anything unusable.

    A malformed or out-of-range value must never widen the cadence silently, so it
    falls back to the conservative default rather than to the caller's intent.
    """
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raw = os.environ.get("ZENDEV_INTERVAL_MINUTES", "")
    else:
        try:
            raw = api(f"repos/{REPOSITORY}/actions/variables/ZENDEV_INTERVAL_MINUTES")["value"]
        except (RuntimeError, ValueError, KeyError, TypeError):
            return INTERVAL
    if not raw.strip():
        return INTERVAL
    try:
        minutes = int(raw.strip())
    except ValueError:
        print(f"::warning::ZENDEV_INTERVAL_MINUTES is not an integer; using {INTERVAL}")
        return INTERVAL
    candidate = timedelta(minutes=minutes)
    if not MIN_INTERVAL <= candidate <= MAX_INTERVAL:
        print(f"::warning::ZENDEV_INTERVAL_MINUTES out of range; using {INTERVAL}")
        return INTERVAL
    return candidate


def resolve_repository(explicit: str | None) -> str:
    """The repository to act on: the run's own inside Actions, the caller's outside.

    Inside Actions the environment is authoritative, and an --repo that disagrees with
    it is refused: a dispatcher must never be pointed at a repository it does not run
    in. Names compare case-insensitively, because GitHub routes them that way and
    reports whichever spelling the repository currently carries.
    """
    if os.environ.get("GITHUB_ACTIONS") == "true":
        actual = os.environ.get("GITHUB_REPOSITORY", "")
        if not actual:
            raise ValueError("GITHUB_REPOSITORY is not set; refusing to guess the repository")
        if explicit and explicit.lower() != actual.lower():
            raise ValueError("--repo names a repository other than the one this workflow runs in")
        return actual
    return explicit or DEFAULT_REPOSITORY


def is_enabled() -> bool:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # GITHUB_TOKEN does not grant repository Variables API access. The
        # workflow passes the trusted vars context instead; do not add a PAT.
        #
        # Only the branch is checked. The repository is compared to nothing: this
        # dispatcher acts on the repository it runs in, whatever that is called today.
        if os.environ.get("GITHUB_REF") != f"refs/heads/{BRANCH}":
            raise ValueError("Dispatcher can only execute on master")
        return os.environ.get("ZENDEV_ENABLED") == "true"
    return api(f"repos/{REPOSITORY}/actions/variables/ZENDEV_ENABLED")["value"] == "true"


def run(*, dispatch: bool = False, now: datetime | None = None,
        interval: timedelta = INTERVAL) -> list[dict]:
    """The caller resolves the cadence, so this adds no API call of its own."""
    if not is_enabled():
        return [{"decision": "disabled", "reason": "ZENDEV_ENABLED is not true"}]
    when = now or datetime.now(timezone.utc)
    off = model_targets_off(active_scheme())
    # Only a recovery pass may abandon a stale run; diagnostics never touch the forge.
    # A target the scheme switched off is reported and never inspected: there is
    # nothing to recover for a role that does not run.
    results = {}
    for target in TARGETS:
        if target in off:
            results[target] = {"workflow": target, "decision": "off", "reason": off[target]}
        else:
            results[target] = inspect_target(target, when, interval, recover=dispatch)

    if dispatch:
        # At most one model target dispatches per pass. When both are simultaneously
        # due, defer the one run more recently rather than starting two at once. Dry
        # runs skip this: it costs an extra API call, and nothing is dispatched anyway.
        due_model_targets = [t for t in MODEL_TARGETS if results[t]["decision"] == "due"]
        if len(due_model_targets) > 1:
            chosen = select_model_target(due_model_targets)
            for target in due_model_targets:
                if target != chosen:
                    results[target] = {
                        "workflow": target,
                        "decision": "deferred",
                        "reason": "alternation: yielding this pass to the model target that ran less recently",
                    }

    ordered = []
    for target in TARGETS:
        result = results[target]
        if result["decision"] == "due" and dispatch:
            # Re-read immediately before POST to reduce races with an operator's
            # manual dispatch. Cross-workflow API operations are not atomic.
            if not is_enabled():
                result = {"workflow": target, "decision": "disabled"}
                ordered.append(result)
                break
            result = inspect_target(target, when, interval, recover=dispatch)
            if result["decision"] == "due":
                api(f"repos/{REPOSITORY}/actions/workflows/{target}/dispatches",
                    payload={"ref": BRANCH})
                result["decision"] = "dispatched"
                # Emit immediately: retain a receipt if a later target fails.
                print(json.dumps(result), flush=True)
        ordered.append(result)
    return ordered


def main() -> int:
    global REPOSITORY
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dispatch", action="store_true")
    parser.add_argument(
        "--repo",
        default=None,
        help="owner/name for local diagnostics; inside Actions the run's own repository is used",
    )
    args = parser.parse_args()
    try:
        REPOSITORY = resolve_repository(args.repo)
    except ValueError as error:
        print(f"::error::Watchdog failed closed: {error}", flush=True)
        return 1
    try:
        interval = resolve_interval()
        results = run(dispatch=args.dispatch, interval=interval)
        minutes = int(interval.total_seconds() // 60)
        report = (
            "## ZenDev scheduling watchdog\n\n"
            f"Dispatch interval: {minutes} minutes.\n\n"
            "```json\n" + json.dumps(results, indent=2) + "\n```\n"
        )
        print(report)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as summary:
                summary.write(report)
        return 0
    except (RuntimeError, ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"::error::Watchdog failed closed: {type(error).__name__}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
