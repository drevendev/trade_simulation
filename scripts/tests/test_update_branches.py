"""Negative controls: the sweep touches exactly the branches it may, and no other."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import update_branches as ub  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "mergeability.yml"

REPO = "drevendev/trade_simulation"


def pull(ref="claude/issue-9-example", head_repo=REPO, mergeable=True, state="behind", draft=False, pr_state="open"):
    return {
        "state": pr_state,
        "draft": draft,
        "mergeable": mergeable,
        "mergeable_state": state,
        "head": {"ref": ref, "sha": "abc", "repo": {"full_name": head_repo} if head_repo else None},
        "base": {"ref": "master", "repo": {"full_name": REPO}},
    }


class ShouldUpdateTests(unittest.TestCase):
    def test_a_loop_branch_that_is_behind_is_updated(self):
        ok, reason = ub.should_update(pull())
        self.assertTrue(ok)
        self.assertEqual(reason, "behind")

    def test_a_conflict_is_left_to_the_author(self):
        ok, reason = ub.should_update(pull(mergeable=False, state="dirty"))
        self.assertFalse(ok)
        self.assertIn("dirty", reason)

    def test_a_clean_or_blocked_branch_is_not_touched(self):
        for state in ("clean", "blocked", "unstable", "has_hooks"):
            with self.subTest(state=state):
                self.assertFalse(ub.should_update(pull(state=state))[0])

    def test_an_uncomputed_answer_is_not_a_reason_to_act(self):
        ok, reason = ub.should_update(pull(mergeable=None, state="unknown"))
        self.assertFalse(ok)
        self.assertIn("not yet computed", reason)

    def test_a_machine_branch_is_never_updated(self):
        # A merge commit committed by the loop identity would fail the committer gate
        # that class is accepted on.
        ok, reason = ub.should_update(pull(ref="spec-mirror"))
        self.assertFalse(ok)
        self.assertIn("machine class", reason)

    def test_an_operator_branch_is_left_alone(self):
        ok, reason = ub.should_update(pull(ref="policy/142-update-behind-branches"))
        self.assertFalse(ok)
        self.assertIn("not a loop branch", reason)

    def test_a_fork_head_is_not_ours_to_move(self):
        for head_repo in ("someone/trade_simulation", None):
            with self.subTest(head_repo=head_repo):
                ok, reason = ub.should_update(pull(head_repo=head_repo))
                self.assertFalse(ok)
                self.assertIn("not in this repository", reason)

    def test_drafts_and_closed_pull_requests_are_skipped(self):
        self.assertFalse(ub.should_update(pull(draft=True))[0])
        self.assertFalse(ub.should_update(pull(pr_state="closed"))[0])


class FailureDetailTests(unittest.TestCase):
    def test_the_http_status_line_is_kept_and_nothing_else(self):
        stderr = "gh: Validation Failed (HTTP 422)\nHTTP 422: Validation Failed (https://api.github.com/...)\n{\"message\": \"...\"}"
        detail = ub.failure_detail(stderr, 1)
        self.assertTrue(detail.startswith("gh: ") or detail.startswith("HTTP "))
        self.assertNotIn("message", detail)

    def test_no_recognisable_line_falls_back_to_the_exit_code(self):
        self.assertEqual(ub.failure_detail("", 7), "gh exit 7")


class WorkflowTests(unittest.TestCase):
    def text(self):
        return WORKFLOW.read_text(encoding="utf-8")

    def test_the_sweep_runs_after_the_fan_out_and_from_master_only(self):
        text = self.text()
        sweep = text.index("scripts/update_branches.py")
        fan_out = text.index("scripts/mergeability.py --repo")
        self.assertGreater(sweep, fan_out, "statuses must be written before branches are updated")
        step = text[text.rfind("- name:", 0, sweep):sweep]
        self.assertIn("refs/heads/master", step)
        self.assertIn("github.event_name != 'pull_request'", step)

    def test_the_sweep_uses_the_loop_token_so_the_push_triggers_checks(self):
        sweep = self.text().index("scripts/update_branches.py")
        step = self.text()[self.text().rfind("- name:", 0, sweep):sweep]
        self.assertIn("secrets.ZENDEV_PAT", step)


if __name__ == "__main__":
    unittest.main()
