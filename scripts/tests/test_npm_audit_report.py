"""Offline negative and positive controls for npm advisory evidence (#829)."""

import json
import pathlib
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import npm_audit_report as audit  # noqa: E402


class AuditEvidenceTests(unittest.TestCase):
    @staticmethod
    def report(nodes=None):
        return {
            "metadata": {"vulnerabilities": {"high": 1, "moderate": 0}},
            "vulnerabilities": {
                "sample-package": {
                    "severity": "high", "range": "<2.0.0",
                    "nodes": nodes if nodes is not None else ["node_modules/sample-package"],
                    "via": [{"source": 1234, "url": "https://github.com/advisories/GHSA-test"}],
                    "fixAvailable": {"name": "sample-package", "version": "2.0.0", "isSemVerMajor": True},
                }
            },
        }

    def test_reports_advisory_fix_and_explicit_dev_only_scope(self):
        lock = {"packages": {"node_modules/sample-package": {"dev": True}}}
        output = audit.summarize(self.report(), lock)
        self.assertIn("HIGH sample-package [dev-only]", output)
        self.assertIn("https://github.com/advisories/GHSA-test", output)
        self.assertIn("fix=sample-package@2.0.0 (major=True)", output)
        self.assertIn("NOT exploit reachability", output)

    def test_non_dev_and_missing_node_are_not_falsely_called_dev_only(self):
        path = "node_modules/sample-package"
        self.assertIn("[non-dev]", audit.summarize(self.report(), {"packages": {path: {"version": "1.0.0"}}}))
        self.assertIn("[unknown]", audit.summarize(self.report(), {"packages": {}}))

    def test_mixed_node_scope_is_unknown_unless_non_dev_is_explicit(self):
        nodes = ["node_modules/sample-package", "node_modules/other"]
        lock = {"packages": {"node_modules/sample-package": {"dev": True}}}
        self.assertIn("[unknown]", audit.summarize(self.report(nodes), lock))
        lock["packages"]["node_modules/other"] = {"version": "1"}
        self.assertIn("[non-dev]", audit.summarize(self.report(nodes), lock))

    def test_rejects_errors_and_malformed_audit_data(self):
        for bad in ({"error": {"code": "ENOAUDIT"}}, {}, {"vulnerabilities": []}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                audit.summarize(bad, {"packages": {}})

    def test_successful_audit_can_report_zero_findings(self):
        self.assertIn("0 affected package(s)", audit.summarize(
            {"vulnerabilities": {}, "metadata": {"vulnerabilities": {"high": 0}}},
            {"packages": {}}))

    def test_npm_exit_one_with_valid_advisories_is_not_a_tool_failure(self):
        fake = lambda *args, **kw: subprocess.CompletedProcess(args[0], 1,
            stdout=json.dumps(self.report()), stderr="")
        self.assertIn("vulnerabilities", audit.run_audit(fake))

    def test_failed_audit_tool_cannot_be_reported_as_clean(self):
        fake = lambda *args, **kw: subprocess.CompletedProcess(args[0], 2,
            stdout="", stderr="network unavailable")
        with self.assertRaisesRegex(ValueError, "failed with exit 2"):
            audit.run_audit(fake)

    def test_advisory_text_cannot_inject_a_multiline_actions_command(self):
        report = self.report()
        report["vulnerabilities"]["sample-package"]["range"] = "<2\n::error::spoofed"
        output = audit.summarize(report, {"packages": {"node_modules/sample-package": {"dev": True}}})
        self.assertNotIn("\n::error::spoofed", output)


if __name__ == "__main__":
    unittest.main()
