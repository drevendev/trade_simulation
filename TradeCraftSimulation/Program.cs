using System.Globalization;
using Simulator;

namespace TradeCraftSimulation;

public static class Program
{
    public static int Main(string[] args)
    {
        int turns = 30;
        string? csvPath = null;
        bool quiet = false;
        var config = new SimulationConfig();

        for (int i = 0; i < args.Length; ++i)
        {
            switch (args[i])
            {
                case "--turns" when i + 1 < args.Length:
                    turns = int.Parse(args[++i], CultureInfo.InvariantCulture);
                    break;
                case "--seed" when i + 1 < args.Length:
                    config.Seed = int.Parse(args[++i], CultureInfo.InvariantCulture);
                    break;
                case "--csv" when i + 1 < args.Length:
                    csvPath = args[++i];
                    break;
                case "--config" when i + 1 < args.Length:
                    if (!TryOverride(config, args[++i], out string error))
                    {
                        Console.Error.WriteLine(error);
                        return 1;
                    }
                    break;
                case "--quiet":
                    quiet = true;
                    break;
                case "--help":
                case "-h":
                    PrintUsage();
                    return 0;
                default:
                    Console.Error.WriteLine($"Unknown argument: {args[i]}");
                    PrintUsage();
                    return 1;
            }
        }

        var simulation = new Simulation(config);
        using CsvLogger? csv = csvPath is null ? null : new CsvLogger(csvPath);

        for (int i = 0; i < turns; ++i)
        {
            simulation.RunTurn();
            csv?.WriteTurn(simulation);
            if (!quiet) Console.WriteLine(simulation.CityView());
        }

        if (quiet) Console.WriteLine(simulation.CityView());
        if (csvPath is not null) Console.WriteLine($"Wrote {turns} turns to {csvPath}");

        return 0;
    }

    /// <summary>
    /// Applies a "Name=value" override to any numeric knob of <see cref="SimulationConfig"/>,
    /// so that balancing the economy does not need a rebuild.
    /// </summary>
    private static bool TryOverride(SimulationConfig config, string assignment, out string error)
    {
        string[] parts = assignment.Split('=', 2);
        if (parts.Length != 2)
        {
            error = $"Expected --config Name=value, got '{assignment}'.";
            return false;
        }

        var property = typeof(SimulationConfig).GetProperty(
            parts[0],
            System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.IgnoreCase);

        if (property is null || !property.CanWrite)
        {
            error = $"SimulationConfig has no writable property '{parts[0]}'.";
            return false;
        }

        try
        {
            object value = property.PropertyType == typeof(int)
                ? int.Parse(parts[1], CultureInfo.InvariantCulture)
                : double.Parse(parts[1], CultureInfo.InvariantCulture);
            property.SetValue(config, value);
        }
        catch (Exception exception) when (exception is FormatException or OverflowException)
        {
            error = $"Cannot parse '{parts[1]}' as {property.PropertyType.Name}.";
            return false;
        }

        error = "";
        return true;
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
            TradeCraftSimulation - a toy supply/demand economy across four trading cities.

            Usage: TradeCraftSimulation [options]

              --turns <n>     number of turns to simulate (default 30)
              --seed <n>      seed of the production noise, same seed = same run (default 42)
              --csv <path>    write a per-turn time series in long CSV format
              --quiet         only print the final state
              --config K=V    override a SimulationConfig knob, repeatable
                              e.g. --config TransportCostPerUnit=0.1 --config MaxPriceStep=0.05
              -h, --help      show this help
            """);
    }
}
