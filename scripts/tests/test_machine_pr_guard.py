"""Negative controls: prove the machine-pull-request guard refuses, not merely that it
is wired up. Every refusal has a sibling test asserting the legitimate shape is still
permitted — a guard that refuses everything protects nothing.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import machine_pr_guard as guard  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
REAL_ALLOWLIST = (REPO_ROOT / "docs" / "zendev" / "spec-mirror-allowlist.txt").read_text(
    encoding="utf-8"
)

MIRROR = "docs/spec/mirror/"
SYNC_BOT = "github-actions[bot]"


class ClassificationTests(unittest.TestCase):
    def test_the_mirror_branch_is_a_machine_class(self):
        cls = guard.classify("spec-mirror")
        self.assertIsNotNone(cls)
        self.assertEqual(cls.branch, "spec-mirror")
        self.assertEqual(cls.roots, (MIRROR,))

    def test_an_agent_branch_is_not_a_machine_class(self):
        self.assertIsNone(guard.classify("claude/issue-90-machine-prs"))

    def test_a_lookalike_branch_is_not_a_machine_class(self):
        # Exact match only. "spec-mirror-2" would otherwise inherit the mirror's
        # right to write the mirror.
        self.assertIsNone(guard.classify("spec-mirror-2"))
        self.assertIsNone(guard.classify("feature/spec-mirror"))


class AllowlistParsingTests(unittest.TestCase):
    def test_the_shipped_allowlist_parses_into_its_intended_rules(self):
        directories, files = guard.parse_allowlist(REAL_ALLOWLIST)
        self.assertEqual(directories, ("06 - Handoff/",))
        self.assertEqual(
            files,
            (
                "REQUIREMENTS_REGISTRY.csv",
                "SPEC_INDEX.md",
                "EXECUTION_ORDER.md",
                "SPEC_CHANGELOG.md",
                "ANSWERS_TO_IMPLEMENTER.md",
            ),
        )

    def test_exclusion_rules_grant_nothing(self):
        directories, files = guard.parse_allowlist("- *\n- /02 - Research/**\n")
        self.assertEqual(directories, ())
        self.assertEqual(files, ())


class MirrorBranchTests(unittest.TestCase):
    def check(self, paths, committer=SYNC_BOT, allowlist=REAL_ALLOWLIST):
        return guard.check("spec-mirror", paths, allowlist, committer)

    def test_an_ordinary_sync_is_permitted(self):
        self.assertEqual(
            self.check(
                [
                    MIRROR + "REQUIREMENTS_REGISTRY.csv",
                    MIRROR + "SPEC_CHANGELOG.md",
                    MIRROR + "06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md",
                ]
            ),
            [],
        )

    def test_the_generated_coverage_table_may_ride_along(self):
        # The table is rendered from the registry this branch replaces, and a check
        # compares the two. Without this, a sync that changed any registry status
        # produced a pull request contradicting its own source — unmergeable, and
        # unfixable from outside, because on master the old registry and the old table
        # still agree.
        self.assertEqual(
            self.check(
                [
                    MIRROR + "REQUIREMENTS_REGISTRY.csv",
                    "docs/spec/IMPLEMENTATION_STATUS.md",
                ]
            ),
            [],
        )

    def test_the_exception_covers_that_file_and_nothing_near_it(self):
        # A named file, not a prefix. The ledger it is rendered from lives one
        # directory up from the mirror and is written by AUTHOR runs; a sync that
        # rewrote it would be editing the evidence rather than the specification.
        violations = self.check(
            [MIRROR + "SPEC_INDEX.md", "docs/spec/implementation_status.csv"]
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("docs/spec/implementation_status.csv", violations[0])

    def test_a_path_outside_the_mirror_is_refused(self):
        violations = self.check(
            [MIRROR + "SPEC_INDEX.md", ".github/workflows/spec-sync.yml"]
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("must stay inside", violations[0])
        self.assertIn(".github/workflows/spec-sync.yml", violations[0])

    def test_a_mirror_path_outside_the_allowlist_is_refused(self):
        violations = self.check([MIRROR + "02 - Research/market microstructure.md"])
        self.assertEqual(len(violations), 1)
        self.assertIn("not inside", violations[0])

    def test_an_unnormalized_export_name_is_refused(self):
        # normalize_mirror.py strips the extension Drive appends. If one survives,
        # the mirror is not what the allowlist describes.
        violations = self.check([MIRROR + "SPEC_INDEX.md.md"])
        self.assertEqual(len(violations), 1)
        self.assertIn("not inside", violations[0])

    def test_a_commit_from_another_identity_is_refused(self):
        violations = self.check([MIRROR + "SPEC_INDEX.md"], committer="Dreven")
        self.assertEqual(len(violations), 1)
        self.assertIn("only .github/workflows/spec-sync.yml may write", violations[0])
        self.assertIn("committed by", violations[0])

    def test_an_operator_dispatched_sync_is_permitted(self):
        # #112 exactly. peter-evans/create-pull-request defaults the commit author to
        # whoever triggered the run and the committer to the bot, so a sync a person
        # dispatches by hand — a supported path, which is why spec-sync.yml keeps
        # workflow_dispatch — is authored by that person and committed by the workflow.
        # The gate reads the committer, so this passes.
        self.assertEqual(self.check([MIRROR + "SPEC_CHANGELOG.md"], committer=SYNC_BOT), [])

    def test_an_unreadable_allowlist_is_refused_rather_than_skipped(self):
        violations = self.check([MIRROR + "SPEC_INDEX.md"], allowlist=None)
        self.assertEqual(len(violations), 1)
        self.assertIn("could not be read", violations[0])

    def test_an_unknown_committer_does_not_suppress_the_path_gates(self):
        # committer=None means "unavailable"; main() refuses on that separately. The
        # path gates must still fire here rather than being skipped along with it.
        violations = guard.check(
            "spec-mirror", [MIRROR + "02 - Research/x.md"], REAL_ALLOWLIST, None
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("not inside", violations[0])


class OrdinaryBranchTests(unittest.TestCase):
    def check(self, paths):
        return guard.check("claude/issue-90-example", paths, None, None)

    def test_ordinary_work_is_permitted(self):
        self.assertEqual(
            self.check(
                [
                    "src/domain/id.ts",
                    "src/domain/id.test.ts",
                    "docs/spec/IMPLEMENTATION_STATUS.md",
                    "docs/spec/FEEDBACK_TO_RESEARCHER.md",
                ]
            ),
            [],
        )

    def test_an_ordinary_branch_may_still_write_the_generated_table(self):
        # The exception widens what the mirror may carry; it claims nothing. An AUTHOR
        # adding a ledger row regenerates the same table, and a rule that made the file
        # machine-owned would refuse every one of those pull requests.
        self.assertEqual(
            guard.check(
                "claude/issue-42-example",
                ["docs/spec/implementation_status.csv", "docs/spec/IMPLEMENTATION_STATUS.md"],
                REAL_ALLOWLIST,
                None,
            ),
            [],
        )

    def test_hand_editing_the_mirror_is_refused(self):
        violations = self.check(
            ["src/domain/id.ts", MIRROR + "REQUIREMENTS_REGISTRY.csv"]
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("machine-owned paths", violations[0])
        self.assertIn(MIRROR + "REQUIREMENTS_REGISTRY.csv", violations[0])

    def test_a_policy_branch_may_not_edit_the_mirror_either(self):
        violations = guard.check(
            "policy/whatever", [MIRROR + "SPEC_CHANGELOG.md"], None, None
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("machine-owned paths", violations[0])

    def test_a_sibling_directory_is_not_swallowed_by_the_mirror_prefix(self):
        # docs/spec/mirror-notes/ is not docs/spec/mirror/. Prefix matching must not
        # quietly claim a neighbouring path.
        self.assertEqual(self.check(["docs/spec/mirror-notes/README.md"]), [])


if __name__ == "__main__":
    unittest.main()
