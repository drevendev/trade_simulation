"""Fill in the merge commit a ledger row could not know when it was written.

`MERGE_COMMIT` names the commit that satisfied a requirement. The AUTHOR cannot write
it: the row lands *inside* the pull request, and the squash commit does not exist until
that pull request merges. So the runbook called the field optional, and eleven of
twenty-three rows were blank — eight of them marked IMPLEMENTED.

That was survivable while nothing read the field. `release_tag.py` reads it: the
coverage digest that decides whether a milestone has been released at these commits or
different ones is a hash of `(REQ_ID, MERGE_COMMIT)` pairs. With blanks in it, a
milestone repaired at new commits hashes identically to the one released before, and the
patch tag that exists for exactly that case is never cut. Release notes rendered the
same blanks as `—`.

A field no one is responsible for filling is not optional, it is broken. This is the
missing step: after a merge lands, ask the forge which commit each row's pull request
became, and write it down. No judgement is involved — the mapping from a merged pull
request to its merge commit is a fact GitHub already holds — so no model runs and no
review is needed.

## What it will not do

It fills blanks. It never rewrites a `MERGE_COMMIT` that is already there, never touches
a row whose pull request is not merged, and never changes `STATUS`. Whether a
requirement is satisfied is a judgement, made by the ACCEPTOR against acceptance
criteria; this only records where the work landed.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import pathlib
import subprocess
import sys

FIELDS = ["REQ_ID", "STATUS", "ISSUE", "PR", "MERGE_COMMIT", "EVIDENCE"]


def _gh(args):
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def merge_commit(repo: str, pull: str):
    """The squash commit a merged pull request became, or None.

    None for anything not merged, including a pull request closed unmerged: a row whose
    pull request was rejected has no provenance to record, and inventing one would be
    worse than the blank.
    """
    try:
        data = json.loads(
            _gh(["pr", "view", str(pull), "--repo", repo, "--json", "state,mergeCommit"])
        )
    except (subprocess.CalledProcessError, ValueError):
        return None
    if data.get("state") != "MERGED":
        return None
    commit = data.get("mergeCommit") or {}
    return commit.get("oid") or None


def rows_needing_backfill(rows):
    """Rows that name a pull request and carry no merge commit yet."""
    return [
        row for row in rows
        if (row.get("PR") or "").strip() and not (row.get("MERGE_COMMIT") or "").strip()
    ]


def read_ledger(path):
    with io.open(path, encoding="utf-8", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def write_ledger(path, rows) -> None:
    # QUOTE_MINIMAL with a real writer, so an EVIDENCE cell holding a comma is quoted
    # rather than silently becoming extra fields — the defect that truncated ten rows
    # at their first comma. `implementation_status.py --check` refuses those rows now,
    # and nothing this writes can create one.
    with io.open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=FIELDS, quoting=csv.QUOTE_MINIMAL, lineterminator="\n"
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({field: (row.get(field) or "").strip() for field in FIELDS})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    root = pathlib.Path(__file__).resolve().parents[1]
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument(
        "--ledger", default=str(root / "docs" / "spec" / "implementation_status.csv")
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    rows = read_ledger(args.ledger)
    pending = rows_needing_backfill(rows)
    if not pending:
        print("backfill: every row that names a pull request already has its commit")
        return 0

    filled = 0
    for row in pending:
        pull = (row["PR"] or "").strip()
        sha = merge_commit(args.repo, pull)
        if not sha:
            print(f"  {row['REQ_ID']}: #{pull} is not merged; nothing to record yet")
            continue
        print(f"  {row['REQ_ID']}: #{pull} -> {sha[:12]}")
        row["MERGE_COMMIT"] = sha
        filled += 1

    if filled and not args.dry_run:
        write_ledger(args.ledger, rows)
    print(f"backfill: {filled} row(s) gained their merge commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
