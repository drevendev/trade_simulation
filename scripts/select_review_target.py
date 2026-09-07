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
* it is machine-generated — a workflow produced it, mechanical gates decide it and
  branch protection merges it, so a review run has nothing to add and merging one by
  hand would restore the dependency that class removes;
* a human owns it — `status:needs-decision` means the decision was handed to a
  person, and a review run cannot take it back;
* the `mergeability` check is failing, so a control has already established that the
  branch cannot be accepted whatever its contents; the next move belongs to the
  author, and the failing check is already on the author's own ladder;
* nothing has run on its head at all. An unmeasured revision is not a clean one, and
  the runbook forbids accepting one anyway, so a run spent on it can only rediscover
  by hand what a check is about to report. This is not the same as a head that has
  other checks but no `mergeability`: that one is old enough to predate the check and
  stays reviewable;
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

## Whose verdict counts

The ACCEPTOR's, and only the ACCEPTOR's. A verdict is not a description of a pull
request, it is an instruction to merge or to rework, and only one identity can carry
it out — so reading every account's review as one cost a full day of throughput:

* on #208 the ACCEPTOR posted ACCEPT twice, while a `CHANGES_REQUESTED` left by the
  researcher's account held `mergeStateStatus` at `BLOCKED`. The ACCEPT could not
  execute, the head counted as judged, and the pull request left the queue for good.
* on #223 an `APPROVED` from that same account, newer than the ACCEPTOR's refusal,
  told the AUTHOR the pull request was settled while GitHub kept it blocked.
* on #238 an `APPROVED` from that account was the *only* verdict on a clean head:
  never re-selected, never merged, eleven hours idle.

So another account's review is evidence, exactly like the prose comments below it.
It may still block the merge — that gate belongs to branch protection, not here —
and `standing_blockers` names whoever holds it so the run can say so instead of
issuing an ACCEPT that cannot be carried out.

