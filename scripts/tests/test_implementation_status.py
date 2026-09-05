"""Negative controls for the coverage generator.

The table is only trustworthy if the generator refuses a ledger that claims more than it
proves, so most of these assert a refusal. The last group asserts the shipped files
actually agree, which makes this suite catch a stale table on its own — not only through
the `--check` invocation in CI.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import implementation_status as status  # noqa: E402

REGISTRY = [
    ("REQ-CORE-001", "READY"),
    ("REQ-CORE-002", "READY"),
    ("REQ-MARKET-001", "REVIEW"),
]


def row(req_id, status_name="IMPLEMENTED", issue="1", pr="2", commit="", evidence="a test"):
    return {
        "REQ_ID": req_id,
        "STATUS": status_name,
        "ISSUE": issue,
        "PR": pr,
        "MERGE_COMMIT": commit,
        "EVIDENCE": evidence,
    }


class ValidationTests(unittest.TestCase):
    def test_a_well_formed_ledger_passes(self):
        self.assertEqual(status.validate(REGISTRY, [row("REQ-CORE-001")]), [])

    def test_an_identifier_absent_from_the_registry_is_refused(self):
        problems = status.validate(REGISTRY, [row("REQ-CORE-999")])
        self.assertEqual(len(problems), 1)
        self.assertIn("REQ-CORE-999", problems[0])
        self.assertIn("not in", problems[0])

    def test_a_duplicate_identifier_is_refused(self):
        problems = status.validate(REGISTRY, [row("REQ-CORE-001"), row("REQ-CORE-001")])
        self.assertTrue(any("more than once" in p for p in problems))

    def test_an_unknown_status_is_refused(self):
        problems = status.validate(REGISTRY, [row("REQ-CORE-001", status_name="DONE")])
        self.assertEqual(len(problems), 1)
        self.assertIn("'DONE'", problems[0])

    def test_in_progress_is_not_a_ledger_status(self):
        # The staleness this generator removes came from storing exactly this.
        problems = status.validate(REGISTRY, [row("REQ-CORE-001", status_name="IN_PROGRESS")])
        self.assertEqual(len(problems), 1)
        self.assertIn("IN_PROGRESS", problems[0])

    def test_implemented_without_a_pull_request_is_refused(self):
        problems = status.validate(REGISTRY, [row("REQ-CORE-001", pr="")])
        self.assertEqual(len(problems), 1)
        self.assertIn("names no merged pull request", problems[0])

    def test_partial_without_a_pull_request_is_refused(self):
        problems = status.validate(REGISTRY, [row("REQ-CORE-001", status_name="PARTIAL", pr="")])
        self.assertEqual(len(problems), 1)
        self.assertIn("names no merged pull request", problems[0])

    def test_a_blocked_row_needs_no_pull_request_but_needs_a_reason(self):
        self.assertEqual(
            status.validate(REGISTRY, [row("REQ-CORE-001", status_name="BLOCKED", pr="")]), []
        )
        problems = status.validate(
            REGISTRY, [row("REQ-CORE-001", status_name="BLOCKED", pr="", evidence="")]
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("no evidence", problems[0])

    def test_a_pull_request_number_must_be_a_number(self):
        problems = status.validate(REGISTRY, [row("REQ-CORE-001", pr="soon")])
        self.assertEqual(len(problems), 1)
        self.assertIn("names no merged pull request", problems[0])


class RenderTests(unittest.TestCase):
    def test_every_registry_identifier_appears(self):
        block = status.render(REGISTRY, [row("REQ-CORE-001")])
        for req_id, _ in REGISTRY:
            self.assertIn(req_id, block)

    def test_an_identifier_with_no_ledger_row_is_not_started(self):
        block = status.render(REGISTRY, [row("REQ-CORE-001")])
        self.assertIn("| REQ-CORE-002 | `READY` | `NOT_STARTED` | — | — | — |", block)

    def test_the_specification_status_is_carried_through(self):
        block = status.render(REGISTRY, [])
        self.assertIn("| REQ-MARKET-001 | `REVIEW` | `NOT_STARTED` |", block)

    def test_the_denominator_comes_from_the_registry(self):
        block = status.render(REGISTRY, [row("REQ-CORE-001")])
        self.assertIn("**Summary: 1 of 3 requirement identifiers implemented.**", block)

    def test_non_implemented_statuses_are_summarised_separately(self):
        block = status.render(
            REGISTRY, [row("REQ-CORE-001"), row("REQ-CORE-002", status_name="PARTIAL")]
        )
        self.assertIn("**Summary: 1 of 3 requirement identifiers implemented.**", block)
        self.assertIn("Also recorded: 1 partial", block)

    def test_a_merge_commit_is_rendered_when_known_and_omitted_when_not(self):
        with_commit = status.render(REGISTRY, [row("REQ-CORE-001", commit="deadbee")])
        self.assertIn("#2, `deadbee`", with_commit)
        without = status.render(REGISTRY, [row("REQ-CORE-001")])
        self.assertIn("| #1 | #2 |", without)


class SpliceTests(unittest.TestCase):
    def test_only_the_marked_block_is_replaced(self):
        document = "before\n%s\nold\n%s\nafter\n" % (status.BEGIN, status.END)
        spliced = status.splice(document, "%s\nnew\n%s" % (status.BEGIN, status.END))
        self.assertTrue(spliced.startswith("before\n"))
        self.assertTrue(spliced.endswith("\nafter\n"))
        self.assertIn("new", spliced)
        self.assertNotIn("old", spliced)

    def test_a_hand_edited_block_no_longer_matches_its_sources(self):
        # What --check detects: the document is spliced from the sources, so any edit
        # inside the block produces a difference.
        block = status.render(REGISTRY, [row("REQ-CORE-001")])
        document = "head\n%s\ntail\n" % block
        tampered = document.replace("`NOT_STARTED`", "`IMPLEMENTED`")
        self.assertNotEqual(status.splice(tampered, block), tampered)


class ShippedFilesTests(unittest.TestCase):
    """The repository's own files must already agree — this is `--check` as a test."""

    def setUp(self):
        self.registry = status.read_registry()
        self.ledger = status.read_ledger()

    def test_the_shipped_ledger_is_valid(self):
        self.assertEqual(status.validate(self.registry, self.ledger), [])

    def test_the_rendered_table_is_current(self):
        document = status.RENDERED.read_text(encoding="utf-8")
        self.assertEqual(
            status.splice(document, status.render(self.registry, self.ledger)),
            document,
            "IMPLEMENTATION_STATUS.md is stale; run python scripts/implementation_status.py",
        )


if __name__ == "__main__":
    unittest.main()
