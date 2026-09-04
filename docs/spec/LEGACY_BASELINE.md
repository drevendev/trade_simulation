# Legacy baseline (REQ-MIGRATION-002)

The frozen, reproducible legacy golden reference required by Milestone 0
(`docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`,
strengthened by `SPEC_CHANGELOG.md` revision `CODE_RUNTIME_QA_02`).

## Parameters

| Field | Value |
| --- | --- |
| Seed | `7` |
| Turns | `30` |
| Simulation entry point | `Simulator.Simulation` (`TradeCraftSimulation`), `new SimulationConfig { Seed = 7 }`, `RunTurn()` x30 |
| Observed runtime | `.NET 9.0.19` (`RuntimeInformation.FrameworkDescription`), target framework `net9.0`, OS `ubuntu 24.04 linux-x64` |
| Normalization | `TradeCraftSimulation.Tests.LegacyBaselineSnapshot.Normalize` — iterates `Simulation.Cities`, each city's `Population` and `Storage.All` in fixed declaration order, formats doubles round-trippable (`"R"`), independent of console/CSV text formatting |
| Hash | SHA-256 of the normalized string, hex-encoded (`LegacyBaselineSnapshot.Hash`) |

## Expected value

```
E7B06C845275F2B7274223261C163C5E930F2728BA33173694FB90E815B7CC67
```

## Reproduction

```sh
dotnet test --configuration Release \
  --filter "TradeCraftSimulation.Tests.LegacyBaselineSnapshotTests.The_seed_7_thirty_turn_baseline_matches_the_frozen_expected_hash"
```

The assertion lives in
`TradeCraftSimulation.Tests/LegacyBaselineSnapshotTests.cs`. Repeated same-seed runs on
the same runtime must reproduce this exact value; a different seed (`8`, also asserted)
must not collapse to the same hash. If the legacy runtime changes in a way that alters
this value, that is a baseline drift to investigate and document, not a value to
silently re-pin.
