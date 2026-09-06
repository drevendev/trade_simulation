"""Resolve the one conflict the forge itself created: the implementation ledger.

Every pull request that implements a requirement appends a row to
``docs/spec/implementation_status.csv`` and regenerates
``docs/spec/IMPLEMENTATION_STATUS.md`` from it. Two files, written by every branch. So
any two pull requests in flight conflict with each other, and any correction an
operator makes to the ledger conflicts with every branch that is open at the time.

That is not a hypothetical. On 2026-09-06 a correction returning two rows to
``PARTIAL`` made both open pull requests ``dirty`` in the same minute. Neither was
about those rows; both had merely appended a row of their own next to them. The AUTHOR
run that met them spent thirteen turns, said nothing, and ended — and would have done
so again every cycle, because its own ladder puts a failing check on its pull request
above every Issue in the queue. Two pull requests were closed by hand.

A conflict in product code is a judgement and stays the author's. A conflict in a file
the forge generates is not: the generated document is a pure function of the ledger, and
the ledger is a table keyed by requirement identifier, not prose. This resolves that
case and only that case.

## What it does

For an open loop pull request (``claude/**``) that GitHub reports as ``dirty``:

1. merge ``master`` into the branch and list the unmerged paths;
2. **refuse unless every one of them is a ledger file.** One product file among them and
   the whole merge is abandoned: the author's judgement is needed for that file, and a
   half-resolved merge is worse than none;
3. merge the ledger rows three ways, by requirement identifier — the same rule git
   applies to lines, applied to rows. A row only one side touched takes that side. A row
   both sides changed differently is a real disagreement about evidence, and the whole
   merge is abandoned for the author to settle;
4. regenerate the document from the merged ledger rather than merging its text, because
   it is generated and its text is not a source;
5. commit the merge and push it with the loop's own credential, so the branch is
   measured again.

## What it never does

It never resolves a conflict outside those two files, never picks a winner between two
rows that disagree, never touches a branch that is not the loop's, and never leaves a
partially resolved merge behind: every refusal aborts the merge first. It exits 0
whatever happened, like the sweep it runs beside — the outcome for a pull request is the
state the forge left it in, printed per branch.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import pathlib
import subprocess
import sys

import implementation_status
import machine_pr_guard
from update_branches import failure_detail

LOOP_PREFIX = "claude/"
DIRTY = "dirty"

LEDGER_CSV = "docs/spec/implementation_status.csv"
LEDGER_DOCUMENT = "docs/spec/IMPLEMENTATION_STATUS.md"
# The generated document is not merged, it is rewritten from the merged rows. The CSV is
# the only file here whose content is a source.
RESOLVABLE = frozenset({LEDGER_CSV, LEDGER_DOCUMENT})

# Stage numbers `git show :N:path` reads out of a conflicted index.
BASE, OURS, THEIRS = 1, 2, 3

# A credential helper that answers from the environment, so the token is never an
# argument: a command line is visible to every other process on the machine, and this
# one runs beside a model.
CREDENTIAL_HELPER = (
    '!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f'
)


# --------------------------------------------------------------------- pure


def should_resolve(pull):
    """(bool, reason). Pure: decides from one pull request object as the API returns it.

    Deliberately the same shape and the same refusals as `update_branches.should_update`,
    one state apart: that one repairs `behind`, this one attempts `dirty`.
    """
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
    if state != DIRTY:
        return False, f"mergeable_state is {state!r}, not {DIRTY!r}"
    return True, DIRTY


def only_the_ledger(paths):
    """Whether every unmerged path is one this may rewrite. Pure.

    An empty set is not resolvable: nothing conflicted, so there is nothing here to do
    and a caller that pushed anyway would be pushing an unexplained merge.
    """
    paths = list(paths)
    return bool(paths) and all(path in RESOLVABLE for path in paths)


def parse_ledger(text):
    """(header, rows) from a ledger CSV, or (None, []) for a side that has no file."""
    if text is None:
        return None, []
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return None, []
    return rows[0], [row for row in rows[1:] if row]


def merge_ledger_rows(base, ours, theirs):
    """Three-way merge of ledger rows by requirement identifier. Pure.

    Returns (rows, disagreements). The rule is git's own, one level up from lines: a row
    only one side changed takes that side; a row both sides changed differently is a
    disagreement this must not settle. A row absent from a side is a deletion by that
    side, and reads the same way.

    Order follows `theirs` — the base branch, the accepted history — with rows that exist
    only on the branch appended after it, which is the shape an append-only ledger has
    anyway.
    """
    def by_id(rows):
        return {row[0]: row for row in rows if row}

    base_rows, our_rows, their_rows = by_id(base), by_id(ours), by_id(theirs)

    merged, disagreements, seen = [], [], set()
    for identifier in [row[0] for row in theirs if row] + [row[0] for row in ours if row]:
        if identifier in seen:
            continue
        seen.add(identifier)

        mine = our_rows.get(identifier)
        yours = their_rows.get(identifier)
        original = base_rows.get(identifier)

        if mine == yours:
            row = mine
        elif mine == original:
            row = yours  # only the base branch touched it
        elif yours == original:
            row = mine  # only this branch touched it
        else:
            disagreements.append(identifier)
            continue
        if row is not None:
            merged.append(row)
    return merged, disagreements


def render_ledger(header, rows, newline="\r\n"):
    """The merged rows as a CSV document, in the ledger's own line ending. Pure."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator=newline)
    if header:
        writer.writerow(header)
    writer.writerows(rows)
    return out.getvalue()


