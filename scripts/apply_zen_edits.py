"""Apply exact-text edits an author committed as `.zen/edits/*.edit` files, and nothing else.

An author outside the loop — the researcher, under scheme/8 — writes files through the
forge's contents API: whole files, no checkout, no `git apply`. For a small file that is
enough. For a large one it is a trap: on #550 the change was one import and one line in
`src/config/simulationConfig.ts`, and three attempts to submit the whole file each lost a
hundred and sixty lines of documentation, were reverted a minute later, and earned a
refusal — six refusals in twelve hours over two lines. On #546 the same author tried to
invent this mechanism inside its own branch, by adding a job to `ci.yml`, which the
policy guard rightly refused.

So the mechanism is provided, from `master`. The author commits a small edit file; the
`zen-edit` workflow runs **this** script from `master` over the branch checked out as
data, and the MACHINE identity pushes the result. The edit file is a list of exact-text
replacements — the format that survives being written without a working tree, because
it has no line numbers and no hunk counts to get wrong:

    ### FILE: src/config/simulationConfig.ts
    <<<<<<< FIND
        population: {
    =======
        population: createDefaultPopulationConfig(),
    >>>>>>> REPLACE

Rules, each because the alternative is a silent wrong edit:

* `FIND` must occur **exactly once** in the file as it stands when the block is reached.
  Zero is a stale edit, two is an ambiguous one; both are refused by name.
* Blocks apply in order; several blocks and several `### FILE:` sections are allowed.
* **All or nothing.** One refused block and no file is touched, no commit is made.
* Only existing regular UTF-8 files inside the repository, and never the control plane
  (`.github/`, `scripts/`, `docs/zendev/`, `AGENTS.md`), the machine-owned mirror
  (`docs/spec/mirror/`) or `.zen/` itself. The control plane is changed by reviewed
  pull requests written as such, not through a side door that writes as the MACHINE.
* Applied edit files are deleted in the same commit, so the pull request's diff carries
  the edits and not the instructions.

Nothing here executes anything from the branch. It reads text, replaces text, writes
text; the workflow around it never runs the branch's code either, and
`scripts/tests/test_apply_zen_edits.py` holds both to that.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

EDITS_DIR = ".zen/edits"
EDIT_SUFFIX = ".edit"

FILE_MARK = "### FILE:"
FIND_MARK = "<<<<<<< FIND"
SPLIT_MARK = "======="
REPLACE_MARK = ">>>>>>> REPLACE"

FORBIDDEN_PREFIXES = (".github/", "scripts/", "docs/zendev/", "docs/spec/mirror/", ".zen/", ".git/")
FORBIDDEN_FILES = ("AGENTS.md",)

MAX_EDIT_FILES = 10
MAX_EDIT_BYTES = 200_000
MAX_TARGET_BYTES = 2_000_000
MAX_BLOCKS = 40


class Refusal(Exception):
    """An edit that cannot be applied as written. The message is for the author."""


def parse(text: str):
    """`[(path, [(find, replace), ...]), ...]` from one edit file. Pure.

    Marker lines are matched after stripping trailing whitespace; every other line is
    taken verbatim. A line of seven `=` inside FIND or REPLACE text cannot be expressed
    in this format — widen the block to avoid it.
    """
    sections = []
    path = None
    blocks = None
    state = "idle"  # idle | find | replace
    find_lines = replace_lines = None
    for number, raw in enumerate(text.replace("\r\n", "\n").split("\n"), start=1):
        line = raw.rstrip()
        if state == "idle":
            if line.startswith(FILE_MARK):
                path = line[len(FILE_MARK):].strip().strip("`")
                if not path:
                    raise Refusal(f"line {number}: `{FILE_MARK}` names no path")
                blocks = []
                sections.append((path, blocks))
            elif line == FIND_MARK:
                if path is None:
                    raise Refusal(f"line {number}: a FIND block before any `{FILE_MARK}` line")
                state, find_lines = "find", []
            elif line in (SPLIT_MARK, REPLACE_MARK):
                raise Refusal(f"line {number}: `{line}` outside a block")
            # anything else between blocks is commentary and is ignored
        elif state == "find":
            if line == SPLIT_MARK:
                state, replace_lines = "replace", []
            elif line in (FIND_MARK, REPLACE_MARK) or line.startswith(FILE_MARK):
                raise Refusal(f"line {number}: `{line}` inside a FIND block; expected `{SPLIT_MARK}`")
            else:
                find_lines.append(raw)
        else:  # replace
            if line == REPLACE_MARK:
                blocks.append(("\n".join(find_lines), "\n".join(replace_lines)))
                state = "idle"
            elif line in (FIND_MARK, SPLIT_MARK) or line.startswith(FILE_MARK):
                raise Refusal(f"line {number}: `{line}` inside a REPLACE block; expected `{REPLACE_MARK}`")
            else:
                replace_lines.append(raw)
    if state != "idle":
        raise Refusal(f"the last block is not closed with `{REPLACE_MARK}`")
    if not sections:
        raise Refusal(f"no `{FILE_MARK}` section found")
    for path, found in sections:
        if not found:
            raise Refusal(f"`{path}`: the section has no FIND/REPLACE block")
    return sections


def path_refusal(path: str):
    """Why `path` may not be edited through this door, or None. Pure."""
    if not path or path.startswith("/") or "\\" in path or ":" in path:
        return "not a repository-relative POSIX path"
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return "not a normalized repository-relative path"
    if path in FORBIDDEN_FILES or path.startswith(FORBIDDEN_PREFIXES):
        return "control plane, mirror and `.zen/` are not editable through zen-edit"
    return None


def replace_once(text: str, find: str, replace: str, where: str) -> str:
    """`text` with the single occurrence of `find` replaced. Pure."""
    if not find:
        raise Refusal(f"{where}: FIND is empty")
    count = text.count(find)
    if count == 0:
        raise Refusal(f"{where}: FIND text not found; the file may have changed, or the "
                      "indentation differs — FIND must match character for character")
    if count > 1:
        raise Refusal(f"{where}: FIND text occurs {count} times and must occur exactly once; "
                      "add surrounding lines to make it unique")
    return text.replace(find, replace)


def apply_to_text(original: str, blocks, path: str) -> str:
    """Every block applied in order to `original`, in the file's own line endings. Pure."""
    crlf = "\r\n" in original
    text = original.replace("\r\n", "\n")
    for index, (find, replace) in enumerate(blocks, start=1):
        text = replace_once(text, find, replace, f"`{path}` block {index}")
    return text.replace("\n", "\r\n") if crlf else text


