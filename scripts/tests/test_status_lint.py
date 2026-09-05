"""Negative controls for the implementation-ledger lint.

Three of these reproduce drift that actually happened: a requirement claimed by a merged
pull request with no row at all (REQ-CONFIG-005, merged in #76), a row citing another
pull request that had not merged (#87 proposing `#84 (pending merge)` as evidence), and
a row citing its own open pull request (#91).

The third one changed meaning, and deliberately. When the status document was
maintained by hand, a row could be written by any pull request, so citing an open one —
including its own — asserted an outcome that had not happened, and #84 showed a cited
pull request can be closed without ever merging. Under the ledger a row is appended by
the pull request that earns it: the row and the citation land together, and a pull
request closed without merging takes its row with it. So a row may cite the pull request
that carries it, and nothing else that is open.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import status_lint  # noqa: E402


def row(req="REQ-CORE-001", status="IMPLEMENTED", issue="46", pr="48", evidence="a test"):
    return {
        "REQ_ID": req,
        "STATUS": status,
        "ISSUE": issue,
        "PR": pr,
        "MERGE_COMMIT": "",
        "EVIDENCE": evidence,
    }


class MissingRowTests(unittest.TestCase):
    def test_a_requirement_claimed_by_a_merged_pull_request_must_have_a_row(self):
        # REQ-CONFIG-005 exactly: merged in #76, recorded nowhere, and therefore
        # re-opened as fresh work by a later run.
        violations = status_lint.lint(
            [row()],
            merged_pull_numbers={48, 76},
            requirements_claimed_by_merged={"REQ-CORE-001": [48], "REQ-CONFIG-005": [76]},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("REQ-CONFIG-005", violations[0])
        self.assertIn("#76", violations[0])
        self.assertIn("NOT_STARTED", violations[0])

    def test_a_recorded_requirement_raises_nothing(self):
        self.assertEqual(
            status_lint.lint(
                [row()],
                merged_pull_numbers={48},
                requirements_claimed_by_merged={"REQ-CORE-001": [48]},
            ),
            [],
        )


class UnmergedCitationTests(unittest.TestCase):
    def test_a_row_may_not_cite_another_open_pull_request(self):
        # The #87 defect, in ledger form.
        violations = status_lint.lint(
            [row(req="REQ-CONFIG-003", status="PARTIAL", pr="84")],
            merged_pull_numbers={79},
            requirements_claimed_by_merged={},
            self_pull=98,
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#84", violations[0])
        self.assertIn("has not merged", violations[0])
        self.assertIn("PARTIAL", violations[0])

    def test_a_row_may_cite_the_pull_request_that_carries_it(self):
        # #91's shape, now correct: the row is inside the pull request it names, so it
        # becomes true exactly when it becomes visible, and false nowhere.
        self.assertEqual(
            status_lint.lint(
                [row(req="REQ-CONFIG-003", status="PARTIAL", pr="91")],
                merged_pull_numbers={79},
                requirements_claimed_by_merged={},
                self_pull=91,
            ),
            [],
        )

    def test_that_exemption_is_for_one_pull_request_only(self):
        # Being checked on #91 does not license a row citing some other open change.
        violations = status_lint.lint(
            [row(pr="91"), row(req="REQ-CORE-002", pr="84")],
            merged_pull_numbers=set(),
            requirements_claimed_by_merged={},
            self_pull=91,
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#84", violations[0])

    def test_a_push_event_has_no_self_and_refuses_every_open_citation(self):
        # On master there is no pull request being checked, and every row there arrived
        # by merging, so an unmerged citation is unambiguously wrong.
        violations = status_lint.lint(
            [row(pr="91")],
            merged_pull_numbers={79},
            requirements_claimed_by_merged={},
            self_pull=None,
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#91", violations[0])

    def test_the_issue_field_may_name_an_open_issue(self):
        # Issues are cited while open by design; only the pull request is checked.
        self.assertEqual(
            status_lint.lint(
                [row(issue="83", pr="48")],
                merged_pull_numbers={48},
                requirements_claimed_by_merged={},
            ),
            [],
        )


class DelegationTests(unittest.TestCase):
    """Everything this no longer checks is checked somewhere that needs no network."""

    def test_a_row_with_no_pull_request_is_left_to_the_validator(self):
        # implementation_status.validate refuses IMPLEMENTED without a pull request,
        # offline and by identifier. Repeating it here would put the same rule behind a
        # network call and let the two disagree.
        self.assertEqual(
            status_lint.lint(
                [row(status="BLOCKED", pr="")],
                merged_pull_numbers=set(),
                requirements_claimed_by_merged={},
            ),
            [],
        )

    def test_statuses_that_assert_merged_code_are_read_from_the_generator(self):
        # One definition of "this status claims merged code", not two.
        self.assertIn("IMPLEMENTED", status_lint.CITES_MERGED_CODE)
        self.assertIn("PARTIAL", status_lint.CITES_MERGED_CODE)
        self.assertNotIn("BLOCKED", status_lint.CITES_MERGED_CODE)


if __name__ == "__main__":
    unittest.main()
