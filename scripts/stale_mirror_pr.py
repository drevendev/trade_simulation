"""Close a refused mirror proposal that nothing else can release, so the producer can
propose again.

A machine-generated pull request is accepted by mechanical gates and merged by branch
protection; no agent reviews it and no agent may push to its branch. That is the
class's whole point, and it has one consequence the class cannot recover from on its
own: when a gate refuses the proposal, nothing releases it. Re-running the checks
replays the workflow definition their run started with, so even a fix to the gate,
merged on ``master``, leaves the proposal red. #109 and #112 each sat that way until a
person closed them by hand, and the specification pipeline stalled for about half an
hour both times.

The producer can do that closing itself. Every sync, before proposing, it asks one
question about the open proposal on its branch: has it carried a *concluded* red check
for longer than a bound? If so, the proposal is closed with a comment saying why, its
branch is deleted, and the proposal step that follows opens a fresh one from the
current mirror under the current checks. A pending or green proposal is left alone, and
so is a red one younger than the bound — checks take minutes to settle, and a young red
is more likely a check still running than a refusal.

The bound is what keeps this honest. A proposal red for a real reason — content outside
the allowlist, say — will be closed and re-proposed every time the bound elapses, and
be red again. That churn is visible, harmless, and still an operator matter: the cause
has to be fixed by a person, exactly as before. What changes is that a cause already
fixed no longer needs a person to notice.

Exit code is 0 whatever the decision. The decision itself is printed, and the
proposal's own state is the record.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys

import machine_pr_guard

MIN_AGE = dt.timedelta(minutes=90)

# Concluded and red. `CANCELLED` is not here — a cancelled run says a newer one
# superseded it, not that the proposal failed — and neither is `ACTION_REQUIRED`, which
# asks a person to approve a run, not to repair a proposal.
RED = frozenset({"FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"})


def default_branch() -> str:
    """The mirror class's branch, taken from the one definition of the class."""
    for cls in machine_pr_guard.MACHINE_CLASSES:
        if cls.producer.endswith("spec-sync.yml"):
            return cls.branch
    return machine_pr_guard.MACHINE_CLASSES[0].branch


def red_checks(pull):
    """Names of the checks that have concluded red on the proposal's head."""
    names = []
    for check in pull.get("statusCheckRollup") or []:
        outcome = (check.get("conclusion") or check.get("state") or "").upper()
        if outcome in RED:
            names.append(check.get("name") or check.get("context") or "?")
    return names


def decide(pull, head_committed_at, now, min_age=MIN_AGE):
    """(close, reason). Pure: no network, no clock of its own."""
    if pull is None:
        return False, "no open proposal"
    red = red_checks(pull)
    if not red:
        return False, "no concluded red check; a pending or green proposal is left alone"
    age = now - head_committed_at
    minutes = int(age.total_seconds() // 60)
    if age < min_age:
        return False, (
            "red (%s) but the head is only %d min old; letting the checks settle"
            % (", ".join(red), minutes)
        )
    return True, "red for %d min: %s" % (minutes, ", ".join(red))


def closing_comment(reason: str) -> str:
    return (
        "Closed by the producer, not by a reviewer.\n\n"
        "This proposal has been %s. Nothing may push to its branch, and re-running its "
        "checks would replay the definition that refused it, so it cannot be released "
        "from here. The next sync proposes the current mirror afresh under the current "
        "checks.\n\n"
        "If the new proposal is red as well, the cause is real and a person owns it — "
        "see docs/zendev/MACHINE_PULL_REQUESTS.md, *Recovering one*." % reason
    )


def timestamp(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("GitHub timestamp must include a timezone")
    return parsed


def _gh(args):
    # UTF-8 explicitly, not by locale: see the note in machine_pr_guard.py.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def load_open_proposal(repo: str, branch: str):
    raw = _gh(
        [
            "pr",
            "list",
            "--repo",
            repo,
            "--head",
            branch,
            "--state",
            "open",
            "--json",
            "number,headRefOid,statusCheckRollup,url",
        ]
    )
    pulls = json.loads(raw)
    return pulls[0] if pulls else None


def head_committed_at(repo: str, sha: str) -> dt.datetime:
    raw = _gh(["api", f"repos/{repo}/commits/{sha}"])
    return timestamp(json.loads(raw)["commit"]["committer"]["date"])


def close(repo: str, number: int, comment: str) -> None:
    _gh(
        [
            "pr",
            "close",
            str(number),
            "--repo",
            repo,
            "--comment",
            comment,
            "--delete-branch",
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--branch", default=default_branch(), help="the machine branch")
    parser.add_argument("--min-age-minutes", type=int, default=int(MIN_AGE.total_seconds() // 60))
    parser.add_argument("--dry-run", action="store_true", help="decide, but close nothing")
    args = parser.parse_args()

    try:
        pull = load_open_proposal(args.repo, args.branch)
        committed = head_committed_at(args.repo, pull["headRefOid"]) if pull else None
    except (subprocess.CalledProcessError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"::warning::stale-mirror-pr: could not read the proposal: {type(error).__name__}")
        return 0

    close_it, reason = decide(
        pull, committed, dt.datetime.now(dt.timezone.utc), dt.timedelta(minutes=args.min_age_minutes)
    )
    number = pull["number"] if pull else None
    if not close_it:
        print(f"stale-mirror-pr: leaving #{number} alone: {reason}" if pull else f"stale-mirror-pr: {reason}")
        return 0
    if args.dry_run:
        print(f"stale-mirror-pr: would close #{number}: {reason}")
        return 0
    try:
        close(args.repo, number, closing_comment(reason))
    except subprocess.CalledProcessError as error:
        print(f"::warning::stale-mirror-pr: could not close #{number} (gh exit {error.returncode})")
        return 0
    print(f"stale-mirror-pr: closed #{number}: {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