def plan(work: pathlib.Path):
    """`(edit_files, {target: new_text})` for everything under `.zen/edits`, or raise.

    Computed entirely in memory: the caller writes only when the whole plan succeeded.
    """
    directory = work / EDITS_DIR
    edit_files = sorted(p for p in directory.glob(f"*{EDIT_SUFFIX}") if p.is_file()) if directory.is_dir() else []
    if not edit_files:
        return [], {}
    if len(edit_files) > MAX_EDIT_FILES:
        raise Refusal(f"{len(edit_files)} edit files; at most {MAX_EDIT_FILES} per push")
    texts = {}
    root = work.resolve()
    for edit_file in edit_files:
        name = edit_file.relative_to(work).as_posix()
        if edit_file.is_symlink() or edit_file.stat().st_size > MAX_EDIT_BYTES:
            raise Refusal(f"`{name}`: not a regular file under {MAX_EDIT_BYTES} bytes")
        try:
            sections = parse(edit_file.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            raise Refusal(f"`{name}`: not UTF-8 text") from None
        except Refusal as error:
            raise Refusal(f"`{name}`: {error}") from None
        if sum(len(blocks) for _, blocks in sections) > MAX_BLOCKS:
            raise Refusal(f"`{name}`: more than {MAX_BLOCKS} blocks")
        for path, blocks in sections:
            reason = path_refusal(path)
            if reason:
                raise Refusal(f"`{name}`: `{path}` — {reason}")
            target = work / path
            if target.is_symlink() or not target.is_file():
                raise Refusal(f"`{name}`: `{path}` is not an existing regular file; zen-edit "
                              "changes files, the contents API creates them")
            if root not in target.resolve().parents:
                raise Refusal(f"`{name}`: `{path}` resolves outside the repository")
            if target.stat().st_size > MAX_TARGET_BYTES:
                raise Refusal(f"`{name}`: `{path}` is larger than {MAX_TARGET_BYTES} bytes")
            if path not in texts:
                try:
                    texts[path] = target.read_bytes().decode("utf-8")
                except UnicodeDecodeError:
                    raise Refusal(f"`{name}`: `{path}` is not UTF-8 text") from None
            try:
                texts[path] = apply_to_text(texts[path], blocks, path)
            except Refusal as error:
                raise Refusal(f"`{name}`: {error}") from None
    return edit_files, texts


def execute(work: pathlib.Path):
    """Apply the plan to disk. Returns `(outcome, report_markdown, names)`."""
    try:
        edit_files, texts = plan(work)
    except Refusal as error:
        report = (
            "## zen-edit: not applied\n\n"
            f"{error}\n\n"
            "Nothing was changed and no commit was made: edits apply all together or not "
            "at all. Correct the `.edit` file and push again; the format and its rules are "
            "in `docs/zendev/ENDLESSZEN_AUTHOR.md`.\n"
        )
        return "refused", report, []
    if not edit_files:
        return "none", "", []
    for path, text in texts.items():
        (work / path).write_bytes(text.encode("utf-8"))
    names = []
    for edit_file in edit_files:
        names.append(edit_file.relative_to(work).as_posix())
        edit_file.unlink()
    lines = ["## zen-edit: applied", ""]
    lines += [f"- `{path}`" for path in sorted(texts)]
    lines += ["", "From " + ", ".join(f"`{name}`" for name in names) + ", removed in the same "
              "commit. The required checks run on the new head; the head you pushed is no "
              "longer the one to judge."]
    return "applied", "\n".join(lines) + "\n", names


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, help="the branch checkout to edit")
    parser.add_argument("--report", default=None, help="write the pull-request comment here")
    parser.add_argument("--names", default=None, help="write the applied edit file names here")
    args = parser.parse_args(argv)

    outcome, report, names = execute(pathlib.Path(args.work))
    print(f"zen-edit: {outcome}")
    if report:
        print(report)
        if args.report:
            pathlib.Path(args.report).write_text(report, encoding="utf-8")
    if args.names:
        pathlib.Path(args.names).write_text(", ".join(names), encoding="utf-8")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"outcome={outcome}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
