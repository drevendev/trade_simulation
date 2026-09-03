IMPLEMENTATION CONTRACT CONSISTENCY REVIEW 01 — Economic Simulation

Status: PASSED WITH CANONICAL PATCHES  
Scope: CORE\_SCHEMA\_AND\_LIFECYCLES, MARKETS\_TRADE\_FX\_CONTRACTS, PRODUCTION\_CAPITAL\_LABOR\_CONTRACTS, POPULATION\_DEMOGRAPHY\_CLANS\_CONTRACTS.  
Purpose: remove implementation ambiguity before writing additional subsystem contracts. This review is authoritative when the four reviewed specs disagree. It does not redesign mature economics; it normalizes schema ownership, phase causality, settlement boundaries and duplicated state.

1\. Executive result

The four current implementation specs are economically compatible, but they contain several contract-level drifts that would force Codex/Claude to choose between competing schemas. No subsystem redesign is required. The issues are repairable by canonical ownership rules and a small number of additive/clarifying patches.

PASS CONDITION: apply the rules below as the canonical interpretation. Later spec-writing must use these normalized contracts. Existing documents may be mechanically patched later, but no coding agent should implement the superseded variants.

2\. Canonical PopulationCohort schema — resolves CRITICAL schema drift

CORE\_SCHEMA currently contains an older cohort shape with stratum LOWER/MIDDLE/UPPER, laborStatus, employedPersons, inventory, health and prosperity. POPULATION\_DEMOGRAPHY\_CLANS\_CONTRACTS contains the mature shape.

Canonical persistent cohort fields are:  
\- id, regionId, clanId;  
\- ageBand \= CHILD | WORKING | ELDER;  
\- stratum \= VULNERABLE | WORKING\_MIDDLE | AFFLUENT;  
\- laborCategory;  
\- population;  
\- wallet;  
\- householdInventory;  
\- healthIndex;  
\- prosperityEma;  
\- essentialSatisfactionEma;  
\- realIncomePerCapitaEma;  
\- employmentRateEma;  
\- migrationPressureEma;  
\- mobilityAccumulator;  
\- wageSignal.

DROP from persistent cohort state:  
\- laborStatus;  
\- employedPersons;  
\- generic inventory alias;  
\- generic health/prosperity aliases.

Rationale: current employment is a tick flow derived from LaborSupplyPlan/LaborAllocation. Keeping laborStatus/employedPersons would duplicate the labor ledger and become stale after migration/merge. householdInventory is the unique household physical-stock container. EMA names make the time semantics explicit.

Required invariant: there is exactly one persistent representation for each household stock/signal; current-tick employment exists only in TickContext/transactions until Phase 15 updates employmentRateEma.

3\. Household affordability after Phase-5 wages — resolves CRITICAL tick-causality conflict

The intended causal rule is preserved: wages physically received in Phase 5 may fund Phase-8 household purchases. Phase-2 household demand may not spend wages before receipt.

The previous wording is insufficient because HouseholdConsumptionPlan.planningCashEnvelope excluded wages while MarketIntent.maxSpend was fixed in Phase 2\. That would make same-tick wages technically available in the wallet but impossible to spend.

Canonical rule:  
A. Phase 2 creates desired quantities and MAXIMUM category/intention budgets using:  
   openingSpendableCash \+ conservativeExpectedCurrentTickWages \+ already-committed deterministic transfers \- liquidityFloor.  
B. conservativeExpectedCurrentTickWages is a bounded planning forecast derived only from prior-close employmentRateEma, wageSignal and current labor-supply eligibility. It is not credited to the wallet and cannot settle any transaction before Phase 5\.  
C. Phase 5 wage settlement changes the actual cohort wallet.  
D. Before Phase-8 clearing, a household affordability revalidation step computes actualSpendableCash from the real wallet after Phase-5 settlement and protected commitments/liquidity floor.  
E. Existing Phase-2 household intents are not replanned. Their effective maxSpend values are clamped to actualSpendableCash, never raised above their Phase-2 maxima. When cash is insufficient, reduce category envelopes in reverse household-priority order: COMFORT, then discretionary SERVICES/BASIC amounts above minima, then ESSENTIAL\_FOOD last. Within one category, scale its good intents proportionally.  
F. Market clearing remains proportional among buyers. Household need priority changes submitted effective demand, never buyer priority inside the clearing algorithm.

