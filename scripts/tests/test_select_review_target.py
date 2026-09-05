"""Negative controls for review selection.

The first test is the one that matters: it is the exact situation that burned two
consecutive ACCEPTOR runs on #84 and starved three other pull requests of review.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import select_review_target as select  # noqa: E402

HEAD = "d8e28d3e2df15c93c1df3e41eceb640996024907"
COMMITTED = "2026-09-05T05:35:00Z"


def check(name, conclusion):
    return {"name": name, "conclusion": conclusion}


# A head that has been measured and is clean. This is the default because it is the
# ordinary case; an empty rollup means *nothing has reported yet*, which is its own
# condition and is asserted for explicitly below.
MEASURED_CLEAN = (
    check("mergeability", "SUCCESS"),
    check("typescript", "SUCCESS"),
    check("build-and-test", "SUCCESS"),
    check("policy-guard", "SUCCESS"),
)


def pull(number=84, created="2026-09-05T05:35:16Z", draft=False, labels=(), checks=None, head_ref="claude/issue-84-example"):
    return {
        "number": number,
        "createdAt": created,
        "isDraft": draft,
        "labels": [{"name": name} for name in labels],
        "headRefName": head_ref,
        "headRefOid": HEAD,
        "statusCheckRollup": list(MEASURED_CLEAN if checks is None else checks),
    }


def comment(body, created):
    return {"body": body, "createdAt": created}


class EligibilityTests(unittest.TestCase):
    def test_an_unchanged_rejection_is_not_reviewed_again(self):
        # #84, exactly: refused at 06:13, nothing pushed, nothing corrected. The
        # 06:40 run reviewed it again and re-posted the same refusal.
        comments = [
            comment("## ACCEPT\n\nAll conditions hold.", "2026-09-05T06:13:05Z"),
            comment("## REQUEST_CHANGES\n\nMerge conflicts.", "2026-09-05T06:13:23Z"),
        ]
        ok, reason = select.eligible(pull(), COMMITTED, comments)
        self.assertFalse(ok)
        self.assertIn("no correction since", reason)

    def test_a_fresh_head_is_eligible(self):
        ok, reason = select.eligible(pull(), COMMITTED, [])
        self.assertTrue(ok)
        self.assertIn("no verdict", reason)

    def test_a_verdict_older_than_the_head_does_not_count(self):
        # The author pushed a fix after the refusal, so the head moved and the old
        # verdict judged a revision that no longer exists.
        stale = [comment("## REQUEST_CHANGES\n\nfix it", "2026-09-05T05:00:00Z")]
        ok, _ = select.eligible(pull(), COMMITTED, stale)
        self.assertTrue(ok)

    def test_a_correction_after_the_verdict_reopens_the_same_head(self):
        comments = [
            comment("## REQUEST_CHANGES\n\nmetadata", "2026-09-05T06:13:23Z"),
            comment("## AUTHOR handoff\n\nCorrected the labels.", "2026-09-05T06:20:00Z"),
        ]
        ok, reason = select.eligible(pull(), COMMITTED, comments)
        self.assertTrue(ok)
        self.assertIn("correction", reason)

    def test_a_second_verdict_after_a_correction_closes_it_again(self):
        comments = [
            comment("## REQUEST_CHANGES\n\nmetadata", "2026-09-05T06:13:23Z"),
            comment("## AUTHOR handoff\n\nCorrected.", "2026-09-05T06:20:00Z"),
            comment("## REQUEST_CHANGES\n\nstill wrong", "2026-09-05T06:40:00Z"),
        ]
        ok, _ = select.eligible(pull(), COMMITTED, comments)
        self.assertFalse(ok)

    def test_a_verdict_naming_the_head_counts_even_if_posted_earlier(self):
        # Clock skew between the commit date and the comment date must not reopen a
        # head that a verdict explicitly named.
        comments = [
            comment(f"**ACCEPT** at revision {HEAD}", "2026-09-05T05:34:00Z"),
        ]
        ok, _ = select.eligible(pull(), COMMITTED, comments)
        self.assertFalse(ok)

    def test_a_human_owned_pull_request_is_left_alone(self):
        ok, reason = select.eligible(
            pull(labels=["status:needs-decision"]), COMMITTED, []
        )
        self.assertFalse(ok)
        self.assertIn("person owns", reason)

    def test_a_conflicting_branch_is_not_handed_to_the_reviewer(self):
        # A control has already established that this cannot be accepted whatever it
        # contains. Selecting it spends a run to restate a check, and the failing
        # check is already item 2 on the AUTHOR's own ladder.
        conflicting = pull(checks=[check("mergeability", "FAILURE")])
        ok, reason = select.eligible(conflicting, COMMITTED, [])
        self.assertFalse(ok)
        self.assertIn("rebase", reason)

    def test_a_pending_mergeability_does_not_block_selection(self):
        # Pending means GitHub has not answered yet and clears within a minute.
        # Refusing on it would let a transient unknown stall the queue.
        waiting = pull(checks=[check("mergeability", None)])
        waiting["statusCheckRollup"][0]["state"] = "PENDING"
        ok, _ = select.eligible(waiting, COMMITTED, [])
        self.assertTrue(ok)

    def test_a_missing_mergeability_check_is_not_a_failure(self):
        # A pull request opened before the check existed must stay reviewable.
        ok, _ = select.eligible(pull(checks=[check("typescript", "SUCCESS")]), COMMITTED, [])
        self.assertTrue(ok)

    def test_other_failing_checks_do_not_block_selection(self):
        # A red test suite is a defect for the reviewer to name, not a reason to
        # withhold the review: the reviewer can judge the criteria as well and return
        # one complete list. Certainty is not the test — every red required check makes
        # the refusal certain — what the review can add is.
        red = pull(checks=[check("typescript", "FAILURE")])
        ok, _ = select.eligible(red, COMMITTED, [])
        self.assertTrue(ok)

    def test_a_head_nothing_has_reported_on_is_not_selected(self):
        # Observed at 08:10: a branch force-pushed minutes earlier had no checks at
        # all, so the mergeability rule found nothing to object to and the head was
        # handed to the model — which spent a run discovering the conflict by hand.
        # Unmeasured is not clean.
        ok, reason = select.eligible(pull(checks=()), COMMITTED, [])
        self.assertFalse(ok)
        self.assertIn("unmeasured is not clean", reason)

    def test_a_head_with_other_checks_but_no_mergeability_is_still_selected(self):
        # The legacy case this must not swallow: a pull request older than the
        # mergeability check has been measured, just not by that check.
        ok, _ = select.eligible(
            pull(checks=[check("typescript", "SUCCESS")]), COMMITTED, []
        )
        self.assertTrue(ok)

    def test_a_draft_is_skipped(self):
        ok, reason = select.eligible(pull(draft=True), COMMITTED, [])
        self.assertFalse(ok)
        self.assertEqual(reason, "draft")


class VerdictDetectionTests(unittest.TestCase):
    def test_the_shapes_the_role_actually_posts_are_recognised(self):
        for body in (
            "## ACCEPT",
            "**ACCEPT** at revision abc1234",
            "## VERDICT: REQUEST_CHANGES",
            "REQUEST_CHANGES\n\nreasons follow",
            "#### Accept",
        ):
            with self.subTest(body=body):
                self.assertTrue(select.is_verdict(body))

    def test_prose_about_a_verdict_is_not_a_verdict(self):
        # A handoff that mentions the refusal it is answering must stay a correction,
        # or the same-head exception can never fire.
        for body in (
            "The previous REQUEST_CHANGES asked for a label fix; done.",
            "I would ACCEPT this once the conflict is resolved.",
            "## AUTHOR handoff\n\nRebased onto master.",
        ):
            with self.subTest(body=body):
                self.assertFalse(select.is_verdict(body))


class ChoiceTests(unittest.TestCase):
    def test_the_oldest_eligible_wins_not_the_oldest(self):
        candidates = [
            (84, "2026-09-05T05:35:16Z", False, "already judged"),
            (85, "2026-09-05T06:00:53Z", True, "no verdict"),
            (88, "2026-09-05T06:37:46Z", True, "no verdict"),
        ]
        self.assertEqual(select.choose(candidates), 85)

    def test_nothing_eligible_selects_nothing_rather_than_the_least_bad(self):
        candidates = [(84, "2026-09-05T05:35:16Z", False, "already judged")]
        self.assertIsNone(select.choose(candidates))




class MachineGeneratedTests(unittest.TestCase):
    """A workflow's own pull request is decided by checks, not by a reviewer."""

    def test_the_mirror_branch_is_never_selected(self):
        ok, reason = select.eligible(pull(head_ref="spec-mirror"), COMMITTED, [])
        self.assertFalse(ok)
        self.assertIn("machine-generated", reason)
        self.assertIn("spec-sync.yml", reason)

    def test_it_is_skipped_even_with_nothing_else_against_it(self):
        # No verdict, no label, green checks — everything that would otherwise make
        # it the obvious target. The class alone decides.
        ok, _ = select.eligible(
            pull(head_ref="spec-mirror", checks=[check("mergeability", "SUCCESS")]),
            COMMITTED,
            [],
        )
        self.assertFalse(ok)

    def test_a_branch_that_merely_resembles_one_is_still_reviewed(self):
        # Exact match only, or an agent could name a branch into the exemption.
        for name in ("spec-mirror-2", "feature/spec-mirror", "claude/spec-mirror"):
            ok, _ = select.eligible(pull(head_ref=name), COMMITTED, [])
            self.assertTrue(ok, name)

    def test_an_ordinary_branch_is_unaffected(self):
        ok, reason = select.eligible(pull(), COMMITTED, [])
        self.assertTrue(ok)
        self.assertIn("no verdict", reason)

    def test_the_oldest_eligible_is_still_chosen_when_a_mirror_is_older(self):
        # The mirror is oldest, so a selector that only sorted would hand it over.
        candidates = [
            (101, "2026-09-05T07:00:00Z", False, "spec-mirror is machine-generated"),
            (105, "2026-09-05T07:40:00Z", True, "no verdict on the current head"),
        ]
        self.assertEqual(select.choose(candidates), 105)


if __name__ == "__main__":
    unittest.main()
