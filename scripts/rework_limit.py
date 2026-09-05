"""Bound the rework on one pull request.

The AUTHOR's ladder puts "an open pull request of yours with changes requested" first,
which is right: closing work outranks opening it. It also has no bound, and #130 showed
what an unbounded first rung costs. Three `REQUEST_CHANGES` verdicts on three heads, five
AUTHOR runs and four ACCEPTOR runs in one afternoon, the only product Issue waiting the
whole time — and the pull request still open.

This bounds it. After the ACCEPTOR has posted its verdict, the forge counts the refusals
on the pull request. At the bound (three by default) it closes the pull request with a
comment listing every refusal, deletes the loop's own branch, and returns the Issue to
`status:ready` with the same record, so the next AUTHOR run starts from `master` with
the history in hand instead of opening a fourth round on a branch that has failed
review three times.

What counts as a refusal is what the selector already counts as a verdict, narrowed to
the refusing kind: a comment whose first marked line says `REQUEST_CHANGES` in one of
the shapes the runbook prescribes, or a formal review in the `CHANGES_REQUESTED` state.
An `ACCEPT`, a correction handoff, prose that mentions an earlier refusal — none of
those count. Neither does an operator's QA comment: the bound is on the automated loop's
own rounds.

Two things it never does. It never deletes a branch that is not the loop's (`claude/**`);
an operator's branch stays. And it never fails the acceptor run: the outcome for the
pull request is the state the forge leaves it in, printed here, and a bookkeeping error
is a warning.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

LIMIT = 3
LOOP_PREFIX = "claude/"
STATUS_READY = "status:ready"

# A refusal announces itself the way a verdict does: at the start of a line, behind at
# most a heading or bold marker, optionally the role and the word "verdict", then the
# refusing word. Anchored so that a sentence *about* an earlier refusal stays prose, and
# so that an operator's QA marker — which the AUTHOR runbook counts as evidence, not as
# a verdict — is not a round of the loop.
REFUSAL_LINE = re.compile(
    r"^\s*(?:#{1,4}\s*|\*\*)?\s*(?:ACCEPTOR\s+)?(?:VERDICT\s*[:\-—]\s*)?REQUEST_CHANGES\b",
    re.MULTILINE | re.IGNORECASE,
)
REFUSING_REVIEW = "CHANGES_REQUESTED"

CLOSES = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", re.IGNORECASE)
BRANCH_ISSUE = re.compile(r"^claude/issue-(\d+)-")


def is_refusal(entry) -> bool:
    """A comment in the refusing verdict shape, or a formal review in the refusing state."""
    if (entry.get("state") or "").upper() == REFUSING_REVIEW:
        return True
    return bool(REFUSAL_LINE.search(entry.get("body") or ""))


def decide(entries, limit=LIMIT):
    """(bound reached, the refusals). Pure."""
    refusals = [entry for entry in entries if is_refusal(entry)]
    return len(refusals) >= limit, refusals


def linked_issue(body, head_ref):
    """The Issue a pull request belongs to: `Closes #N` in the body, else the branch name."""
    match = CLOSES.search(body or "")
    if match:
        return int(match.group(1))
    match = BRANCH_ISSUE.match(head_ref or "")
    return int(match.group(1)) if match else None


def entries_of(pull):
    """Comments and formal reviews as one timeline. Reviews without a time are not events."""
    entries = [
        {
            "body": comment.get("body") or "",
            "createdAt": comment.get("createdAt") or "",
            "state": None,
            "url": comment.get("url"),
        }
        for comment in pull.get("comments") or []
    ]
    entries += [
        {
            "body": review.get("body") or "",
            "createdAt": review.get("submittedAt") or "",
            "state": review.get("state"),
            "url": None,
        }
        for review in pull.get("reviews") or []
        if review.get("submittedAt")
    ]
    return sorted(entries, key=lambda entry: entry["createdAt"])


def first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:120]
    return ""


def summary(pull, refusals, limit, issue):
    head = (pull.get("headRefOid") or "")[:8]
    lines = [
        f"## Rework bound reached: {len(refusals)} refusals on one pull request",
        "",
        f"Closed by the forge at head `{head}`, not by a reviewer. The bound is {limit} "
        "`REQUEST_CHANGES` verdicts: a further round on a branch that has failed review "
        "this often costs more than a fresh start from `master` with the record in hand.",
        "",
        "Refusals:",
    ]
    for refusal in refusals:
        label = first_line(refusal["body"]) or (refusal.get("state") or "review")
        where = f" ({refusal['url']})" if refusal.get("url") else ""
        lines.append(f"- {refusal['createdAt']} — {label}{where}")
    lines.append("")
    if issue is not None:
        lines.append(
            f"The commits stay reachable from this pull request. Issue #{issue} returns to "
            f"`{STATUS_READY}` with this record; the next AUTHOR run starts from `master` and "
            "reads every verdict above before claiming it."
        )
    else:
        lines.append(
            "The commits stay reachable from this pull request. No linked Issue could be "
            "read from the body or the branch name, so a person decides what returns to "
            "the queue."
        )
    return "\n".join(lines)


def issue_note(pull, refusals, limit):
    return (
        f"## Returned to the queue by the forge\n\n"
        f"Pull request {pull.get('url')} was closed after {len(refusals)} `REQUEST_CHANGES` "
        f"verdicts (the bound is {limit}). Its commits remain reachable from the pull request; "
        f"its branch is gone. Start from `master`, and read every verdict on that pull request "
        f"before claiming this Issue: the record of what was refused is the work packet now."
    )


def _gh(args):
    # UTF-8 explicitly, not by locale: see the note in machine_pr_guard.py.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def load_pull(repo: str, number: int):
    raw = _gh(
        [
            "pr",
            "view",
            str(number),
            "--repo",
            repo,
            "--json",
            "number,state,url,body,headRefName,headRefOid,comments,reviews",
        ]
    )
    return json.loads(raw)


def issue_status_labels(repo: str, issue: int):
    raw = _gh(["issue", "view", str(issue), "--repo", repo, "--json", "labels"])
    return [label["name"] for label in json.loads(raw).get("labels", []) if label["name"].startswith("status:")]


def close_out(repo: str, pull, refusals, limit: int) -> None:
    number = pull["number"]
    head_ref = pull.get("headRefName") or ""
    issue = linked_issue(pull.get("body"), head_ref)

    _gh(["pr", "comment", str(number), "--repo", repo, "--body", summary(pull, refusals, limit, issue)])
    close = ["pr", "close", str(number), "--repo", repo]
    if head_ref.startswith(LOOP_PREFIX):
        close.append("--delete-branch")
    _gh(close)

    if issue is None:
        return
    args = ["issue", "edit", str(issue), "--repo", repo, "--add-label", STATUS_READY]
    for label in issue_status_labels(repo, issue):
        if label != STATUS_READY:
            args += ["--remove-label", label]
    _gh(args)
    _gh(["issue", "comment", str(issue), "--repo", repo, "--body", issue_note(pull, refusals, limit)])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--pull", type=int, required=True, help="the pull request just reviewed")
    parser.add_argument("--limit", type=int, default=LIMIT, help="refusals that end the rework")
    parser.add_argument("--dry-run", action="store_true", help="decide, but change nothing")
    args = parser.parse_args()

    try:
        pull = load_pull(args.repo, args.pull)
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"::warning::rework-limit: could not read #{args.pull}: {type(error).__name__}")
        return 0

    if (pull.get("state") or "").upper() != "OPEN":
        print(f"rework-limit: #{args.pull} is {pull.get('state')}; nothing to bound")
        return 0

    reached, refusals = decide(entries_of(pull), args.limit)
    print(f"rework-limit: #{args.pull} has {len(refusals)} refusal(s); bound is {args.limit}")
    if not reached:
        return 0
    if args.dry_run:
        print(f"rework-limit: would close #{args.pull} and return its Issue to {STATUS_READY}")
        return 0
    try:
        close_out(args.repo, pull, refusals, args.limit)
    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as error:
        print(f"::warning::rework-limit: closing #{args.pull} did not complete: {type(error).__name__}")
        return 0
    print(f"rework-limit: closed #{args.pull} at the bound")
    return 0


if __name__ == "__main__":
    sys.exit(main())
