"""Choose the one pull request an ACCEPTOR run should review, or choose nothing.

Section 1 of the ACCEPTOR runbook is a computation: take the oldest open, non-draft
pull request whose current head has no verdict yet, with one narrow exception for a
metadata correction on an unchanged head. Nothing in it requires reading a diff or
weighing an argument.

Leaving that computation to the model cost real runs. Two consecutive runs selected
the same pull request, whose head had not moved and whose last verdict was a
refusal, and re-posted the same refusal — which section 1 explicitly forbids
("stop without re-reviewing an unchanged rejection"). Meanwhile three other pull
requests were never reached, because the ineligible one was the oldest.

So the selection happens here, before the model is started, and when nothing is
eligible the model is not started at all.

## What makes a pull request ineligible

* it is a draft, or closed;
* a human owns it — `status:needs-decision` means the decision was handed to a
  person, and a review run cannot take it back;
* the `mergeability` check is failing, so a control has already established that the
  branch cannot be accepted whatever its contents; the next move belongs to the
  author, and the failing check is already on the author's own ladder;
* its current head already carries a verdict, and no correction has been posted since.

Eligibility means a review is *owed and possible*, not merely owed. Withhold one only
when it could add nothing the checks have not already said. An unmergeable branch is
that case: it cannot be accepted whatever it contains, and the diff on offer is not
the diff that would land, so the reviewer would be judging a text that no longer
applies.

Not "skip whatever will fail". Every failing required check determines the outcome,
since none of them may be red at acceptance — so that reading would withhold most of
the reviews worth having. A red test suite still selects, because the reviewer can
judge the criteria too and return one complete list instead of two partial ones.

## How a verdict is tied to a head

Two independent signals, either of which counts:

* the verdict names the head revision (the runbook requires this);
* the verdict was posted after the head commit was made.

Either alone is enough. The effect is deliberately conservative: when in doubt this
treats the head as already judged and moves on. A missed review costs one cycle of
latency, while a repeated one costs a run *and* leaves contradictory comments on the
pull request — the asymmetry says which way to lean.

A verdict is not final if a correction followed it. A non-verdict comment newer than
the newest verdict is read as the AUTHOR's correction handoff, which is what section
1's same-head exception turns on.

## What this does not do

It does not decide anything about the change. Eligibility is not acceptance: every
refusal, verification and merge gate in the runbook still applies afterwards, and
the model is still the only thing that reaches a verdict.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

# A verdict announces itself, and the two shapes below are the two ways it does.
#
# Both anchor to the start of a line, so a sentence *about* a verdict stays prose —
# "the previous REQUEST_CHANGES asked for a label fix" must remain a correction, or
# the same-head exception could never fire and a corrected pull request would be
# stuck forever.
#
# A heading or bold marker is matched case-insensitively, because a model writing
# "## Accept" means the verdict and missing it would restart the re-review loop this
# exists to stop. A bare word with no marker must be the shouted form the runbook
# specifies; anything less would swallow ordinary sentences that open with "Accept".
MARKED_VERDICT = re.compile(
    r"^\s*(?:#{1,4}\s*|\*\*)\s*(?:VERDICT\s*[:\-—]\s*)?"
    r"(?:ACCEPT|REQUEST_CHANGES)\b",
    re.MULTILINE | re.IGNORECASE,
)
BARE_VERDICT = re.compile(r"^\s*(?:ACCEPT|REQUEST_CHANGES)\b", re.MULTILINE)

HUMAN_OWNED_LABEL = "status:needs-decision"
MERGEABILITY_CHECK = "mergeability"


def is_verdict(body: str) -> bool:
    body = body or ""
    return bool(MARKED_VERDICT.search(body) or BARE_VERDICT.search(body))


def judges_head(comment, head_sha: str, head_committed_at: str) -> bool:
    """Whether this comment is a verdict on the current head revision."""
    if not is_verdict(comment["body"]):
        return False
    if head_sha[:7] and head_sha[:7] in (comment["body"] or ""):
        return True
    return comment["createdAt"] >= head_committed_at


def conflicts_with_base(pull) -> bool:
    """Whether the mergeability check has already ruled this branch out.

    Only an explicit failure counts. A missing check is not a failure — a pull request
    opened before the check existed must stay reviewable — and `pending` is not one
    either: it means GitHub has not answered yet, it clears within a minute, and
    treating it as a refusal would let a transient unknown stall the queue.
    """
    for check in pull.get("statusCheckRollup") or []:
        name = check.get("name") or check.get("context")
        if name != MERGEABILITY_CHECK:
            continue
        outcome = (check.get("conclusion") or check.get("state") or "").upper()
        if outcome == "FAILURE":
            return True
    return False


def eligible(pull, head_committed_at: str, comments):
    """Return (bool, reason). Pure: no network, no clock."""
    if pull.get("isDraft"):
        return False, "draft"
    labels = {label["name"] for label in pull.get("labels", [])}
    if HUMAN_OWNED_LABEL in labels:
        return False, f"{HUMAN_OWNED_LABEL}: a person owns this decision"

    if conflicts_with_base(pull):
        return False, f"{MERGEABILITY_CHECK} is failing: the author must rebase first"

    head_sha = pull["headRefOid"]
    verdicts = [c for c in comments if judges_head(c, head_sha, head_committed_at)]
    if not verdicts:
        return True, "no verdict on the current head"

    newest_verdict = max(c["createdAt"] for c in verdicts)
    corrections = [
        c
        for c in comments
        if not is_verdict(c["body"]) and c["createdAt"] > newest_verdict
    ]
    if corrections:
        return True, "a correction was posted after the last verdict on this head"
    return False, f"already judged at {head_sha[:8]}; no correction since"


def choose(candidates):
    """candidates: [(number, created_at, is_eligible, reason)] -> number or None."""
    for number, _, ok, _ in sorted(candidates, key=lambda c: (c[1], c[0])):
        if ok:
            return number
    return None


def _gh(args):
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True
    ).stdout


def load_pulls(repo: str):
    raw = _gh(
        [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,createdAt,isDraft,labels,headRefOid,statusCheckRollup",
        ]
    )
    return json.loads(raw)


def load_comments(repo: str, number: int):
    raw = _gh(
        ["pr", "view", str(number), "--repo", repo, "--json", "comments,reviews"]
    )
    data = json.loads(raw)
    comments = [
        {"body": c.get("body", ""), "createdAt": c.get("createdAt", "")}
        for c in data.get("comments", [])
    ]
    # A formal review counts equally; the role posts comments only because GitHub
    # refuses a same-account review, which is an accident of identity, not of meaning.
    comments += [
        {"body": r.get("body", ""), "createdAt": r.get("submittedAt", "")}
        for r in data.get("reviews", [])
        if r.get("submittedAt")
    ]
    return comments


def head_commit_date(repo: str, sha: str) -> str:
    raw = _gh(["api", f"repos/{repo}/commits/{sha}"])
    return json.loads(raw)["commit"]["committer"]["date"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    args = parser.parse_args()

    candidates = []
    for pull in load_pulls(args.repo):
        number = pull["number"]
        committed_at = head_commit_date(args.repo, pull["headRefOid"])
        ok, reason = eligible(pull, committed_at, load_comments(args.repo, number))
        candidates.append((number, pull["createdAt"], ok, reason))

    # Every pull request and why, always. When this picks nothing, the reason it
    # picked nothing is the only evidence that the loop is idle by decision rather
    # than broken — and a silent selector is indistinguishable from a stalled one.
    for number, created_at, ok, reason in sorted(candidates, key=lambda c: c[1]):
        print(f"  #{number} ({created_at}) {'eligible' if ok else 'skipped'}: {reason}")

    target = choose(candidates)
    value = str(target) if target else "none"
    print(f"target={value}")

    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"target={value}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
