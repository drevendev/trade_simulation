namespace Simulator;

public enum ResourceType
{
    None = -1,
    Food = 0,
    Wood = 1,
    Tools = 2
}

/// <summary>
/// A bag of goods. Money is deliberately not a resource here: it is held by
/// <see cref="Pop"/> and serves as the numeraire that goods are priced in.
/// </summary>
public class Storage
{
    public const int ResourceCount = 3;

    /// <summary>All tradable resources, handy for iteration.</summary>
    public static readonly ResourceType[] All =
    {
        ResourceType.Food, ResourceType.Wood, ResourceType.Tools
    };

    private readonly double[] amounts = new double[ResourceCount];

    public double this[ResourceType resource]
    {
        get => amounts[Index(resource)];
        set => amounts[Index(resource)] = value;
    }

    public double Total
    {
        get
        {
            double total = 0;
            foreach (double amount in amounts) total += amount;
            return total;
        }
    }

    public void Add(ResourceType resource, double amount)
    {
        if (amount < 0) throw new ArgumentOutOfRangeException(nameof(amount), amount, "Use Take to remove goods.");
        amounts[Index(resource)] += amount;
    }

    /// <summary>Removes up to <paramref name="requested"/> units and returns how much was actually taken.</summary>
    public double Take(ResourceType resource, double requested)
    {
        if (requested < 0) throw new ArgumentOutOfRangeException(nameof(requested), requested, "Use Add to put goods in.");
        int index = Index(resource);
        double taken = Math.Min(requested, amounts[index]);
        amounts[index] -= taken;
        if (amounts[index] < SimulationConfig.Epsilon) amounts[index] = 0;
        return taken;
    }

    public void Clear() => Array.Clear(amounts);

    private static int Index(ResourceType resource)
    {
        if (resource == ResourceType.None)
            throw new ArgumentOutOfRangeException(nameof(resource), "ResourceType.None cannot be stored.");
        return (int)resource;
    }
}
