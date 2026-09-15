"""Report, as a commit status, whether an open pull request still merges cleanly.

A pull request stops being mergeable when its *base* moves, not when the pull request
itself changes. GitHub's own pull request checks do not re-run on a push to `master`,
so a branch that conflicted an hour ago still shows the green checks it earned before
the conflict existed. Nothing in the loop noticed that, and the discovery fell to an
ACCEPTOR run — which spends a model run and half an hour to learn something the forge
already knew.

This script closes that. It reads mergeability from the API and writes a commit
status named `mergeability` onto the pull request's head revision, so the answer is
visible where every other gate is visible, at the moment the base moves.

Three outcomes, and the third is the point:

* the pull request merges cleanly    -> `success`
* it conflicts with its base         -> `failure`
* GitHub has not computed it yet     -> `pending`, never `success`

An unknown answer is not a passing answer. GitHub computes mergeability lazily and
reports `null` while it works; treating that as green would make the check report
health it never observed, which is the failure mode the check exists to prevent.
`pending` is honest, and the next push to either branch re-evaluates it.

This check reports conflicts and staleness and nothing else. Whether the tests pass,
the policy guard is happy, or the review is done are other checks' business — a check
that answers more than one question cannot be read.

Staleness is measured here, not read off `mergeable_state`. GitHub reports that state
as `"behind"` only when the base branch's protection rule has *"Require branches to be
up to date before merging"* switched on; with it off, a branch that is two commits
behind and conflict-free comes back `"clean"`, and this check went green on it. That is
what happened to #479 on 2026-09-15: two commits behind, status rewritten after both
merges landed, `success`.

Whether that setting is off on `master` is an inference, not a reading — no identity in
the loop can see branch protection — but it is the only explanation anyone has offered
for the observation, and the repair does not rest on it either way. A control that
depends on a setting nobody here can see is not a control, so the distance is computed
from the repository itself and the API's own word on it is now only corroboration. The
check reports the same thing whichever way that setting is set.

A `success` here is a claim about a *revision*: this head contains the tip of its base.
Between measuring that and writing it down the base can move, and two runs can be in
flight at once — a `pull_request` run and a `push`-to-base run sit in different workflow
concurrency groups, so neither waits for the other. A run that measured `behind_by == 0`
against the old tip would then overwrite the push run's honest `failure` with a `success`
nobody could see was stale. So every measurement carries the base tip it was taken
against, and a `success` is confirmed against that tip immediately before it is written.
A base that moved under the measurement is re-measured; one that keeps moving is
`pending`, never green. The confirm-to-write window remains — closing it entirely needs
the two writers serialized, which is a workflow change and ships on its own — but a
`success` now names a base revision that was still current a request ago instead of one
that may be arbitrarily old.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from typing import NamedTuple, Optional

CONTEXT = "mergeability"

# The API caps a status description; a truncated sentence reads as a bug in the check.
MAX_DESCRIPTION = 140


# The base moved and this branch has not caught up. It merges cleanly, but its green
# checks were measured against a base that no longer exists, so they say nothing about
# what would actually land — the case where two changes are textually independent and
# semantically not.
#
# Reported as a failure rather than left to branch protection's "require branches to be
# up to date". That setting blocks the merge and produces no check, so the branch shows
# nothing red: selection would keep offering it and the AUTHOR's own "open pull request
# with a failing required check" rule would match nothing. It would belong to no queue,
# which is the trap this control plane has already had to close once. A red check
# blocks the same merge and routes the work.
#
# This is the *name* GitHub gives that condition, and it is no longer what decides it.
# The condition is decided by `compare_to_base`; this value is still honoured when the API
# does volunteer it, so that turning the branch-protection setting on later cannot make
# the check disagree with itself.
STALE_BASE = "behind"


def _fit(template: str, base_ref) -> str:
    """Fill `{ref}` in `template`, shortening the ref rather than the sentence.

    `post_status` clamps to `MAX_DESCRIPTION`, which on a long branch name would cut
    this mid-word: the reader then sees a check that looks broken, at the moment it is
    telling them something true. A branch name is the one part that can be abbreviated
    and still do its job, so the sentence keeps its full length and the name gives way.
    """
    ref = base_ref or "the base branch"
    room = MAX_DESCRIPTION - len(template.format(ref=""))
    if len(ref) > room:
        ref = ref[: max(room - 1, 0)] + "…"
    return template.format(ref=ref)


def classify(mergeable, mergeable_state, behind_by, base_ref):
    """Map what we know about a pull request to (state, description). Pure.

    `behind_by` is how many commits the base branch holds that this head does not,
    measured by `compare_to_base`, or `None` when that measurement did not come back.

    `behind_by` has no default, deliberately. A default is how this arm would go
    unreachable a second time: a caller that never measured would keep getting
    `success`, silently, which is precisely the defect being repaired. Without one,
    failing to measure is a `TypeError` at the call site rather than a green tick.
    """
    if mergeable is False:
        return (
            "failure",
            f"conflicts with the base branch ({mergeable_state}); rebase and push",
        )
    if mergeable is not True:
        return (
            "pending",
            "mergeability not yet computed by GitHub; re-evaluated on the next push",
        )
    # It merges. The remaining question is whether what it merges into is still there.
    if behind_by is None:
        return (
            "pending",
            _fit(
                "could not measure this branch's distance from {ref}; "
                "re-evaluated on the next push",
                base_ref,
            ),
        )
    if behind_by > 0:
        commits = "commit" if behind_by == 1 else "commits"
        return (
            "failure",
            _fit(
                "behind {ref} by %d %s; its checks were measured against a base that "
                "has moved — update the branch" % (behind_by, commits),
                base_ref,
            ),
        )
    if mergeable_state == STALE_BASE:
        # The two disagree: the comparison found no distance and the API volunteered
        # `behind` anyway. Still refused — corroboration from the forge about its own
        # base is not something to overrule — but described without a count, because
        # interpolating the measured zero here prints "behind master by 0 commits",
        # which reads as a broken check at the moment it is telling the truth.
        return (
            "failure",
            _fit(
                "GitHub reports this branch behind {ref}, though the comparison "
                "measured no distance; update the branch",
                base_ref,
            ),
        )
    return ("success", f"merges cleanly into the base branch ({mergeable_state})")


def _gh(args):
    # UTF-8 explicitly, not by locale. Without it Python decodes with the platform's
    # preferred encoding, which on a Windows console is cp1252: a comment or title
    # holding an em dash then raises inside the reader thread, `stdout` comes back as
    # None, and the caller fails several frames later on something that looks unrelated.
    # The runner's UTF-8 locale hides this, so it only ever appears off the runner —
    # where the control plane is developed. Same fix as machine_pr_guard.py carries.
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout


def read_pull(repo: str, number: int):
    """Return (head_sha, mergeable, mergeable_state, base_ref) for one pull request."""
    raw = _gh(["api", f"repos/{repo}/pulls/{number}"])
    data = json.loads(raw)
    return (
        data["head"]["sha"],
        data.get("mergeable"),
        data.get("mergeable_state"),
        (data.get("base") or {}).get("ref"),
    )


class Comparison(NamedTuple):
    """One reading of a head's distance from its base, and the base it read.

    `behind_by` alone is a number without a subject: it is true of the base as it stood
    during that request and says nothing once the base moves. `base_tip` is what makes
    the reading checkable later, so keeping them apart is how the verdict lost track of
    what it was measuring.
    """

    behind_by: Optional[int]
    base_tip: Optional[str]


UNMEASURED = Comparison(None, None)


def compare_to_base(repo: str, base_ref: str, head_sha: str) -> Comparison:
    """Commits on `base_ref` that `head_sha` lacks, and the base tip that was compared.

    The forge's own comparison, so it costs no clone and answers about the base branch
    as it stands right now rather than as it stood when the pull request was opened.
    `base.sha` on the pull request object is not reliably either of those, which is why
    it is not what this reads.

    `base_commit.sha` is the tip the endpoint resolved `base_ref` to for this very
    count — not the merge base, which the response reports separately. Taking it from
    the same response as the count is the point: a tip read by a second request could
    be a different revision from the one the number describes, which is the ambiguity
    this is here to remove.

    A comparison that does not come back is `UNMEASURED`, and `classify` turns that into
    `pending`. Not `0`: a measurement that did not happen is not a measurement of zero,
    and this whole repair is about the check no longer reporting green for a property
    it has not looked at.
    """
    try:
        raw = _gh(["api", f"repos/{repo}/compare/{base_ref}...{head_sha}"])
        data = json.loads(raw)
        return Comparison(int(data["behind_by"]), data["base_commit"]["sha"])
    except (subprocess.CalledProcessError, ValueError, KeyError, TypeError) as error:
        print(
            f"::warning::{CONTEXT}: could not compare "
            f"{base_ref}...{head_sha}: {error}"
        )
        return UNMEASURED


def resolve(repo: str, number: int, attempts: int, delay: float):
    """Read mergeability, giving GitHub a bounded chance to finish computing it."""
    head_sha = mergeable = state = base_ref = None
    for attempt in range(attempts):
        head_sha, mergeable, state, base_ref = read_pull(repo, number)
        if mergeable is not None:
            break
        if attempt + 1 < attempts:
            time.sleep(delay)
    return head_sha, mergeable, state, base_ref


class Verdict(NamedTuple):
    """What to write, and what it was measured against.

    The last two fields are not decoration. `state` and `description` are what a reader
    sees; `base_ref` and `base_tip` are what makes the claim falsifiable before it is
    written. A verdict that carried only the first three could not be re-checked at all,
    which is why the stale-`success` window existed.
    """

    head_sha: str
    state: str
    description: str
    base_ref: Optional[str] = None
    base_tip: Optional[str] = None


def measure(repo: str, number: int, attempts: int, delay: float) -> Verdict:
    """Everything one verdict needs, including the base revision it turns on.

    The distance is only measured once GitHub says the branch merges. When it says the
    branch conflicts, or has not decided, the verdict does not turn on the distance and
    the extra request would buy nothing.
    """
    head_sha, mergeable, state, base_ref = resolve(repo, number, attempts, delay)
    comparison = (
        compare_to_base(repo, base_ref, head_sha) if mergeable is True else UNMEASURED
    )
    status, description = classify(mergeable, state, comparison.behind_by, base_ref)
    return Verdict(head_sha, status, description, base_ref, comparison.base_tip)


def settle(
    repo: str, number: int, attempts: int, delay: float, rounds: int = 2
) -> Verdict:
    """A verdict whose `success` was confirmed against the base tip it claims.

    Only `success` is re-checked, because only `success` is a claim that expires: a
    conflict and an uncomputed mergeability both stay true, or at worst stay blocking,
    when the base moves. Green is the one answer that a moving base turns into a lie,
    and the one another run may be writing `failure` for at the same moment.

    A base that moved under the measurement is measured again rather than guessed at. A
    base still moving after `rounds` attempts gives `pending`: this is a check, not a
    wait loop, and `pending` blocks the merge exactly as `failure` would while claiming
    less. What it must never do is fall through to the `success` that was computed
    against a tip we have just watched disappear.
    """
    attempts_left = max(rounds, 1)
    verdict = measure(repo, number, attempts, delay)
    while attempts_left:
        if verdict.state != "success" or verdict.base_tip is None:
            return verdict
        confirmed = compare_to_base(repo, verdict.base_ref, verdict.head_sha)
        if confirmed.base_tip == verdict.base_tip:
            return verdict
        if confirmed.base_tip is None:
            # The confirmation itself did not come back. Re-measuring would go through
            # the same endpoint that just declined to answer, so it buys nothing; what
            # matters is that an unconfirmed `success` is not written.
            return verdict._replace(
                state="pending",
                description=_fit(
                    "could not confirm {ref} had not moved since this branch was "
                    "measured; re-evaluated on the next push",
                    verdict.base_ref,
                ),
            )
        attempts_left -= 1
        if not attempts_left:
            break
        print(
            f"::notice::{CONTEXT}: #{number} base {verdict.base_ref} moved from "
            f"{verdict.base_tip[:8]} during measurement; measuring again"
        )
        verdict = measure(repo, number, attempts, delay)
    return verdict._replace(
        state="pending",
        description=_fit(
            "{ref} moved while this branch was being measured; "
            "re-evaluated on the next push",
            verdict.base_ref,
        ),
    )


def post_status(repo: str, sha: str, state: str, description: str) -> None:
    _gh(
        [
            "api",
            "-X",
            "POST",
            f"repos/{repo}/statuses/{sha}",
            "-f",
            f"state={state}",
            "-f",
            f"context={CONTEXT}",
            "-f",
            f"description={description[:MAX_DESCRIPTION]}",
        ]
    )


def open_pull_numbers(repo: str):
    raw = _gh(["api", f"repos/{repo}/pulls?state=open&per_page=100"])
    return [int(pull["number"]) for pull in json.loads(raw)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pull", type=int, help="one pull request number")
    group.add_argument(
        "--all-open",
        action="store_true",
        help="every open pull request; use when the base branch moved",
    )
    parser.add_argument("--attempts", type=int, default=8)
    parser.add_argument("--delay", type=float, default=4.0)
    # A second, more patient pass over whatever is still unknown after the first. See
    # the note on `pending` below.
    parser.add_argument("--recheck-attempts", type=int, default=15)
    parser.add_argument("--recheck-delay", type=float, default=8.0)
    args = parser.parse_args()

    numbers = [args.pull] if args.pull else open_pull_numbers(args.repo)

    conflicted = []
    unknown = []
    for number in numbers:
        verdict = settle(args.repo, number, args.attempts, args.delay)
        post_status(args.repo, verdict.head_sha, verdict.state, verdict.description)
        print(
            f"{CONTEXT}: #{number} {verdict.head_sha[:8]} -> "
            f"{verdict.state} ({verdict.description})"
        )
        if verdict.state == "failure":
            conflicted.append(number)
        elif verdict.state == "pending":
            unknown.append(number)

    # `pending` is honest and it blocks, which was the right call while this status was
    # advisory. Now that it is a required check, a `pending` that nobody clears is a
    # merge freeze — and the moment it is most likely is exactly after a merge, when
    # GitHub invalidates mergeability for every open pull request and recomputes it
    # lazily, sometimes past the first pass's patience.
    #
    # So whatever is still unknown gets one more, slower pass in the same run. Bounded
    # on purpose: this is a nudge for a value that arrives late, not a wait loop for one
    # that never arrives. Anything still unknown afterwards stays `pending` and clears
    # on the next push, which is the behaviour this had before.
    #
    # `pending` now has two further causes — a comparison against the base that did not
    # come back, and a base that moved while the branch was being measured — and this
    # pass retries both, because `settle` re-measures rather than reusing the first
    # pass's answer. A base that moves twice in a run is a base that is being pushed to,
    # and the push's own fan-out will write the verdict this one declined to guess.
    for number in unknown:
        verdict = settle(
            args.repo, number, args.recheck_attempts, args.recheck_delay
        )
        post_status(args.repo, verdict.head_sha, verdict.state, verdict.description)
        print(f"{CONTEXT}: #{number} {verdict.head_sha[:8]} -> {verdict.state} (recheck)")
        if verdict.state == "failure":
            conflicted.append(number)

    # Exit 0 either way. The verdict for a pull request is the status written onto it,
    # not this run's own conclusion: a red run over a list of pull requests says
    # nothing about which one is broken, and a red run on the base branch would
    # report the repository as unhealthy because one branch drifted.
    if conflicted:
        print(f"::notice::{CONTEXT}: conflicting pull request(s): {conflicted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
