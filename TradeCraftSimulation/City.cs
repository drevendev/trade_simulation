namespace Simulator;

public enum CityTypes
{
    Center,
    Plain,
    Forest,
    Mountains
}

/// <summary>
/// A city owns its population and its market. Goods are owned by the pops, not by
/// the city: the city only orchestrates production, market clearing, trade and consumption.
/// </summary>
public class City
{
    private readonly SimulationConfig config;

    public CityTypes Type { get; }
    public string Name { get; }
    public Pop[] Population { get; } = new Pop[4];
    public Market Market { get; }
    public List<City> NeighbourCities { get; } = new();

    /// <summary>Units the traders of this city can still move this turn.</summary>
    public double RemainingTradePower { get; private set; }

    /// <summary>Units of cargo this city's traders lost on the road this turn.</summary>
    public double CargoLost { get; private set; }

    /// <summary>Deals executed by this city's traders this turn.</summary>
    public List<Deal> ExecutedDeals { get; } = new();

    public double TradePower => Traders.Count * config.TradePowerPerTrader;

    public Pop Traders => Population[(int)PopType.Trader];

    public City(CityTypes type, SimulationConfig config)
    {
        this.config = config;
        Type = type;
        Market = new Market(config);

        switch (type)
        {
            case CityTypes.Center:
                Name = "Capitalist";
                InitPopulation(20, 20, 20, 20);
                break;
            case CityTypes.Plain:
                Name = "Farmland";
                InitPopulation(15, 10, 10, 5);
                break;
            case CityTypes.Forest:
                Name = "Forresty";
                InitPopulation(10, 15, 10, 5);
                break;
            default:
                Name = "Craftovo";
                InitPopulation(10, 10, 15, 5);
                break;
        }
    }

    private void InitPopulation(int farmers, int woodcutters, int crafters, int traders)
    {
        Population[(int)PopType.Farmer] = new Pop(PopType.Farmer, farmers, config);
        Population[(int)PopType.Woodcutter] = new Pop(PopType.Woodcutter, woodcutters, config);
        Population[(int)PopType.Crafter] = new Pop(PopType.Crafter, crafters, config);
        Population[(int)PopType.Trader] = new Pop(
            PopType.Trader,
            Math.Max(1, (int)Math.Round(traders * config.TraderShare)),
            config);
    }

    // ---- turn phases ------------------------------------------------------

    public void BeginTurn()
    {
        Market.BeginTurn();
        RemainingTradePower = TradePower;
        CargoLost = 0;
        ExecutedDeals.Clear();
    }

    public void Produce(Random random)
    {
        foreach (Pop pop in Population)
        {
            double noise = 1 + (random.NextDouble() * 2 - 1) * config.ProductionNoise;
            pop.Produce(CityModifier(pop.Type), noise);
        }
    }

    public void CalculateNeed()
    {
        foreach (Pop pop in Population) pop.CalculateNeed(Market);
    }

    /// <summary>Sums up what the citizens want to buy and what they offer, then repricess the market.</summary>
    public void UpdateMarket()
    {
        foreach (ResourceType resource in Storage.All)
        {
            // Demand is what the citizens can actually pay for at the price they see now, not
            // what they wish they could buy. Counting the wishes of a bankrupt city keeps
            // pushing its prices up, which is the last thing its broke citizens need.
            double price = Market.PriceOf(resource);

            double demand = 0;
            double supply = 0;
            foreach (Pop pop in Population)
            {
                demand += pop.AffordableShortageOf(resource, price);
                supply += pop.SurplusOf(resource);
            }
            Market.Demand[resource] = demand;
            Market.Supply[resource] = supply;
        }

        Market.UpdatePrices();
    }

    /// <summary>
    /// Matches local sellers and buyers at the current price. Rationing is proportional,
    /// so the outcome does not depend on the order pops are stored in. Resources clear in
    /// a fixed order, which lets a pop spend the income from selling food on buying wood.
    /// </summary>
    public void ClearLocalMarket()
    {
        foreach (ResourceType resource in Storage.All)
        {
            double price = Market.PriceOf(resource);

            double offered = 0;
            double wanted = 0;
            foreach (Pop pop in Population)
            {
                offered += pop.SurplusOf(resource);
                wanted += pop.AffordableShortageOf(resource, price);
            }

            double traded = Math.Min(offered, wanted);
            if (traded <= SimulationConfig.Epsilon) continue;

            double sold = TakeFromSellers(resource, traded, price);
            double bought = GiveToBuyers(resource, sold, price);
            Market.Traded[resource] = bought;
        }
    }

    public void Consume()
    {
        foreach (Pop pop in Population) pop.Consume();
    }

    public void Spoil()
    {
        foreach (Pop pop in Population) pop.Spoil();
    }

    // ---- market plumbing --------------------------------------------------

    /// <summary>
    /// Removes up to <paramref name="amount"/> units from the pops that hold a surplus,
    /// proportionally to that surplus, and pays them <paramref name="price"/> per unit.
    /// The buyer is debited by the caller. Returns the units actually removed.
    /// </summary>
    public double TakeFromSellers(ResourceType resource, double amount, double price)
    {
        if (amount <= SimulationConfig.Epsilon) return 0;

        double totalSurplus = 0;
        foreach (Pop pop in Population) totalSurplus += pop.SurplusOf(resource);
        if (totalSurplus <= SimulationConfig.Epsilon) return 0;

        double target = Math.Min(amount, totalSurplus);
        double taken = 0;
        foreach (Pop pop in Population)
        {
            double surplus = pop.SurplusOf(resource);
            if (surplus <= SimulationConfig.Epsilon) continue;

            double share = target * (surplus / totalSurplus);
            double removed = pop.Inventory.Take(resource, share);
            pop.Receive(removed * price);
            taken += removed;
        }

        return taken;
    }

