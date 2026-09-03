USER\_DRAFT\_SYNTHESIS — Economic Simulation

Purpose  
This document synthesizes all four user drafts into one design-direction record. The drafts are treated as authoritative for intent, not mechanics. Each major idea is classified as KEEP, REWORK, DROP, or OPEN QUESTION. The objective is to prevent later architecture from accidentally merging incompatible generations of the design.

Sources reviewed  
1\. Кланы. Цепочки производства.docx  
2\. Кланы. Особенности кланов.docx  
3\. Кланы и места их обитания.docx  
4\. Алгоритмы торговли.docx

Executive synthesis  
The drafts converge on several durable ideas despite many rewrites: clans are the key meso-level social actors; population should be aggregated rather than simulated as thousands of individuals; regions matter; economic outcomes should emerge from production, needs, trade and scarcity; specialization should emerge from comparative local advantages; state institutions and taxation should interact with the market; and the simulation should be understandable through visible flows rather than hidden buffs.

The major incompatibility is that the drafts repeatedly alternate between individual pops, strata, clan-wide abstractions, city markets, clan markets, tribe markets, global markets, negative inventories/futures, infrastructure job slots, and direct priority-based allocation. These should not be combined literally. The final model should choose one compact hierarchy and one accounting model.

Recommended canonical direction  
Use this hierarchy:  
World → States → Regions → Clans → Population cohorts \+ Production Units.  
Markets exist at region/state trade-node level, not separately for every clan and every social layer. Clans own wealth/assets and influence behavior, but production and consumption should operate through explicit cohorts/production units so accounting remains coherent. States levy taxes, procure, transfer and regulate. Trade occurs over region links with transport costs/capacity. A deliberately external infinite “global market” should not be part of the normal simulation.

\============================================================  
1\. Кланы. Цепочки производства.docx  
\============================================================

Core draft idea  
A deliberately small catalog of raw resources and three quality tiers of manufactured goods: tools, food, clothing, weapons and furniture. Higher tiers consume additional inputs and better tools.

KEEP  
\- Explicit production chains instead of direct money generation.  
\- Small catalog philosophy. The heading “Минимализм” is directionally correct and should remain a design constraint.  
\- Distinction between raw materials and processed goods.  
\- Tools as productive inputs/capital-like goods rather than only consumer goods.  
\- Scarce specialty inputs such as spices/dyes as optional sources of specialization and trade value.  
\- Quality differentiation as a possible late-stage mechanism if it creates meaningful consumption/production choices.

REWORK  
\- Replace three manually duplicated tiers of every product with a more composable recipe/quality system. Avoid 15 near-identical goods unless quality materially changes behavior.  
\- Treat food, clothing, tools, weapons and furniture differently by economic role. Food is recurring consumption; clothing/furniture are durable household consumption; tools are production inputs/durables; weapons are state/military procurement or security goods.  
\- Correct recipe anomalies and circular wording in the draft (e.g. the final furniture chain references quality tools in an inconsistent sequence).  
\- Raw food should probably be split only if geography/production requires it. A single generic food commodity may be enough for v1, with luxury food/spices later.  
\- Resource extraction should depend on regional endowments/land/capacity, not merely on the presence of workers.

DROP  
\- Mechanical “Tier 1/2/3” replication for every product as a mandatory v1 system.  
\- Any recipe whose only purpose is to force all earlier tiers to be consumed by later tiers.  
\- Quality as a universal property across every good from day one.

OPEN QUESTIONS  
\- Whether v1 needs explicit quality grades at all, or whether goods should remain single commodities until core macro behavior is stable.  
\- Whether weapons belong in the first economic milestone if warfare itself is outside initial scope.  
\- Whether durable household goods need depreciation/stock ownership in v1 or can be represented as periodic consumption demand.

Provisional decision  
Start v1 with approximately 6–10 economically distinct goods, not 20+. Prefer: staple food, wood, ore/metal, textiles, tools, construction material, one comfort/luxury composite, and optionally weapons. Add spices/dyes/quality only after the core economy is stable.

\============================================================  
2\. Кланы. Особенности кланов.docx  
\============================================================

