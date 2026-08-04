namespace Simulator;

/// <summary>
/// Every tunable number of the model in one place, so that balancing the economy
/// does not require hunting for magic constants across the code base.
/// </summary>
public class SimulationConfig
{
    /// <summary>Seed of the production noise generator. Same seed => same run.</summary>
    public int Seed { get; set; } = 42;

    // ---- production -------------------------------------------------------

    /// <summary>Relative amplitude of the random production jitter (0.05 = +/-5%).</summary>
    public double ProductionNoise { get; set; } = 0.05;

    /// <summary>Output multiplier a city gets on the resource it is specialised in.</summary>
    public double SpecializationBonus { get; set; } = 1.5;

    /// <summary>
    /// Output multiplier of the capital on everything. A quarter of its population are
    /// traders who produce nothing, so without it the capital is structurally short of
    /// every good, pays for the imports out of a fixed money stock and goes broke.
    /// </summary>
    public double CapitalBonus { get; set; } = 1.25;

    // ---- consumption ------------------------------------------------------

    // The needs are calibrated against the production powers in Pop so that the world
    // as a whole produces a few percent more than it eats, while every single city is
    // short of something. That deficit is what makes trade worth doing.

    // Calibrated as total world output divided by total population: 337.5 food, 675 wood and
    // 67.5 tools produced by 165 producers, feeding those 165 plus 12 traders. The world as a
    // whole is then exactly self-sufficient while every single city is short of something,
    // and that gap is what makes trade worth doing. Change TraderShare and these move too.

    /// <summary>Units of food a single person needs per turn.</summary>
    public double FoodPerCapita { get; set; } = 1.9068;

    /// <summary>Units of wood a single person needs per turn.</summary>
    public double WoodPerCapita { get; set; } = 3.8136;

    /// <summary>Units of tools a single person needs per turn.</summary>
    public double ToolsPerCapita { get; set; } = 0.3814;

    // ---- spoilage ---------------------------------------------------------
    // Without decay every stock grows without bound and prices collapse to the floor.

    /// <summary>Share of the leftover food lost at the end of a turn.</summary>
    public double FoodSpoilage { get; set; } = 0.5;

    /// <summary>Share of the leftover wood lost at the end of a turn.</summary>
    public double WoodSpoilage { get; set; } = 0.25;

    /// <summary>Share of the leftover tools lost at the end of a turn.</summary>
    public double ToolsSpoilage { get; set; } = 0.15;

    // ---- prices -----------------------------------------------------------

    public double BasicFoodPrice { get; set; } = 2;
    public double BasicWoodPrice { get; set; } = 1;
    public double BasicToolsPrice { get; set; } = 10;

    /// <summary>Maximum relative price change per turn (0.10 = at most +/-10%).</summary>
    public double MaxPriceStep { get; set; } = 0.10;

    public double MinPrice { get; set; } = 0.05;
    public double MaxPrice { get; set; } = 1000;

    // Without elasticity demand is a hard ceiling and supply a hard floor, so any lasting
    // imbalance compounds at MaxPriceStep per turn until the price hits a clamp. Buying more
    // of what is cheap and going without what is dear is what brakes both runaways.

    /// <summary>How strongly demand reacts to the price deviating from the base price. 0 disables elasticity.</summary>
    public double DemandElasticity { get; set; } = 0.5;

    /// <summary>
    /// How far demand can rise above the bare need when a good is cheap. This is also what
    /// keeps money in circulation: without a generous ceiling a pop that has accumulated money
    /// has nothing left to spend it on, and the money stops coming back to the producers.
    /// </summary>
    public double MaxDemandMultiplier { get; set; } = 6.0;

    /// <summary>How far demand can fall below the bare need when a good is dear. Food is a
    /// necessity, so the floor is deliberately close to 1: people go hungry, they do not stop eating.</summary>
    public double MinDemandMultiplier { get; set; } = 0.8;

    // ---- money ------------------------------------------------------------

    /// <summary>Money each pop starts with, per person.</summary>
    public double StartingMoneyPerCapita { get; set; } = 20;

    /// <summary>
    /// Extra starting capital for traders. All markets open at the same base prices, so it
    /// takes a few turns before any price gap is worth arbitraging; without working capital
    /// the traders starve before trade can bootstrap itself.
    /// </summary>
    public double TraderCapitalMultiplier { get; set; } = 5;

    // ---- trade ------------------------------------------------------------

    /// <summary>
    /// Share of the cargo that does not survive the trip to a neighbouring city. This is the
    /// cost of trade, and it is charged in goods rather than in money on purpose: a money
    /// cost would burn the fixed money stock of the world turn after turn until everybody is
    /// broke. Zero would let arbitrage equalise prices instantly.
    /// </summary>
    public double TransportLossShare { get; set; } = 0.05;

    /// <summary>
    /// How many units one trader can move per turn. Traders eat but produce nothing, so
    /// this has to be large enough for the margin on the goods they move to feed them.
    /// </summary>
    public double TradePowerPerTrader { get; set; } = 25;

    /// <summary>Share of a city's surplus a single deal may strip away.</summary>
    public double MaxSurplusShareTraded { get; set; } = 0.5;

    /// <summary>
    /// Head count of the trader pop, as a share of the counts the cities were designed with.
    /// Traders live off the margin they themselves arbitrage away, so the merchant class
    /// cannot be larger than the trade flow can feed.
    /// </summary>
    public double TraderShare { get; set; } = 0.3;

    /// <summary>How many deals the traders of one city may execute per turn.</summary>
    public int MaxDealsPerTurn { get; set; } = 4;

    /// <summary>Amounts below this are treated as zero.</summary>
    public const double Epsilon = 1e-9;

    public double SpoilageOf(ResourceType resource) => resource switch
    {
        ResourceType.Food => FoodSpoilage,
        ResourceType.Wood => WoodSpoilage,
        ResourceType.Tools => ToolsSpoilage,
        _ => 0
    };

    public double NeedPerCapita(ResourceType resource) => resource switch
    {
        ResourceType.Food => FoodPerCapita,
        ResourceType.Wood => WoodPerCapita,
        ResourceType.Tools => ToolsPerCapita,
        _ => 0
    };

    /// <summary>
    /// How much of the bare need a pop actually asks for at <paramref name="price"/>:
    /// more than it needs when the good is cheap, less when it is dear.
    /// </summary>
    public double DemandMultiplier(ResourceType resource, double price)
    {
        double basePrice = BasePrice(resource);
        if (DemandElasticity <= 0 || basePrice <= Epsilon) return 1;
        if (price <= Epsilon) return MaxDemandMultiplier;

        return Math.Clamp(
            Math.Pow(basePrice / price, DemandElasticity),
            MinDemandMultiplier,
            MaxDemandMultiplier);
    }

    public double BasePrice(ResourceType resource) => resource switch
    {
        ResourceType.Food => BasicFoodPrice,
        ResourceType.Wood => BasicWoodPrice,
        ResourceType.Tools => BasicToolsPrice,
        _ => 0
    };
}
