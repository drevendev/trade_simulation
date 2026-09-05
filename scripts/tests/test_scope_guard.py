"""Negative controls for the handoff guard: prove it refuses, not merely that it runs."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import scope_guard as guard  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"

BODY = """Closes #140

## Changed artifacts

- `scripts/scope_guard.py` — the guard
- scripts/tests/test_scope_guard.py — its negative controls
"""


class CheckTests(unittest.TestCase):
    def test_an_undeclared_path_is_a_violation_naming_the_path(self):
        # #130, exactly: files changed that the handoff never mentioned.
        violations = guard.check(
            ["scripts/scope_guard.py", "scripts/mergeability.py"], BODY, "claude/issue-140-x"
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("scripts/mergeability.py", violations[0])
        self.assertNotIn("scripts/scope_guard.py\n", violations[0])

    def test_a_declared_path_passes_with_or_without_backticks(self):
        paths = ["scripts/scope_guard.py", "scripts/tests/test_scope_guard.py"]
        self.assertEqual(guard.check(paths, BODY, "claude/issue-140-x"), [])

    def test_an_empty_body_with_changes_is_refused(self):
        violations = guard.check(["src/index.ts"], "", "claude/issue-1-x")
        self.assertEqual(len(violations), 1)
        self.assertIn("empty", violations[0])
        self.assertEqual(guard.check(["src/index.ts"], None, "claude/issue-1-x")[0], violations[0])

    def test_an_empty_diff_has_nothing_to_declare(self):
        self.assertEqual(guard.check([], "", "claude/issue-1-x"), [])

    def test_a_machine_class_branch_is_exempt_without_reading_the_body(self):
        # A mirror snapshot has no author and no handoff; its own guard decides its paths.
        self.assertEqual(
            guard.check(["docs/spec/mirror/SPEC_INDEX.md"], "", "spec-mirror"), []
        )

    def test_matching_is_literal(self):
        # A path spelled differently from git is not declared: the guard must not guess.
        violations = guard.check(["docs/zendev/AUTHOR_RUNBOOK.md"], "docs\\zendev\\AUTHOR_RUNBOOK.md", "claude/x")
        self.assertEqual(len(violations), 1)


class WorkflowTests(unittest.TestCase):
    def text(self):
        return CI.read_text(encoding="utf-8")

    def test_the_guard_runs_inside_policy_guard_on_pull_requests(self):
        text = self.text()
        self.assertIn("scripts/scope_guard.py", text)
        # Inside the policy-guard job, after its declaration and before the next job or EOF.
        job = text.index("policy-guard:")
        self.assertGreater(text.index("scripts/scope_guard.py"), job)

    def test_a_corrected_body_re_runs_the_check(self):
        # `edited` in the pull_request event types: without it a fixed handoff could
        # only be re-measured by pushing an empty commit.
        self.assertIn("edited", self.text())
        self.assertRegex(self.text(), r"types:\s*\[[^\]]*edited[^\]]*\]")

    def test_the_body_arrives_through_the_environment_not_an_expression(self):
        # Attacker-controllable text on a public repository must never be interpolated
        # into a shell line.
        text = self.text()
        self.assertIn("PR_BODY: ${{ github.event.pull_request.body }}", text)
        self.assertNotIn('"${{ github.event.pull_request.body }}"', text)


if __name__ == "__main__":
    unittest.main()