Without `--acceptor` every account's verdict counts, as before. That is the wider
reading, and it is the safe direction to fail in: a missed verdict re-reviews a head
that was already judged, which is the defect this module exists to prevent (#152).

## What is a verdict

A comment in one of the shapes the runbooks prescribe — a heading or bold marker,
optionally the role and the word "verdict", then `ACCEPT` or `REQUEST_CHANGES` — or a
formal review whose state is `APPROVED` or `CHANGES_REQUESTED`, whatever its words. A
review left in the `COMMENTED` state is prose. On #193 the role's own
`## ACCEPTOR Verdict: ACCEPT` was not a verdict to an earlier reading of this, so the
next run reviewed the same head again and refused it: two verdicts on one revision,
which is what this exists to prevent (#152).

## How a verdict is tied to a head

Two independent signals, either of which counts:

* the verdict names the head revision (the runbook requires this);
* the verdict was posted after the head commit was made.

Either alone is enough. The effect is deliberately conservative: when in doubt this
treats the head as already judged and moves on. A missed review costs one cycle of
latency, while a repeated one costs a run *and* leaves contradictory comments on the
pull request — the asymmetry says which way to lean.

A verdict is not final if a correction followed it. A non-verdict comment newer than
the newest verdict, posted by the pull request's author, is read as the AUTHOR's
correction handoff, which is what section 1's same-head exception turns on. A note
from any other account after the verdict — an operator's, a QA reviewer's — is
evidence for the next review, not a correction: on #190 such a note reopened an
accepted head, the run that followed refused it, and the bound closed the pull request.

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

import machine_pr_guard

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
    r"^\s*(?:#{1,4}\s*|\*\*)\s*(?:ACCEPTOR\s+)?(?:VERDICT\s*[:\-—]\s*)?"
    r"(?:ACCEPT|REQUEST_CHANGES)\b",
    re.MULTILINE | re.IGNORECASE,
)
BARE_VERDICT = re.compile(r"^\s*(?:ACCEPT|REQUEST_CHANGES)\b", re.MULTILINE)

# A formal review carries its verdict in its state, whatever its words. A review left in
# the `COMMENTED` state is prose, however strongly it is worded.
REVIEW_VERDICT_STATES = ("APPROVED", "CHANGES_REQUESTED")

HUMAN_OWNED_LABEL = "status:needs-decision"
MERGEABILITY_CHECK = "mergeability"


def is_verdict(body: str) -> bool:
    body = body or ""
    return bool(MARKED_VERDICT.search(body) or BARE_VERDICT.search(body))


def is_verdict_entry(entry, acceptor: str = "") -> bool:
    """A comment in a verdict shape, or a formal review in a verdict state.

    With `acceptor` named, only that identity's entries can be verdicts. An entry that
    records no author keeps the wider reading and stays a verdict: unknown identity is
    not evidence of a foreign one, and dropping a verdict costs a duplicate review.
    """
    if acceptor and not is_from(entry, acceptor):
        return False
    if (entry.get("state") or "").upper() in REVIEW_VERDICT_STATES:
        return True
    return is_verdict(entry.get("body") or "")


def normalize_login(login) -> str:
    """One spelling for one identity.

    `gh` prints a GitHub App as `app/name` on the pull request it authored and as `name`
    on the comments it posted; the web shows it as `name[bot]`. Comparing any two of
    those verbatim says "different", which is how a role fails to recognise itself.
    """
    login = (login or "").strip()
    if login.startswith("app/"):
        login = login[len("app/"):]
    if login.endswith("[bot]"):
        login = login[: -len("[bot]")]
    return login.lower()


def is_from(entry, login: str) -> bool:
    """Whether this entry was posted by `login`.

    An entry with no author recorded reads as yes, for the reason given in
    `is_verdict_entry`: silence about identity must not delete a verdict.
    """
    if not login or "author" not in entry:
        return True
    return normalize_login(entry.get("author")) == normalize_login(login)


def is_the_authors(entry, author: str) -> bool:
    """Whether an entry was posted by the pull request's author.

    Unknown on either side reads as yes: a record that carries no identities keeps the
    older, wider reading rather than silently never reopening anything.
    """
    if not author or "author" not in entry:
        return True
    return normalize_login(entry.get("author")) == author


def judges_head(comment, head_sha: str, head_committed_at: str, acceptor: str = "") -> bool:
    """Whether this entry is a verdict on the current head revision."""
    if not is_verdict_entry(comment, acceptor):
        return False
    if head_sha[:7] and head_sha[:7] in (comment["body"] or ""):
        return True
    return comment["createdAt"] >= head_committed_at


def standing_blockers(comments, acceptor: str = ""):
    """Every account whose latest formal review still refuses. Including this role's.

    GitHub blocks the merge on the *latest* review per reviewer, so an older refusal
    followed by that same account's approval is not standing. Only formal reviews are
    read: a comment, whatever it says, has never blocked a merge — which is exactly why
    the ACCEPTOR's own refusals belong here.

    The first version of this excluded them, reasoning that it named "a gate this role
    does not own". That was wrong twice over. The role does not own that gate either:
    GitHub blocks on a standing refusal whoever left it, and an ACCEPT posted as a
    comment does not supersede a formal review. And the omission cost the very
    diagnosis this exists to give — on #223 the run reported "standing refusals: empty"
    while its own refusal from the previous day was the only thing holding the merge.

    The two cases need different answers, not the same silence, so `split` below tells
    them apart: a refusal of this role's own is cleared by approving formally, while
    another account's is not this role's to clear at all.
    """
    latest = {}
    for entry in comments:
        if entry.get("kind") != "review":
            continue
        login = normalize_login(entry.get("author"))
        if not login:
            continue
        seen = latest.get(login)
        if seen is None or entry.get("createdAt", "") >= seen[0]:
            latest[login] = (entry.get("createdAt", ""), (entry.get("state") or "").upper())
    return sorted(login for login, (_, state) in latest.items() if state == "CHANGES_REQUESTED")


def split_blockers(blockers, acceptor: str = ""):
    """(this role's own refusal stands, other accounts still refusing).

    Kept separate from the reading above so that what the run *says* is decided here
    rather than by the model comparing logins in a prompt. The role has mistaken its
    own identity before (#152), and a run that cannot tell whose refusal it is looking
    at will either sit on a merge it could clear in one call, or try to clear one it
    cannot.
    """
    own = normalize_login(acceptor)
    others = [login for login in blockers if not own or login != own]
    return (bool(own) and own in blockers), others


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


def is_unmeasured(pull) -> bool:
    """Whether nothing at all has reported on this head yet.

    A head seconds old has no checks because none have started. A head that conflicts
    with its base may have none for much longer: GitHub runs pull-request workflows
    against the merge ref, and a conflicting pull request has no merge ref, so nothing
    fires. Either way the revision is unmeasured, which is not the same as clean.
    """
    return not (pull.get("statusCheckRollup") or [])


def eligible(pull, head_committed_at: str, comments, acceptor: str = ""):
    """Return (bool, reason). Pure: no network, no clock."""
    if pull.get("isDraft"):
        return False, "draft"

    # Classified by head branch, the same way the guard that gates it does — one
    # definition of the class, in machine_pr_guard.MACHINE_CLASSES, rather than a
    # branch name repeated here to drift out of step with it.
    machine = machine_pr_guard.classify(pull.get("headRefName") or "")
    if machine is not None:
        return False, (
            "%s is machine-generated: %s produced it and branch protection merges it"
            % (machine.branch, machine.producer)
        )

    labels = {label["name"] for label in pull.get("labels", [])}
    if HUMAN_OWNED_LABEL in labels:
        return False, f"{HUMAN_OWNED_LABEL}: a person owns this decision"

    if conflicts_with_base(pull):
        return False, f"{MERGEABILITY_CHECK} is failing: the author must rebase first"

    if is_unmeasured(pull):
        return False, "nothing has reported on this head yet: unmeasured is not clean"

    head_sha = pull["headRefOid"]
    verdicts = [
        c for c in comments if judges_head(c, head_sha, head_committed_at, acceptor)
    ]
    if not verdicts:
        return True, "no verdict on the current head"

    newest_verdict = max(c["createdAt"] for c in verdicts)
    author = normalize_login((pull.get("author") or {}).get("login"))
    corrections = [
        c
        for c in comments
        if not is_verdict_entry(c, acceptor)
        and c["createdAt"] > newest_verdict
        and is_the_authors(c, author)
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
    # UTF-8 explicitly, not by locale. Without it Python decodes with the platform's
    # preferred encoding, which on a Windows console is cp1252: a comment or title
    # holding an em dash then raises inside the reader thread, `stdout` comes back as
    # None, and the caller fails several frames later on something that looks unrelated.
    # The runner's UTF-8 locale hides this, so it only ever appears off the runner —
    # where the control plane is developed. Same fix as machine_pr_guard.py carries.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
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
            "number,createdAt,isDraft,labels,headRefName,headRefOid,statusCheckRollup,author",
        ]
    )
    return json.loads(raw)


