"""Print bounded npm-audit advisory evidence without disguising outstanding risk.

Exit 0 for a valid audit report, including findings (triage is not remediation).
Exit nonzero when the audit itself was unavailable or returned invalid JSON.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def _safe(value: object) -> str:
    """Keep registry-controlled values from producing multiline log commands."""
    return " ".join(str(value).split()).replace("|", "/")[:180]


def _lock_scope(nodes: object, packages: dict) -> str:
    if not isinstance(nodes, list) or not nodes:
        return "unknown"
    flags = []
    for node in nodes:
        entry = packages.get(node) if isinstance(node, str) else None
        flags.append(entry.get("dev") is True if isinstance(entry, dict) else None)
    if all(flag is True for flag in flags):
        return "dev-only"
    if any(flag is False for flag in flags):
        return "non-dev"
    return "unknown"


def summarize(report: dict, lockfile: dict) -> str:
    if not isinstance(report, dict) or report.get("error"):
        raise ValueError(f"npm audit error: {_safe(report.get('error') if isinstance(report, dict) else report)}")
    findings = report.get("vulnerabilities")
    packages = lockfile.get("packages") if isinstance(lockfile, dict) else None
    if not isinstance(findings, dict) or not isinstance(packages, dict):
        raise ValueError("npm audit or package-lock.json is missing the required object fields")
    metadata = report.get("metadata") or {}
    totals = metadata.get("vulnerabilities") or {} if isinstance(metadata, dict) else {}
    if not isinstance(totals, dict):
        totals = {}
    counts = ", ".join(f"{key}={totals.get(key, '?')}" for key in ("critical", "high", "moderate", "low"))
    lines = [f"npm audit: {len(findings)} affected package(s); {counts}.",
             "Scope describes lockfile dependency classification, NOT exploit reachability.",
             "This is diagnostic evidence: findings remain open until separately remediated."]
    for package, detail in sorted(findings.items()):
        if not isinstance(detail, dict):
            raise ValueError(f"npm audit entry for {_safe(package)} is malformed")
        via = detail.get("via") or []
        if not isinstance(via, list):
            raise ValueError(f"npm audit entry for {_safe(package)} has malformed via")
        references = []
        for item in via:
            if isinstance(item, dict):
                references.append(_safe(item.get("url") or item.get("source") or "advisory"))
            elif isinstance(item, str):
                references.append("via:" + _safe(item))
        fix = detail.get("fixAvailable")
        if isinstance(fix, dict):
            fix_text = f"{_safe(fix.get('name', package))}@{_safe(fix.get('version', '?'))} (major={bool(fix.get('isSemVerMajor'))})"
        else:
            fix_text = str(fix) if isinstance(fix, bool) else "unknown"
        lines.append(
            f"{_safe(detail.get('severity', 'unknown')).upper()} {_safe(package)} "
            f"[{_lock_scope(detail.get('nodes'), packages)}] "
            f"range={_safe(detail.get('range', '?'))}; fix={fix_text}; "
            f"references={', '.join(references[:8]) or 'none'}"
        )
    return "\n".join(lines)


def run_audit(runner=subprocess.run) -> dict:
    result = runner(["npm", "audit", "--json"], capture_output=True, text=True,
                    timeout=90, check=False)
    if result.returncode not in (0, 1):
        raise ValueError(f"npm audit command failed with exit {result.returncode}: {_safe(result.stderr)}")
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError(f"npm audit returned invalid JSON (exit {result.returncode})") from error
    if not isinstance(report, dict) or report.get("error"):
        raise ValueError(f"npm audit API error: {_safe(report.get('error') if isinstance(report, dict) else report)}")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-json", type=Path, help="read a captured audit report instead of invoking npm")
    parser.add_argument("--lockfile", type=Path, default=Path("package-lock.json"))
    args = parser.parse_args(argv)
    try:
        lock = json.loads(args.lockfile.read_text(encoding="utf-8"))
        report = (json.loads(args.report_json.read_text(encoding="utf-8"))
                  if args.report_json else run_audit())
        print(summarize(report, lock))
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"::error::npm audit evidence unavailable: {_safe(error)}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
