using System.Globalization;

namespace Simulator;

/// <summary>
/// Dumps one row per turn/city/resource in long format, ready to be pivoted in a
/// spreadsheet. Without a time series it is impossible to tell a converging economy
/// from a slowly exploding one.
/// </summary>
public sealed class CsvLogger : IDisposable
{
    private readonly TextWriter writer;

    public CsvLogger(TextWriter writer)
    {
        this.writer = writer;
        this.writer.WriteLine("turn,city,resource,price,demand,supply,traded,imported,exported,stock,satisfaction,city_money");
    }

    public CsvLogger(string path) : this(new StreamWriter(path, append: false)) { }

    public void WriteTurn(Simulation simulation)
    {
        foreach (City city in simulation.Cities)
        {
            double money = city.TotalMoney;
            foreach (ResourceType resource in Storage.All)
            {
                writer.WriteLine(string.Join(',',
                    simulation.Turn.ToString(CultureInfo.InvariantCulture),
                    city.Name,
                    resource,
                    Num(city.Market.PriceOf(resource)),
                    Num(city.Market.Demand[resource]),
                    Num(city.Market.Supply[resource]),
                    Num(city.Market.Traded[resource]),
                    Num(city.Market.Imported[resource]),
                    Num(city.Market.Exported[resource]),
                    Num(city.StockOf(resource)),
                    Num(city.SatisfactionOf(resource)),
                    Num(money)));
            }
        }
    }

    private static string Num(double value) => value.ToString("F4", CultureInfo.InvariantCulture);

    public void Dispose() => writer.Dispose();
}
