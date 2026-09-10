"""Negative controls for the implementation-ledger lint.

Three of these reproduce drift that actually happened: a requirement claimed by a merged
pull request with no row at all (REQ-CONFIG-005, merged in #76), a row citing another
pull request that had not merged (#87 proposing `#84 (pending merge)` as evidence), and
a row citing its own open pull request (#91).

The third one changed meaning, and deliberately. When the status document was
maintained by hand, a row could be written by any pull request, so citing an open one —
including its own — asserted an outcome that had not happened, and #84 showed a cited
pull request can be closed without ever merging. Under the ledger a row is appended by
the pull request that earns it: the row and the citation land together, and a pull
request closed without merging takes its row with it. So a row may cite the pull request
that carries it, and nothing else that is open.

The fourth reproduces #369. `REQ-VISUALIZATION-007` was merged by #358 before the
registry knew the name; the mirror proposal registering it was then refused here for
the missing row, and the row could not be written because the validator refuses an
unregistered identifier. The change that introduces an identifier may lack its row —
that change only, that identifier only — and these prove the exception is computed
from the registries and cannot outlive the change that used it.
"""

import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import status_lint  # noqa: E402


def row(req="REQ-CORE-001", status="IMPLEMENTED", issue="46", pr="48", evidence="a test"):
    return {
        "REQ_ID": req,
        "STATUS": status,
        "ISSUE": issue,
        "PR": pr,
        "MERGE_COMMIT": "",
        "EVIDENCE": evidence,
    }


