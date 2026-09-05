"""Every path a pull request changes must be named in its handoff.

The handoff record has a *Changed artifacts* section, and the ACCEPTOR runbook refuses a
diff that reaches outside the Issue's declared scope. Half of that gate is judgement —
whether the declared set is the *right* set for the Issue — and it stays with the
reviewer. The other half is a predicate: does every changed path appear in the body at
all? The first revision of #130 changed more than ten files and declared two, and a
review run was spent discovering what a string search would have found.

So this is that string search, run inside the required ``policy-guard`` check. A changed
path the body does not mention refuses the pull request, and the author — whose own
ladder puts a failing required check second — corrects the handoff. The reviewer never
sees the undeclared version.

Deliberately literal. A path counts as declared when it appears verbatim in the body,
inside backticks or not, exactly as ``git diff --name-only`` spells it. There is no
parsing of sections: the template's shape can change, and a guard coupled to prose
drifts with it. Machine-generated pull requests are exempt — they have no author and
no handoff by construction, and their own class guard decides what they may touch.

Exit code 0 means every changed path is declared, 1 means at least one is not.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

import machine_pr_guard


def undeclared(paths, body):
    """The changed paths the body does not mention. Pure."""
    text = body or ""
    return [path for path in paths if path not in text]


def check(paths, body, head_ref):
    """Pure decision. Returns a list of human-readable violations."""
    if machine_pr_guard.classify(head_ref or "") is not None:
        return []
    missing = undeclared(paths, body)
    if not missing:
        return []
    if not (body or "").strip():
        return [
            "the pull request body is empty; a handoff names every changed file, and "
            "this diff changes %d" % len(paths)
        ]
    return [
        "%d changed path(s) are not named anywhere in the pull request body:\n  %s\n"
        "  A handoff lists every changed file under *Changed artifacts*, spelled as git "
        "spells it. Add the missing ones, or drop the change if it does not belong to "
        "this pull request's Issue." % (len(missing), "\n  ".join(missing))
    ]


def read_body(path):
    if not path:
        return ""
    file = pathlib.Path(path)
    if not file.is_file():
        return ""
    return file.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="base ref to compare against")
    parser.add_argument("--head-ref", required=True, help="head branch name")
    parser.add_argument(
        "--body-file", required=True, help="file holding the pull request body"
    )
    args = parser.parse_args()

    paths = machine_pr_guard.changed_paths(args.base)
    violations = check(paths, read_body(args.body_file), args.head_ref)

    if not violations:
        print("scope-guard: every one of %d changed path(s) is named in the handoff" % len(paths))
        return 0
    for violation in violations:
        print("::error::scope-guard: %s" % violation)
    return 1


if __name__ == "__main__":
    sys.exit(main())
