"""Negative controls for the mergeability status.

The interesting case is the third one. A check that quietly reports `success` when it
does not know the answer is worse than no check at all, because it converts an
unmeasured property into a green tick that a reviewer is entitled to trust.

`BehindIsMeasuredNotAskedFor` is the regression bound for Issue #482. For as long as
the `behind` arm keyed off `mergeable_state`, every test here passed and the arm had
never fired against this repository once: the tests asserted what the function did with
the string `"behind"`, and GitHub never sent that string. Those tests are kept, because
the classification they pin is still correct — what is added is the coverage that the
classification is *reachable* from what the API actually returns.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import mergeability  # noqa: E402

UP_TO_DATE = 0


class ClassifyTests(unittest.TestCase):
    def test_a_conflicting_pull_request_fails(self):
        state, description = mergeability.classify(False, "dirty", None, "master")
        self.assertEqual(state, "failure")
        self.assertIn("conflicts", description)
        self.assertIn("rebase", description)

    def test_a_clean_pull_request_passes(self):
        state, _ = mergeability.classify(True, "clean", UP_TO_DATE, "master")
        self.assertEqual(state, "success")

    def test_unknown_is_pending_and_never_success(self):
        state, description = mergeability.classify(None, "unknown", None, "master")
        self.assertEqual(state, "pending")
        self.assertNotEqual(state, "success")
        self.assertIn("not yet computed", description)

    def test_other_blocked_states_are_still_mergeable(self):
        # `blocked` means another gate has not passed — a required check, a review.
        # That is not this check's question, and answering it here would make two
        # different failures indistinguishable on the pull request.
        for api_state in ("blocked", "unstable", "has_hooks"):
            with self.subTest(api_state=api_state):
                state, _ = mergeability.classify(True, api_state, UP_TO_DATE, "master")
                self.assertEqual(state, "success")

    def test_a_branch_behind_its_base_fails(self):
        # It merges cleanly, and its green checks were measured against a base that no
        # longer exists. #88 and #91 were textually independent and semantically not:
        # the merge result did not typecheck.
        state, description = mergeability.classify(True, "behind", 1, "master")
        self.assertEqual(state, "failure")
        self.assertIn("update the branch", description)

    def test_being_behind_is_reported_rather_than_left_to_branch_protection(self):
        # The alternative — GitHub's "require branches to be up to date" — blocks the
        # merge and produces no check. Nothing shows red, so selection keeps offering
        # the pull request and the AUTHOR's "failing required check" rule matches
        # nothing: it belongs to no queue. This assertion is the difference.
        verdict = mergeability.classify(True, "behind", 1, "master")[0]
        self.assertEqual(verdict, "failure")
        self.assertNotEqual(verdict, "success")

    def test_every_description_fits_the_api_limit(self):
        # Including the two descriptions that interpolate a branch name, against a ref
        # far longer than any this repository uses. A truncated sentence reads as a bug
        # in the check, and the clamp in `post_status` is a backstop, not a licence.
        long_ref = "release/" + "x" * 60
        cases = [
            (False, "dirty", None),
            (None, "unknown", None),
            (True, "clean", UP_TO_DATE),
            (True, "clean", 1234),
            (True, "clean", None),
        ]
        for mergeable, api_state, behind in cases:
            with self.subTest(mergeable=mergeable, behind=behind):
                _, description = mergeability.classify(
                    mergeable, api_state, behind, long_ref
                )
                self.assertLessEqual(len(description), mergeability.MAX_DESCRIPTION)

    def test_a_long_base_name_gives_way_before_the_sentence_does(self):
        # Which half of the message survives the limit matters. A clamped sentence
        # reads as a broken check; an abbreviated branch name still reads as a check.
        _, description = mergeability.classify(
            True, "clean", 2, "release/" + "x" * 60
        )
        self.assertLessEqual(len(description), mergeability.MAX_DESCRIPTION)
        self.assertTrue(description.endswith("update the branch"), description)
        self.assertIn("by 2 commits", description)
        self.assertIn("release/", description)


class BehindIsMeasuredNotAskedFor(unittest.TestCase):
    """Issue #482: the four acceptance criteria, as assertions.

    GitHub reports `mergeable_state == "behind"` only when the base branch requires
    branches to be up to date before merging. That setting is off on `master`, so a
    branch two commits behind came back `"clean"` and this check went green on it —
    #479, head `fd61cae`, status re-evaluated at 00:11:46Z after both merges that made
    it stale. The distance is now measured, and `"clean"` no longer means current.
    """

    def test_clean_but_behind_is_a_failure_naming_the_stale_base(self):
        # Criterion 1, and the exact shape of the observed defect: the API says
        # `clean`, the repository says two commits.
        state, description = mergeability.classify(True, "clean", 2, "master")
        self.assertEqual(state, "failure")
        self.assertIn("master", description)
        self.assertIn("2 commits", description)
        self.assertIn("update the branch", description)

    def test_a_branch_containing_the_base_tip_is_still_green(self):
        # Criterion 2. Being up to date is a measured zero, not an absent answer.
        state, description = mergeability.classify(True, "clean", UP_TO_DATE, "master")
        self.assertEqual(state, "success")
        self.assertIn("merges cleanly", description)

    def test_a_conflict_outranks_the_distance(self):
        # Criterion 3. A conflicting branch is also usually behind; saying so would
        # send the author to do a merge that cannot succeed. The conflict description
        # is the one that names the work.
        state, description = mergeability.classify(False, "dirty", 7, "master")
        self.assertEqual(state, "failure")
        self.assertIn("conflicts", description)
        self.assertNotIn("update the branch", description)

    def test_an_uncomputed_mergeability_is_pending_even_when_the_distance_is_known(self):
        # Criterion 4. Knowing the branch is current says nothing about conflicts.
        state, _ = mergeability.classify(None, "unknown", UP_TO_DATE, "master")
        self.assertEqual(state, "pending")

    def test_an_unmeasured_distance_is_pending_and_never_success(self):
        # Criterion 5's other half. The comparison request can fail; when it does, the
        # branch may be current or may be ten commits stale and this run does not know.
        # Reporting the green half of that is how the check lied in the first place.
        state, description = mergeability.classify(True, "clean", None, "master")
        self.assertEqual(state, "pending")
        self.assertNotEqual(state, "success")
        self.assertIn("master", description)

    def test_the_verdict_does_not_depend_on_the_api_volunteering_behind(self):
        # Criterion 5. This is the assertion that fails if anyone reconnects the arm to
        # `mergeable_state`: every state GitHub can report for a mergeable branch, with
        # a positive measured distance, must be red — `"behind"` included but not
        # required. Before this change only the last of these was a failure.
        for api_state in ("clean", "blocked", "unstable", "has_hooks", "behind"):
            with self.subTest(api_state=api_state):
                self.assertEqual(
                    mergeability.classify(True, api_state, 3, "master")[0], "failure"
                )

    def test_classify_refuses_to_answer_without_a_distance(self):
        # Criterion 5, structurally: the argument has no default, so a caller that
        # forgets to measure cannot fall through to `success`.
        with self.assertRaises(TypeError):
            mergeability.classify(True, "clean")


class BehindCountTests(unittest.TestCase):
    """The measurement itself, over the forge's comparison endpoint."""

    def _with_gh(self, fake):
        original = mergeability._gh
        mergeability._gh = fake
        self.addCleanup(lambda: setattr(mergeability, "_gh", original))

    def test_it_asks_the_base_to_head_comparison_and_returns_behind_by(self):
        seen = []

        def fake(args):
            seen.append(args)
            return '{"behind_by": 2, "ahead_by": 1, "status": "diverged"}'

        self._with_gh(fake)
        self.assertEqual(mergeability.behind_count("o/r", "master", "deadbeef"), 2)
        self.assertEqual(seen, [["api", "repos/o/r/compare/master...deadbeef"]])

    def test_a_failed_comparison_is_unknown_rather_than_zero(self):
        def fake(args):
            raise mergeability.subprocess.CalledProcessError(1, "gh")

        self._with_gh(fake)
        self.assertIsNone(mergeability.behind_count("o/r", "master", "deadbeef"))

    def test_a_malformed_comparison_is_unknown_rather_than_zero(self):
        def fake(args):
            return '{"ahead_by": 1}'

        self._with_gh(fake)
        self.assertIsNone(mergeability.behind_count("o/r", "master", "deadbeef"))


