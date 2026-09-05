"""The bookkeeper must not be executed from the working tree the model left behind.

A run's later steps execute whatever `scripts/` the working directory holds when they
start, and the model changes that directory during the run — the ACCEPTOR runbook
tells it to check out a pull request's head so it can verify independently. One ledger
record came back missing its `model` field for exactly this reason: the reviewed
branch predated the field, and its copy of the recorder ran.

The recording step carries the ledger credential, so this is also the shape of a
credential-handling defect: a pull request that edited the recorder would have had its
version executed by the reviewing workflow with that token in the environment.

These are text assertions rather than a YAML parse, deliberately — the check must run
in the policy-guard job with nothing installed but the standard library.
"""

import pathlib
import unittest

WORKFLOWS = pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows"
MODEL_RUNNERS = ("zendev-author.yml", "zendev-acceptor.yml")

STAGE_LINE = 'cp scripts/record_usage.py "${RUNNER_TEMP}/record_usage.py"'
STAGED_CALL = 'python "${RUNNER_TEMP}/record_usage.py"'
WORKING_TREE_CALL = "python scripts/record_usage.py"
MODEL_STEP = "uses: anthropics/claude-code-action"


def lines(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8").splitlines()


def index_of(rows, needle, name):
    for i, row in enumerate(rows):
        if needle in row:
            return i
    raise AssertionError(f"{name}: {needle!r} not found")


class BookkeeperIsolationTests(unittest.TestCase):
    def test_the_recorder_is_staged_before_the_model_runs(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                rows = lines(name)
                staged = index_of(rows, STAGE_LINE, name)
                model = index_of(rows, MODEL_STEP, name)
                self.assertLess(
                    staged,
                    model,
                    f"{name}: staging after the model copies the tree the model left",
                )

    def test_the_recording_step_runs_the_staged_copy(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                rows = lines(name)
                index_of(rows, STAGED_CALL, name)

    def test_no_workflow_runs_the_recorder_from_the_working_tree(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                offenders = [r for r in lines(name) if WORKING_TREE_CALL in r]
                self.assertEqual(
                    offenders,
                    [],
                    f"{name}: recorder invoked from the working tree: {offenders}",
                )

    def test_the_fixtures_still_match_the_files(self):
        # Guards the test itself: if a workflow is renamed or the recorder invocation
        # is rewritten, these assertions must fail loudly rather than pass vacuously
        # by finding nothing to check.
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                self.assertTrue((WORKFLOWS / name).is_file(), f"{name} is missing")
                self.assertIn(MODEL_STEP, "\n".join(lines(name)))


if __name__ == "__main__":
    unittest.main()
