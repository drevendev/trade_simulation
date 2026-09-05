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
        # Only one model target is simultaneously due here, so alternation never
        # kicks in and every due target -- spec-sync plus the one model target --
        # dispatches. See AlternationDispatchTests for the both-due case.
        with patch.object(watchdog, "inspect_target", side_effect=lambda target, now, interval=None: {
            "workflow": target, "decision": "due" if target != "zendev-acceptor.yml" else "recent"}), \
                patch.object(watchdog, "api") as api:
            watchdog.run(dispatch=True, now=NOW)
            self.assertEqual(api.call_count, 2)
            expected = ("spec-sync.yml", "zendev-author.yml")
            for call, target in zip(api.call_args_list, expected):
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
        # Only spec-sync is due, so this exercises the POST failure itself rather
        # than the (separately tested) alternation tie-break lookup.
        with patch.object(watchdog, "inspect_target", side_effect=lambda target, now, interval=None: (
                {"decision": "due"} if target == "spec-sync.yml" else {"decision": "recent"})), \
                patch.object(watchdog, "api", side_effect=RuntimeError("network")) as api, \
                self.assertRaises(RuntimeError):
            watchdog.run(dispatch=True, now=NOW)
        self.assertEqual(api.call_count, 1)


class RepositoryNameTests(unittest.TestCase):
    """The name is data from the run's context, never a constant the dispatcher enforces.

    On 2026-09-05 a rename in case only — trade_simulation to Trade_Simulation — made the
    strict comparison that used to live in is_enabled() refuse every tick until the name
    was put back (#171).
    """

    def test_actions_takes_the_repository_from_the_environment_whatever_its_spelling(self):
        for spelling in ("drevendev/trade_simulation", "drevendev/Trade_Simulation", "drevendev/TradeSim"):
            with self.subTest(spelling=spelling), patch.dict(
                os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": spelling}, clear=True
            ):
                self.assertEqual(watchdog.resolve_repository(None), spelling)

    def test_actions_refuses_to_guess_when_the_environment_is_silent(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}, clear=True), self.assertRaises(ValueError):
            watchdog.resolve_repository(None)

    def test_actions_refuses_an_argument_for_another_repository_but_not_another_spelling(self):
        env = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "drevendev/Trade_Simulation"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(watchdog.resolve_repository("drevendev/trade_simulation"), "drevendev/Trade_Simulation")
            with self.assertRaises(ValueError):
                watchdog.resolve_repository("someone/elsewhere")

    def test_local_runs_use_the_argument_or_the_documented_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(watchdog.resolve_repository("drevendev/TradeSim"), "drevendev/TradeSim")
            self.assertEqual(watchdog.resolve_repository(None), watchdog.DEFAULT_REPOSITORY)

    def test_is_enabled_reads_the_switch_under_any_spelling_and_still_insists_on_master(self):
        env = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "drevendev/Trade_Simulation",
               "GITHUB_REF": "refs/heads/master", "ZENDEV_ENABLED": "true"}
        with patch.dict(os.environ, env, clear=True), patch.object(watchdog, "api") as api:
            self.assertTrue(watchdog.is_enabled())
            os.environ["GITHUB_REF"] = "refs/heads/untrusted"
            with self.assertRaises(ValueError):
                watchdog.is_enabled()
            api.assert_not_called()


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


class LastRunTimeTests(unittest.TestCase):
    def test_returns_the_newest_run_timestamp(self):
        with patch.object(watchdog, "api", return_value={"workflow_runs": [attempt(age=5)]}) as api:
            when = watchdog.last_run_time(watchdog.MODEL_TARGETS[0])
        self.assertEqual(when, NOW - timedelta(minutes=5))
        self.assertIn("per_page=1", api.call_args.args[0])

    def test_no_history_returns_none(self):
        with patch.object(watchdog, "api", return_value={"workflow_runs": []}):
            self.assertIsNone(watchdog.last_run_time(watchdog.MODEL_TARGETS[0]))

    def test_wrong_branch_fails_closed(self):
        with patch.object(watchdog, "api", return_value={"workflow_runs": [attempt(head_branch="untrusted")]}):
            with self.assertRaises(ValueError):
                watchdog.last_run_time(watchdog.MODEL_TARGETS[0])

    def test_malformed_response_fails_closed(self):
        for response in ({"workflow_runs": "nope"}, {}, "nope"):
            with self.subTest(response=response):
                with patch.object(watchdog, "api", return_value=response):
                    with self.assertRaises(ValueError):
                        watchdog.last_run_time(watchdog.MODEL_TARGETS[0])


class SelectModelTargetTests(unittest.TestCase):
    def test_picks_the_target_run_less_recently(self):
        author, acceptor = watchdog.MODEL_TARGETS
        with patch.object(watchdog, "last_run_time", side_effect=lambda target: (
                NOW - timedelta(hours=1) if target == author else NOW - timedelta(hours=3))):
            self.assertEqual(watchdog.select_model_target([author, acceptor]), acceptor)

    def test_never_run_sorts_oldest(self):
        author, acceptor = watchdog.MODEL_TARGETS
        with patch.object(watchdog, "last_run_time", side_effect=lambda target: (
                None if target == acceptor else NOW)):
            self.assertEqual(watchdog.select_model_target([author, acceptor]), acceptor)

    def test_genuine_tie_breaks_by_declared_order(self):
        author, acceptor = watchdog.MODEL_TARGETS
        for shared in (None, NOW):
            with self.subTest(shared=shared):
                with patch.object(watchdog, "last_run_time", return_value=shared):
                    self.assertEqual(watchdog.select_model_target([acceptor, author]), author)


