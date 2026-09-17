"""Bring a loop branch that is merely behind its base up to date, without a model run.

`mergeability` reports two red conditions. `dirty` is a conflict and needs a person or
a model to resolve. `behind` is not: the branch merges cleanly, its checks were simply
measured against a base that has since moved, and the repair is one merge commit of the
base into the branch. Until now that merge cost a full AUTHOR run — the role's own
ladder picks up its failing check and performs the merge by hand — twice on #130 in one
afternoon.

This performs the merge through the forge's own endpoint, for the loop's branches only:

* the head must live in this repository — a fork's branch is not ours to move;
* the branch must be the loop's (``claude/**``) or an outside author's (``zen/**``);
  any other branch — an operator's — is left alone;
* it must not be a machine class: a merge commit committed by anyone but the producing
  workflow fails that class's committer gate, so updating one would refuse it;
* the branch must merge. A conflict is not this sweep's to resolve, and an answer
  GitHub has not computed yet is not an answer;
* the branch must be *measurably* behind. That distance is measured against the
  repository, by ``mergeability.compare_to_base``, not read off ``mergeable_state``.

That last point is the repair in #492. This asked GitHub for ``mergeable_state ==
"behind"``, and GitHub emits that string only when the base branch's protection rule
has *"Require branches to be up to date before merging"* switched on. With it off — as
the #479 observation says it is here — a branch two commits behind comes back
``"clean"``, so the condition was never satisfied for the case it targets and the sweep
updated nothing. It is the same defect #482 repaired in ``mergeability``, and the same
fix: measure, and keep the API's word only as corroboration.

``clean``, ``blocked``, ``unstable`` and ``has_hooks`` therefore no longer decide
anything. They describe review and check state, which is orthogonal to whether the base
has moved; a branch in any of them that is measurably behind is updated, matching the
`failure` ``mergeability`` now writes on it.

The credential matters. A push made with the workflow's own token starts no workflows,
so the updated branch would carry the stale checks it had before, and the pull request
would read as measured on a revision nothing ever measured. The step that runs this
uses the loop's token instead, and runs only from the reviewed definition on ``master``.

Exit code is 0 whatever happened to individual branches. The outcome for a pull request
is the update the forge did or did not perform, printed per branch; this run's own
status says only that the sweep ran.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

import machine_pr_guard
import mergeability

LOOP_PREFIX = "claude/"
# An author outside the loop — the researcher under scheme/8 — works on `zen/**` through
# the forge's API and has no working tree to merge the base into. On 2026-09-17 three
# control-plane merges left #550 "behind master by 3 commits": a red required check its
# author had no way to clear. So the forge maintains that class like the loop's own, with
# one difference. A `claude/**` draft is skipped because a run may still be writing it; a
# `zen/**` draft is maintained, because such an author keeps its pull request in draft
# for the whole of its iteration, which is exactly when a moved base costs it the most,
# and a base merge cannot collide with a working tree that does not exist.
OUTSIDE_PREFIX = "zen/"
MAINTAINED_PREFIXES = (LOOP_PREFIX, OUTSIDE_PREFIX)
BEHIND = "behind"


def should_update(pull, behind_by):
    """(bool, reason). Pure: decides from one pull request object and one measurement.

    `behind_by` is how many commits the base branch holds that this head does not, as
    `mergeability.compare_to_base` measured it, or `None` when that measurement did not
    come back. It is a parameter rather than something read here because this function
    performs no network call and its whole test suite depends on that.

    `behind_by` has no default, for the reason `mergeability.classify` gives for the
    same parameter: a default is how this arm goes unreachable a third time. A caller
    that never measured would get the old always-`False` answer silently; without one
    it gets a `TypeError` at the call site.
    """
    head = pull.get("head") or {}
    base = pull.get("base") or {}
    ref = head.get("ref") or ""
    head_repo = (head.get("repo") or {}).get("full_name")
    base_repo = (base.get("repo") or {}).get("full_name")

    if pull.get("state", "open") != "open":
        return False, "not open"
    if pull.get("draft") and not ref.startswith(OUTSIDE_PREFIX):
        return False, "draft"
    if not head_repo or head_repo != base_repo:
        return False, "head is not in this repository"
    if machine_pr_guard.classify(ref) is not None:
        return False, "machine class: a merge commit from anyone else fails its committer gate"
    if not ref.startswith(MAINTAINED_PREFIXES):
        return False, f"not a loop branch ({LOOP_PREFIX}** or {OUTSIDE_PREFIX}**)"
    if pull.get("mergeable") is None:
        return False, "mergeability not yet computed"
    state = pull.get("mergeable_state")
    if pull.get("mergeable") is False:
        return False, f"conflicts with the base branch ({state}); not this sweep's to resolve"
    # It merges. The only remaining question is whether the base has moved under it.
    if behind_by is None:
        # Distinct from "mergeability not yet computed" on purpose. That one is GitHub
        # not having decided whether the branch merges; this one is the compare endpoint
        # not answering at all. A comparison that did not happen is not a measurement of
        # zero, and treating it as one is exactly how this sweep went quiet before.
        return False, "could not measure this branch's distance from its base"
    if behind_by > 0:
        commits = "commit" if behind_by == 1 else "commits"
        return True, f"behind its base by {behind_by} {commits}"
    if state == BEHIND:
        # The two disagree: the comparison found no distance and the API volunteered
        # `behind` anyway. Updated anyway — corroboration from the forge about its own
        # base is not something to overrule — but described without the measured zero,
        # which would read as a broken sweep. Same rule as `mergeability.classify`.
        return True, "GitHub reports this branch behind its base, though the comparison measured no distance"
    return False, "already contains the tip of its base"


def failure_detail(stderr: str, returncode: int) -> str:
    """The one line of a failed gh call worth printing: the HTTP status, if any."""
    for line in (stderr or "").splitlines():
        if line.startswith("HTTP ") or line.startswith("gh: "):
            return line.strip()
    return f"gh exit {returncode}"


def _gh(args):
    # UTF-8 explicitly, not by locale: see the note in machine_pr_guard.py.
    return subprocess.run(
        ["gh", *args], capture_output=True, text=True, encoding="utf-8"
    )


def read_pull(repo: str, number: int):
    result = _gh(["api", f"repos/{repo}/pulls/{number}"])
    if result.returncode:
        raise RuntimeError(f"could not read #{number}: {failure_detail(result.stderr, result.returncode)}")
    return json.loads(result.stdout)


def open_pull_numbers(repo: str):
    result = _gh(["api", f"repos/{repo}/pulls?state=open&per_page=100"])
    if result.returncode:
        raise RuntimeError(f"could not list pull requests: {failure_detail(result.stderr, result.returncode)}")
    return [int(pull["number"]) for pull in json.loads(result.stdout)]


def update(repo: str, number: int, head_sha: str):
    """Ask the forge to merge the base into the branch. Returns (ok, detail).

    `expected_head_sha` makes the request refuse if the branch moved since it was
    read, so a push landing in the same second is never merged over.
    """
    result = _gh(
        [
            "api",
            "-X",
            "PUT",
            f"repos/{repo}/pulls/{number}/update-branch",
            "-f",
            f"expected_head_sha={head_sha}",
        ]
    )
    if result.returncode == 0:
        return True, "update requested"
    return False, failure_detail(result.stderr, result.returncode)


def measure(repo: str, pull) -> mergeability.Comparison:
    """How far this head is behind its base. The impure half of the decision.

    Measured for every pull request the sweep reads, including ones the pure guards will
    reject anyway. Gating the request on a cheap precondition would mean writing the
    guard chain a second time, and a second copy that drifts is how this arm became
    unreachable in the first place: a branch that should have been updated would come
    back "could not measure" and nobody would look again. One compare request per open
    pull request per sweep is the cheaper mistake.
    """
    head_sha = (pull.get("head") or {}).get("sha")
    base_ref = (pull.get("base") or {}).get("ref")
    if not head_sha or not base_ref:
        return mergeability.UNMEASURED
    return mergeability.compare_to_base(repo, base_ref, head_sha)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pull", type=int, help="one pull request number")
    group.add_argument("--all-open", action="store_true", help="every open pull request")
    parser.add_argument("--dry-run", action="store_true", help="decide, but update nothing")
    args = parser.parse_args()

    try:
        numbers = [args.pull] if args.pull else open_pull_numbers(args.repo)
    except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"::warning::update-branches: {error}")
        return 0

    for number in numbers:
        try:
            pull = read_pull(args.repo, number)
        except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
            print(f"::warning::update-branches: {error}")
            continue
        ref = (pull.get("head") or {}).get("ref") or "?"
        ok, reason = should_update(pull, measure(args.repo, pull).behind_by)
        if not ok:
            print(f"update-branches: #{number} {ref} left alone: {reason}")
            continue
        if args.dry_run:
            print(f"update-branches: #{number} {ref} would be updated ({reason})")
            continue
        done, detail = update(args.repo, number, pull["head"]["sha"])
        verb = "updated" if done else "not updated"
        print(f"update-branches: #{number} {ref} {verb}: {detail}")
        if not done:
            print(f"::notice::update-branches: #{number} not updated: {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
