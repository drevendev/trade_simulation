"""Render the implementation coverage table from evidence, instead of maintaining it.

The old table stored a status. A pull request merged somewhere else, the status became
wrong, and a later run had to notice and flip it — which is what reconciliation runs
were: pure bookkeeping, one AUTHOR run and one ACCEPTOR run each, changing no code.

The fix is to store only what does not go stale. This file is generated from two
sources:

* ``docs/spec/mirror/REQUIREMENTS_REGISTRY.csv`` — every requirement identifier that
  exists, and the specification's own status for it;
* ``docs/spec/implementation_status.csv`` — the ledger, one row per identifier that has
  reached a state worth recording, written by the AUTHOR run that produced it.

**A ledger row's presence on master is its merge evidence.** The row lands in the same
pull request as the work, so it exists on the default branch exactly when that work is
merged, and nothing later has to be flipped. There is no API call here on purpose: a
generator that asked GitHub anything could not be a CI gate, because its output would
depend on when it ran.

``--check`` fails when the rendered file does not match the sources, which catches both
a hand-edited table and a ledger row whose author forgot to regenerate.

Statuses a ledger row may carry:

``IMPLEMENTED``  merged code plus a named test that fails without it.
``PARTIAL``      merged code covering a named slice, with the rest explicitly open.
``BLOCKED``      cannot proceed; the blocking question is named in the evidence.
``DEFERRED``     deliberately out of scope for now, with the reason.
``CONTESTED``    implementable only once the researcher resolves a contradiction.

``IN_PROGRESS`` is deliberately absent. Claimed work is a ``status:in-progress`` label on
an Issue — a live fact the forge already owns, and the one this table kept getting wrong.
An identifier with no ledger row renders as ``NOT_STARTED``.
"""

from __future__ import annotations

import argparse
import csv
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
REGISTRY = REPO_ROOT / "docs" / "spec" / "mirror" / "REQUIREMENTS_REGISTRY.csv"
LEDGER = REPO_ROOT / "docs" / "spec" / "implementation_status.csv"
RENDERED = REPO_ROOT / "docs" / "spec" / "IMPLEMENTATION_STATUS.md"

BEGIN = "<!-- coverage:generated:begin -->"
END = "<!-- coverage:generated:end -->"

LEDGER_FIELDS = ["REQ_ID", "STATUS", "ISSUE", "PR", "MERGE_COMMIT", "EVIDENCE"]

# Every ledger status, and whether it must name a merged pull request. A status that
# claims merged code without one is a claim with no evidence behind it.
STATUSES = {
    "IMPLEMENTED": True,
    "PARTIAL": True,
    "BLOCKED": False,
    "DEFERRED": False,
    "CONTESTED": False,
}


