"""Recover missed ZenDev dispatches; dry-run unless --dispatch is explicit.

Only the fixed repository, master branch and three existing workflows are allowed.
No model runs here. A successful dispatch is not a successful unit of product work.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlencode

REPOSITORY = "drevendev/trade_simulation"
BRANCH = "master"
TARGETS = ("spec-sync.yml", "zendev-author.yml", "zendev-acceptor.yml")
ACTIVE_STATUSES = ("queued", "in_progress", "waiting", "pending", "requested")

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
        command, input=data, capture_output=True, text=True, timeout=30
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


def inspect_target(target: str, now: datetime, interval: timedelta = INTERVAL) -> dict:
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
    if active:
        return {"workflow": target, "decision": "active", "run_ids": [r["id"] for r in active]}

    # Failed/cancelled attempts count too: do not turn a permanent failure into
    # a paid retry storm. No historic catch-up; at most one dispatch per target.
    recent = read_runs(endpoint, created=">=" + (now - interval).isoformat())
    for run in recent:
        if run["head_branch"] != BRANCH or run["workflow_id"] != workflow["id"]:
            raise ValueError("Workflow history is outside the requested target")
        if run["status"] != "completed":
            return {"workflow": target, "decision": "active", "run_ids": [run["id"]]}
    latest = max(recent, key=lambda r: timestamp(r["created_at"]), default=None)
    if latest is not None and now - timestamp(latest["created_at"]) < interval:
        return {"workflow": target, "decision": "recent", "run_id": latest["id"],
                "created_at": latest["created_at"], "conclusion": latest["conclusion"]}
    return {"workflow": target, "decision": "due"}


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


def is_enabled() -> bool:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # GITHUB_TOKEN does not grant repository Variables API access. The
        # workflow passes the trusted vars context instead; do not add a PAT.
        if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
                or os.environ.get("GITHUB_REF") != f"refs/heads/{BRANCH}"):
            raise ValueError("Dispatcher can only execute on the canonical master")
        return os.environ.get("ZENDEV_ENABLED") == "true"
    return api(f"repos/{REPOSITORY}/actions/variables/ZENDEV_ENABLED")["value"] == "true"


def run(*, dispatch: bool = False, now: datetime | None = None,
        interval: timedelta = INTERVAL) -> list[dict]:
    """The caller resolves the cadence, so this adds no API call of its own."""
    if not is_enabled():
        return [{"decision": "disabled", "reason": "ZENDEV_ENABLED is not true"}]
    results = []
    for target in TARGETS:
        result = inspect_target(target, now or datetime.now(timezone.utc), interval)
        if result["decision"] == "due" and dispatch:
            # Re-read immediately before POST to reduce races with an operator's
            # manual dispatch. Cross-workflow API operations are not atomic.
            if not is_enabled():
                results.append({"workflow": target, "decision": "disabled"})
                break
            result = inspect_target(target, now or datetime.now(timezone.utc), interval)
            if result["decision"] == "due":
                api(f"repos/{REPOSITORY}/actions/workflows/{target}/dispatches",
                    payload={"ref": BRANCH})
                result["decision"] = "dispatched"
                # Emit immediately: retain a receipt if a later target fails.
                print(json.dumps(result), flush=True)
        results.append(result)
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dispatch", action="store_true")
    args = parser.parse_args()
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
