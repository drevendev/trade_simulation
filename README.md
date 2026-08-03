# TradeCraftSimulation

A toy economy across four trading cities. Nobody sets prices: each city has its own market,
prices follow local supply and demand, and merchants make a living carrying goods from the
market where they are cheap to the market where they are dear.

Run it for a few hundred turns and the interesting part shows up on its own — every good ends
up cheapest in the city that specialises in it, and the capital turns into the entrepot the
provinces trade through.

## The model

**Goods.** Food, wood and tools. Money is not a good: it is held by the population and is the
unit every price is quoted in, which is what makes prices comparable between cities.

**Population.** Every city has four pops. Farmers make food, woodcutters make wood, crafters
make tools, and traders make nothing at all — they live off the margin between two markets.
Every pop, traders included, eats every turn, owns its own goods and its own money.

**Cities.** Four of them, wired in a star around the capital, so the provinces can only reach
each other through the middle. Each province is 1.5x better at its own trade; the capital is
1.25x better at everything, because a quarter of its people are merchants who grow nothing and
it would otherwise be permanently short of every good.

| City | Type | Good at |
| --- | --- | --- |
| Capitalist | center | everything, a little |
| Farmland | plain | food |
| Forresty | forest | wood |
| Craftovo | mountains | tools |

## A turn

```
produce -> price -> trade between cities -> local market -> consume -> spoil
```

The order is not arbitrary:

- **Prices** are set before anybody trades, from the stocks and needs of this turn.
- **Trade between cities runs before the local market.** The other way round, the locals spend
  all their money on the insufficient local supply first and there is nobody left to sell the
  imports to — the traders go bankrupt and trade stops for good.
- **Consumption** happens at the end, out of what a pop managed to buy.
- **Spoilage** destroys a share of the leftovers. Without it every stock grows without bound
  and every price slides to the floor.

## How a price moves

A price is a stock, not a fresh calculation: every turn it is nudged towards the
demand/supply ratio by at most `MaxPriceStep` (10% by default) and clamped into
`[MinPrice, MaxPrice]`.

Two details matter more than they look:

- **Demand is what the citizens can pay for**, not what they wish they could buy. Counting the
  wishes of a bankrupt city keeps pushing its prices up, which is the last thing its broke
  citizens need, and the whole economy seizes up within a hundred turns.
- **Demand is elastic.** Cheap goods are worth stockpiling, dear ones are done without. Without
  that, demand is a hard ceiling and supply a hard floor, any lasting imbalance compounds at
  10% a turn until it hits a clamp, and a pop that has accumulated money has nothing left to
  spend it on — so the money never comes back to the producers.

## How a deal works

A trader buys a resource in one city, carries it to a neighbour and sells it there. The deal is
worth doing when the price gap is wider than the transport loss, and its size is capped by
every constraint that actually applies: the trade power the traders have left this turn, the
share of the local surplus they are allowed to strip, the money they can put up front, and the
demand the destination can actually pay for. Traders work in both directions — they export a
local surplus and import what a neighbour sells cheaply.

Transport costs a share of the cargo rather than a fee in money, on purpose: a money fee burns
the fixed money stock of the world turn after turn until everybody is broke. As it stands,
**the money stock never changes** — that invariant is covered by a test.

## Running it

```bash
dotnet run --project TradeCraftSimulation -- --turns 200 --quiet --csv run.csv
```

| Option | Meaning |
| --- | --- |
| `--turns <n>` | how many turns to simulate (default 30) |
| `--seed <n>` | seed of the production noise; the same seed replays the same run (default 42) |
| `--csv <path>` | per-turn time series in long format, one row per turn/city/resource |
| `--quiet` | print only the final state |
| `--config K=V` | override any knob of `SimulationConfig`, repeatable |

Every tunable number lives in [`SimulationConfig`](TradeCraftSimulation/SimulationConfig.cs) and
can be overridden from the command line, so balancing does not need a rebuild:

```bash
dotnet run --project TradeCraftSimulation -- --turns 300 --quiet \
  --config TransportLossShare=0.02 --config MaxPriceStep=0.05
```

The CSV is the point of the exercise: a time series is the only way to tell a converging
economy from a slowly exploding one. Columns are `turn, city, resource, price, demand, supply,
traded, imported, exported, stock, satisfaction, city_money`.

## Tests

```bash
dotnet test
```

They cover the invariants that are easy to break and hard to notice: money is neither created
nor destroyed, goods are conserved apart from the transport loss, no pop ever spends money it
does not have, prices stay inside their range, the same seed replays the same run, and trade
does not quietly die out halfway through a run.

## Known limitations

- **Nobody changes trade.** Population counts are fixed, so a glutted trade stays glutted. A
  woodcutter in a city drowning in wood is poor forever instead of becoming a farmer, and a
  merchant who goes bankrupt stays a bankrupt merchant. Labour mobility is the single biggest
  thing missing.
- **No demography.** Nobody is born and nobody starves to death; hunger only shows up as a
  satisfaction below 1.
- **Merchant capital concentrates.** The capital's traders end up holding a large share of the
  world's money, and provincial traders can be squeezed out of business entirely.
- **Prices are quantity-driven.** The money side only enters through what buyers can afford;
  there is no proper money-bid price formation, and no credit.
