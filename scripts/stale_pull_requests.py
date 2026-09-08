"""Close a pull request no run can reach any more, and return its work to the queue.

Over 2026-09-06 and 07 the loop accumulated pull requests that nothing would ever
touch again: #208 carried the ACCEPTOR's own ACCEPT on a head branch protection would
not merge; #223 was refused, then labelled for a human, then went dirty; #238 sat clean
and approved with no run able to select it; #242 was quietly superseded by a duplicate.
Two thirds of a measured day's spend sat in that pile. Every one of them had to be
found by a person and ended by hand.

The rework bound already ends the loud failure: three refusals and the branch stops.
This ends the quiet one.

## Age is the symptom; unreachability is the disease

"Close pull requests older than a day" is the obvious rule and the wrong one. A pull
request can be a day old and perfectly healthy — three review rounds at half an hour
each, plus the time an AUTHOR run needs to answer them, is normal — while a pull
request can become unreachable within an hour and never recover.

So the test is two-part, and both halves must hold:

* **nothing has advanced it** for the window (default 24 hours), and
* **no review run could select it right now** — `select_review_target.eligible` says no.

The second half is what makes this safe. A pull request a run could pick up is not
stuck, it is queued, however old it is; closing it would punish a busy queue. And every
pull request in the pile above was ineligible for hours before anyone noticed.

## What counts as advancing it

The head moved, the ACCEPTOR posted a verdict, or the pull request's own author
commented. Nothing else.

A comment from a third party — the QA voice, an operator, the researcher — is evidence,
not progress, exactly as it is for a verdict. This is deliberate and it is the same rule
the rest of the loop now follows: a voice that cannot move a pull request cannot keep it
alive either. Otherwise an hourly QA run would hold every dead branch open forever,
which is the failure this exists to end, arriving by a politer road.

## What it will not close

* Machine-generated pull requests. `stale_mirror_pr.py` owns those, with a much shorter
  fuse, and two closers on one class would drift.
* Drafts. Unfinished is not stuck.
* Anything labelled `status:needs-decision`. That label means a person took the
  decision, and a job that overrides it is not a bound, it is a race with the operator.
  These are reported loudly instead — an untouched one is the operator's queue, and
  saying so is this job's other half.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys

import machine_pr_guard
import rework_limit
import select_review_target as select

DEFAULT_HOURS = 24
HUMAN_OWNED_LABEL = select.HUMAN_OWNED_LABEL


def parse_time(value):
    """GitHub timestamps, as aware datetimes. Unreadable reads as the epoch.

    A timestamp that cannot be parsed must not make a pull request look freshly
    touched: the safe direction is "old", because the eligibility half of the test still
    has to agree before anything closes.
    """
    try:
        return dt.datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except ValueError:
        return dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)


def last_progress(pull, head_committed_at, acceptor=""):
    """When this pull request last moved, by the definition in the module docstring.

    Opening it counts, and that is not a detail. On 2026-09-08 this bound closed #285
    two minutes after the AUTHOR opened it, reporting "idle 24.3h" — truthfully, because
    the branch was one the author had abandoned the day before and re-proposed without
    touching its head. Every other signal was 24 hours old and the arithmetic was right;
    the meaning was not. A branch nobody has touched is abandoned, but a pull request
    somebody just opened is a proposal, and this bound exists to end the first, never the
    second.

    (That the AUTHOR re-proposed a stale head instead of starting from `master`, as the
    closure of #223 asked it to, is a separate defect and not this module's to correct.)
    """
    author = select.normalize_login((pull.get("author") or {}).get("login"))
    moments = [parse_time(head_committed_at), parse_time(pull.get("createdAt"))]

    for comment in pull.get("comments") or []:
        if select.is_the_authors(
            {"author": (comment.get("author") or {}).get("login")}, author
        ):
            moments.append(parse_time(comment.get("createdAt")))

    for review in pull.get("reviews") or []:
        entry = {
            "author": (review.get("author") or {}).get("login"),
            "state": review.get("state"),
            "body": review.get("body"),
            "createdAt": review.get("submittedAt"),
        }
        if select.is_verdict_entry(entry, acceptor):
            moments.append(parse_time(review.get("submittedAt")))

    # A verdict the ACCEPTOR posted as a comment counts the same as a formal one: which
    # shape it takes is an accident of GitHub's same-account rule, not of meaning.
    if acceptor:
        for comment in pull.get("comments") or []:
            entry = {
                "author": (comment.get("author") or {}).get("login"),
                "state": None,
                "body": comment.get("body"),
                "createdAt": comment.get("createdAt"),
            }
            if select.is_verdict_entry(entry, acceptor):
                moments.append(parse_time(comment.get("createdAt")))

    return max(moments)


def verdict(pull, head_committed_at, now, hours, eligible_now, acceptor=""):
    """Return (action, reason). Pure: no network, no clock of its own.

    action is one of "close", "report", "keep".
    """
    if pull.get("isDraft"):
        return "keep", "draft: unfinished is not stuck"

    machine = machine_pr_guard.classify(pull.get("headRefName") or "")
    if machine is not None:
        return "keep", f"{machine.branch} is machine-generated; stale_mirror_pr.py owns it"

    idle_hours = (now - last_progress(pull, head_committed_at, acceptor)).total_seconds() / 3600
    if idle_hours < hours:
        return "keep", f"advanced {idle_hours:.1f}h ago, inside the {hours}h window"

    if eligible_now:
        return "keep", f"idle {idle_hours:.1f}h but a review run can select it: queued, not stuck"

    labels = {label["name"] for label in pull.get("labels") or []}
    if HUMAN_OWNED_LABEL in labels:
        return "report", (
            f"idle {idle_hours:.1f}h and unreachable, but {HUMAN_OWNED_LABEL} means a "
            "person owns this decision"
        )

    return "close", f"idle {idle_hours:.1f}h and no review run can select it"


def summary(pull, reason: str, hours: int, issue) -> str:
    lines = [
        "## Closed as unreachable",
        "",
        f"Closed by the forge, not by a reviewer: {reason}.",
        "",
        "Two things had to be true at once. Nothing has advanced this pull request for "
        f"{hours} hours — no commit on its head, no verdict from the ACCEPTOR, no "
        "comment from its own author — and no review run can select it as it stands, so "
        "nothing was going to change that on its own.",
        "",
        "This is not a judgement about the change. The commits stay reachable from this "
        "pull request and the record below stays readable.",
    ]
    if issue is not None:
        lines += [
            "",
            f"Issue #{issue} returns to `{rework_limit.STATUS_READY}`. The next AUTHOR run "
            "starts from `master`; a branch this far behind costs more to revive than to "
            "rewrite, which is what the queue kept proving.",
        ]
    else:
        lines += [
            "",
            "No linked Issue could be read from the body or the branch name, so a person "
            "decides what returns to the queue.",
        ]
    return "\n".join(lines)


def issue_note(pull, reason: str, hours: int):
    def note(issue: int) -> str:
        return (
            "## Returned to the queue by the forge\n\n"
            f"Pull request {pull.get('url')} was closed as unreachable: {reason}. Nothing "
            f"had advanced it for {hours} hours and no review run could select it.\n\n"
            "Its commits remain reachable from that pull request; its branch is gone. "
            "Start from `master`, and read the pull request first — whatever was already "
            "solved there is worth carrying over, and whatever refused it is worth not "
            "repeating."
        )
    return note


def _gh(args):
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def load_pulls(repo: str):
    raw = _gh([
        "pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json",
        "number,createdAt,updatedAt,isDraft,labels,headRefName,headRefOid,"
        "statusCheckRollup,author,url,body,comments,reviews",
    ])
    return json.loads(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--acceptor", default="", help="login of the ACCEPTOR identity")
    parser.add_argument(
        "--hours", type=int, default=int(os.environ.get("ZENDEV_STALE_PR_HOURS") or DEFAULT_HOURS),
        help="hours without progress before an unreachable pull request is closed",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    closed = 0
    for pull in load_pulls(args.repo):
        number = pull["number"]
        committed_at = select.head_commit_date(args.repo, pull["headRefOid"])
        eligible_now, _ = select.eligible(
            pull, committed_at, select.load_comments(args.repo, number), args.acceptor
        )
        action, reason = verdict(
            pull, committed_at, now, args.hours, eligible_now, args.acceptor
        )
        print(f"  #{number} {action}: {reason}")

        if action == "report":
            # Not a failure of the loop, and not this job's to resolve — but a pull
            # request a person owns and has not touched in a day is the one thing here
            # nothing else will ever surface.
            print(f"::warning::#{number} waits on a person: {reason}")
        if action != "close" or args.dry_run:
            continue

        issue = rework_limit.linked_issue(pull.get("body"), pull.get("headRefName") or "")
        try:
            rework_limit.retire(
                args.repo,
                pull,
                summary(pull, reason, args.hours, issue),
                issue_note(pull, reason, args.hours),
            )
            closed += 1
        except subprocess.CalledProcessError as error:
            # One pull request failing to close must not stop the rest, and must not
            # fail the run that hosts this: the queue is still better off than before.
            print(f"::warning::stale-pull-requests: closing #{number} failed: "
                  f"{type(error).__name__}")

    print(f"stale-pull-requests: closed {closed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
