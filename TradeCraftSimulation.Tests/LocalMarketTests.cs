using Simulator;
using Xunit;

namespace TradeCraftSimulation.Tests;

public class LocalMarketTests
{
    private static City ReadyCity(SimulationConfig config)
    {
        var city = new City(CityTypes.Plain, config);
        city.BeginTurn();
        city.Produce(new Random(1));
        city.CalculateNeed();
        city.UpdateMarket();
        return city;
    }

    private static double TotalMoney(City city)
    {
        double total = 0;
        foreach (Pop pop in city.Population) total += pop.Money;
        return total;
    }

    private static double TotalGoods(City city)
    {
        double total = 0;
        foreach (Pop pop in city.Population) total += pop.Inventory.Total;
        return total;
    }

    [Fact]
    public void Clearing_the_local_market_moves_money_around_without_creating_any()
    {
        City city = ReadyCity(new SimulationConfig());
        double before = TotalMoney(city);

        city.ClearLocalMarket();

        Assert.Equal(before, TotalMoney(city), 6);
    }

    [Fact]
    public void Clearing_the_local_market_moves_goods_around_without_creating_any()
    {
        City city = ReadyCity(new SimulationConfig());
        double before = TotalGoods(city);

        city.ClearLocalMarket();

        Assert.Equal(before, TotalGoods(city), 6);
    }

    [Fact]
    public void Nobody_ends_up_owing_money()
    {
        City city = ReadyCity(new SimulationConfig());

        city.ClearLocalMarket();

        foreach (Pop pop in city.Population) Assert.True(pop.Money >= 0, $"{pop.Type} has {pop.Money}");
    }

    [Fact]
    public void A_pop_without_money_buys_nothing()
    {
        City city = ReadyCity(new SimulationConfig());
        Pop crafter = city.Population[(int)PopType.Crafter];
        crafter.Money = 0;
        double tools = crafter.Inventory[ResourceType.Tools];
        double food = crafter.Inventory[ResourceType.Food];

        city.ClearLocalMarket();

        Assert.Equal(food, crafter.Inventory[ResourceType.Food], 9);
        Assert.True(crafter.Inventory[ResourceType.Tools] <= tools);
    }

    [Fact]
    public void Consumption_eats_the_need_and_reports_a_full_belly()
    {
        var config = new SimulationConfig();
        var city = new City(CityTypes.Plain, config);
        city.CalculateNeed();

        Pop farmer = city.Population[(int)PopType.Farmer];
        farmer.Inventory.Add(ResourceType.Food, farmer.Need[ResourceType.Food]);

        farmer.Consume();

        Assert.Equal(0, farmer.Inventory[ResourceType.Food], 9);
        Assert.Equal(1.0, farmer.Satisfaction[ResourceType.Food], 9);
    }

    [Fact]
    public void Half_the_food_means_half_a_belly_and_never_a_negative_stock()
    {
        var config = new SimulationConfig();
        var city = new City(CityTypes.Plain, config);
        city.CalculateNeed();

        Pop farmer = city.Population[(int)PopType.Farmer];
        farmer.Inventory.Add(ResourceType.Food, farmer.Need[ResourceType.Food] / 2);

        farmer.Consume();

        Assert.Equal(0.5, farmer.Satisfaction[ResourceType.Food], 9);
        Assert.Equal(0, farmer.Inventory[ResourceType.Food], 9);
    }

    [Fact]
    public void Leftovers_spoil_by_the_configured_share()
    {
        var config = new SimulationConfig { WoodSpoilage = 0.25 };
        var city = new City(CityTypes.Plain, config);
        Pop pop = city.Population[(int)PopType.Woodcutter];
        pop.Inventory.Add(ResourceType.Wood, 100);

        pop.Spoil();

        Assert.Equal(75, pop.Inventory[ResourceType.Wood], 9);
    }
}
