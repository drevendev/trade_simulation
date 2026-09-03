# Migration marker

Every class in this project (`TradeCraftSimulation`) is **legacy**: the four-city,
System.Random-seeded C# simulation kept as a reference oracle while the canonical
implementation moves to TypeScript in `src/` (see [AGENTS.md](../AGENTS.md) and
`docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`,
Milestone 0 onward).

| Class | Legacy responsibility |
| --- | --- |
| `Simulation.cs` | Top-level orchestrator: four hard-coded cities, one shared seeded `Random`, six-stage turn loop. |
| `SimulationConfig.cs` | Centralized tunables for the legacy economy. |
| `City.cs` | Owns population and market per city; orchestrates production, pricing, trade and consumption. |
| `Pop.cs` | Social class: production, need, want, consumption and spoilage. |
| `Market.cs` | Per-city price engine and per-turn demand/supply/trade counters. |
| `Deal.cs` | Inter-city trade evaluation and execution. |
| `Storage.cs` | Typed goods inventory. |
| `CsvLogger.cs` | Transitional per-turn CSV diagnostics. |
| `Program.cs` | CLI entry point (`--turns`, `--seed`, `--csv`, `--quiet`, `--config`). Its behavior is not changed by the migration; it stays the runnable harness until Milestone 12. |

Do not implement a canonical subsystem here and port it to TypeScript afterward, and
do not let canonical code mutate the same stock as this legacy runtime. Legacy classes
are deleted only after Milestone 6+ once their responsibility is proven in canonical
code and tests (`docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`).
