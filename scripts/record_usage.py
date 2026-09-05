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
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import pathlib
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
    args = parser.parse_args()

    messages, problem = read_messages(args.execution_file)
    if problem:
        warn(problem)
        tokens = {field: None for field in TOKEN_FIELDS}
        extra, source, model = {}, "unavailable", None
    else:
        tokens, extra, source = extract_usage(messages)
        model = extract_model(messages)
        if model is None:
            warn("the execution file names no model; recording null")

    now = dt.datetime.now(dt.timezone.utc)
    record = {
        "recorded_at": now.isoformat(timespec="seconds"),
        "role": args.role,
        "conclusion": args.conclusion,
        "model": model,
        "usage_source": source,
        **tokens,
        "total_cost_usd": extra.get("total_cost_usd"),
        "duration_ms": extra.get("duration_ms"),
        "num_turns": extra.get("num_turns"),
        "session_id": extra.get("session_id"),
        "run_id": args.run_id,
        "run_url": args.run_url,
        "commit": args.commit,
    }
    payload = json.dumps(record, indent=2, ensure_ascii=False) + "\n"

    # Visible in the public run log on purpose: token counts are not sensitive, and
    # seeing them here is what makes a broken ledger obvious.
    print(json.dumps(record, ensure_ascii=False))

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