Core draft idea  
Clans are defined by traits, ideological dichotomies, values and history. These affect preferred laws, occupations and behavior. Proposed axes include Tradition/Progress, Militarism/Pacifism, Authority/Freedom, Development/Expansion. Clan values include Influence, Strength, Welfare, Wealth and Culture.

KEEP  
\- Clan identity should be behavioral, not cosmetic.  
\- Traits and historical origin should affect preferences/decision weights.  
\- Clans should have persistent values/priorities that can differ from state policy.  
\- Loyalty to the state and political influence are important state-clan coupling variables.  
\- Founding/history traits can provide path dependence and explain why similar economic conditions produce different choices.  
\- A small set of ideological/preference axes is useful for law preference, migration, investment and political support.

REWORK  
\- Replace large collections of direct percentage bonuses with decision weights and response modifiers. Example: an expansionist clan should invest more in trade/settlement and tolerate migration, not receive a flat “+X% trade”.  
\- Reduce dichotomies to a small orthogonal set. Four axes are already near the upper bound; some effects currently overlap (Development/Expansion with Wealth/Influence and Tradition/Progress with occupation efficiency).  
\- Rename or neutralize loaded labels where they duplicate concrete laws. “Authority/Freedom” can be a preference axis, while slavery/serfdom/free labor should be explicit institutions/laws.  
\- Culture and “great people” are not required for the core economic simulation. If retained, culture should influence education/adoption/social cohesion rather than spawn special characters.  
\- Clan strength should derive from wealth, population, armed manpower and state institutions, not exist as a magical standalone resource.

DROP  
\- Direct bonuses such as “Pacifism gives birth rate bonus” unless supported by a clear causal path.  
\- One-off “unique trait” complexity unless it affects the same standard decision system.  
\- Great-person mechanics in the economic core.  
\- A separate abstract “culture production” resource if it does not feed a concrete subsystem.

OPEN QUESTIONS  
\- Exact canonical preference axes. Candidate minimal set: Tradition↔Innovation; Hierarchy↔Egalitarianism; Localism↔Expansionism; Militarism↔Civilianism.  
\- Whether values should be five ranked priorities or normalized continuous weights. Continuous weights are easier for autonomous decisions.  
\- Whether clan preferences can drift endogenously with outcomes/generational change or remain mostly persistent in v1.

Provisional decision  
Clans will have a small trait set and 3–4 continuous preference axes. These alter utility weights for investment, migration, law support, trade, education and security. Avoid direct economic production buffs unless the trait represents an actual capability/endowment.

\============================================================  
3\. Кланы и места их обитания.docx  
\============================================================

Core draft idea  
This is an evolutionary design journal containing several incompatible clan models (v1–v6). Durable themes are clan population, wealth, influence, territory/region attachment, strata, occupations, infrastructure, internal/external markets and eventual simplification toward real regions.

KEEP  
\- Clans as population-bearing meso-agents with population, wealth/assets, influence and loyalty/preferences.  
\- Real region map rather than purely abstract territory counters. Later versions explicitly converge on one clan tied to a region and regions with climate/terrain/resource properties.  
\- Region endowments: fertility, terrain, resource availability, accessibility/roads and possibly climate.  
\- Population stratification by socioeconomic status, but only at aggregate cohort level.  
\- Social mobility and demographic differences between strata as emergent outputs of prosperity/institutions.  
\- Jobs should be constrained by productive capacity/infrastructure rather than arbitrary occupation percentages.  
\- Economic specialization should reflect region resources, productive assets, prices and clan preferences.  
\- Infrastructure/investment project choice as an autonomous clan behavior is valuable.  
\- Political influence should connect clan economic contribution/wealth/population to the state, but must not be a simple points reward detached from institutions.  
\- Migration/settlement should connect population pressure and regional opportunity.

