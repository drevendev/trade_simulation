"""The forge resolves what the forge generated, and refuses everything else.

The last test is the one that matters: it builds the conflict of 2026-09-06 out of real
commits in a real repository and proves the merge comes out with both sides' evidence.
"""

import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import implementation_status  # noqa: E402
import resolve_ledger_conflicts as resolver  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "mergeability.yml"

HEADER = ["REQ_ID", "STATUS", "ISSUE", "PR", "MERGE_COMMIT", "EVIDENCE"]


def row(identifier, status="IMPLEMENTED", evidence="a named test"):
    return [identifier, status, "1", "2", "", evidence]


def pull(ref="claude/issue-1-example", state="dirty", mergeable=False, draft=False,
         head_repo="drevendev/trade_simulation", base_repo="drevendev/trade_simulation"):
    return {
        "number": 1,
        "state": "open",
        "draft": draft,
        "mergeable": mergeable,
        "mergeable_state": state,
        "head": {"ref": ref, "sha": "a" * 40, "repo": {"full_name": head_repo}},
        "base": {"ref": "master", "repo": {"full_name": base_repo}},
    }


class ShouldResolveTests(unittest.TestCase):
    def test_a_conflicting_loop_branch_is_attempted(self):
        ok, reason = resolver.should_resolve(pull())
        self.assertTrue(ok)
        self.assertEqual(reason, "dirty")

    def test_a_branch_that_is_merely_behind_belongs_to_the_sweep(self):
        # `update_branches.py` owns that state; two scripts pushing to one branch would
        # race, and the forge's own endpoint does it without a checkout.
        ok, reason = resolver.should_resolve(pull(state="behind"))
        self.assertFalse(ok)
        self.assertIn("behind", reason)

    def test_a_clean_branch_is_not_touched(self):
        for state in ("clean", "blocked", "unstable"):
            with self.subTest(state=state):
                ok, _ = resolver.should_resolve(pull(state=state))
                self.assertFalse(ok)

    def test_an_uncomputed_answer_is_not_a_reason_to_act(self):
        ok, reason = resolver.should_resolve(pull(mergeable=None))
        self.assertFalse(ok)
        self.assertIn("not yet computed", reason)

    def test_a_machine_branch_is_never_resolved(self):
        ok, reason = resolver.should_resolve(pull(ref="spec-mirror"))
        self.assertFalse(ok)
        self.assertIn("machine class", reason)

    def test_an_operator_branch_is_left_alone(self):
        for ref in ("policy/204-something", "docs/a-note", "fix/a-bug"):
            with self.subTest(ref=ref):
                ok, reason = resolver.should_resolve(pull(ref=ref))
                self.assertFalse(ok)
                self.assertIn("not a loop branch", reason)

    def test_a_fork_head_is_not_ours_to_move(self):
        ok, reason = resolver.should_resolve(pull(head_repo="someone/trade_simulation"))
        self.assertFalse(ok)
        self.assertIn("not in this repository", reason)

    def test_drafts_and_closed_pull_requests_are_skipped(self):
        self.assertFalse(resolver.should_resolve(pull(draft=True))[0])
        closed = pull()
        closed["state"] = "closed"
        self.assertFalse(resolver.should_resolve(closed)[0])


class ResolvablePathsTests(unittest.TestCase):
    def test_the_two_generated_ledger_files_are_resolvable(self):
        self.assertTrue(resolver.only_the_ledger(
            ["docs/spec/implementation_status.csv", "docs/spec/IMPLEMENTATION_STATUS.md"]
        ))

    def test_one_product_file_among_them_refuses_the_whole_merge(self):
        # Half a resolution is worse than none: the author must see the conflict whole.
        self.assertFalse(resolver.only_the_ledger(
            ["docs/spec/implementation_status.csv", "src/simulation/worldState.ts"]
        ))

    def test_a_neighbouring_specification_file_is_not_the_ledger(self):
        for path in (
            "docs/spec/FEEDBACK_TO_RESEARCHER.md",
            "docs/spec/mirror/REQUIREMENTS_REGISTRY.csv",
            "scripts/implementation_status.py",
        ):
            with self.subTest(path=path):
                self.assertFalse(resolver.only_the_ledger([path]))

    def test_nothing_conflicting_is_not_something_to_resolve(self):
        self.assertFalse(resolver.only_the_ledger([]))