class MeasureTests(unittest.TestCase):
    """`measure` is the seam the live script goes through, so it is where the
    reachability actually has to hold: `classify` being correct proved nothing for the
    whole time the caller never handed it a measurement."""

    def _wire(self, pull, comparison=None):
        def refuse(args):
            # `AssertionError` on purpose: `behind_count` catches the four exception
            # types a real failed comparison raises, so anything it catches would be
            # swallowed into `None` and the test would pass without proving anything.
            raise AssertionError(f"no comparison expected, got {args}")

        original_read, original_gh = mergeability.read_pull, mergeability._gh
        mergeability.read_pull = lambda repo, number: pull
        mergeability._gh = (lambda args: comparison) if comparison else refuse
        self.addCleanup(
            lambda: (
                setattr(mergeability, "read_pull", original_read),
                setattr(mergeability, "_gh", original_gh),
            )
        )

    def test_a_clean_but_stale_pull_request_is_measured_red_end_to_end(self):
        # The #479 reproduction through the real call path: nothing in this input
        # contains the word "behind".
        self._wire(("fd61cae", True, "clean", "master"), '{"behind_by": 2}')
        head, state, description = mergeability.measure("o/r", 479, attempts=1, delay=0)
        self.assertEqual(head, "fd61cae")
        self.assertEqual(state, "failure")
        self.assertIn("behind master by 2 commits", description)

    def test_a_current_pull_request_is_still_green_end_to_end(self):
        self._wire(("cafe", True, "clean", "master"), '{"behind_by": 0}')
        _, state, _ = mergeability.measure("o/r", 1, attempts=1, delay=0)
        self.assertEqual(state, "success")

    def test_a_conflict_is_not_compared_at_all(self):
        # No comparison is wired: reaching for one would raise. A branch that cannot
        # merge does not need its distance, and the verdict must not turn on it.
        self._wire(("cafe", False, "dirty", "master"))
        _, state, description = mergeability.measure("o/r", 2, attempts=1, delay=0)
        self.assertEqual(state, "failure")
        self.assertIn("conflicts", description)


