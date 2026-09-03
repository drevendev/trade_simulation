Repository Audit 01 — drevendev/trade\_simulation

Scope  
Audit of the current implementation base before economic redesign. Goal: identify reusable architecture, hard limitations, migration risks, and safe extension points.

Repository shape  
The repository is a compact .NET 9 console solution with one simulation project, one xUnit test project, and a dependency-free static docs/ GitHub Pages visualization. Core code is concentrated in Simulation.cs, City.cs, Pop.cs, Market.cs, Deal.cs, Storage.cs, SimulationConfig.cs, CsvLogger.cs and Program.cs. There is no database/server and no heavyweight framework. This is favorable for staged refactoring because the economic kernel is small and already separated from presentation.

Current execution model  
Simulation owns four fixed cities and a seeded System.Random. The world topology is a star: one capital connected to three provinces. RunTurn() uses a clear deterministic phase pipeline:  
BeginTurn → Produce \+ CalculateNeed → UpdateMarket/prices → intercity Trade → ClearLocalMarket → Consume → Spoil.  
This explicit phase loop is the strongest architectural asset. Preserve the concept and generalize it into a richer deterministic tick pipeline rather than replacing it with opaque agent callbacks.

Current entities  
City owns four aggregate Pop cohorts and one Market. Pops are Farmer, Woodcutter, Crafter and Trader. Each cohort has fixed Count, cash, inventory, need/want vectors, satisfaction and one production specialization. Goods are Food, Wood and Tools. Money is a cash stock/numeraire and is neither produced nor destroyed.

The cohort abstraction is compatible with the target. Recommended direction: evolve Pop into flexible population/labor cohorts and add clan/state/ownership dimensions around cohorts; do not replace cohorts with thousands of individual people.

Production  
Current production is Count × ProductionPower × city modifier × seeded noise. There are no input recipes, wages, capital, infrastructure, deposits, firm accounts or investment.

Preserve: deterministic production phase, explicit per-turn output, centralized tuning.  
Rework: hard-coded occupations, direct city bonuses, production bound directly to social cohorts. Mature design should separate labor/population from production units while still allowing clan ownership and occupational allocation.

Needs, consumption and stocks  
Each Pop computes bare per-capita Need and a price-sensitive Want. Cheap goods are stockpiled more; expensive goods are demanded less. Consumption removes inventory and records satisfaction. Spoilage is an explicit physical sink preventing unbounded stock growth.

Preserve: explicit needs, satisfaction, inventories, bounded elasticity, explicit spoilage/depreciation sinks.  
Rework: all goods are currently treated like recurring personal needs; tools are consumed like food. New model should distinguish consumption goods, intermediate inputs and durable/capital goods. Sustained satisfaction should affect demography/migration rather than being telemetry only.

Price formation  
Each city stores one persistent price per good. Demand is affordable shortage; supply is surplus. Price moves toward demand/supply ratio but each turn is capped by MaxPriceStep and clamped between MinPrice and MaxPrice.

This is simple, stable and explainable, but not a full monetary price-discovery mechanism. Preserve inertial local prices and bounded adjustment as a design principle. Re-evaluate the exact formula during MARKETS research; a full electronic order book is likely excessive for the target. An excess-demand/inventory rule or double-auction-lite mechanism should be compared for realism, stability and browser cost.

Local market clearing  
Local sellers expose surplus and buyers expose affordable shortage. Quantity traded is min(total offered, total wanted). Seller and buyer allocations are proportional, avoiding dependence on cohort array order. Money transfers directly between cohorts.

This proportional rationing primitive is highly reusable: deterministic, cheap and scalable. It can later serve households/cohorts, production units and state procurement without per-unit matching.

Intercity trade  
Trader cohorts inspect adjacent city/resource opportunities and repeatedly execute the highest-profit Deal. Deal size is capped by trade capacity, source surplus share, trader cash and affordable destination demand. Transport cost is represented as physical cargo loss, avoiding accidental destruction of the fixed money stock.

Preserve: route profitability, capacity limits, adjacency graph, explicit source/destination checks and understandable deal evaluation.  
Rework: special Trader pop as sole commerce actor; cargo destruction as the only transport cost; merchant-capital concentration; adjacent bilateral arbitrage only; no tariffs, currencies/FX or logistics infrastructure. Future monetary transport costs must have explicit recipients rather than disappearing from accounting.

Money and accounting  
The current world has a fixed closed money stock. Payments only transfer balances. Tests verify that world money never changes and no Pop can overdraw.

Preserve the invariant discipline, not the fixed-money assumption. The target must explicitly account for every monetary source/sink: issuance, taxation, transfers, debt service, credit if retained, FX conversion and write-offs. Each regime needs auditable balance identities.

Configuration  
SimulationConfig centralizes nearly every coefficient: seed, production noise, specialization, needs, spoilage, base prices, price bounds/step, elasticity, starting cash and trade parameters. Program.cs supports command-line overrides through \--config Name=value.

