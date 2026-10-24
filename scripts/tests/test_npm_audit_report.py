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


    def test_blocks_high_and_critical_without_proven_dev_only_scope(self):
        path = "node_modules/sample-package"
        report = self.report()
        for scope in ({"packages": {path: {"version": "1.0.0"}}},
                      {"packages": {}},
                      {"packages": {path: {"dev": False}}}):
            with self.subTest(scope=scope):
                self.assertEqual(audit.high_findings_not_proven_dev_only(report, scope),
                                 ["sample-package"])
        report["vulnerabilities"]["sample-package"]["severity"] = "critical"
        self.assertEqual(audit.high_findings_not_proven_dev_only(report, {"packages": {}}),
                         ["sample-package"])

    def test_dev_only_high_remains_reported_but_not_blocked(self):
        lock = {"packages": {"node_modules/sample-package": {"dev": True}}}
        self.assertEqual(audit.high_findings_not_proven_dev_only(self.report(), lock), [])
        self.assertIn("HIGH sample-package", audit.summarize(self.report(), lock))

    def test_moderate_non_dev_does_not_trigger_high_severity_gate(self):
        report = self.report()
        report["vulnerabilities"]["sample-package"]["severity"] = "moderate"
        self.assertEqual(audit.high_findings_not_proven_dev_only(report, {"packages": {}}), [])

    def test_cli_exits_three_on_high_nondev_with_visible_advisory(self):
        import contextlib
        import io
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            report_file = folder / "audit.json"
            lock_file = folder / "package-lock.json"
            report_file.write_text(json.dumps(self.report()), encoding="utf-8")
            lock_file.write_text(json.dumps({"packages": {
                "node_modules/sample-package": {"dev": False}}}), encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = audit.main(["--report-json", str(report_file), "--lockfile", str(lock_file)])
            self.assertEqual(code, 3)
            self.assertIn("HIGH sample-package [non-dev]", out.getvalue())
            self.assertIn("::error::HIGH/CRITICAL", err.getvalue())
            lock_file.write_text(json.dumps({"packages": {
                "node_modules/sample-package": {"dev": True}}}), encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = audit.main(["--report-json", str(report_file), "--lockfile", str(lock_file)])
            self.assertEqual(code, 0)
            self.assertIn("HIGH sample-package [dev-only]", out.getvalue())
            self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
