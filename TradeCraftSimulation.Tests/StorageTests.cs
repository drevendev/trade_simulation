using Simulator;
using Xunit;

namespace TradeCraftSimulation.Tests;

public class StorageTests
{
    [Fact]
    public void Take_never_hands_out_more_than_is_there()
    {
        var storage = new Storage();
        storage.Add(ResourceType.Food, 10);

        Assert.Equal(10, storage.Take(ResourceType.Food, 25));
        Assert.Equal(0, storage[ResourceType.Food]);
    }

    [Fact]
    public void Take_leaves_the_remainder_alone()
    {
        var storage = new Storage();
        storage.Add(ResourceType.Wood, 10);

        Assert.Equal(4, storage.Take(ResourceType.Wood, 4));
        Assert.Equal(6, storage[ResourceType.Wood]);
    }

    [Fact]
    public void Total_sums_every_resource()
    {
        var storage = new Storage();
        storage.Add(ResourceType.Food, 1);
        storage.Add(ResourceType.Wood, 2);
        storage.Add(ResourceType.Tools, 3);

        Assert.Equal(6, storage.Total);
    }

    [Fact]
    public void Negative_amounts_are_rejected_instead_of_silently_flipping_a_sign()
    {
        var storage = new Storage();

        Assert.Throws<ArgumentOutOfRangeException>(() => storage.Add(ResourceType.Food, -1));
        Assert.Throws<ArgumentOutOfRangeException>(() => storage.Take(ResourceType.Food, -1));
    }

    [Fact]
    public void Nothing_cannot_be_stored()
    {
        var storage = new Storage();

        Assert.Throws<ArgumentOutOfRangeException>(() => storage.Add(ResourceType.None, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => _ = storage[ResourceType.None]);
    }
}