def load_comments(repo: str, number: int):
    raw = _gh(
        ["pr", "view", str(number), "--repo", repo, "--json", "comments,reviews"]
    )
    data = json.loads(raw)
    comments = [
        {
            "body": c.get("body", ""),
            "createdAt": c.get("createdAt", ""),
            "state": None,
            "kind": "comment",
            "author": (c.get("author") or {}).get("login", ""),
        }
        for c in data.get("comments", [])
    ]
    # A formal review counts equally, and its state is read as well as its words: the
    # role posts comments only because GitHub refuses a same-account review, which is an
    # accident of identity, not of meaning, while another account's review carries its
    # verdict in the state and rarely in a heading.
    comments += [
        {
            "body": r.get("body", ""),
            "createdAt": r.get("submittedAt", ""),
            "state": r.get("state"),
            "kind": "review",
            "author": (r.get("author") or {}).get("login", ""),
        }
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
    parser.add_argument(
        "--acceptor",
        default="",
        help="login of the ACCEPTOR identity; only its verdicts are verdicts",
    )
    args = parser.parse_args()

    candidates = []
    blockers = {}
    for pull in load_pulls(args.repo):
        number = pull["number"]
        committed_at = head_commit_date(args.repo, pull["headRefOid"])
        comments = load_comments(args.repo, number)
        ok, reason = eligible(pull, committed_at, comments, args.acceptor)
        candidates.append((number, pull["createdAt"], ok, reason))
        held_by = standing_blockers(comments, args.acceptor)
        if held_by:
            blockers[number] = held_by

    # Every pull request and why, always. When this picks nothing, the reason it
    # picked nothing is the only evidence that the loop is idle by decision rather
    # than broken — and a silent selector is indistinguishable from a stalled one.
    for number, created_at, ok, reason in sorted(candidates, key=lambda c: c[1]):
        print(f"  #{number} ({created_at}) {'eligible' if ok else 'skipped'}: {reason}")

    # A merge that cannot execute is worth saying out loud even on pull requests this
    # run will not touch: it is the only place the deadlock of #211 is visible before
    # someone goes looking for it. Whose refusal it is decides what can be done, so the
    # line says which.
    for number, held_by in sorted(blockers.items()):
        mine, others = split_blockers(held_by, args.acceptor)
        parts = []
        if mine:
            parts.append("your own earlier refusal (clear it by approving formally)")
        if others:
            parts.append(f"{', '.join(others)} (not this role's to clear)")
        print(f"  #{number} merge held by {'; '.join(parts)}")

    target = choose(candidates)
    value = str(target) if target else "none"
    print(f"target={value}")

    mine, others = split_blockers(blockers.get(target, []) if target else [], args.acceptor)
    held = ",".join(others)
    if held:
        print(f"blocked_by={held}")
    if mine:
        print("self_refusal=true")

    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"target={value}\n")
            handle.write(f"blocked_by={held}\n")
            handle.write(f"self_refusal={'true' if mine else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
