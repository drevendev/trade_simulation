using Simulator;
using Xunit;

namespace TradeCraftSimulation.Tests;

public class DealTests
{
    private const ResourceType Traded = ResourceType.Wood;

    /// <summary>Two connected cities, ready to trade, with the price of wood set by hand.</summary>
    private static (City home, City neighbour) Pair(SimulationConfig config, double homePrice, double neighbourPrice)
    {
        var home = new City(CityTypes.Center, config);
        var neighbour = new City(CityTypes.Forest, config);
        home.NeighbourCities.Add(neighbour);
        neighbour.NeighbourCities.Add(home);

        foreach (City city in new[] { home, neighbour })
        {
            city.BeginTurn();
            city.Produce(new Random(1));
            city.CalculateNeed();
        }

        home.Market.Price[Traded] = homePrice;
        neighbour.Market.Price[Traded] = neighbourPrice;
        return (home, neighbour);
    }

    private static double MoneyIn(params City[] cities)
    {
        double total = 0;
        foreach (City city in cities)
        foreach (Pop pop in city.Population) total += pop.Money;
        return total;
    }

    private static double GoodsIn(params City[] cities)
    {
        double total = 0;
        foreach (City city in cities)
        foreach (Pop pop in city.Population) total += pop.Inventory.Total;
        return total;
    }

    [Fact]
    public void Equal_prices_are_not_worth_a_trip()
    {
        var config = new SimulationConfig();
        (City home, City neighbour) = Pair(config, 1.0, 1.0);

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 100, config);

        Assert.False(deal.IsPossible);
        Assert.Same(Deal.None, deal);
    }

    [Fact]
    public void A_gap_narrower_than_the_transport_loss_is_not_worth_a_trip()
    {
        var config = new SimulationConfig { TransportLossShare = 0.1 };
        // Selling at 1.05 loses 10% of the cargo, which is worse than not going at all.
        (City home, City neighbour) = Pair(config, 1.0, 1.05);

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 100, config);

        Assert.False(deal.IsPossible);
    }

    [Fact]
    public void A_gap_wider_than_the_transport_loss_is_worth_a_trip()
    {
        var config = new SimulationConfig { TransportLossShare = 0.1 };
        (City home, City neighbour) = Pair(config, 1.0, 2.0);

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 100, config);

        Assert.True(deal.IsPossible);
        Assert.Equal(2.0 * 0.9 - 1.0, deal.ProfitPerUnit, 9);
        Assert.Equal(deal.ProfitPerUnit * deal.Amount, deal.TotalProfit, 9);
    }

    [Fact]
    public void A_deal_is_never_bigger_than_the_trade_power_left()
    {
        var config = new SimulationConfig();
        (City home, City neighbour) = Pair(config, 0.1, 5.0);

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 7, config);

        Assert.True(deal.IsPossible);
        Assert.True(deal.Amount <= 7 + SimulationConfig.Epsilon, $"amount was {deal.Amount}");
    }

    [Fact]
    public void A_deal_never_strips_more_than_the_allowed_share_of_the_surplus()
    {
        var config = new SimulationConfig { MaxSurplusShareTraded = 0.25 };
        (City home, City neighbour) = Pair(config, 0.1, 5.0);
        double surplus = home.SurplusOf(Traded);

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 1e9, config);

        Assert.True(deal.Amount <= surplus * 0.25 + SimulationConfig.Epsilon);
    }

    [Fact]
    public void Traders_cannot_buy_what_they_cannot_pay_for()
    {
        var config = new SimulationConfig();
        (City home, City neighbour) = Pair(config, 1.0, 5.0);
        home.Traders.Money = 10;

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 1e9, config);

        Assert.True(deal.Amount <= 10.0 / 1.0 + SimulationConfig.Epsilon, $"amount was {deal.Amount}");
    }

    [Fact]
    public void Executing_a_deal_moves_goods_and_loses_exactly_the_transport_share()
    {
        var config = new SimulationConfig { TransportLossShare = 0.1 };
        (City home, City neighbour) = Pair(config, 0.5, 4.0);
        double goodsBefore = GoodsIn(home, neighbour);

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 50, config);
        double moved = deal.Execute();

        Assert.True(moved > 0);
        Assert.Equal(moved * 0.1, deal.CargoLost, 9);
        Assert.Equal(goodsBefore - deal.CargoLost, GoodsIn(home, neighbour), 6);
    }

    [Fact]
    public void Executing_a_deal_never_creates_or_destroys_money()
    {
        var config = new SimulationConfig();
        (City home, City neighbour) = Pair(config, 0.5, 4.0);
        double moneyBefore = MoneyIn(home, neighbour);

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 50, config);
        deal.Execute();

        Assert.Equal(moneyBefore, MoneyIn(home, neighbour), 6);
    }

    [Fact]
    public void A_trader_that_carried_goods_out_earns_the_margin()
    {
        var config = new SimulationConfig { TransportLossShare = 0.05 };
        (City home, City neighbour) = Pair(config, 0.5, 4.0);
        double before = home.Traders.Money;

        Deal deal = Deal.Evaluate(home.Traders, home, neighbour, Traded, 50, config);
        deal.Execute();

        Assert.True(deal.SoldAmount > 0);
        Assert.Equal(deal.RealizedProfit, home.Traders.Money - before, 6);
        Assert.True(deal.RealizedProfit > 0, $"profit was {deal.RealizedProfit}");
    }

    [Fact]
    public void Traders_also_import_what_a_neighbour_sells_cheaply()
    {
        var config = new SimulationConfig();
        // Wood is dear at home and cheap next door, so the profitable route runs inwards.
        (City home, City neighbour) = Pair(config, 5.0, 0.5);

        Deal deal = home.FindBestDeal();

        Assert.True(deal.IsPossible);
        Assert.Same(neighbour, deal.From);
        Assert.Same(home, deal.To);
        Assert.Same(home.Traders, deal.Traders);
    }

    [Fact]
    public void The_best_deal_is_the_one_that_earns_the_most()
    {
        var config = new SimulationConfig();
        var home = new City(CityTypes.Center, config);
        var cheap = new City(CityTypes.Forest, config);
        var cheaper = new City(CityTypes.Plain, config);
        foreach (City other in new[] { cheap, cheaper })
        {
            home.NeighbourCities.Add(other);
            other.NeighbourCities.Add(home);
        }

        foreach (City city in new[] { home, cheap, cheaper })
        {
            city.BeginTurn();
            city.Produce(new Random(1));
            city.CalculateNeed();
        }

        home.Market.Price[Traded] = 5.0;
        cheap.Market.Price[Traded] = 2.0;
        cheaper.Market.Price[Traded] = 0.2;

        // Both suppliers need a surplus worth hauling, otherwise the winner is decided by
        // who has the goods rather than by who is cheapest.
        cheap.Population[(int)PopType.Woodcutter].Inventory.Add(Traded, 500);
        cheaper.Population[(int)PopType.Woodcutter].Inventory.Add(Traded, 500);

        Deal deal = home.FindBestDeal();

        Assert.Same(cheaper, deal.From);
    }

    [Fact]
    public void A_deal_with_nothing_to_trade_is_not_possible()
    {
        Assert.False(Deal.None.IsPossible);
        Assert.Equal(0, Deal.None.TotalProfit);
        Assert.Equal(0, Deal.None.Execute());
    }
}
