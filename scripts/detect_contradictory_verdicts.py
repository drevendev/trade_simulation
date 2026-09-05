"""Detect multiple verdicts on the same PR head and report them.

When an ACCEPTOR or reviewer posts two verdicts (ACCEPT or REQUEST_CHANGES) at
the same head revision, this reports exactly one correction naming both verdicts
and the head revision.

This prevents the AUTHOR from seeing contradictory verdicts as input and making
a selection that depends on comment ordering.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

import verdict


def judges_head(comment, head_sha: str, head_committed_at: str) -> bool:
    """Whether this comment is a verdict on the current head revision."""
    if not verdict.is_verdict(comment["body"]):
        return False
    if head_sha[:7] and head_sha[:7] in (comment["body"] or ""):
        return True
    return comment["createdAt"] >= head_committed_at


def _gh(args):
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True
    ).stdout


def load_pr_info(repo: str, number: int) -> dict:
    """Load PR metadata, comments, and reviews."""
    raw = _gh(
        [
            "pr",
            "view",
            str(number),
            "--repo",
            repo,
            "--json",
            "headRefOid,comments,reviews",
        ]
    )
    return json.loads(raw)


def head_commit_date(repo: str, sha: str) -> str:
    """Get the commit date of a specific SHA."""
    raw = _gh(["api", f"repos/{repo}/commits/{sha}"])
    return json.loads(raw)["commit"]["committer"]["date"]


def find_verdicts(comments, head_sha: str, head_committed_at: str) -> list[dict]:
    """Find all verdicts at the current head.

    Returns a list of verdict dicts with:
    - body: the comment/review body
    - createdAt: when it was posted
    - type: 'comment' or 'review'
    - url: permalink to the comment/review (if available)
    """
    verdicts = []

    # Process comments
    for c in comments.get("comments", []):
        if judges_head(c, head_sha, head_committed_at):
            verdicts.append(
                {
                    "body": c.get("body", ""),
                    "createdAt": c.get("createdAt", ""),
                    "type": "comment",
                    "url": c.get("url", ""),
                    "author": c.get("author", {}).get("login", ""),
                }
            )

    # Process formal reviews
    for r in comments.get("reviews", []):
        if r.get("submittedAt"):
            if judges_head(r, head_sha, head_committed_at):
                verdicts.append(
                    {
                        "body": r.get("body", ""),
                        "createdAt": r.get("submittedAt", ""),
                        "type": "review",
                        "url": r.get("url", ""),
                        "author": r.get("author", {}).get("login", ""),
                    }
                )

    return verdicts


def has_contradictory_verdicts(verdicts: list[dict]) -> bool:
    """Check if there are two different verdicts at the same head."""
    if len(verdicts) < 2:
        return False

    # Extract verdict types
    verdict_types = set()
    for v in verdicts:
        verdict_text = verdict.extract_verdict_text(v["body"])
        if verdict_text:
            verdict_types.add(verdict_text)

    # Contradictory if both ACCEPT and REQUEST_CHANGES are present
    return len(verdict_types) > 1


def format_verdict_link(v: dict) -> str:
    """Format a verdict as a link to the comment/review."""
    if v.get("url"):
        return f"[{v['type'].title()}]({v['url']})"
    return f"{v['type'].title()}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--pr", required=True, help="pull request number")
    args = parser.parse_args()

    # Load PR info
    pr_data = load_pr_info(args.repo, args.pr)
    head_sha = pr_data.get("headRefOid", "")
    if not head_sha:
        print("error: no head revision found", file=sys.stderr)
        return 1

    # Get head commit date
    head_committed_at = head_commit_date(args.repo, head_sha)

    # Find all verdicts at the current head
    verdicts = find_verdicts(pr_data, head_sha, head_committed_at)

    # Check for contradictory verdicts
    if not has_contradictory_verdicts(verdicts):
        # No contradiction, output empty result
        print("contradictory_verdicts=")
        return 0

    # Format the contradictory verdicts report
    verdict_links = ", ".join(format_verdict_link(v) for v in verdicts)
    short_sha = head_sha[:8]

    # Output the contradiction info for the workflow to use
    report = f"Contradictory verdicts at {short_sha}: {verdict_links}"
    print(f"contradictory_verdicts={report}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
