"""A reading that cannot be taken must say so, and a reading that can must say only
what the ledger asked for."""

import json
import pathlib
import sys
import unittest
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import subscription_usage as usage  # noqa: E402

PAYLOAD = {
    "five_hour": {"utilization": 12.5, "resets_at": "2026-09-05T18:00:00Z"},
    "seven_day": {"utilization": 41, "resets_at": "2026-09-08T04:50:00Z"},
    "seven_day_opus": None,
    "seven_day_sonnet": {"utilization": 3, "resets_at": "2026-09-08T04:50:00Z"},
    "extra_usage": {"is_enabled": False, "monthly_limit": None, "used_credits": None},
}


class SummarizeTests(unittest.TestCase):
    def test_only_the_two_fields_per_window_survive(self):
        windows = usage.summarize(PAYLOAD)
        self.assertEqual(set(windows), set(usage.WINDOWS))
        self.assertEqual(
            windows["five_hour"],
            {"utilization": 12.5, "resets_at": "2026-09-05T18:00:00Z"},
        )
        self.assertNotIn("extra_usage", windows)

    def test_an_absent_window_is_null_not_zero(self):
        self.assertIsNone(usage.summarize(PAYLOAD)["seven_day_opus"])

    def test_a_non_numeric_utilization_is_dropped(self):
        payload = {"five_hour": {"utilization": "12", "resets_at": 5}}
        self.assertEqual(
            usage.summarize(payload)["five_hour"], {"utilization": None, "resets_at": None}
        )

    def test_a_boolean_is_not_a_percentage(self):
        payload = {"five_hour": {"utilization": True, "resets_at": "x"}}
        self.assertIsNone(usage.summarize(payload)["five_hour"]["utilization"])

    def test_a_payload_that_is_not_an_object_yields_all_nulls(self):
        self.assertTrue(all(v is None for v in usage.summarize(["nope"]).values()))


class ReadTests(unittest.TestCase):
    def test_no_token_is_unavailable_with_a_reason(self):
        reading = usage.read("", fetcher=lambda token: PAYLOAD)
        self.assertFalse(reading["available"])
        self.assertIn("no token", reading["reason"])
        self.assertIsNone(reading["five_hour"])

    def test_a_rate_limit_is_recorded_by_status_code_only(self):
        def refuse(token):
            raise urllib.error.HTTPError("u", 429, "Too Many Requests", {}, None)

        reading = usage.read("t", fetcher=refuse)
        self.assertFalse(reading["available"])
        self.assertEqual(reading["reason"], "HTTP 429")

    def test_a_network_failure_is_recorded_by_class(self):
        def drop(token):
            raise urllib.error.URLError("unreachable")

        reading = usage.read("t", fetcher=drop)
        self.assertFalse(reading["available"])
        self.assertEqual(reading["reason"], "URLError")

    def test_a_timeout_is_recorded_by_class(self):
        def hang(token):
            raise TimeoutError()

        self.assertEqual(usage.read("t", fetcher=hang)["reason"], "TimeoutError")

    def test_a_malformed_body_is_unavailable(self):
        def garbage(token):
            raise json.JSONDecodeError("bad", "", 0)

        self.assertEqual(usage.read("t", fetcher=garbage)["reason"], "malformed body")
        self.assertEqual(usage.read("t", fetcher=lambda t: [1, 2])["reason"], "malformed body")

    def test_a_successful_reading_is_available_and_summarized(self):
        reading = usage.read("t", fetcher=lambda token: PAYLOAD)
        self.assertTrue(reading["available"])
        self.assertIsNone(reading["reason"])
        self.assertEqual(reading["seven_day"]["utilization"], 41)
        self.assertNotIn("extra_usage", reading)

    def test_the_fetcher_receives_the_token_and_nothing_is_printed_from_it(self):
        seen = {}

        def capture(token):
            seen["token"] = token
            return PAYLOAD

        reading = usage.read("secret-token", fetcher=capture)
        self.assertEqual(seen["token"], "secret-token")
        self.assertNotIn("secret-token", json.dumps(reading))


class HeaderTests(unittest.TestCase):
    def test_the_two_headers_the_endpoint_requires_are_declared(self):
        # Losing either one turns every reading into "HTTP 429" or "HTTP 401", which the
        # ledger would faithfully record as a gap forever. Pin them.
        self.assertEqual(usage.BETA_HEADER, "oauth-2025-04-20")
        self.assertTrue(usage.USER_AGENT.startswith("claude-code/"))


if __name__ == "__main__":
    unittest.main()
