"""What the intake job may and may not do to a finding from the external QA voice.

The QA account has read access only, so without this job its Issues carry no labels
and no work-selection item in the AUTHOR runbook can reach them. The tests below fix
both halves of that: the finding becomes visible, and it does not become work.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import qa_intake  # noqa: E402

KNOWN = [
    "type:bug", "type:feature", "type:process", "type:docs",
    "area:simulation-core", "area:tooling", "area:market",
    "priority:high", "priority:normal", "priority:low",
    "status:needs-triage", "status:ready", "status:in-progress", "qa", "policy",
]

BODY = """## Goal

The genesis reconciliation compares the wrong totals.

Type: bug
Area: simulation-core
Priority: high
"""


class DeclarationTests(unittest.TestCase):
    def test_the_three_declaration_lines_become_labels(self):
        self.assertEqual(
            qa_intake.declared_labels(BODY),
            ["type:bug", "area:simulation-core", "priority:high"],
        )

    def test_the_shapes_a_writer_actually_uses(self):
        for body in (
            "Type: bug",
            "**Type:** bug",
            "- Type: bug",
            "> Type:  bug  ",
            "type: BUG",
        ):
            with self.subTest(body=body):
                self.assertEqual(qa_intake.declared_labels(body), ["type:bug"])

    def test_a_multiword_area_becomes_the_hyphenated_label(self):
        self.assertEqual(
            qa_intake.declared_labels("Area: simulation core"), ["area:simulation-core"]
        )

    def test_prose_mentioning_an_axis_is_not_a_declaration(self):
        # Anchored to the line start, or every finding that discusses its own type
        # would relabel itself from the middle of a sentence.
        for body in (
            "The Type: bug declaration was missing from the earlier report.",
            "I would call this a type: bug, but see below.",
        ):
            with self.subTest(body=body):
                self.assertEqual(qa_intake.declared_labels(body), [])

    def test_the_first_declaration_of_an_axis_wins(self):
        # A quoted reply repeating the heading must not override the author's own.
        body = "Type: bug\n\n> Type: feature\n"
        self.assertEqual(qa_intake.declared_labels(body), ["type:bug"])


class LabelSelectionTests(unittest.TestCase):
    def test_a_well_formed_finding_gets_its_axes_plus_qa_and_triage(self):
        self.assertEqual(
            qa_intake.labels_to_apply(BODY, [], KNOWN),
            ["area:simulation-core", "priority:high", "qa", "status:needs-triage",
             "type:bug"],
        )

    def test_an_unknown_value_is_dropped_and_the_finding_still_arrives(self):
        # The outside account must not be able to extend the repository's vocabulary,
        # and losing one axis costs a triage while inventing a label costs the meaning
        # of every axis. The finding still becomes visible.
        body = "Type: bug\nArea: quantum-tunnelling\nPriority: high\n"
        self.assertEqual(
            qa_intake.labels_to_apply(body, [], KNOWN),
            ["priority:high", "qa", "status:needs-triage", "type:bug"],
        )

    def test_a_finding_with_no_declarations_still_becomes_visible(self):
        self.assertEqual(
            qa_intake.labels_to_apply("just prose", [], KNOWN),
            ["qa", "status:needs-triage"],
        )

    def test_it_never_grants_status_ready(self):
        # The QA voice may not put work into the AUTHOR's queue. Promotion is a
        # judgement made at triage, by the AUTHOR.
        body = BODY + "\nStatus: ready\nstatus:ready\n"
        applied = qa_intake.labels_to_apply(body, [], KNOWN)
        self.assertNotIn("status:ready", applied)
        self.assertIn("status:needs-triage", applied)

    def test_it_does_not_add_a_second_status_label(self):
        # #214: an open Issue carrying two status:* labels happened twice in one day
        # and needed an operator both times. On `reopened` one may already stand.
        applied = qa_intake.labels_to_apply(BODY, ["status:in-progress"], KNOWN)
        self.assertNotIn("status:needs-triage", applied)
        self.assertIn("qa", applied)

    def test_labels_already_present_are_not_re_applied(self):
        applied = qa_intake.labels_to_apply(BODY, ["qa", "type:bug"], KNOWN)
        self.assertEqual(applied, ["area:simulation-core", "priority:high",
                                   "status:needs-triage"])

    def test_nothing_to_add_is_an_empty_list_not_an_error(self):
        have = ["type:bug", "area:simulation-core", "priority:high", "qa",
                "status:needs-triage"]
        self.assertEqual(qa_intake.labels_to_apply(BODY, have, KNOWN), [])

    def test_a_label_the_repository_does_not_have_yet_is_not_invented(self):
        # If `qa` has not been created, the job must still label what it can rather
        # than fail on a label that does not exist.
        without_qa = [name for name in KNOWN if name != "qa"]
        applied = qa_intake.labels_to_apply(BODY, [], without_qa)
        self.assertNotIn("qa", applied)
        self.assertIn("status:needs-triage", applied)

    def test_the_policy_label_is_never_granted_from_a_body(self):
        # `policy` marks the control plane, which the AUTHOR must not take. An outside
        # account naming it must not be able to move an Issue into that class.
        applied = qa_intake.labels_to_apply("Type: process\nArea: tooling\npolicy\n",
                                            [], KNOWN)
        self.assertNotIn("policy", applied)


class IdentityTests(unittest.TestCase):
    def test_the_bot_suffix_is_not_part_of_the_identity(self):
        self.assertEqual(qa_intake.normalize_login("AndyDev"), "andydev")
        self.assertEqual(qa_intake.normalize_login("zendev-machine[bot]"),
                         "zendev-machine")


if __name__ == "__main__":
    unittest.main()
