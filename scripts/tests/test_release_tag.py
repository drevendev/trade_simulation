"""What may be released, and what the milestone map must keep true.

The last test is the important one: it is the only thing standing between a
requirement the researcher adds and a milestone gate that silently never covers it.
"""

import csv
import io
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import release_tag  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
MILESTONES = ROOT / "docs" / "zendev" / "milestones.json"
REGISTRY = ROOT / "docs" / "spec" / "mirror" / "REQUIREMENTS_REGISTRY.csv"
STATUS = ROOT / "docs" / "spec" / "implementation_status.csv"

MAP = {"M0": ["REQ-A", "REQ-B"], "M1": ["REQ-C"]}


def row(req_id, status="IMPLEMENTED", commit="abc123", issue="1", pull="2"):
    return {"REQ_ID": req_id, "STATUS": status, "ISSUE": issue, "PR": pull,
            "MERGE_COMMIT": commit, "EVIDENCE": ""}


class CompletenessTests(unittest.TestCase):
    def test_all_implemented_is_complete(self):
        self.assertTrue(release_tag.complete([row("REQ-A"), row("REQ-B")], MAP["M0"]))

    def test_one_partial_row_is_not_complete(self):
        # REQ-CONFIG-003 and REQ-CONFIG-004 sat at PARTIAL for a day after post-merge
        # QA. A milestone containing them is not released.
        rows = [row("REQ-A"), row("REQ-B", status="PARTIAL")]
        self.assertFalse(release_tag.complete(rows, MAP["M0"]))

    def test_a_missing_row_is_not_complete(self):
        # The ledger gains a row when work lands, so absent and not-done are the same
        # fact. Treating absence as success would release unstarted work.
        self.assertFalse(release_tag.complete([row("REQ-A")], MAP["M0"]))

    def test_status_is_read_case_and_space_insensitively(self):
        rows = [row("REQ-A", status=" implemented "), row("REQ-B")]
        self.assertTrue(release_tag.complete(rows, MAP["M0"]))


class PlanTests(unittest.TestCase):
    def test_a_newly_complete_milestone_is_tagged_from_zero(self):
        got = release_tag.plan([row("REQ-A"), row("REQ-B")], {"M0": MAP["M0"]}, {})
        self.assertEqual([entry["tag"] for entry in got], ["v0.0.0"])

    def test_an_unchanged_milestone_is_not_re_tagged(self):
        # The job runs on every push to master. Same coverage, same digest, no tag.
        rows = [row("REQ-A"), row("REQ-B")]
        digest = release_tag.coverage_digest(rows)
        got = release_tag.plan(rows, {"M0": MAP["M0"]}, {"M0": [(0, digest)]})
        self.assertEqual(got, [])

    def test_a_milestone_satisfied_by_different_commits_earns_a_patch(self):
        # M1 was reached, two rows went back to PARTIAL, repairs landed at new
        # commits. The old tag stands; a patch is cut beside it.
        before = [row("REQ-A"), row("REQ-B")]
        after = [row("REQ-A"), row("REQ-B", commit="def456")]
        got = release_tag.plan(
            after, {"M0": MAP["M0"]}, {"M0": [(0, release_tag.coverage_digest(before))]}
        )
        self.assertEqual([entry["tag"] for entry in got], ["v0.0.1"])

    def test_the_patch_counts_from_the_highest_existing_tag(self):
        got = release_tag.plan(
            [row("REQ-A"), row("REQ-B")], {"M0": MAP["M0"]},
            {"M0": [(0, "stale"), (1, "alsostale")]},
        )
        self.assertEqual([entry["tag"] for entry in got], ["v0.0.2"])

    def test_row_order_in_the_ledger_does_not_look_like_a_re_release(self):
        forward = [row("REQ-A"), row("REQ-B")]
        reversed_ = [row("REQ-B"), row("REQ-A")]
        self.assertEqual(
            release_tag.coverage_digest(forward), release_tag.coverage_digest(reversed_)
        )

    def test_an_incomplete_milestone_yields_nothing(self):
        rows = [row("REQ-A"), row("REQ-B"), row("REQ-C", status="PARTIAL")]
        got = release_tag.plan(rows, MAP, {})
        self.assertEqual([entry["tag"] for entry in got], ["v0.0.0"])


