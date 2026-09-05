"""Every subprocess in the control plane decodes as UTF-8, not by locale.

`subprocess.run(..., text=True)` without `encoding` decodes with the platform's
preferred encoding. On the hosted runner that is UTF-8, so this is invisible there. On
a Windows console it is cp1252, and a single non-ASCII byte — an em dash in a pull
request title, a mirrored handoff filename — raises inside the reader thread. The
exception does not propagate: `stdout` comes back as `None` and the caller fails
several frames later on something that looks unrelated. `check=True` does not fire,
because the process exited fine.

This was found twice. `machine_pr_guard.py` learned it in #111 after the guard refused
the first real mirror. Three other scripts had the same call shape and nobody looked,
because the runner never showed it — and the runner is not where the control plane is
developed or debugged.

A rule enforced in one file is a habit. This makes it a property of the directory.
"""

import ast
import pathlib
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]


def subprocess_run_calls(tree):
    """Every `subprocess.run(...)` call node in a parsed module."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "run"
            and isinstance(func.value, ast.Name)
            and func.value.id == "subprocess"
        ):
            yield node


class SubprocessEncodingTests(unittest.TestCase):
    def modules(self):
        return sorted(SCRIPTS.glob("*.py"))

    def test_every_subprocess_run_pins_the_encoding(self):
        offenders = []
        for path in self.modules():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for call in subprocess_run_calls(tree):
                keywords = {k.arg for k in call.keywords}
                if "encoding" not in keywords:
                    offenders.append(f"{path.name}:{call.lineno}")
        self.assertEqual(
            offenders,
            [],
            "subprocess.run without encoding= decodes by locale; "
            f"pin encoding=\"utf-8\" at: {offenders}",
        )

    def test_the_scan_actually_finds_calls(self):
        # Without this the test above passes on an empty set — the vacuous-pass shape
        # this repository keeps rediscovering. Every module that shells out must be
        # visible to the walker.
        found = sum(
            len(list(subprocess_run_calls(ast.parse(p.read_text(encoding="utf-8")))))
            for p in self.modules()
        )
        self.assertGreaterEqual(found, 4, "the walker found almost no subprocess calls")

    def test_a_call_without_encoding_is_detected(self):
        # Negative control on the detector itself, not on the tree: prove it would
        # object if a bare call appeared.
        tree = ast.parse("import subprocess\nsubprocess.run(['gh'], text=True)\n")
        call = next(subprocess_run_calls(tree))
        self.assertNotIn("encoding", {k.arg for k in call.keywords})


if __name__ == "__main__":
    unittest.main()
