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
    def test_synthetic_credentials_are_detected(self):
        samples = [
            "key = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'",
            "token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "pat = github_pat_AAAAAAAAAAAAAAAAAAAAAA",
            "google = AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "-----BEGIN RSA PRIVATE KEY-----",
            '  "type": "service_account",',
            "aws = AKIAIOSFODNN7EXAMPLE",
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
