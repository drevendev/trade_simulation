"""Bring a loop branch that is merely behind its base up to date, without a model run.

`mergeability` reports two red conditions. `dirty` is a conflict and needs a person or
a model to resolve. `behind` is not: the branch merges cleanly, its checks were simply
measured against a base that has since moved, and the repair is one merge commit of the
base into the branch. Until now that merge cost a full AUTHOR run — the role's own
ladder picks up its failing check and performs the merge by hand — twice on #130 in one
afternoon.

This performs the merge through the forge's own endpoint, for the loop's branches only:

* the head must live in this repository — a fork's branch is not ours to move;
* the branch must be the loop's (``claude/**``); an operator's branch is left alone;
* it must not be a machine class: a merge commit committed by anyone but the producing
  workflow fails that class's committer gate, so updating one would refuse it;
* GitHub must already report ``behind``. ``dirty``, ``clean``, ``blocked`` and an
  uncomputed answer are all left exactly as they are.

The credential matters. A push made with the workflow's own token starts no workflows,
so the updated branch would carry the stale checks it had before, and the pull request
would read as measured on a revision nothing ever measured. The step that runs this
uses the loop's token instead, and runs only from the reviewed definition on ``master``.

Exit code is 0 whatever happened to individual branches. The outcome for a pull request
is the update the forge did or did not perform, printed per branch; this run's own
status says only that the sweep ran.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

import machine_pr_guard

LOOP_PREFIX = "claude/"
BEHIND = "behind"


def should_update(pull):
    """(bool, reason). Pure: decides from one pull request object as the API returns it."""
    head = pull.get("head") or {}
    base = pull.get("base") or {}
    ref = head.get("ref") or ""
    head_repo = (head.get("repo") or {}).get("full_name")
    base_repo = (base.get("repo") or {}).get("full_name")

    if pull.get("state", "open") != "open":
        return False, "not open"
    if pull.get("draft"):
        return False, "draft"
    if not head_repo or head_repo != base_repo:
        return False, "head is not in this repository"
    if machine_pr_guard.classify(ref) is not None:
        return False, "machine class: a merge commit from anyone else fails its committer gate"
    if not ref.startswith(LOOP_PREFIX):
        return False, f"not a loop branch ({LOOP_PREFIX}**)"
    if pull.get("mergeable") is None:
        return False, "mergeability not yet computed"
    state = pull.get("mergeable_state")
    if state != BEHIND:
        return False, f"mergeable_state is {state!r}, not {BEHIND!r}"
    return True, BEHIND


def failure_detail(stderr: str, returncode: int) -> str:
    """The one line of a failed gh call worth printing: the HTTP status, if any."""
    for line in (stderr or "").splitlines():
        if line.startswith("HTTP ") or line.startswith("gh: "):
            return line.strip()
    return f"gh exit {returncode}"


def _gh(args):
    # UTF-8 explicitly, not by locale: see the note in machine_pr_guard.py.
    return subprocess.run(
        ["gh", *args], capture_output=True, text=True, encoding="utf-8"
    )


def read_pull(repo: str, number: int):
    result = _gh(["api", f"repos/{repo}/pulls/{number}"])
    if result.returncode:
        raise RuntimeError(f"could not read #{number}: {failure_detail(result.stderr, result.returncode)}")
    return json.loads(result.stdout)


def open_pull_numbers(repo: str):
    result = _gh(["api", f"repos/{repo}/pulls?state=open&per_page=100"])
    if result.returncode:
        raise RuntimeError(f"could not list pull requests: {failure_detail(result.stderr, result.returncode)}")
    return [int(pull["number"]) for pull in json.loads(result.stdout)]


def update(repo: str, number: int, head_sha: str):
    """Ask the forge to merge the base into the branch. Returns (ok, detail).

    `expected_head_sha` makes the request refuse if the branch moved since it was
    read, so a push landing in the same second is never merged over.
    """
    result = _gh(
        [
            "api",
            "-X",
            "PUT",
            f"repos/{repo}/pulls/{number}/update-branch",
            "-f",
            f"expected_head_sha={head_sha}",
        ]
    )
    if result.returncode == 0:
        return True, "update requested"
    return False, failure_detail(result.stderr, result.returncode)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pull", type=int, help="one pull request number")
    group.add_argument("--all-open", action="store_true", help="every open pull request")
    parser.add_argument("--dry-run", action="store_true", help="decide, but update nothing")
    args = parser.parse_args()

    try:
        numbers = [args.pull] if args.pull else open_pull_numbers(args.repo)
    except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"::warning::update-branches: {error}")
        return 0

    for number in numbers:
        try:
            pull = read_pull(args.repo, number)
        except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
            print(f"::warning::update-branches: {error}")
            continue
        ref = (pull.get("head") or {}).get("ref") or "?"
        ok, reason = should_update(pull)
        if not ok:
            print(f"update-branches: #{number} {ref} left alone: {reason}")
            continue
        if args.dry_run:
            print(f"update-branches: #{number} {ref} would be updated ({reason})")
            continue
        done, detail = update(args.repo, number, pull["head"]["sha"])
        verb = "updated" if done else "not updated"
        print(f"update-branches: #{number} {ref} {verb}: {detail}")
        if not done:
            print(f"::notice::update-branches: #{number} not updated: {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
