# Legacy migration marker

Required by Milestone 0 of
`docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`:
"Add a migration marker documenting which classes are legacy."

Every class below is **legacy**: it lives in the C# reference oracle
(`TradeCraftSimulation/`), it is not touched by `REQ-MIGRATION-003`, and it stays
authoritative for its own stocks until a canonical TypeScript replacement under
`src/` is implemented and proven with tests (see the non-negotiable migration
rules — one authoritative owner per stock, no bidirectional mirroring). This file
is a snapshot of that boundary as of `REQ-MIGRATION-003`; update it as
responsibilities move to `src/`, do not delete rows retroactively.

| Legacy class | File | Responsibility |
| --- | --- | --- |
| `City` | `TradeCraftSimulation/City.cs` | City entity: stocks, prices, population |
| `Pop` | `TradeCraftSimulation/Pop.cs` | Population unit: production/consumption needs |
| `Market` | `TradeCraftSimulation/Market.cs` | Intercity trade and price discovery |
| `Deal` | `TradeCraftSimulation/Deal.cs` | A single trade transaction between cities |
| `Storage` | `TradeCraftSimulation/Storage.cs` | Per-city goods inventory |
| `Simulation` | `TradeCraftSimulation/Simulation.cs` | Six-stage turn loop orchestrator |
| `SimulationConfig` | `TradeCraftSimulation/SimulationConfig.cs` | Seed, turn count and tunable parameters |
| `CsvLogger` | `TradeCraftSimulation/CsvLogger.cs` | Per-turn CSV run output |
| `Program` | `TradeCraftSimulation/Program.cs` | CLI entry point (`--turns`, `--seed`, `--csv`, `--quiet`) |

Canonical replacements land under `src/config/`, `src/domain/`, `src/simulation/`
and `src/diagnostics/` starting at Milestone 1 (`REQ-CORE-001`,
`REQ-CONFIG-001..005`), per ADR
[0002-typescript-canonical-engine](../adr/0002-typescript-canonical-engine.md).
No row above is deleted, moved or renamed by `REQ-MIGRATION-003`.