class TagListingTests(unittest.TestCase):
    def test_the_digest_is_read_out_of_a_tag_message(self):
        listing = (
            "v0.0.0\tM0 complete.\n\ncoverage-digest: 7323469a3507b253\n\x00"
            "v0.1.0\tM1 complete.\n\ncoverage-digest: aaaabbbbccccdddd\n\x00"
        )
        got = release_tag.parse_tag_listing(listing, MAP)
        self.assertEqual(got["M0"], [(0, "7323469a3507b253")])
        self.assertEqual(got["M1"], [(0, "aaaabbbbccccdddd")])

    def test_a_tag_without_a_digest_still_holds_its_patch_number(self):
        # A tag cut by hand blocks nothing, but the next patch must still clear it.
        got = release_tag.parse_tag_listing("v0.0.0\tcut by hand\x00", MAP)
        self.assertEqual(got["M0"], [(0, "")])
        self.assertEqual(release_tag.next_patch(got["M0"]), 1)

    def test_tags_that_are_not_releases_are_ignored(self):
        # scheme/N marks a change of operating setup and shares the tag namespace.
        listing = "scheme/3\tverdict ownership\x00v1.2.3\tnot ours\x00"
        got = release_tag.parse_tag_listing(listing, MAP)
        self.assertEqual(got, {"M0": [], "M1": []})


class ForeignTaggerTests(unittest.TestCase):
    """A release this job did not cut has passed none of its gates."""

    MACHINE = "zendev-machine[bot]"

    def test_a_tag_cut_by_a_model_run_is_reported(self):
        # v0.2.0, 2026-09-08 06:02Z: cut by hand while REQ-CORE-006 was still PARTIAL,
        # bypassing the completeness check, the provenance refusal and the digest.
        listing = ("v0.0.0\tzendev-machine[bot]\x00"
                   "v0.2.0\tclaude[bot]\x00")
        self.assertEqual(
            release_tag.foreign_taggers(listing, self.MACHINE),
            [("v0.2.0", "claude[bot]")],
        )

    def test_this_jobs_own_tags_are_not_reported(self):
        listing = "v0.0.0\tzendev-machine[bot]\x00"
        self.assertEqual(release_tag.foreign_taggers(listing, self.MACHINE), [])

    def test_scheme_tags_are_not_releases(self):
        # scheme/N shares the namespace and is cut by the operator by design.
        listing = "scheme/4\tDreven\x00"
        self.assertEqual(release_tag.foreign_taggers(listing, self.MACHINE), [])

    def test_a_lightweight_tag_with_no_tagger_is_not_reported(self):
        # An unannotated tag carries no tagger; reporting every one of those would be
        # noise that trains the reader to ignore the warning that matters.
        listing = "v0.3.0\t\x00"
        self.assertEqual(release_tag.foreign_taggers(listing, self.MACHINE), [])

    def test_an_empty_listing_reports_nothing(self):
        self.assertEqual(release_tag.foreign_taggers("", self.MACHINE), [])


class TheRepositorysOwnMapTests(unittest.TestCase):
    """The map is data about the specification, and the specification changes."""

    def test_every_requirement_in_the_registry_is_mapped_exactly_once(self):
        # This is the guard. The researcher adds requirements through the mirror, and
        # one that belongs to no milestone is covered by no gate and would never
        # appear in any release — silently. Failing here is how that gets noticed.
        document = json.loads(MILESTONES.read_text(encoding="utf-8"))
        placed = [
            req_id
            for ids in document["milestones"].values()
            for req_id in ids
        ] + list(document["unassigned"])

        self.assertEqual(
            len(placed), len(set(placed)), "a requirement is mapped to two milestones"
        )

        with io.open(REGISTRY, encoding="utf-8", newline="") as handle:
            registry = {r["REQ_ID"] for r in csv.DictReader(handle)}

        self.assertEqual(
            registry - set(placed), set(),
            "requirements in the registry that no milestone claims",
        )
        self.assertEqual(
            set(placed) - registry, set(),
            "milestones claiming requirements the registry does not have",
        )

    def test_the_ledger_only_carries_requirements_the_registry_knows(self):
        with io.open(REGISTRY, encoding="utf-8", newline="") as handle:
            registry = {r["REQ_ID"] for r in csv.DictReader(handle)}
        self.assertEqual(
            {r["REQ_ID"] for r in release_tag.read_rows(STATUS)} - registry, set()
        )

    def test_the_map_names_a_source_for_every_milestone(self):
        # M1 and M2 are read off prose, and a release must be able to say so.
        document = json.loads(MILESTONES.read_text(encoding="utf-8"))
        self.assertEqual(
            set(document["milestones"]), set(document["source"]),
            "every milestone must declare whether its membership is explicit or prose",
        )


if __name__ == "__main__":
    unittest.main()
