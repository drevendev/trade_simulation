"""The setup the loop is running under, named and versioned so measurements compare.

A day of telemetry is only comparable to another day if the system was the same on
both. It usually was not: between 2026-09-05 and 2026-09-07 the identities changed,
the per-run ceilings changed, and the ownership of the formal verdict changed. Each of
those makes the earlier numbers numbers about a different system, and nothing in the
ledger said so — the boundary lived in one person's memory.

A **scheme** is that setup written down: roles and their identities, the model each
role runs, who owns the verdict, which voices exist, the mandatory checks, the rework
bound, the cadence. `docs/zendev/schemes.json` holds them, `scheme/N` tags the commit
where each took effect, and every telemetry record carries `{id, digest}` so a window
can be sliced by scheme without knowing a single date.

## Why a digest, and what it can and cannot catch

The digest is a hash of the active descriptor. Two records with the same `id` and
different digests mean the descriptor was edited without the number moving — the
failure that makes a named scheme worthless.

It cannot, on its own, catch the descriptor drifting away from *reality*: a workflow
edited to a different model while the descriptor still names the old one hashes the
same. That is why `check_observed` exists and why the recorder calls it with what the
run actually used. A claim the run itself contradicts is worth more than any hash.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib

# The recorder runs from RUNNER_TEMP, not from the working tree: a reviewed branch
# must not get its own copy of the recorder executed with the ledger credential in the
# environment (see the staging step in zendev-acceptor.yml). The descriptor has to
# travel the same way and for the same reason — read from the working tree it would be
# whatever the branch under review says the setup is.
#
# So: an explicit path wins, then a copy staged beside this module, then the
# repository's own. The last is the one that applies off the runner.
def _default_path() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve().parent
    candidates = [
        os.environ.get("ZENDEV_SCHEMES_FILE", ""),
        here / "schemes.json",
        here.parent / "docs" / "zendev" / "schemes.json",
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return pathlib.Path(candidate)
    return here.parent / "docs" / "zendev" / "schemes.json"

# Keys that describe the setup. `note`, `_comment`, `in_force_from` and `commit` are
# prose and bookkeeping: an operator filling in the commit of a merge must not change
# the identity of the scheme, or every record written before that edit would look like
# it belonged to a different one.
DESCRIPTIVE_KEYS = (
    "id", "roles", "verdict_owner", "voices",
    "required_checks", "rework_limit", "cadence_minutes",
)


def load(path=None):
    path = pathlib.Path(path) if path else _default_path()
    return json.loads(path.read_text(encoding="utf-8"))


def active(document):
    """The descriptor named by `active`, or None when it names nothing that exists."""
    wanted = document.get("active")
    for scheme in document.get("schemes", []):
        if scheme.get("id") == wanted:
            return scheme
    return None


def digest(scheme) -> str:
    """A stable short hash of the descriptive part of a scheme.

    Sorted keys and a compact separator, so re-indenting the file or reordering its
    keys does not read as a change of setup — only the values do.
    """
    if not scheme:
        return ""
    subset = {key: scheme[key] for key in DESCRIPTIVE_KEYS if key in scheme}
    canonical = json.dumps(subset, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def stamp(path=None):
    """`{"id": ..., "digest": ...}` for a telemetry record, or None if unreadable.

    Never raises. A telemetry record with no scheme block is a small loss; a recorder
    that dies because a JSON file is malformed loses the whole record, and the record
    is the only evidence the run happened at all.
    """
    try:
        scheme = active(load(path))
    except (OSError, ValueError):
        return None
    if not scheme:
        return None
    return {"id": scheme["id"], "digest": digest(scheme)}


def check_observed(scheme, role: str, model: str):
    """Say why the run contradicts the descriptor, or None when it does not.

    Only checks what a run can actually observe about itself. A run with no model —
    a role that found no work — observes nothing and contradicts nothing.
    """
    if not scheme or not model:
        return None
    declared = ((scheme.get("roles") or {}).get(role) or {}).get("model")
    if not declared:
        return None
    # The workflow pins an alias (`claude-haiku-4-5`); the result names the exact build
    # (`claude-haiku-4-5-20251001`). The alias is the claim, so a prefix match is the
    # honest comparison — an exact one would report drift on every ordinary run.
    if model == declared or model.startswith(declared + "-"):
        return None
    return f"{scheme['id']} declares {role} on {declared}, the run used {model}"


def milestone_map(document):
    """Milestone -> the requirement ids it gates. Empty when the file carries none."""
    return {name: list(ids) for name, ids in (document.get("milestones") or {}).items()}
