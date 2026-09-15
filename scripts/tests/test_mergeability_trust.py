"""The required `mergeability` status is written by `master`'s code, and by nothing else.

#495. The workflow that writes that status used to run on a push to *any* branch, from
that branch's own copy of its definition and of `scripts/mergeability.py`, with
`statuses: write` — and fan the verdict out over every open pull request. A branch that
changed the classifier, on purpose or by mistake, judged every other branch with it,
unreviewed. The same file guarded its three MACHINE-identity steps against exactly that
and left the status writer unguarded.

The repair is a trust boundary, not a condition: every run of the workflow executes
`master`'s definition and `master`'s scripts. Pull request activity arrives as
`pull_request_target`, which runs in the context of the base and — unlike
`pull_request` — fires for a conflicting pull request too, so a branch force-pushed
into a conflicting state is still marked red on its own head. The fan-out over all open
pull requests runs from `master` only. Nothing checks out or executes the judged
revision.

These assertions are what keeps the boundary from eroding one edit at a time: a
`pull_request` trigger reintroduced for a quick check, a `ref:` on the checkout to test
a branch, a branch filter dropped from `push`. Each would pass review as a small change
and each reopens the hole, so each is refused here by name.

Text assertions rather than a YAML parse, like the other workflow tests: this must run
in the policy-guard job with nothing but the standard library. The checks are functions
of the text, and the synthetic cases below prove they fire on the text that would
violate them — a check that only ever sees the shipped file cannot be told apart from
one that checks nothing.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "mergeability.yml"

FAN_OUT = "--all-open"
ONE_PULL = "--pull"
MASTER_ONLY = "github.ref == 'refs/heads/master'"
NOT_A_PULL_REQUEST = "github.event_name != 'pull_request_target'"
A_PULL_REQUEST = "github.event_name == 'pull_request_target'"

# Every step that carries authority beyond the event's own pull request: the status
# fan-out, and the three that hold a credential able to push. Each must run from
# `master` only, and never on a pull request event, whose `github.ref` is `master` too.
PRIVILEGED = ("mergeability.py", "create-github-app-token", "update_branches.py",
              "resolve_ledger_conflicts.py")


def text():
    return WORKFLOW.read_text(encoding="utf-8")


def triggers(body):
    """The `on:` block, as {event: the lines indented under it}. Pure."""
    block = re.search(r"^on:\n((?:(?:[ ]+\S.*)?\n)*)", body, re.MULTILINE).group(1)
    found = {}
    for match in re.finditer(r"^  ([\w]+):[^\n]*\n((?:    [^\n]*\n)*)", block, re.MULTILINE):
        found[match.group(1)] = match.group(2)
    return found


def steps(body):
    """Each step's text, split on the list markers at step indentation. Pure."""
    starts = [m.start() for m in re.finditer(r"^      - (?:name|uses|id):", body, re.MULTILINE)]
    starts.append(len(body))
    return [body[a:b] for a, b in zip(starts, starts[1:])]


def condition(step):
    match = re.search(r"^\s+if:\s*(.+?)\s*$", step, re.MULTILINE)
    return match.group(1) if match else ""


def violations(body):
    """Every way `body` lets code other than `master`'s write the status. Pure.

    A list of sentences rather than a boolean, so a failure names the edit that caused
    it. Empty means the boundary holds.
    """
    found = []
    events = triggers(body)

    if "pull_request" in events:
        found.append("`pull_request` runs the judged branch's own definition and scripts; "
                     "pull request activity must arrive as `pull_request_target`")
    if "pull_request_target" not in events:
        found.append("no `pull_request_target` trigger: a conflicting pull request would "
                     "get no run and no red status on its head")
    push = events.get("push")
    if push is None:
        found.append("no `push` trigger: `master` moving would re-measure nothing")
    elif not re.search(r"^\s+branches:\s*\[\s*master\s*\]\s*$", push, re.MULTILINE):
        found.append("`push` is not filtered to `master`; a push to any other branch would "
                     "run that branch's unreviewed definition with `statuses: write`")

    if re.search(r"pull_request\.head\.", body):
        found.append("the judged revision's head is referenced; nothing here may check "
                     "out or execute it")

    all_steps = steps(body)
    checkouts = [s for s in all_steps if "actions/checkout" in s]
    if not checkouts:
        found.append("no checkout step found; the scan is not seeing the workflow")
    for step in checkouts:
        if re.search(r"^\s+ref:", step, re.MULTILINE):
            found.append("the checkout names a `ref:`; the base branch, which is the "
                         "default, is the only revision that may run here")

    for step in all_steps:
        privileged = any(marker in step for marker in PRIVILEGED) and ONE_PULL not in step
        if privileged:
            guard = condition(step)
            if MASTER_ONLY not in guard or NOT_A_PULL_REQUEST not in guard:
                found.append(f"a privileged step is not confined to `master` pushes and "
                             f"dispatches: `if: {guard or '<none>'}`")
        if ONE_PULL in step:
            if condition(step) != A_PULL_REQUEST:
                found.append("the single-pull-request step must run on "
                             "`pull_request_target` and nothing else")
            if FAN_OUT in step:
                found.append("the single-pull-request step fans out")

    return found


