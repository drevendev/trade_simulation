"""Read how much of the subscription's rate-limit windows is in use, so a run's share
can be recorded.

The loop authenticates with a Claude subscription token, and a subscription is not
metered in dollars. It is metered in rolling windows — five hours and seven days — each
reported as a utilization percentage, the same figures Claude Code shows on its own
usage screen. The ledger's ``total_cost_usd`` is what the same tokens would cost at API
list prices; it says nothing about how close the loop is to the ceiling that actually
stops it. This reads that ceiling once before the model runs and once after, and the
difference is the run's share of the subscription.

Three rules, the same ones ``record_usage.py`` lives by:

- **It never fails the run.** No token, a 429, a timeout, a body that is not JSON: each
  writes a file saying the reading is unavailable, and exits 0.
- **Unknown is not zero.** An unavailable reading is ``available: false`` with a reason,
  and the recorder turns that into nulls — never into a zero delta.
- **It prints nothing it read.** Neither the token nor the response body appears in the
  log, only whether the reading succeeded. The figures themselves reach the private
  ledger through the recorder and stay out of the public run log.

The endpoint is the one Claude Code itself uses. It is not a documented public API, so
this reads defensively: only the two fields per window that the ledger needs are kept,
and any surprise in the shape becomes "unavailable" rather than a crash or a guess.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN"

# Both headers are load-bearing. Without the beta header the endpoint does not accept
# an OAuth token at all; without a Claude Code user agent it rate-limits aggressively
# and answers 429 to everything.
BETA_HEADER = "oauth-2025-04-20"
USER_AGENT = "claude-code/2.1.0"

# The windows the ledger records. `five_hour` and `seven_day` are the two that gate the
# loop; the per-model weekly windows exist on some plans and are kept when present.
WINDOWS = ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet")
KEPT_FIELDS = ("utilization", "resets_at")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def summarize(payload):
    """Keep only utilization and reset time per window. Pure.

    Everything else the endpoint returns — credits, limits, flags — is dropped here, so
    the ledger never accumulates fields nobody asked for, and a shape change upstream
    can at worst turn one window into null.
    """
    windows = {}
    for name in WINDOWS:
        block = payload.get(name) if isinstance(payload, dict) else None
        if not isinstance(block, dict):
            windows[name] = None
            continue
        utilization = block.get("utilization")
        if isinstance(utilization, bool) or not isinstance(utilization, (int, float)):
            utilization = None
        resets_at = block.get("resets_at")
        if not isinstance(resets_at, str):
            resets_at = None
        windows[name] = {"utilization": utilization, "resets_at": resets_at}
    return windows


def unavailable(reason: str, error_message=None):
    return {
        "available": False,
        "reason": reason,
        "error_message": error_message,
        "fetched_at": now_iso(),
        **{name: None for name in WINDOWS},
    }


def error_detail(exc):
    """The API's own account of a refusal: its error type and message. Pure over the body.

    Every reading since the first one came back `HTTP 403`, and a status code alone
    cannot say whether the token lacks a scope, the endpoint moved, or a proxy refused
    the runner. The error body can: it is JSON with an `error.type` and an
    `error.message`, and neither carries the token. The type joins the reason, which is
    printed; the message stays in the reading, which reaches the private ledger only.
    """
    try:
        # Enough for any error document; the message itself is cut to 200 characters
        # below, so what reaches the ledger is a line, never a page.
        body = exc.read(65536)
    except (OSError, AttributeError, ValueError):
        return None, None
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except (json.JSONDecodeError, AttributeError):
        return None, None
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict):
        return None, None
    kind = error.get("type")
    message = error.get("message")
    return (
        kind if isinstance(kind, str) and kind else None,
        message[:200] if isinstance(message, str) and message else None,
    )


def fetch(token: str, timeout: float = 20.0):
    request = urllib.request.Request(
        ENDPOINT,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": BETA_HEADER,
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def read(token: str, fetcher=fetch):
    """One reading, or an unavailable record naming the class of failure. Never raises."""
    if not token:
        return unavailable("no token in the environment")
    try:
        payload = fetcher(token)
    except urllib.error.HTTPError as exc:
        # The status code and the API's error type go into the reason; the error
        # message goes into the reading only. Neither contains the token.
        kind, message = error_detail(exc)
        return unavailable(f"HTTP {exc.code}" + (f" {kind}" if kind else ""), message)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return unavailable(type(exc).__name__)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return unavailable("malformed body")
    if not isinstance(payload, dict):
        return unavailable("malformed body")
    return {
        "available": True,
        "reason": None,
        "error_message": None,
        "fetched_at": now_iso(),
        **summarize(payload),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="where to write the reading as JSON")
    args = parser.parse_args()

    reading = read(os.environ.get(TOKEN_VARIABLE, ""))
    path = pathlib.Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(reading, indent=2) + "\n", encoding="utf-8")

    # The figures stay out of the public log on purpose; only the fact of a reading.
    if reading["available"]:
        print("subscription_usage: reading recorded")
    else:
        print(f"::warning::subscription_usage: reading unavailable ({reading['reason']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
