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



ACCEPTOR = "zendev-acceptor"


def review(state, created, author, body=""):
    return {"body": body, "createdAt": created, "state": state,
            "kind": "review", "author": author}


def entry(body, created, state=None, author=None):
    e = {"body": body, "createdAt": created, "state": state}
    if author is not None:
        e["author"] = author
    return e


def authored(login="app/zendev-author", **kw):
    p = pull(**kw)
    p["author"] = {"login": login}
    return p


class TwoReviewerTests(unittest.TestCase):
    """The loop's own identity and another account both post on the same head."""

    def test_the_runbooks_prescribed_heading_is_a_verdict(self):
        # #152 exactly: the role wrote the heading the runbook prescribes, the selector
        # did not read it as a verdict, and the next run reviewed the head again.
        for body in (
            "## ACCEPTOR Verdict: ACCEPT",
            "## ACCEPTOR verdict: REQUEST_CHANGES",
            "## ACCEPTOR VERDICT: REQUEST_CHANGES\n\n**Head revision**: 0bcc816",
            "## ACCEPTOR Verdict: ACCEPT \u2713",
            "**ACCEPTOR verdict: ACCEPT** at revision abc1234",
        ):
            with self.subTest(body=body):
                self.assertTrue(select.is_verdict(body))

    def test_a_role_heading_without_a_verdict_word_is_not_one(self):
        for body in (
            "## ACCEPTOR Run Assessment \u2014 BLOCKED",
            "## Merged by ACCEPTOR",
            "## ACCEPTOR claim\n\nreviewing #84",
        ):
            with self.subTest(body=body):
                self.assertFalse(select.is_verdict(body))

    def test_a_formal_review_state_is_a_verdict_whatever_its_words(self):
        prose = "CODE_RUNTIME_QA_M1_18 \u2014 one new schema/conformance blocker."
        self.assertTrue(select.is_verdict_entry(entry(prose, "t", state="CHANGES_REQUESTED")))
        self.assertTrue(select.is_verdict_entry(entry(prose, "t", state="APPROVED")))
        self.assertFalse(select.is_verdict_entry(entry(prose, "t", state="COMMENTED")))
        self.assertFalse(select.is_verdict_entry(entry(prose, "t")))

    def test_another_accounts_refusing_review_judges_the_head_without_an_acceptor(self):
        # With no ACCEPTOR named the wider reading stands: any verdict-shaped entry
        # judges the head. This is what the loop did before verdict ownership, and it
        # is the safe direction for a caller that has not been taught the identity.
        comments = [
            entry("CODE_RUNTIME_QA_M1_18: one new blocker.", "2026-09-06T05:57:55Z",
                  state="CHANGES_REQUESTED", author="drevendev"),
        ]
        ok, reason = select.eligible(authored(), COMMITTED, comments)
        self.assertFalse(ok)
        self.assertIn("no correction since", reason)

    def test_a_qa_note_from_another_account_is_not_a_correction(self):
        # #190 exactly: accepted at 04:33, a QA reviewer commented at 05:01, the 05:30
        # run reopened the head as "corrected" and refused it: the third refusal.
        comments = [
            entry("## ACCEPT\n\nAll conditions hold.", "2026-09-06T04:33:23Z",
                  author="zendev-acceptor"),
            entry("R103 follow-up on the evidence-state repair: one contradiction remains.",
                  "2026-09-06T05:01:48Z", state="COMMENTED", author="drevendev"),
        ]
        ok, reason = select.eligible(authored(), COMMITTED, comments)
        self.assertFalse(ok)
        self.assertIn("no correction since", reason)

    def test_the_authors_own_handoff_is_still_a_correction(self):
        comments = [
            entry("## REQUEST_CHANGES\n\nmetadata", "2026-09-06T04:33:23Z",
                  author="zendev-acceptor"),
            entry("## AUTHOR handoff\n\nCorrected the body.", "2026-09-06T05:01:48Z",
                  author="zendev-author"),
        ]
        ok, reason = select.eligible(authored(), COMMITTED, comments)
        self.assertTrue(ok)
        self.assertIn("correction", reason)

    def test_the_apps_two_spellings_are_one_identity(self):
        # `gh` prints the author as `app/zendev-author` on the pull request and as
        # `zendev-author` on its comments; the web shows `zendev-author[bot]`.
        for spelling in ("zendev-author", "app/zendev-author", "zendev-author[bot]"):
            self.assertEqual(select.normalize_login(spelling), "zendev-author")

    def test_a_record_without_identities_keeps_the_wider_reading(self):
        # No author on the pull request, none on the comments: the older behaviour.
        comments = [
            comment("## REQUEST_CHANGES\n\nmetadata", "2026-09-05T06:13:23Z"),
            comment("## AUTHOR handoff\n\nCorrected.", "2026-09-05T06:20:00Z"),
        ]
        ok, _ = select.eligible(pull(), COMMITTED, comments)
        self.assertTrue(ok)

    def test_the_selector_and_the_bound_read_one_refusal_shape(self):
        # Two regular expressions, one meaning: a refusal the bound counts must be a
        # verdict the selector sees, or the same head is reviewed again after it.
        import rework_limit as rl
        for body in (
            "## ACCEPTOR Verdict: REQUEST_CHANGES",
            "## VERDICT: REQUEST_CHANGES",
            "**REQUEST_CHANGES**\n\nfix it",
            "REQUEST_CHANGES at revision 9e14cdb",
        ):
            with self.subTest(body=body):
                self.assertTrue(select.is_verdict(body))
                self.assertTrue(rl.is_refusal({"body": body, "state": None}))


