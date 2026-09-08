"""Reading what a run did instead of what it said, and not reading more than that.

The run this replays: on 2026-09-08 an ACCEPTOR selected #252, spent thirty-two turns,
posted a formal CHANGES_REQUESTED, and was recorded as `unknown` because its closing
words matched no pattern. One of the measurement's cleanliness criteria is "no runs with
outcome unknown", so a lie about wording was failing a criterion about behaviour.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import record_usage  # noqa: E402
import run_effect  # noqa: E402

ACCEPTOR = "zendev-acceptor"
AUTHOR = "zendev-author"
SINCE = "2026-09-08T00:00:37Z"
DURING = "2026-09-08T00:02:50Z"
BEFORE = "2026-09-07T22:34:12Z"


def review(state, at, who=ACCEPTOR, body=""):
    return {"state": state, "submittedAt": at, "body": body, "author": {"login": who}}


def comment(body, at, who=ACCEPTOR):
    return {"body": body, "createdAt": at, "author": {"login": who}}


def pull(number=252, merged=None, reviews=(), comments=()):
    return {"number": number, "mergedAt": merged,
            "reviews": list(reviews), "comments": list(comments)}


class AcceptorEffectTests(unittest.TestCase):
    def test_252_exactly(self):
        effect, reason = run_effect.acceptor_effect(
            pull(reviews=[review("CHANGES_REQUESTED", DURING)]), ACCEPTOR, SINCE
        )
        self.assertEqual(effect, run_effect.COMPLETED)
        self.assertIn("CHANGES_REQUESTED", reason)

    def test_a_verdict_posted_as_a_comment_counts(self):
        # Which shape a verdict takes is an accident of GitHub's same-account rule.
        effect, _ = run_effect.acceptor_effect(
            pull(comments=[comment("## ACCEPTOR Verdict: ACCEPT", DURING)]),
            ACCEPTOR, SINCE,
        )
        self.assertEqual(effect, run_effect.COMPLETED)

    def test_a_merge_during_the_run_counts(self):
        effect, reason = run_effect.acceptor_effect(
            pull(merged=DURING), ACCEPTOR, SINCE
        )
        self.assertEqual(effect, run_effect.COMPLETED)
        self.assertIn("merged", reason)

    def test_a_verdict_from_before_the_run_is_not_this_runs_work(self):
        # The whole point is what happened *during* this run. An older refusal standing
        # on the pull request would otherwise mark every later run as productive.
        effect, _ = run_effect.acceptor_effect(
            pull(reviews=[review("CHANGES_REQUESTED", BEFORE)]), ACCEPTOR, SINCE
        )
        self.assertEqual(effect, run_effect.NONE)

    def test_another_accounts_verdict_is_not_this_roles_effect(self):
        effect, _ = run_effect.acceptor_effect(
            pull(reviews=[review("APPROVED", DURING, who="drevendev")]), ACCEPTOR, SINCE
        )
        self.assertEqual(effect, run_effect.NONE)

    def test_a_qa_comment_during_the_run_is_not_this_roles_effect(self):
        effect, _ = run_effect.acceptor_effect(
            pull(comments=[comment("## SLOPSTER QA: FINDING", DURING, who="andy-zen-dev")]),
            ACCEPTOR, SINCE,
        )
        self.assertEqual(effect, run_effect.NONE)

    def test_a_run_that_only_talked_has_no_effect(self):
        effect, _ = run_effect.acceptor_effect(
            pull(comments=[comment("Looking at this now.", DURING)]), ACCEPTOR, SINCE
        )
        self.assertEqual(effect, run_effect.NONE)


class AuthorEffectTests(unittest.TestCase):
    def test_a_pull_request_opened_during_the_run_counts(self):
        pulls = [{"number": 283, "createdAt": DURING, "author": {"login": "app/" + AUTHOR}}]
        effect, reason = run_effect.author_effect(pulls, AUTHOR, SINCE)
        self.assertEqual(effect, run_effect.COMPLETED)
        self.assertIn("#283", reason)

    def test_a_push_to_an_older_pull_request_counts(self):
        pulls = [{"number": 252, "createdAt": BEFORE, "headCommittedAt": DURING,
                  "author": {"login": "app/" + AUTHOR}}]
        effect, reason = run_effect.author_effect(pulls, AUTHOR, SINCE)
        self.assertEqual(effect, run_effect.COMPLETED)
        self.assertIn("pushed", reason)

    def test_an_untouched_older_pull_request_is_not_an_effect(self):
        pulls = [{"number": 252, "createdAt": BEFORE, "headCommittedAt": BEFORE,
                  "author": {"login": "app/" + AUTHOR}}]
        self.assertEqual(run_effect.author_effect(pulls, AUTHOR, SINCE)[0], run_effect.NONE)

    def test_someone_elses_pull_request_is_not_this_roles_effect(self):
        pulls = [{"number": 283, "createdAt": DURING, "author": {"login": "drevendev"}}]
        self.assertEqual(run_effect.author_effect(pulls, AUTHOR, SINCE)[0], run_effect.NONE)

    def test_the_apps_two_spellings_are_one_identity(self):
        pulls = [{"number": 283, "createdAt": DURING,
                  "author": {"login": "zendev-author[bot]"}}]
        self.assertEqual(
            run_effect.author_effect(pulls, "app/zendev-author", SINCE)[0],
            run_effect.COMPLETED,
        )


class OrderingTests(unittest.TestCase):
    """Where the effect sits among the things that can decide an outcome."""

    def test_it_rescues_the_run_that_used_to_be_unknown(self):
        outcome, source = record_usage.classify_outcome("success", "…", effect="completed")
        self.assertEqual((outcome, source), ("completed", "forge"))

    def test_without_it_that_run_is_still_unknown(self):
        outcome, source = record_usage.classify_outcome("success", "…")
        self.assertEqual((outcome, source), ("unknown", "heuristic"))

    def test_it_does_not_overrule_the_runs_own_account_of_itself(self):
        # An effect says work happened, not that it went well. A run that posts a
        # verdict and reports being blocked is blocked, and only the run knows that.
        outcome, source = record_usage.classify_outcome(
            "success", "## AUTHOR run status update: BLOCKED on a missing decision",
            effect="completed",
        )
        self.assertEqual(source, "heuristic")
        self.assertNotEqual(outcome, "completed")

    def test_a_workflow_failure_still_wins(self):
        outcome, source = record_usage.classify_outcome(
            "failure", "anything", effect="completed"
        )
        self.assertEqual((outcome, source), ("failed", "workflow"))

    def test_no_work_from_the_workflow_still_wins(self):
        # The model was never started, so nothing it might have done is relevant.
        outcome, source = record_usage.classify_outcome(
            "no_work", "", effect="completed"
        )
        self.assertEqual((outcome, source), ("no_work", "workflow"))

    def test_a_run_with_no_effect_and_no_claim_stays_unknown(self):
        # Which is now a true statement rather than an artefact of phrasing.
        outcome, source = record_usage.classify_outcome("success", "…", effect="none")
        self.assertEqual((outcome, source), ("unknown", "heuristic"))


if __name__ == "__main__":
    unittest.main()
