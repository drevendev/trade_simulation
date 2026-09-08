"""Recording where merged work landed, and refusing to invent it.

Eleven of twenty-three ledger rows carried no merge commit, eight of them marked
IMPLEMENTED, because the field is one the AUTHOR cannot know from inside its own pull
request and nothing filled it afterwards.
"""

import csv
import io
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import backfill_merge_commits as backfill  # noqa: E402
import release_tag  # noqa: E402

SHA = "30e029c2b5d1fda6c0e365d4c61ee790235b9d8d"


def row(req_id="REQ-CORE-006", status="IMPLEMENTED", pull="239", commit="",
        evidence="landed"):
    return {"REQ_ID": req_id, "STATUS": status, "ISSUE": "235", "PR": pull,
            "MERGE_COMMIT": commit, "EVIDENCE": evidence}


class SelectionTests(unittest.TestCase):
    def test_a_row_naming_a_pull_request_with_no_commit_is_selected(self):
        self.assertEqual(len(backfill.rows_needing_backfill([row()])), 1)

    def test_a_row_that_already_has_its_commit_is_left_alone(self):
        # Never rewrite provenance that is already recorded: the ledger is the record,
        # and a second opinion about where work landed is not an improvement.
        self.assertEqual(backfill.rows_needing_backfill([row(commit=SHA)]), [])

    def test_a_row_naming_no_pull_request_is_not_selected(self):
        self.assertEqual(backfill.rows_needing_backfill([row(pull="")]), [])

    def test_whitespace_is_not_a_recorded_commit(self):
        self.assertEqual(len(backfill.rows_needing_backfill([row(commit="   ")])), 1)


class WritingTests(unittest.TestCase):
    def test_evidence_holding_a_comma_survives_a_round_trip(self):
        # The defect this repair exists beside: an unquoted comma turned ten rows into
        # more than six fields, and every reader saw only the text before it.
        evidence = "Tests: a.test.ts, b.test.ts; typecheck clean, build succeeded"
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ledger.csv"
            backfill.write_ledger(path, [row(evidence=evidence, commit=SHA)])
            with io.open(path, encoding="utf-8", newline="") as handle:
                parsed = list(csv.DictReader(handle))
        self.assertEqual(len(parsed), 1)
        self.assertIsNone(parsed[0].get(None), "the row split into extra fields")
        self.assertEqual(parsed[0]["EVIDENCE"], evidence)

    def test_only_the_six_declared_columns_are_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ledger.csv"
            extra = dict(row(), NOTES="something a hand-edit left behind")
            backfill.write_ledger(path, [extra])
            header = io.open(path, encoding="utf-8").readline().strip()
        self.assertEqual(header, ",".join(backfill.FIELDS))


class ReleaseRefusesBlankProvenanceTests(unittest.TestCase):
    """The reason any of this matters."""

    def test_a_complete_milestone_with_a_blank_commit_is_named(self):
        rows = [row(req_id="REQ-A", commit=SHA), row(req_id="REQ-B", commit="")]
        self.assertEqual(
            release_tag.missing_provenance(rows, ["REQ-A", "REQ-B"]), ["REQ-B"]
        )

    def test_full_provenance_reports_nothing_missing(self):
        rows = [row(req_id="REQ-A", commit=SHA), row(req_id="REQ-B", commit=SHA)]
        self.assertEqual(release_tag.missing_provenance(rows, ["REQ-A", "REQ-B"]), [])

    def test_a_milestone_is_not_tagged_while_provenance_is_blank(self):
        # Tagging it would mint a coverage digest that cannot tell these commits from
        # any later repair of the same milestone, which is the one thing the digest
        # exists to do.
        rows = [row(req_id="REQ-A", commit=""), row(req_id="REQ-B", commit=SHA)]
        planned = release_tag.plan(rows, {"M0": ["REQ-A", "REQ-B"]}, {})
        self.assertEqual(planned, [])

    def test_the_same_milestone_is_tagged_once_provenance_is_recorded(self):
        rows = [row(req_id="REQ-A", commit=SHA), row(req_id="REQ-B", commit="b" * 40)]
        planned = release_tag.plan(rows, {"M0": ["REQ-A", "REQ-B"]}, {})
        self.assertEqual([entry["tag"] for entry in planned], ["v0.0.0"])

    def test_blank_commits_no_longer_collide_in_the_digest(self):
        # Two milestones satisfied at genuinely different commits must not hash alike.
        before = [row(req_id="REQ-A", commit="a" * 40)]
        after = [row(req_id="REQ-A", commit="c" * 40)]
        self.assertNotEqual(
            release_tag.coverage_digest(before), release_tag.coverage_digest(after)
        )


class TheRepositorysOwnLedgerTests(unittest.TestCase):
    def test_no_row_that_names_a_merged_pull_request_lacks_its_commit(self):
        # The state this repair produced, asserted so it cannot quietly return.
        rows = release_tag.read_rows(
            pathlib.Path(__file__).resolve().parents[2]
            / "docs" / "spec" / "implementation_status.csv"
        )
        blank = [
            r["REQ_ID"] for r in rows
            if (r.get("PR") or "").strip() and not (r.get("MERGE_COMMIT") or "").strip()
        ]
        self.assertEqual(blank, [], "rows naming a pull request with no merge commit")


if __name__ == "__main__":
    unittest.main()
