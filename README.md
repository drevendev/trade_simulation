# TradeCraftSimulation

A deterministic economic simulation that models price formation, trade, and settlement in an
interconnected local-market system. The **canonical implementation is TypeScript** and the engine
is browser-capable today; the full Worker-backed interactive observatory around that same engine is
scheduled for M11. The current [GitHub Pages](https://drevendev.github.io/trade_simulation/)
experience is a static milestone-viewer surface, not the canonical engine running in-browser.
The current repository `docs/index.html` source leads with an M4 closed-economy preview and also
contains the consolidated M3 LocalMarket experience, including price/quantity charts, selected-tick
market balance and headline metrics; earlier M0–M2 previews and the legacy viewer remain in history.
The freshness of the deployed Pages build has not been independently re-verified here.

## Current state

**Milestone 1 & 2:** Complete. Canonical TypeScript implementation provides:
- Deterministic world genesis with configured regions, currencies, clans and production units
- Sixteen-phase tick orchestrator with stable execution order
- Stock reconciliation across all economic categories (money, goods, population, capital, resources)
- Normalized accounting spine: typed MONEY and GOOD signed deltas plus PHYSICAL_LOSS attribution,
  reconciled at phase and tick boundaries

**Milestone 3:** Complete, and released as `v0.3.0` once every one of its ledger rows carried the
merge commit that landed it. Local markets and transaction settlement. Per-requirement evidence
lives in the [implementation ledger](docs/spec/implementation_status.csv); see
[Known scope boundaries](#known-scope-boundaries) for what that ledger currently records. Local
market implementation adds:
- Ephemeral MarketIntent contracts and the budget commitments that back them
- Log-space price formation using supply/demand expectations, bounded per tick by
  `maxAbsoluteLogPriceMovePerTick`
- Deterministic proportional local clearing with stable allocation
- Atomic market settlement with tax-aware money and goods transfers
- Canonical M3 local-market telemetry for diagnostics (shortage/surplus rates, cleared/traded quantities, collection efficiency)

**Milestone 4:** Complete, and [released as `v0.4.0`](https://github.com/drevendev/trade_simulation/releases/tag/v0.4.0)
on 2026-09-30. The canonical one-region closed economy composes production, labor allocation
and payroll, household consumption, finite extraction, real-goods capital formation and
ProductionUnit lifecycle through the authoritative sixteen-phase TypeScript orchestrator.
Its 240-tick deterministic acceptance gate and milestone representation are recorded in the
[implementation ledger](docs/spec/implementation_status.csv). The release was published after
machine-recorded merge provenance, through the repository's mechanical release workflow.

**Interactive viewer:** [Open the GitHub Pages milestone viewer](https://drevendev.github.io/trade_simulation/) — the repository source contains an M4 preview and the M3 LocalMarket experience, including selected-tick price and quantity charts. Earlier M0–M2 previews and the legacy viewer are preserved in the history disclosure. Deployed build freshness is not asserted by this source-level README update.

## Understanding M3 local markets

New to the simulation? Start here:

- **[How the Local Market Works](docs/reference/local-market-guide.md)** — Price formation, supply/demand, shortage/surplus signals, and why deterministic ordering matters.
- **[What Happens When a Trade Settles](docs/reference/market-settlement-and-taxes.md)** — Money and goods flow, buyer-gross vs. seller-net prices, consumption tax collection, and accounting reconciliation.

## Building and testing

The current codebase is **TypeScript + Node.js + Vitest** for the canonical simulation engine.

```bash
# Verify everything builds and tests pass
npm ci
npm run typecheck
npm test
npm run build
```

### Legacy reference oracle

The original **C# / .NET 9** implementation in `TradeCraftSimulation/` is retained as a stable
reference oracle for baseline behavior, not as the active development target. It remains
functional and tested, but canonical feature development occurs in TypeScript.

To build and test the legacy code:

```bash
dotnet restore
dotnet build --configuration Release
dotnet test --configuration Release
```

## Project structure

- `src/` — Canonical TypeScript simulation engine
  - `config/` — Configuration layers and validation
  - `domain/` — Core types, IDs, registries, and numeric contracts
  - `simulation/` — Tick orchestrator, market clearing, settlement, telemetry
  - `diagnostics/` — Milestone preview generation and test utilities

- `TradeCraftSimulation/` — Legacy C# reference implementation (frozen at M0)
- `docs/` — GitHub Pages viewer and milestone preview artifacts
- `docs/spec/` — Implementation specification and handoff documentation

## Implementation evidence

- **Specification registry:** [`docs/spec/mirror/REQUIREMENTS_REGISTRY.csv`](docs/spec/mirror/REQUIREMENTS_REGISTRY.csv)
- **Implementation status:** [`docs/spec/implementation_status.csv`](docs/spec/implementation_status.csv)
- **Specification handoff:** [`docs/spec/mirror/06 - Handoff/`](docs/spec/mirror/) (numbered sections covering scope, schema, config, markets, acceptance, and migration)
- **ADRs:** [`docs/adr/`](docs/adr/) — Architectural decisions (identity, numeric contracts, etc.)

## Invariants and guarantees

The canonical simulation is **deterministic**:
- Same configuration, seed, and tick count produce identical replay hash across runs
- No random-number consumption outside of reproducible seeded calls

**M3 local market settlement** (REQ-MARKET-001..005 and REQ-ACCEPTANCE-004, recorded IMPLEMENTED in
the ledger):
- Atomic transaction settlement with preflight affordability/inventory checks and tax-aware transfers
- Deterministic proportional clearing within a tick/phase
- Phase and tick boundary reconciliation: conserved MONEY and GOOD stock deltas reconcile by asset key within configured tolerance (1e-9 by default)
- Typed ledger entries for transactions, tax transfers, and physical losses with explicit attribution

## Known scope boundaries

[`docs/spec/implementation_status.csv`](docs/spec/implementation_status.csv) is the authoritative
per-requirement implementation record: one evidence row per requirement identifier, written by the
pull request that earns it. [`docs/spec/IMPLEMENTATION_STATUS.md`](docs/spec/IMPLEMENTATION_STATUS.md)
is generated from that file and is presentation only. The summary below follows it.

**Recorded IMPLEMENTED:**
- Core deterministic orchestration and ledger framework
- Configuration, scenario definition, and world genesis
- Local market price formation, clearing, and settlement with tax (REQ-MARKET-001..005,
  REQ-ACCEPTANCE-004)
- M3 representation: the consolidated LocalMarket Pages experience (REQ-VISUALIZATION-006), the
  README and public project text (REQ-VISUALIZATION-007), and the two public explainer articles
  (REQ-VISUALIZATION-008)
- M4 closed-economy stack: M4 configuration (REQ-CONFIG-006..007), production/labor/capital
  integration (REQ-PRODUCTION-001..008), household/population behavior
  (REQ-POPULATION-001..003), the integrated 240-tick gate (REQ-ACCEPTANCE-005), and the M4
  milestone representation (REQ-VISUALIZATION-009)

**Closed:**
- Milestone 3. A milestone is released only once every one of its ledger rows reads IMPLEMENTED
  *and* carries the merge commit that landed it, and `release-tag.yml` makes that judgement
  mechanically from the ledger rather than by hand. All nine M3 rows met it, and the tagger cut
  `v0.3.0 — M3` on that evidence. A row whose merge commit is blank is one a pull request is
  still carrying: `scripts/backfill_merge_commits.py` records it once that pull request lands.
- Milestone 4 is complete and was released as [`v0.4.0 — M4`](https://github.com/drevendev/trade_simulation/releases/tag/v0.4.0)
  on 2026-09-30, after the canonical M4 implementation rows and machine-recorded merge provenance
  satisfied the release workflow. This published release is historical; it is not a claim that later
  M5–M12 requirements are implemented.

**Not implemented yet (later milestones M5–M8):**
- Inter-regional transport, trade logistics and FX (M5)
- Fiscal policy, governance, clans and debt (M6)
- Monetary policy and currency dynamics (M7)
- Demography, migration and expansion (M8)

**Out of scope (core v1 hard exclusions):**
- Housing, property, speculative finance, or individuals as modeled entities
- Warfare or explicit political dynamics

For the full specification boundary, see [`docs/spec/mirror/06 - Handoff/START_HERE.md`](docs/spec/mirror/06%20-%20Handoff/START_HERE%20—%20Economic%20Simulation%20Implementation%20Handoff.md).

## Contributing and license

Interested in improving a reproducible economy simulation? Start with [CONTRIBUTING.md](CONTRIBUTING.md) and a narrowly scoped [Issue](https://github.com/drevendev/trade_simulation/issues). The contribution guide explains the TypeScript and legacy C# development paths, actual verification commands, and the repository-specific independent review/merge process. Before starting a change, check which integration branch maintainers are currently accepting.

Project-authored code and documentation are licensed under the [MIT License](LICENSE). Third-party dependencies, external source material, and separately licensed assets retain their own terms; see their upstream notices. GitHub-public does not imply rights beyond the applicable licenses.