class MissingRowTests(unittest.TestCase):
    def test_a_requirement_claimed_by_a_merged_pull_request_must_have_a_row(self):
        # REQ-CONFIG-005 exactly: merged in #76, recorded nowhere, and therefore
        # re-opened as fresh work by a later run.
        violations = status_lint.lint(
            [row()],
            merged_pull_numbers={48, 76},
            requirements_claimed_by_merged={"REQ-CORE-001": [48], "REQ-CONFIG-005": [76]},
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("REQ-CONFIG-005", violations[0])
        self.assertIn("#76", violations[0])
        self.assertIn("NOT_STARTED", violations[0])

    def test_a_recorded_requirement_raises_nothing(self):
        self.assertEqual(
            status_lint.lint(
                [row()],
                merged_pull_numbers={48},
                requirements_claimed_by_merged={"REQ-CORE-001": [48]},
            ),
            [],
        )


class UnmergedCitationTests(unittest.TestCase):
    def test_a_row_may_not_cite_another_open_pull_request(self):
        # The #87 defect, in ledger form.
        violations = status_lint.lint(
            [row(req="REQ-CONFIG-003", status="PARTIAL", pr="84")],
            merged_pull_numbers={79},
            requirements_claimed_by_merged={},
            self_pull=98,
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#84", violations[0])
        self.assertIn("has not merged", violations[0])
        self.assertIn("PARTIAL", violations[0])

    def test_a_row_may_cite_the_pull_request_that_carries_it(self):
        # #91's shape, now correct: the row is inside the pull request it names, so it
        # becomes true exactly when it becomes visible, and false nowhere.
        self.assertEqual(
            status_lint.lint(
                [row(req="REQ-CONFIG-003", status="PARTIAL", pr="91")],
                merged_pull_numbers={79},
                requirements_claimed_by_merged={},
                self_pull=91,
            ),
            [],
        )

    def test_that_exemption_is_for_one_pull_request_only(self):
        # Being checked on #91 does not license a row citing some other open change.
        violations = status_lint.lint(
            [row(pr="91"), row(req="REQ-CORE-002", pr="84")],
            merged_pull_numbers=set(),
            requirements_claimed_by_merged={},
            self_pull=91,
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#84", violations[0])

    def test_a_push_event_has_no_self_and_refuses_every_open_citation(self):
        # On master there is no pull request being checked, and every row there arrived
        # by merging, so an unmerged citation is unambiguously wrong.
        violations = status_lint.lint(
            [row(pr="91")],
            merged_pull_numbers={79},
            requirements_claimed_by_merged={},
            self_pull=None,
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#91", violations[0])

    def test_the_issue_field_may_name_an_open_issue(self):
        # Issues are cited while open by design; only the pull request is checked.
        self.assertEqual(
            status_lint.lint(
                [row(issue="83", pr="48")],
                merged_pull_numbers={48},
                requirements_claimed_by_merged={},
            ),
            [],
        )


class DelegationTests(unittest.TestCase):
    """Everything this no longer checks is checked somewhere that needs no network."""

    def test_a_row_with_no_pull_request_is_left_to_the_validator(self):
        # implementation_status.validate refuses IMPLEMENTED without a pull request,
        # offline and by identifier. Repeating it here would put the same rule behind a
        # network call and let the two disagree.
        self.assertEqual(
            status_lint.lint(
                [row(status="BLOCKED", pr="")],
                merged_pull_numbers=set(),
                requirements_claimed_by_merged={},
            ),
            [],
        )

    def test_statuses_that_assert_merged_code_are_read_from_the_generator(self):
        # One definition of "this status claims merged code", not two.
        self.assertIn("IMPLEMENTED", status_lint.CITES_MERGED_CODE)
        self.assertIn("PARTIAL", status_lint.CITES_MERGED_CODE)
        self.assertNotIn("BLOCKED", status_lint.CITES_MERGED_CODE)


REGISTRY = "docs/spec/mirror/REQUIREMENTS_REGISTRY.csv"
HEADER = "REQ_ID,AREA,FILE,ANCHOR,STATEMENT,TYPE,PRIORITY,STATUS,MILESTONE,ACCEPTANCE\n"
NEW = "REQ-VISUALIZATION-007"


def registry(*ids):
    return HEADER + "".join(
        "%s,docs,file.md,anchor,statement,functional,high,READY,M3,acceptance\n" % i
        for i in ids
    )


def git(cwd, *args):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


class RegistryHistory:
    """Three commits: before any registry, a registry without NEW, then one adding it.

    That is the shape of #369 exactly: master had no `REQ-VISUALIZATION-007`, #358 had
    merged under that name, and the mirror proposal was the change introducing it.
    """

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        git(root, "init", "-b", "master")
        git(root, "config", "user.email", "test@example.invalid")
        git(root, "config", "user.name", "Test")

        (root / "README.md").write_text("base\n", encoding="utf-8")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "before any registry")
        self.before_registry = git(root, "rev-parse", "HEAD")

        path = root / REGISTRY
        path.parent.mkdir(parents=True)
        path.write_text(registry("REQ-CORE-001"), encoding="utf-8")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "registry")
        self.without = git(root, "rev-parse", "HEAD")

        path.write_text(registry("REQ-CORE-001", NEW), encoding="utf-8")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "registry introduces " + NEW)
        self.introducing = git(root, "rev-parse", "HEAD")

        self.root = root
        return self

    def __exit__(self, *exc):
        self.tmp.cleanup()
        return False


class RegistryIntroductionTests(unittest.TestCase):
    """#369: the change that registers an identifier may lack its row, once."""

    CLAIMED = {"REQ-CORE-001": [48], NEW: [358]}

    def test_the_identifier_this_change_registers_may_lack_its_row(self):
        self.assertEqual(
            status_lint.lint([row()], {48, 358}, self.CLAIMED, bootstrapping={NEW}), []
        )

    def test_an_unrelated_missing_row_is_still_refused_beside_it(self):
        claimed = dict(self.CLAIMED, **{"REQ-CONFIG-005": [76]})
        violations = status_lint.lint([row()], {48, 76, 358}, claimed, bootstrapping={NEW})
        self.assertEqual(len(violations), 1)
        self.assertIn("REQ-CONFIG-005", violations[0])
        self.assertNotIn(NEW, violations[0])

    def test_the_exception_expires_with_the_change_that_used_it(self):
        # The next change is measured against a base that already carries the
        # identifier, so nothing is new and the missing row is what it always was.
        violations = status_lint.lint(
            [row()], {48, 358}, self.CLAIMED, bootstrapping=frozenset()
        )
        self.assertEqual(len(violations), 1)
        self.assertIn(NEW, violations[0])

    def test_a_truthful_row_ends_the_bootstrap(self):
        rows = [row(), row(req=NEW, status="PARTIAL", issue="355", pr="358")]
        self.assertEqual(status_lint.lint(rows, {48, 358}, self.CLAIMED), [])

    def test_the_exception_does_not_reach_the_citation_rule(self):
        # Being newly registered says nothing about the pull request a row cites.
        rows = [row(req=NEW, status="PARTIAL", pr="999")]
        violations = status_lint.lint(rows, {48}, {}, bootstrapping={NEW})
        self.assertEqual(len(violations), 1)
        self.assertIn("#999", violations[0])

    def test_the_set_is_the_difference_of_the_registries(self):
        self.assertEqual(status_lint.newly_registered({"A"}, {"A", NEW}), {NEW})
        self.assertEqual(status_lint.newly_registered({"A", NEW}, {"A", NEW}), frozenset())
        # A removal introduces nothing.
        self.assertEqual(status_lint.newly_registered({"A", NEW}, {"A"}), frozenset())
        # The registry's own first commit introduced everything in it.
        self.assertEqual(status_lint.newly_registered(set(), {"A"}), {"A"})


class RegistryAtRefTests(unittest.TestCase):
    def test_the_registry_is_read_at_the_ref_not_from_the_working_tree(self):
        with RegistryHistory() as h:
            self.assertIn(NEW, status_lint.registry_ids_at(h.introducing, cwd=h.root))
            self.assertNotIn(NEW, status_lint.registry_ids_at(h.without, cwd=h.root))
            self.assertIn("REQ-CORE-001", status_lint.registry_ids_at(h.without, cwd=h.root))

    def test_a_commit_before_the_registry_existed_holds_no_identifiers(self):
        with RegistryHistory() as h:
            self.assertEqual(
                status_lint.registry_ids_at(h.before_registry, cwd=h.root), frozenset()
            )

    def test_a_base_that_does_not_resolve_is_refused_not_treated_as_empty(self):
        # Empty would make every identifier new, and the exception permanent.
        with RegistryHistory() as h:
            with self.assertRaises(LookupError):
                status_lint.registry_ids_at("no-such-ref", cwd=h.root)

    def test_the_cycle_of_369_end_to_end(self):
        # Base: no NEW. Merged #358 claims NEW. The candidate registers NEW. No row.
        with RegistryHistory() as h:
            head = status_lint.registry_ids_at(h.introducing, cwd=h.root)
            claimed = {NEW: [358]}

            # The registering change, measured against the base it is proposed to.
            new = status_lint.newly_registered(
                status_lint.registry_ids_at(h.without, cwd=h.root), head
            )
            self.assertEqual(new, {NEW})
            self.assertEqual(
                status_lint.lint([row()], {48, 358}, claimed, bootstrapping=new), []
            )

            # The change after it, measured against a base that now carries NEW.
            new = status_lint.newly_registered(
                status_lint.registry_ids_at(h.introducing, cwd=h.root), head
            )
            self.assertEqual(new, frozenset())
            self.assertEqual(
                len(status_lint.lint([row()], {48, 358}, claimed, bootstrapping=new)), 1
            )

            # And once the row lands, nothing is exceptional any more.
            rows = [row(), row(req=NEW, status="PARTIAL", issue="355", pr="358")]
            self.assertEqual(
                status_lint.lint(rows, {48, 358}, claimed, bootstrapping=new), []
            )


if __name__ == "__main__":
    unittest.main()
