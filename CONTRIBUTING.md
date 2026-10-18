# Contributing to TradeCraftSimulation

Thank you for helping improve the economic simulation. Small, evidence-backed changes are welcome.

## Before starting

1. Read [README.md](README.md) for the current TypeScript runtime and the retained C# reference implementation.
2. Read [AGENTS.md](AGENTS.md) for the repository's authoritative development contract. It also applies to human contributors: simulation invariants, review roles, safety gates, and merge authority are not optional.
3. Search [existing Issues](https://github.com/drevendev/trade_simulation/issues) and open pull requests before choosing a task. For a first contribution, prefer an unclaimed, narrowly scoped documentation or test issue. Comment with your proposed scope before starting if ownership or the current integration branch is unclear.
4. Never treat the mirrored research specification in `docs/spec/mirror/**` as an editable source. It is machine-owned; raise specification disagreements in an Issue instead.

## Set up and test

The **canonical runtime** is TypeScript in `src/`. Use Node.js 22 or newer and npm:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The `npm test` script prepares Playwright Chromium before running Vitest; a working browser-install environment may be required. Record a command as `not_run` or `unavailable` if you could not execute it. Do not claim success without an actual run.

The **legacy reference oracle** is .NET 9 / C# in `TradeCraftSimulation/` and `TradeCraftSimulation.Tests/`. For changes affecting that runtime:

```sh
dotnet restore
dotnet build --configuration Release --no-restore
dotnet test --configuration Release --no-build
```

Canonical changes must preserve deterministic replay and conservation/accounting invariants. Run additional scenario/acceptance checks required by the Issue and the current [AGENTS.md](AGENTS.md).

## Issue and pull request workflow

- Work from an accepted, specific Issue. A complete Issue describes **Goal, Evidence, Scope, Non-goals, Acceptance criteria, Verification** and has the repository's priority/type/area labels.
- Keep one independently reviewable change per PR. Explain what changed, why, which Issue it addresses, and what was actually verified. Include unrun checks, remaining risks and tested revision.
- Before opening a PR, confirm with maintainers which **integration/release branch** should be targeted. Do not assume you can push directly to `master`. The repository runs a scheme-defined author/verdict/merge process.
- Do not bypass checks, use force-push to overwrite shared work, create tags/releases, or modify `AGENTS.md`, schemes, branch protection and workflows to grant yourself extra authority.
- A PR is a proposal, not an accepted release. Under the currently active `scheme/8`, an independent SLOPSTER verdict and all required green checks on the reviewed head must precede the operator's merge. See [AGENTS.md](AGENTS.md) for the exact contract.

## Licenses and attribution

The project-authored software and documentation are offered under [MIT](LICENSE). This does **not** overwrite third-party licenses in NuGet/npm packages, referenced materials, bundled assets, or upstream examples. Keep existing copyright notices and include accurate attribution for anything you add. Only contribute material you have the right to license on compatible terms; discuss exceptions before proposing a PR. Never add secrets, private logs, personal data or material from private repositories.

If you are unsure about scope, a third-party license, or an unverifiable claim, open an Issue rather than inventing evidence.
