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


class ModelTests(unittest.TestCase):
    def test_model_from_the_result_message(self):
        self.assertEqual(
            rec.extract_model([{"type": "result", "model": "claude-haiku-4-5"}]),
            "claude-haiku-4-5",
        )

    def test_model_from_a_nested_assistant_message(self):
        self.assertEqual(
            rec.extract_model(
                [{"type": "assistant", "message": {"model": "claude-sonnet-5"}}]
            ),
            "claude-sonnet-5",
        )

    def test_the_last_model_wins(self):
        # Service sub-calls can name a different model; the run's own model is the
        # one that finished it.
        self.assertEqual(
            rec.extract_model(
                [
                    {"type": "assistant", "message": {"model": "claude-haiku-4-5"}},
                    {"type": "result", "model": "claude-sonnet-5"},
                ]
            ),
            "claude-sonnet-5",
        )

    def test_absent_model_is_null_not_guessed(self):
        # A guessed model in the ledger is worse than a gap: it would make a silent
        # default change look like a deliberate choice.
        self.assertIsNone(rec.extract_model([{"type": "result"}, {"type": "system"}]))


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


class TranscriptTests(unittest.TestCase):
    def test_result_text_and_assistant_text_blocks_are_joined(self):
        messages = [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "first"}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
            {"type": "result", "result": "done"},
        ]
        self.assertEqual(rec.transcript(messages), "first\ndone")

    def test_a_malformed_message_list_yields_an_empty_transcript(self):
        self.assertEqual(rec.transcript([None, "text", {"type": "result"}]), "")


class OutcomeTests(unittest.TestCase):
    def test_no_work_from_the_workflow_is_trusted(self):
        self.assertEqual(rec.classify_outcome("no_work", "anything"), ("no_work", "workflow"))

    def test_a_failed_action_is_failed_whatever_the_transcript_says(self):
        self.assertEqual(rec.classify_outcome("failure", "all good"), ("failed", "workflow"))

    def test_a_blocked_run_is_read_from_its_own_markers(self):
        for text in (
            "Set status:blocked and stopped.",
            "## AUTHOR blocker\n\nGate: token scope",
            "**Blocked on**: the mirror is missing",
        ):
            with self.subTest(text=text):
                self.assertEqual(rec.classify_outcome("success", text), ("blocked", "heuristic"))

    def test_prose_mentioning_blockers_is_not_a_blocked_run(self):
        # The claim comment every run posts says "Known blockers: none".
        text = "**AUTHOR claim**\n\nKnown blockers: none. Proceeding."
        self.assertEqual(rec.classify_outcome("success", text), ("completed", "heuristic"))

    def test_a_handoff_is_completed_whatever_else_it_mentions(self):
        # Run 33986212612 opened #163 and was recorded as blocked, because its text
        # also discussed Issue #138, which is blocked. The handoff decides.
        text = (
            "## AUTHOR handoff\n\nBranch: claude/issue-157-build-initial-world\n"
            "Pull request: #163\n\n## Blocked elsewhere\n\nIssue #138 remains status:blocked."
        )
        self.assertEqual(rec.classify_outcome("success", text), ("completed", "heuristic"))

    def test_a_verdict_is_completed_for_the_acceptor(self):
        for text in ("## ACCEPTOR verdict: REQUEST_CHANGES\n\nHead abc", "## ACCEPT\n\nAll six hold."):
            with self.subTest(text=text):
                self.assertEqual(rec.classify_outcome("success", text), ("completed", "heuristic"))

    def test_a_blocker_heading_without_a_handoff_is_still_blocked(self):
        text = "## AUTHOR blocker\n\nGate: the registry names no READY row. status:blocked set."
        self.assertEqual(rec.classify_outcome("success", text), ("blocked", "heuristic"))


class FinalTextTests(unittest.TestCase):
    def test_the_result_text_is_the_final_word(self):
        messages = [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Issue #138 is blocked, skipping it"}]}},
            {"type": "result", "result": "## AUTHOR handoff\n\nPull request: #163"},
        ]
        self.assertEqual(rec.final_text(messages), "## AUTHOR handoff\n\nPull request: #163")

    def test_without_a_result_the_last_assistant_text_stands_in(self):
        messages = [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "first"}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "last"}]}},
        ]
        self.assertEqual(rec.final_text(messages), "last")

    def test_nothing_said_is_an_empty_final_text(self):
        self.assertEqual(rec.final_text([{"type": "system"}, None]), "")
        self.assertEqual(rec.final_text(None), "")

    def test_a_run_that_found_nothing_is_no_work(self):
        text = "Evaluated items 1-5: no eligible item. Nothing to do."
        self.assertEqual(rec.classify_outcome("success", text), ("no_work", "heuristic"))

    def test_an_unknown_conclusion_with_no_markers_is_unknown(self):
        self.assertEqual(rec.classify_outcome("unknown", ""), ("unknown", "heuristic"))
        self.assertEqual(rec.classify_outcome("", ""), ("unknown", "heuristic"))

    def test_every_outcome_is_one_of_the_declared_values(self):
        for conclusion, text in (("success", ""), ("failure", ""), ("no_work", ""), ("", "x")):
            outcome, _ = rec.classify_outcome(conclusion, text)
            self.assertIn(outcome, rec.OUTCOMES)


