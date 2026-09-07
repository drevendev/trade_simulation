"""Label an Issue opened by the external QA voice, so the loop can see it at all.

SLOPSTER acts as a GitHub account with read access to a public repository. Read access
is enough to open an Issue and comment on a pull request, and deliberately not enough
to label anything: an account that could label could also mark its own finding
`status:ready` and put work into the AUTHOR's queue without anyone reading it.

But an Issue with no labels is invisible. Every one of the six work-selection items in
the AUTHOR runbook is expressed over labels, so a finding that arrives unlabelled is
not "low priority" — it is unreachable, and the QA voice would be talking to nobody.

This closes that gap and nothing more. It reads three declaration lines the QA
manifest requires, applies only labels that already exist in the repository, and marks
the Issue `status:needs-triage` — never `status:ready`. Promotion to work stays a
judgement, made by the AUTHOR at triage; this job only makes the finding visible.

## Why it does not simply trust the declarations

An unknown or malformed value is dropped, not created. The label set is the
repository's vocabulary for what kind of thing an Issue is, and letting an outside
account extend it by writing a new word in a body would make the vocabulary meaningless
— and the label list is what several guards key on. A finding whose `Area:` is
unreadable still arrives, still carries `qa` and `status:needs-triage`, and a human or
the AUTHOR gives it the right axis at triage. Losing an axis costs one triage; taking
the word on trust costs the meaning of every axis.

## Why it will not add a second status label

An open Issue carrying two `status:*` labels is a live defect (#214): it happened
twice in one day and needed an operator both times. On `reopened` the Issue may
already carry one, so this adds `status:needs-triage` only when no `status:*` label is
present at all.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

# `Type: bug`, `**Priority:** high`, `- Area: simulation-core`. Anchored to the start
# of a line so a sentence mentioning a type in prose is not a declaration.
DECLARATION = re.compile(
    r"^[\s>*_-]*\**\s*(type|area|priority)\s*\**\s*:\s*\**\s*([A-Za-z0-9][A-Za-z0-9 _./-]*?)\s*\**\s*$",
    re.MULTILINE | re.IGNORECASE,
)

QA_LABEL = "qa"
TRIAGE_LABEL = "status:needs-triage"
STATUS_PREFIX = "status:"


def declared_labels(body: str):
    """Map the declaration lines of an Issue body to candidate label names.

    The first declaration of an axis wins. A body that says `Type: bug` twice with
    different values is malformed, and picking the last would let a trailing line in a
    quoted reply silently override the author's own heading.
    """
    found = {}
    for axis, value in DECLARATION.findall(body or ""):
        axis = axis.lower()
        if axis in found:
            continue
        found[axis] = "%s:%s" % (axis, value.strip().lower().replace(" ", "-"))
    return [found[axis] for axis in ("type", "area", "priority") if axis in found]


def labels_to_apply(body: str, existing, known):
    """The labels to add: declared ones the repository knows, plus qa and triage.

    `existing` is what the Issue already carries, `known` the repository's whole label
    vocabulary. Returns a sorted list so the result is stable to compare in a test and
    in a log; applying a label an Issue already has is a no-op, but saying so in the
    log is noise.
    """
    known = {name.lower() for name in known}
    have = {name.lower() for name in existing}
    add = {name for name in declared_labels(body) if name in known} - have

    if QA_LABEL in known:
        add.add(QA_LABEL)
    if not any(name.startswith(STATUS_PREFIX) for name in have) and TRIAGE_LABEL in known:
        add.add(TRIAGE_LABEL)
    return sorted(add - have)


def _gh(args):
    # UTF-8 explicitly, not by locale: an Issue body holding an em dash otherwise
    # raises inside the reader thread on a Windows console, several frames from here.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def normalize_login(login) -> str:
    login = (login or "").strip()
    if login.endswith("[bot]"):
        login = login[: -len("[bot]")]
    return login.lower()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--issue", required=True, type=int)
    parser.add_argument(
        "--qa-author",
        required=True,
        help="the only account whose Issues this labels; anything else is left alone",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    issue = json.loads(
        _gh(["issue", "view", str(args.issue), "--repo", args.repo,
             "--json", "author,body,labels,state"])
    )
    author = normalize_login((issue.get("author") or {}).get("login"))
    if author != normalize_login(args.qa_author):
        print(f"qa-intake: #{args.issue} is {author or 'unknown'}'s, not the QA voice's; leaving it alone")
        return 0

    known = [row["name"] for row in json.loads(
        _gh(["label", "list", "--repo", args.repo, "--limit", "200", "--json", "name"])
    )]
    existing = [row["name"] for row in issue.get("labels") or []]
    add = labels_to_apply(issue.get("body") or "", existing, known)

    if not add:
        print(f"qa-intake: #{args.issue} already carries everything this would add")
        return 0

    print(f"qa-intake: #{args.issue} += {', '.join(add)}")
    if args.dry_run:
        return 0

    # One call: two calls can half-apply, and a finding carrying `qa` but no status is
    # exactly as invisible as one carrying nothing.
    try:
        _gh(["issue", "edit", str(args.issue), "--repo", args.repo,
             *sum((["--add-label", name] for name in add), [])])
    except subprocess.CalledProcessError as error:
        # Never fail the job. A finding that arrives unlabelled is a triage cost; a red
        # workflow on every QA Issue is a broken control plane, and the louder signal
        # would be the wrong one.
        print(f"::warning::qa-intake: labelling #{args.issue} failed: {error.stderr.strip()[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