class ResolveTests(unittest.TestCase):
    def test_resolve_retries_while_the_answer_is_unknown(self):
        answers = [
            ("sha", None, "unknown", "master"),
            ("sha", None, "unknown", "master"),
            ("sha", True, "clean", "master"),
        ]
        calls = []

        def fake_read(repo, number):
            calls.append(number)
            return answers[len(calls) - 1]

        original = mergeability.read_pull
        mergeability.read_pull = fake_read
        try:
            head, mergeable, state, base = mergeability.resolve(
                "o/r", 7, attempts=5, delay=0
            )
        finally:
            mergeability.read_pull = original

        self.assertEqual(len(calls), 3)
        self.assertEqual((head, mergeable, state, base), ("sha", True, "clean", "master"))

    def test_resolve_gives_up_and_reports_unknown_rather_than_guessing(self):
        def always_unknown(repo, number):
            return ("sha", None, "unknown", "master")

        original = mergeability.read_pull
        mergeability.read_pull = always_unknown
        try:
            _, mergeable, _, base = mergeability.resolve("o/r", 7, attempts=3, delay=0)
        finally:
            mergeability.read_pull = original

        self.assertIsNone(mergeable)
        self.assertEqual(
            mergeability.classify(mergeable, "unknown", None, base)[0], "pending"
        )


class RecheckTests(unittest.TestCase):
    """The second pass exists because this status is now a required check.

    `pending` blocks, which was the right call while the status was advisory. As a
    required check, a `pending` nobody clears is a merge freeze — and the moment it is
    most likely is right after a merge, when GitHub invalidates mergeability for every
    open pull request and recomputes it lazily.
    """

    def test_resolve_is_more_patient_when_asked(self):
        calls = []

        def counting(repo, number):
            calls.append(number)
            return ("sha", None, "unknown", "master")

        original = mergeability.read_pull
        mergeability.read_pull = counting
        try:
            mergeability.resolve("o/r", 7, attempts=3, delay=0)
            first_pass = len(calls)
            mergeability.resolve("o/r", 7, attempts=15, delay=0)
        finally:
            mergeability.read_pull = original

        self.assertEqual(first_pass, 3)
        self.assertEqual(len(calls) - first_pass, 15)

    def test_a_late_answer_is_still_an_answer(self):
        # The case the recheck is for: unknown throughout the first pass, resolved
        # during the second. Without it the pull request keeps a blocking `pending`
        # until something unrelated pushes.
        answers = [("sha", None, "unknown", "master")] * 4 + [
            ("sha", False, "dirty", "master")
        ]
        seen = []

        def late(repo, number):
            seen.append(number)
            return answers[min(len(seen) - 1, len(answers) - 1)]

        original = mergeability.read_pull
        mergeability.read_pull = late
        try:
            _, mergeable, state, base = mergeability.resolve(
                "o/r", 7, attempts=10, delay=0
            )
        finally:
            mergeability.read_pull = original

        self.assertIs(mergeable, False)
        self.assertEqual(mergeability.classify(mergeable, state, None, base)[0], "failure")


if __name__ == "__main__":
    unittest.main()