REWORK  
\- Do not make “clan owns exactly one region” a universal invariant unless needed for identity. Better: each clan has a home region and population/ownership shares that may exist in multiple regions; v1 may simplify to one home region plus migration shares if performance requires it.  
\- Replace 11-level or repeated five-strata ladders with 3–4 cohorts. Candidate: dependent/poor, working/middle, affluent/elite, plus enslaved/unfree only when law permits. Occupational role and wealth stratum should be separate dimensions.  
\- Replace full per-turn reallocation of all workers by a frictional labor allocation rule. Completely dynamic assignment causes unrealistic instant shifts; fixed jobs cause lock-in. A partial adjustment rate gives both responsiveness and persistence.  
\- Replace “rank all jobs by Influence/Welfare/Money points” with expected utility/profitability plus clan preference weights. The outputs should use normal economic quantities where possible.  
\- Infrastructure should create capacity/productivity rather than simply “jobs as slots” in all cases. Production units can have labor demand and capital capacity.  
\- Preserve wealth and influence, but define them from accounting and political institutions rather than arbitrary score generation.  
\- Territory expansion should be a region/state/clan interaction, not merely adding abstract cells.

DROP  
\- The earliest bespoke profession distribution tables per stratum and clan type.  
\- 11 prosperity levels and complicated deterministic transitions.  
\- Repeated redesign generations as separate coexisting systems.  
\- “Infinite gatherers” as a default unemployment sink. Unallocated labor should exist explicitly and may perform subsistence/informal production with lower productivity.  
\- One simultaneous infrastructure project per clan as a hard universal rule; use an investment budget/capacity rule instead.  
\- Territory ownership represented as hundreds of tiny abstract terrain slots if real regions are used.  
\- Player-leader assumptions from later drafts. The target simulation has no player.

MARKET LAYERS — KEEP/REWORK/DROP  
The draft proposes clan-local, tribal/internal, external-state and global markets.

KEEP  
\- Internal vs external trade distinction.  
\- Domestic trade usually having lower friction than international trade due to tariffs/borders/transport.  
\- Clan internal inventories/allocations can exist as accounting within an organization without becoming a separate price-forming market.

REWORK  
\- Clan-local “communist market” becomes clan/household/production-unit inventory transfer or internal allocation. Do not call every inventory pool a market.  
\- Tribal market becomes a region/state market or trade node with actual prices and clearing.  
\- External markets are simply other states/regions connected through the same trade network, with tariffs and transport costs layered on.

DROP  
\- Infinite global market with infinite money and intentionally bad prices as a normal balancing mechanism. It hides shortages/surpluses, destroys closed-system accounting and suppresses emergent crises.  
\- Automatic end-of-turn rescue purchases that always clear deficits externally.

“FUTURES” / NEGATIVE INVENTORY IDEA  
DROP as named/mechanical futures. Negative physical inventories should not be allowed. The draft’s “future” mechanism is really unmet demand/backorders. Preserve the information as explicit shortage/backlog variables, not as negative goods. A future contract is a financial instrument with delivery obligations and would add unnecessary complexity.

OPEN QUESTIONS  
\- Whether states or regions are the primary market-clearing geography. Likely region markets with trade links aggregated across regions.  
\- Whether clans may own productive assets outside their home region. Defer until core ownership model is defined.  
\- Whether enslaved population is included in v1. It is useful only if laws/institutions are modeled carefully and distinctly from generic poverty.  
\- How much political simulation belongs in scope beyond policy choice and clan influence.

Provisional decision  
Canonical clan boundary: clan is a social/ownership/political actor, not a container replacing every household, firm, market and territory entity. It holds financial wealth/assets, preferences, influence, loyalty and demographic membership. Production units and population cohorts remain separate accounting entities linked to a clan.

\============================================================  
4\. Алгоритмы торговли.docx  
\============================================================

Core draft idea  
A detailed sequence for production by tier, market sale/purchase, merchant commissions, taxes, class needs, trade between cities, price adjustment, spoilage, social classes, hunger/health/happiness, later followed by a radical simplification to individual pops.

KEEP  
\- Explicit tick ordering matters and should be specified, tested and deterministic.  
\- Production consumes inputs before producing outputs.  
\- Needs have priority: subsistence first; comfort/luxury later.  
\- Hunger/need satisfaction should affect health, mortality, migration and productivity.  
\- Price-sensitive substitution among consumption goods is desirable if implemented cheaply.  
\- States pay wages/procure services/goods through explicit budget flows.  
\- Taxes are transfers to a treasury rather than disappearing money.  
\- Trade should react to profitable price differences and transport frictions.  
\- Unsold goods may spoil/depreciate where appropriate.  
\- Demand should be observable even when it cannot be fully satisfied, but distinguish desired demand, effective demand and unmet need.  
\- Wealth/prosperity can raise consumption expectations, creating endogenous demand growth.

