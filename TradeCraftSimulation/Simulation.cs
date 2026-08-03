namespace Simulator;

/// <summary>
/// The world: four cities wired in a star around the capital, and the turn loop that
/// drives them. Everything is deterministic for a given <see cref="SimulationConfig.Seed"/>.
/// </summary>
public class Simulation
{
    private readonly Random random;

    public SimulationConfig Config { get; }
    public City[] Cities { get; } = new City[4];
    public int Turn { get; private set; }

    /// <summary>Units of cargo lost on the road since the start of the run.</summary>
    public double TotalCargoLost { get; private set; }

    public Simulation(SimulationConfig? config = null)
    {
        Config = config ?? new SimulationConfig();
        random = new Random(Config.Seed);

        Cities[0] = new City(CityTypes.Center, Config);
        Cities[1] = new City(CityTypes.Plain, Config);
        Cities[2] = new City(CityTypes.Forest, Config);
        Cities[3] = new City(CityTypes.Mountains, Config);

        ConnectCities(Cities[0], Cities[1]);
        ConnectCities(Cities[0], Cities[2]);
        ConnectCities(Cities[0], Cities[3]);
    }

    private static void ConnectCities(City first, City second)
    {
        first.NeighbourCities.Add(second);
        second.NeighbourCities.Add(first);
    }

    /// <summary>
    /// One turn, in the only order that makes the loop close:
    /// produce -> price -> trade between cities -> local market -> consume -> spoil.
    /// Trade has to run before the local market: once the locals have spent their money
    /// on the (insufficient) local supply, there is nobody left to sell the imports to.
    /// </summary>
    public void RunTurn()
    {
        ++Turn;

        foreach (City city in Cities) city.BeginTurn();

        foreach (City city in Cities)
        {
            city.Produce(random);
            city.CalculateNeed();
        }

        // Prices react to this turn's stocks and needs before anybody trades on them.
        foreach (City city in Cities) city.UpdateMarket();

        // Traders move goods from the cheap market to the expensive one.
        foreach (City city in Cities) city.Trade(Config.MaxDealsPerTurn);

        // Whatever is left changes hands at home.
        foreach (City city in Cities) city.ClearLocalMarket();

        foreach (City city in Cities)
        {
            city.Consume();
            city.Spoil();
        }

        foreach (City city in Cities) TotalCargoLost += city.CargoLost;
    }

    /// <summary>All the money in the world. It is a closed system: this never changes.</summary>
    public double TotalMoney
    {
        get
        {
            double total = 0;
            foreach (City city in Cities) total += city.TotalMoney;
            return total;
        }
    }

    public string CityView()
    {
        var output = new System.Text.StringBuilder();
        output.Append($"===== TURN {Turn} =====  money in the world: {TotalMoney:F1}  (cargo lost on the road so far: {TotalCargoLost:F1})\n");
        foreach (City city in Cities)
        {
            output.Append($"\n{city.Name} [{city.Type}]\n");
            output.Append(city.PopsInfo());
            output.Append(city.ResourceInfo());
        }
        return output.ToString();
    }
}
