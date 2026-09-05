"""Tests for status:* label cleanup on closed Issues.

Negative controls:
1. Only status:* labels are removed; other labels are preserved
2. Multiple status:* labels can be present and all are removed
3. An Issue with no status:* labels is not modified
"""

import pathlib
import sys
import unittest
from unittest.mock import MagicMock, patch

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

    @patch("cleanup_closed_issues.urllib.request.urlopen")
    def test_issue_with_status_labels_removes_all(self, mock_urlopen):
        """An Issue with status:* labels removes them all via API."""
        mock_response = MagicMock()
        mock_response.read.return_value = b""
        mock_response.__enter__.return_value = mock_response
        mock_response.__exit__.return_value = None
        mock_urlopen.return_value = mock_response

        labels = [
            {"name": "status:in-progress"},
            {"name": "priority:normal"},
            {"name": "status:blocked"},
        ]
        success, message = cleanup_closed_issues.remove_status_labels_from_issue(
            issue_number=121,
            issue_labels=labels,
            repo="owner/repo",
            github_token="test-token",
        )
        self.assertTrue(success)
        self.assertIn("121", message)
        self.assertIn("removed", message)
        self.assertIn("2", message)  # two status labels
        self.assertNotIn("priority:normal", message)
        # Verify API was called twice (once per status label)
        self.assertEqual(mock_urlopen.call_count, 2)

    def test_issue_with_status_labels_without_token_fails(self):
        """An Issue with status:* labels fails if no token is provided."""
        labels = [
            {"name": "status:in-progress"},
            {"name": "status:blocked"},
        ]
        success, message = cleanup_closed_issues.remove_status_labels_from_issue(
            issue_number=121,
            issue_labels=labels,
            repo="owner/repo",
            github_token=None,
        )
        self.assertFalse(success)
        self.assertIn("121", message)
        self.assertIn("no GitHub token", message)

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
            github_token="test-token",
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
            github_token="test-token",
        )
        self.assertTrue(success)
        self.assertIn("50", message)
        self.assertIn("no status:* labels", message)

    @patch("cleanup_closed_issues.urllib.request.urlopen")
    def test_multiple_status_labels_are_removed(self, mock_urlopen):
        """When multiple status:* labels are present, all are removed via API."""
        mock_response = MagicMock()
        mock_response.read.return_value = b""
        mock_response.__enter__.return_value = mock_response
        mock_response.__exit__.return_value = None
        mock_urlopen.return_value = mock_response

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
            github_token="test-token",
        )
        self.assertTrue(success)
        self.assertIn("42", message)
        self.assertIn("3", message)  # count of status labels
        self.assertIn("removed", message)
        # Verify API was called once per status label
        self.assertEqual(mock_urlopen.call_count, 3)

    @patch("cleanup_closed_issues.urllib.request.urlopen")
    def test_api_failure_is_reported(self, mock_urlopen):
        """API failures are properly reported."""
        import urllib.error

        mock_urlopen.side_effect = urllib.error.HTTPError(
            "url", 404, "Not Found", {}, None
        )

        labels = [
            {"name": "status:ready"},
        ]
        success, message = cleanup_closed_issues.remove_status_labels_from_issue(
            issue_number=99,
            issue_labels=labels,
            repo="owner/repo",
            github_token="test-token",
        )
        self.assertFalse(success)
        self.assertIn("99", message)
        self.assertIn("Failed", message)


if __name__ == "__main__":
    unittest.main()
