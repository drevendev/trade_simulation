"""The ledger is only useful if a gap in it is visible as a gap."""

import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import record_usage as rec  # noqa: E402


class ExtractionTests(unittest.TestCase):
    def test_result_message_wins(self):
        messages = [
            {"type": "assistant", "usage": {"input_tokens": 5, "output_tokens": 1}},
            {
                "type": "result",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_read_input_tokens": 900,
                    "cache_creation_input_tokens": 50,
                },
                "total_cost_usd": 0.42,
                "duration_ms": 12345,
                "num_turns": 7,
                "session_id": "abc",
            },
        ]
        tokens, extra, source = rec.extract_usage(messages)
        self.assertEqual(source, "result")
        self.assertEqual(tokens["input_tokens"], 100)
        self.assertEqual(tokens["cache_read_input_tokens"], 900)
        self.assertEqual(extra["total_cost_usd"], 0.42)
        self.assertEqual(extra["num_turns"], 7)

    def test_assistant_messages_are_summed_without_a_result(self):
        messages = [
            {"type": "assistant", "usage": {"input_tokens": 5, "output_tokens": 1}},
            {"type": "assistant", "message": {"usage": {"input_tokens": 7, "output_tokens": 2}}},
        ]
        tokens, extra, source = rec.extract_usage(messages)
        self.assertEqual(source, "summed")
        self.assertEqual(tokens["input_tokens"], 12)
        self.assertEqual(tokens["output_tokens"], 3)
        self.assertEqual(extra, {})

    def test_no_usage_anywhere_is_unavailable_not_zero(self):
        tokens, _, source = rec.extract_usage([{"type": "system"}, {"type": "assistant"}])
        self.assertEqual(source, "unavailable")
        for field in rec.TOKEN_FIELDS:
            self.assertIsNone(tokens[field], f"{field} must be null, not 0")


class ReadMessagesTests(unittest.TestCase):
    def test_missing_path_is_reported_not_raised(self):
        messages, problem = rec.read_messages("")
        self.assertIsNone(messages)
        self.assertIn("no execution file", problem)

    def test_absent_file_is_reported_not_raised(self):
        messages, problem = rec.read_messages("does-not-exist.json")
        self.assertIsNone(messages)
        self.assertIn("does not exist", problem)

    def test_malformed_file_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "broken.json"
            path.write_text("{not json", encoding="utf-8")
            messages, problem = rec.read_messages(str(path))
        self.assertIsNone(messages)
        self.assertIn("could not be parsed", problem)

    def test_valid_file_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ok.json"
            path.write_text(json.dumps([{"type": "result"}]), encoding="utf-8")
            messages, problem = rec.read_messages(str(path))
        self.assertIsNone(problem)
        self.assertEqual(len(messages), 1)


if __name__ == "__main__":
    unittest.main()
