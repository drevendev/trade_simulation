"""The scheme a run was under, and the two ways that claim can go wrong.

A day of telemetry compares to another day only if the setup was the same. Between
2026-09-05 and 2026-09-07 the identities, the per-run ceilings and the ownership of
the verdict all changed, and nothing in the ledger said so.
"""

import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import schemes  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
FILE = ROOT / "docs" / "zendev" / "schemes.json"

ONE = {
    "id": "scheme/1",
    "roles": {"author": {"identity": "a[bot]", "model": "claude-haiku-4-5",
                         "max_budget_usd": 3.0}},
    "verdict_owner": "any account",
    "voices": [],
    "required_checks": ["build-and-test"],
    "rework_limit": 3,
    "cadence_minutes": 25,
    "note": "prose that must not affect the digest",
    "in_force_from": "2026-09-05T18:40:00Z",
    "commit": "",
}


class DigestTests(unittest.TestCase):
    def test_prose_and_bookkeeping_do_not_change_the_identity_of_a_scheme(self):
        # An operator filling in the commit of the merge that put a scheme in force
        # must not make every record written before that edit look like another one.
        edited = dict(ONE, note="rewritten later", commit="5c9f9ec",
                      in_force_from="2026-09-06T11:43:00Z")
        self.assertEqual(schemes.digest(ONE), schemes.digest(edited))

    def test_a_changed_ceiling_is_a_different_scheme(self):
        raised = json.loads(json.dumps(ONE))
        raised["roles"]["author"]["max_budget_usd"] = 5.0
        self.assertNotEqual(schemes.digest(ONE), schemes.digest(raised))

    def test_a_changed_verdict_owner_is_a_different_scheme(self):
        owned = dict(ONE, verdict_owner="zendev-acceptor")
        self.assertNotEqual(schemes.digest(ONE), schemes.digest(owned))

    def test_reformatting_the_file_is_not_a_change(self):
        reordered = {key: ONE[key] for key in reversed(list(ONE))}
        self.assertEqual(schemes.digest(ONE), schemes.digest(reordered))


class ObservedDriftTests(unittest.TestCase):
    """The hash cannot see the descriptor drifting from reality. This can."""

    def test_the_pinned_alias_matches_the_exact_build_the_run_reports(self):
        # The workflow pins `claude-haiku-4-5`; the result names
        # `claude-haiku-4-5-20251001`. An exact comparison would cry drift every run.
        self.assertIsNone(
            schemes.check_observed(ONE, "author", "claude-haiku-4-5-20251001")
        )

    def test_a_different_model_is_reported(self):
        message = schemes.check_observed(ONE, "author", "claude-sonnet-5")
        self.assertIn("scheme/1", message)
        self.assertIn("claude-sonnet-5", message)

    def test_a_run_with_no_model_contradicts_nothing(self):
        # A role that found no work observes nothing about itself.
        self.assertIsNone(schemes.check_observed(ONE, "acceptor", ""))

    def test_a_role_the_scheme_does_not_describe_is_not_drift(self):
        self.assertIsNone(schemes.check_observed(ONE, "machine", "claude-haiku-4-5"))


class StampTests(unittest.TestCase):
    def test_an_unreadable_file_costs_the_block_not_the_record(self):
        # The telemetry record is the only evidence a run happened. A recorder that
        # dies on a malformed JSON file loses that, which is far worse than a record
        # with no scheme block.
        self.assertIsNone(schemes.stamp(ROOT / "docs" / "zendev" / "no-such-file.json"))

    def test_the_repositorys_own_file_produces_a_stamp(self):
        stamp = schemes.stamp(FILE)
        self.assertIsNotNone(stamp)
        self.assertTrue(stamp["id"].startswith("scheme/"))
        self.assertEqual(len(stamp["digest"]), 12)


class TheRepositorysOwnSchemesTests(unittest.TestCase):
    def test_the_active_scheme_exists(self):
        document = schemes.load(FILE)
        self.assertIsNotNone(
            schemes.active(document),
            "`active` names a scheme that is not in the file",
        )

    def test_scheme_ids_are_unique_and_numbered_without_gaps(self):
        ids = [scheme["id"] for scheme in schemes.load(FILE)["schemes"]]
        self.assertEqual(len(ids), len(set(ids)))
        numbers = [int(name.split("/")[1]) for name in ids]
        self.assertEqual(numbers, list(range(1, len(numbers) + 1)))

    def test_every_scheme_declares_who_owns_the_verdict(self):
        # The field this whole exercise exists to make explicit.
        for scheme in schemes.load(FILE)["schemes"]:
            with self.subTest(scheme=scheme["id"]):
                self.assertTrue((scheme.get("verdict_owner") or "").strip())

    def test_every_scheme_carries_every_descriptive_key(self):
        # A scheme missing one hashes as if the field were absent everywhere, so two
        # genuinely different setups could share a digest.
        for scheme in schemes.load(FILE)["schemes"]:
            for key in schemes.DESCRIPTIVE_KEYS:
                with self.subTest(scheme=scheme["id"], key=key):
                    self.assertIn(key, scheme)


if __name__ == "__main__":
    unittest.main()
