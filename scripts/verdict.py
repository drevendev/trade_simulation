"""Shared verdict detection for review comments and GitHub reviews.

Two shapes are recognized:
- Marked verdicts: ## VERDICT: ACCEPT or **REQUEST_CHANGES**
- Bare verdicts: ACCEPT or REQUEST_CHANGES at the start of a line

Both are case-insensitive.
"""

import re

# A verdict announces itself, and the two shapes below are the two ways it does.
#
# Both anchor to the start of a line, so a sentence *about* a verdict stays prose —
# "the previous REQUEST_CHANGES asked for a label fix" must remain a correction, or
# the same-head exception could never fire and a corrected pull request would be
# stuck forever.
#
# A heading or bold marker is matched case-insensitively, because a model writing
# "## Accept" means the verdict and missing it would restart the re-review loop this
# exists to stop. A bare word with no marker must be the shouted form the runbook
# specifies; anything less would swallow ordinary sentences that open with "Accept".
MARKED_VERDICT = re.compile(
    r"^\s*(?:#{1,4}\s*|\*\*)\s*(?:VERDICT\s*[:\-—]\s*)?"
    r"(?:ACCEPT|REQUEST_CHANGES)\b",
    re.MULTILINE | re.IGNORECASE,
)
BARE_VERDICT = re.compile(r"^\s*(?:ACCEPT|REQUEST_CHANGES)\b", re.MULTILINE)


def is_verdict(body: str) -> bool:
    """Whether this text contains a verdict announcement."""
    body = body or ""
    return bool(MARKED_VERDICT.search(body) or BARE_VERDICT.search(body))


def extract_verdict_text(body: str) -> str:
    """Extract the verdict word (ACCEPT or REQUEST_CHANGES) from a body, or empty string."""
    body = body or ""
    # Try marked verdict first
    match = MARKED_VERDICT.search(body)
    if match:
        # Extract the verdict word from the matched text
        text = match.group()
        if "ACCEPT" in text.upper():
            return "ACCEPT"
        elif "REQUEST_CHANGES" in text.upper():
            return "REQUEST_CHANGES"
    # Try bare verdict
    match = BARE_VERDICT.search(body)
    if match:
        text = match.group().strip().upper()
        if "ACCEPT" in text:
            return "ACCEPT"
        elif "REQUEST_CHANGES" in text:
            return "REQUEST_CHANGES"
    return ""
