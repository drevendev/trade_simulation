# M0 Milestone Preview (REQ-VISUALIZATION-003)

What this is, and the evidence behind it.

## What was built

A "Migration status" panel on the existing GitHub Pages site
(`docs/index.html`, served from `master:/docs` — no new hosting, workflow or
credential was added). It reads `docs/m0-preview.json`, a small static,
hand-authored diagnostic artifact, and renders:

- the milestone label (`Milestone 0 — Baseline lock and migration scaffolding`);
- the frozen legacy baseline seed, turn count and full SHA-256 hash, matching
  `docs/spec/LEGACY_BASELINE.md` (`REQ-MIGRATION-002`);
- the canonical TypeScript scaffolding status, matching `toolchainStatus()` in
  `src/index.ts` (`REQ-MIGRATION-003`) — scaffolding present, no canonical
  economics yet.

The panel is a strict one-way reader: it fetches one static JSON file and
never imports, reads or references a canonical (`src/**`) or legacy
(`TradeCraftSimulation/**`) runtime module path, so it cannot mutate
WorldState, consume simulation RNG, or become a second source of economic
truth. It sits above the existing 300-turn/seed-42 legacy run viewer, which
is unchanged and remains the separate, larger reference visualization — the
panel is explicit that the two are different runs (seed 7/30 turns vs. seed
42/300 turns) so a reader does not conflate the golden fixture with the
run.csv demo.

## Evidence that the panel's claims stay true

`src/diagnostics/m0Preview.test.ts` (part of the `npm test` / `typescript`
required check) fails if any of these drift:

- `docs/m0-preview.json`'s `legacyBaseline.seed`/`turns`/`hash` no longer
  match the values documented in `docs/spec/LEGACY_BASELINE.md`;
- `docs/m0-preview.json`'s `canonicalScaffolding.present` no longer matches
  the real `toolchainStatus().canonicalScaffolding` exported by `src/index.ts`;
- `docs/index.html` stops fetching `m0-preview.json`, or starts referencing a
  runtime module path (`src/simulation`, `TradeCraftSimulation`) that would
  turn the one-way reader into a bridge.

## Build/render smoke check

Performed manually against a local static server (`python3 -m http.server`
from `docs/`) using the `chromium` binary already present in this
environment, headless, with `--screenshot`:

- the existing legacy run viewer (price charts, trade map, scrubber) still
  renders and is visually unchanged;
- the new "Migration status" panel renders above it, shows the milestone
  label, full hash (wrapped, not truncated, on a narrow viewport) and
  scaffolding status, and does not block or delay the existing viewer's
  `run.csv` fetch.

No GitHub Pages deployment was triggered by this check; this repository's
Pages source already serves `master:/docs`, so no workflow change was
needed. Actual production deployment happens after this pull request merges,
per this Issue's own acceptance criteria ("after merge/deployment verify the
actual Pages result") — that verification is out of scope for an AUTHOR run,
which cannot merge.

## Milestone unit accounting (REQ-VISUALIZATION-002)

M0's planned implementation units: `REQ-MIGRATION-001..004` (four units) plus
this visible preview unit (one unit) = five units total. `1 / 5 = 20%`,
satisfying the >=5%-rounded-up-minimum-one visualization share for M0. This
is an M0-only accounting; it makes no claim about M1's or any later
milestone's own quota.

## Non-goals kept

No new economic runtime, Worker/observatory architecture, mutable WorldState
access, second economic API, shared stock, or RNG use by presentation was
added. `docs/index.html`'s existing legacy viewer and its `run.csv` fetch are
unchanged.
