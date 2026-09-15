"""The linked Issue must carry its label axes before a review run is spent on it.

`AGENTS.md` states the rule: *"Before an Issue may be claimed it carries exactly one
`priority:*`, exactly one `type:*`, and at least one `area:*`."* Until now the only thing
enforcing it was the ACCEPTOR, and `ACCEPTOR_RUNBOOK.md` section 2 said why it stayed
there: the gate *could* be checked, and no run had yet failed it.

A run has now failed it. Issue #448 carried `priority:high`, `type:bug` and
`status:needs-review` and no `area:*` label at all; it was claimed, implemented, and
carried to PR #459, where an ACCEPTOR run found the missing axis at review time and
refused the pull request. That refusal was correct and it was the most expensive place to
make it: one AUTHOR run, one ACCEPTOR run and a rework round, to report a missing label.
So the gate moves here, into the required `policy-guard` check, where a missing label
costs a re-run instead.

What this refuses, and nothing else: an Issue the body links whose labels do not satisfy
the three axes. It names the Issue, the axis, and the labels actually present, so the fix
is one `gh issue edit` and not an investigation.

What it deliberately does not do:

* **It does not refuse a pull request that links no Issue.** That gate is the ACCEPTOR's,
  stated once in section 2 alongside Issue completeness; a second, differently-worded
  refusal of the same rule would make one failure report as two unrelated defects. A
  pull request with nothing linked passes here and is judged there.
* **It does not apply the missing label.** Auto-labelling decides the work's area on the
  author's behalf and destroys the signal the axis exists to carry. It refuses and names.
* **It does not read a link out of quoted text.** A closing keyword inside a code span,
  a fenced block or an HTML comment does not link an Issue on GitHub, so it does not link
  one here either. A handoff has to be able to write down what a link looks like.
* **It does not read `status:*`.** That axis is the loop's own bookkeeping, it changes
  several times over an Issue's life, and it is not one of the three the contract names.
  It is not counted toward any axis and its presence never changes the result.

Machine-generated pull requests are exempt by construction: they have no author, no
handoff and no Issue, and `machine_pr_guard` already decides what they may touch.

Exit code 0 means every linked Issue carries its axes, 1 means at least one does not.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys

# Same directory. This module is run as `python scripts/issue_label_guard.py`, so that
# directory is already first on the path; the tests put it there explicitly.
import machine_pr_guard

# GitHub's own closing keywords, which are what actually link an Issue to a pull request.
# A bare `#123` is a reference, not a link: it neither closes the Issue nor tells this
# guard which Issue the work belongs to, and treating one as a link would let an
# incidental mention of a badly labelled Issue refuse an unrelated pull request.
CLOSING_KEYWORDS = ("close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved")

LINK = re.compile(
    r"\b(?:%s)\b\s*:?\s+#(\d+)" % "|".join(CLOSING_KEYWORDS),
    re.IGNORECASE,
)

# GitHub does not link a closing keyword it finds inside a code span, a fenced block or
# an HTML comment, and neither does this. The first pull request to carry this guard
# refused itself on exactly that: its handoff documented a live run against a body
# reading `Closes #999999`, in backticks, and the guard went and asked the forge about
# Issue 999999. A handoff must be able to quote a link without creating one — otherwise
# the record of what a guard does cannot be written down without tripping it.
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
FENCED_CODE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[ \t]*$|\Z)", re.DOTALL | re.MULTILINE)
# A code span may not contain a blank line, so an unclosed backtick swallows a
# paragraph at most rather than the rest of the body.
INLINE_CODE = re.compile(r"(`+)(?:(?!\1)[^\n]|\n(?!\s*\n))+?\1")


def strip_code(text):
    """The body with code spans, fenced blocks and HTML comments removed. Pure.

    Removed, not blanked to spaces: nothing downstream reads an offset, and the
    surrounding text keeps its own line structure because the fenced pattern is anchored
    to whole lines.
    """
    without = HTML_COMMENT.sub("", text or "")
    without = FENCED_CODE.sub("", without)
    return INLINE_CODE.sub("", without)

# The three axes the working contract names, and how many labels each admits.
# `status:*` is absent on purpose — see the module docstring.
AXES = (
    ("priority:", "exactly one", 1, 1),
    ("type:", "exactly one", 1, 1),
    ("area:", "at least one", 1, None),
)


def linked_issues(body):
    """Issue numbers the body links with a closing keyword, in order, deduplicated. Pure."""
    seen = []
    for match in LINK.finditer(strip_code(body)):
        number = int(match.group(1))
        if number not in seen:
            seen.append(number)
    return seen


def axis_violations(number, labels):
    """How the labels of one Issue fail the three axes. Pure.

    `labels` is the Issue's label names. Returns one human-readable violation per axis
    that is wrong, each naming the Issue, the axis and what is actually present.
    """
    names = sorted(labels)
    violations = []
    for prefix, requirement, low, high in AXES:
        present = [name for name in names if name.startswith(prefix)]
        if len(present) < low or (high is not None and len(present) > high):
            found = ", ".join("`%s`" % name for name in present) if present else "none"
            violations.append(
                "Issue #%d carries %s `%s*` label(s) (%s); the working contract requires "
                "%s. Labels on the Issue: %s."
                % (
                    number,
                    len(present),
                    prefix,
                    found,
                    requirement,
                    ", ".join("`%s`" % name for name in names) if names else "none",
                )
            )
    return violations


def check(body, head_ref, labels_of):
    """Pure decision given a resolver. Returns a list of human-readable violations.

    `labels_of` maps an Issue number to its label names; it is the only part of this
    that touches the forge, and it is injected so the decision above stays testable
    without a network.
    """
    if machine_pr_guard.classify(head_ref or "") is not None:
        return []
    violations = []
    for number in linked_issues(body):
        violations.extend(axis_violations(number, labels_of(number)))
    return violations


def _gh(args):
    # UTF-8 explicitly, not by locale: an Issue title or label may carry bytes a cp1252
    # console decodes into something else, and the reader then fails several frames away
    # from the cause. Same fix as status_lint.py and machine_pr_guard.py carry.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def forge_labels(repo):
    """A resolver that asks the forge for one Issue's labels."""

    def labels_of(number):
        raw = _gh(
            ["issue", "view", str(number), "--repo", repo, "--json", "labels"]
        )
        return [label["name"] for label in json.loads(raw).get("labels") or []]

    return labels_of


