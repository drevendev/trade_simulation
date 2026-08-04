namespace Simulator;

/// <summary>
/// One arbitrage operation: a trader buys a resource in its home city, carries it to a
/// neighbour and sells it there. It is only worth doing when the price gap between the
/// two markets is wider than the transport cost.
/// </summary>
public class Deal
{
    /// <summary>The "no deal" placeholder returned when nothing is worth trading.</summary>
    public static readonly Deal None = new();

    public City? From { get; private init; }
    public City? To { get; private init; }

    /// <summary>The pop running the deal. It is always a trader of the city that initiated it,
    /// which may be either end of the route: traders both export from and import to their home.</summary>
    public Pop? Traders { get; private init; }

    public ResourceType Resource { get; private init; } = ResourceType.None;

    /// <summary>Units the trader intends to move.</summary>
    public double Amount { get; private init; }

    public double BuyPrice { get; private init; }
    public double SellPrice { get; private init; }

    /// <summary>Share of the cargo lost on the way.</summary>
    public double TransportLossShare { get; private init; }

    /// <summary>Margin on one unit bought: only what survives the trip can be sold.</summary>
    public double ProfitPerUnit => SellPrice * (1 - TransportLossShare) - BuyPrice;

    public double TotalProfit => ProfitPerUnit * Amount;

    public bool IsPossible =>
        From != null && To != null && Traders != null &&
        Amount > SimulationConfig.Epsilon &&
        ProfitPerUnit > SimulationConfig.Epsilon;

    // ---- filled in by Execute ---------------------------------------------

    /// <summary>Units actually bought and carried away.</summary>
    public double ExecutedAmount { get; private set; }

    /// <summary>Units the destination market actually absorbed.</summary>
    public double SoldAmount { get; private set; }

    /// <summary>Units that never arrived.</summary>
    public double CargoLost { get; private set; }

    /// <summary>Money the trader ended up making (can differ from <see cref="TotalProfit"/> because of rationing).</summary>
    public double RealizedProfit { get; private set; }

    private Deal() { }

    /// <summary>
    /// Sizes a deal against every constraint that applies: the traders' remaining trade
    /// power, the surplus the source city is willing to part with, the money the traders
    /// have, and the demand the destination can actually pay for.
    /// </summary>
    public static Deal Evaluate(Pop traders, City from, City to, ResourceType resource, double capacity, SimulationConfig config)
    {
        if (capacity <= SimulationConfig.Epsilon) return None;

        double buyPrice = from.Market.PriceOf(resource);
        double sellPrice = to.Market.PriceOf(resource);
        double loss = config.TransportLossShare;

        if (sellPrice * (1 - loss) - buyPrice <= SimulationConfig.Epsilon) return None;

        double amount = capacity;
        amount = Math.Min(amount, from.SurplusOf(resource) * config.MaxSurplusShareTraded);

        // Only the part of the cargo that survives the trip can be sold there.
        if (loss < 1) amount = Math.Min(amount, to.AffordableDemandFor(resource, sellPrice) / (1 - loss));

        if (buyPrice > SimulationConfig.Epsilon) amount = Math.Min(amount, traders.Money / buyPrice);

        if (amount <= SimulationConfig.Epsilon) return None;

        return new Deal
        {
            From = from,
            To = to,
            Traders = traders,
            Resource = resource,
            Amount = amount,
            BuyPrice = buyPrice,
            SellPrice = sellPrice,
            TransportLossShare = loss
        };
    }

    /// <summary>
    /// Moves the goods and the money. Returns the number of units actually bought,
    /// which is what the deal costs the traders in trade power.
    /// </summary>
    public double Execute()
    {
        if (!IsPossible) return 0;

        City from = From!;
        City to = To!;
        Pop traders = Traders!;

        double bought = from.TakeFromSellers(Resource, Amount, BuyPrice);
        if (bought <= SimulationConfig.Epsilon) return 0;
        traders.Pay(bought * BuyPrice);

        CargoLost = bought * TransportLossShare;
        double delivered = bought - CargoLost;

        double sold = to.GiveToBuyers(Resource, delivered, SellPrice);
        traders.Receive(sold * SellPrice);

        // Whatever the destination could not absorb comes back and is sold at home later.
        double unsold = delivered - sold;
        if (unsold > SimulationConfig.Epsilon) traders.Inventory.Add(Resource, unsold);

        from.Market.Exported.Add(Resource, bought);
        to.Market.Imported.Add(Resource, sold);

        ExecutedAmount = bought;
        SoldAmount = sold;
        RealizedProfit = sold * SellPrice - bought * BuyPrice;
        return bought;
    }
}
