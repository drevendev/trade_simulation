"""Record what one autonomous run consumed, into the private telemetry ledger.

This repository is public, so its Actions logs and artifacts are public with it. The
numbers therefore go to a separate private repository, one JSON file per run.

Two rules shape this script:

- **It never fails the run.** Telemetry is an observation of the loop, not part of it.
  A missing token, an unreachable ledger, or a malformed execution file produces a
  warning and exit code 0. A loop that stops because bookkeeping failed would be worse
  than a loop with a gap in its bookkeeping.
- **Unknown is not zero.** A field that could not be determined is written as null and
  the record is marked so the rollup can exclude it, rather than quietly reporting a
  run that cost nothing.

Beyond tokens, a record now says three more things, because three days of records
could not answer the questions that matter for the budget:

- **What share of the subscription the run consumed.** The loop runs on a subscription
  metered in rolling windows, not dollars. ``subscription_usage.py`` reads the windows
  before and after the model; the difference is recorded here. Those figures go to the
  private ledger only — the public log prints the record without them.
- **What kind of run it was.** ``completed``, ``no_work``, ``blocked``, ``failed`` or
  ``unknown``. The workflow decides ``no_work`` and ``failed``; the rest is read from
  what the model wrote and is marked as a heuristic, because a transcript that discusses
  a blocker it does not have looks blocked to a string search.
- **Which work it touched.** Issue and pull request numbers and requirement identifiers
  mentioned in the transcript, and whether an author run was reworking a refusal. These
  are what let cost be read per merged requirement instead of per run.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)

API = "https://api.github.com"

# The two windows whose difference is a run's share of the subscription.
GATING_WINDOWS = ("five_hour", "seven_day")

OUTCOMES = ("completed", "no_work", "blocked", "failed", "unknown")

REQUIREMENT = re.compile(r"\bREQ-[A-Z]+-\d{3}\b")
# `#123` not glued to a word, a slash or another hash: a forge reference, not a URL
# fragment, a colour code or a markdown heading.
REFERENCE = re.compile(r"(?<![\w/#])#(\d{1,6})\b")

# The shapes a run ends on when it delivered: a handoff or a verdict heading, or a pull
# request it names. Checked first, on the final message only, because a run that opened
# a pull request has completed whatever else its transcript discussed — the first live
# record under this classifier called an author run "blocked" for mentioning an Issue
# that was blocked, while the run itself ended in a handoff for #163.
COMPLETED = re.compile(
    r"^\s*#{1,6}\s*(?:AUTHOR\s+handoff|ACCEPTOR\s+verdict|ACCEPT\b|REQUEST_CHANGES\b)"
    r"|\bpull request\b[^\n]{0,60}#\d+"
    r"|\bPR:?\s*#\d+"
    r"|\bopened (?:a )?(?:new )?pull request",
    re.I | re.M,
)

# The shapes a run uses when it stops on a gate: the label it sets, the phrase the
# runbook prescribes, or a heading that names a blocker. Prose that merely mentions the
# word — "no known blockers" in a claim comment — is not a heading and does not match.
BLOCKED = re.compile(
    r"status:blocked|\bblocked on\b|^#{1,6}[^\n]*\bblock(?:ed|er)\b", re.I | re.M
)
NO_WORK = re.compile(
    r"\bno[_ ]work\b|\bno eligible\b|\bnothing (?:is )?eligible\b|\bno executable work\b",
    re.I,
)
REWORK = re.compile(
    r"REQUEST_CHANGES|CHANGES_REQUESTED|\bchanges requested\b|\bACCEPTOR (?:verdict|feedback)\b",
    re.I,
)


def warn(message: str) -> None:
    print(f"::warning::record_usage: {message}")


def read_messages(path: str):
    if not path:
        return None, "no execution file was produced"
    file = pathlib.Path(path)
    if not file.is_file():
        return None, f"execution file {file.name} does not exist"
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"execution file could not be parsed: {exc}"
    if not isinstance(data, list):
        return None, "execution file was not a list of messages"
    return data, None


def extract_model(messages):
    """Which model produced this run.

    Without it the ledger cannot be read back: a cost or quality change is
    indistinguishable from a model change, and the model can change without anyone
    editing the workflow. Checked in several places because the shape differs between
    the final result message and the assistant messages.
    """
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        for candidate in (message.get("model"), (message.get("message") or {}).get("model")):
            if isinstance(candidate, str) and candidate:
                return candidate
    return None


def extract_usage(messages):
    """Prefer the final result message; fall back to summing assistant messages.

    The result message carries cumulative usage for the session. Summing assistant
    messages reconstructs it when the run ended without one, which is why the source
    is recorded alongside the numbers.
    """
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("type") == "result":
            usage = message.get("usage") or {}
            return (
                {field: usage.get(field) for field in TOKEN_FIELDS},
                {
                    "total_cost_usd": message.get("total_cost_usd"),
                    "duration_ms": message.get("duration_ms"),
                    "num_turns": message.get("num_turns"),
                    "session_id": message.get("session_id"),
                },
                "result",
            )

    totals = {field: 0 for field in TOKEN_FIELDS}
    seen = False
    for message in messages:
        if not isinstance(message, dict):
            continue
        usage = message.get("usage") or (message.get("message") or {}).get("usage")
        if not isinstance(usage, dict):
            continue
        seen = True
        for field in TOKEN_FIELDS:
            value = usage.get(field)
            if isinstance(value, int):
                totals[field] += value

    if not seen:
        return {field: None for field in TOKEN_FIELDS}, {}, "unavailable"
    return totals, {}, "summed"


def transcript(messages) -> str:
    """Everything the model said: the final result text and every assistant text block."""
    parts = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        if message.get("type") == "result" and isinstance(message.get("result"), str):
            parts.append(message["result"])
        content = (message.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if (
                isinstance(block, dict)
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
            ):
                parts.append(block["text"])
    return "\n".join(parts)


def final_text(messages) -> str:
    """What the run said last: the result text, or failing that the last assistant text.

    The outcome is read from this, not from the whole transcript. A run talks about many
    things on the way — Issues that are blocked, work it decided not to take — and only
    its last word says how it ended.
    """
    last = ""
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        if message.get("type") == "result" and isinstance(message.get("result"), str):
            return message["result"]
        content = (message.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        texts = [
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        ]
        if texts:
            last = "\n".join(texts)
    return last


def classify_outcome(conclusion, text):
    """(outcome, source). Pure.

    The workflow's own conclusion is trusted where it is specific: `no_work` means the
    model was never started, and anything that is not success or unknown is a failure.
    Everything else is read from the run's final message, and the source says so. A
    handoff or a verdict there means completed, whatever else the message mentions.
    """
    if conclusion == "no_work":
        return "no_work", "workflow"
    if conclusion not in (None, "", "unknown", "success"):
        return "failed", "workflow"
    if COMPLETED.search(text or ""):
        return "completed", "heuristic"
    if BLOCKED.search(text or ""):
        return "blocked", "heuristic"
    if NO_WORK.search(text or ""):
        return "no_work", "heuristic"
    if conclusion == "success":
        return "completed", "heuristic"
    return "unknown", "heuristic"


def mentions(text):
    """Forge references and requirement identifiers the transcript names. Pure."""
    return {
        "references": sorted({int(number) for number in REFERENCE.findall(text or "")}),
        "requirements": sorted(set(REQUIREMENT.findall(text or ""))),
    }


def is_rework(role, text):
    """Whether an author run was answering a refusal. None for any other role."""
    if role != "author":
        return None
    return bool(REWORK.search(text or ""))


def load_reading(path):
    """A subscription reading written by subscription_usage.py, or None."""
    if not path:
        return None
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _utilization(reading, window):
    if not isinstance(reading, dict) or not reading.get("available"):
        return None
    block = reading.get(window)
    if not isinstance(block, dict):
        return None
    value = block.get("utilization")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def subscription_block(before, after):
    """Before, after and the difference per gating window. Pure.

    The delta is null unless both readings are available: a missing side is a gap in
    the bookkeeping, and a gap must never be read as a run that consumed nothing.
    """
    delta = {}
    for window in GATING_WINDOWS:
        first, second = _utilization(before, window), _utilization(after, window)
        if first is None or second is None:
            delta[window] = None
        else:
            delta[window] = round(second - first, 3)
    return {"before": before, "after": after, "delta": delta}


def public_view(record):
    """The record as printed in the public run log: everything but the subscription."""
    return {key: value for key, value in record.items() if key != "subscription"}


def put_record(repo: str, path: str, payload: str, token: str) -> None:
    body = json.dumps(
        {
            "message": f"record: {path}",
            "content": base64.b64encode(payload.encode("utf-8")).decode("ascii"),
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        f"{API}/repos/{repo}/contents/{path}",
        data=body,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "trade-simulation-telemetry",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        response.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execution-file", default="")
    parser.add_argument("--role", required=True)
    parser.add_argument("--conclusion", default="unknown")
    parser.add_argument("--ledger-repo", required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--run-url", default="")
    parser.add_argument("--commit", default="")
    parser.add_argument("--usage-before", default="", help="subscription reading before the model")
    parser.add_argument("--usage-after", default="", help="subscription reading after the model")
    args = parser.parse_args()

    messages, problem = read_messages(args.execution_file)
    if problem:
        warn(problem)
        tokens = {field: None for field in TOKEN_FIELDS}
        extra, source, model, text = {}, "unavailable", None, ""
    else:
        tokens, extra, source = extract_usage(messages)
        model = extract_model(messages)
        text = transcript(messages)
        if model is None:
            warn("the execution file names no model; recording null")

    # The outcome is read from the run's last word; mentions and rework from everything.
    outcome, outcome_source = classify_outcome(args.conclusion, final_text(messages))
    before = load_reading(args.usage_before)
    after = load_reading(args.usage_after)
    if before is None or after is None:
        warn("a subscription reading is missing; the subscription block carries nulls")

    now = dt.datetime.now(dt.timezone.utc)
    record = {
        "recorded_at": now.isoformat(timespec="seconds"),
        "role": args.role,
        "conclusion": args.conclusion,
        "outcome": outcome,
        "outcome_source": outcome_source,
        "rework": is_rework(args.role, text),
        "mentions": mentions(text),
        "model": model,
        "usage_source": source,
        **tokens,
        "total_cost_usd": extra.get("total_cost_usd"),
        "duration_ms": extra.get("duration_ms"),
        "num_turns": extra.get("num_turns"),
        "session_id": extra.get("session_id"),
        "subscription": subscription_block(before, after),
        "run_id": args.run_id,
        "run_url": args.run_url,
        "commit": args.commit,
    }
    payload = json.dumps(record, indent=2, ensure_ascii=False) + "\n"

    # Visible in the public run log on purpose: token counts are not sensitive, and
    # seeing them here is what makes a broken ledger obvious. The subscription figures
    # are the one exception — they describe the account, not the run — and stay in the
    # private ledger.
    print(json.dumps(public_view(record), ensure_ascii=False))

    token = os.environ.get("TELEMETRY_TOKEN", "")
    if not token:
        warn("TELEMETRY_TOKEN is not set; the run was not recorded to the ledger")
        return 0

    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    path = (
        f"runs/{now.year:04d}/{now.month:02d}/"
        f"{stamp}-{args.role}-{args.run_id or 'norun'}.json"
    )
    try:
        put_record(args.ledger_repo, path, payload, token)
    except urllib.error.HTTPError as exc:
        warn(f"ledger rejected the record: HTTP {exc.code}")
        return 0
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        warn(f"ledger unreachable: {exc}")
        return 0

    print(f"record_usage: wrote {args.ledger_repo}/{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