    /// <summary>
    /// Hands up to <paramref name="amount"/> units to the pops that want them and can pay,
    /// proportionally to that affordable shortage, debiting <paramref name="price"/> per unit.
    /// The seller is credited by the caller. Returns the units actually handed over.
    /// </summary>
    public double GiveToBuyers(ResourceType resource, double amount, double price)
    {
        if (amount <= SimulationConfig.Epsilon) return 0;

        double totalWant = AffordableDemandFor(resource, price);
        if (totalWant <= SimulationConfig.Epsilon) return 0;

        double target = Math.Min(amount, totalWant);
        double given = 0;
        foreach (Pop pop in Population)
        {
            double want = pop.AffordableShortageOf(resource, price);
            if (want <= SimulationConfig.Epsilon) continue;

            double share = target * (want / totalWant);
            // Guard against a rounding overshoot: never let a pop spend money it does not have.
            if (price > SimulationConfig.Epsilon) share = Math.Min(share, pop.Money / price);
            if (share <= SimulationConfig.Epsilon) continue;

            pop.Pay(share * price);
            pop.Inventory.Add(resource, share);
            given += share;
        }

        return given;
    }

    /// <summary>Units the citizens still want to buy at <paramref name="price"/> and can pay for.</summary>
    public double AffordableDemandFor(ResourceType resource, double price)
    {
        double total = 0;
        foreach (Pop pop in Population) total += pop.AffordableShortageOf(resource, price);
        return total;
    }

    /// <summary>Units currently offered for sale by the citizens.</summary>
    public double SurplusOf(ResourceType resource)
    {
        double total = 0;
        foreach (Pop pop in Population) total += pop.SurplusOf(resource);
        return total;
    }

    // ---- trade ------------------------------------------------------------

    /// <summary>
    /// Traders repeatedly take the most profitable deal they can find until they run out
    /// of trade power, money or profitable price gaps.
    /// </summary>
    public void Trade(int maxDealsPerTurn)
    {
        for (int i = 0; i < maxDealsPerTurn; ++i)
        {
            if (RemainingTradePower <= SimulationConfig.Epsilon) return;

            Deal deal = FindBestDeal();
            if (!deal.IsPossible) return;

            double moved = deal.Execute();
            if (moved <= SimulationConfig.Epsilon) return;

            RemainingTradePower -= moved;
            CargoLost += deal.CargoLost;
            ExecutedDeals.Add(deal);
        }
    }

    /// <summary>
    /// The most profitable deal available to this city's traders. Both directions are
    /// considered: exporting a local surplus to a neighbour, and importing what a
    /// neighbour sells cheaply. Returns <see cref="Deal.None"/> if no price gap covers
    /// the transport cost.
    /// </summary>
    public Deal FindBestDeal()
    {
        Deal best = Deal.None;
        foreach (City neighbour in NeighbourCities)
        {
            foreach (ResourceType resource in Storage.All)
            {
                Consider(Deal.Evaluate(Traders, this, neighbour, resource, RemainingTradePower, config));
                Consider(Deal.Evaluate(Traders, neighbour, this, resource, RemainingTradePower, config));
            }
        }
        return best;

        void Consider(Deal candidate)
        {
            if (candidate.IsPossible && candidate.TotalProfit > best.TotalProfit) best = candidate;
        }
    }

    private double CityModifier(PopType popType)
    {
        if (Type == CityTypes.Center) return config.CapitalBonus;

        bool specialised =
            (Type == CityTypes.Plain && popType == PopType.Farmer) ||
            (Type == CityTypes.Forest && popType == PopType.Woodcutter) ||
            (Type == CityTypes.Mountains && popType == PopType.Crafter);

        return specialised ? config.SpecializationBonus : 1.0;
    }

    // ---- reporting --------------------------------------------------------

    public double TotalMoney
    {
        get
        {
            double total = 0;
            foreach (Pop pop in Population) total += pop.Money;
            return total;
        }
    }

    public double StockOf(ResourceType resource)
    {
        double total = 0;
        foreach (Pop pop in Population) total += pop.Inventory[resource];
        return total;
    }

    /// <summary>Share of the need for <paramref name="resource"/> the citizens covered last turn, weighted by head count.</summary>
    public double SatisfactionOf(ResourceType resource)
    {
        double weighted = 0;
        double people = 0;
        foreach (Pop pop in Population)
        {
            weighted += pop.Satisfaction[resource] * pop.Count;
            people += pop.Count;
        }
        return people > 0 ? weighted / people : 1;
    }

    public string PopsInfo()
    {
        var output = new System.Text.StringBuilder();
        foreach (Pop pop in Population)
        {
            output.Append($"  {pop.Type,-11} x{pop.Count,-4} money {pop.Money,9:F1}   wealth {pop.WealthIn(Market),9:F1}   fed {pop.Satisfaction[ResourceType.Food],5:P0}\n");
        }
        return output.ToString();
    }

    public string ResourceInfo()
    {
        var output = new System.Text.StringBuilder();
        foreach (ResourceType resource in Storage.All)
        {
            output.Append($"  {resource,-6} price {Market.PriceOf(resource),7:F2}   stock {StockOf(resource),8:F1}   traded {Market.Traded[resource],7:F1}   in {Market.Imported[resource],6:F1}   out {Market.Exported[resource],6:F1}\n");
        }
        return output.ToString();
    }
}