This is a revalidation of affordability, not a second shopping/planning loop.

Required tests:  
\- zero opening cash \+ forecast/realized wage \-\> positive Phase-8 consumption is possible only after wage receipt;  
\- forecast wage \> realized wage \-\> no overdraft; lower-priority intent budgets shrink deterministically;  
\- forecast wage \< realized wage \-\> household does not invent new unplanned demand; spending remains capped by Phase-2 maxima;  
\- wage transaction failure \-\> corresponding cash cannot be spent.

4\. Market budget ledger ownership

The generic budget commitment ledger remains canonical for ProductionUnit/State/Clan market intents. Household Phase-8 intents use a specialized household envelope view produced by the affordability revalidation above.

No ledger may reserve money that does not yet exist in the actor wallet. Phase-2 expected household wages are planning capacity only. The actual reservation occurs after Phase 5 against the actual wallet.

Unused household envelope after Phase 8 simply remains cash. There is no same-tick replanning pass.

5\. Clan Phase-10 cash flows — resolves timing ambiguity

Canonical Phase 10 order for Clan-related flows:  
1\) settle ProductionUnit profit/dividend distributions to owners when due;  
2\) settle State fiscal transfers/subsidies and debt service according to fiscal contract;  
3\) compute Clan cash available after receipts and mandatory reserves;  
4\) execute scheduled Clan member distributions;  
5\) execute Clan owner injections into eligible ProductionUnits from remaining designated investment budget.

All Phase-10 receipts affect normal market purchasing/production only next tick. Owner injection can change a ProductionUnit wallet in Phase 10, but Phase-2 plans, Phase-4 inputs, Phase-5 production and Phase-8 purchases are already closed. The injection may fund Phase-12 investment settlement if that contract explicitly reserved the investment plan in Phase 2; otherwise it is next-tick working capital.

A Clan may not distribute and then re-use the same cash for an owner injection. Every Phase-10 cash flow participates in one shared commitment/reconciliation ledger.

6\. Cross-currency Clan funding and FX phase boundary

There is one settleFx primitive for the entire simulation, not a trade-only helper.

Canonical rules:  
\- same-currency Clan transfers are direct atomic wallet transfers;  
\- cross-currency owner injections, distributions or other real payments call settleFx exactly once;  
\- settleFx always uses the same canonical FxLiquidityPoolState as trade;  
\- liquidity consumed by Phase 7 remains consumed in Phase 10; pools do not reset between phases;  
\- within any phase, competing FX requests are ordered/reserved deterministically by the subsystem’s stable allocation rule, then stable IDs;  
\- partial FX settlement proportionally reduces the real payment; no negative source wallet and no synthetic destination currency are allowed;  
\- a failed FX conversion does not create a receivable in core v1 unless a later subsystem explicitly introduces one.

Required invariant: for every currency pair, opening pool liquidity \+ authorized replenishment \- all successful settlements \= closing pool liquidity within tolerance, regardless of calling subsystem.

7\. ProductionUnit capacity — removes duplicated authoritative state

installedCapital is the sole authoritative physical capital stock.

capacity is DERIVED:  
capacity \= installedCapital × recipe.batchesPerCapitalUnit.

Preferred implementation: do not serialize capacity in canonical state; expose deriveNameplateCapacity(unit, recipe). If retained as a performance cache, it is non-authoritative, recomputed after every capital mutation and validated at serialization boundaries. No subsystem may mutate capacity directly.

