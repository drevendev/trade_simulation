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

**Milestone 3:** In progress. Local market foundations (requirements REQ-MARKET-001..005 and REQ-ACCEPTANCE-004):
- Ephemeral budget commitments and persistent MarketIntent contracts
- Log-space price formation using supply/demand expectations with bounded daily movement
- Deterministic proportional local clearing with stable allocation
- Atomic preflighted market settlement with tax-aware money and goods transfers
- Market telemetry for diagnostics (shortage/surplus rates, cleared/traded quantities, collection efficiency) — development ongoing
- Phase/tick reconciliation of conserved asset deltas within configured tolerance

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

**Accounting and settlement**:
- Market transactions are preflighted for atomic settlement; transactions are the authoritative settlement unit
- Conserved asset deltas (money by currency, goods by kind) reconcile within configured tolerance at phase/tick boundaries
- Physical losses and other typed sinks are separately attributed and do not require balancing credits
- Stock reconciliation residuals maintained within configured tolerance (1e-9 by default)
- All ledger mutations isolated to atomic operation boundaries (phases and transactions)

## Known scope boundaries

**Completed:**
- Core deterministic orchestration and ledger framework (M0–M2)
- Configuration, scenario definition, and world genesis
- Local market price formation and clearing (foundations)

**In progress:**
- M3 local market settlement acceptance and telemetry completion
- Refinement of M3 golden-gate acceptance test coverage

**Not implemented yet (later milestones M4–M8):**
- Production function specification and dynamics (M4)
- Population cohort behavior and labor allocation (M4)
- Inter-regional transport and trade logistics (M5)
- Fiscal policy, laws, clans and debt (M6)
- Monetary policy and currency (M7)
- Demography, migration, expansion and succession (M8)

**Core-v1 hard exclusions**:
- Housing, property, speculative finance, or individuals as modeled entities
- Warfare or explicit political dynamics

For the full specification boundary, see [`docs/spec/mirror/06 - Handoff/START_HERE.md`](docs/spec/mirror/06%20-%20Handoff/START_HERE%20—%20Economic%20Simulation%20Implementation%20Handoff.md).
