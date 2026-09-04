"""Negative controls: prove the guard fires, not merely that it is configured."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import policy_guard as guard  # noqa: E402


class ClassificationTests(unittest.TestCase):
    def test_policy_and_product_are_separated(self):
        policy, product = guard.classify(
            [
                "AGENTS.md",
                ".github/workflows/zendev-author.yml",
                "docs/zendev/AUTHOR_RUNBOOK.md",
                "TradeCraftSimulation/Market.cs",
                "docs/index.html",
            ]
        )
        self.assertEqual(
            policy,
            [".github/workflows/zendev-author.yml", "AGENTS.md", "docs/zendev/AUTHOR_RUNBOOK.md"],
        )
        self.assertEqual(product, ["TradeCraftSimulation/Market.cs"])

    def test_spec_mirror_is_neither_policy_nor_product(self):
        policy, product = guard.classify(["docs/spec/mirror/REQUIREMENTS_REGISTRY.csv"])
        self.assertEqual(policy, [])
        self.assertEqual(product, [])

    def test_the_control_plane_counts_as_policy(self):
        # The guard, the dispatcher and the mirror tooling decide how the loop behaves.
        # A change to any of them is a policy change, including a change to this guard.
        policy, product = guard.classify(
            [
                "scripts/policy_guard.py",
                "scripts/schedule_watchdog.py",
                "scripts/tests/test_policy_guard.py",
            ]
        )
        self.assertEqual(
            policy,
            [
                "scripts/policy_guard.py",
                "scripts/schedule_watchdog.py",
                "scripts/tests/test_policy_guard.py",
            ],
        )
        self.assertEqual(product, [])

    def test_weakening_the_guard_alongside_product_code_is_refused(self):
        # The specific attack this closes: relax the guard and ship a product change in
        # the same breath, with the guard passing because it no longer objects.
        violations = guard.check(
            ["scripts/policy_guard.py", "src/index.ts"], added_lines=[]
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("split them", violations[0])

    def test_canonical_typescript_counts_as_product(self):
        # From M1 the canonical engine lives in src/. If the guard did not know that,
        # a policy change could ride along inside a canonical diff unnoticed.
        policy, product = guard.classify(
            ["src/index.ts", "src/domain/market.ts", "AGENTS.md"]
        )
        self.assertEqual(policy, ["AGENTS.md"])
        self.assertEqual(product, ["src/domain/market.ts", "src/index.ts"])

    def test_typescript_change_mixed_with_policy_is_refused(self):
        violations = guard.check(["AGENTS.md", "src/index.ts"], added_lines=[])
        self.assertEqual(len(violations), 1)
        self.assertIn("split them", violations[0])


class MixedChangeTests(unittest.TestCase):
    def test_mixed_change_is_refused(self):
        violations = guard.check(
            ["AGENTS.md", "TradeCraftSimulation/Market.cs"], added_lines=[]
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("split them", violations[0])

    def test_policy_only_change_is_allowed(self):
        self.assertEqual(guard.check(["AGENTS.md"], added_lines=[]), [])

    def test_product_only_change_is_allowed(self):
        self.assertEqual(
            guard.check(["TradeCraftSimulation/Market.cs"], added_lines=[]), []
        )


class SecretScanTests(unittest.TestCase):
    # The fixtures below are assembled from fragments rather than written as
    # literals. Writing them out would put credential-shaped strings into a tracked
    # file, and the guard would then refuse every pull request that touches this
    # test — as it did the first time this file was written. Splitting them keeps the
    # scanner free of exceptions: no path is allowlisted, so no path is a hole.
    def test_synthetic_credentials_are_detected(self):
        filler = "A" * 24
        samples = [
            "key = '" + "sk-" + "ant-api03-" + filler + "'",
            "token: " + "ghp" + "_" + filler + "AAAAAAAAAAAA",
            "pat = " + "github" + "_pat_" + filler,
            "google = " + "AIza" + "Sy" + filler,
            "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
            '  "type": "' + 'service_account",',
            "aws = " + "AKIA" + "IOSFODNN7EXAMPLE",
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertTrue(guard.scan_secrets([sample]), f"missed: {sample}")

    def test_ordinary_code_is_not_flagged(self):
        clean = [
            "var price = market.PriceOf(Good.Food);",
            "# See docs/spec/mirror/REQUIREMENTS_REGISTRY.csv",
            "secrets.CLAUDE_CODE_OAUTH_TOKEN",
            "private key handling is documented in AGENTS.md",
        ]
        self.assertEqual(guard.scan_secrets(clean), [])


if __name__ == "__main__":
    unittest.main()
