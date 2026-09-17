"""Negative controls: the sweep touches exactly the branches it may, and no other."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import update_branches as ub  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "mergeability.yml"

REPO = "drevendev/trade_simulation"


def pull(ref="claude/issue-9-example", head_repo=REPO, mergeable=True, state="clean", draft=False, pr_state="open"):
    """A conflict-free loop branch as this repository's API actually reports one.

    `state` defaults to `"clean"`, not `"behind"`: #492 is the observation that GitHub
    never says `"behind"` here, so a suite whose default case says it would test a
    pull request this repository does not produce.
    """
    return {
        "state": pr_state,
        "draft": draft,
        "mergeable": mergeable,
        "mergeable_state": state,
        "head": {"ref": ref, "sha": "abc", "repo": {"full_name": head_repo} if head_repo else None},
        "base": {"ref": "master", "repo": {"full_name": REPO}},
    }


class ShouldUpdateTests(unittest.TestCase):
    def test_a_clean_branch_that_is_measurably_behind_is_updated(self):
        # #492: the case the sweep exists for, and the one it used to refuse. GitHub
        # says "clean" because `master` does not require branches to be up to date;
        # the branch is two commits behind all the same.
        ok, reason = ub.should_update(pull(state="clean"), 2)
        self.assertTrue(ok)
        self.assertIn("2 commits", reason)

    def test_the_decision_is_the_measurement_and_not_the_reported_state(self):
        # Reconnect the decision to `mergeable_state` alone and every case here flips.
        for state in ("clean", "blocked", "unstable", "has_hooks"):
            with self.subTest(state=state):
                self.assertTrue(ub.should_update(pull(state=state), 1)[0])

    def test_a_branch_that_already_contains_its_base_tip_is_not_updated(self):
        for state in ("clean", "blocked", "unstable", "has_hooks"):
            with self.subTest(state=state):
                ok, reason = ub.should_update(pull(state=state), 0)
                self.assertFalse(ok)
                self.assertIn("already contains", reason)

    def test_one_commit_behind_is_not_pluralised(self):
        reason = ub.should_update(pull(), 1)[1]
        self.assertIn("1 commit", reason)
        self.assertNotIn("commits", reason)

    def test_a_conflict_is_left_to_the_author(self):
        ok, reason = ub.should_update(pull(mergeable=False, state="dirty"), 3)
        self.assertFalse(ok)
        self.assertIn("dirty", reason)

    def test_an_uncomputed_answer_is_not_a_reason_to_act(self):
        ok, reason = ub.should_update(pull(mergeable=None, state="unknown"), 4)
        self.assertFalse(ok)
        self.assertIn("not yet computed", reason)

    def test_an_unmeasured_comparison_is_never_a_measured_zero(self):
        ok, reason = ub.should_update(pull(state="clean"), None)
        self.assertFalse(ok)
        self.assertIn("could not measure", reason)

    def test_an_unmeasured_comparison_and_an_uncomputed_mergeability_do_not_share_words(self):
        # Two different failures — the compare endpoint not answering, and GitHub not
        # having decided whether the branch merges. A reader who cannot tell them apart
        # cannot tell which request to retry.
        unmeasured = ub.should_update(pull(), None)[1]
        uncomputed = ub.should_update(pull(mergeable=None), 0)[1]
        self.assertNotEqual(unmeasured, uncomputed)
        self.assertNotIn("not yet computed", unmeasured)
        self.assertNotIn("could not measure", uncomputed)

    def test_the_forge_is_not_overruled_about_its_own_base(self):
        # GitHub volunteering "behind" while the comparison measured no distance: still
        # updated, and described without the zero. Mirrors `mergeability.classify`.
        ok, reason = ub.should_update(pull(state="behind"), 0)
        self.assertTrue(ok)
        self.assertIn("GitHub reports", reason)
        self.assertNotIn("0", reason)

    def test_a_machine_branch_is_never_updated(self):
        # A merge commit committed by the loop identity would fail the committer gate
        # that class is accepted on.
        ok, reason = ub.should_update(pull(ref="spec-mirror"), 5)
        self.assertFalse(ok)
        self.assertIn("machine class", reason)

    def test_an_operator_branch_is_left_alone(self):
        ok, reason = ub.should_update(pull(ref="policy/142-update-behind-branches"), 5)
        self.assertFalse(ok)
        self.assertIn("not a loop branch", reason)

    def test_an_outside_author_s_branch_is_maintained_like_the_loop_s(self):
        # The researcher under scheme/8 has no working tree to merge the base into.
        ok, reason = ub.should_update(pull(ref="zen/req-config-007-population-defaults"), 3)
        self.assertTrue(ok)
        self.assertIn("behind its base by 3 commits", reason)

    def test_an_outside_author_s_draft_is_maintained_and_the_loop_s_is_not(self):
        self.assertTrue(ub.should_update(pull(ref="zen/issue-549-x", draft=True), 3)[0])
        ok, reason = ub.should_update(pull(ref="claude/issue-9-example", draft=True), 3)
        self.assertEqual((ok, reason), (False, "draft"))

    def test_a_prefix_that_only_resembles_the_class_is_not_the_class(self):
        for ref in ("zenith/x", "xzen/x", "zen", "claudette/x"):
            with self.subTest(ref=ref):
                self.assertFalse(ub.should_update(pull(ref=ref), 3)[0])

    def test_a_fork_head_is_not_ours_to_move(self):
        for head_repo in ("someone/trade_simulation", None):
            with self.subTest(head_repo=head_repo):
                ok, reason = ub.should_update(pull(head_repo=head_repo), 5)
                self.assertFalse(ok)
                self.assertIn("not in this repository", reason)

    def test_drafts_and_closed_pull_requests_are_skipped(self):
        self.assertFalse(ub.should_update(pull(draft=True), 5)[0])
        self.assertFalse(ub.should_update(pull(pr_state="closed"), 5)[0])

    def test_the_distance_has_no_default_so_an_unmeasured_caller_raises(self):
        # Not a style point. A default is how this arm went unreachable twice: a caller
        # that never measured would keep getting the old silent `False`.
        with self.assertRaises(TypeError):
            ub.should_update(pull())

    def test_deciding_performs_no_network_call(self):
        calls = []
        original = ub.mergeability.compare_to_base
        ub.mergeability.compare_to_base = lambda *a, **k: calls.append(a)
        try:
            ub.should_update(pull(), 2)
        finally:
            ub.mergeability.compare_to_base = original
        self.assertEqual(calls, [])


class MeasureTests(unittest.TestCase):
    """The impure half: what `main()` asks the forge before it calls `should_update`."""

    def call(self, pull_object, result):
        seen = []
        original = ub.mergeability.compare_to_base
        ub.mergeability.compare_to_base = lambda *args: (seen.append(args), result)[1]
        try:
            return ub.measure(REPO, pull_object), seen
        finally:
            ub.mergeability.compare_to_base = original

    def test_the_head_sha_and_base_ref_come_off_the_pull_request(self):
        comparison, seen = self.call(pull(), ub.mergeability.Comparison(2, "basetip"))
        self.assertEqual(comparison.behind_by, 2)
        self.assertEqual(seen, [(REPO, "master", "abc")])

    def test_a_pull_request_missing_either_end_is_unmeasured_without_a_request(self):
        for broken in ({"head": {}}, {"base": {}}, {}):
            with self.subTest(broken=broken):
                comparison, seen = self.call(broken, ub.mergeability.Comparison(9, "x"))
                self.assertIs(comparison, ub.mergeability.UNMEASURED)
                self.assertEqual(seen, [])


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
        # A pull request event's `github.ref` is `master` too, so the ref alone is no guard.
        self.assertIn("github.event_name != 'pull_request_target'", step)

    def test_the_sweep_acts_as_the_machine_identity_so_the_push_triggers_checks(self):
        text = self.text()
        sweep = text.index("scripts/update_branches.py")
        step = text[text.rfind("- name:", 0, sweep):sweep]
        self.assertIn("GH_TOKEN: ${{ steps.identity.outputs.token }}", step)
        # The identity is minted right before, under the same master-only condition,
        # from the MACHINE app — a role that runs no model.
        mint = text[text.rfind("- name: Act as the MACHINE identity", 0, sweep):sweep]
        self.assertIn("vars.ZENDEV_MACHINE_APP_CLIENT_ID", mint)
        self.assertIn("refs/heads/master", mint)
        self.assertNotIn("ZENDEV_PAT", text)


if __name__ == "__main__":
    unittest.main()
