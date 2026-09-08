"""Ask the forge what a run actually did, so its outcome is not a matter of wording.

`record_usage.classify_outcome` reads the run's final message. That is a claim, and a
model that finishes with the wrong words makes real work invisible: on 2026-09-08 an
ACCEPTOR run selected #252, spent thirty-two turns, posted a formal `CHANGES_REQUESTED`,
and was filed as `unknown`. Three of the 125 runs in the measured day went the same way,
and one of the day's cleanliness criteria is "no runs with outcome `unknown`" — so a
three-percent lie about wording fails a criterion about behaviour, and pollutes the cost
per unit of work in both directions.

This reads the effect instead. Not what the run said: what its identity did in the
repository between the moment the model started and now.

* **ACCEPTOR** — a verdict on the reviewed pull request, in either shape the runbook
  allows, or that pull request merged. Reaching a verdict is the whole of its job.
* **AUTHOR** — a pull request it opened, or a commit it pushed to the head of one it
  already had. Producing or advancing a branch is the whole of its job.

## Where this sits, and why it does not decide more than it knows

It is consulted last: the workflow's own conclusion first, then the run's own claim of
completed, blocked or no work, and only then this. So it changes nothing about runs that
already report something, and rescues exactly the case that reports nothing.

That ordering matters in the other direction too. An effect says work happened, not that
it went well — a run that posts a verdict *and* says it was blocked is blocked, and the
run is the only thing that knows that. Facts beat silence here, not testimony.

A run that did nothing observable and claimed nothing stays `unknown`, which is then a
true statement rather than an artefact of phrasing.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from select_review_target import is_verdict_entry, normalize_login

COMPLETED = "completed"
NONE = "none"


def _gh(args):
    # UTF-8 explicitly, not by locale: see the note in machine_pr_guard.py.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def acceptor_effect(pull, identity: str, since: str):
    """(effect, reason) for a review run: did this identity reach a verdict?"""
    if (pull.get("mergedAt") or "") >= since and pull.get("mergedAt"):
        return COMPLETED, "the reviewed pull request merged during this run"

    for review in pull.get("reviews") or []:
        submitted = review.get("submittedAt") or ""
        entry = {
            "author": (review.get("author") or {}).get("login"),
            "state": review.get("state"),
            "body": review.get("body"),
        }
        if submitted >= since and is_verdict_entry(entry, identity):
            return COMPLETED, f"posted a formal {review.get('state')} at {submitted}"

    for comment in pull.get("comments") or []:
        created = comment.get("createdAt") or ""
        entry = {
            "author": (comment.get("author") or {}).get("login"),
            "state": None,
            "body": comment.get("body"),
        }
        if created >= since and is_verdict_entry(entry, identity):
            return COMPLETED, f"posted a verdict comment at {created}"

    return NONE, "no verdict from this identity on the reviewed pull request"


def author_effect(pulls, identity: str, since: str):
    """(effect, reason) for an authoring run: did this identity produce or advance one?

    `headCommittedAt` is supplied by the caller per pull request, because `gh pr list`
    does not carry it. A pull request opened during the run counts even if its head is
    older, which happens when a branch is pushed first and opened a moment later.
    """
    for pull in pulls:
        if normalize_login((pull.get("author") or {}).get("login")) != normalize_login(identity):
            continue
        if (pull.get("createdAt") or "") >= since:
            return COMPLETED, f"opened #{pull['number']} at {pull['createdAt']}"
        if (pull.get("headCommittedAt") or "") >= since and pull.get("headCommittedAt"):
            return COMPLETED, f"pushed to #{pull['number']} at {pull['headCommittedAt']}"
    return NONE, "no pull request opened or advanced by this identity"


def load_pull(repo: str, number: int):
    return json.loads(
        _gh(["pr", "view", str(number), "--repo", repo, "--json",
             "number,mergedAt,reviews,comments"])
    )


def load_author_pulls(repo: str, identity: str, since: str):
    pulls = json.loads(
        _gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", "20",
             "--json", "number,createdAt,author,headRefOid"])
    )
    mine = [
        pull for pull in pulls
        if normalize_login((pull.get("author") or {}).get("login")) == normalize_login(identity)
    ]
    # Only the ones that could plausibly have moved: reading a head commit date is an
    # API call each, and a run that pushed did so within its own lifetime.
    for pull in mine:
        if (pull.get("createdAt") or "") >= since:
            continue
        try:
            commit = json.loads(_gh(["api", f"repos/{repo}/commits/{pull['headRefOid']}"]))
            pull["headCommittedAt"] = commit["commit"]["committer"]["date"]
        except (subprocess.CalledProcessError, ValueError, KeyError):
            pull["headCommittedAt"] = ""
    return mine


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--role", required=True, choices=("author", "acceptor"))
    parser.add_argument("--identity", required=True, help="the role's login")
    parser.add_argument("--since", required=True, help="ISO 8601, when the model started")
    parser.add_argument("--pull", default="", help="the reviewed pull request, ACCEPTOR only")
    args = parser.parse_args()

    try:
        if args.role == "acceptor":
            if not args.pull or args.pull == "none":
                effect, reason = NONE, "no pull request was selected"
            else:
                effect, reason = acceptor_effect(
                    load_pull(args.repo, int(args.pull)), args.identity, args.since
                )
        else:
            effect, reason = author_effect(
                load_author_pulls(args.repo, args.identity, args.since),
                args.identity, args.since,
            )
    except (subprocess.CalledProcessError, ValueError) as error:
        # Never fail the run that hosts this. A missing effect costs the rescue; a red
        # step here would cost the telemetry record, which is the more valuable thing.
        print(f"::warning::run-effect: could not read the forge: {type(error).__name__}")
        effect, reason = NONE, "the forge could not be read"

    print(f"run-effect: {effect} — {reason}")

    import os
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"effect={effect}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
