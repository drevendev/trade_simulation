"""The mirror is navigated by exact filename, so normalization has to be exact."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import normalize_mirror as norm  # noqa: E402


class IntendedNameTests(unittest.TestCase):
    def test_doubled_extensions_are_collapsed(self):
        cases = {
            "SPEC_INDEX.md.md": "SPEC_INDEX.md",
            "REQUIREMENTS_REGISTRY.csv.csv": "REQUIREMENTS_REGISTRY.csv",
            "NOTES.txt.txt": "NOTES.txt",
            "01 — CORE_SCHEMA_AND_LIFECYCLES.md.md": "01 — CORE_SCHEMA_AND_LIFECYCLES.md",
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(norm.intended_name(name), expected)

    def test_correct_names_are_left_alone(self):
        for name in (
            "SPEC_INDEX.md",
            "REQUIREMENTS_REGISTRY.csv",
            "01 — CORE_SCHEMA_AND_LIFECYCLES.md",
            "START_HERE",
            "archive.tar.gz",
        ):
            with self.subTest(name=name):
                self.assertIsNone(norm.intended_name(name))

    def test_a_single_dot_md_is_not_stripped(self):
        # The failure worth guarding: turning SPEC_INDEX.md into SPEC_INDEX would
        # break every FILE reference in the requirements registry.
        self.assertIsNone(norm.intended_name("SPEC_INDEX.md"))


class PlanTests(unittest.TestCase):
    def test_plan_covers_only_what_needs_renaming(self):
        plan = norm.plan(["A.md.md", "B.md", "C.csv.csv", "START_HERE"])
        self.assertEqual(plan, {"A.md.md": "A.md", "C.csv.csv": "C.csv"})


if __name__ == "__main__":
    unittest.main()
