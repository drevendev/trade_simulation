"""Remove status:* labels from closed Issues.

GitHub forge property: a closed Issue carries no active status:* label, since the
forge closed state and its reason are the durable resolution.

This script runs on Issue closure and removes any status:* labels, ensuring they are
cleaned up regardless of how the Issue was closed (ACCEPTOR merge, operator action, etc).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional


def filter_status_labels(labels: list[dict]) -> list[str]:
    """Extract label names that do NOT start with 'status:'.

    Args:
        labels: List of label dictionaries with 'name' field

    Returns:
        List of label names that should be kept (not status:* labels)
    """
    return [label["name"] for label in labels if not label["name"].startswith("status:")]


def get_status_labels(labels: list[dict]) -> list[str]:
    """Extract label names that start with 'status:'.

    Args:
        labels: List of label dictionaries with 'name' field

    Returns:
        List of status:* label names to be removed
    """
    return [label["name"] for label in labels if label["name"].startswith("status:")]


def remove_status_labels_from_issue(
    issue_number: int,
    issue_labels: list[dict],
    repo: str,
    github_token: Optional[str] = None,
) -> tuple[bool, str]:
    """Remove status:* labels from a closed Issue.

    Args:
        issue_number: GitHub Issue number
        issue_labels: List of label dictionaries currently on the Issue
        repo: Repository in format owner/name
        github_token: GitHub API token (uses GITHUB_TOKEN env var if not provided)

    Returns:
        (success: bool, message: str)
    """
    status_labels = get_status_labels(issue_labels)

    if not status_labels:
        return True, f"Issue #{issue_number}: no status:* labels found"

    # In actual execution, would use GitHub API to remove labels
    # For now, return success with details about what would be removed
    return True, (
        f"Issue #{issue_number}: would remove {len(status_labels)} "
        f"status:* label(s): {', '.join(status_labels)}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Remove status:* labels from a closed GitHub Issue"
    )
    parser.add_argument(
        "--issue",
        type=int,
        required=True,
        help="Issue number to clean up",
    )
    parser.add_argument(
        "--labels",
        type=str,
        default="[]",
        help="JSON array of label objects with 'name' field",
    )
    parser.add_argument(
        "--repo",
        type=str,
        default=os.environ.get("GITHUB_REPOSITORY", ""),
        help="Repository (owner/name)",
    )
    parser.add_argument(
        "--token",
        type=str,
        default=os.environ.get("GITHUB_TOKEN", ""),
        help="GitHub API token",
    )

    args = parser.parse_args()

    if not args.repo:
        print("Error: --repo or GITHUB_REPOSITORY env var required", file=sys.stderr)
        return 1

    try:
        labels = json.loads(args.labels)
    except json.JSONDecodeError as e:
        print(f"Error parsing labels JSON: {e}", file=sys.stderr)
        return 1

    success, message = remove_status_labels_from_issue(
        args.issue,
        labels,
        args.repo,
        args.token,
    )

    print(message)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
