"""Exact-text edits applied from `master`, all or nothing, and never over the control plane."""

import os
import pathlib
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import apply_zen_edits as zen  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "zen-edit.yml"

EDIT = """### FILE: src/config/a.ts
<<<<<<< FIND
    population: {
=======
    population: createDefaults(),
>>>>>>> REPLACE
"""

TARGET = "export const config = {\n    labor: {\n    },\n    population: {\n    },\n};\n"


def block(find, replace):
    return f"{zen.FIND_MARK}\n{find}\n{zen.SPLIT_MARK}\n{replace}\n{zen.REPLACE_MARK}\n"


class ParseTests(unittest.TestCase):
    def test_one_file_one_block(self):
        self.assertEqual(zen.parse(EDIT),
                         [("src/config/a.ts", [("    population: {", "    population: createDefaults(),")])])

    def test_several_blocks_and_sections_keep_their_order(self):
        text = ("### FILE: a.ts\n" + block("one", "1") + "a note between blocks\n" + block("two", "2")
                + "### FILE: `b.ts`\n" + block("three", ""))
        self.assertEqual(zen.parse(text), [("a.ts", [("one", "1"), ("two", "2")]), ("b.ts", [("three", "")])])

    def test_multi_line_text_is_kept_verbatim_with_its_indentation(self):
        text = "### FILE: a.ts\n" + block("  a\n\n    b  ", "  c")
        self.assertEqual(zen.parse(text)[0][1], [("  a\n\n    b  ", "  c")])

    def test_an_edit_file_written_with_crlf_parses_the_same(self):
        self.assertEqual(zen.parse(EDIT.replace("\n", "\r\n")), zen.parse(EDIT))

    def test_malformed_files_are_refused_by_name(self):
        cases = {
            "no FILE": block("a", "b"),
            "unclosed": "### FILE: a.ts\n<<<<<<< FIND\na\n=======\nb\n",
            "nested find": "### FILE: a.ts\n<<<<<<< FIND\na\n<<<<<<< FIND\n",
            "stray split": "### FILE: a.ts\n=======\n",
            "empty section": "### FILE: a.ts\n",
            "no path": "### FILE:\n" + block("a", "b"),
            "nothing": "just words\n",
        }
        for name, text in cases.items():
            with self.subTest(case=name), self.assertRaises(zen.Refusal):
                zen.parse(text)


class ReplaceTests(unittest.TestCase):
    def test_a_find_that_occurs_once_is_replaced(self):
        out = zen.apply_to_text(TARGET, [("    population: {\n    },", "    population: make(),")], "a.ts")
        self.assertIn("    population: make(),\n};", out)
        self.assertIn("    labor: {\n    },", out)

    def test_a_find_that_does_not_occur_is_refused(self):
        with self.assertRaisesRegex(zen.Refusal, "not found"):
            zen.apply_to_text(TARGET, [("population: [", "x")], "a.ts")

    def test_a_find_that_occurs_twice_is_refused_with_the_count(self):
        with self.assertRaisesRegex(zen.Refusal, "occurs 2 times"):
            zen.apply_to_text(TARGET, [("    },", "x")], "a.ts")

    def test_an_empty_find_is_refused(self):
        with self.assertRaisesRegex(zen.Refusal, "FIND is empty"):
            zen.apply_to_text(TARGET, [("", "x")], "a.ts")

    def test_blocks_apply_in_order_to_the_text_the_previous_block_left(self):
        out = zen.apply_to_text("a b c", [("b", "X"), ("a X", "done")], "a.ts")
        self.assertEqual(out, "done c")

    def test_an_empty_replace_deletes(self):
        self.assertEqual(zen.apply_to_text("keep\ndrop\nkeep2\n", [("keep\ndrop\n", "keep\n")], "a.ts"), "keep\nkeep2\n")

    def test_a_crlf_file_stays_crlf_and_still_matches_lf_find_text(self):
        out = zen.apply_to_text("a\r\nb\r\nc\r\n", [("a\nb", "A\nB")], "a.ts")
        self.assertEqual(out, "A\r\nB\r\nc\r\n")


class PathTests(unittest.TestCase):
    def test_ordinary_repository_paths_are_editable(self):
        for path in ("src/config/simulationConfig.ts", "docs/spec/OPEN_QUESTIONS.md", "README.md"):
            with self.subTest(path=path):
                self.assertIsNone(zen.path_refusal(path))

    def test_everything_else_is_refused(self):
        for path in ("", "/etc/passwd", "../x", "src/../../x", "src\\a.ts", "C:/x", "src//a.ts", "./a.ts",
                     ".github/workflows/ci.yml", "scripts/policy_guard.py", "docs/zendev/schemes.json",
                     "AGENTS.md", "docs/spec/mirror/REQUIREMENTS_REGISTRY.csv", ".zen/edits/x.edit", ".git/config"):
            with self.subTest(path=path):
                self.assertIsNotNone(zen.path_refusal(path))


class ExecuteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = pathlib.Path(self.tmp.name)
        (self.work / "src" / "config").mkdir(parents=True)
        (self.work / "src" / "config" / "a.ts").write_text(TARGET, encoding="utf-8")
        (self.work / ".zen" / "edits").mkdir(parents=True)

    def edit(self, name, text):
        (self.work / ".zen" / "edits" / name).write_text(text, encoding="utf-8")

    def test_edits_are_applied_and_the_edit_file_is_removed(self):
        self.edit("001.edit", "### FILE: src/config/a.ts\n" + block("    population: {\n    },", "    population: make(),"))
        outcome, report, names = zen.execute(self.work)
        self.assertEqual(outcome, "applied")
        self.assertEqual(names, [".zen/edits/001.edit"])
        self.assertIn("population: make(),", (self.work / "src/config/a.ts").read_text(encoding="utf-8"))
        self.assertFalse((self.work / ".zen/edits/001.edit").exists())
        self.assertIn("## zen-edit: applied", report)
        self.assertIn("`src/config/a.ts`", report)

    def test_one_refused_block_and_nothing_at_all_is_changed(self):
        self.edit("001.edit", "### FILE: src/config/a.ts\n" + block("    labor: {", "    labour: {"))
        self.edit("002.edit", "### FILE: src/config/a.ts\n" + block("no such text", "x"))
        outcome, report, names = zen.execute(self.work)
        self.assertEqual((outcome, names), ("refused", []))
        self.assertEqual((self.work / "src/config/a.ts").read_text(encoding="utf-8"), TARGET)
        self.assertTrue((self.work / ".zen/edits/001.edit").exists())
        self.assertIn("## zen-edit: not applied", report)
        self.assertIn("`.zen/edits/002.edit`", report)
        self.assertIn("block 1", report)
        self.assertIn("not found", report)

    def test_two_edit_files_for_one_target_apply_in_name_order(self):
        self.edit("001.edit", "### FILE: src/config/a.ts\n" + block("    labor: {", "    labour: {"))
        self.edit("002.edit", "### FILE: src/config/a.ts\n" + block("    labour: {", "    work: {"))
        self.assertEqual(zen.execute(self.work)[0], "applied")
        self.assertIn("    work: {", (self.work / "src/config/a.ts").read_text(encoding="utf-8"))

    def test_the_control_plane_a_missing_file_and_a_binary_are_refused(self):
        (self.work / "scripts").mkdir()
        (self.work / "scripts" / "guard.py").write_text("x = 1\n", encoding="utf-8")
        (self.work / "src" / "blob.bin").write_bytes(b"\xff\xfe\x00binary")
        for target, fragment in (("scripts/guard.py", "not editable through zen-edit"),
                                 ("src/config/missing.ts", "not an existing regular file"),
                                 ("src/blob.bin", "not UTF-8")):
            with self.subTest(target=target):
                self.edit("001.edit", f"### FILE: {target}\n" + block("x", "y"))
                outcome, report, _ = zen.execute(self.work)
                self.assertEqual(outcome, "refused")
                self.assertIn(fragment, report)
        self.assertEqual((self.work / "scripts" / "guard.py").read_text(encoding="utf-8"), "x = 1\n")

    def test_a_symlinked_target_is_refused(self):
        outside = pathlib.Path(self.tmp.name + "-outside.txt")
        outside.write_text("secret\n", encoding="utf-8")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        link = self.work / "src" / "link.ts"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("this platform does not let the test create a symlink")
        self.edit("001.edit", "### FILE: src/link.ts\n" + block("secret", "leaked"))
        self.assertEqual(zen.execute(self.work)[0], "refused")
        self.assertEqual(outside.read_text(encoding="utf-8"), "secret\n")

    def test_no_edit_files_is_not_an_event(self):
        self.assertEqual(zen.execute(self.work), ("none", "", []))

    def test_more_edit_files_than_the_bound_is_refused(self):
        for index in range(zen.MAX_EDIT_FILES + 1):
            self.edit(f"{index:03d}.edit", "### FILE: src/config/a.ts\n" + block("    labor: {", "    labor: {"))
        self.assertEqual(zen.execute(self.work)[0], "refused")

    def test_main_reports_the_outcome_to_the_workflow(self):
        self.edit("001.edit", "### FILE: src/config/a.ts\n" + block("    labor: {", "    labour: {"))
        output = self.work / "github-output.txt"
        report = self.work / "report.md"
        names = self.work / "names.txt"
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}):
            self.assertEqual(zen.main(["--work", str(self.work), "--report", str(report), "--names", str(names)]), 0)
        self.assertEqual(output.read_text(encoding="utf-8"), "outcome=applied\n")
        self.assertEqual(names.read_text(encoding="utf-8"), ".zen/edits/001.edit")
        self.assertIn("## zen-edit: applied", report.read_text(encoding="utf-8"))


