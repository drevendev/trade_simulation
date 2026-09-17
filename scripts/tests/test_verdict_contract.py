"""One verdict owner and one evidence channel, in every document that names them (#544).

`AGENTS.md` is the operative contract; `docs/zendev/ENDLESSZEN_AUTHOR.md` is the guide
an author outside the loop works to; the active entry of `docs/zendev/schemes.json` is
what the dispatcher and the ledgers read. scheme/8 made SLOPSTER the verdict owner, and
the guide then told it to submit a formal review — which the contract forbids that
account, for the reason #208 and #211 record: a formal refusal from an account without
write access holds the merge until someone with authority clears it. Two documents, two
answers, and a clean pull request with no compliant way to be accepted.

The three now say one thing, and these assertions are what keeps a later policy edit
from quietly making them disagree again. Text assertions, like the other contract
tests: standard library only, and a pattern that stops matching fails loudly because
every negative check here is paired with a positive one on the same document.
"""

import json
import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import record_pull_request as rpr  # noqa: E402
import schemes  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
AGENTS = ROOT / "AGENTS.md"
GUIDE = ROOT / "docs" / "zendev" / "ENDLESSZEN_AUTHOR.md"
SCHEMES = ROOT / "docs" / "zendev" / "schemes.json"

QA_LOGIN = "andy-zen-dev"
ACCEPT = "## Verdict: ACCEPT"
REFUSE = "## Verdict: REQUEST_CHANGES"
FINDING = "## SLOPSTER QA: FINDING"
# The instruction #544 reported, in any of the spellings it could come back in.
ASKS_FOR_A_FORMAL_REVIEW = re.compile(
    r"formal review\s*[—:-]\s*\*?Approve|\*?Approve\*?\s+or\s+\*?Request changes", re.IGNORECASE
)


def flat(path):
    """The document as one line of single-spaced text, so a sentence wrapped at 88
    columns still matches as a sentence."""
    return re.sub(r"\s+", " ", path.read_text(encoding="utf-8"))


def active_scheme():
    return schemes.active(json.loads(SCHEMES.read_text(encoding="utf-8")))


class OneOwnerTests(unittest.TestCase):
    def test_the_contract_derives_the_verdict_owner_from_the_active_scheme(self):
        text = flat(AGENTS)
        self.assertIn("The verdict owner is named by the active scheme", text)
        self.assertIn("`verdict_owner`", text)
        self.assertNotIn("Only the ACCEPTOR identity's verdict is a verdict", text,
                         "an unconditional ACCEPTOR-only rule contradicts a scheme that runs none")

    def test_the_contract_names_the_owner_the_active_scheme_declares(self):
        owner = active_scheme()["verdict_owner"]
        self.assertTrue(owner)
        self.assertIn(f"`{owner}`", flat(AGENTS),
                      "AGENTS.md must name the login the active scheme makes the verdict owner")

    def test_the_qa_login_is_spelled_as_the_account_is(self):
        self.assertIn(f"**SLOPSTER** (`{QA_LOGIN}`)", flat(AGENTS))
        self.assertNotIn("`AndyDev`", flat(AGENTS))

    def test_authority_comes_from_the_descriptor_not_from_capability(self):
        self.assertIn("never from what an account is technically able to do", flat(AGENTS))


class OneChannelTests(unittest.TestCase):
    def test_neither_document_asks_slopster_for_a_formal_review(self):
        for path in (AGENTS, GUIDE):
            with self.subTest(document=path.name):
                text = flat(path)
                self.assertIsNone(ASKS_FOR_A_FORMAL_REVIEW.search(text))
                self.assertRegex(text, r"never posts a formal review",
                                 "the prohibition must be stated, not merely absent")

    def test_both_documents_name_the_same_verdict_and_finding_forms(self):
        for path in (AGENTS, GUIDE):
            with self.subTest(document=path.name):
                text = flat(path)
                for form in (ACCEPT, REFUSE, FINDING.replace("QA: FINDING", "QA:")):
                    self.assertIn(form, text)

    def test_a_clean_head_has_a_documented_path_to_the_operator_s_merge(self):
        for path in (AGENTS, GUIDE):
            with self.subTest(document=path.name):
                text = flat(path)
                self.assertRegex(text, r"[Cc]lean head")
                self.assertIn("four", text)
                self.assertRegex(text, r"operator (?:merges|needs)")

    def test_the_active_scheme_describes_the_same_channel(self):
        scheme = active_scheme()
        self.assertEqual(scheme["verdict_owner"], QA_LOGIN)
        note = scheme.get("note", "")
        self.assertNotIn("formal reviews as the verdicts", note)
        self.assertIn("## Verdict:", note)

    def test_the_ledger_reads_the_documented_form_as_a_verdict_of_that_owner(self):
        owner = active_scheme()["verdict_owner"]
        comments = [
            {"user": {"login": owner}, "created_at": "2026-09-16T19:01:00Z",
             "body": f"{REFUSE}\n\nHead `8dea670`"},
            {"user": {"login": owner}, "created_at": "2026-09-16T19:19:00Z",
             "body": f"{ACCEPT}\n\nHead `ec14fa1`"},
            {"user": {"login": owner}, "created_at": "2026-09-16T17:58:00Z",
             "body": f"{FINDING}\n\nHead `8dea670`"},
        ]
        found = rpr.verdicts([], comments, owner)
        self.assertEqual([v["state"] for v in found], ["CHANGES_REQUESTED", "APPROVED"])
        self.assertTrue(all(v["source"] == "comment" for v in found))


if __name__ == "__main__":
    unittest.main()
