"""Scheduling safety controls without network calls or paid model dispatches."""

from datetime import datetime, timedelta, timezone
import os
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import schedule_watchdog as watchdog

NOW = datetime(2026, 9, 4, 12, 0, tzinfo=timezone.utc)


def attempt(age=30, status="completed", conclusion="success", **fields):
    return {"id": 123, "workflow_id": 1, "head_branch": "master", "status": status,
            "conclusion": conclusion, "created_at": (NOW - timedelta(minutes=age)).isoformat(),
            **fields}


class IntervalTests(unittest.TestCase):
    """The cadence variable is the only ceiling on how often paid runs start."""

    def resolve(self, value):
        env = {"GITHUB_ACTIONS": "true"}
        if value is not None:
            env["ZENDEV_INTERVAL_MINUTES"] = value
        with patch.dict(os.environ, env, clear=True):
            return watchdog.resolve_interval()

    def test_unset_and_blank_use_the_default(self):
        self.assertEqual(self.resolve(None), watchdog.INTERVAL)
        self.assertEqual(self.resolve("   "), watchdog.INTERVAL)

    def test_operator_value_inside_the_range_is_honoured(self):
        self.assertEqual(self.resolve("30"), timedelta(minutes=30))
        self.assertEqual(self.resolve("15"), watchdog.MIN_INTERVAL)
        self.assertEqual(self.resolve("360"), watchdog.MAX_INTERVAL)

    def test_unusable_values_fall_back_and_never_widen_silently(self):
        for value in ("14", "0", "-30", "361", "abc", "30.5", ""):
            with self.subTest(value=value):
                self.assertEqual(self.resolve(value), watchdog.INTERVAL)

    def test_actions_reads_the_env_not_the_variables_api(self):
        with patch.object(watchdog, "api", side_effect=AssertionError("no API call")):
            self.assertEqual(self.resolve("30"), timedelta(minutes=30))

    def test_run_does_not_resolve_the_cadence_itself(self):
        """main() resolves once; run() must add no API call to the dispatch path."""
        with patch.object(watchdog, "is_enabled", return_value=False),                 patch.object(watchdog, "api") as api:
            watchdog.run(dispatch=True, now=NOW)
        api.assert_not_called()


class InspectTests(unittest.TestCase):
    def inspect(self, recent=(), active=(), state="active", interval=watchdog.INTERVAL):
        def history(endpoint, **filters):
            return list(active) if filters.get("status") == "waiting" else (
                [] if "status" in filters else list(recent))
        with patch.object(watchdog, "api", return_value={"state": state, "id": 1}), \
                patch.object(watchdog, "read_runs", side_effect=history):
            return watchdog.inspect_target(watchdog.TARGETS[0], NOW, interval)

    def test_recent_success_failed_and_cancelled_attempts_suppress_retry(self):
        for conclusion in ("success", "failure", "cancelled", "skipped", "timed_out"):
            with self.subTest(conclusion=conclusion):
                self.assertEqual(self.inspect([attempt(conclusion=conclusion)])["decision"], "recent")

    def test_one_hour_boundary_is_due(self):
        self.assertEqual(self.inspect([attempt(age=59.99)])["decision"], "recent")
        self.assertEqual(self.inspect([attempt(age=60)])["decision"], "due")
        self.assertEqual(self.inspect()["decision"], "due")

    def test_boundary_follows_the_configured_interval(self):
        half = timedelta(minutes=30)
        self.assertEqual(self.inspect([attempt(age=29.99)], interval=half)["decision"], "recent")
        self.assertEqual(self.inspect([attempt(age=30)], interval=half)["decision"], "due")
        # The same run is still inside the default hour: cadence is the only difference.
        self.assertEqual(self.inspect([attempt(age=30)])["decision"], "recent")

    def test_old_waiting_approval_blocks(self):
        self.assertEqual(self.inspect(active=[attempt(age=180, status="waiting")])["decision"], "active")

    def test_new_run_created_during_inspection_blocks(self):
        for status in ("queued", "in_progress", "waiting", "pending", "requested"):
            self.assertEqual(self.inspect([attempt(status=status)])["decision"], "active")

    def test_disabled_workflow_is_not_reenabled(self):
        self.assertEqual(self.inspect(state="disabled_manually")["decision"], "disabled")

    def test_latest_unsorted_attempt_and_future_time_are_safe(self):
        self.assertEqual(self.inspect([attempt(age=59), attempt(age=-1)])["run_id"], 123)
        self.assertEqual(self.inspect([attempt(age=-1)])["decision"], "recent")

    def test_wrong_branch_and_workflow_fail_closed(self):
        for fields in ({"head_branch": "untrusted"}, {"workflow_id": 99}):
            for keyword in ("recent", "active"):
                with self.assertRaises(ValueError):
                    self.inspect(**{keyword: [attempt(**fields)]})

    def test_unknown_target_fails_without_network(self):
        with patch.object(watchdog, "api") as api, self.assertRaises(ValueError):
            watchdog.inspect_target("other.yml", NOW)
        api.assert_not_called()


