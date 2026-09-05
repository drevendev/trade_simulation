"""Each role acts through its own GitHub App, and no personal token remains.

ADR 0006. The AUTHOR and the ACCEPTOR authenticate as two different applications, so
the forge can tell them apart; the roles that run no model act as a third. Every token
is minted inside the job that uses it, for one repository, and dies with the job. A
personal access token anywhere in the workflows would undo all of that at once — one
identity for every role, one credential that expires on a date nobody watches — so its
absence is asserted here, not assumed.

Text assertions rather than a YAML parse, like the other workflow tests: this must run
in the policy-guard job with nothing but the standard library.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"

MINT = "uses: actions/create-github-app-token@v3"
AUTHOR = ("vars.ZENDEV_AUTHOR_APP_CLIENT_ID", "secrets.ZENDEV_AUTHOR_APP_PRIVATE_KEY")
ACCEPTOR = ("vars.ZENDEV_ACCEPTOR_APP_CLIENT_ID", "secrets.ZENDEV_ACCEPTOR_APP_PRIVATE_KEY")
MACHINE = ("vars.ZENDEV_MACHINE_APP_CLIENT_ID", "secrets.ZENDEV_MACHINE_APP_PRIVATE_KEY")
THIS_REPOSITORY = "repositories: ${{ github.event.repository.name }}"
LEDGER = "repositories: zen-telemetry"
PERSONAL_TOKENS = ("ZENDEV_PAT", "TELEMETRY_PAT")


def text(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def jobs(name):
    """Split a workflow into its jobs by the two-space-indented job keys."""
    body = text(name)
    starts = [m.start() for m in re.finditer(r"^  [a-z][\w-]*:\s*$", body, re.MULTILINE)]
    starts.append(len(body))
    return [body[a:b] for a, b in zip(starts, starts[1:])]


class NoPersonalTokenTests(unittest.TestCase):
    def test_no_workflow_names_a_personal_access_token(self):
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for token in PERSONAL_TOKENS:
                with self.subTest(workflow=path.name, token=token):
                    self.assertNotIn(token, path.read_text(encoding="utf-8"))

    def test_the_scan_sees_every_workflow(self):
        # Without this the assertion above passes on an empty directory.
        self.assertGreaterEqual(len(list(WORKFLOWS.glob("*.yml"))), 6)


class RoleIdentityTests(unittest.TestCase):
    def assert_role(self, name, mine, others):
        body = text(name)
        for needle in mine:
            self.assertIn(needle, body, f"{name} must act as its own app")
        for other in others:
            for needle in other:
                self.assertNotIn(needle, body, f"{name} must never hold another role's app")
        self.assertIn(THIS_REPOSITORY, body, f"{name} must scope its token to this repository")

    def test_the_author_acts_as_the_author_app_only(self):
        self.assert_role("zendev-author.yml", AUTHOR, [ACCEPTOR])

    def test_the_acceptor_acts_as_the_acceptor_app_only(self):
        self.assert_role("zendev-acceptor.yml", ACCEPTOR, [AUTHOR])

    def test_model_roles_mint_before_they_check_out_and_hand_the_model_the_same_token(self):
        for name in ("zendev-author.yml", "zendev-acceptor.yml"):
            with self.subTest(workflow=name):
                work = [job for job in jobs(name) if "claude-code-action" in job]
                self.assertEqual(len(work), 1, f"{name}: exactly one job runs the model")
                job = work[0]
                self.assertLess(job.index(MINT), job.index("uses: actions/checkout"))
                self.assertIn("token: ${{ steps.identity.outputs.token }}", job)
                self.assertIn("github_token: ${{ steps.identity.outputs.token }}", job)

    def test_the_ledger_is_written_as_the_machine_app_scoped_to_the_ledger(self):
        for name in ("zendev-author.yml", "zendev-acceptor.yml"):
            with self.subTest(workflow=name):
                job = next(j for j in jobs(name) if "claude-code-action" in j)
                ledger = job.index("id: ledger")
                self.assertIn(LEDGER, job[ledger:])
                self.assertIn("continue-on-error: true", job[ledger:])
                self.assertIn("TELEMETRY_TOKEN: ${{ steps.ledger.outputs.token }}", job)
                for needle in MACHINE:
                    self.assertIn(needle, job)

    def test_the_machine_roles_act_as_the_machine_app_only(self):
        for name in ("spec-sync.yml", "mergeability.yml"):
            with self.subTest(workflow=name):
                body = text(name)
                for needle in MACHINE:
                    self.assertIn(needle, body)
                for other in (AUTHOR, ACCEPTOR):
                    for needle in other:
                        self.assertNotIn(needle, body)
                self.assertIn(THIS_REPOSITORY, body)

    def test_the_watchdog_holds_no_app_at_all(self):
        body = text("zendev-watchdog.yml")
        self.assertNotIn(MINT, body)
        for role in (AUTHOR, ACCEPTOR, MACHINE):
            for needle in role:
                self.assertNotIn(needle, body)


class SmokeTests(unittest.TestCase):
    def test_model_roles_can_prove_their_identity_without_a_model(self):
        for name in ("zendev-author.yml", "zendev-acceptor.yml"):
            with self.subTest(workflow=name):
                body = text(name)
                self.assertIn("smoke:", body)
                self.assertIn("type: boolean", body)
                identity = next(j for j in jobs(name) if j.startswith("  identity:"))
                self.assertNotIn("claude-code-action", identity)
                self.assertIn("Say who this run is", identity)
                # Telemetry never stops the loop: an unreachable ledger is a warning in
                # the identity job, not a failed identity. The first smoke run stopped
                # the whole run over exactly that, before the app reached the ledger.
                ledger = identity.index("id: ledger")
                self.assertIn("continue-on-error: true", identity[ledger:identity.index("uses:", ledger)])
                work = next(j for j in jobs(name) if "claude-code-action" in j)
                self.assertIn("needs: identity", work)
                self.assertIn("if: ${{ !inputs.smoke }}", work)


if __name__ == "__main__":
    unittest.main()