condition remains a separate canonical \[0,1\] impairment stock and may be changed only by explicit damage/repair mechanisms.

8\. Region/Market status — removes duplicated lifecycle state

LocalMarketState.status is the sole canonical market lifecycle state: ACTIVE | DORMANT.

DROP RegionState.marketStatus as an independently mutable field. If UI/convenience code wants region.marketStatus, derive it from region.marketId \-\> LocalMarketState.status.

Reason: Region and LocalMarket cannot both own the same lifecycle switch without drift.

9\. Pending jurisdiction — removes duplicated transition state

PendingTransitions.jurisdictionChanges is the sole canonical future-jurisdiction queue.

DROP RegionState.pendingControllerStateId as independently mutable state. Region.controllerStateId contains only the effective current controller. Pending changes activate through the Phase-1 transition application according to activateTick.

This preserves the already-agreed one-tick legal causality for taxes, trade barriers, FX regime and policy.

10\. TradeShipment additive schema normalization

MARKETS\_TRADE\_FX\_CONTRACTS legitimately extends the minimal core TradeShipment schema. The canonical implementation must include beneficialOwner plus the settlement values needed for audit/replay.

At minimum canonical TradeShipmentState contains:  
\- id, goodId, quantity;  
\- originRegionId, destinationRegionId;  
\- seller, buyer, beneficialOwner;  
\- routeLinkIds / transportLinkId;  
\- destinationInventoryBucket identifying the buyer's exact destination stock container;  
\- departureTick, arrivalTick;  
\- current status;  
\- invoice/transport/tariff/tax/FX linkage fields required by the market contract.

After dispatch settlement, beneficialOwner is normally the buyer. Quantity is not simultaneously present in origin inventory or destination inventory. Delivery transfers shipment quantity exactly once into the beneficial owner’s recorded destinationInventoryBucket. For ProductionUnit buyers this must be INPUT or INVESTMENT as declared by the originating market intent; finished output is never delivered into outputInventory by a purchase.

11\. Inventory naming and actor-locality

Canonical stock names are actor-specific:  
\- PopulationCohort.householdInventory;  
\- ProductionUnit.inputInventory/outputInventory/investmentInventory;  
\- State.publicInventory;  
\- Clan has no ordinary goods inventory in core v1 unless a later explicit subsystem adds one.

Generic Inventory remains a type alias, not a generic field name.

Market/Trade code must access actor inventory through typed accessor functions rather than assuming every ActorRef has inventory under the same property.

12\. Phase causality summary

The four specs now share one operational timeline:  
\- Phase 1: apply due transitions, shipment arrivals, planned monetary/debt operations and opening reconciliation;  
\- Phase 2: create production, labor-supply, household, fiscal/procurement, trade-support and investment intents from opening/prior-close information;  
\- Phase 3: allocate labor;  
\- Phase 4: local pre-production input procurement;  
\- Phase 5: wage withholding/payment and physical production/extraction;  
\- Phase 6: one market repricing step using current supply/demand signals;  
\- Phase 7: interregional trade/FX dispatch and zero-travel close;  
\- Phase 8: main local market clearing; household intents first pass affordability revalidation against actual post-wage wallets;  
\- Phase 9: realized household/public consumption and spoilage;  
\- Phase 10: fiscal settlement, debt service, dividends, Clan distributions and owner funding;  
\- Phase 11: monetary/FX reconciliation only, not a second market;  
\- Phase 12: planned capital/infrastructure formation using already-owned/reserved real goods and valid financing;  
\- Phase 13: births, deaths, aging, migration, social mobility, cohort merge;  
\- Phase 14: expansion/settlement/state-formation/unit lifecycle decisions queued for their canonical activation timing;  
\- Phase 15: statistics, EMAs, diagnostics and explainability records;  
\- Phase 15 close: invariant checks and deterministic normalization/serialization close.

No later phase may retroactively change an earlier phase’s realized allocation.