REWORK  
\- Preserve aggregate cohorts, NOT the later “one pop \= one person” simplification. Individual agents would conflict with browser-performance and implementation-simplicity goals.  
\- Replace strict purchase order by influence/class with market rationing plus institutional rules. Political priority procurement can exist for the state, but general consumers should not buy sequentially by social influence because array/order effects create artifacts.  
\- Replace merchant commission as a universal tax-like deduction with explicit transport/trading costs and merchant/logistics income if merchant actors are retained.  
\- Replace detailed food-basket search loops with a small utility/substitution mechanism. Full greedy basket optimization per cohort per tick is unnecessary.  
\- Collapse separate Hunger/Heat/Health/Happiness/Tools/Services bars into fewer modeled needs with clear causal roles. Candidate: subsistence nutrition, shelter/basic goods, healthcare/services, discretionary/comfort.  
\- Health should be a stock driven by nutrition, disease/shocks and services, not a highly bespoke herb-counter loop.  
\- Happiness should become welfare/satisfaction derived from need coverage, income security and laws, not a separate shopping mini-game.  
\- Tools should be production-unit inputs/capital; do not make every worker buy personal tools based on experience thresholds unless later justified.  
\- Taxes should be assessed at explicit bases (income, consumption, property/wealth, trade) rather than arbitrary sequencing.  
\- Debt should not be inherited by unrelated members merely because a group shrank; if debt is included, assign it to coherent debtors (clan, production unit, state).

DROP  
\- One individually simulated person per “pop”.  
\- Strict class-order consumer purchasing.  
\- Hand-built threshold loops for food baskets, luxury baskets and every need category.  
\- Clergy tithe/merchant commission as mandatory universal mechanics.  
\- “Money above threshold is donated to city for influence” as a generic sink; this can become political donations/investment only if explicitly modeled.  
\- Random theft from warehouse as routine sink unless theft/crime becomes a real institution/shock with a recipient or physical loss rationale.  
\- Services that bypass markets and money-flow accounting without a defined producer/payment flow.

OPEN QUESTIONS  
\- Whether consumer substitution uses CES-like utility, ranked substitutes, or simple affordability-weighted demand. Research should pick the simplest stable option.  
\- Whether unemployment receives subsistence production, transfers, savings drawdown or all three depending on institutions.  
\- Whether health and education are explicit service sectors in v1 or represented by state/private spending effectiveness functions.  
\- Whether merchants are explicit clan-owned production units or whether trade/logistics is a shared capacity service.

Provisional decision  
Use population cohorts with needs and budgets. Each cohort forms nominal consumption budgets by need category; products inside a category compete through a simple price/quality preference rule. Unmet essential need feeds health/mortality/migration. Avoid per-person optimization.

\============================================================  
Cross-draft contradictions resolved  
\============================================================

A. Individual pops vs clans vs strata  
Decision: no individual persons. Population is aggregated into cohorts indexed by region × clan × socioeconomic stratum (and possibly labor status). Clans remain meso-level actors; cohorts are the demographic/economic population representation.

B. Clan as everything vs separate firms/markets  
Decision: clan does not replace production units or markets. It can own production assets and receive income, but firms/production units are explicit operational entities and markets clear at geographic trade nodes.

C. Clan market / tribal market / global market  
Decision: keep internal organizational inventories plus geographic price-forming markets. Drop infinite global market. All simulated states participate in the same networked world economy.

D. Futures / negative inventories  
Decision: physical stocks cannot go negative. Track unmet demand/backlog separately. Financial derivatives are out of scope.

E. Dynamic worker assignment vs fixed professions  
Decision: partial adjustment labor allocation. Desired labor demand can change each tick; only a configurable fraction of workers transitions, with education/skill/institution constraints.

F. Many strata vs simple prosperity  
Decision: 3–4 economic strata/cohorts are enough. Stratum is separate from occupation. Social mobility is gradual and driven by sustained wealth/income, education and laws.

G. Direct bonuses vs emergent behavior  
Decision: traits/laws primarily change constraints, costs, utility weights and behavioral thresholds. Avoid free production/wealth/influence bonuses unless causally justified.

