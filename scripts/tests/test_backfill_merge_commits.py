"""Recording where merged work landed, and refusing to invent it.

Eleven of twenty-three ledger rows carried no merge commit, eight of them marked
IMPLEMENTED, because the field is one the AUTHOR cannot know from inside its own pull
request and nothing filled it afterwards.
"""

import csv
import io
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import backfill_merge_commits as backfill  # noqa: E402
import release_tag  # noqa: E402

SHA = "30e029c2b5d1fda6c0e365d4c61ee790235b9d8d"
ROOT = pathlib.Path(__file__).resolve().parents[2]
LIVE_LEDGER = ROOT / "docs" / "spec" / "implementation_status.csv"

# Every merge on master is a squash, and GitHub ends a squash subject with the pull
# request's number in parentheses. That is the repository's own record of what merged,
# and it needs no network to read.
SQUASH_SUBJECT = re.compile(r"\(#(\d+)\)\s*$")


# A merged row's commit is filled by the provenance backfill, which proposes its own
# pull request the moment the merge lands and merges it a minute or two later. Inside
# that window a blank is the in-flight state, not the defect; a blank that outlives the
# window is. On 2026-09-10 the check without a window turned master red at 09:35:02Z, a
# minute before the backfill landed, and refused an unrelated pull request at 12:45Z for
# carrying that state of master.
BACKFILL_GRACE_SECONDS = 30 * 60


def merged_pulls_in_history(cwd=None):
    """{pull request number: squash commit time, unix seconds} from this checkout."""
    log = subprocess.run(
        ["git", "log", "--format=%ct %s"],
        cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8",
    ).stdout
    merged = {}
    for line in log.splitlines():
        stamp, _, subject = line.partition(" ")
        match = SQUASH_SUBJECT.search(subject)
        if match and stamp.isdigit():
            merged.setdefault(int(match.group(1)), int(stamp))
    return merged


def shallow_checkout(cwd=None) -> bool:
    """True when this checkout does not carry the history the check needs."""
    done = subprocess.run(
        ["git", "rev-parse", "--is-shallow-repository"],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8",
    )
    return done.stdout.strip() == "true"


def merged_without_commit(rows, merged, now, grace=BACKFILL_GRACE_SECONDS):
    """Identifiers whose row names a pull request merged longer than `grace` seconds
    ago and records no commit. Pure. `merged` maps pull number to merge time."""
    out = []
    for r in rows:
        pull = (r.get("PR") or "").strip()
        if not pull.isdigit() or (r.get("MERGE_COMMIT") or "").strip():
            continue
        merged_at = merged.get(int(pull))
        if merged_at is not None and now - merged_at > grace:
            out.append((r.get("REQ_ID") or "").strip())
    return out


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


