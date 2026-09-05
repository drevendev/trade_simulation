"""Tests for status:* label cleanup on closed Issues.

Negative controls:
1. Only status:* labels are removed; other labels are preserved
2. Multiple status:* labels can be present and all are removed
3. An Issue with no status:* labels is not modified
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import cleanup_closed_issues  # noqa: E402


class FilterStatusLabelsTests(unittest.TestCase):
    """Test the label filtering logic."""

    def test_filter_removes_only_status_labels(self):
        """status:* labels are removed, others are kept."""
        labels = [
            {"name": "status:in-progress"},
            {"name": "priority:normal"},
            {"name": "type:process"},
            {"name": "status:ready"},
            {"name": "area:tooling"},
        ]
        kept = cleanup_closed_issues.filter_status_labels(labels)
        self.assertEqual(
            set(kept),
            {"priority:normal", "type:process", "area:tooling"},
        )

    def test_filter_preserves_labels_that_start_with_other_prefixes(self):
        """Labels with different prefixes are preserved."""
        labels = [
            {"name": "status:ready"},
            {"name": "status-marker"},  # different prefix pattern
            {"name": "stat:something"},  # similar but not status:
        ]
        kept = cleanup_closed_issues.filter_status_labels(labels)
        self.assertEqual(
            set(kept),
            {"status-marker", "stat:something"},
        )

    def test_filter_handles_empty_label_list(self):
        """Empty label list returns empty result."""
        kept = cleanup_closed_issues.filter_status_labels([])
        self.assertEqual(kept, [])

    def test_filter_handles_all_status_labels(self):
        """When all labels are status:*, result is empty."""
        labels = [
            {"name": "status:in-progress"},
            {"name": "status:ready"},
            {"name": "status:blocked"},
        ]
        kept = cleanup_closed_issues.filter_status_labels(labels)
        self.assertEqual(kept, [])

    def test_filter_handles_no_status_labels(self):
        """When no labels are status:*, all are kept."""
        labels = [
            {"name": "priority:normal"},
            {"name": "type:feature"},
            {"name": "area:core"},
        ]
        kept = cleanup_closed_issues.filter_status_labels(labels)
        self.assertEqual(
            set(kept),
            {"priority:normal", "type:feature", "area:core"},
        )


class GetStatusLabelsTests(unittest.TestCase):
    """Test extracting status:* labels."""

    def test_get_extracts_only_status_labels(self):
        """get_status_labels returns only status:* labeled items."""
        labels = [
            {"name": "status:in-progress"},
            {"name": "priority:normal"},
            {"name": "status:blocked"},
            {"name": "type:process"},
        ]
        status_labels = cleanup_closed_issues.get_status_labels(labels)
        self.assertEqual(
            set(status_labels),
            {"status:in-progress", "status:blocked"},
        )

    def test_get_returns_empty_when_no_status_labels(self):
        """Returns empty list when no status:* labels present."""
        labels = [
            {"name": "priority:normal"},
            {"name": "type:feature"},
        ]
        status_labels = cleanup_closed_issues.get_status_labels(labels)
        self.assertEqual(status_labels, [])

    def test_get_returns_empty_for_empty_list(self):
        """Empty label list returns empty result."""
        status_labels = cleanup_closed_issues.get_status_labels([])
        self.assertEqual(status_labels, [])


class RemoveStatusLabelsTests(unittest.TestCase):
    """Test the main label removal function."""

    def test_issue_with_status_labels_reports_removal(self):
        """An Issue with status:* labels reports what would be removed."""
        labels = [
            {"name": "status:in-progress"},
            {"name": "priority:normal"},
            {"name": "status:blocked"},
        ]
        success, message = cleanup_closed_issues.remove_status_labels_from_issue(
            issue_number=121,
            issue_labels=labels,
            repo="owner/repo",
        )
        self.assertTrue(success)
        self.assertIn("121", message)
        self.assertIn("status:in-progress", message)
        self.assertIn("status:blocked", message)
        self.assertNotIn("priority:normal", message)

    def test_issue_with_no_status_labels_reports_none_found(self):
        """An Issue without status:* labels reports no action needed."""
        labels = [
            {"name": "priority:normal"},
            {"name": "type:feature"},
        ]
        success, message = cleanup_closed_issues.remove_status_labels_from_issue(
            issue_number=100,
            issue_labels=labels,
            repo="owner/repo",
        )
        self.assertTrue(success)
        self.assertIn("100", message)
        self.assertIn("no status:* labels", message)

    def test_issue_with_empty_labels(self):
        """An Issue with no labels reports no action needed."""
        success, message = cleanup_closed_issues.remove_status_labels_from_issue(
            issue_number=50,
            issue_labels=[],
            repo="owner/repo",
        )
        self.assertTrue(success)
        self.assertIn("50", message)
        self.assertIn("no status:* labels", message)

    def test_multiple_status_labels_are_reported(self):
        """When multiple status:* labels are present, all are reported."""
        labels = [
            {"name": "status:in-progress"},
            {"name": "status:ready"},
            {"name": "status:blocked"},
            {"name": "priority:high"},
        ]
        success, message = cleanup_closed_issues.remove_status_labels_from_issue(
            issue_number=42,
            issue_labels=labels,
            repo="owner/repo",
        )
        self.assertTrue(success)
        self.assertIn("42", message)
        self.assertIn("3", message)  # count
        self.assertIn("would remove", message)


if __name__ == "__main__":
    unittest.main()
