using Simulator;
using Xunit;

namespace TradeCraftSimulation.Tests;

public class MarketTests
{
    private static readonly SimulationConfig Config = new();

    [Fact]
    public void Market_opens_at_the_base_prices()
    {
        var market = new Market(Config);

        Assert.Equal(Config.BasicFoodPrice, market.PriceOf(ResourceType.Food));
        Assert.Equal(Config.BasicWoodPrice, market.PriceOf(ResourceType.Wood));
        Assert.Equal(Config.BasicToolsPrice, market.PriceOf(ResourceType.Tools));
    }

    [Fact]
    public void Price_rises_when_demand_exceeds_supply_but_never_by_more_than_the_max_step()
    {
        var market = new Market(Config);
        double before = market.PriceOf(ResourceType.Food);

        market.Demand[ResourceType.Food] = 100;
        market.Supply[ResourceType.Food] = 10;
        market.UpdatePrices();

        Assert.Equal(before * (1 + Config.MaxPriceStep), market.PriceOf(ResourceType.Food), 9);
    }

    [Fact]
    public void Price_falls_when_supply_exceeds_demand_but_never_by_more_than_the_max_step()
    {
        var market = new Market(Config);
        double before = market.PriceOf(ResourceType.Food);

        market.Demand[ResourceType.Food] = 10;
        market.Supply[ResourceType.Food] = 100;
        market.UpdatePrices();

        Assert.Equal(before * (1 - Config.MaxPriceStep), market.PriceOf(ResourceType.Food), 9);
    }

    [Fact]
    public void Price_holds_when_demand_matches_supply()
    {
        var market = new Market(Config);
        double before = market.PriceOf(ResourceType.Wood);

        market.Demand[ResourceType.Wood] = 42;
        market.Supply[ResourceType.Wood] = 42;
        market.UpdatePrices();

        Assert.Equal(before, market.PriceOf(ResourceType.Wood), 9);
    }

    [Fact]
    public void Price_holds_when_a_resource_is_neither_wanted_nor_offered()
    {
        var market = new Market(Config);
        double before = market.PriceOf(ResourceType.Tools);

        market.Demand[ResourceType.Tools] = 0;
        market.Supply[ResourceType.Tools] = 0;
        market.UpdatePrices();

        Assert.Equal(before, market.PriceOf(ResourceType.Tools), 9);
    }

    [Fact]
    public void Price_never_leaves_the_allowed_range()
    {
        var market = new Market(Config);

        for (int i = 0; i < 500; ++i)
        {
            market.Demand[ResourceType.Wood] = 0;
            market.Supply[ResourceType.Wood] = 1000;
            market.UpdatePrices();
        }
        Assert.Equal(Config.MinPrice, market.PriceOf(ResourceType.Wood), 9);

        for (int i = 0; i < 5000; ++i)
        {
            market.Demand[ResourceType.Wood] = 1000;
            market.Supply[ResourceType.Wood] = 0;
            market.UpdatePrices();
        }
        Assert.Equal(Config.MaxPrice, market.PriceOf(ResourceType.Wood), 9);
    }

    [Fact]
    public void Barter_rate_is_the_ratio_of_the_two_prices()
    {
        var market = new Market(Config);

        double rate = market.PriceInAnotherResource(ResourceType.Tools, ResourceType.Food);

        Assert.Equal(Config.BasicToolsPrice / Config.BasicFoodPrice, rate, 9);
    }

    [Fact]
    public void Nothing_can_be_priced_in_nothing()
    {
        var market = new Market(Config);

        Assert.Equal(0, market.PriceInAnotherResource(ResourceType.None, ResourceType.Food));
        Assert.Equal(0, market.PriceInAnotherResource(ResourceType.Food, ResourceType.None));
        Assert.Equal(0, market.PriceOf(ResourceType.None));
    }

    [Fact]
    public void Cheap_goods_are_wanted_beyond_the_bare_need_and_dear_ones_below_it()
    {
        var config = new SimulationConfig();
        double basePrice = config.BasePrice(ResourceType.Food);

        Assert.Equal(1, config.DemandMultiplier(ResourceType.Food, basePrice), 9);
        Assert.True(config.DemandMultiplier(ResourceType.Food, basePrice / 4) > 1);
        Assert.True(config.DemandMultiplier(ResourceType.Food, basePrice * 4) < 1);

        Assert.Equal(config.MaxDemandMultiplier, config.DemandMultiplier(ResourceType.Food, 1e-12), 9);
        Assert.Equal(config.MinDemandMultiplier, config.DemandMultiplier(ResourceType.Food, 1e12), 9);
    }
}