def read_registry(path=REGISTRY):
    """Requirement identifiers in registry order, with the specification's own status."""
    with open(path, encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return [(row["REQ_ID"].strip(), row["STATUS"].strip()) for row in rows if row.get("REQ_ID")]


def read_ledger(path=LEDGER):
    with open(path, encoding="utf-8", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def validate(registry, ledger):
    """Every way the ledger can be wrong, named precisely enough to fix."""
    problems: list[str] = []
    known = {req_id for req_id, _ in registry}
    seen: set[str] = set()

    for index, row in enumerate(ledger, start=2):  # header is line 1
        req_id = (row.get("REQ_ID") or "").strip()
        status = (row.get("STATUS") or "").strip()
        evidence = (row.get("EVIDENCE") or "").strip()
        pr = (row.get("PR") or "").strip()

        if not req_id:
            problems.append("line %d: empty REQ_ID" % index)
            continue
        if req_id in seen:
            problems.append("line %d: %s appears more than once" % (index, req_id))
        seen.add(req_id)
        if req_id not in known:
            problems.append(
                "line %d: %s is not in %s; a requirement identifier is created by the "
                "researcher, never here" % (index, req_id, REGISTRY.name)
            )
        if status not in STATUSES:
            problems.append(
                "line %d: %s has status %r; allowed: %s"
                % (index, req_id, status, ", ".join(sorted(STATUSES)))
            )
            continue
        if not evidence:
            problems.append(
                "line %d: %s has no evidence. Every status is a claim, and a claim "
                "without evidence is not one" % (index, req_id)
            )
        if STATUSES[status] and not pr.isdigit():
            problems.append(
                "line %d: %s is %s but names no merged pull request"
                % (index, req_id, status)
            )
    return problems


def render(registry, ledger):
    by_id = {(row.get("REQ_ID") or "").strip(): row for row in ledger}

    lines = [
        BEGIN,
        "",
        "<!-- Generated by scripts/implementation_status.py from"
        " docs/spec/implementation_status.csv and the mirrored requirements registry.",
        "     Do not edit this block by hand: `policy-guard` regenerates it and fails on"
        " a difference. -->",
        "",
        "| REQ ID | Spec | Status | Issue | Merged in | Evidence |",
        "| --- | --- | --- | --- | --- | --- |",
    ]

    counts: dict[str, int] = {}
    for req_id, spec_status in registry:
        row = by_id.get(req_id)
        status = (row.get("STATUS") or "").strip() if row else "NOT_STARTED"
        counts[status] = counts.get(status, 0) + 1

        issue = (row.get("ISSUE") or "").strip() if row else ""
        pr = (row.get("PR") or "").strip() if row else ""
        commit = (row.get("MERGE_COMMIT") or "").strip() if row else ""
        evidence = (row.get("EVIDENCE") or "").strip() if row else "—"

        merged = "—"
        if pr:
            merged = "#%s, `%s`" % (pr, commit) if commit else "#%s" % pr

        lines.append(
            "| %s | `%s` | `%s` | %s | %s | %s |"
            % (
                req_id,
                spec_status,
                status,
                "#%s" % issue if issue else "—",
                merged,
                evidence,
            )
        )

    total = len(registry)
    implemented = counts.get("IMPLEMENTED", 0)
    tail = ["", "**Summary: %d of %d requirement identifiers implemented.**" % (implemented, total)]

    extra = [
        "%d %s" % (count, status.lower().replace("_", " "))
        for status, count in sorted(counts.items())
        if status not in ("IMPLEMENTED", "NOT_STARTED")
    ]
    if extra:
        tail.append("Also recorded: %s." % ", ".join(extra))
    tail.append(
        "The denominator is the data-row count of the mirrored registry at generation "
        "time; it is never carried forward from an earlier revision. Work that is "
        "claimed but not yet merged is a `status:in-progress` label on its Issue, not a "
        "row here."
    )

    return "\n".join(lines + tail + ["", END])


def splice(document: str, block: str) -> str:
    start = document.index(BEGIN)
    end = document.index(END) + len(END)
    return document[:start] + block + document[end:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the rendered file does not match the sources; write nothing",
    )
    args = parser.parse_args()

    registry = read_registry()
    ledger = read_ledger()

    problems = validate(registry, ledger)
    if problems:
        for problem in problems:
            print("::error::implementation-status: %s" % problem)
        return 1

    document = RENDERED.read_text(encoding="utf-8")
    if BEGIN not in document or END not in document:
        print(
            "::error::implementation-status: %s has no generated block; expected the "
            "markers %s and %s" % (RENDERED.name, BEGIN, END)
        )
        return 1

    updated = splice(document, render(registry, ledger))

    if args.check:
        if updated != document:
            print(
                "::error::implementation-status: %s is stale. Regenerate it with "
                "`python scripts/implementation_status.py` and commit the result."
                % RENDERED.name
            )
            return 1
        print(
            "implementation-status: %s matches %d ledger row(s) over %d registry row(s)"
            % (RENDERED.name, len(ledger), len(registry))
        )
        return 0

    RENDERED.write_text(updated, encoding="utf-8")
    print(
        "implementation-status: rendered %d ledger row(s) over %d registry row(s)"
        % (len(ledger), len(registry))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