def run_lines(body):
    """Every line of shell the workflow runs, from `run:` steps inline or in a block."""
    lines, collecting, indent = [], False, 0
    for line in body.split("\n"):
        match = re.match(r"^(\s*)(?:- )?run:\s*(\|)?\s*(.*)$", line)
        if match and not collecting:
            if match.group(2):
                collecting, indent = True, len(match.group(1))
            elif match.group(3):
                lines.append(match.group(3))
            continue
        if collecting:
            if line.strip() and len(line) - len(line.lstrip()) <= indent:
                collecting = False
            else:
                lines.append(line.strip())
    return [line for line in lines if line]


class WorkflowTests(unittest.TestCase):
    """The branch is data. `master`'s applier is the only program that touches it."""

    def setUp(self):
        self.body = WORKFLOW.read_text(encoding="utf-8").replace("\r\n", "\n")

    def test_it_runs_master_s_definition_on_edit_files_only(self):
        block_ = re.search(r"^on:\n((?:(?:[ ]+\S.*)?\n)*)", self.body, re.MULTILINE).group(1)
        self.assertEqual(set(re.findall(r"^  ([\w]+):", block_, re.MULTILINE)), {"pull_request_target"})
        self.assertIn("types: [opened, reopened, synchronize]", block_)
        self.assertIn("- '.zen/edits/**'", block_)

    def test_only_this_repository_s_zen_branches(self):
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", self.body)
        self.assertIn("startsWith(github.event.pull_request.head.ref, 'zen/')", self.body)

    def test_the_workflow_token_reads_and_the_machine_writes(self):
        block_ = re.search(r"^permissions:\n((?:  .*\n)*)", self.body, re.MULTILINE).group(1)
        grants = dict(re.findall(r"^  ([\w-]+):\s*(\w+)\s*$", block_, re.MULTILINE))
        self.assertEqual(grants, {"contents": "read", "pull-requests": "read"})
        self.assertIn("vars.ZENDEV_MACHINE_APP_CLIENT_ID", self.body)
        self.assertIn("repositories: ${{ github.event.repository.name }}", self.body)
        for other in ("ZENDEV_AUTHOR_APP", "ZENDEV_ACCEPTOR_APP", "claude-code-action", "ZENDEV_PAT"):
            self.assertNotIn(other, self.body)

    def test_both_checkouts_drop_their_credentials_and_the_branch_goes_to_work(self):
        checkouts = re.findall(r"uses: actions/checkout@v\d+\n\s+with:\n((?:\s{10}.*\n)+)", self.body)
        self.assertEqual(len(checkouts), 2)
        for options in checkouts:
            self.assertIn("persist-credentials: false", options)
        control, work = checkouts
        self.assertIn("path: control", control)
        self.assertNotIn("ref:", control, "the definition that runs is master's, the event's default")
        self.assertIn("path: work", work)
        self.assertIn("ref: ${{ github.event.pull_request.head.sha }}", work)

    def test_nothing_from_the_branch_is_ever_executed(self):
        lines = run_lines(self.body)
        self.assertTrue(any("control/scripts/apply_zen_edits.py" in line for line in lines),
                        "the scan must see the applier, or it is seeing nothing")
        for line in lines:
            with self.subTest(line=line):
                self.assertNotRegex(line, r"\b(?:npm|npx|node|yarn|pnpm|pip|make|dotnet)\b")
                self.assertNotRegex(line, r"(?:python|bash|sh|source|\.)\s+\.?/?work/")
                if re.search(r"\bpython\b", line):
                    self.assertIn("control/scripts/", line)

    def test_names_a_pusher_chose_reach_the_shell_through_the_environment_only(self):
        for line in run_lines(self.body):
            with self.subTest(line=line):
                self.assertNotIn("${{", line, "an expression inside a run line interpolates untrusted text")
        self.assertIn("HEAD_REF: ${{ github.event.pull_request.head.ref }}", self.body)
        self.assertIn('"HEAD:refs/heads/${HEAD_REF}"', self.body)

    def test_the_push_is_never_forced(self):
        for line in run_lines(self.body):
            self.assertNotRegex(line, r"--force|-f\b|\+HEAD")


if __name__ == "__main__":
    unittest.main()
