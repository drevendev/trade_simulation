"""When a pull request no run can reach is ended, and when it is left alone.

Each closing test replays a pull request that actually accumulated in the queue on
2026-09-06/07 and had to be ended by hand. Each keeping test is a way this bound could
destroy work that was fine.
"""

import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import stale_pull_requests as stale  # noqa: E402

NOW = dt.datetime(2026, 9, 8, 12, 0, tzinfo=dt.timezone.utc)
HOURS = 24
ACCEPTOR = "zendev-acceptor"
OLD = "2026-09-06T10:00:00Z"   # 50 hours before NOW
RECENT = "2026-09-08T06:00:00Z"  # 6 hours before NOW


def pull(number=208, draft=False, labels=(), head_ref="claude/issue-201-config-004",
         author="app/zendev-author", comments=(), reviews=(), created=OLD):
    return {
        "number": number,
        "createdAt": created,
        "isDraft": draft,
        "labels": [{"name": name} for name in labels],
        "headRefName": head_ref,
        "headRefOid": "20045a28" + "0" * 32,
        "author": {"login": author},
        "url": f"https://github.com/drevendev/trade_simulation/pull/{number}",
        "body": f"Closes #{number - 8}",
        "comments": [{"body": b, "createdAt": t, "author": {"login": who}}
                     for b, t, who in comments],
        "reviews": [{"body": b, "submittedAt": t, "state": s, "author": {"login": who}}
                    for b, t, s, who in reviews],
    }


def call(p, committed=OLD, eligible=False, hours=HOURS):
    return stale.verdict(p, committed, NOW, hours, eligible, ACCEPTOR)


class ClosesWhatNothingCanReachTests(unittest.TestCase):
    def test_208_accepted_on_a_head_that_cannot_merge(self):
        # The ACCEPTOR's own ACCEPT sat on the head, so no run would select it again;
        # branch protection would not merge it. 36 hours, ended by hand.
        action, reason = call(pull(reviews=[
            ("", "2026-09-06T10:03:14Z", "CHANGES_REQUESTED", ACCEPTOR),
        ]))
        self.assertEqual(action, "close")
        self.assertIn("no review run can select it", reason)

    def test_242_quietly_superseded_by_a_duplicate(self):
        action, _ = call(pull(number=242, head_ref="claude/issue-240-acceptance-003"))
        self.assertEqual(action, "close")

    def test_285_a_freshly_opened_pull_request_is_never_stale(self):
        # #285: the AUTHOR re-proposed a branch it had abandoned the day before,
        # without touching its head. Every other signal was 24 hours old, the
        # arithmetic said "idle 24.3h", and this bound closed the pull request two
        # minutes after it was opened. Opening one is an act.
        action, reason = call(
            pull(number=285, created="2026-09-08T11:58:00Z"), committed=OLD
        )
        self.assertEqual(action, "keep", reason)

    def test_a_pull_request_opened_long_ago_and_untouched_is_still_stale(self):
        # The other half: creation is progress once, not forever.
        action, _ = call(pull(created=OLD), committed=OLD)
        self.assertEqual(action, "close")

    def test_the_window_is_measured_from_the_head_not_from_the_opening(self):
        # A pull request opened days ago whose head moved an hour ago is working.
        action, reason = call(pull(), committed=RECENT)
        self.assertEqual(action, "keep")
        self.assertIn("inside the", reason)


class RefusesToDestroyWorkTests(unittest.TestCase):
    def test_a_selectable_pull_request_is_queued_not_stuck(self):
        # The half that makes this safe. Age alone must never close anything.
        action, reason = call(pull(), eligible=True)
        self.assertEqual(action, "keep")
        self.assertIn("queued, not stuck", reason)

    def test_a_draft_is_left_alone(self):
        action, reason = call(pull(draft=True))
        self.assertEqual(action, "keep")
        self.assertIn("draft", reason)

    def test_the_mirror_is_not_this_jobs_to_close(self):
        # stale_mirror_pr.py owns that class with a much shorter fuse.
        action, reason = call(pull(head_ref="spec-mirror"))
        self.assertEqual(action, "keep")
        self.assertIn("machine-generated", reason)

    def test_a_pull_request_a_person_owns_is_reported_never_closed(self):
        # #223 carried this label for hours. Overriding it would be a race with the
        # operator, not a bound.
        action, reason = call(pull(number=223, labels=["status:needs-decision"]))
        self.assertEqual(action, "report")
        self.assertIn("a person owns this decision", reason)

    def test_the_authors_own_comment_is_progress(self):
        action, reason = call(pull(comments=[
            ("## AUTHOR handoff: rebased onto master", RECENT, "app/zendev-author"),
        ]))
        self.assertEqual(action, "keep")
        self.assertIn("advanced", reason)

    def test_an_acceptor_verdict_is_progress(self):
        action, _ = call(pull(reviews=[("", RECENT, "CHANGES_REQUESTED", ACCEPTOR)]))
        self.assertEqual(action, "keep")

    def test_an_acceptor_verdict_posted_as_a_comment_counts_the_same(self):
        # Which shape a verdict takes is an accident of GitHub's same-account rule.
        action, _ = call(pull(comments=[
            ("## ACCEPTOR Verdict: ACCEPT", RECENT, "zendev-acceptor[bot]"),
        ]))
        self.assertEqual(action, "keep")


class ThirdPartyVoicesDoNotKeepABranchAliveTests(unittest.TestCase):
    """The same rule the verdict follows: a voice that cannot move it cannot hold it."""

    def test_a_qa_comment_is_evidence_not_progress(self):
        # SLOPSTER runs hourly. If its comments reset the clock, no branch is ever
        # unreachable again and this bound quietly stops existing.
        action, reason = call(pull(comments=[
            ("## SLOPSTER QA: FINDING\nHead `20045a28`", RECENT, "andy-zen-dev"),
        ]))
        self.assertEqual(action, "close")
        self.assertIn("no review run can select it", reason)

    def test_a_researcher_review_is_evidence_not_progress(self):
        action, _ = call(pull(reviews=[
            ("looks fine to me", RECENT, "APPROVED", "drevendev"),
        ]))
        self.assertEqual(action, "close")

    def test_an_operator_comment_is_evidence_not_progress(self):
        action, _ = call(pull(comments=[("bumping this", RECENT, "drevendev")]))
        self.assertEqual(action, "close")


class WindowTests(unittest.TestCase):
    def test_the_window_is_configurable(self):
        # 50 hours idle: inside a 72-hour window, outside a 24-hour one.
        self.assertEqual(call(pull(), hours=72)[0], "keep")
        self.assertEqual(call(pull(), hours=24)[0], "close")

    def test_an_unreadable_timestamp_reads_as_old_not_as_fresh(self):
        # Failing toward "old" is safe: eligibility still has to agree before anything
        # closes. Failing toward "fresh" would silently disable the bound.
        self.assertEqual(
            stale.parse_time("not a date"),
            dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc),
        )


if __name__ == "__main__":
    unittest.main()
