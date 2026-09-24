"""The mergeability workflow's self-test proves the classifier, never the state of `master`.

#679. `write-mergeability-status` runs a self-test before it writes the required
`mergeability` status, so that a broken classifier cannot judge anyone. That step used
to discover the whole `scripts/tests` suite, which also holds tests of *live* state: the
ledger on the checkout and `master`'s history. The workflow checks out `master` on every
event (`test_mergeability_trust.py`), so those tests measured `master` — and when
`master` carried a merged row with a blank commit past the backfill's grace window
(#678), the self-test failed on every pull request, the status was never written, and
the one pull request able to repair `master` could not merge for want of it. A test
about `master`'s state, run from `master`, withholds the gate from its own repair.

The self-test now names the modules it proves: the classifier, the two repair scripts
this workflow runs, and the trust boundary that keeps all of them `master`'s. Nothing
that reads live forge state. The live-ledger regression still runs in `policy-guard`,
on the pull request's merge ref, where the repair passes and everything else is honestly
red — that step is where a claim about the ledger belongs.

The assertions here keep the list honest in both directions: the step may not fall back
to `discover`, may not name a module that reads live state, may not name a module that
does not exist, and must name `test_<script>` for every `scripts/<script>.py` the
workflow executes, so a new script cannot be added to the workflow without its proof.

Text assertions rather than a YAML parse, like the other workflow tests: this runs in
the policy-guard job with nothing but the standard library. The synthetic cases below
prove each check fires on the text that would violate it.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "mergeability.yml"
TESTS = ROOT / "scripts" / "tests"

SELF_TEST = "Prove the classifier fires"
TRUST_BOUNDARY = "test_mergeability_trust"

# Modules that read the state of the checkout or of the forge rather than a fixture.
# Naming one here is the defect of #678 in a different spelling.
LIVE_STATE = ("test_backfill_merge_commits",)


def text():
    return WORKFLOW.read_text(encoding="utf-8")


def steps(body):
    """Each step's text, split on the list markers at step indentation. Pure."""
    starts = [m.start() for m in re.finditer(r"^      - (?:name|uses|id):", body, re.MULTILINE)]
    starts.append(len(body))
    return [body[a:b] for a, b in zip(starts, starts[1:])]


def self_test(body):
    """The self-test step's text, or None when no step carries its name. Pure."""
    for step in steps(body):
        if SELF_TEST in step:
            return step
    return None


def scripts_run(body):
    """Every `scripts/<name>.py` the workflow executes. Pure."""
    return sorted(set(re.findall(r"python scripts/(\w+)\.py", body)))


def modules_named(step):
    """The test modules the self-test step names. Pure."""
    return sorted(set(re.findall(r"\btest_\w+", step)))


def violations(body, existing=None):
    """Every way `body` lets the self-test measure something other than the scripts. Pure.

    `existing` is the set of module names that exist under scripts/tests; it defaults
    to the checkout's, and the synthetic cases pass their own. A list of sentences
    rather than a boolean, so a failure names the edit that caused it.
    """
    if existing is None:
        existing = {path.stem for path in TESTS.glob("test_*.py")}
    step = self_test(body)
    if step is None:
        return [f"no step named `{SELF_TEST}`; the scan is not seeing the workflow"]

    found = []
    if re.search(r"\bdiscover\b", step):
        found.append("the self-test discovers the whole suite; a test of `master`'s live "
                     "state would then withhold the status from the pull request that "
                     "repairs that state (#678)")
    named = modules_named(step)
    if TRUST_BOUNDARY not in named:
        found.append(f"the self-test does not prove the trust boundary `{TRUST_BOUNDARY}`")
    for script in scripts_run(body):
        if f"test_{script}" not in named:
            found.append(f"`scripts/{script}.py` runs in this workflow but `test_{script}` "
                         f"is not part of the self-test")
    for module in named:
        if module in LIVE_STATE:
            found.append(f"the self-test names `{module}`, which reads live state")
        elif module not in existing:
            found.append(f"the self-test names `{module}`, which does not exist")
    return found


class SelfTestHoldsTests(unittest.TestCase):
    def test_the_shipped_workflow_has_no_violation(self):
        self.assertEqual(violations(text()), [])

    def test_the_scan_sees_what_it_guards(self):
        # Without this, every assertion passes on a file the patterns stopped matching.
        body = text()
        self.assertIsNotNone(self_test(body))
        self.assertEqual(
            scripts_run(body), ["mergeability", "resolve_ledger_conflicts", "update_branches"]
        )
        self.assertGreaterEqual(len(modules_named(self_test(body))), 4)

    def test_every_named_module_is_a_file_that_exists(self):
        for module in modules_named(self_test(text())):
            with self.subTest(module=module):
                self.assertTrue((TESTS / f"{module}.py").is_file())


class SelfTestErodesTests(unittest.TestCase):
    """Each edit below is small, plausible, and reintroduces #678. Each is refused."""

    def setUp(self):
        self.body = text()
        self.step = self_test(self.body)
        self.assertEqual(violations(self.body), [], "the fixture must start clean")

    def edited(self, old, new):
        replaced = self.body.replace(old, new)
        self.assertNotEqual(replaced, self.body, "the fixture edit must apply")
        return replaced

    def assert_refused(self, body, fragment, existing=None):
        found = violations(body, existing)
        self.assertTrue(any(fragment in v for v in found), f"expected {fragment!r} in {found}")

    def test_discovering_the_whole_suite_is_refused(self):
        module_line = next(line for line in self.step.splitlines() if "test_mergeability" in line)
        edited = self.edited(module_line, "          python -m unittest discover -s scripts/tests -v")
        self.assert_refused(edited, "discovers the whole suite")

    def test_dropping_the_proof_of_a_script_the_workflow_runs_is_refused(self):
        edited = self.edited("test_update_branches", "")
        self.assert_refused(edited, "`scripts/update_branches.py` runs in this workflow")

    def test_dropping_the_trust_boundary_is_refused(self):
        edited = self.edited(TRUST_BOUNDARY, "")
        self.assert_refused(edited, "does not prove the trust boundary")

    def test_naming_a_module_that_reads_live_state_is_refused(self):
        edited = self.edited(TRUST_BOUNDARY, f"{TRUST_BOUNDARY} test_backfill_merge_commits")
        self.assert_refused(edited, "reads live state")

    def test_naming_a_module_that_does_not_exist_is_refused(self):
        edited = self.edited(TRUST_BOUNDARY, f"{TRUST_BOUNDARY} test_no_such_module")
        self.assert_refused(edited, "does not exist")

    def test_a_new_script_in_the_workflow_needs_its_proof(self):
        # The step keeps up with the workflow: a script added without a test is refused.
        edited = self.edited(
            'python scripts/mergeability.py --repo "${{ github.repository }}" --all-open',
            'python scripts/mergeability.py --repo "${{ github.repository }}" --all-open\n'
            "          python scripts/new_repair.py",
        )
        self.assert_refused(edited, "`scripts/new_repair.py` runs in this workflow")

    def test_a_missing_self_test_step_is_named_not_passed(self):
        edited = self.edited(SELF_TEST, "Run the tests")
        self.assertEqual(len(violations(edited)), 1)
        self.assert_refused(edited, "the scan is not seeing the workflow")


if __name__ == "__main__":
    unittest.main()
