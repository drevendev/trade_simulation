"""Both guards must read the paths git actually changed, not git's display form.

This builds a real repository, because that is where the defect lived: `check()` and
`classify()` were tested with hand-written path lists and were never wrong, while
`changed_paths()` — the thing that produced those lists in production — had never been
run against a repository at all.

The name that matters is the one from #109: `06 - Handoff/99 — PROJECT_MANIFEST.md`.
Its em dash makes `git diff --name-only` C-quote the whole path, and the guard then
refused a file for being outside a directory it was inside.
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import machine_pr_guard as guard  # noqa: E402
import policy_guard  # noqa: E402

MIRROR = "docs/spec/mirror"
EM_DASH_PATH = MIRROR + "/06 - Handoff/99 — PROJECT_MANIFEST.md"
SPACED_PATH = MIRROR + "/06 - Handoff/README notes.md"
ASCII_PATH = MIRROR + "/SPEC_CHANGELOG.md"


def git(cwd, *args):
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


class RepositoryFixture:
    """A repository with one commit on master and one on a branch off it."""

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        git(root, "init", "-b", "master")
        git(root, "config", "user.email", "test@example.invalid")
        git(root, "config", "user.name", "Test")
        git(root, "config", "core.quotepath", "true")  # git's default; be explicit

        (root / "README.md").write_text("base\n", encoding="utf-8")
        git(root, "add", "-A")
        git(root, "commit", "-m", "base")

        for relative in (EM_DASH_PATH, SPACED_PATH, ASCII_PATH):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("content\n", encoding="utf-8")
        git(root, "add", "-A")
        git(root, "commit", "-m", "mirror sync")

        self.root = root
        self.previous = os.getcwd()
        os.chdir(root)
        return self

    def __exit__(self, *exc):
        os.chdir(self.previous)
        self.tmp.cleanup()
        return False


class ChangedPathsTests(unittest.TestCase):
    def test_machine_guard_reads_a_non_ascii_path_unquoted(self):
        with RepositoryFixture():
            paths = guard.changed_paths("master~1")
        self.assertIn(EM_DASH_PATH, paths)
        self.assertFalse(
            [p for p in paths if p.startswith('"')],
            "git's C-quoted display form reached the guard",
        )

    def test_a_path_with_a_space_survives_the_split(self):
        with RepositoryFixture():
            paths = guard.changed_paths("master~1")
        self.assertIn(SPACED_PATH, paths)
        self.assertNotIn("", paths)
        self.assertEqual(len(paths), 3)

    def test_the_mirror_is_accepted_end_to_end(self):
        # #109 exactly: three mirrored files, one of them em-dashed, refused for being
        # outside the directory it is inside.
        with RepositoryFixture():
            paths = guard.changed_paths("master~1")
            allowlist = "+ /SPEC_CHANGELOG.md*\n+ /06 - Handoff/**\n- *\n"
            violations = guard.check(
                "spec-mirror", paths, allowlist, "github-actions[bot]"
            )
        self.assertEqual(violations, [])

    def test_policy_guard_reads_the_same_path_unquoted(self):
        with RepositoryFixture():
            paths, _ = policy_guard.collect("master~1")
        self.assertIn(EM_DASH_PATH, paths)
        self.assertFalse([p for p in paths if p.startswith('"')])

    def test_policy_guard_still_classifies_a_non_ascii_policy_path(self):
        # The quiet half: a quoted path matches no prefix, so a mix would pass. This
        # proves the classification actually reaches a policy path with an em dash.
        self.assertTrue(policy_guard.is_policy("scripts/tools/héritage.py"))
        policy, product = policy_guard.classify(
            ["scripts/tools/héritage.py", "src/domain/id.ts"]
        )
        self.assertEqual(policy, ["scripts/tools/héritage.py"])
        self.assertEqual(product, ["src/domain/id.ts"])


if __name__ == "__main__":
    unittest.main()
