using Simulator;
using Xunit;

namespace TradeCraftSimulation.Tests;

public class SimulationTests
{
    private static string RunToCsv(int seed, int turns)
    {
        var simulation = new Simulation(new SimulationConfig { Seed = seed });
        var writer = new StringWriter();
        var logger = new CsvLogger(writer);

        for (int i = 0; i < turns; ++i)
        {
            simulation.RunTurn();
            logger.WriteTurn(simulation);
        }

        return writer.ToString();
    }

    [Fact]
    public void The_money_stock_of_the_world_never_changes()
    {
        var simulation = new Simulation();
        double before = simulation.TotalMoney;

        for (int i = 0; i < 200; ++i) simulation.RunTurn();

        Assert.Equal(before, simulation.TotalMoney, 6);
    }

    [Fact]
    public void Nothing_goes_negative_or_turns_into_a_NaN()
    {
        var simulation = new Simulation();

        for (int turn = 0; turn < 200; ++turn)
        {
            simulation.RunTurn();

            foreach (City city in simulation.Cities)
            {
                foreach (ResourceType resource in Storage.All)
                {
                    double price = city.Market.PriceOf(resource);
                    Assert.False(double.IsNaN(price) || double.IsInfinity(price));
                    Assert.InRange(price, simulation.Config.MinPrice, simulation.Config.MaxPrice);
                    Assert.True(city.StockOf(resource) >= 0);
                    Assert.InRange(city.SatisfactionOf(resource), 0, 1);
                }

                foreach (Pop pop in city.Population)
                {
                    Assert.True(pop.Money >= 0, $"turn {simulation.Turn}: {city.Name} {pop.Type} has {pop.Money}");
                    Assert.False(double.IsNaN(pop.Money));
                }
            }
        }
    }

    [Fact]
    public void The_same_seed_replays_the_same_run()
    {
        Assert.Equal(RunToCsv(seed: 7, turns: 40), RunToCsv(seed: 7, turns: 40));
    }

    [Fact]
    public void A_different_seed_gives_a_different_run()
    {
        Assert.NotEqual(RunToCsv(seed: 7, turns: 40), RunToCsv(seed: 8, turns: 40));
    }

    [Fact]
    public void Trade_between_cities_actually_happens_and_keeps_happening()
    {
        var simulation = new Simulation();

        for (int i = 0; i < 50; ++i) simulation.RunTurn();
        Assert.True(simulation.TotalCargoLost > 0, "no cargo ever moved, so no deal was ever executed");

        double movedByTurn50 = simulation.TotalCargoLost;
        for (int i = 0; i < 50; ++i) simulation.RunTurn();

        Assert.True(
            simulation.TotalCargoLost > movedByTurn50,
            "trade died out: the traders went bankrupt or the price gaps closed for good");
    }

    [Theory]
    [InlineData(1)]
    [InlineData(42)]
    [InlineData(99)]
    public void Every_good_ends_up_cheapest_in_the_city_that_specialises_in_it(int seed)
    {
        var simulation = new Simulation(new SimulationConfig { Seed = seed });
        for (int i = 0; i < 300; ++i) simulation.RunTurn();

        Assert.Equal(CityTypes.Plain, CheapestFor(simulation, ResourceType.Food));
        Assert.Equal(CityTypes.Forest, CheapestFor(simulation, ResourceType.Wood));
        Assert.Equal(CityTypes.Mountains, CheapestFor(simulation, ResourceType.Tools));
    }

    private static CityTypes CheapestFor(Simulation simulation, ResourceType resource)
    {
        City cheapest = simulation.Cities[0];
        foreach (City city in simulation.Cities)
        {
            if (city.Market.PriceOf(resource) < cheapest.Market.PriceOf(resource)) cheapest = city;
        }
        return cheapest.Type;
    }

    [Fact]
    public void Every_city_keeps_producing_and_consuming_instead_of_hoarding_forever()
    {
        var simulation = new Simulation();
        for (int i = 0; i < 300; ++i) simulation.RunTurn();

        foreach (City city in simulation.Cities)
        {
            // A stock that has run away is the symptom of the loop not closing: goods produced
            // turn after turn that nobody ever buys, eats or lets rot.
            Assert.True(
                city.StockOf(ResourceType.Wood) < 2000,
                $"{city.Name} is sitting on {city.StockOf(ResourceType.Wood):F0} wood");
        }
    }
}
