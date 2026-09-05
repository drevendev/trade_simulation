"""Mechanical gates for machine-generated pull requests.

Some pull requests are produced by a workflow rather than by an agent: they copy bytes
from somewhere else into one declared corner of the repository. Reviewing one with a
model asserts nothing that a predicate cannot assert, and it spends a review slot that
a code pull request is waiting for.

This guard is that predicate. It decides two things and nothing else:

1. A pull request whose head branch belongs to a machine class must stay inside the
   paths that class owns — plus any file generated from them, which the producing
   workflow has to regenerate in the same pull request or ship a snapshot that
   contradicts its own sources — must satisfy that class's own allowlist, and its head
   commit must be *committed* by the workflow identity that produces it. The author of that
   commit records who triggered the run and may be a person; the committer records what
   wrote it, and only that answers the question this guard is asking.
2. Nobody else may write those paths. An agent branch — or a person — editing
   ``docs/spec/mirror/**`` by hand is refused, because the mirror's whole value is
   that it is a verifiable copy of Drive rather than a place where anything can be
   typed.

Rule 2 is why this change narrows authority rather than widening it. Before this
guard, the mirror could be written from any branch and only a reviewer stood in the
way.

The guard deliberately does not scan for credentials: ``policy_guard.py`` runs over
the same diff in the same job and already refuses credential shapes from any branch.

Exit code 0 means the pull request may proceed, 1 means it is refused.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class MachineClass:
    """One branch that a workflow owns, and the gates that apply to it."""

    branch: str
    producer: str
    # Path prefixes this class owns. Nothing else may appear in its diff, and no other
    # branch may touch them.
    roots: tuple[str, ...]
    # Files derived from the roots that the producing workflow must regenerate in the
    # same pull request, because a check compares them against their sources.
    #
    # These are *not* owned. An ordinary branch may write them too — an AUTHOR adding a
    # ledger row regenerates the same table — so they are excluded from the
    # exclusive-write rule below and only widen what this class may carry. Nothing here
    # asserts the generated content is right: the generator's own `--check` runs in CI
    # over the same diff and refuses a table that does not match its sources.
    generated: tuple[str, ...]
    # The commit identity the producing workflow writes under — the *committer*, which
    # is what wrote the bytes. Not the author: `peter-evans/create-pull-request`
    # defaults the author to whoever triggered the run, so an operator dispatching the
    # sync by hand legitimately appears there. A commit committed under any other name
    # on this branch means something other than the workflow wrote it.
    committer: str
    # An rclone filter file deciding what may exist under the roots, or None when the
    # roots themselves are the whole rule.
    allowlist: str | None


MACHINE_CLASSES = (
    MachineClass(
        branch="spec-mirror",
        producer=".github/workflows/spec-sync.yml",
        roots=("docs/spec/mirror/",),
        generated=("docs/spec/IMPLEMENTATION_STATUS.md",),
        committer="github-actions[bot]",
        allowlist="docs/zendev/spec-mirror-allowlist.txt",
    ),
)

MACHINE_ROOTS = tuple(root for cls in MACHINE_CLASSES for root in cls.roots)


def classify(head_ref: str):
    """The machine class this head branch belongs to, or None for an ordinary one."""
    for cls in MACHINE_CLASSES:
        if head_ref == cls.branch:
            return cls
    return None


def parse_allowlist(text: str):
    """Read the rclone filter file as rules relative to the mirror root.

    Only the ``+`` rules matter: the file ends in ``- *``, so anything not included is
    excluded. A rule ending in ``/**`` names a directory and matches everything
    beneath it. Any other rule names exactly one file. The trailing ``*`` those file
    rules carry exists to absorb the extension Google Drive appends on export, and
    ``normalize_mirror.py`` strips that before anything is committed — so a committed
    path that still carries an export suffix is a normalization failure, and refusing
    it here is the point.
    """
    directories: list[str] = []
    files: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("+ "):
            continue
        rule = line[2:].strip().lstrip("/")
        if rule.endswith("/**"):
            directories.append(rule[: -len("**")])
        else:
            files.append(rule.rstrip("*"))
    return tuple(directories), tuple(files)


def allowlisted(relative_path: str, rules) -> bool:
    directories, files = rules
    if relative_path in files:
        return True
    return any(relative_path.startswith(directory) for directory in directories)


def check(head_ref: str, paths, allowlist_text, tip_committer):
    """Pure decision. Returns a list of human-readable violations."""
    violations: list[str] = []
    cls = classify(head_ref)

    if cls is None:
        trespass = sorted(p for p in paths if p.startswith(MACHINE_ROOTS))
        if trespass:
            violations.append(
                "branch '%s' writes machine-owned paths; only the workflow that "
                "produces them may.\n  %s" % (head_ref, "\n  ".join(trespass))
            )
        return violations

    permitted = sorted(p for p in paths if not p.startswith(cls.roots))
    outside = [p for p in permitted if p not in cls.generated]
    if outside:
        violations.append(
            "%s must stay inside %s (or regenerate %s); it also changed:\n  %s"
            % (
                cls.branch,
                ", ".join(cls.roots),
                ", ".join(cls.generated) or "nothing",
                "\n  ".join(outside),
            )
        )

    if cls.allowlist is not None:
        if allowlist_text is None:
            violations.append(
                "%s requires %s, which could not be read" % (cls.branch, cls.allowlist)
            )
        else:
            rules = parse_allowlist(allowlist_text)
            for root in cls.roots:
                for path in sorted(p for p in paths if p.startswith(root)):
                    if not allowlisted(path[len(root):], rules):
                        violations.append(
                            "%s is not inside %s; widening what is mirrored is a "
                            "reviewed policy change, not a sync result"
                            % (path, cls.allowlist)
                        )

    if tip_committer is not None and tip_committer != cls.committer:
        violations.append(
            "the head commit of %s was committed by '%s', not by '%s'; only %s may "
            "write this branch. The commit's author may be whoever triggered the sync; "
            "its committer may not" % (cls.branch, tip_committer, cls.committer, cls.producer)
        )

    return violations


def _git(args):
    # UTF-8 explicitly, not by locale: a path this guard classifies may carry bytes
    # that a cp1252 console would decode into a different string.
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def changed_paths(base: str):
    """Changed paths, as git actually spells them.

    Read with `-z` and split on NUL, never `splitlines()` over the default output.
    Without `-z`, git C-quotes any path holding a byte outside ASCII: it wraps the path
    in double quotes and replaces each such byte with an octal escape, so a mirrored
    handoff document whose name contains an em dash arrives as a quoted string carrying
    three escape sequences where the dash was. That string starts with a quote, so no
    prefix test can match it, and this guard refused the first real mirror to reach it,
    #109, for being outside a directory it was inside. Every file under
    `06 - Handoff/` carries an em dash, which was most of the specification.

    `-z` also keeps a newline inside a filename from splitting one path into two.
    """
    out = _git(["diff", "--name-only", "-z", base + "...HEAD"])
    return [path for path in out.split("\x00") if path]


def commit_committer(sha: str):
    """The committer name of one commit, or None when it is not in this clone.

    `%cn`, not `%an`. A sync dispatched by an operator is authored by that operator and
    committed by the workflow identity; refusing it on the author would break a
    documented operating path — `spec-sync.yml` keeps `workflow_dispatch` precisely so
    a person can run it — while proving nothing about who wrote the bytes.
    """
    try:
        return _git(["log", "-1", "--format=%cn", sha]).strip()
    except subprocess.CalledProcessError:
        return None


def read_allowlist(path):
    if path is None:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="base ref to compare against")
    parser.add_argument("--head-ref", required=True, help="head branch name")
    parser.add_argument(
        "--head-sha",
        default=None,
        help="head commit; its committer is checked against the producing workflow",
    )
    args = parser.parse_args()

    cls = classify(args.head_ref)
    paths = changed_paths(args.base)

    tip = None
    if cls is not None and args.head_sha:
        tip = commit_committer(args.head_sha)
        if tip is None:
            print(
                "::error::machine-pr-guard: the head revision %s is not present in "
                "this clone, so its committer is unavailable; refusing rather than "
                "assuming it" % args.head_sha
            )
            return 1

    allowlist = read_allowlist(cls.allowlist if cls is not None else None)
    violations = check(args.head_ref, paths, allowlist, tip)

    if not violations:
        where = (
            "machine class %s" % cls.branch if cls is not None else "an ordinary branch"
        )
        print(
            "machine-pr-guard: passed over %d changed file(s) on %s"
            % (len(paths), where)
        )
        return 0

    for violation in violations:
        print("::error::machine-pr-guard: %s" % violation)
    return 1


if __name__ == "__main__":
    sys.exit(main())
