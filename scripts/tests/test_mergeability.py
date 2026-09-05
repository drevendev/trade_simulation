"""Negative controls for the mergeability status.

The interesting case is the third one. A check that quietly reports `success` when it
does not know the answer is worse than no check at all, because it converts an
unmeasured property into a green tick that a reviewer is entitled to trust.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import mergeability  # noqa: E402


class ClassifyTests(unittest.TestCase):
    def test_a_conflicting_pull_request_fails(self):
        state, description = mergeability.classify(False, "dirty")
        self.assertEqual(state, "failure")
        self.assertIn("conflicts", description)
        self.assertIn("rebase", description)

    def test_a_clean_pull_request_passes(self):
        state, _ = mergeability.classify(True, "clean")
        self.assertEqual(state, "success")

    def test_unknown_is_pending_and_never_success(self):
        state, description = mergeability.classify(None, "unknown")
        self.assertEqual(state, "pending")
        self.assertNotEqual(state, "success")
        self.assertIn("not yet computed", description)

    def test_other_blocked_states_are_still_mergeable(self):
        # `blocked` means another gate has not passed — a required check, a review.
        # That is not this check's question, and answering it here would make two
        # different failures indistinguishable on the pull request.
        for api_state in ("blocked", "unstable", "has_hooks"):
            with self.subTest(api_state=api_state):
                state, _ = mergeability.classify(True, api_state)
                self.assertEqual(state, "success")

    def test_a_branch_behind_its_base_fails(self):
        # It merges cleanly, and its green checks were measured against a base that no
        # longer exists. #88 and #91 were textually independent and semantically not:
        # the merge result did not typecheck.
        state, description = mergeability.classify(True, "behind")
        self.assertEqual(state, "failure")
        self.assertIn("update the branch", description)

    def test_being_behind_is_reported_rather_than_left_to_branch_protection(self):
        # The alternative — GitHub's "require branches to be up to date" — blocks the
        # merge and produces no check. Nothing shows red, so selection keeps offering
        # the pull request and the AUTHOR's "failing required check" rule matches
        # nothing: it belongs to no queue. This assertion is the difference.
        self.assertEqual(mergeability.classify(True, "behind")[0], "failure")
        self.assertNotEqual(mergeability.classify(True, "behind")[0], "success")

    def test_every_description_fits_the_api_limit(self):
        for mergeable in (True, False, None):
            with self.subTest(mergeable=mergeable):
                _, description = mergeability.classify(mergeable, "some_longer_state")
                self.assertLessEqual(len(description), mergeability.MAX_DESCRIPTION)


class ResolveTests(unittest.TestCase):
    def test_resolve_retries_while_the_answer_is_unknown(self):
        answers = [("sha", None, "unknown"), ("sha", None, "unknown"), ("sha", True, "clean")]
        calls = []

        def fake_read(repo, number):
            calls.append(number)
            return answers[len(calls) - 1]

        original = mergeability.read_pull
        mergeability.read_pull = fake_read
        try:
            head, mergeable, state = mergeability.resolve("o/r", 7, attempts=5, delay=0)
        finally:
            mergeability.read_pull = original

        self.assertEqual(len(calls), 3)
        self.assertEqual((head, mergeable, state), ("sha", True, "clean"))

    def test_resolve_gives_up_and_reports_unknown_rather_than_guessing(self):
        def always_unknown(repo, number):
            return ("sha", None, "unknown")

        original = mergeability.read_pull
        mergeability.read_pull = always_unknown
        try:
            _, mergeable, _ = mergeability.resolve("o/r", 7, attempts=3, delay=0)
        finally:
            mergeability.read_pull = original

        self.assertIsNone(mergeable)
        self.assertEqual(mergeability.classify(mergeable, "unknown")[0], "pending")


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
            return ("sha", None, "unknown")

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
        answers = [("sha", None, "unknown")] * 4 + [("sha", False, "dirty")]
        seen = []

        def late(repo, number):
            seen.append(number)
            return answers[min(len(seen) - 1, len(answers) - 1)]

        original = mergeability.read_pull
        mergeability.read_pull = late
        try:
            _, mergeable, state = mergeability.resolve("o/r", 7, attempts=10, delay=0)
        finally:
            mergeability.read_pull = original

        self.assertIs(mergeable, False)
        self.assertEqual(mergeability.classify(mergeable, state)[0], "failure")


if __name__ == "__main__":
    unittest.main()
