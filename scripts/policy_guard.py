"""Structural guard for autonomous pull requests.

Two rules the ACCEPTOR role must not be the only thing enforcing:

1. A change to automation policy (workflows, AGENTS.md, runbooks) may not be bundled
   with a change to product code. Policy is reviewed alone, so that widening what
   agents may do can never ride along inside a feature diff.
2. No credential-shaped string, and no path into a local home directory, enters the
   repository.

Exit code 0 means the change is allowed to proceed, 1 means it is refused.
The guard is intentionally simple: it is a negative control, not a linter.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

POLICY_PREFIXES = (
    ".github/workflows/",
    "docs/zendev/",
    # The control plane itself. Everything under scripts/ decides how the loop behaves:
    # when agents wake, what may cross the mirror boundary, what this guard refuses.
    # Left unclassified, an agent could weaken this very file, adjust its tests to
    # match, and have the change merged with no person involved.
    "scripts/",
)
POLICY_FILES = ("AGENTS.md",)

PRODUCT_PREFIXES = (
    # Canonical TypeScript engine. Everything from M1 lives here.
    "src/",
    # Legacy C#, kept as a reference oracle until M12.
    "TradeCraftSimulation/",
    "TradeCraftSimulation.Tests/",
)

# Deliberately narrow: each pattern matches a credential shape, not a English word.
SECRET_PATTERNS = (
    ("Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}")),
    ("Claude OAuth token", re.compile(r"sk-ant-oat[A-Za-z0-9_\-]{8,}")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}")),
    ("GitHub fine-grained token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}")),
    ("Private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("Service account key", re.compile(r'"type"\s*:\s*"service_account"')),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
)

# A path into somebody's home directory names the machine a change was made on, and
# usually the person. It is not a credential, so it gets its own class and its own
# message, but it is refused for the same reason: it must not enter a public
# repository, and until now noticing it was left entirely to the reviewing model.
LOCAL_PATH_PATTERNS = (
    (
        "Windows home directory path",
        re.compile(r"\b[A-Za-z]:[\\/](?:Users|home)[\\/][^\\/\s\"']+"),
    ),
    (
        "POSIX home directory path",
        re.compile(r"(?<![\w.-])/(?:home|Users)/[^/\s\"']+"),
    ),
)

# The hosted runner's own working directory is a fixed, published path that names no
# person and no private machine. Workflows may legitimately refer to it.
#
# Assembled from fragments, like the fixtures in the test: written as one literal, this
# line is itself a home-directory path, and the guard refused the pull request that
# introduced it. Exempting this file instead would have put a hole in the scanner at
# the one place a hole is least acceptable.
_RUNNER_HOME = "/" + "home/runner"
LOCAL_PATH_EXEMPTIONS = (re.compile("^" + re.escape(_RUNNER_HOME) + r"(?:/|$)"),)


def is_policy(path: str) -> bool:
    return path in POLICY_FILES or path.startswith(POLICY_PREFIXES)


def is_product(path: str) -> bool:
    return path.startswith(PRODUCT_PREFIXES)


def classify(paths):
    """Split changed paths into the policy set and the product set."""
    return (
        sorted(p for p in paths if is_policy(p)),
        sorted(p for p in paths if is_product(p)),
    )


def scan_secrets(added_lines):
    """Return (label, line) for every added line that looks like a credential."""
    findings = []
    for line in added_lines:
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(line):
                findings.append((label, line.strip()[:120]))
                break
    return findings


def scan_local_paths(added_lines):
    """Return (label, line) for every added line carrying a local machine path."""
    findings = []
    for line in added_lines:
        for label, pattern in LOCAL_PATH_PATTERNS:
            match = pattern.search(line)
            if not match:
                continue
            if any(e.match(match.group(0)) for e in LOCAL_PATH_EXEMPTIONS):
                continue
            findings.append((label, line.strip()[:120]))
            break
    return findings


def check(paths, added_lines):
    """Pure policy decision. Returns a list of human-readable violations."""
    violations = []

    policy, product = classify(paths)
    if policy and product:
        violations.append(
            "policy and product code changed in one pull request; split them.\n"
            f"  policy:  {', '.join(policy)}\n"
            f"  product: {', '.join(product)}"
        )

    for label, line in scan_secrets(added_lines):
        violations.append(f"possible {label} in an added line: {line}")

    for label, line in scan_local_paths(added_lines):
        violations.append(f"{label} in an added line: {line}")

    return violations


def _git(args):
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def collect(base: str):
    paths = [p for p in _git(["diff", "--name-only", f"{base}...HEAD"]).splitlines() if p]
    diff = _git(["diff", "--unified=0", f"{base}...HEAD"])
    added = [
        line[1:]
        for line in diff.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    ]
    return paths, added


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="base ref to compare against")
    args = parser.parse_args()

    paths, added = collect(args.base)
    violations = check(paths, added)

    if not violations:
        print(f"policy-guard: passed over {len(paths)} changed file(s)")
        return 0

    for violation in violations:
        print(f"::error::policy-guard: {violation}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
