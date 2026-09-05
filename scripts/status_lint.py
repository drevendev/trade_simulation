"""Keep `docs/spec/IMPLEMENTATION_STATUS.md` honest about what actually merged.

That document is the repository's answer to "is the specification implemented?", and
it is maintained by hand inside pull requests. Two ways it drifted, both observed:

* **A requirement claimed by a merged pull request had no row at all.** `REQ-CONFIG-005`
  was implemented in part by #76 and never appeared in the table, so a later AUTHOR run
  opened a fresh Issue for it without noticing the overlap. Absence is invisible: no
  reader can miss a row that was never written.
* **A row cited a pull request that had not merged.** A proposed edit recorded a
  pending pull request and described its contents as evidence, which would have made
  the merged document assert the outcome of an unmerged change — the same error as
  promoting a check that never ran.

Both are arithmetic over the document and the pull request graph, so neither belongs
in a model run.

Three rules, and each one is a thing that went wrong rather than a thing that might:

1. Every requirement identifier named by a merged pull request's title has a row.
2. Every pull request cited in the `Merged in` column has actually merged.
3. The summary counts equal the rows they claim to count.

What this deliberately does not check: whether a row's *evidence* is any good, whether
the named test proves the requirement, or whether `IMPLEMENTED` is deserved. Those are
judgements, and a linter that pretended to make them would be trusted for something it
cannot do.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys

REQ_ID = re.compile(r"\bREQ-[A-Z]+-\d{3}\b")
ROW = re.compile(r"^\|\s*(REQ-[A-Z]+-\d{3})\s*\|(.*)$")
PR_REF = re.compile(r"#(\d+)")
SUMMARY = re.compile(
    r"\*\*Summary:\s*(\d+)\s+of\s+(\d+)\s+requirements implemented;\s*(\d+)\s+in progress\.\*\*"
)

IMPLEMENTED = "IMPLEMENTED"
IN_PROGRESS = "IN_PROGRESS"


def parse_rows(text: str):
    """Return [{req, status, issue_cell, merged_cell}] for every requirement row."""
    rows = []
    for line in text.splitlines():
        match = ROW.match(line)
        if not match:
            continue
        cells = [cell.strip() for cell in match.group(2).split("|")]
        # status | issue | merged in | proving test  (the trailing empty cell is the
        # row's closing pipe, and a short row is a malformed row, not a crash).
        if len(cells) < 3:
            rows.append(
                {"req": match.group(1), "status": "", "issue": "", "merged": "", "malformed": True}
            )
            continue
        rows.append(
            {
                "req": match.group(1),
                "status": cells[0].strip("`"),
                "issue": cells[1],
                "merged": cells[2],
                "malformed": False,
            }
        )
    return rows


def parse_summary(text: str):
    match = SUMMARY.search(text)
    if not match:
        return None
    return {
        "implemented": int(match.group(1)),
        "total": int(match.group(2)),
        "in_progress": int(match.group(3)),
    }


def lint(rows, summary, merged_pull_numbers, requirements_claimed_by_merged):
    """Pure. Returns a list of human-readable violations."""
    violations = []
    documented = {row["req"] for row in rows}

    for row in rows:
        if row["malformed"]:
            violations.append(f"{row['req']}: row has too few columns to read")

    for req in sorted(set(requirements_claimed_by_merged) - documented):
        where = ", ".join(f"#{p}" for p in sorted(requirements_claimed_by_merged[req]))
        violations.append(
            f"{req} was claimed by merged pull request(s) {where} but has no row; "
            "a requirement absent from the table cannot be noticed by a reader"
        )

    for row in rows:
        cited = {int(n) for n in PR_REF.findall(row["merged"])}
        unmerged = sorted(cited - merged_pull_numbers)
        for number in unmerged:
            violations.append(
                f"{row['req']}: the Merged in column cites #{number}, which has not "
                "merged; this document may not assert the outcome of an open change"
            )
        if row["status"] == IMPLEMENTED and not cited:
            violations.append(
                f"{row['req']}: marked {IMPLEMENTED} with no merged pull request cited"
            )

    if summary is None:
        violations.append("the Summary line is missing or does not parse")
    else:
        actual_implemented = sum(1 for row in rows if row["status"] == IMPLEMENTED)
        actual_in_progress = sum(1 for row in rows if row["status"] == IN_PROGRESS)
        if summary["implemented"] != actual_implemented:
            violations.append(
                f"the Summary claims {summary['implemented']} implemented; "
                f"{actual_implemented} rows say {IMPLEMENTED}"
            )
        if summary["in_progress"] != actual_in_progress:
            violations.append(
                f"the Summary claims {summary['in_progress']} in progress; "
                f"{actual_in_progress} rows say {IN_PROGRESS}"
            )

    return violations


def _gh(args):
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True
    ).stdout


def load_merged_pulls(repo: str):
    """Return (merged numbers, {REQ-ID: [pull numbers]}) from merged pull titles."""
    raw = _gh(
        [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "merged",
            "--limit",
            "200",
            "--json",
            "number,title",
        ]
    )
    numbers = set()
    claimed: dict[str, list[int]] = {}
    for pull in json.loads(raw):
        numbers.add(pull["number"])
        for req in REQ_ID.findall(pull.get("title") or ""):
            claimed.setdefault(req, []).append(pull["number"])
    return numbers, claimed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument(
        "--file", default="docs/spec/IMPLEMENTATION_STATUS.md", help="status document"
    )
    args = parser.parse_args()

    text = pathlib.Path(args.file).read_text(encoding="utf-8")
    merged_numbers, claimed = load_merged_pulls(args.repo)
    violations = lint(parse_rows(text), parse_summary(text), merged_numbers, claimed)

    if not violations:
        print(f"status-lint: {args.file} agrees with the merged pull requests")
        return 0

    for violation in violations:
        print(f"::error::status-lint: {violation}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
