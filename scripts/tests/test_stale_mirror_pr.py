"""The producer closes only what is red, concluded and old — and nothing else."""

import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import stale_mirror_pr as stale  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "spec-sync.yml"

NOW = dt.datetime(2026, 9, 5, 12, 0, tzinfo=dt.timezone.utc)


def check(name, conclusion=None, state=None):
    entry = {"name": name}
    if conclusion is not None:
        entry["conclusion"] = conclusion
    if state is not None:
        entry["context"] = name
        entry["state"] = state
    return entry


def proposal(*checks):
    return {"number": 112, "headRefOid": "abc", "statusCheckRollup": list(checks)}


class DecideTests(unittest.TestCase):
    def test_red_and_old_is_closed(self):
        pull = proposal(check("policy-guard", "FAILURE"), check("typescript", "SUCCESS"))
        close, reason = stale.decide(pull, NOW - dt.timedelta(hours=2), NOW)
        self.assertTrue(close)
        self.assertIn("policy-guard", reason)
        self.assertNotIn("typescript", reason)

    def test_red_but_young_is_left_to_settle(self):
        pull = proposal(check("policy-guard", "FAILURE"))
        close, reason = stale.decide(pull, NOW - dt.timedelta(minutes=10), NOW)
        self.assertFalse(close)
        self.assertIn("10 min old", reason)

    def test_the_bound_is_inclusive_of_exactly_the_bound(self):
        pull = proposal(check("policy-guard", "FAILURE"))
        self.assertTrue(stale.decide(pull, NOW - stale.MIN_AGE, NOW)[0])

    def test_green_or_pending_is_never_closed_however_old(self):
        for entry in (
            check("policy-guard", "SUCCESS"),
            check("mergeability", state="PENDING"),
            check("build-and-test", None),
            check("ci", "CANCELLED"),
            check("ci", "ACTION_REQUIRED"),
        ):
            with self.subTest(entry=entry):
                close, _ = stale.decide(proposal(entry), NOW - dt.timedelta(days=3), NOW)
                self.assertFalse(close)

    def test_a_red_commit_status_counts_like_a_red_check_run(self):
        pull = proposal(check("mergeability", state="FAILURE"))
        self.assertTrue(stale.decide(pull, NOW - dt.timedelta(hours=2), NOW)[0])

    def test_no_open_proposal_is_nothing_to_do(self):
        close, reason = stale.decide(None, None, NOW)
        self.assertFalse(close)
        self.assertEqual(reason, "no open proposal")

    def test_a_shorter_bound_can_be_passed(self):
        pull = proposal(check("policy-guard", "FAILURE"))
        close, _ = stale.decide(pull, NOW - dt.timedelta(minutes=10), NOW, dt.timedelta(minutes=5))
        self.assertTrue(close)


class ClassTests(unittest.TestCase):
    def test_the_branch_comes_from_the_machine_class_definition(self):
        self.assertEqual(stale.default_branch(), "spec-mirror")

    def test_the_closing_comment_points_at_the_recovery_document(self):
        text = stale.closing_comment("red for 120 min: policy-guard")
        self.assertIn("MACHINE_PULL_REQUESTS.md", text)
        self.assertIn("red for 120 min", text)


class WorkflowTests(unittest.TestCase):
    def test_the_producer_closes_before_it_proposes(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        closing = text.index("scripts/stale_mirror_pr.py")
        proposing = text.index("peter-evans/create-pull-request")
        self.assertLess(closing, proposing)

    def test_closing_uses_the_same_token_as_proposing(self):
        # Both act as the MACHINE identity: the token minted once at the top of the job.
        text = WORKFLOW.read_text(encoding="utf-8")
        closing = text.index("scripts/stale_mirror_pr.py")
        step = text[text.rfind("- name:", 0, closing):closing]
        self.assertIn("GH_TOKEN: ${{ steps.identity.outputs.token }}", step)
        proposing = text.index("peter-evans/create-pull-request")
        proposal = text[proposing:text.index("add-paths:", proposing)]
        self.assertIn("token: ${{ steps.identity.outputs.token }}", proposal)


if __name__ == "__main__":
    unittest.main()