class MergeRowsTests(unittest.TestCase):
    def test_each_side_keeps_the_row_only_it_touched(self):
        # #196 and #198, exactly: each branch appended a row of its own while master
        # changed a different one. Nothing here is a disagreement.
        base = [row("REQ-A"), row("REQ-B")]
        ours = [row("REQ-A"), row("REQ-B"), row("REQ-NEW")]
        theirs = [row("REQ-A", "PARTIAL", "the row master demoted"), row("REQ-B")]

        merged, disagreements = resolver.merge_ledger_rows(base, ours, theirs)

        self.assertEqual(disagreements, [])
        self.assertEqual([r[0] for r in merged], ["REQ-A", "REQ-B", "REQ-NEW"])
        self.assertEqual(merged[0][1], "PARTIAL")

    def test_both_sides_changing_one_row_is_a_disagreement_this_refuses(self):
        # Master demoted the row; the branch promoted it with new evidence. Which
        # evidence stands is exactly the judgement this must not make.
        base = [row("REQ-A")]
        ours = [row("REQ-A", "IMPLEMENTED", "the repair's new test")]
        theirs = [row("REQ-A", "PARTIAL", "returned by QA")]

        merged, disagreements = resolver.merge_ledger_rows(base, ours, theirs)

        self.assertEqual(disagreements, ["REQ-A"])
        self.assertEqual(merged, [])

    def test_the_same_change_on_both_sides_is_not_a_disagreement(self):
        base = [row("REQ-A")]
        same = [row("REQ-A", "PARTIAL")]
        merged, disagreements = resolver.merge_ledger_rows(base, same, list(same))
        self.assertEqual(disagreements, [])
        self.assertEqual(merged, same)

    def test_a_row_deleted_on_one_side_stays_deleted(self):
        base = [row("REQ-A"), row("REQ-B")]
        ours = [row("REQ-A"), row("REQ-B")]
        theirs = [row("REQ-A")]
        merged, disagreements = resolver.merge_ledger_rows(base, ours, theirs)
        self.assertEqual(disagreements, [])
        self.assertEqual([r[0] for r in merged], ["REQ-A"])

    def test_a_row_deleted_by_one_side_and_changed_by_the_other_is_a_disagreement(self):
        base = [row("REQ-A")]
        ours = [row("REQ-A", "PARTIAL")]
        theirs = []
        _, disagreements = resolver.merge_ledger_rows(base, ours, theirs)
        self.assertEqual(disagreements, ["REQ-A"])

    def test_the_base_branchs_order_is_kept_and_new_rows_follow_it(self):
        base = []
        ours = [row("REQ-MINE")]
        theirs = [row("REQ-ONE"), row("REQ-TWO")]
        merged, _ = resolver.merge_ledger_rows(base, ours, theirs)
        self.assertEqual([r[0] for r in merged], ["REQ-ONE", "REQ-TWO", "REQ-MINE"])

    def test_rendering_round_trips_through_the_parser(self):
        rows = [row("REQ-A", evidence='evidence with a comma, a "quote" and a\nnewline')]
        text = resolver.render_ledger(HEADER, rows)
        self.assertIn("\r\n", text)
        header, parsed = resolver.parse_ledger(text)
        self.assertEqual(header, HEADER)
        self.assertEqual(parsed, rows)


class WorkflowTests(unittest.TestCase):
    def text(self):
        return WORKFLOW.read_text(encoding="utf-8")

    def test_the_resolver_runs_from_master_only_and_after_the_sweep(self):
        rows = self.text().splitlines()
        sweep = next(i for i, r in enumerate(rows) if "update_branches.py" in r)
        resolve = next(i for i, r in enumerate(rows) if "resolve_ledger_conflicts.py" in r)
        self.assertLess(sweep, resolve)
        step = self.text()[self.text().rindex("- name:", 0, self.text().index("resolve_ledger_conflicts.py")):]
        self.assertIn("github.ref == 'refs/heads/master'", step.split("run:")[0])

    def test_the_resolver_acts_as_the_machine_identity_so_the_push_is_measured(self):
        body = self.text()
        step = body[body.rindex("- name:", 0, body.index("resolve_ledger_conflicts.py")):]
        self.assertIn("steps.identity.outputs.token", step.split("run:")[0])
        self.assertNotIn("github.token", step.split("run:")[0])

    def test_the_checkout_has_the_history_a_merge_needs(self):
        # A shallow clone has no merge base, and the merge would fail on every branch.
        self.assertIn("fetch-depth: 0", self.text())

    def test_the_token_is_never_an_argument(self):
        self.assertNotIn("${GH_TOKEN}@", self.text())
        self.assertIn("${GH_TOKEN}", resolver.CREDENTIAL_HELPER)


