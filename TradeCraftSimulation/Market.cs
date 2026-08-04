namespace Simulator;

/// <summary>
/// The price engine of a single city. Prices are expressed in money (the numeraire)
/// and move towards the demand/supply ratio by a limited step per turn, so the
/// economy can converge instead of oscillating between extremes.
/// </summary>
public class Market
{
    private readonly SimulationConfig config;

    /// <summary>Units the citizens want to buy this turn.</summary>
    public Storage Demand { get; } = new();

    /// <summary>Units the citizens offer for sale this turn.</summary>
    public Storage Supply { get; } = new();

    /// <summary>Current price of one unit, in money.</summary>
    public Storage Price { get; } = new();

    /// <summary>Units that changed hands on the local market this turn.</summary>
    public Storage Traded { get; } = new();

    /// <summary>Units brought in by traders from neighbouring cities this turn.</summary>
    public Storage Imported { get; } = new();

    /// <summary>Units carried away by traders to neighbouring cities this turn.</summary>
    public Storage Exported { get; } = new();

    public Market(SimulationConfig config)
    {
        this.config = config;
        foreach (ResourceType resource in Storage.All)
        {
            Price[resource] = config.BasePrice(resource);
        }
    }

    public double PriceOf(ResourceType resource) =>
        resource == ResourceType.None ? 0 : Price[resource];

    /// <summary>Barter rate: how many units of <paramref name="buyType"/> one unit of <paramref name="sellType"/> is worth.</summary>
    public double PriceInAnotherResource(ResourceType sellType, ResourceType buyType)
    {
        if (sellType == ResourceType.None || buyType == ResourceType.None) return 0;
        double buyPrice = Price[buyType];
        return buyPrice <= SimulationConfig.Epsilon ? 0 : Price[sellType] / buyPrice;
    }

    /// <summary>Clears the per-turn counters. Prices are a stock and deliberately survive.</summary>
    public void BeginTurn()
    {
        Demand.Clear();
        Supply.Clear();
        Traded.Clear();
        Imported.Clear();
        Exported.Clear();
    }

    /// <summary>
    /// Nudges every price towards the demand/supply ratio, capped by
    /// <see cref="SimulationConfig.MaxPriceStep"/> and clamped to the allowed range.
    /// </summary>
    public void UpdatePrices()
    {
        foreach (ResourceType resource in Storage.All)
        {
            Price[resource] = Math.Clamp(
                Price[resource] * PriceStepFor(resource),
                config.MinPrice,
                config.MaxPrice);
        }
    }

    /// <summary>The multiplier the price of <paramref name="resource"/> will be moved by this turn.</summary>
    public double PriceStepFor(ResourceType resource)
    {
        double demand = Demand[resource];
        double supply = Supply[resource];

        // Nobody wants it and nobody has it: no information, leave the price alone.
        if (demand <= SimulationConfig.Epsilon && supply <= SimulationConfig.Epsilon) return 1.0;

        double ratio = supply <= SimulationConfig.Epsilon
            ? double.PositiveInfinity
            : demand / supply;

        return Math.Clamp(ratio, 1 - config.MaxPriceStep, 1 + config.MaxPriceStep);
    }
}
