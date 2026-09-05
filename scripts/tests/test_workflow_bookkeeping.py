"""The bookkeeper must not be executed from the working tree the model left behind.

A run's later steps execute whatever `scripts/` the working directory holds when they
start, and the model changes that directory during the run — the ACCEPTOR runbook
tells it to check out a pull request's head so it can verify independently. One ledger
record came back missing its `model` field for exactly this reason: the reviewed
branch predated the field, and its copy of the recorder ran.

The recording step carries the ledger credential, so this is also the shape of a
credential-handling defect: a pull request that edited the recorder would have had its
version executed by the reviewing workflow with that token in the environment.

The subscription reader is held to the same rule, and to one more: it carries the
Claude OAuth token, so that token must reach exactly the steps that need it — the model
and the two readings — and no other.

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

USAGE_STAGE_LINE = 'cp scripts/subscription_usage.py "${RUNNER_TEMP}/subscription_usage.py"'
USAGE_STAGED_CALL = 'python "${RUNNER_TEMP}/subscription_usage.py"'
USAGE_WORKING_TREE_CALL = "python scripts/subscription_usage.py"
OAUTH_TOKEN = "secrets.CLAUDE_CODE_OAUTH_TOKEN"


def lines(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8").splitlines()


def index_of(rows, needle, name):
    for i, row in enumerate(rows):
        if needle in row:
            return i
    raise AssertionError(f"{name}: {needle!r} not found")


def indexes_of(rows, needle):
    return [i for i, row in enumerate(rows) if needle in row]


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


class SubscriptionReaderTests(unittest.TestCase):
    def test_the_reader_is_staged_before_the_model_runs(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                rows = lines(name)
                self.assertLess(index_of(rows, USAGE_STAGE_LINE, name), index_of(rows, MODEL_STEP, name))

    def test_one_reading_precedes_the_model_and_one_follows_it(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                rows = lines(name)
                calls = indexes_of(rows, USAGE_STAGED_CALL)
                model = index_of(rows, MODEL_STEP, name)
                self.assertEqual(len(calls), 2, f"{name}: expected exactly two readings, found {len(calls)}")
                self.assertLess(calls[0], model, f"{name}: the first reading must precede the model")
                self.assertGreater(calls[1], model, f"{name}: the second reading must follow the model")

    def test_the_reader_never_runs_from_the_working_tree(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                self.assertEqual([r for r in lines(name) if USAGE_WORKING_TREE_CALL in r], [])

    def test_the_oauth_token_reaches_exactly_the_model_and_the_two_readings(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                self.assertEqual(
                    len(indexes_of(lines(name), OAUTH_TOKEN)),
                    3,
                    f"{name}: the OAuth token must appear in the model step and the two "
                    "reading steps, nowhere else",
                )

    def test_the_recorder_receives_both_readings(self):
        for name in MODEL_RUNNERS:
            with self.subTest(workflow=name):
                text = "\n".join(lines(name))
                self.assertIn("--usage-before", text)
                self.assertIn("--usage-after", text)


if __name__ == "__main__":
    unittest.main()