def read_body(path):
    if not path:
        return ""
    file = pathlib.Path(path)
    if not file.is_file():
        return ""
    return file.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--head-ref", required=True, help="head branch name")
    parser.add_argument(
        "--body-file", required=True, help="file holding the pull request body"
    )
    args = parser.parse_args()

    body = read_body(args.body_file)
    try:
        violations = check(body, args.head_ref, forge_labels(args.repo))
    except subprocess.CalledProcessError as exc:
        # An unresolvable Issue is not a pass. Failing loudly here says the guard could
        # not decide, which is what happened; swallowing it would report a green gate
        # over an Issue nobody looked at.
        print(
            "::error::issue-label-guard: could not read a linked Issue from %s: %s"
            % (args.repo, (exc.stderr or "").strip()[:300])
        )
        return 1

    if not violations:
        linked = linked_issues(body)
        if linked:
            print(
                "issue-label-guard: %s carries its priority/type/area axes"
                % ", ".join("#%d" % n for n in linked)
            )
        else:
            print(
                "issue-label-guard: the body links no Issue with a closing keyword; "
                "whether that is allowed is the ACCEPTOR's gate, not this one"
            )
        return 0

    for violation in violations:
        print("::error::issue-label-guard: %s" % violation)
    return 1


if __name__ == "__main__":
    sys.exit(main())
