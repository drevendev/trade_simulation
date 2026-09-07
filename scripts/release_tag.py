"""Cut a release tag when a milestone's requirements are all implemented.

The roadmap has versions but the repository has never had a tag, so "what shipped at
M1" is answerable only by reading merge history. This makes it mechanical: the ledger
already records, per requirement, the Issue, the pull request and the merge commit
that satisfied it, and a milestone is done exactly when every one of its rows says
IMPLEMENTED. No judgement is left, so no model runs and no review is needed — the
same class as the mirror's own pull requests.

## Versions

`v0.<milestone>.<patch>`. The major stays 0 until the product says otherwise; the
minor is the milestone number, so a tag's name says what it gates.

The patch exists because a milestone does not stay done. Post-merge QA returned
REQ-CONFIG-003 and REQ-CONFIG-004 to PARTIAL after M1 had been reached; when repairs
land, the milestone is complete again but at different commits, and overwriting the
old tag would erase what "M1" meant to anyone who read it earlier. So the old tag
stands and a patch is cut beside it.

## How a re-release is detected without keeping state

Each tag's message carries `coverage-digest`, a hash of the (requirement, merge
commit) pairs behind it. A milestone whose newest tag carries a different digest has
been satisfied by different commits since, and earns the next patch. Nothing has to be
remembered between runs: the tags are the state.

This is also what makes the job idempotent. It runs on every push to master, and on a
push that changed nothing about coverage the digest is identical and nothing is cut.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys

IMPLEMENTED = "IMPLEMENTED"
TAG = re.compile(r"^v0\.(\d+)\.(\d+)$")
DIGEST_LINE = re.compile(r"^coverage-digest:\s*([0-9a-f]{6,64})\s*$", re.MULTILINE)


def coverage_digest(rows) -> str:
    """A hash of what actually backs a milestone: requirement and merge commit.

    Sorted, so the row order in the ledger cannot make an unchanged milestone look
    re-released.
    """
    pairs = sorted((row["REQ_ID"], (row.get("MERGE_COMMIT") or "").strip()) for row in rows)
    canonical = json.dumps(pairs, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def milestone_number(name: str) -> int:
    return int(name[1:])


def complete(rows, required_ids):
    """Whether every required requirement has an IMPLEMENTED row.

    A missing row is not complete. The ledger only gains a row when work lands, so
    "absent" and "not done" are the same fact, and treating absence as success would
    release a milestone whose work was never started.
    """
    by_id = {row["REQ_ID"]: row for row in rows}
    return all(
        req_id in by_id
        and (by_id[req_id].get("STATUS") or "").strip().upper() == IMPLEMENTED
        for req_id in required_ids
    )


def missing_provenance(rows, required_ids):
    """Required requirements whose row records no merge commit.

    A blank here is not a small gap. The coverage digest is a hash of
    `(REQ_ID, MERGE_COMMIT)` pairs, so blanks make a milestone repaired at new commits
    hash identically to the one released before, and the patch tag that exists for
    exactly that case is never cut. The release notes would render the blanks as an
    em dash and call it provenance.

    Eleven of twenty-three rows were blank when this was written, because nothing was
    responsible for filling a field the AUTHOR cannot know from inside its own pull
    request. `backfill_merge_commits.py` is now that something; this refuses to release
    if it has not run or could not answer.
    """
    by_id = {row["REQ_ID"]: row for row in rows}
    return sorted(
        req_id for req_id in required_ids
        if not ((by_id.get(req_id) or {}).get("MERGE_COMMIT") or "").strip()
    )


def next_patch(existing):
    """The patch to cut given the milestone's existing (patch, digest) pairs."""
    return max(patch for patch, _ in existing) + 1 if existing else 0


def plan(rows, milestones, existing):
    """What to tag now.

    `existing` maps a milestone name to [(patch, digest)] already tagged. Returns a
    list of entries in milestone order.
    """
    out = []
    for name in sorted(milestones, key=milestone_number):
        required = milestones[name]
        if not complete(rows, required):
            continue
        blank = missing_provenance(rows, required)
        if blank:
            # Loud, and not a tag. Releasing this would mint a digest that cannot
            # distinguish these commits from any later repair of the same milestone.
            print(
                "::warning::release-tag: %s is complete but %s record no merge commit; "
                "not releasing until backfill_merge_commits.py fills them"
                % (name, ", ".join(blank))
            )
            continue
        backing = [row for row in rows if row["REQ_ID"] in set(required)]
        digest = coverage_digest(backing)
        seen = existing.get(name, [])
        if any(known == digest for _, known in seen):
            continue
        out.append({
            "tag": "v0.%d.%d" % (milestone_number(name), next_patch(seen)),
            "milestone": name,
            "requirements": sorted(required),
            "digest": digest,
            "rows": sorted(backing, key=lambda row: row["REQ_ID"]),
        })
    return out


