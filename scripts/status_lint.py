"""Keep the implementation ledger honest about what actually merged.

`docs/spec/implementation_status.csv` is the repository's answer to "is the
specification implemented?", and `docs/spec/IMPLEMENTATION_STATUS.md` is rendered from
it by `implementation_status.py`. This checks the one thing that rendering cannot: how
the ledger relates to the pull request graph, which is outside the repository.

Two rules remain here, and each is a thing that went wrong rather than a thing that
might:

1. **Every requirement identifier named by a merged pull request's title has a ledger
   row.** `REQ-CONFIG-005` was implemented in part by #76 and recorded nowhere, so a
   later AUTHOR run opened #86 for it without noticing the overlap. Absence is
   invisible: no reader can miss a row that was never written. The rendered table now
   shows every registry identifier, so absence shows up as `NOT_STARTED` beside a
   requirement that demonstrably was started — which is a lie of the same shape.

   One exception, and it lasts exactly one change. An identifier is created by the
   researcher and reaches the repository through the machine mirror, so a pull request
   can merge under a name the registry does not know yet — #358 did, for
   `REQ-VISUALIZATION-007` — and then nothing can land: the mirror proposal that
   registers the identifier is refused here for the missing row, and the row cannot
   be written first because `implementation_status.validate` refuses an identifier the
   registry does not carry (#369). So the change that introduces an identifier into the
   registry — the proposal, and the push that lands it, each measured against its own
   base — may lack that identifier's row. That identifier only, that change only: the
   next change to land is refused until a truthful row exists. The set is computed from
   the diff between the base registry and this one, so no label, flag or body text can
   widen it or make it last.

2. **Every pull request a ledger row cites has merged** — except the pull request being
   checked, which is the row's own. That exception is new, and it is the mechanism that
   removed reconciliation runs: a row is appended by the pull request that earns it, so
   the row and the citation land together. A pull request closed without merging takes
   its row with it, and a row can never outlive the merge it claims. Any *other* open
   citation is still a document asserting the outcome of a change that has not landed,
   which is how #87 came to propose recording `#84 (pending merge)` as evidence.

Rules that used to live here and no longer can fail:

* *a malformed row* — rows are CSV, and `implementation_status.validate` refuses a row
  with an unknown status, a missing identifier or no evidence;
* *`IMPLEMENTED` citing no pull request* — same validator, and it needs no network, so
  it belongs there rather than here;
* *summary arithmetic* — the summary is computed by the generator from the rows it
  renders, and `implementation_status.py --check` proves the document matches. A parser
  re-deriving those counts here would be a second, weaker copy of an arithmetic that
  cannot disagree with itself.

What this deliberately does not check: whether a row's evidence is any good, whether the
named test proves the requirement, or whether `IMPLEMENTED` is deserved. Those are
judgements, and a linter pretending to make them would be trusted for something it
cannot do.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import subprocess
import sys

# Same directory. This module is run as `python scripts/status_lint.py`, so that
# directory is already first on the path; the tests put it there explicitly.
import implementation_status

REQ_ID = re.compile(r"\bREQ-[A-Z]+-\d{3}\b")

# Statuses that assert merged code. A row carrying one is claiming the pull request it
# cites actually landed.
CITES_MERGED_CODE = tuple(
    status for status, needs_pull in implementation_status.STATUSES.items() if needs_pull
)


def lint(
    rows,
    merged_pull_numbers,
    requirements_claimed_by_merged,
    self_pull=None,
    bootstrapping=frozenset(),
):
    """Pure. Returns a list of human-readable violations.

    `bootstrapping` is the set of identifiers this very change introduces into the
    registry — see `newly_registered` — and the only identifiers whose missing row is
    not a violation. A caller that is not measuring a change passes nothing, and then
    every claimed identifier must have its row.
    """
    violations = []
    recorded = {(row.get("REQ_ID") or "").strip() for row in rows}

    for req in sorted(set(requirements_claimed_by_merged) - recorded - set(bootstrapping)):
        where = ", ".join("#%d" % p for p in sorted(requirements_claimed_by_merged[req]))
        violations.append(
            "%s was claimed by merged pull request(s) %s but has no ledger row; the "
            "rendered table therefore calls it NOT_STARTED, which is false" % (req, where)
        )

    for row in rows:
        req = (row.get("REQ_ID") or "").strip()
        status = (row.get("STATUS") or "").strip()
        cited = (row.get("PR") or "").strip()
        if not cited.isdigit():
            # Absent or malformed citations are implementation_status.validate's
            # business; it runs without a network and names them precisely.
            continue
        number = int(cited)
        if number in merged_pull_numbers:
            continue
        if self_pull is not None and number == self_pull:
            # The row travels inside this pull request. It becomes true at the moment
            # it becomes visible on master, and false nowhere.
            continue
        violations.append(
            "%s: the ledger cites #%d, which has not merged. A row may cite the pull "
            "request that carries it — that one lands with the row — but no other open "
            "pull request, or the ledger asserts an outcome that has not happened%s"
            % (req, number, "" if status not in CITES_MERGED_CODE else " while claiming %s" % status)
        )

    return violations


def newly_registered(base_ids, head_ids):
    """The identifiers present in this registry and absent from the base's. Pure.

    This is the whole bootstrap: an identifier is introduced by exactly one change, so
    the set holds it for that change and for no change after it.
    """
    return frozenset(head_ids) - frozenset(base_ids)


def registry_ids_at(ref: str, cwd=None):
    """The requirement identifiers the registry held at `ref`.

    A ref that does not resolve raises LookupError: a check measured against nothing
    would treat every identifier as new, which is the permanent bypass the docstring
    rules out. A ref that resolves but holds no registry file returns the empty set —
    that is the one change which introduced the registry itself, and every identifier
    in it was new then.
    """
    resolved = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", ref + "^{commit}"],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8",
    )
    if resolved.returncode != 0:
        raise LookupError("the base %r does not resolve to a commit" % ref)
    shown = subprocess.run(
        ["git", "show", "%s:%s" % (ref, implementation_status.REGISTRY_PATH)],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8",
    )
    if shown.returncode != 0:
        if "does not exist in" in shown.stderr or "exists on disk, but not in" in shown.stderr:
            return frozenset()
        raise LookupError(
            "the registry at %r could not be read: %s" % (ref, shown.stderr.strip())
        )
    rows = csv.DictReader(io.StringIO(shown.stdout))
    return frozenset(row["REQ_ID"].strip() for row in rows if row.get("REQ_ID"))


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
        "--self",
        dest="self_pull",
        default="",
        help="the pull request being checked, whose own number a row may cite",
    )
    parser.add_argument(
        "--base",
        default="",
        help=(
            "the git ref this change is measured against: the base branch of a pull "
            "request, the parent commit of a push. An identifier the registry gains "
            "relative to it may lack its ledger row in this change only. Empty means "
            "nothing is being introduced, and every claimed identifier needs its row"
        ),
    )
    args = parser.parse_args()

    rows = implementation_status.read_ledger()
    self_pull = int(args.self_pull) if args.self_pull.strip().isdigit() else None

    head_ids = frozenset(req for req, _ in implementation_status.read_registry())
    if args.base.strip():
        try:
            base_ids = registry_ids_at(args.base.strip(), cwd=implementation_status.REPO_ROOT)
        except LookupError as exc:
            print("::error::status-lint: %s" % exc)
            return 1
        bootstrapping = newly_registered(base_ids, head_ids)
    else:
        bootstrapping = frozenset()

    merged_numbers, claimed = load_merged_pulls(args.repo)
    recorded = {(row.get("REQ_ID") or "").strip() for row in rows}
    for req in sorted((set(claimed) - recorded) & bootstrapping):
        where = ", ".join("#%d" % p for p in sorted(claimed[req]))
        print(
            "::notice::status-lint: %s is claimed by merged pull request(s) %s and has "
            "no ledger row; permitted once, because this change is the one that "
            "registers it. The next change to land is refused until a truthful row "
            "exists." % (req, where)
        )
    violations = lint(rows, merged_numbers, claimed, self_pull, bootstrapping)

    if not violations:
        print(
            "status-lint: %d ledger row(s) agree with the merged pull requests"
            % len(rows)
        )
        return 0

    for violation in violations:
        print("::error::status-lint: %s" % violation)
    return 1


if __name__ == "__main__":
    sys.exit(main())
