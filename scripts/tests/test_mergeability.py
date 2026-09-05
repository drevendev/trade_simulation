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
        for api_state in ("blocked", "unstable", "behind", "has_hooks"):
            with self.subTest(api_state=api_state):
                state, _ = mergeability.classify(True, api_state)
                self.assertEqual(state, "success")

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


if __name__ == "__main__":
    unittest.main()
