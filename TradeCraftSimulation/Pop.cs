namespace Simulator;

public enum PopType
{
    Farmer,
    Woodcutter,
    Crafter,
    Trader
}

/// <summary>
/// A social class inside a city. A pop produces one good, holds money and its own
/// inventory, buys what it cannot produce and consumes every turn.
/// </summary>
public class Pop
{
    private readonly SimulationConfig config;

    public PopType Type { get; }
    public int Count { get; }

    /// <summary>Cash on hand. The only form of money in the model.</summary>
    public double Money { get; internal set; }

    /// <summary>Goods this pop owns right now (a stock, not a flow).</summary>
    public Storage Inventory { get; } = new();

    /// <summary>How much this pop has to consume this turn to be fully satisfied (a flow).</summary>
    public Storage Need { get; } = new();

    /// <summary>How much this pop wants to hold: its need plus what is worth stockpiling at the current price.</summary>
    public Storage Want { get; } = new();

    /// <summary>Share of the need actually consumed last turn, per resource. 1.0 = fully fed.</summary>
    public Storage Satisfaction { get; } = new();

    public ResourceType ProducingResource { get; }
    public double ProductionPower { get; }

    /// <summary>Units produced during the last turn (a flow, reset every turn).</summary>
    public double LastProduction { get; private set; }

    public Pop(PopType type, int count, SimulationConfig config)
    {
        this.config = config;
        Type = type;
        Count = count;
        Money = count * config.StartingMoneyPerCapita
                * (type == PopType.Trader ? config.TraderCapitalMultiplier : 1);

        (ProducingResource, ProductionPower) = type switch
        {
            PopType.Farmer => (ResourceType.Food, 5.0),
            PopType.Woodcutter => (ResourceType.Wood, 10.0),
            PopType.Crafter => (ResourceType.Tools, 1.0),
            // Traders produce nothing; they live off the margin between two markets.
            _ => (ResourceType.None, 0.0)
        };
    }

    /// <summary>Adds this turn's output to the inventory. Returns the amount produced.</summary>
    public double Produce(double cityModifier, double noise)
    {
        LastProduction = 0;
        if (ProducingResource == ResourceType.None) return 0;

        LastProduction = Count * ProductionPower * cityModifier * noise;
        Inventory.Add(ProducingResource, LastProduction);
        return LastProduction;
    }

    /// <summary>
    /// The bare need is what this pop eats; the want adds what is worth stockpiling at the
    /// current price. Only the want reaches the market, and only the need is consumed.
    /// </summary>
    public void CalculateNeed(Market market)
    {
        foreach (ResourceType resource in Storage.All)
        {
            double need = Count * config.NeedPerCapita(resource);
            Need[resource] = need;
            Want[resource] = need * config.DemandMultiplier(resource, market.PriceOf(resource));
        }
    }

    /// <summary>Units this pop offers to the market: whatever it holds beyond what it wants to keep.</summary>
    public double SurplusOf(ResourceType resource) => Math.Max(0, Inventory[resource] - Want[resource]);

    /// <summary>Units this pop wants to buy: the part of its want it cannot cover from its own inventory.</summary>
    public double ShortageOf(ResourceType resource) => Math.Max(0, Want[resource] - Inventory[resource]);

    /// <summary>Units this pop wants to buy and can actually pay for at <paramref name="price"/>.</summary>
    public double AffordableShortageOf(ResourceType resource, double price)
    {
        if (price <= SimulationConfig.Epsilon) return ShortageOf(resource);
        return Math.Min(ShortageOf(resource), Money / price);
    }

    /// <summary>Eats what it can and records how well the need was met.</summary>
    public void Consume()
    {
        foreach (ResourceType resource in Storage.All)
        {
            double need = Need[resource];
            double consumed = Inventory.Take(resource, need);
            Satisfaction[resource] = need > SimulationConfig.Epsilon ? consumed / need : 1.0;
        }
    }

    /// <summary>Destroys a share of the leftovers so that stocks cannot grow without bound.</summary>
    public void Spoil()
    {
        foreach (ResourceType resource in Storage.All)
        {
            Inventory.Take(resource, Inventory[resource] * config.SpoilageOf(resource));
        }
    }

    /// <summary>Money plus the market value of everything this pop holds.</summary>
    public double WealthIn(Market market)
    {
        double wealth = Money;
        foreach (ResourceType resource in Storage.All)
        {
            wealth += Inventory[resource] * market.PriceOf(resource);
        }
        return wealth;
    }

    internal void Pay(double amount)
    {
        if (amount < 0) throw new ArgumentOutOfRangeException(nameof(amount), amount, "Negative payment.");
        Money -= amount;
        if (Money < SimulationConfig.Epsilon && Money > -SimulationConfig.Epsilon) Money = 0;
        if (Money < 0) throw new InvalidOperationException($"{Type} overdrew its money by {-Money:F6}.");
    }

    internal void Receive(double amount)
    {
        if (amount < 0) throw new ArgumentOutOfRangeException(nameof(amount), amount, "Negative income.");
        Money += amount;
    }
}