def git(args, cwd):
    subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8"
    )


class RealMergeTests(unittest.TestCase):
    """The conflict of 2026-09-06, built out of commits and resolved."""

    def build(self, tmp, extra_conflict=False):
        origin = tmp / "origin.git"
        work = tmp / "work"
        subprocess.run(["git", "init", "--bare", "-b", "master", str(origin)],
                       check=True, capture_output=True)
        subprocess.run(["git", "clone", str(origin), str(work)], check=True, capture_output=True)
        git(["config", "user.name", "test"], work)
        git(["config", "user.email", "test@example.invalid"], work)

        registry = work / "docs" / "spec" / "mirror"
        registry.mkdir(parents=True)
        (registry / "REQUIREMENTS_REGISTRY.csv").write_text(
            "REQ_ID,AREA,STATUS\nREQ-A,CORE,READY\nREQ-B,CORE,READY\nREQ-NEW,CORE,READY\n",
            encoding="utf-8",
        )
        (work / "docs" / "spec" / "IMPLEMENTATION_STATUS.md").write_text(
            "# Implementation status\n\n## Coverage\n\n"
            f"{implementation_status.BEGIN}\n{implementation_status.END}\n",
            encoding="utf-8",
        )
        if extra_conflict:
            (work / "src").mkdir()
            (work / "src" / "worldState.ts").write_text("export const base = 1;\n", encoding="utf-8")

        self.write_ledger(work, [row("REQ-A"), row("REQ-B")])
        git(["add", "-A"], work)
        git(["commit", "-m", "base"], work)
        git(["push", "origin", "master"], work)
        return origin, work

    def write_ledger(self, work, rows):
        (work / "docs" / "spec" / "implementation_status.csv").write_text(
            resolver.render_ledger(HEADER, rows), encoding="utf-8", newline=""
        )
        self.assertEqual(implementation_status.main(["--root", str(work)]), 0)

    def diverge(self, work, extra_conflict=False):
        """A branch that appends a row, and a master that changes another."""
        git(["checkout", "-b", "claude/issue-1-example"], work)
        self.write_ledger(work, [row("REQ-A"), row("REQ-B"), row("REQ-NEW", evidence="the branch's own")])
        if extra_conflict:
            (work / "src" / "worldState.ts").write_text("export const branch = 2;\n", encoding="utf-8")
        git(["add", "-A"], work)
        git(["commit", "-m", "branch work"], work)
        git(["push", "origin", "claude/issue-1-example"], work)

        git(["checkout", "master"], work)
        self.write_ledger(work, [row("REQ-A", "PARTIAL", "returned by QA"), row("REQ-B")])
        if extra_conflict:
            (work / "src" / "worldState.ts").write_text("export const master = 3;\n", encoding="utf-8")
        git(["add", "-A"], work)
        git(["commit", "-m", "operator correction"], work)
        git(["push", "origin", "master"], work)

    def test_a_conflict_confined_to_the_ledger_is_merged_with_both_sides(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = pathlib.Path(name)
            _, work = self.build(tmp)
            self.diverge(work)

            outcome = resolver.resolve(work, pull(), push=False)

            self.assertIn("resolved", outcome, outcome)
            self.assertNotIn("left to the author", outcome)
            # Both sides' evidence survived, and the generated document agrees with it.
            header, rows = resolver.parse_ledger(
                (work / resolver.LEDGER_CSV).read_text(encoding="utf-8")
            )
            self.assertEqual(header, HEADER)
            by_id = {r[0]: r for r in rows}
            self.assertEqual(by_id["REQ-A"][1], "PARTIAL")
            self.assertEqual(by_id["REQ-NEW"][5], "the branch's own")
            self.assertEqual(implementation_status.main(["--root", str(work), "--check"]), 0)
            # A merge commit, with nothing left unmerged.
            self.assertEqual(resolver.unmerged_paths(work), [])

    def test_a_conflict_touching_product_code_is_left_whole_for_the_author(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = pathlib.Path(name)
            _, work = self.build(tmp, extra_conflict=True)
            self.diverge(work, extra_conflict=True)

            outcome = resolver.resolve(work, pull(), push=False)

            self.assertIn("left to the author", outcome)
            self.assertIn("src/worldState.ts", outcome)
            # The merge was abandoned, not left half-done.
            self.assertEqual(resolver.unmerged_paths(work), [])
            status = subprocess.run(
                ["git", "-C", str(work), "status", "--porcelain"],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(status.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
