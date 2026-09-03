"""Strip the extension Google Drive appends when exporting a native document.

A Google Doc titled `SPEC_INDEX.md` exports to `SPEC_INDEX.md.md`, and a Google Sheet
titled `REQUIREMENTS_REGISTRY.csv` exports to `REQUIREMENTS_REGISTRY.csv.csv`. The
specification refers to files by their intended names, so the mirror normalizes them.

This runs over a fresh staging copy, never over the committed mirror: renaming files
underneath rclone would make the next sync see them as missing, re-download them and
delete the renamed ones on every run.

A rename that would overwrite an existing file is refused and reported. Two documents
resolving to one name is a collision in the specification, not something to resolve by
picking a winner silently.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

DOUBLED = (".md.md", ".csv.csv", ".txt.txt")


def intended_name(name: str) -> str | None:
    """Return the normalized name, or None when the name is already correct."""
    for suffix in DOUBLED:
        if name.endswith(suffix):
            return name[: -len(suffix)] + suffix[len(suffix) // 2 :]
    return None


def plan(names):
    """Map each name that needs renaming to its target. Pure, so it is testable."""
    return {name: target for name in names if (target := intended_name(name))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", help="staging directory to normalize in place")
    args = parser.parse_args()

    root = pathlib.Path(args.root)
    if not root.is_dir():
        print(f"::error::normalize_mirror: {root} is not a directory")
        return 1

    conflicts = []
    renamed = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        target_name = intended_name(path.name)
        if target_name is None:
            continue
        target = path.with_name(target_name)
        if target.exists():
            conflicts.append(f"{path.relative_to(root)} -> {target.name} already exists")
            continue
        path.rename(target)
        renamed += 1
        print(f"normalize_mirror: {path.name} -> {target.name}")

    if conflicts:
        for conflict in conflicts:
            print(f"::error::normalize_mirror: {conflict}")
        return 1

    print(f"normalize_mirror: {renamed} file(s) normalized")
    return 0


if __name__ == "__main__":
    sys.exit(main())