# ---------------------------------------------------------------------- git


def git(args, root, token=None, check=False):
    command = ["git", "-C", str(root)]
    if token is not None:
        command += ["-c", f"credential.helper={CREDENTIAL_HELPER}"]
    command += list(args)
    # UTF-8 explicitly, not by locale: see the note in machine_pr_guard.py.
    result = subprocess.run(
        command, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if check and result.returncode:
        # Never the raw stderr: this runs with a credential in the environment and a
        # failed transport can echo a URL back.
        raise RuntimeError(f"git {args[0]} failed ({failure_detail(result.stderr, result.returncode)})")
    return result


def unmerged_paths(root):
    result = git(["diff", "--name-only", "--diff-filter=U"], root, check=True)
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def stage(root, number, path):
    """One side of a conflicted file, or None when that side does not have it."""
    result = git(["show", f":{number}:{path}"], root)
    return result.stdout if result.returncode == 0 else None


def abandon(root):
    git(["merge", "--abort"], root)


# ------------------------------------------------------------------ per pull


def resolve(root, pull, dry_run=False, push=True):
    """Attempt one pull request. Returns a sentence saying what happened."""
    number = pull["number"]
    branch = pull["head"]["ref"]

    ok, reason = should_resolve(pull)
    if not ok:
        return f"left alone: {reason}"

    try:
        git(["fetch", "origin", "master", branch], root, check=True)
        git(["checkout", "-B", f"zendev/resolve-{number}", f"origin/{branch}"], root, check=True)
    except RuntimeError as error:
        return f"not attempted: {error}"

    merge = git(["merge", "--no-commit", "--no-ff", "origin/master"], root)
    if merge.returncode == 0:
        # It merges after all: `dirty` was stale, and a merge nobody asked for is not
        # this script's to push. `update_branches.py` owns the clean case.
        abandon(root)
        return "left alone: it merges cleanly now; the sweep owns that case"

    conflicted = unmerged_paths(root)
    if not only_the_ledger(conflicted):
        abandon(root)
        outside = sorted(set(conflicted) - RESOLVABLE)
        return f"left to the author: conflicts outside the ledger ({', '.join(outside) or 'none listed'})"

    header, rows = None, []
    if LEDGER_CSV in conflicted:
        base_header, base_rows = parse_ledger(stage(root, BASE, LEDGER_CSV))
        our_header, our_rows = parse_ledger(stage(root, OURS, LEDGER_CSV))
        their_header, their_rows = parse_ledger(stage(root, THEIRS, LEDGER_CSV))
        header = their_header or our_header or base_header
        if our_header and their_header and our_header != their_header:
            abandon(root)
            return "left to the author: the ledger's columns differ between the two sides"
        rows, disagreements = merge_ledger_rows(base_rows, our_rows, their_rows)
        if disagreements:
            abandon(root)
            return (
                "left to the author: both sides changed "
                + ", ".join(disagreements)
                + " differently, and which evidence stands is a judgement"
            )
    else:
        # Only the generated document conflicted. The ledger merged cleanly, so the
        # document follows from the merged file already in the tree.
        header, rows = parse_ledger((root / LEDGER_CSV).read_text(encoding="utf-8"))

    if dry_run:
        abandon(root)
        return f"would resolve {len(conflicted)} ledger path(s) into {len(rows)} row(s)"

    (root / LEDGER_CSV).write_text(render_ledger(header, rows), encoding="utf-8", newline="")
    if implementation_status.main(["--root", str(root)]) != 0:
        abandon(root)
        return "left to the author: the merged ledger does not validate"

    git(["add", LEDGER_CSV, LEDGER_DOCUMENT], root, check=True)
    still = unmerged_paths(root)
    if still:
        abandon(root)
        return f"left to the author: {len(still)} path(s) still unmerged after the rewrite"

    message = (
        "Merge master into this branch, resolving the generated ledger\n\n"
        "The conflict was confined to docs/spec/implementation_status.csv and the\n"
        "document generated from it. Rows were merged by requirement identifier, each\n"
        "taken from the side that changed it, and the document was regenerated rather\n"
        "than merged. No product file was touched. See scripts/resolve_ledger_conflicts.py."
    )
    try:
        git(["commit", "--no-verify", "-m", message], root, check=True)
    except RuntimeError as error:
        abandon(root)
        return f"not resolved: {error}"

    if not push:
        return f"resolved locally, not pushed ({len(rows)} row(s))"
    result = git(["push", "origin", f"HEAD:{branch}"], root, token=True)
    if result.returncode:
        return f"resolved but not pushed: {failure_detail(result.stderr, result.returncode)}"
    return f"resolved and pushed: {len(rows)} ledger row(s), {len(conflicted)} path(s) merged"


# --------------------------------------------------------------------- main


def _gh(args):
    return subprocess.run(
        ["gh", *args], capture_output=True, text=True, encoding="utf-8"
    )


def read_pull(repo, number):
    result = _gh(["api", f"repos/{repo}/pulls/{number}"])
    if result.returncode:
        raise RuntimeError(f"could not read #{number}: {failure_detail(result.stderr, result.returncode)}")
    return json.loads(result.stdout)


def open_pull_numbers(repo):
    result = _gh(["api", f"repos/{repo}/pulls?state=open&per_page=100"])
    if result.returncode:
        raise RuntimeError(f"could not list pull requests: {failure_detail(result.stderr, result.returncode)}")
    return [int(pull["number"]) for pull in json.loads(result.stdout)]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--root", default=".", help="the checkout to merge in")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pull", type=int, help="one pull request number")
    group.add_argument("--all-open", action="store_true", help="every open pull request")
    parser.add_argument("--dry-run", action="store_true", help="decide and merge, but push nothing")
    args = parser.parse_args(argv)

    root = pathlib.Path(args.root).resolve()
    started_on = git(["rev-parse", "--abbrev-ref", "HEAD"], root).stdout.strip()

    try:
        numbers = [args.pull] if args.pull else open_pull_numbers(args.repo)
    except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"::warning::resolve-ledger: {error}")
        return 0

    for number in numbers:
        try:
            pull = read_pull(args.repo, number)
        except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
            print(f"::warning::resolve-ledger: {error}")
            continue
        ref = (pull.get("head") or {}).get("ref") or "?"
        try:
            outcome = resolve(root, pull, dry_run=args.dry_run)
        except (RuntimeError, OSError, ValueError, KeyError) as error:
            abandon(root)
            outcome = f"not resolved: {type(error).__name__}"
        print(f"resolve-ledger: #{number} {ref} {outcome}")

    if started_on and started_on != "HEAD":
        git(["checkout", "--force", started_on], root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