class BoundaryHoldsTests(unittest.TestCase):
    def test_the_shipped_workflow_has_no_violation(self):
        self.assertEqual(violations(text()), [])

    def test_the_scan_sees_what_it_guards(self):
        # Without this, every assertion above passes on a file the patterns stopped
        # matching — the vacuous pass this repository keeps rediscovering.
        body = text()
        found = steps(body)
        self.assertEqual(sum(1 for s in found if FAN_OUT in s and "mergeability.py" in s), 1)
        self.assertEqual(sum(1 for s in found if ONE_PULL in s), 1)
        self.assertEqual(sum(1 for s in found if "create-github-app-token" in s), 1)
        self.assertGreaterEqual(sum(1 for s in found if "--all-open" in s), 3)
        self.assertEqual(set(triggers(body)), {"pull_request_target", "push", "workflow_dispatch"})

    def test_the_token_is_no_wider_than_the_status(self):
        # Non-goal of #495 made mechanical: the repair must not widen the grant.
        block = re.search(r"^permissions:\n((?:  .*\n)*)", text(), re.MULTILINE).group(1)
        grants = dict(re.findall(r"^  ([\w-]+):\s*(\w+)\s*$", block, re.MULTILINE))
        self.assertEqual(grants, {"contents": "read", "pull-requests": "read", "statuses": "write"})


class BoundaryErodesTests(unittest.TestCase):
    """Each edit below is small, plausible, and reopens the hole. Each is refused."""

    def setUp(self):
        self.body = text()
        self.assertEqual(violations(self.body), [], "the fixture must start clean")

    def assert_refused(self, edited, fragment):
        found = violations(edited)
        self.assertTrue(any(fragment in v for v in found), f"expected {fragment!r} in {found}")

    def test_a_push_from_any_branch_is_refused(self):
        edited = self.body.replace("  push:\n    branches: [master]\n", "  push:\n")
        self.assert_refused(edited, "`push` is not filtered to `master`")

    def test_a_push_filter_naming_another_branch_is_refused(self):
        edited = self.body.replace("branches: [master]", "branches: [master, 'claude/**']")
        self.assert_refused(edited, "`push` is not filtered to `master`")

    def test_a_pull_request_trigger_is_refused(self):
        edited = self.body.replace("  pull_request_target:\n", "  pull_request:\n")
        self.assert_refused(edited, "`pull_request` runs the judged branch's own definition")
        self.assert_refused(edited, "no `pull_request_target` trigger")

    def test_a_checkout_of_the_judged_head_is_refused(self):
        edited = self.body.replace(
            "        with:\n          fetch-depth: 0\n",
            "        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n"
            "          fetch-depth: 0\n",
        )
        self.assert_refused(edited, "the checkout names a `ref:`")
        self.assert_refused(edited, "the judged revision's head is referenced")

    def test_an_unguarded_fan_out_is_refused(self):
        edited = self.body.replace(
            "      - name: Status for every open pull request, because the base moved\n"
            f"        if: {NOT_A_PULL_REQUEST} && {MASTER_ONLY}\n",
            "      - name: Status for every open pull request, because the base moved\n",
        )
        self.assertNotEqual(edited, self.body, "the fixture edit must apply")
        self.assert_refused(edited, "a privileged step is not confined")

    def test_a_fan_out_guarded_by_the_ref_alone_is_refused(self):
        # `github.ref` is `master` on a pull request event too, so the ref guard by
        # itself would let a pull request's run write every other pull request's status.
        edited = self.body.replace(
            f"        if: {NOT_A_PULL_REQUEST} && {MASTER_ONLY}\n"
            "        env:\n          GH_TOKEN: ${{ github.token }}\n",
            f"        if: {MASTER_ONLY}\n"
            "        env:\n          GH_TOKEN: ${{ github.token }}\n",
        )
        self.assertNotEqual(edited, self.body, "the fixture edit must apply")
        self.assert_refused(edited, "a privileged step is not confined")

    def test_a_pull_request_step_that_fans_out_is_refused(self):
        edited = self.body.replace(
            '--pull "${PR_NUMBER}"', '--pull "${PR_NUMBER}" --all-open'
        )
        self.assert_refused(edited, "the single-pull-request step fans out")

    def test_a_widened_grant_is_refused(self):
        edited = self.body.replace("  contents: read\n", "  contents: write\n")
        block = re.search(r"^permissions:\n((?:  .*\n)*)", edited, re.MULTILINE).group(1)
        grants = dict(re.findall(r"^  ([\w-]+):\s*(\w+)\s*$", block, re.MULTILINE))
        self.assertNotEqual(
            grants, {"contents": "read", "pull-requests": "read", "statuses": "write"}
        )


if __name__ == "__main__":
    unittest.main()
