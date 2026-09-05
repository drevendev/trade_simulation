"""Negative controls for the implementation-status lint.

Two of these reproduce drift that actually happened: a requirement claimed by a
merged pull request with no row at all, and a row citing a pull request that had not
merged.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import status_lint  # noqa: E402

HEADER = """| REQ ID | Status | Issue | Merged in | Proving test |
| --- | --- | --- | --- | --- |
"""


def document(rows, implemented=1, in_progress=0, total=32):
    body = HEADER + "".join(rows)
    return (
        f"{body}\n**Summary: {implemented} of {total} requirements implemented; "
        f"{in_progress} in progress.** trailing prose\n"
    )


ROW_DONE = "| REQ-CORE-001 | `IMPLEMENTED` | #46 | #48, `58a0b49` | src/domain/id.test.ts |\n"
ROW_OPEN = "| REQ-CONFIG-003 | `IN_PROGRESS` | #77 | (open) | partial slice |\n"


class MissingRowTests(unittest.TestCase):
    def test_a_requirement_claimed_by_a_merged_pull_request_must_have_a_row(self):
        # REQ-CONFIG-005 exactly: merged in #76, absent from the table, and therefore
        # re-opened as fresh work by a later run.
        text = document([ROW_DONE])
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers={48, 76},
            requirements_claimed_by_merged={"REQ-CORE-001": [48], "REQ-CONFIG-005": [76]},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("REQ-CONFIG-005", violations[0])
        self.assertIn("#76", violations[0])

    def test_a_documented_requirement_raises_nothing(self):
        text = document([ROW_DONE])
        self.assertEqual(
            status_lint.lint(
                status_lint.parse_rows(text),
                status_lint.parse_summary(text),
                merged_pull_numbers={48},
                requirements_claimed_by_merged={"REQ-CORE-001": [48]},
            ),
            [],
        )


class UnmergedCitationTests(unittest.TestCase):
    def test_a_row_may_not_cite_an_unmerged_pull_request(self):
        # The #87 defect: a merged document asserting the outcome of an open change.
        row = "| REQ-CONFIG-003 | `IN_PROGRESS` | #77, #83 | #79, `7f5da85`; #84 (pending) | mixed |\n"
        text = document([row], implemented=0, in_progress=1)
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers={79},
            requirements_claimed_by_merged={},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#84", violations[0])
        self.assertIn("has not merged", violations[0])

    def test_a_row_may_not_cite_the_pull_request_that_writes_it(self):
        # Observed on #91 within the hour: the author recorded its own open number as
        # the merge. It is false when the check runs, and a pull request closed
        # without merging — as #84 was — would leave it false forever.
        row = "| REQ-CONFIG-003 | `IN_PROGRESS` | #83 | #91 | slice two |\n"
        text = document([row], implemented=0, in_progress=1)
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers={79},
            requirements_claimed_by_merged={},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("write (open) instead", violations[0])

    def test_the_issue_column_may_cite_an_open_issue(self):
        # Issues are cited while open by design; only the Merged in column is checked.
        text = document([ROW_OPEN], implemented=0, in_progress=1)
        self.assertEqual(
            status_lint.lint(
                status_lint.parse_rows(text),
                status_lint.parse_summary(text),
                merged_pull_numbers=set(),
                requirements_claimed_by_merged={},
            ),
            [],
        )

    def test_implemented_without_a_merged_pull_request_is_refused(self):
        row = "| REQ-CORE-002 | `IMPLEMENTED` | #57 | (open) | some test |\n"
        text = document([row])
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers=set(),
            requirements_claimed_by_merged={},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("no merged pull request cited", violations[0])


class SummaryTests(unittest.TestCase):
    def test_a_wrong_implemented_count_is_refused(self):
        text = document([ROW_DONE], implemented=7)
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers={48},
            requirements_claimed_by_merged={},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("claims 7 implemented", violations[0])

    def test_a_wrong_in_progress_count_is_refused(self):
        # Adding a row and forgetting the count is how the summary went stale before.
        text = document([ROW_DONE, ROW_OPEN], implemented=1, in_progress=0)
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers={48},
            requirements_claimed_by_merged={},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("1 rows say IN_PROGRESS", violations[0])

    def test_a_missing_summary_is_refused_rather_than_ignored(self):
        text = HEADER + ROW_DONE
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers={48},
            requirements_claimed_by_merged={},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("Summary line is missing", violations[0])


class ParsingTests(unittest.TestCase):
    def test_the_legend_table_is_not_mistaken_for_requirement_rows(self):
        legend = "| `NOT_STARTED` | Present in the registry, no work begun |\n"
        self.assertEqual(status_lint.parse_rows(legend + ROW_DONE), [
            {
                "req": "REQ-CORE-001",
                "status": "IMPLEMENTED",
                "issue": "#46",
                "merged": "#48, `58a0b49`",
                "malformed": False,
            }
        ])

    def test_a_short_row_is_reported_rather_than_crashing(self):
        text = document(["| REQ-CORE-009 | `IMPLEMENTED` |\n"])
        violations = status_lint.lint(
            status_lint.parse_rows(text),
            status_lint.parse_summary(text),
            merged_pull_numbers=set(),
            requirements_claimed_by_merged={},
        )
        self.assertTrue(any("too few columns" in v for v in violations))


if __name__ == "__main__":
    unittest.main()
