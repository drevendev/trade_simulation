"""Test detection of contradictory verdicts and shared verdict definitions."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import verdict  # noqa: E402
import select_review_target as select  # noqa: E402
import detect_contradictory_verdicts as detector  # noqa: E402

HEAD = "d8e28d3e2df15c93c1df3e41eceb640996024907"
COMMITTED = "2026-09-05T05:35:00Z"


def comment(body, created, author="testuser"):
    return {
        "body": body,
        "createdAt": created,
        "author": {"login": author},
        "url": f"https://github.com/test/repo/issues/1#issuecomment-123",
    }


def review(body, created, author="testuser"):
    return {
        "body": body,
        "submittedAt": created,
        "author": {"login": author},
        "url": f"https://github.com/test/repo/pull/1#pullrequestreview-123",
    }


class SharedVerdictDefinitionTests(unittest.TestCase):
    """Ensure verdict detection is identical across modules."""

    def test_verdict_module_is_used_by_select_review_target(self):
        # select.is_verdict should delegate to verdict.is_verdict
        test_cases = [
            "## ACCEPT",
            "REQUEST_CHANGES\n\nreasons",
            "The previous REQUEST_CHANGES was wrong.",
            "I would ACCEPT if...",
        ]
        for body in test_cases:
            with self.subTest(body=body):
                self.assertEqual(select.is_verdict(body), verdict.is_verdict(body))

    def test_verdict_extraction_matches_detection(self):
        # If is_verdict says it's a verdict, extract_verdict_text should return something
        test_cases = [
            ("## ACCEPT", "ACCEPT"),
            ("REQUEST_CHANGES\n\nreasons", "REQUEST_CHANGES"),
            ("**ACCEPT** at revision abc", "ACCEPT"),
            ("#### VERDICT: REQUEST_CHANGES", "REQUEST_CHANGES"),
            ("The previous REQUEST_CHANGES was wrong.", ""),
            ("I would ACCEPT if...", ""),
        ]
        for body, expected in test_cases:
            with self.subTest(body=body):
                is_v = verdict.is_verdict(body)
                extracted = verdict.extract_verdict_text(body)
                if is_v:
                    self.assertEqual(extracted, expected)
                else:
                    self.assertEqual(extracted, "")

    def test_verdict_detection_consistency_across_modules(self):
        # Both modules should agree on what is and isn't a verdict
        test_cases = [
            "## ACCEPT\n\nAll checks pass.",
            "**REQUEST_CHANGES**",
            "#### Accept",
            "REQUEST_CHANGES",
            "The previous REQUEST_CHANGES mentioned...",
            "I would ACCEPT this if it also...",
            "## AUTHOR handoff\n\nFixed the issue.",
        ]
        for body in test_cases:
            with self.subTest(body=body):
                self.assertEqual(
                    select.is_verdict(body),
                    verdict.is_verdict(body),
                    f"Verdict detection mismatch for: {body}",
                )
                self.assertEqual(
                    detector.judges_head(
                        {"body": body, "createdAt": "2026-09-05T05:36:00Z"},
                        HEAD,
                        COMMITTED,
                    ),
                    verdict.is_verdict(body),
                    f"judges_head mismatch for: {body}",
                )


class ContradictoryVerdictDetectionTests(unittest.TestCase):
    """Test detection of contradictory verdicts on the same head."""

    def test_no_verdicts_returns_false(self):
        verdicts = []
        self.assertFalse(detector.has_contradictory_verdicts(verdicts))

    def test_single_verdict_returns_false(self):
        verdicts = [
            {
                "body": "## ACCEPT",
                "createdAt": "2026-09-05T06:00:00Z",
                "type": "comment",
            }
        ]
        self.assertFalse(detector.has_contradictory_verdicts(verdicts))

    def test_two_accept_verdicts_returns_false(self):
        verdicts = [
            {
                "body": "## ACCEPT",
                "createdAt": "2026-09-05T06:00:00Z",
                "type": "comment",
            },
            {
                "body": "## ACCEPT\n\nConfirmed.",
                "createdAt": "2026-09-05T06:00:30Z",
                "type": "comment",
            },
        ]
        self.assertFalse(detector.has_contradictory_verdicts(verdicts))

    def test_two_request_changes_verdicts_returns_false(self):
        verdicts = [
            {
                "body": "## REQUEST_CHANGES",
                "createdAt": "2026-09-05T06:00:00Z",
                "type": "comment",
            },
            {
                "body": "REQUEST_CHANGES\n\nMore fixes needed.",
                "createdAt": "2026-09-05T06:00:30Z",
                "type": "comment",
            },
        ]
        self.assertFalse(detector.has_contradictory_verdicts(verdicts))

    def test_accept_and_request_changes_returns_true(self):
        # This is the problematic case from #84
        verdicts = [
            {
                "body": "## ACCEPT\n\nAll conditions hold.",
                "createdAt": "2026-09-05T06:13:05Z",
                "type": "comment",
            },
            {
                "body": "## REQUEST_CHANGES\n\nMerge conflicts.",
                "createdAt": "2026-09-05T06:13:23Z",
                "type": "comment",
            },
        ]
        self.assertTrue(detector.has_contradictory_verdicts(verdicts))

    def test_request_changes_and_accept_returns_true(self):
        # Order shouldn't matter
        verdicts = [
            {
                "body": "REQUEST_CHANGES",
                "createdAt": "2026-09-05T06:13:00Z",
                "type": "comment",
            },
            {
                "body": "## ACCEPT",
                "createdAt": "2026-09-05T06:13:30Z",
                "type": "comment",
            },
        ]
        self.assertTrue(detector.has_contradictory_verdicts(verdicts))

    def test_comment_and_review_contradiction_detected(self):
        # Verdicts can come from both comments and reviews
        verdicts = [
            {
                "body": "## ACCEPT",
                "createdAt": "2026-09-05T06:13:05Z",
                "type": "comment",
            },
            {
                "body": "REQUEST_CHANGES\n\nFails the spec.",
                "createdAt": "2026-09-05T06:13:20Z",
                "type": "review",
            },
        ]
        self.assertTrue(detector.has_contradictory_verdicts(verdicts))

    def test_three_verdicts_mixed_types_detected(self):
        # Even with three verdicts, if there's a contradiction it's detected
        verdicts = [
            {
                "body": "## ACCEPT",
                "createdAt": "2026-09-05T06:13:00Z",
                "type": "comment",
            },
            {
                "body": "## ACCEPT",
                "createdAt": "2026-09-05T06:13:10Z",
                "type": "comment",
            },
            {
                "body": "REQUEST_CHANGES",
                "createdAt": "2026-09-05T06:13:20Z",
                "type": "review",
            },
        ]
        self.assertTrue(detector.has_contradictory_verdicts(verdicts))


class JudgesHeadTests(unittest.TestCase):
    """Test whether a comment is a verdict on the current head."""

    def test_non_verdict_returns_false(self):
        c = {"body": "The previous REQUEST_CHANGES was wrong.", "createdAt": "2026-09-05T06:00:00Z"}
        self.assertFalse(detector.judges_head(c, HEAD, COMMITTED))

    def test_verdict_posted_after_head_returns_true(self):
        c = {"body": "## ACCEPT", "createdAt": "2026-09-05T05:36:00Z"}
        self.assertTrue(detector.judges_head(c, HEAD, COMMITTED))

    def test_verdict_naming_head_returns_true_even_if_earlier(self):
        c = {
            "body": f"**ACCEPT** at revision {HEAD}",
            "createdAt": "2026-09-05T05:34:00Z",
        }
        self.assertTrue(detector.judges_head(c, HEAD, COMMITTED))

    def test_verdict_older_than_head_returns_false(self):
        c = {"body": "## REQUEST_CHANGES", "createdAt": "2026-09-05T05:00:00Z"}
        self.assertFalse(detector.judges_head(c, HEAD, COMMITTED))


if __name__ == "__main__":
    unittest.main()
