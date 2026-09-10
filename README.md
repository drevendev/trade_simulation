# TradeCraftSimulation

A deterministic economic simulation that models price formation, trade, and settlement in an
interconnected local-market system. The **canonical implementation is TypeScript** and is
browser-capable (scheduled for M11+). The current [GitHub Pages](https://drevendev.github.io/trade_simulation/)
deployment shows the legacy reference viewer and M1/M2 milestone previews, not the canonical engine executing.

## Current state

**Milestone 1 & 2:** Complete. Canonical TypeScript implementation provides:
- Deterministic world genesis with configured regions, currencies, clans and production units
- Sixteen-phase tick orchestrator with stable execution order
- Stock reconciliation across all economic categories (money, goods, population, capital, resources)
- Ledger framework tracking all economic flows

**Milestone 3:** In progress. Local market implementation adds (core mechanics complete, acceptance and telemetry refinement ongoing):
- Ephemeral budget commitments and persistent MarketIntent contracts
- Log-space price formation using supply/demand expectations with bounded daily movement
- Deterministic proportional local clearing with stable allocation
- Atomic market settlement with tax-aware money and goods transfers
- Canonical M3 local-market telemetry for diagnostics (shortage/surplus rates, cleared/traded quantities, collection efficiency)

**Interactive viewer:** [View the current M2 Milestone Preview](https://drevendev.github.io/trade_simulation/) — see baseline-scenario world topology, tick execution, and zero-flow reconciliation across 100+ ticks.

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

**M3 local market settlement** (in progress, with refinements ongoing):
- Atomic transaction settlement with preflight affordability/inventory checks and tax-aware transfers
- Deterministic proportional clearing within a tick/phase
- Phase and tick boundary reconciliation: conserved MONEY and GOOD stock deltas reconcile by asset key within configured tolerance (1e-9 by default)
- Typed ledger entries for transactions, tax transfers, and physical losses with explicit attribution

## Known scope boundaries

**Completed:**
- Core deterministic orchestration and ledger framework
- Configuration, scenario definition, and world genesis

**In progress:**
- Local market price formation, clearing, and settlement with tax (core mechanics complete; telemetry and acceptance test refinement ongoing per REQ-MARKET-005 and REQ-ACCEPTANCE-004)

**Not implemented yet (later milestones M4–M8):**
- Production function, labor allocation and population dynamics (M4–M5)
- Inter-regional transport, trade logistics and FX (M5)
- Fiscal policy, governance, clans and debt (M6)
- Monetary policy and currency dynamics (M7)
- Demography, migration and expansion (M8)

**Out of scope (core v1 hard exclusions):**
- Housing, property, speculative finance, or individuals as modeled entities
- Warfare or explicit political dynamics

For the full specification boundary, see [`docs/spec/mirror/06 - Handoff/START_HERE.md`](docs/spec/mirror/06%20-%20Handoff/START_HERE%20—%20Economic%20Simulation%20Implementation%20Handoff.md).
