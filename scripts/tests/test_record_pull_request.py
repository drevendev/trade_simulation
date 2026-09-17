"""One ledger record per closed pull request, from facts GitHub holds, by `master` only."""

import datetime as dt
import json
import pathlib
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import machine_pr_guard  # noqa: E402
import record_pull_request as rpr  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "pr-ledger.yml"

NOW = dt.datetime(2026, 9, 16, 12, 0, tzinfo=dt.timezone.utc)
SCHEME = {"id": "scheme/7", "digest": "abc123def456"}
OWNER = "zendev-acceptor"


def at(minutes):
    return (dt.datetime(2026, 9, 16, 9, 0, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def pull(**fields):
    base = {
        "number": 600, "title": "REQ-CONFIG-006: the M4 configuration surface",
        "body": "Closes #527\n\nAlso touches REQ-CONFIG-005.\n\n## Changed artifacts\n- `src/x.ts`",
        "user": {"login": "drevendev", "type": "User"},
        "head": {"ref": "zen/issue-527-config"}, "base": {"ref": "master"},
        "draft": False, "created_at": at(0), "closed_at": at(90), "merged_at": at(90),
        "merge_commit_sha": "feedface", "additions": 120, "deletions": 8,
        "changed_files": 4, "commits": 3,
    }
    base.update(fields)
    return base


def review(login, state, minutes):
    return {"user": {"login": login}, "state": state, "submitted_at": at(minutes)}


def comment(login, body, minutes):
    return {"user": {"login": login}, "body": body, "created_at": at(minutes)}


class VerdictTests(unittest.TestCase):
    def test_a_formal_refusal_then_an_accepting_comment_are_two_verdicts_in_order(self):
        found = rpr.verdicts(
            [review("zendev-acceptor[bot]", "CHANGES_REQUESTED", 30)],
            [comment("app/zendev-acceptor", "## Verdict: ACCEPT\n\nJudging head `abc`.", 75)],
            OWNER,
        )
        self.assertEqual([(v["state"], v["source"]) for v in found],
                         [("CHANGES_REQUESTED", "review"), ("APPROVED", "comment")])

    def test_the_same_verdict_as_review_and_as_comment_counts_once(self):
        found = rpr.verdicts(
            [review("zendev-acceptor", "CHANGES_REQUESTED", 30)],
            [comment("zendev-acceptor", "## ACCEPTOR Verdict: REQUEST_CHANGES — head `abc`", 31)],
            OWNER,
        )
        self.assertEqual(len(found), 1)

    def test_two_refusals_far_apart_are_two_rounds(self):
        found = rpr.verdicts(
            [review("zendev-acceptor", "CHANGES_REQUESTED", 30), review("zendev-acceptor", "CHANGES_REQUESTED", 80)],
            [], OWNER,
        )
        self.assertEqual(len(found), 2)

    def test_only_the_verdict_owner_judges(self):
        found = rpr.verdicts(
            [review("drevendev", "CHANGES_REQUESTED", 20), review("andy-zen-dev", "APPROVED", 25)],
            [comment("andy-zen-dev", "## Verdict: ACCEPT", 26), comment("zendev-acceptor", "## Verdict: ACCEPT", 40)],
            OWNER,
        )
        self.assertEqual([(v["state"], v["at"]) for v in found], [("APPROVED", at(40))])

    def test_a_comment_that_only_mentions_a_verdict_is_not_one(self):
        found = rpr.verdicts([], [comment("zendev-acceptor", "The earlier ## Verdict: ACCEPT was wrong.", 5)], OWNER)
        self.assertEqual(found, [])

    def test_bare_review_comments_are_not_verdicts(self):
        found = rpr.verdicts([review("zendev-acceptor", "COMMENTED", 5)], [], OWNER)
        self.assertEqual(found, [])


class SummaryTests(unittest.TestCase):
    def summarize(self, p=None, reviews=(), comments=(), qa_login="andy-zen-dev"):
        return rpr.summarize(p or pull(), list(reviews), list(comments),
                             verdict_owner=OWNER, qa_login=qa_login, scheme=SCHEME, now=NOW,
                             run_url="https://example/run/1")

    def test_a_merged_pull_request_accepted_after_one_refusal(self):
        record = self.summarize(
            reviews=[review("zendev-acceptor", "CHANGES_REQUESTED", 30)],
            comments=[comment("drevendev", "Fixed.", 50), comment("zendev-acceptor", "## Verdict: ACCEPT", 80)],
        )
        self.assertTrue(record["merged"])
        self.assertIsNone(record["closed_reason"])
        self.assertEqual(record["refusals"], 1)
        self.assertFalse(record["accepted_first_time"])
        self.assertEqual(record["first_verdict_at"], at(30))
        self.assertEqual(record["minutes_to_first_verdict"], 30.0)
        self.assertEqual(record["minutes_open"], 90.0)
        self.assertEqual(record["author_comments"], 1)
        self.assertEqual(record["merge_commit"], "feedface")
        self.assertEqual(record["scheme"], SCHEME)
        self.assertEqual(record["kind"], "pull_request")
        self.assertEqual(record["recorded_at"], NOW.isoformat(timespec="seconds"))

    def test_accepted_on_the_first_verdict(self):
        record = self.summarize(comments=[comment("zendev-acceptor", "## Verdict: ACCEPT", 20)])
        self.assertEqual(record["refusals"], 0)
        self.assertTrue(record["accepted_first_time"])

    def test_never_judged_has_no_first_verdict(self):
        record = self.summarize()
        self.assertIsNone(record["accepted_first_time"])
        self.assertIsNone(record["first_verdict_at"])
        self.assertIsNone(record["minutes_to_first_verdict"])
        self.assertEqual(record["verdicts"], [])

    def test_issues_and_requirements_come_from_the_body_and_the_title(self):
        record = self.summarize()
        self.assertEqual(record["issues"], [527])
        self.assertEqual(record["requirements"], ["REQ-CONFIG-005", "REQ-CONFIG-006"])

    def test_the_author_and_its_kind(self):
        human = self.summarize()
        self.assertEqual((human["author"], human["author_kind"]), ("drevendev", "user"))
        app = self.summarize(pull(user={"login": "zendev-author[bot]", "type": "Bot"}))
        self.assertEqual((app["author"], app["author_kind"]), ("zendev-author[bot]", "app"))

    def test_a_machine_pull_request_is_marked_by_its_class(self):
        branch = machine_pr_guard.MACHINE_CLASSES[0].branch
        record = self.summarize(pull(head={"ref": branch}, user={"login": "zendev-machine[bot]", "type": "Bot"}))
        self.assertEqual(record["machine_class"], branch)
        self.assertIsNone(self.summarize()["machine_class"])

    def test_closed_at_the_rework_bound(self):
        p = pull(merged_at=None, merge_commit_sha=None, closed_at=at(200))
        record = self.summarize(p, reviews=[review("zendev-acceptor", "CHANGES_REQUESTED", m) for m in (30, 90, 150)],
                                comments=[comment("zendev-acceptor", "## Rework bound reached: 3 refusals on one pull request\n\nClosed by the forge", 200)])
        self.assertFalse(record["merged"])
        self.assertIsNone(record["merge_commit"])
        self.assertEqual(record["closed_reason"], "rework_bound")
        self.assertEqual(record["refusals"], 3)
        self.assertEqual(record["minutes_open"], 200.0)

    def test_closed_as_unreachable_and_closed_by_hand(self):
        p = pull(merged_at=None, merge_commit_sha=None, closed_at=at(2000))
        forge = self.summarize(p, comments=[comment("zendev-acceptor", "## Closed as unreachable\n\nClosed by the forge, not by a reviewer.", 2000)])
        self.assertEqual(forge["closed_reason"], "unreachable")
        self.assertEqual(self.summarize(p)["closed_reason"], "other")

    def test_qa_findings_count_the_qa_login_only(self):
        record = self.summarize(comments=[
            comment("andy-zen-dev", "## SLOPSTER QA: FINDING\n\nHead abc", 10),
            comment("andy-zen-dev", "## SLOPSTER QA: FINDING\n\nHead def", 40),
            comment("andy-zen-dev", "Looks fine.", 41),
            comment("drevendev", "## SLOPSTER QA: FINDING (quoted)", 42),
        ])
        self.assertEqual(record["qa_findings"], 2)
        self.assertEqual(self.summarize(comments=[comment("andy-zen-dev", "## SLOPSTER QA: FINDING", 10)], qa_login="")["qa_findings"], 0)


class PathAndSelectionTests(unittest.TestCase):
    def test_the_record_path_is_the_closing_time_and_the_number(self):
        record = rpr.summarize(pull(), [], [], verdict_owner=OWNER, qa_login="", scheme=SCHEME, now=NOW)
        self.assertEqual(rpr.record_path(record), "pulls/2026/09/20260916T103000Z-600.json")

    def test_a_backfill_and_a_live_record_name_one_path(self):
        live = rpr.summarize(pull(), [], [], verdict_owner=OWNER, qa_login="", scheme=SCHEME, now=NOW)
        later = rpr.summarize(pull(), [], [], verdict_owner=OWNER, qa_login="", scheme=SCHEME,
                              now=NOW + dt.timedelta(days=3))
        self.assertEqual(rpr.record_path(live), rpr.record_path(later))

    def test_closed_since_keeps_closed_pull_requests_at_or_after_the_threshold_in_closing_order(self):
        pulls = [pull(number=1, closed_at=at(500)), pull(number=2, closed_at=None, merged_at=None),
                 pull(number=3, closed_at=at(100)), pull(number=4, closed_at=at(300))]
        chosen = rpr.closed_since(pulls, at(300))
        self.assertEqual([p["number"] for p in chosen], [4, 1])

    def test_logins_are_one_identity_under_every_spelling(self):
        for spelling in ("app/zendev-acceptor", "zendev-acceptor[bot]", "Zendev-Acceptor"):
            self.assertEqual(rpr.normalize_login(spelling), "zendev-acceptor")


class SchemeAtTests(unittest.TestCase):
    """A backfilled pull request is stamped with the scheme it closed under, not today's."""

    DOCUMENT = {"active": "scheme/3", "schemes": [
        {"id": "scheme/1", "in_force_from": at(0), "roles": {"author": {"model": "a"}}, "verdict_owner": "x"},
        {"id": "scheme/2", "in_force_from": at(100), "roles": {"author": {"model": "b"}}, "verdict_owner": "x"},
        {"id": "scheme/3", "in_force_from": None, "roles": {"author": {"model": None}}, "verdict_owner": "x"},
    ]}

    def test_the_latest_scheme_in_force_at_the_closing_time_is_chosen(self):
        self.assertEqual(rpr.scheme_at(self.DOCUMENT, at(50))["id"], "scheme/1")
        self.assertEqual(rpr.scheme_at(self.DOCUMENT, at(100))["id"], "scheme/2")
        self.assertEqual(rpr.scheme_at(self.DOCUMENT, at(5000))["id"], "scheme/2")

    def test_before_the_first_scheme_and_without_a_time_there_is_no_stamp(self):
        self.assertIsNone(rpr.scheme_at(self.DOCUMENT, at(-1)))
        self.assertIsNone(rpr.scheme_at(self.DOCUMENT, None))
        self.assertIsNone(rpr.scheme_at(None, at(50)))

    def test_a_scheme_not_yet_in_force_is_never_chosen_even_when_active(self):
        self.assertNotEqual(rpr.scheme_at(self.DOCUMENT, at(9999))["id"], "scheme/3")

    def test_the_stamp_carries_the_descriptor_digest(self):
        import schemes
        stamp = rpr.scheme_at(self.DOCUMENT, at(100))
        self.assertEqual(stamp["digest"], schemes.digest(self.DOCUMENT["schemes"][1]))

    def test_the_repositorys_own_descriptor_places_the_day_of_scheme_6_under_scheme_6(self):
        import schemes
        document = schemes.load(ROOT / "docs" / "zendev" / "schemes.json")
        self.assertEqual(rpr.scheme_at(document, "2026-09-15T03:00:00Z")["id"], "scheme/6")


class BackfillOwnerTests(unittest.TestCase):
    """#545: the verdict owner comes from the scheme a pull request closed under.

    These go through `main()` on purpose. The defect was in `main()` — the pure
    functions were right and the owner was computed once, outside the loop — so a test
    of the pure functions alone would have passed over it.
    """

    DOCUMENT = {"active": "scheme/B", "schemes": [
        {"id": "scheme/A", "in_force_from": at(0), "verdict_owner": "zendev-acceptor",
         "roles": {"acceptor": {"model": "claude-x"}}},
        {"id": "scheme/B", "in_force_from": at(1000), "verdict_owner": "andy-zen-dev",
         "roles": {"acceptor": {"model": None}}},
    ]}

    def run_backfill(self, extra=()):
        old = pull(number=1, created_at=at(10), closed_at=at(100), merged_at=at(100))
        new = pull(number=2, created_at=at(1010), closed_at=at(1100), merged_at=at(1100))
        comments = {
            1: [comment("zendev-acceptor", "## Verdict: REQUEST_CHANGES", 40),
                comment("zendev-acceptor", "## Verdict: ACCEPT", 90),
                comment("andy-zen-dev", "## Verdict: REQUEST_CHANGES", 95)],
            2: [comment("zendev-acceptor", "## Verdict: REQUEST_CHANGES", 1020),
                comment("andy-zen-dev", "## Verdict: ACCEPT", 1090)],
        }
        by_number = {1: old, 2: new}
        with tempfile.TemporaryDirectory() as out, \
                patch.object(rpr.schemes, "load", return_value=self.DOCUMENT), \
                patch.object(rpr, "read_closed", return_value=[old, new]), \
                patch.object(rpr, "read_pull", side_effect=lambda repo, n: by_number[n]), \
                patch.object(rpr, "read_reviews", return_value=[]), \
                patch.object(rpr, "read_comments", side_effect=lambda repo, n: comments[n]):
            code = rpr.main(["--repo", "o/r", "--closed-since", at(0), "--out-dir", out, *extra])
            self.assertEqual(code, 0)
            records = {}
            for path in pathlib.Path(out).rglob("*.json"):
                record = json.loads(path.read_text(encoding="utf-8"))
                records[record["number"]] = record
        return records

    def test_each_record_takes_its_owner_and_its_stamp_from_one_descriptor(self):
        records = self.run_backfill()
        self.assertEqual((records[1]["scheme"]["id"], records[1]["verdict_owner"]),
                         ("scheme/A", "zendev-acceptor"))
        self.assertEqual((records[2]["scheme"]["id"], records[2]["verdict_owner"]),
                         ("scheme/B", "andy-zen-dev"))

    def test_a_historical_pull_request_keeps_its_historical_verdicts(self):
        old = self.run_backfill()[1]
        self.assertEqual([v["state"] for v in old["verdicts"]], ["CHANGES_REQUESTED", "APPROVED"])
        self.assertEqual(old["refusals"], 1)
        self.assertFalse(old["accepted_first_time"])
        self.assertEqual(old["first_verdict_at"], at(40))

    def test_the_current_scheme_ignores_verdict_shaped_content_from_anyone_else(self):
        new = self.run_backfill()[2]
        self.assertEqual([v["state"] for v in new["verdicts"]], ["APPROVED"])
        self.assertEqual(new["refusals"], 0)
        self.assertTrue(new["accepted_first_time"])

    def test_an_explicit_owner_overrides_every_scheme(self):
        records = self.run_backfill(["--verdict-owner", "andy-zen-dev"])
        self.assertEqual(records[1]["verdict_owner"], "andy-zen-dev")
        self.assertEqual([v["state"] for v in records[1]["verdicts"]], ["CHANGES_REQUESTED"])
        self.assertEqual(records[2]["verdict_owner"], "andy-zen-dev")

    def test_the_owner_falls_back_to_the_active_scheme_only_outside_every_scheme(self):
        active = self.DOCUMENT["schemes"][1]
        self.assertEqual(rpr.owner_for(self.DOCUMENT, at(-5), active=active), "andy-zen-dev")
        self.assertEqual(rpr.owner_for(self.DOCUMENT, at(50), active=active), "zendev-acceptor")
        self.assertEqual(rpr.owner_for(None, at(50)), "")


class WorkflowTests(unittest.TestCase):
    """The recorder runs from `master` only, reads only, and writes the ledger as the MACHINE."""

    def text(self):
        return WORKFLOW.read_text(encoding="utf-8")

    def triggers(self):
        block = re.search(r"^on:\n((?:(?:[ ]+\S.*)?\n)*)", self.text(), re.MULTILINE).group(1)
        return set(re.findall(r"^  ([\w]+):", block, re.MULTILINE))

    def test_pull_requests_arrive_as_pull_request_target_closed_and_nothing_else(self):
        self.assertEqual(self.triggers(), {"pull_request_target", "workflow_dispatch"})
        self.assertRegex(self.text(), r"pull_request_target:\n\s+types: \[closed\]")

    def test_the_checkout_never_takes_the_judged_head(self):
        body = self.text()
        self.assertNotIn("pull_request.head.", body)
        checkout = body[body.index("actions/checkout"):body.index("actions/setup-python")]
        self.assertNotRegex(checkout, r"^\s+ref:", "the base branch is the only revision that may run here")
        self.assertIn("persist-credentials: false", checkout)

    def test_the_token_reads_and_the_machine_writes_the_ledger_alone(self):
        body = self.text()
        block = re.search(r"^permissions:\n((?:  .*\n)*)", body, re.MULTILINE).group(1)
        grants = dict(re.findall(r"^  ([\w-]+):\s*(\w+)\s*$", block, re.MULTILINE))
        self.assertEqual(grants, {"contents": "read", "pull-requests": "read"})
        self.assertIn("uses: actions/create-github-app-token@v3", body)
        self.assertIn("vars.ZENDEV_MACHINE_APP_CLIENT_ID", body)
        self.assertIn("repositories: zen-telemetry", body)
        self.assertIn("TELEMETRY_TOKEN: ${{ steps.ledger.outputs.token }}", body)
        for other in ("ZENDEV_AUTHOR_APP", "ZENDEV_ACCEPTOR_APP", "claude-code-action", "ZENDEV_PAT"):
            self.assertNotIn(other, body)

    def test_the_recorder_is_invoked_for_the_event_s_own_pull_request(self):
        self.assertIn('--pull "${{ github.event.pull_request.number || inputs.number }}"', self.text())
        self.assertIn("scripts/record_pull_request.py", self.text())


if __name__ == "__main__":
    unittest.main()
