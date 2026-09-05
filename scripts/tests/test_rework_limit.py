"""The bound fires on the third refusal and on nothing that is not a refusal."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import rework_limit as rl  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "zendev-acceptor.yml"


def comment(body, created, url="https://example/c"):
    return {"body": body, "createdAt": created, "state": None, "url": url}


def review(state, created, body=""):
    return {"body": body, "createdAt": created, "state": state, "url": None}


# The three shapes the ACCEPTOR actually used on #130 in one afternoon.
REFUSALS_ON_130 = [
    comment("## VERDICT: REQUEST_CHANGES\n\n**Reviewed head revision**: 909f03d", "2026-09-05T11:13:00Z"),
    comment("REQUEST_CHANGES at revision 9e14cdb\n\n**Handoff record is incomplete**", "2026-09-05T12:14:00Z"),
    comment("## ACCEPTOR VERDICT: REQUEST_CHANGES\n\n**Head revision**: 0bcc816", "2026-09-05T13:12:00Z"),
]


class RefusalShapeTests(unittest.TestCase):
    def test_every_shape_the_acceptor_used_is_a_refusal(self):
        for entry in REFUSALS_ON_130:
            with self.subTest(body=entry["body"].splitlines()[0]):
                self.assertTrue(rl.is_refusal(entry))

    def test_bold_and_lowercase_markers_count_too(self):
        self.assertTrue(rl.is_refusal(comment("**REQUEST_CHANGES**\n\nfix it", "t")))
        self.assertTrue(rl.is_refusal(comment("## ACCEPTOR verdict: request_changes", "t")))

    def test_a_formal_review_requesting_changes_needs_no_words(self):
        self.assertTrue(rl.is_refusal(review("CHANGES_REQUESTED", "t")))
        self.assertFalse(rl.is_refusal(review("APPROVED", "t")))
        self.assertFalse(rl.is_refusal(review("COMMENTED", "t", "A note that mentions REQUEST_CHANGES mid-sentence.")))

    def test_an_acceptance_is_not_a_refusal(self):
        self.assertFalse(rl.is_refusal(comment("## ACCEPTOR verdict: ACCEPT\n\nAll six hold.", "t")))
        self.assertFalse(rl.is_refusal(comment("## ACCEPT", "t")))

    def test_prose_about_an_earlier_refusal_is_not_one(self):
        self.assertFalse(rl.is_refusal(comment("## AUTHOR correction\n\nThe previous REQUEST_CHANGES asked for a label fix.", "t")))
        self.assertFalse(rl.is_refusal(comment("Addressed REQUEST_CHANGES feedback from ACCEPTOR.", "t")))

    def test_an_operator_qa_marker_is_evidence_not_a_round_of_the_loop(self):
        self.assertFalse(rl.is_refusal(comment("## Operator QA: REQUEST_CHANGES\n\nlooked wrong", "t")))


class DecideTests(unittest.TestCase):
    def test_two_refusals_keep_the_pull_request_open(self):
        reached, refusals = rl.decide(REFUSALS_ON_130[:2])
        self.assertFalse(reached)
        self.assertEqual(len(refusals), 2)

    def test_the_third_refusal_reaches_the_bound(self):
        # #130, exactly.
        reached, refusals = rl.decide(REFUSALS_ON_130)
        self.assertTrue(reached)
        self.assertEqual(len(refusals), 3)

    def test_acceptances_and_handoffs_between_refusals_do_not_count(self):
        timeline = [
            REFUSALS_ON_130[0],
            comment("## AUTHOR handoff\n\nfixed", "2026-09-05T11:35:00Z"),
            REFUSALS_ON_130[1],
            comment("## ACCEPTOR verdict: ACCEPT", "2026-09-05T12:40:00Z"),
        ]
        reached, refusals = rl.decide(timeline)
        self.assertFalse(reached)
        self.assertEqual(len(refusals), 2)

    def test_the_bound_is_configurable(self):
        self.assertTrue(rl.decide(REFUSALS_ON_130[:2], limit=2)[0])
        self.assertFalse(rl.decide(REFUSALS_ON_130, limit=4)[0])


class LinkedIssueTests(unittest.TestCase):
    def test_closes_in_the_body_wins(self):
        self.assertEqual(rl.linked_issue("Closes #121\n\n## Achieved outcome", "claude/issue-999-x"), 121)
        self.assertEqual(rl.linked_issue("fixes #5", ""), 5)
        self.assertEqual(rl.linked_issue("Resolved #77.", ""), 77)

    def test_the_branch_name_is_the_fallback(self):
        self.assertEqual(rl.linked_issue("no reference here", "claude/issue-121-label-cleanup-workflow"), 121)

    def test_nothing_to_read_is_none_not_a_guess(self):
        self.assertIsNone(rl.linked_issue("", "policy/142-update-behind-branches"))
        self.assertIsNone(rl.linked_issue(None, None))


class TimelineTests(unittest.TestCase):
    def test_comments_and_reviews_are_one_ordered_timeline(self):
        pull = {
            "comments": [{"body": "b", "createdAt": "2026-09-05T12:00:00Z", "url": "u"}],
            "reviews": [
                {"body": "", "state": "CHANGES_REQUESTED", "submittedAt": "2026-09-05T11:00:00Z"},
                {"body": "pending", "state": "PENDING"},
            ],
        }
        entries = rl.entries_of(pull)
        self.assertEqual([e["createdAt"] for e in entries], ["2026-09-05T11:00:00Z", "2026-09-05T12:00:00Z"])
        self.assertEqual(entries[0]["state"], "CHANGES_REQUESTED")


class SummaryTests(unittest.TestCase):
    def test_the_summary_names_the_count_the_head_and_the_issue(self):
        pull = {"headRefOid": "0bcc8161e5c66cd9", "url": "https://x/pull/130"}
        text = rl.summary(pull, REFUSALS_ON_130, 3, 121)
        self.assertIn("3 refusals", text)
        self.assertIn("0bcc8161", text)
        self.assertIn("Issue #121 returns to `status:ready`", text)
        self.assertIn("## VERDICT: REQUEST_CHANGES", text)

    def test_without_an_issue_a_person_is_named_instead(self):
        text = rl.summary({"headRefOid": "abc", "url": "u"}, REFUSALS_ON_130, 3, None)
        self.assertIn("a person decides", text)


class WorkflowTests(unittest.TestCase):
    def text(self):
        return WORKFLOW.read_text(encoding="utf-8")

    def test_the_control_plane_is_staged_before_the_model_and_the_bound_runs_from_it(self):
        rows = self.text().splitlines()
        staged = next(i for i, r in enumerate(rows) if 'cp -r scripts "${RUNNER_TEMP}/control-plane"' in r)
        model = next(i for i, r in enumerate(rows) if "uses: anthropics/claude-code-action" in r)
        bound = next(i for i, r in enumerate(rows) if '"${RUNNER_TEMP}/control-plane/rework_limit.py"' in r)
        self.assertLess(staged, model)
        self.assertGreater(bound, model)

    def test_the_bound_runs_only_when_a_pull_request_was_reviewed(self):
        text = self.text()
        bound = text.index("control-plane/rework_limit.py")
        step = text[text.rfind("- name:", 0, bound):bound]
        self.assertIn("always() && steps.select.outputs.target != 'none'", step)

    def test_the_bound_never_runs_from_the_working_tree(self):
        self.assertNotIn("python scripts/rework_limit.py", self.text())


if __name__ == "__main__":
    unittest.main()