class PreMergeLedgerLifecycleTests(unittest.TestCase):
    """The pre-merge ledger lifecycle: open PR rows can be blank, merged rows must not."""

    def _is_pr_merged(self, pr_number):
        """Override this in tests to control merge state. Production uses GitHub API."""
        # In production, this would query GitHub via backfill.merge_commit().
        # For testing, this is mocked to return True/False.
        raise NotImplementedError("must be mocked in test")

    def _validate_rows_by_merge_state(self, rows):
        """Check that only merged PRs can have blank MERGE_COMMIT.

        Open PRs are allowed blank MERGE_COMMIT (they haven't merged yet).
        Merged PRs must have their merge commit recorded.
        """
        violations = []
        for r in rows:
            pr = (r.get("PR") or "").strip()
            commit = (r.get("MERGE_COMMIT") or "").strip()

            if not pr:
                # No PR referenced, no requirement
                continue

            if commit:
                # Has merge commit, all good
                continue

            # PR referenced but no merge commit: only allowed if PR is still open
            if not self._is_pr_merged(pr):
                # Open PR with blank commit: allowed per AUTHOR_RUNBOOK section 7
                continue

            # Merged PR with blank commit: violation
            violations.append(r["REQ_ID"])

        return violations

    def test_an_open_pr_row_with_blank_commit_is_allowed(self):
        """Current pull request in-flight: blank MERGE_COMMIT allowed per runbook."""
        rows = [row(req_id="REQ-CURRENT", pull="999")]  # PR 999, blank commit

        def mock_is_merged(pr_num):
            # PR 999 (the current open PR) is not merged
            return pr_num != "999"

        with mock.patch.object(self, '_is_pr_merged', side_effect=mock_is_merged):
            violations = self._validate_rows_by_merge_state(rows)

        self.assertEqual(violations, [], "open PR should allow blank MERGE_COMMIT")

    def test_a_merged_pr_row_with_blank_commit_is_rejected(self):
        """Merged PR: blank MERGE_COMMIT is a defect that must be backfilled."""
        rows = [row(req_id="REQ-MERGED", pull="123", commit="")]  # Merged but blank

        def mock_is_merged(pr_num):
            # PR 123 is merged
            return pr_num == "123"

        with mock.patch.object(self, '_is_pr_merged', side_effect=mock_is_merged):
            violations = self._validate_rows_by_merge_state(rows)

        self.assertEqual(violations, ["REQ-MERGED"], "merged PR must have MERGE_COMMIT")

    def test_a_row_with_no_pr_reference_is_unaffected(self):
        """Rows without PR reference are not checked for merge state."""
        rows = [row(req_id="REQ-NOPR", pull="", commit="")]

        def mock_is_merged(pr_num):
            return True  # All merged, but this row has no PR

        with mock.patch.object(self, '_is_pr_merged', side_effect=mock_is_merged):
            violations = self._validate_rows_by_merge_state(rows)

        self.assertEqual(violations, [], "rows without PR reference not checked")

    def test_regression_live_ledger_no_merged_pr_without_commit(self):
        """Regression: the live ledger names no merged pull request without its commit.

        A blank `MERGE_COMMIT` is the documented in-flight state of a row whose pull
        request is still open (AUTHOR_RUNBOOK section 7); on a merged one it is the
        state the backfill exists to end. Whether a pull request merged is read from
        this checkout's history, never from the network. The earlier version asked
        `gh`, which is unauthenticated in CI, swallowed the failure and passed on every
        run over the two hours REQ-CONFIG-004 sat merged with a blank commit (#321).
        Without the history this skips, visibly; it never passes for want of looking.

        A blank inside the backfill's grace window is the in-flight state and passes;
        the two-hour blank that motivated this would fail after thirty minutes.
        """
        if shallow_checkout(cwd=ROOT):
            self.skipTest("shallow checkout: master's history is not available to read")
        rows = release_tag.read_rows(LIVE_LEDGER)
        self.assertEqual(
            merged_without_commit(rows, merged_pulls_in_history(cwd=ROOT), now=time.time()),
            [],
            "regression: live ledger has merged pull request(s) without a commit",
        )


class MergedWithoutCommitTests(unittest.TestCase):
    """The check behind the regression, on rows and history it controls."""

    HOUR = 3600

    def test_a_merged_pull_request_with_a_blank_commit_is_a_violation(self):
        # Merged an hour ago: the backfill has had its turn many times over.
        self.assertEqual(
            merged_without_commit([row(pull="239", commit="")], {239: 0}, now=self.HOUR),
            ["REQ-CORE-006"],
        )

    def test_a_blank_inside_the_backfill_window_is_in_flight(self):
        # Merged ten minutes ago: the backfill's own pull request is on its way.
        self.assertEqual(
            merged_without_commit([row(pull="239", commit="")], {239: 3000}, now=3600), []
        )

    def test_the_window_is_a_bound_not_a_licence(self):
        # One second past the grace window is a violation; at the boundary it is not.
        merged = {239: 0}
        self.assertEqual(
            merged_without_commit([row(pull="239", commit="")], merged, now=BACKFILL_GRACE_SECONDS),
            [],
        )
        self.assertEqual(
            merged_without_commit([row(pull="239", commit="")], merged, now=BACKFILL_GRACE_SECONDS + 1),
            ["REQ-CORE-006"],
        )

    def test_an_open_pull_request_with_a_blank_commit_is_in_flight(self):
        self.assertEqual(
            merged_without_commit([row(pull="239", commit="")], {238: 0}, now=self.HOUR), []
        )

    def test_a_recorded_commit_is_never_questioned(self):
        self.assertEqual(
            merged_without_commit([row(pull="239", commit=SHA)], {}, now=self.HOUR), []
        )

    def test_a_row_naming_no_pull_request_is_not_the_check_s_business(self):
        self.assertEqual(merged_without_commit([row(pull="", commit="")], {}, now=self.HOUR), [])

    def test_squash_subjects_are_read_from_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                subprocess.run(
                    ["git", *args], cwd=tmp, check=True, capture_output=True,
                    text=True, encoding="utf-8",
                )
            git("init", "-q", "-b", "master")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Test")
            for subject in (
                "Implement REQ-CORE-001: the first thing (#12)",
                "spec: sync specification mirror from Drive (#7)",
                "a commit that is not a squash",
                "PR #99 mentioned in the middle is not a merge",
            ):
                git("commit", "-q", "--allow-empty", "-m", subject)
            merged = merged_pulls_in_history(cwd=tmp)
            self.assertEqual(set(merged), {12, 7})
            for stamp in merged.values():
                self.assertGreater(stamp, 0)
                self.assertLessEqual(stamp, int(time.time()) + 60)
            self.assertFalse(shallow_checkout(cwd=tmp))


if __name__ == "__main__":
    unittest.main()
