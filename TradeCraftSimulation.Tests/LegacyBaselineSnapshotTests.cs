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

    [Fact]
    public void The_same_seed_produces_the_same_normalized_snapshot_hash()
    {
        string first = RunAndHash(seed: 7, turns: RepresentativeTurns);
        string second = RunAndHash(seed: 7, turns: RepresentativeTurns);

        Assert.Equal(first, second);
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
