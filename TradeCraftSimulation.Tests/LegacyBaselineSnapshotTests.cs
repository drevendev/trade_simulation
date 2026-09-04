using Simulator;
using Xunit;

namespace TradeCraftSimulation.Tests;

/// <summary>
/// Locks REQ-MIGRATION-002: repeated same-seed legacy runs on the same runtime must produce
/// the same normalized snapshot/hash, and the hash must actually depend on the run.
/// </summary>
public class LegacyBaselineSnapshotTests
{
    // The spec's representative baseline horizon (Milestone 0 implementation steps).
    private const int RepresentativeTurns = 30;

    // Frozen golden value for seed 7 / 30 turns on .NET 9, measured once and checked in per
    // REQ-MIGRATION-002 (SPEC_CHANGELOG revision CODE_RUNTIME_QA_02). See
    // docs/spec/LEGACY_BASELINE.md for the reproduction command and runtime this was captured on.
    // Any change to this value means the legacy baseline drifted and must be investigated, not
    // silently re-pinned.
    private const string ExpectedSeed7Turn30Hash =
        "E7B06C845275F2B7274223261C163C5E930F2728BA33173694FB90E815B7CC67";

    [Fact]
    public void The_same_seed_produces_the_same_normalized_snapshot_hash()
    {
        string first = RunAndHash(seed: 7, turns: RepresentativeTurns);
        string second = RunAndHash(seed: 7, turns: RepresentativeTurns);

        Assert.Equal(first, second);
    }

    [Fact]
    public void The_seed_7_thirty_turn_baseline_matches_the_frozen_expected_hash()
    {
        Assert.Equal(ExpectedSeed7Turn30Hash, RunAndHash(seed: 7, turns: RepresentativeTurns));
    }

    [Fact]
    public void A_different_seed_produces_a_different_normalized_snapshot_hash()
    {
        string first = RunAndHash(seed: 7, turns: RepresentativeTurns);
        string second = RunAndHash(seed: 8, turns: RepresentativeTurns);

        Assert.NotEqual(first, second);
    }

    private static string RunAndHash(int seed, int turns)
    {
        var simulation = new Simulation(new SimulationConfig { Seed = seed });
        for (int i = 0; i < turns; ++i) simulation.RunTurn();
        return LegacyBaselineSnapshot.Hash(simulation);
    }
}
