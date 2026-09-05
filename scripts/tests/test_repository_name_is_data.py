"""The repository's name is read from the run, never compared to a literal.

Renaming a repository is an owner's decision that must not need a policy change to
survive — the policy change would need the loop's own review path, and the loop would be
stopped. On 2026-09-05 a rename in case only stopped it for as long as the spelling
differed (#171). These assertions keep the name out of every place where a literal would
be load-bearing: workflow conditions and the control-plane scripts. The one permitted
literal is the watchdog's developer default for local runs, and it is named here so that
a second one cannot appear unnoticed.

Text assertions rather than a YAML parse, like the other workflow tests: this runs in
the policy-guard job with nothing but the standard library.
"""

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
SCRIPTS = ROOT / "scripts"

LITERAL = "drevendev/trade_simulation"


class WorkflowTests(unittest.TestCase):
    def test_no_workflow_compares_the_repository_to_a_literal(self):
        for path in sorted(WORKFLOWS.glob("*.yml")):
            text = path.read_text(encoding="utf-8")
            with self.subTest(workflow=path.name):
                self.assertNotIn("github.repository ==", text)
                self.assertNotIn(LITERAL, text)

    def test_the_role_prompts_name_the_repository_from_the_context(self):
        for name in ("zendev-author.yml", "zendev-acceptor.yml"):
            with self.subTest(workflow=name):
                self.assertIn("${{ github.repository }}", (WORKFLOWS / name).read_text(encoding="utf-8"))

    def test_the_watchdog_still_requires_master_and_the_switch(self):
        text = (WORKFLOWS / "zendev-watchdog.yml").read_text(encoding="utf-8")
        self.assertIn("github.ref == 'refs/heads/master'", text)
        self.assertIn("vars.ZENDEV_ENABLED == 'true'", text)


class ScriptTests(unittest.TestCase):
    def test_only_the_watchdog_default_carries_the_name(self):
        for path in sorted(SCRIPTS.glob("*.py")):
            text = path.read_text(encoding="utf-8")
            with self.subTest(script=path.name):
                if path.name == "schedule_watchdog.py":
                    self.assertEqual(text.count(LITERAL), 1, "one developer default, no more")
                    self.assertIn(f'DEFAULT_REPOSITORY = "{LITERAL}"', text)
                else:
                    self.assertNotIn(LITERAL, text)

    def test_the_scan_sees_the_scripts_and_the_workflows(self):
        # Without this the assertions above pass on empty directories.
        self.assertGreaterEqual(len(list(SCRIPTS.glob("*.py"))), 10)
        self.assertGreaterEqual(len(list(WORKFLOWS.glob("*.yml"))), 6)


if __name__ == "__main__":
    unittest.main()
