"""Report, as a commit status, whether an open pull request still merges cleanly.

A pull request stops being mergeable when its *base* moves, not when the pull request
itself changes. GitHub's own pull request checks do not re-run on a push to `master`,
so a branch that conflicted an hour ago still shows the green checks it earned before
the conflict existed. Nothing in the loop noticed that, and the discovery fell to an
ACCEPTOR run — which spends a model run and half an hour to learn something the forge
already knew.

This script closes that. It reads mergeability from the API and writes a commit
status named `mergeability` onto the pull request's head revision, so the answer is
visible where every other gate is visible, at the moment the base moves.

Three outcomes, and the third is the point:

* the pull request merges cleanly    -> `success`
* it conflicts with its base         -> `failure`
* GitHub has not computed it yet     -> `pending`, never `success`

An unknown answer is not a passing answer. GitHub computes mergeability lazily and
reports `null` while it works; treating that as green would make the check report
health it never observed, which is the failure mode the check exists to prevent.
`pending` is honest, and the next push to either branch re-evaluates it.

This check reports conflicts and nothing else. Whether the tests pass, the policy
guard is happy, or the review is done are other checks' business — a check that
answers more than one question cannot be read.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

CONTEXT = "mergeability"

# The API caps a status description; a truncated sentence reads as a bug in the check.
MAX_DESCRIPTION = 140


# The base moved and this branch has not caught up. It merges cleanly, but its green
# checks were measured against a base that no longer exists, so they say nothing about
# what would actually land — the case where two changes are textually independent and
# semantically not.
#
# Reported as a failure rather than left to branch protection's "require branches to be
# up to date". That setting blocks the merge and produces no check, so the branch shows
# nothing red: selection would keep offering it and the AUTHOR's own "open pull request
# with a failing required check" rule would match nothing. It would belong to no queue,
# which is the trap this control plane has already had to close once. A red check
# blocks the same merge and routes the work.
STALE_BASE = "behind"


def classify(mergeable, mergeable_state):
    """Map the API's answer to (state, description). Pure."""
    if mergeable is False:
        return (
            "failure",
            f"conflicts with the base branch ({mergeable_state}); rebase and push",
        )
    if mergeable is True and mergeable_state == STALE_BASE:
        return (
            "failure",
            "the base has moved since this branch was measured; update the branch",
        )
    if mergeable is True:
        return ("success", f"merges cleanly into the base branch ({mergeable_state})")
    return (
        "pending",
        "mergeability not yet computed by GitHub; re-evaluated on the next push",
    )


def _gh(args):
    # UTF-8 explicitly, not by locale. Without it Python decodes with the platform's
    # preferred encoding, which on a Windows console is cp1252: a comment or title
    # holding an em dash then raises inside the reader thread, `stdout` comes back as
    # None, and the caller fails several frames later on something that looks unrelated.
    # The runner's UTF-8 locale hides this, so it only ever appears off the runner —
    # where the control plane is developed. Same fix as machine_pr_guard.py carries.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def read_pull(repo: str, number: int):
    """Return (head_sha, mergeable, mergeable_state) for one pull request."""
    raw = _gh(["api", f"repos/{repo}/pulls/{number}"])
    data = json.loads(raw)
    return data["head"]["sha"], data.get("mergeable"), data.get("mergeable_state")


def resolve(repo: str, number: int, attempts: int, delay: float):
    """Read mergeability, giving GitHub a bounded chance to finish computing it."""
    head_sha = mergeable = state = None
    for attempt in range(attempts):
        head_sha, mergeable, state = read_pull(repo, number)
        if mergeable is not None:
            break
        if attempt + 1 < attempts:
            time.sleep(delay)
    return head_sha, mergeable, state


def post_status(repo: str, sha: str, state: str, description: str) -> None:
    _gh(
        [
            "api",
            "-X",
            "POST",
            f"repos/{repo}/statuses/{sha}",
            "-f",
            f"state={state}",
            "-f",
            f"context={CONTEXT}",
            "-f",
            f"description={description[:MAX_DESCRIPTION]}",
        ]
    )


def open_pull_numbers(repo: str):
    raw = _gh(["api", f"repos/{repo}/pulls?state=open&per_page=100"])
    return [int(pull["number"]) for pull in json.loads(raw)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pull", type=int, help="one pull request number")
    group.add_argument(
        "--all-open",
        action="store_true",
        help="every open pull request; use when the base branch moved",
    )
    parser.add_argument("--attempts", type=int, default=8)
    parser.add_argument("--delay", type=float, default=4.0)
    args = parser.parse_args()

    numbers = [args.pull] if args.pull else open_pull_numbers(args.repo)

    conflicted = []
    for number in numbers:
        head_sha, mergeable, state = resolve(
            args.repo, number, args.attempts, args.delay
        )
        status, description = classify(mergeable, state)
        post_status(args.repo, head_sha, status, description)
        print(f"{CONTEXT}: #{number} {head_sha[:8]} -> {status} ({description})")
        if status == "failure":
            conflicted.append(number)

    # Exit 0 either way. The verdict for a pull request is the status written onto it,
    # not this run's own conclusion: a red run over a list of pull requests says
    # nothing about which one is broken, and a red run on the base branch would
    # report the repository as unhealthy because one branch drifted.
    if conflicted:
        print(f"::notice::{CONTEXT}: conflicting pull request(s): {conflicted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
