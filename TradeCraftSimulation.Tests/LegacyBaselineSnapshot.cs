using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Simulator;

namespace TradeCraftSimulation.Tests;

/// <summary>
/// Normalizes a legacy <see cref="Simulation"/>'s state (city stocks, prices and pop
/// balances) into a stable hash, independent of console/CSV text formatting. This is the
/// golden reference REQ-MIGRATION-002 asks for: something the canonical migration can diff
/// against without caring how a human-readable report happens to round or lay out numbers.
/// </summary>
public static class LegacyBaselineSnapshot
{
    /// <summary>
    /// Builds the canonical string a hash is taken over. Iterates <see cref="Simulation.Cities"/>,
    /// <see cref="City.Population"/> and <see cref="Storage.All"/> in their fixed declaration
    /// order, so the result never depends on dictionary/hash-set iteration order, and formats
    /// doubles round-trippable ("R") rather than at the fixed decimal precision the console/CSV
    /// views use, so this snapshot cannot be mistaken for either of them.
    /// </summary>
    public static string Normalize(Simulation simulation)
    {
        var builder = new StringBuilder();
        builder.Append("turn=").Append(simulation.Turn.ToString(CultureInfo.InvariantCulture));
        builder.Append(";totalMoney=").Append(Num(simulation.TotalMoney));
        builder.Append(";cargoLost=").Append(Num(simulation.TotalCargoLost));

        foreach (City city in simulation.Cities)
        {
            builder.Append("|city=").Append(city.Type).Append(':').Append(city.Name);

            foreach (ResourceType resource in Storage.All)
            {
                builder.Append(";res=").Append(resource)
                    .Append(",price=").Append(Num(city.Market.PriceOf(resource)))
                    .Append(",stock=").Append(Num(city.StockOf(resource)))
                    .Append(",traded=").Append(Num(city.Market.Traded[resource]))
                    .Append(",imported=").Append(Num(city.Market.Imported[resource]))
                    .Append(",exported=").Append(Num(city.Market.Exported[resource]));
            }

            foreach (Pop pop in city.Population)
            {
                builder.Append(";pop=").Append(pop.Type)
                    .Append(",count=").Append(pop.Count.ToString(CultureInfo.InvariantCulture))
                    .Append(",money=").Append(Num(pop.Money));
            }
        }

        return builder.ToString();
    }

    /// <summary>SHA-256 of <see cref="Normalize"/>, hex-encoded, so a test compares one short string.</summary>
    public static string Hash(Simulation simulation) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(simulation))));

    private static string Num(double value) => value.ToString("R", CultureInfo.InvariantCulture);
}