class VerdictOwnershipTests(unittest.TestCase):
    """Only the ACCEPTOR's verdict is a verdict. Each test is a pull request that died.

    Reviews from `drevendev` are the researcher's. They may still hold the merge —
    branch protection decides that — but they must not decide whether the loop looks
    at the pull request again.
    """

    def test_238_another_accounts_approval_no_longer_judges_the_head(self):
        # #238: CLEAN, an APPROVED from drevendev the only verdict on the head, never
        # re-selected and so never merged. Eleven hours idle.
        comments = [
            review("APPROVED", "2026-09-07T05:56:17Z", "drevendev"),
        ]
        ok, reason = select.eligible(authored(), COMMITTED, comments, ACCEPTOR)
        self.assertTrue(ok, reason)
        self.assertIn("no verdict", reason)

    def test_223_another_accounts_approval_does_not_settle_a_refused_head(self):
        # #223: the ACCEPTOR refused, then an APPROVED from drevendev arrived newer.
        # The head then moved, which is what makes it reviewable again — the foreign
        # approval must neither settle it nor stand in for the ACCEPTOR's own.
        comments = [
            review("CHANGES_REQUESTED", "2026-09-06T22:34:12Z", ACCEPTOR),
            review("APPROVED", "2026-09-07T01:01:03Z", "drevendev"),
        ]
        moved = "2026-09-07T01:30:00Z"
        ok, reason = select.eligible(authored(), moved, comments, ACCEPTOR)
        self.assertTrue(ok, reason)

    def test_208_the_roles_own_verdict_still_judges_the_head(self):
        # The other half of the same rule. #208 carries the ACCEPTOR's own ACCEPT, so
        # it stays out of the queue: re-reviewing a head this role already judged is
        # #152, and verdict ownership must not reopen it.
        comments = [
            review("CHANGES_REQUESTED", "2026-09-06T17:59:18Z", "drevendev"),
            entry("## ACCEPTOR Verdict: ACCEPT", "2026-09-07T01:05:00Z", author=ACCEPTOR),
        ]
        ok, reason = select.eligible(authored(), COMMITTED, comments, ACCEPTOR)
        self.assertFalse(ok)
        self.assertIn("already judged", reason)

    def test_a_foreign_verdict_shaped_comment_is_not_a_verdict_either(self):
        # Not only formal reviews: the QA voice writes comments, and one that happens
        # to open with the runbook's word must not take the head out of the queue.
        comments = [
            entry("## REQUEST_CHANGES\n\nthis looks wrong", "2026-09-07T05:00:00Z",
                  author="AndyDev"),
        ]
        ok, reason = select.eligible(authored(), COMMITTED, comments, ACCEPTOR)
        self.assertTrue(ok, reason)

    def test_an_entry_without_an_author_stays_a_verdict(self):
        # Silence about identity is not evidence of a foreign one. Dropping the verdict
        # would re-review a judged head, which costs a run and leaves two verdicts on
        # one revision (#152) — the failure this module exists to prevent.
        comments = [comment("## ACCEPT\n\nAll conditions hold.", "2026-09-05T06:13:05Z")]
        ok, reason = select.eligible(pull(), COMMITTED, comments, ACCEPTOR)
        self.assertFalse(ok)
        self.assertIn("already judged", reason)

    def test_the_two_spellings_of_the_acceptor_are_one_identity(self):
        # The workflow passes the app slug; `gh` prints comments as `name[bot]`.
        comments = [
            entry("## ACCEPT", "2026-09-07T01:05:00Z", author="zendev-acceptor[bot]"),
        ]
        ok, _ = select.eligible(authored(), COMMITTED, comments, "zendev-acceptor")
        self.assertFalse(ok)


class StandingBlockerTests(unittest.TestCase):
    """Naming the gate this role does not own (#211)."""

    def test_a_foreign_refusal_still_standing_is_named(self):
        comments = [review("CHANGES_REQUESTED", "2026-09-06T17:59:18Z", "drevendev")]
        self.assertEqual(select.standing_blockers(comments, ACCEPTOR), ["drevendev"])

    def test_the_acceptors_own_refusal_is_not_a_foreign_blocker(self):
        comments = [review("CHANGES_REQUESTED", "2026-09-06T17:59:18Z", ACCEPTOR)]
        self.assertEqual(select.standing_blockers(comments, ACCEPTOR), [])

    def test_only_the_latest_review_per_account_counts(self):
        # GitHub blocks on the latest review per reviewer; an approval after a refusal
        # clears it, and reading the refusal alone would report a gate that is open.
        comments = [
            review("CHANGES_REQUESTED", "2026-09-06T17:59:18Z", "drevendev"),
            review("APPROVED", "2026-09-07T01:01:03Z", "drevendev"),
        ]
        self.assertEqual(select.standing_blockers(comments, ACCEPTOR), [])

    def test_a_comment_never_blocks_a_merge(self):
        comments = [
            entry("## REQUEST_CHANGES\n\nno", "2026-09-07T01:00:00Z", author="AndyDev"),
        ]
        self.assertEqual(select.standing_blockers(comments, ACCEPTOR), [])


if __name__ == "__main__":
    unittest.main()
