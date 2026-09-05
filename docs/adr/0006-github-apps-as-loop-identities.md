# 6. The loop acts through three GitHub Apps, one per class of authority

Date: 2026-09-05
Status: Accepted

## Context

ADR 0001 accepted a weakness and named it: both roles authenticated as the same
personal account through one fine-grained token, so the forge could not tell the
AUTHOR from the ACCEPTOR, and the separation between them was a rule the acceptor was
asked to follow rather than something that refused a violation. The same token expired
on a date, lacked the *Workflows* permission — which blocked #126 the day a
control-plane fix needed to touch a workflow (#145) — and, being a person's, made every
action of the loop look like that person's.

The authority model this repository follows says which alternative makes the
separation structural: an application identity per role, with short-lived credentials
minted per run and permissions scoped to the role. Issue #145 asked for the choice
between widening the token and taking that path. The path was taken.

## Decision

Three GitHub Apps, registered on the owner's account, each installed on the
repositories it serves and nowhere else:

| App | Acts for | Repository permissions | Installed on |
| --- | --- | --- | --- |
| ZenDev Author (`zendev-author[bot]`) | `zendev-author.yml` | Contents, Issues, Pull requests, Workflows — read and write | `trade_simulation` |
| ZenDev Acceptor (`zendev-acceptor[bot]`) | `zendev-acceptor.yml` | Contents, Issues, Pull requests — read and write; Checks, Commit statuses, Actions — read | `trade_simulation` |
| ZenDev Machine (`zendev-machine[bot]`) | `spec-sync.yml`, the branch update in `mergeability.yml`, the telemetry ledger | Contents, Pull requests — read and write | `trade_simulation`, `zen-telemetry` |

The apps are **account-level and shared across projects**, named for the system and the
role, never for a project: a new project adds its repository to the three installations
and stores the same six values. One private key per project is the intended practice,
so a leaked project secret is revoked without touching the others.

Inside a workflow, a token is minted by `actions/create-github-app-token` in the job
that uses it, scoped at mint time to **one repository** — this one for the role, the
ledger alone for telemetry — and revoked when the job ends. Nothing long-lived is
stored but the private keys. The watchdog keeps the ephemeral `GITHUB_TOKEN`: it
dispatches workflows and holds no app. The rework bound and the commit statuses keep
it too: they act as the forge, not as a role.

Every model-running workflow begins with an `identity` job that mints its role's token
and the ledger's, and prints who the run is — app slug and installation — and what it
reaches. With the `smoke` input set, that job is the whole run. This is how a freshly
bootstrapped project proves its six values before a model is ever started.

The client identifiers are repository variables (`ZENDEV_<ROLE>_APP_CLIENT_ID`), the
private keys repository secrets (`ZENDEV_<ROLE>_APP_PRIVATE_KEY`). A test refuses any
workflow that names a personal access token, any role workflow that holds another
role's app, and any role token not scoped to this repository.

## Consequences

**The separation is structural now.** Authorship and acceptance are two actors the
forge can distinguish, which is the precondition ADR 0001 said was unmet. It makes a
required approving review possible as a branch-protection rule. It is **not enabled by
this decision**: a pull request's author cannot approve it, the operator authors the
policy pull requests, and `enforce_admins` binds the operator too — so requiring an
approval would block the one path a widening change may take. How a person accepts
such a change under that rule is decided before the rule is turned on, not by it.

**The personal tokens go.** `ZENDEV_PAT` and `TELEMETRY_PAT` are referenced nowhere
after this change and are revoked once the first scheduled runs have proved the apps.

**Blast radius is per app, not per project.** A private key stored in one project can
mint a token for any repository the app is installed on; only our own workflow code
narrows it to one. That is accepted for a personal account with few projects. The
escape, if it stops being acceptable, is a second set of apps for the project that
needs isolation; the workflows change nothing but variable names.

**Identities show in the history.** Pull requests, comments, merges and the mirror
proposals are now made by `zendev-author[bot]`, `zendev-acceptor[bot]` and
`zendev-machine[bot]`. The mirror's commits are still *committed* by
`github-actions[bot]`, because the proposing action sets its committer explicitly, so
`machine_pr_guard`'s committer gate is unchanged; only the proposal's author changed.
Slugs are stable identifiers from here on: scripts will come to check them, so the apps
are not renamed.

**Nothing changes for the model's trigger.** The dispatcher still starts the roles with
`GITHUB_TOKEN`, so the triggering actor remains `github-actions[bot]` and the
`allowed_bots` gate on the action stays exactly as narrow as before.

**A follow-up becomes possible.** With distinct identities the acceptor can post a
formal review instead of a comment-shaped verdict; the runbooks and the selector still
describe comments, and moving them is its own change.

## Alternatives considered

- **Add the Workflows scope to the personal token.** Minutes of work; keeps one
  identity for every role, keeps the expiry, keeps every action of the loop attributed
  to a person. Rejected because it repairs the symptom in #145 and none of the
  weakness ADR 0001 recorded.
- **One app for everything.** Simplest to install; the forge still could not tell the
  roles apart, which was the point. Rejected.
- **One set of apps per project.** Contains a leaked key to one project. Deferred:
  three apps per project multiplies setup for a personal account with few projects, and
  the workflows are indifferent to which set they read, so it stays available.