def notes(entry, source: str) -> str:
    """The tag message and release body: what shipped, and where to verify it."""
    dash = "—"
    lines = [
        "%s complete %s %d requirements." % (entry["milestone"], dash, len(entry["requirements"])),
        "",
        "| Requirement | Issue | Pull request | Merge commit |",
        "| --- | --- | --- | --- |",
    ]
    for row in entry["rows"]:
        issue = (row.get("ISSUE") or "").strip()
        pull = (row.get("PR") or "").strip()
        commit = (row.get("MERGE_COMMIT") or "").strip()[:12]
        lines.append(
            "| `%s` | %s | %s | %s |" % (
                row["REQ_ID"],
                ("#" + issue) if issue else dash,
                ("#" + pull) if pull else dash,
                ("`%s`" % commit) if commit else dash,
            )
        )
    lines += [
        "",
        "Milestone membership read from docs/zendev/milestones.json (source: %s)." % source,
        "Generated from docs/spec/implementation_status.csv. No model was involved.",
        "",
        "coverage-digest: %s" % entry["digest"],
    ]
    return "\n".join(lines) + "\n"


def read_rows(path):
    with io.open(path, encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _git(args):
    """Run git, and on failure say what git said.

    The first live run died on `git push origin v0.0.0` with exit 128 and printed
    nothing but the exit code: `check=True` raises CalledProcessError, whose str() does
    not include stderr. The cause was one line of git output that never reached the log.
    """
    done = subprocess.run(
        ["git", *args], capture_output=True, text=True, encoding="utf-8"
    )
    if done.returncode != 0:
        raise RuntimeError(
            "git %s failed (%d): %s"
            % (" ".join(args), done.returncode, (done.stderr or done.stdout).strip())
        )
    return done.stdout


def parse_tag_listing(listing, milestones):
    """Turn `git tag --list` output into {milestone: [(patch, digest)]}.

    Kept pure so the version arithmetic can be tested without a repository.
    """
    found = {name: [] for name in milestones}
    numbers = {milestone_number(name): name for name in milestones}
    for block in (listing or "").split("\x00"):
        if not block.strip():
            continue
        ref, _, body = block.partition("\t")
        match = TAG.match(ref.strip())
        if not match:
            continue
        name = numbers.get(int(match.group(1)))
        if name is None:
            continue
        recorded = DIGEST_LINE.search(body or "")
        found[name].append((int(match.group(2)), recorded.group(1) if recorded else ""))
    return found


def existing_tags(milestones):
    listing = _git([
        "tag", "--list", "v0.*",
        "--format=%(refname:strip=2)%09%(contents)%00",
    ])
    return parse_tag_listing(listing, milestones)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    root = pathlib.Path(__file__).resolve().parents[1]
    parser.add_argument(
        "--status", default=str(root / "docs" / "spec" / "implementation_status.csv")
    )
    parser.add_argument(
        "--milestones", default=str(root / "docs" / "zendev" / "milestones.json")
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    document = json.loads(pathlib.Path(args.milestones).read_text(encoding="utf-8"))
    milestones = document["milestones"]
    entries = plan(read_rows(args.status), milestones, existing_tags(milestones))

    if not entries:
        print("release-tag: no milestone is newly complete")
        return 0

    for entry in entries:
        source = (document.get("source") or {}).get(entry["milestone"], "unknown")
        body = notes(entry, source)
        print("release-tag: %s (%s, digest %s)" % (entry["tag"], entry["milestone"], entry["digest"]))
        if args.dry_run:
            print(body)
            continue
        _git(["tag", "-a", entry["tag"], "-m", body])
        _git(["push", "origin", entry["tag"]])
        # The tag is the durable record; the release is presentation. A release that
        # fails to create must not lose the tag that already pushed.
        made = subprocess.run(
            ["gh", "release", "create", entry["tag"],
             "--title", "%s %s %s" % (entry["tag"], "—", entry["milestone"]),
             "--notes", body],
            check=False, capture_output=True, text=True, encoding="utf-8",
        )
        if made.returncode != 0:
            print("::warning::release-tag: %s tagged, release not created: %s"
                  % (entry["tag"], made.stderr.strip()[:200]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
