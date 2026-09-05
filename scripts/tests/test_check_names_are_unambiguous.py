"""No workflow job may share a name with a commit status the repository writes.

A required check is matched by name. When two different things answer to one name,
the checks rollup shows both and no reader — person or run — can tell which one the
protected branch is satisfied by. On #126 the job reported `pass` beside the status
reporting `pending`: the same word, the same revision, two different claims.

The two are not the same claim and must not look alike. A commit status says whether
the branch merges. The job that writes it succeeding says only that the machinery ran.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
SCRIPTS = ROOT / "scripts"

# `CONTEXT = "..."` at module level: how a script declares the status name it posts.
CONTEXT_ASSIGNMENT = re.compile(r'^CONTEXT\s*=\s*"([^"]+)"', re.MULTILINE)

# `  name: value` two levels in, which is how a job's display name is written here.
JOB_NAME = re.compile(r"^    name:\s*(\S+)\s*$", re.MULTILINE)


def status_contexts():
    """Every commit-status name a script in scripts/ posts."""
    found = {}
    for path in sorted(SCRIPTS.glob("*.py")):
        for context in CONTEXT_ASSIGNMENT.findall(path.read_text(encoding="utf-8")):
            found[context] = path.name
    return found


def job_names():
    """Every workflow job display name, with the file it comes from."""
    found = {}
    for path in sorted(WORKFLOWS.glob("*.yml")):
        for name in JOB_NAME.findall(path.read_text(encoding="utf-8")):
            found.setdefault(name, []).append(path.name)
    return found


class CheckNameTests(unittest.TestCase):
    def test_no_job_shares_a_name_with_a_commit_status(self):
        contexts = status_contexts()
        jobs = job_names()
        collisions = sorted(set(contexts) & set(jobs))
        self.assertEqual(
            collisions,
            [],
            "a job and a commit status answer to the same name, so the rollup shows "
            f"two different claims under one label: {collisions}",
        )

    def test_the_scan_finds_both_kinds_of_name(self):
        # Without this, the assertion above passes whenever a pattern stops matching —
        # the vacuous pass this repository keeps rediscovering. Both sides must be
        # non-empty for the intersection to mean anything.
        self.assertIn("mergeability", status_contexts())
        self.assertGreaterEqual(len(job_names()), 4)

    def test_the_status_name_is_the_one_branch_protection_requires(self):
        # Renaming the context would silently un-require the check: branch protection
        # holds the old name, nothing would ever post it, and the gate would sit
        # pending forever. Changing this string is a repository-settings change too.
        self.assertEqual(status_contexts().get("mergeability"), "mergeability.py")


if __name__ == "__main__":
    unittest.main()
