"""Negative controls for the Issue-label-axis guard: prove it refuses, not merely that it runs."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import issue_label_guard as guard  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"
ACCEPTOR_RUNBOOK = ROOT / "docs" / "zendev" / "ACCEPTOR_RUNBOOK.md"

# Exactly what Issue #448 carried when it reached PR #459: two axes and no `area:*`.
LABELS_448 = ["priority:high", "type:bug", "status:needs-review"]

GOOD = ["priority:normal", "type:process", "area:tooling", "status:in-progress"]

BODY = "Closes #462\n\n## Changed artifacts\n\n- `scripts/issue_label_guard.py`\n"


def resolver(mapping):
    """A `labels_of` that answers from a dict and fails loudly on anything else."""

    def labels_of(number):
        if number not in mapping:
            raise AssertionError("the guard asked about an Issue it was not given: #%d" % number)
        return mapping[number]

    return labels_of


class AxisTests(unittest.TestCase):
    def test_the_448_label_set_is_refused_and_names_the_issue_and_the_axis(self):
        violations = guard.axis_violations(448, LABELS_448)
        self.assertEqual(len(violations), 1)
        self.assertIn("#448", violations[0])
        self.assertIn("area:", violations[0])
        self.assertIn("at least one", violations[0])

    def test_the_message_names_the_labels_that_are_present(self):
        # The fix must be one `gh issue edit`, not an investigation.
        violations = guard.axis_violations(448, LABELS_448)
        for name in LABELS_448:
            self.assertIn(name, violations[0])

    def test_a_fully_labelled_issue_passes(self):
        self.assertEqual(guard.axis_violations(462, GOOD), [])

    def test_several_area_labels_are_allowed(self):
        self.assertEqual(
            guard.axis_violations(1, ["priority:high", "type:bug", "area:config", "area:market"]),
            [],
        )

    def test_no_priority_is_refused(self):
        violations = guard.axis_violations(1, ["type:bug", "area:market"])
        self.assertEqual(len(violations), 1)
        self.assertIn("priority:", violations[0])
        self.assertIn("exactly one", violations[0])

    def test_two_priorities_are_refused(self):
        violations = guard.axis_violations(1, ["priority:high", "priority:normal", "type:bug", "area:market"])
        self.assertEqual(len(violations), 1)
        self.assertIn("priority:", violations[0])

    def test_no_type_is_refused(self):
        violations = guard.axis_violations(1, ["priority:high", "area:market"])
        self.assertEqual(len(violations), 1)
        self.assertIn("type:", violations[0])

    def test_two_types_are_refused(self):
        violations = guard.axis_violations(1, ["priority:high", "type:bug", "type:process", "area:market"])
        self.assertEqual(len(violations), 1)
        self.assertIn("type:", violations[0])

    def test_every_wrong_axis_is_reported_not_just_the_first(self):
        violations = guard.axis_violations(1, ["status:ready"])
        self.assertEqual(len(violations), 3)

    def test_an_unlabelled_issue_is_refused(self):
        violations = guard.axis_violations(1, [])
        self.assertEqual(len(violations), 3)
        self.assertIn("none", violations[0])


class StatusAxisTests(unittest.TestCase):
    def test_status_is_not_counted_toward_any_axis(self):
        # Two `status:*` labels is a different defect (#214) and not this gate's business.
        noisy = GOOD + ["status:needs-review"]
        self.assertEqual(guard.axis_violations(1, noisy), [])

    def test_a_missing_status_label_changes_nothing(self):
        without = [name for name in GOOD if not name.startswith("status:")]
        self.assertEqual(guard.axis_violations(1, without), guard.axis_violations(1, GOOD))

    def test_status_alone_does_not_satisfy_an_axis(self):
        self.assertEqual(len(guard.axis_violations(1, ["status:ready", "status:blocked"])), 3)


class LinkTests(unittest.TestCase):
    def test_the_template_closing_keyword_links_the_issue(self):
        self.assertEqual(guard.linked_issues("Closes #462"), [462])

    def test_every_closing_keyword_form_links(self):
        for word in ("Closes", "closes", "Fixes", "fixed", "Resolves", "RESOLVE"):
            with self.subTest(keyword=word):
                self.assertEqual(guard.linked_issues("%s #7" % word), [7])

    def test_a_bare_reference_is_not_a_link(self):
        # "#448 is related" must not drag an unrelated Issue's labels into this gate.
        self.assertEqual(guard.linked_issues("See #448 and PR #459 for context"), [])

    def test_repeated_links_are_reported_once(self):
        self.assertEqual(guard.linked_issues("Closes #5\n\nCloses #5\nFixes #6"), [5, 6])

    def test_an_empty_or_missing_body_links_nothing(self):
        self.assertEqual(guard.linked_issues(""), [])
        self.assertEqual(guard.linked_issues(None), [])


class CheckTests(unittest.TestCase):
    def test_a_linked_issue_missing_an_axis_refuses_the_pull_request(self):
        violations = guard.check("Closes #448", "claude/issue-448-x", resolver({448: LABELS_448}))
        self.assertEqual(len(violations), 1)
        self.assertIn("#448", violations[0])

    def test_a_correctly_labelled_linked_issue_passes(self):
        self.assertEqual(guard.check(BODY, "claude/issue-462-x", resolver({462: GOOD})), [])

    def test_no_linked_issue_is_not_this_guards_refusal(self):
        # Section 2 of the ACCEPTOR runbook owns that gate; a second wording of it would
        # report one failure as two unrelated defects.
        self.assertEqual(guard.check("## Handoff\n\nNothing linked.", "claude/x", resolver({})), [])

    def test_every_linked_issue_is_checked(self):
        violations = guard.check(
            "Closes #448\nCloses #462", "claude/x", resolver({448: LABELS_448, 462: GOOD})
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("#448", violations[0])

    def test_a_machine_branch_is_exempt_without_resolving_anything(self):
        # A mirror snapshot has no author and no Issue; its own class guard decides it.
        def explode(number):
            raise AssertionError("the forge must not be asked about a machine pull request")

        self.assertEqual(guard.check("Closes #448", "spec-mirror", explode), [])


class WorkflowTests(unittest.TestCase):
    def text(self):
        return CI.read_text(encoding="utf-8")

    def test_the_guard_runs_inside_policy_guard_on_pull_requests(self):
        text = self.text()
        self.assertIn("scripts/issue_label_guard.py", text)
        job = text.index("policy-guard:")
        self.assertGreater(text.index("scripts/issue_label_guard.py"), job)

    def test_the_body_arrives_through_the_environment_not_an_expression(self):
        # Attacker-controllable text on a public repository must never be interpolated
        # into a shell line.
        text = self.text()
        self.assertIn("PR_BODY: ${{ github.event.pull_request.body }}", text)
        self.assertNotIn('"${{ github.event.pull_request.body }}"', text)

    def test_the_guard_is_given_a_token_to_read_the_issue_with(self):
        rows = self.text().splitlines()
        call = next(i for i, row in enumerate(rows) if "scripts/issue_label_guard.py" in row)
        step = next(i for i in range(call, -1, -1) if rows[i].lstrip().startswith("- name:"))
        self.assertIn("GH_TOKEN", "\n".join(rows[step:call]))


class RunbookTests(unittest.TestCase):
    def test_the_decision_table_names_the_check_for_the_label_axes_gate(self):
        # Acceptance criterion 6: the gate moved, so the table must say who holds it now.
        text = ACCEPTOR_RUNBOOK.read_text(encoding="utf-8")
        row = next(
            line for line in text.splitlines()
            if line.startswith("|") and "Label axes on the Issue" in line
        )
        self.assertIn("issue_label_guard.py", row)
        self.assertNotIn("| you |", row)

    def test_the_observed_failure_that_moved_the_gate_is_recorded(self):
        text = ACCEPTOR_RUNBOOK.read_text(encoding="utf-8")
        for evidence in ("#448", "#459", "#462"):
            with self.subTest(evidence=evidence):
                self.assertIn(evidence, text)


if __name__ == "__main__":
    unittest.main()