class HistoryTests(unittest.TestCase):
    def test_paginates_until_total_is_satisfied(self):
        with patch.object(watchdog, "api", side_effect=[
            {"total_count": 2, "workflow_runs": [attempt()]},
            {"total_count": 2, "workflow_runs": [attempt(id=124)]},
        ]) as api:
            self.assertEqual(len(watchdog.read_runs("endpoint", status="waiting")), 2)
            self.assertIn("page=2", api.call_args.args[0])
            self.assertIn("branch=master", api.call_args.args[0])

    def test_truncated_and_malformed_history_fail_closed(self):
        for response in ({"total_count": 1, "workflow_runs": []},
                         {"total_count": "0", "workflow_runs": []},
                         {"total_count": -1, "workflow_runs": []}):
            with patch.object(watchdog, "api", return_value=response), \
                    self.assertRaises((RuntimeError, ValueError)):
                watchdog.read_runs("endpoint")


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.enabled = patch.object(watchdog, "is_enabled", return_value=True)
        self.enabled.start()
        self.addCleanup(self.enabled.stop)

    def test_dry_run_never_posts(self):
        with patch.object(watchdog, "inspect_target", return_value={"decision": "due"}), \
                patch.object(watchdog, "api") as api:
            self.assertEqual(len(watchdog.run(now=NOW)), 3)
            api.assert_not_called()

    def test_dispatches_each_due_target_once_to_master(self):
        with patch.object(watchdog, "inspect_target", side_effect=lambda target, now, interval=None: {
            "workflow": target, "decision": "due"}), patch.object(watchdog, "api") as api:
            watchdog.run(dispatch=True, now=NOW)
            self.assertEqual(api.call_count, 3)
            for call, target in zip(api.call_args_list, watchdog.TARGETS):
                self.assertEqual(call.args[0], f"repos/{watchdog.REPOSITORY}/actions/workflows/{target}/dispatches")
                self.assertEqual(call.kwargs, {"payload": {"ref": "master"}})

    def test_recheck_prevents_racing_with_manual_run(self):
        with patch.object(watchdog, "inspect_target", side_effect=[
            {"decision": "due"}, {"decision": "active"},
            {"decision": "recent"}, {"decision": "disabled"},
        ]), patch.object(watchdog, "api") as api:
            watchdog.run(dispatch=True, now=NOW)
            api.assert_not_called()

    def test_disabled_repository_and_inspection_error_never_post(self):
        with patch.object(watchdog, "is_enabled", return_value=False), \
                patch.object(watchdog, "api") as api:
            self.assertEqual(watchdog.run(dispatch=True)[0]["decision"], "disabled")
            api.assert_not_called()
        with patch.object(watchdog, "inspect_target", side_effect=RuntimeError("API failure")), \
                patch.object(watchdog, "api") as api, self.assertRaises(RuntimeError):
            watchdog.run(dispatch=True)
        api.assert_not_called()

    def test_uncertain_dispatch_is_not_retried(self):
        with patch.object(watchdog, "inspect_target", return_value={"decision": "due"}), \
                patch.object(watchdog, "api", side_effect=RuntimeError("network")) as api, \
                self.assertRaises(RuntimeError):
            watchdog.run(dispatch=True, now=NOW)
        self.assertEqual(api.call_count, 1)


class EnvironmentTests(unittest.TestCase):
    def test_actions_uses_trusted_vars_not_variables_api(self):
        env = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": watchdog.REPOSITORY,
               "GITHUB_REF": "refs/heads/master", "ZENDEV_ENABLED": "true"}
        with patch.dict(os.environ, env, clear=True), patch.object(watchdog, "api") as api:
            self.assertTrue(watchdog.is_enabled())
            os.environ["ZENDEV_ENABLED"] = "false"
            self.assertFalse(watchdog.is_enabled())
            os.environ["GITHUB_REF"] = "refs/heads/untrusted"
            with self.assertRaises(ValueError):
                watchdog.is_enabled()
            api.assert_not_called()

    def test_local_diagnostics_read_current_variable(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(watchdog, "api", return_value={"value": "true"}) as api:
            self.assertTrue(watchdog.is_enabled())
            self.assertIn("variables/ZENDEV_ENABLED", api.call_args.args[0])

    def test_api_failure_does_not_disclose_server_body(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 1, stdout="", stderr="sensitive fixture")), self.assertRaises(RuntimeError) as error:
            watchdog.api("endpoint")
        self.assertNotIn("sensitive", str(error.exception))

    def test_only_dispatch_has_post_and_json_body(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 0, stdout="", stderr="")) as process:
            watchdog.api("endpoint", payload={"ref": "master"})
            self.assertIn("POST", process.call_args.args[0])
            self.assertEqual(process.call_args.kwargs["input"], '{"ref": "master"}')


class WiringTests(unittest.TestCase):
    def test_one_scheduler_and_no_agent_authority_changes(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        for target in watchdog.TARGETS:
            text = (root / ".github/workflows" / target).read_text()
            self.assertNotIn("  schedule:", text)
            self.assertIn("  workflow_dispatch:", text)
        scheduler = (root / ".github/workflows/zendev-watchdog.yml").read_text()
        self.assertIn('cron: "11,26,41,56 * * * *"', scheduler)
        self.assertIn("GH_TOKEN: ${{ github.token }}", scheduler)
        self.assertNotIn("secrets.ZENDEV_PAT", scheduler)
        self.assertNotIn("claude-code-action", scheduler)
        self.assertIn("default: false", scheduler)


if __name__ == "__main__":
    unittest.main()