class AlternationDispatchTests(unittest.TestCase):
    """At most one model target dispatches per pass; spec-sync is unaffected."""

    def setUp(self):
        self.enabled = patch.object(watchdog, "is_enabled", return_value=True)
        self.enabled.start()
        self.addCleanup(self.enabled.stop)

    def decide(self, decisions):
        return lambda target, now, interval=None: {"workflow": target, "decision": decisions[target]}

    def test_both_due_dispatches_only_the_target_run_less_recently(self):
        decisions = {"spec-sync.yml": "recent", "zendev-author.yml": "due", "zendev-acceptor.yml": "due"}
        with patch.object(watchdog, "inspect_target", side_effect=self.decide(decisions)), \
                patch.object(watchdog, "select_model_target",
                              return_value="zendev-acceptor.yml") as select, \
                patch.object(watchdog, "api") as api:
            results = watchdog.run(dispatch=True, now=NOW)
        select.assert_called_once_with(["zendev-author.yml", "zendev-acceptor.yml"])
        self.assertEqual(api.call_count, 1)
        self.assertEqual(api.call_args.args[0],
                          f"repos/{watchdog.REPOSITORY}/actions/workflows/zendev-acceptor.yml/dispatches")
        by_workflow = {r.get("workflow"): r["decision"] for r in results}
        self.assertEqual(by_workflow["zendev-acceptor.yml"], "dispatched")
        self.assertEqual(by_workflow["zendev-author.yml"], "deferred")

    def test_one_due_dispatches_without_consulting_alternation(self):
        decisions = {"spec-sync.yml": "recent", "zendev-author.yml": "due", "zendev-acceptor.yml": "active"}
        with patch.object(watchdog, "inspect_target", side_effect=self.decide(decisions)), \
                patch.object(watchdog, "select_model_target") as select, \
                patch.object(watchdog, "api") as api:
            results = watchdog.run(dispatch=True, now=NOW)
        select.assert_not_called()
        self.assertEqual(api.call_count, 1)
        by_workflow = {r.get("workflow"): r["decision"] for r in results}
        self.assertEqual(by_workflow["zendev-author.yml"], "dispatched")
        self.assertEqual(by_workflow["zendev-acceptor.yml"], "active")

    def test_neither_due_dispatches_nothing(self):
        decisions = {"spec-sync.yml": "recent", "zendev-author.yml": "recent", "zendev-acceptor.yml": "active"}
        with patch.object(watchdog, "inspect_target", side_effect=self.decide(decisions)), \
                patch.object(watchdog, "select_model_target") as select, \
                patch.object(watchdog, "api") as api:
            watchdog.run(dispatch=True, now=NOW)
        select.assert_not_called()
        api.assert_not_called()

    def test_one_active_is_left_untouched_by_alternation(self):
        decisions = {"spec-sync.yml": "due", "zendev-author.yml": "active", "zendev-acceptor.yml": "due"}
        with patch.object(watchdog, "inspect_target", side_effect=self.decide(decisions)), \
                patch.object(watchdog, "select_model_target") as select, \
                patch.object(watchdog, "api") as api:
            results = watchdog.run(dispatch=True, now=NOW)
        select.assert_not_called()
        by_workflow = {r.get("workflow"): r["decision"] for r in results}
        self.assertEqual(by_workflow["zendev-acceptor.yml"], "dispatched")
        self.assertEqual(by_workflow["zendev-author.yml"], "active")

    def test_dry_run_never_consults_alternation_or_the_network(self):
        decisions = {"spec-sync.yml": "recent", "zendev-author.yml": "due", "zendev-acceptor.yml": "due"}
        with patch.object(watchdog, "inspect_target", side_effect=self.decide(decisions)), \
                patch.object(watchdog, "select_model_target") as select, \
                patch.object(watchdog, "api") as api:
            results = watchdog.run(now=NOW)
        select.assert_not_called()
        api.assert_not_called()
        by_workflow = {r.get("workflow"): r["decision"] for r in results}
        self.assertEqual(by_workflow["zendev-author.yml"], "due")
        self.assertEqual(by_workflow["zendev-acceptor.yml"], "due")

    def test_consecutive_passes_alternate_on_a_genuine_tie(self):
        """The rate stays the same, spread across two half-length passes instead of
        one -- proving the half-interval equivalence the Issue's trade-off table
        claims, without needing to fabricate a full wall-clock simulation."""
        decisions = {"spec-sync.yml": "recent", "zendev-author.yml": "due", "zendev-acceptor.yml": "due"}
        with patch.object(watchdog, "inspect_target", side_effect=self.decide(decisions)), \
                patch.object(watchdog, "last_run_time", return_value=None), \
                patch.object(watchdog, "api"):
            first = watchdog.run(dispatch=True, now=NOW)
        first_by = {r.get("workflow"): r["decision"] for r in first}
        self.assertEqual(first_by["zendev-author.yml"], "dispatched")
        self.assertEqual(first_by["zendev-acceptor.yml"], "deferred")

        # After the author's dispatch its last run is the most recent: the tie
        # breaks the other way, and the acceptor dispatches on the next pass.
        with patch.object(watchdog, "inspect_target", side_effect=self.decide(decisions)), \
                patch.object(watchdog, "last_run_time", side_effect=lambda target: (
                        NOW if target == "zendev-author.yml" else None)), \
                patch.object(watchdog, "api"):
            second = watchdog.run(dispatch=True, now=NOW)
        second_by = {r.get("workflow"): r["decision"] for r in second}
        self.assertEqual(second_by["zendev-acceptor.yml"], "dispatched")
        self.assertEqual(second_by["zendev-author.yml"], "deferred")


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