H. Global rescue imports  
Decision: no infinite supplier. Shortages are allowed and should propagate into prices, welfare, migration, investment and state policy.

I. Social/political “influence”  
Decision: retain influence, but derive it from population, wealth/assets, office/institutional position, political contributions and legitimacy. Do not generate influence simply because a job output says “+20 influence”.

J. Territory model  
Decision: real regions with endowments and connectivity. Regions are stable geographic units; ownership/control/settlement can change. Avoid microscopic abstract terrain slots.

\============================================================  
Canonical concept inventory to carry forward  
\============================================================

World/regions  
\- finite set of connected regions  
\- terrain/climate/resource endowments  
\- transport/accessibility  
\- settlement/capacity

States  
\- borders/control  
\- treasury, taxes, spending, procurement, debt  
\- laws/institutions  
\- monetary regime/currency later

Clans  
\- population membership  
\- wealth/assets/ownership  
\- influence/loyalty  
\- persistent traits/preferences  
\- home/geographic concentration  
\- investment/political behavior

Population cohorts  
\- headcount  
\- clan/region/stratum  
\- labor status/occupation allocation  
\- income/cash or household wealth share  
\- needs/satisfaction  
\- health/demographic rates  
\- migration/social mobility

Production units  
\- owner clan/state  
\- region  
\- recipe/input/output  
\- labor demand  
\- capital/infrastructure capacity  
\- inventory/cash/accounting

Markets/trade  
\- local geographic price per good  
\- supply/effective demand/unmet demand  
\- inertial/bounded price discovery  
\- transport costs/capacity  
\- domestic/international tariffs and policy  
\- explicit shipment flows

Goods  
\- small economically distinct set  
\- raw/intermediate/consumer/capital classification  
\- spoilage/depreciation where appropriate

\============================================================  
Items explicitly rejected from the final direction  
\============================================================

1\. Individual-person simulation as the main population model.  
Reason: unnecessary computational cost and noisy micro-complexity; cohort representation preserves the required feedback loops.

2\. Infinite global market as buyer/seller of last resort.  
Reason: masks scarcity, breaks world accounting and removes meaningful international specialization/crises.

3\. Negative physical inventory called “futures”.  
Reason: conflates shortage/backlog with a derivative contract and weakens accounting clarity.

4\. Every historical draft version coexisting.  
Reason: the versions are successive attempts to solve the same problems; combining them would duplicate layers.

5\. Universal multi-tier quality ladder for all goods in v1.  
Reason: content explosion with little systemic gain before the core economy is stable.

6\. Job outputs denominated in arbitrary Wealth/Welfare/Influence score points.  
Reason: replaces economic causality with game-score generation; use money, goods, services and institutional political effects.

7\. Sequential consumer purchase by social influence/class.  
Reason: produces order-dependent rationing artifacts; use explicit rationing/market rules.

8\. Mandatory per-turn total labor reassignment.  
Reason: creates implausible instant adaptation; use partial mobility/friction.

9\. Player/leader mechanics.  
Reason: target product is fully autonomous with no player.

\============================================================  
Research questions generated by source audit  
\============================================================

The next RESEARCH pass should specifically resolve:  
1\. Which simple market-clearing/price-adjustment mechanism best preserves stability while allowing nominal demand and shortages?  
2\. Which cohort demographic formulation gives plausible births/deaths/migration without individual simulation?  
3\. How to represent production-unit ownership and clan income with minimal balance-sheet complexity?  
4\. What labor reallocation rule gives useful persistence without expensive matching?  
5\. Whether trade should be merchant-agent driven or network-flow/profit-opportunity driven.  
6\. How to model multi-state money/currency in stages without introducing full banking too early.  
7\. What minimal consumption substitution rule is sufficient for essential vs discretionary goods?  
8\. How to run or port the deterministic engine in GitHub Pages with an acceptable browser performance budget.

Source-audit conclusion  
All four drafts contain useful design intent, but none should be implemented literally. The strongest combined concept is a region-based autonomous economy where clans are social/ownership/political actors, population is cohort-based, production is recipe/capacity based, markets are geographic and finite, and state institutions act through explicit flows. The final model should preserve the drafts’ emergent-market ambition while rejecting the repeated layers of bespoke strata, score outputs, rescue markets and per-person logic that accumulated during earlier iterations.  
