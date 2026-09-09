# TradeCraftSimulation

A deterministic economic simulation that models price formation, trade, and settlement in an
interconnected local-market system. **The canonical implementation is TypeScript and runs in
the browser on [GitHub Pages](https://drevendev.github.io/trade_simulation/).**

## Current state

**Milestone 1 & 2:** Complete. Canonical TypeScript implementation provides:
- Deterministic world genesis with configured regions, currencies, clans and production units
- Sixteen-phase tick orchestrator with stable execution order
- Stock reconciliation across all economic categories (money, goods, population, capital, resources)
- Ledger framework tracking all economic flows

**Milestone 3:** In progress. Local market implementation adds:
- Ephemeral budget commitments and persistent MarketIntent contracts
- Log-space price formation using supply/demand expectations with bounded daily movement
- Deterministic proportional local clearing with stable allocation
- Atomic market settlement with tax-aware money and goods transfers
- Comprehensive settlement telemetry (shortage/surplus rates, cleared/traded quantities, collection efficiency)
- Deterministic replay and accounting invariants verified at settlement boundary

**Interactive viewer:** [View the current M2 Milestone Preview](https://drevendev.github.io/trade_simulation/) — see baseline-scenario world topology, tick execution, and zero-flow reconciliation across 100+ ticks.

## Building and testing

The current codebase is **TypeScript + Node.js + Vitest** for the canonical simulation engine.

```bash
# Verify everything builds and tests pass
npm ci
npm run typecheck
npm test
npm run build
```

To view the interactive GitHub Pages experience locally:

```bash
npm run dev
```

Then open http://localhost:5173 in your browser.

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
- All economic identities (money conservation, stock reconciliation, no negative balances) are enforced at settlement boundary

Money and goods flows are **fully accounted**:
- Every transaction creates equal-and-opposite ledger entries
- Stocks reconcile to zero across the full system at configured tolerance (1e-9 by default)
- All ledger mutations are isolated to atomic operation boundaries (phases and transactions)

## Known scope boundaries

**Completed:**
- Core deterministic orchestration and ledger framework
- Configuration, scenario definition, and world genesis
- Local market price formation, clearing, and settlement with tax

**In progress:**
- Refinement of M3 local market acceptance test coverage

**Out of scope (v1):**
- Production function specification and dynamics
- Population cohort behavior and labor allocation
- Fiscal policy, monetary policy, and macroeconomic dynamics
- Inter-regional transport and trade logistics beyond M3 local markets
- Housing, property, speculative finance, or individuals
- Warfare or explicit political dynamics

For the full specification boundary, see [`docs/spec/mirror/06 - Handoff/START_HERE.md`](docs/spec/mirror/06%20-%20Handoff/START_HERE%20—%20Economic%20Simulation%20Implementation%20Handoff.md).