13\. Simplicity decisions

KEEP:  
\- one labor allocation pass;  
\- one local market price update per tick;  
\- two local settlement passes only because production inputs must precede production while household/main clearing follows wages/trade;  
\- one FX primitive and one pairwise liquidity stock;  
\- cohort EMAs rather than employer histories;  
\- Clan treasury as the only Clan financial stock.

DO NOT ADD to repair these issues:  
\- persistent employment matrices;  
\- household credit;  
\- wage receivables;  
\- separate Clan FX wallet abstractions;  
\- a second household shopping pass;  
\- separate region and market lifecycle flags;  
\- separate current/pending controller fields outside PendingTransitions;  
\- direct mutable ProductionUnit capacity.

14\. Cross-spec invariants added by this review

CR-01 Cohort schema has one canonical stratum enum and one name per persistent stock/signal.  
CR-02 Sum current employment is derived from LaborAllocation; no duplicate persistent employedPersons stock exists.  
CR-03 Phase-8 household cash debits never exceed actual post-Phase-5 wallet cash minus protected commitments.  
CR-04 Current-tick wages cannot be spent before their Phase-5 credit transaction.  
CR-05 Household spending cannot exceed Phase-2 desired maxima even if realized wages exceed forecast.  
CR-06 Every Phase-10 Clan cash unit can be committed to at most one outgoing flow.  
CR-07 Every cross-currency real payment consumes the same finite FX pool exactly once.  
CR-08 FX liquidity is continuous across phases within a tick; no per-subsystem reset.  
CR-09 installedCapital is the only authoritative source of nameplate production capacity.  
CR-10 LocalMarket.status is the only market lifecycle flag.  
CR-11 PendingTransitions is the only owner of not-yet-effective jurisdiction changes.  
CR-12 In-transit goods have exactly one beneficial owner and exactly one physical location class: shipment.  
CR-13 Typed inventory access cannot place the same good quantity in multiple actor inventory fields.  
CR-14 Phase-10 income cannot retroactively fund Phase-8 demand or Phase-5 production.  
CR-15 Phase-13 migration/reclassification preserves wallet balances by currency and household inventories by good across source/target cohort splits.  
CR-16 Cohort merge happens only after all Phase-13 flows and uses the mature identity key including laborCategory.  
CR-17 Derived/cache fields cannot be independently mutated as economic stocks.  
CR-18 A jurisdiction change queued in Phase 14 changes legal/tax/trade/FX treatment only upon canonical activation, never retroactively.

15\. Required consistency tests

1\) Wage-funded consumption golden test.  
2\) Wage forecast shortfall deterministic budget-clamp test.  
3\) Cohort migration \+ aging \+ merge conservation test across two currencies and multiple goods.  
4\) Clan dividend \-\> member distribution \-\> owner injection cash-exclusivity test.  
5\) Clan cross-currency injection competing with Phase-7 trade FX liquidity test.  
6\) Production capital investment/depreciation test proving capacity cannot drift from installedCapital.  
7\) Market dormancy test proving no Region/LocalMarket status divergence exists.  
8\) Jurisdiction activation test proving Phase-14 queue does not change current-tick taxes/tariffs.  
9\) In-transit beneficial-owner destruction/delivery test.  
10\) Full mixed-tick reconciliation: wages \+ consumption \+ trade \+ FX \+ Clan distributions \+ migration, with money/goods/population invariants checked at the Phase-15 close.

16\. Review conclusion

RESULT: PASS WITH PATCHES. The implementation architecture remains stable. The conflicts found are naming/ownership/timing ambiguities, not evidence that the economic model needs redesign.

Readiness impact: the reviewed contracts are safe to implement provided this review is treated as authoritative for the conflicts it explicitly normalizes. Later subsystem contracts were written against these rules.

Historical note: this review originally preceded the State Fiscal \+ Laws contract. That work is now complete; for implementation order, follow START\_HERE and the master implementation index.  