class MentionTests(unittest.TestCase):
    def test_references_and_requirements_are_collected_once_each_and_sorted(self):
        text = "Closes #135. See #48 and #135; REQ-CONFIG-004 depends on REQ-CONFIG-003."
        self.assertEqual(
            rec.mentions(text),
            {"references": [48, 135], "requirements": ["REQ-CONFIG-003", "REQ-CONFIG-004"]},
        )

    def test_url_fragments_headings_and_colours_are_not_references(self):
        text = "https://x/pull/130#issuecomment-5 ## Heading #ffffff #123abc"
        self.assertEqual(rec.mentions(text)["references"], [])

    def test_empty_text_yields_empty_lists(self):
        self.assertEqual(rec.mentions(""), {"references": [], "requirements": []})


class ReworkTests(unittest.TestCase):
    def test_an_author_answering_a_refusal_is_rework(self):
        self.assertTrue(rec.is_rework("author", "Addressed REQUEST_CHANGES feedback"))
        self.assertTrue(rec.is_rework("author", "## Handoff\n\nchanges requested were fixed"))

    def test_an_author_implementing_fresh_work_is_not(self):
        self.assertFalse(rec.is_rework("author", "Implemented REQ-CONFIG-004 and opened #150"))

    def test_other_roles_are_null_not_false(self):
        self.assertIsNone(rec.is_rework("acceptor", "REQUEST_CHANGES"))


def reading(**windows):
    return {"available": True, "reason": None, **windows}


class SubscriptionBlockTests(unittest.TestCase):
    def test_the_delta_is_the_difference_per_gating_window(self):
        before = reading(five_hour={"utilization": 10.0}, seven_day={"utilization": 40})
        after = reading(five_hour={"utilization": 12.5}, seven_day={"utilization": 41})
        block = rec.subscription_block(before, after)
        self.assertEqual(block["delta"], {"five_hour": 2.5, "seven_day": 1})
        self.assertIs(block["before"], before)
        self.assertIs(block["after"], after)

    def test_a_missing_side_makes_the_delta_null_not_zero(self):
        after = reading(five_hour={"utilization": 12.5}, seven_day={"utilization": 41})
        block = rec.subscription_block(None, after)
        self.assertEqual(block["delta"], {"five_hour": None, "seven_day": None})
        self.assertIsNone(block["before"])

    def test_an_unavailable_reading_counts_as_missing(self):
        before = reading(five_hour={"utilization": 10.0}, seven_day={"utilization": 40})
        after = {"available": False, "reason": "HTTP 429", "five_hour": None, "seven_day": None}
        self.assertEqual(
            rec.subscription_block(before, after)["delta"],
            {"five_hour": None, "seven_day": None},
        )

    def test_one_null_window_does_not_poison_the_other(self):
        before = reading(five_hour={"utilization": 10.0}, seven_day=None)
        after = reading(five_hour={"utilization": 11.0}, seven_day={"utilization": 41})
        self.assertEqual(
            rec.subscription_block(before, after)["delta"], {"five_hour": 1.0, "seven_day": None}
        )


class PublicViewTests(unittest.TestCase):
    def test_the_public_log_never_carries_the_subscription_block(self):
        record = {"role": "author", "subscription": {"delta": {"five_hour": 2}}, "num_turns": 3}
        public = rec.public_view(record)
        self.assertNotIn("subscription", public)
        self.assertEqual(public["num_turns"], 3)
        # And the original is untouched: the ledger gets everything.
        self.assertIn("subscription", record)


class LoadReadingTests(unittest.TestCase):
    def test_missing_or_malformed_files_are_none(self):
        self.assertIsNone(rec.load_reading(""))
        self.assertIsNone(rec.load_reading("no-such-file.json"))
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "bad.json"
            path.write_text("[1]", encoding="utf-8")
            self.assertIsNone(rec.load_reading(str(path)))

    def test_a_reading_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "ok.json"
            path.write_text(json.dumps({"available": False, "reason": "HTTP 429"}), encoding="utf-8")
            self.assertEqual(rec.load_reading(str(path))["reason"], "HTTP 429")


if __name__ == "__main__":
    unittest.main()