This pattern should be retained and expanded into structured serializable scenario/config data shared by CLI tests and the eventual browser runner.

Determinism and tests  
Determinism is already first-class. Tests cover constant world money, nonnegative/finite state, bounded prices and satisfaction, same-seed replay, different-seed divergence, persistent trade, specialization emerging as long-run cheapest price, and prevention of runaway stock hoarding. Separate tests cover deals, local markets, markets and storage.

This is a strong foundation. Migration should preserve deterministic benchmark scenarios and expand them to accounting identities, demographic conservation, fiscal/monetary flows and policy-shock scenarios. Existing tests should remain green during staged refactors where their semantics still apply.

Visualization and deployment  
The current docs/index.html is a single static dependency-free GitHub Pages page reading docs/run.csv. It already provides responsive styling, price charts, a turn scrubber/player, a four-city map, trade-flow arrows and per-turn snapshots.

This is useful as a diagnostic frontend, but the simulation itself currently runs offline in .NET and only exports CSV. The target requires an autonomous browser experience on GitHub Pages, so runtime migration is a major technical decision. Two viable paths are: compile the C\# kernel for browser WebAssembly, or port the compact kernel to TypeScript and prove parity against deterministic golden runs. Because the domain code is small and the final UI will be web-native, TypeScript is likely simpler long-term, but the decision should wait until architecture/performance requirements are clearer.

Preserve  
\- deterministic seeded execution and explicit tick phases;  
\- aggregate/cohort agents rather than individual people;  
\- explicit inventories, cash and physical flows;  
\- local market objects and region adjacency;  
\- proportional rationing as a cheap clearing primitive;  
\- persistent/inertial prices rather than scripted prices;  
\- centralized configuration;  
\- conservation/invariant testing philosophy;  
\- time-series observability and GitHub Pages diagnostic visualization;  
\- small readable domain classes rather than a generic ECS or heavyweight simulation framework.

Replace or generalize  
\- fixed four-city star world;  
\- hard-coded Farmer/Woodcutter/Crafter/Trader populations;  
\- fixed population counts and no labor mobility/demography;  
\- three goods with uniform treatment;  
\- production directly bound to populations;  
\- compensating CapitalBonus and hand-calibrated self-sufficiency;  
\- fixed closed money stock;  
\- trader-only commerce and cargo loss as transport payment;  
\- quantity-ratio pricing as the final price mechanism;  
\- absence of states, clans, ownership, taxes, laws, debt, currencies, migration/settlement and shocks;  
\- offline CSV as the only simulation-to-UI path.

Recommended migration boundary  
Layer 0 — freeze current behavior with tests and one or more golden deterministic outputs.  
Layer 1 — generalize world/config/data definitions (variable regions, goods, recipes, actors) without changing major economics.  
Layer 2 — separate population/labor cohorts from production units and ownership.  
Layer 3 — upgrade market and trade mechanics using the selected coherent model.  
Layer 4 — add demography, clans, states and fiscal systems.  
Layer 5 — add monetary regimes/currencies, expansion and events.  
Layer 6 — move/compile runtime into browser and replace the diagnostic page with the final explanatory UI.  
This avoids simultaneous economic-model and platform rewrites.

Technical risks  
HIGH — browser runtime choice: current .NET console does not execute directly on static GitHub Pages.  
HIGH — preserving accounting consistency once taxes, debt and money creation exist.  
HIGH — market redesign can destabilize the current self-correcting loop if production, demand and pricing all change at once.  
MEDIUM — cohort \+ clan \+ production-unit \+ state layers can duplicate responsibilities unless boundaries are explicit.  
MEDIUM — multi-currency/FX multiplies complexity and should follow a stable single-currency multi-state milestone.  
LOW — repository size/structure; it is compact enough for safe staged refactoring.

Implications for next work units  
SOURCE\_AUDIT should map each user-draft idea to one canonical layer: population cohort, clan, production unit, market, state/law, region, monetary system or event, and reject duplicate agent layers.  
MODEL\_ARCHITECTURE should preserve a deterministic phase pipeline and explicit stocks/flows.  
MARKETS research should compare excess-demand/inventory pricing with double-auction-lite alternatives, treating browser performance and explainability as requirements.  
The final implementation plan should include deterministic parity/golden-run tests so Codex/Claude can refactor without silently destroying existing emergent behavior.

Conclusion  
The repository is not a dead-end prototype requiring wholesale replacement. It is a compact and disciplined seed with three especially valuable assets: deterministic phase-based execution, explicit stock/money flows backed by invariant tests, and a clean simulation → time-series → GitHub Pages diagnostic path. The economic mechanics must be substantially generalized, but the engineering philosophy should be preserved. Recommended strategy: evolutionary replacement of domain mechanics inside the deterministic shell, followed by a deliberate browser-runtime migration after the economic architecture stabilizes.  
