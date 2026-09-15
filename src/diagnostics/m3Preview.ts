/**
 * M3 Milestone Preview generator (REQ-VISUALIZATION-006).
 *
 * Produces the deterministic one-way JSON export behind the consolidated M3 LocalMarket
 * Pages experience: a multi-tick local-market slice measured from the real Phase-6 ->
 * Phase-8 pipeline and the real settlement boundary, never from a re-implementation.
 *
 * Handoff/11 "Milestone preview scope (M0-M12)" requires the M3 slice to show a legible
 * price/traded-quantity trend, a current-tick market-balance or settlement visual, and
 * headline metrics for price, traded quantity, realized Phase-8 MAIN-pass shortageRate
 * and surplusRate, seller-net receipt, buyer-gross cost and collected consumption tax.
 * Every one of those fields is read off canonical output here:
 *
 * - `shortageRate` / `surplusRate` and the demand/supply quantities come from the
 *   `LocalMarketTelemetry` that `createPhase8Handler` already emits (REQ-MARKET-005).
 *   HANDOFF-REPAIR-009 forbids deriving a second surplus metric, so this module computes
 *   neither rate itself.
 * - Seller-net receipt, buyer-gross cost and collected consumption tax are summed from the
 *   realized MAIN-pass `MarketAllocation`s that the same Phase-8 run produced, using the
 *   same `quantity * unitPrice` products `executeAllocation` applies to authoritative
 *   stock. They are the settled amounts, not a parallel estimate.
 *
 * The preview is diagnostic/presentation output only. It takes `WorldState` by value and
 * every transition in the loop below returns a new world, so the caller's world is left
 * untouched; it draws no economic RNG; and it is never read back into the simulation.
 */

import type { CurrencyId, GoodId, MarketId, RegionId, StateId } from "../domain/id";
import type { WorldState } from "../simulation/worldState";
import { executeTick, composePhaseHandlers } from "../simulation/tickOrchestrator";
import type { MarketIntent } from "../simulation/marketIntent";
import { createMarketIntentId } from "../simulation/marketIntent";
import { createPhase6Handler, marketPriceKey, type Phase6PriceConfig } from "../simulation/phase6MarketPriceFormation";
import { createPhase8Handler } from "../simulation/phase8MainMarketClearing";
import { applyMarketStateTransition } from "../simulation/marketStateTransition";
import { applyMarketSettlementTransition } from "../simulation/marketSettlementTransition";

/** One tick of the M3 golden run, as the page plots and tabulates it. */
export interface M3PreviewTick {
  readonly tick: number;
  /** Phase-6 price this tick's clearing used, in market currency per unit of the good. */
  readonly sellerNetPrice: number;
  /** Buyer-facing price including assessed consumption tax, same units. */
  readonly householdGrossPrice: number;
  readonly desiredDemandQuantity: number;
  readonly effectiveDemandQuantity: number;
  readonly offeredQuantity: number;
  readonly clearedQuantity: number;
  readonly unmetDemandQuantity: number;
  readonly unsoldOfferQuantity: number;
  /** Realized Phase-8 MAIN-pass shortage ratio, straight from canonical telemetry. */
  readonly shortageRate: number;
  /** Realized Phase-8 MAIN-pass surplus ratio, straight from canonical telemetry. */
  readonly surplusRate: number;
  /** Money the sellers received, summed over this tick's realized MAIN allocations. */
  readonly sellerNetReceipt: number;
  /** Money the buyers paid, summed over the same allocations. */
  readonly buyerGrossCost: number;
  /** Consumption tax credited to the destination State treasury, same allocations. */
  readonly consumptionTaxCollected: number;
  readonly allocationCount: number;
}

/** Identity and units of the single market/good slice the preview shows. */
export interface M3PreviewMarket {
  readonly marketId: MarketId;
  readonly regionId: RegionId;
  readonly regionName: string;
  readonly goodId: GoodId;
  readonly goodName: string;
  readonly quantityUnitLabel: string;
  readonly currencyId: CurrencyId;
  readonly currencyCode: string;
  readonly destinationStateId: StateId | null;
  readonly destinationStateName: string | null;
  readonly pass: "MAIN";
  readonly sellerCount: number;
  readonly buyerCount: number;
}

export interface M3Preview {
  readonly milestone: "M3";
  readonly requirement: "REQ-VISUALIZATION-006";
  readonly scenario: {
    readonly scenarioId: string;
    readonly seed: number;
    readonly configVersion: string;
    readonly ticksExecuted: number;
  };
  readonly market: M3PreviewMarket;
  /**
   * The Phase-6 price-formation bounds this run was configured with. No canonical config
   * section owns `minimumPrice`/`maximumPrice` yet (see `Phase6PriceConfig`), so the
   * fixture values are exported rather than left implicit in the page.
   */
  readonly priceBounds: {
    readonly minimumPrice: number;
    readonly maximumPrice: number;
    readonly maxAbsoluteLogPriceMovePerTick: number;
  };
  readonly ticks: ReadonlyArray<M3PreviewTick>;
  readonly totals: {
    readonly clearedQuantity: number;
    readonly sellerNetReceipt: number;
    readonly buyerGrossCost: number;
    readonly consumptionTaxCollected: number;
    readonly allocationCount: number;
  };
  /**
   * The settlement transfer identity over the whole run: what buyers paid equals what
   * sellers received plus what the treasury collected. This restates the money movement
   * the page draws; it is not a second accounting system, and `residual` is reported so a
   * reader can see it is zero rather than being told so.
   */
  readonly settlementIdentity: {
    readonly buyerGrossCost: number;
    readonly sellerNetReceiptPlusTax: number;
    readonly residual: number;
    /** The configured domain zero threshold for money, so the page states a rule, not a guess. */
    readonly moneyEpsilon: number;
  };
}

/** Which actors trade, how much they offer/want, and for how long. */
export interface M3GoldenRunFixture {
  readonly regionId: RegionId;
  readonly marketId: MarketId;
  readonly goodId: GoodId;
  readonly sellers: ReadonlyArray<{ readonly productionUnitId: string }>;
  readonly buyers: ReadonlyArray<{ readonly cohortId: string }>;
  /** Units each seller puts on the market per tick, capped by what it actually holds. */
  readonly offerQuantityPerSeller: number;
  /** Units each buyer wants per tick. */
  readonly desiredQuantityPerBuyer: number;
  /** Cash cap per buyer per tick, capped by what that buyer actually holds. */
  readonly maxSpendPerBuyer: number;
  readonly ticks: number;
  readonly priceConfig: Phase6PriceConfig;
  /**
   * The consumption-tax policy this scenario trades under. Handoff/04 section 2 requires an
   * M3 fixture to state its own rate and collection efficiency rather than inherit one, so
   * these are scenario inputs and carry no canonical authority.
   */
  readonly taxPolicy: {
    /** Statutory consumption-tax rate applied to the seller-net price, in [0,1]. */
    readonly consumptionTaxRate: number;
    /** Share of assessed tax the destination State actually collects, in [0,1]. */
    readonly collectionEfficiency: number;
  };
}

/**
 * Run the M3 golden local-market scenario and project it into the preview shape.
 *
 * Each tick runs one real `executeTick()` over the composed Phase-6 + Phase-8 handlers,
 * then carries the result forward across the two canonical boundaries in the order
 * `applyMarketSettlementTransition` (allocations onto authoritative stock) then
 * `applyMarketStateTransition` (Phase-6 price and post-MAIN expectations onto
 * `LocalMarketState`). The next tick therefore reprices from the persisted lagged state
 * and trades against the stock the previous tick actually left behind.
 *
 * Seller offers are capped at live OUTPUT inventory and buyer budgets at live wallet
 * balances, because Phase-8's M3 fixture convention treats a SELL intent's desired
 * quantity as sellable outright: an offer above real stock would be cleared and then
 * refused by `executeAllocation`, which is a fixture defect rather than an economic event.
 */
export function generateM3Preview(worldState: WorldState, fixture: M3GoldenRunFixture): M3Preview {
  const marketIds = new Map<string, MarketId>([[fixture.regionId, fixture.marketId]]);
  const getFixtureMarketIds = (): Map<string, MarketId> => marketIds;

  const getFixtureIntents = (world: WorldState): MarketIntent[] => {
    const region = world.regions.get(fixture.regionId);
    const currencyId = region?.settlementCurrencyId;
    const intents: MarketIntent[] = [];

    fixture.sellers.forEach((seller, index) => {
      const unit = world.productionUnits.get(seller.productionUnitId as never);
      const held = unit?.outputInventory.get(fixture.goodId) ?? 0;
      const offered = Math.min(fixture.offerQuantityPerSeller, held);
      if (offered <= 0) return;
      intents.push({
        id: createMarketIntentId(`mi:m3-preview-seller-${index + 1}`),
        actor: { type: "PRODUCTION_UNIT", productionUnitId: seller.productionUnitId as never },
        regionId: fixture.regionId,
        goodId: fixture.goodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: offered,
        minimumReserveQuantity: 0,
        inventoryBucket: "OUTPUT",
        sourcePlanId: "plan:m3-preview-supply",
      });
    });

    fixture.buyers.forEach((buyer, index) => {
      const cohort = world.cohorts.get(buyer.cohortId as never);
      const cash = currencyId === undefined ? 0 : (cohort?.wallet.get(currencyId) ?? 0);
      const budget = Math.min(fixture.maxSpendPerBuyer, cash);
      if (budget <= 0) return;
      intents.push({
        id: createMarketIntentId(`mi:m3-preview-buyer-${index + 1}`),
        actor: { type: "COHORT", cohortId: buyer.cohortId as never },
        regionId: fixture.regionId,
        goodId: fixture.goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: fixture.desiredQuantityPerBuyer,
        maxSpend: budget,
        sourcePlanId: "plan:m3-preview-demand",
      });
    });

    return intents;
  };

  const phaseHandler = composePhaseHandlers(
    createPhase6Handler({ getFixtureIntents, getFixtureMarketIds, priceConfig: fixture.priceConfig }),
    createPhase8Handler({
      getFixtureIntents,
      getFixtureMarketIds,
      collectTelemetry: true,
      taxPolicy: {
        getConsumptionTaxRate: () => fixture.taxPolicy.consumptionTaxRate,
        getCollectionEfficiency: () => fixture.taxPolicy.collectionEfficiency,
      },
    }),
  );

  const priceKey = marketPriceKey(fixture.marketId, fixture.goodId);
  const ticks: M3PreviewTick[] = [];

  let world = worldState;
  for (let tick = 1; tick <= fixture.ticks; tick++) {
    const result = executeTick(world, tick, world.pendingTransitions, phaseHandler);
    const context = result.context;

    // A phase-boundary failure means the tick this preview would publish is not a tick the
    // orchestrator accepted. Reporting it as a market story would present broken accounting
    // as a picture of the economy, so the generator refuses instead.
    if (result.phaseBoundaryError !== undefined) {
      throw new Error(
        `generateM3Preview: tick ${tick} failed phase-boundary validation at phase ` +
          `${result.phaseBoundaryError.phase}: ${JSON.stringify(result.phaseBoundaryError.errors)}`,
      );
    }

    const telemetry = context.marketTelemetry.find(
      (entry) => entry.marketId === fixture.marketId && entry.goodId === fixture.goodId && entry.pass === "MAIN",
    );

    if (telemetry !== undefined) {
      let sellerNetReceipt = 0;
      let buyerGrossCost = 0;
      let consumptionTaxCollected = 0;
      let allocationCount = 0;
      for (const allocation of context.marketAllocations) {
        if (allocation.pass !== "MAIN") continue;
        if (allocation.marketId !== fixture.marketId || allocation.goodId !== fixture.goodId) continue;
        sellerNetReceipt += allocation.quantity * allocation.sellerNetUnitPrice;
        buyerGrossCost += allocation.quantity * allocation.buyerGrossUnitPrice;
        consumptionTaxCollected += allocation.consumptionTaxAmount;
        allocationCount += 1;
      }

      ticks.push({
        tick,
        sellerNetPrice: telemetry.sellerNetPrice,
        householdGrossPrice: telemetry.householdGrossPrice,
        desiredDemandQuantity: telemetry.desiredDemandQuantity,
        effectiveDemandQuantity: telemetry.effectiveDemandQuantity,
        offeredQuantity: telemetry.offeredQuantity,
        clearedQuantity: telemetry.clearedQuantity,
        unmetDemandQuantity: telemetry.unmetDemandQuantity,
        unsoldOfferQuantity: telemetry.unsoldOfferQuantity,
        shortageRate: telemetry.shortageRate,
        surplusRate: telemetry.surplusRate,
        sellerNetReceipt,
        buyerGrossCost,
        consumptionTaxCollected,
        allocationCount,
      });
    }

    world = applyMarketSettlementTransition(world, context);
    world = applyMarketStateTransition(world, context);
    // Phase-6 only writes a price when it saw intents this tick. Once supply and demand
    // are both exhausted there is nothing left to observe, so the run stops rather than
    // padding the trend with repeated flat ticks that no clearing produced.
    if (!context.marketPrices.has(priceKey)) break;
  }

  const region = worldState.regions.get(fixture.regionId);
  const currencyId = region?.settlementCurrencyId ?? ("cur:unknown" as CurrencyId);
  const currency = worldState.currencies.get(currencyId);
  const destinationStateId = region?.controllerStateId ?? null;
  const destinationState = destinationStateId === null ? undefined : worldState.states.get(destinationStateId);
  const goodDefinition = worldState.definitionRegistry.goods[fixture.goodId];

  const totals = ticks.reduce(
    (accumulator, entry) => ({
      clearedQuantity: accumulator.clearedQuantity + entry.clearedQuantity,
      sellerNetReceipt: accumulator.sellerNetReceipt + entry.sellerNetReceipt,
      buyerGrossCost: accumulator.buyerGrossCost + entry.buyerGrossCost,
      consumptionTaxCollected: accumulator.consumptionTaxCollected + entry.consumptionTaxCollected,
      allocationCount: accumulator.allocationCount + entry.allocationCount,
    }),
    { clearedQuantity: 0, sellerNetReceipt: 0, buyerGrossCost: 0, consumptionTaxCollected: 0, allocationCount: 0 },
  );

  const sellerNetReceiptPlusTax = totals.sellerNetReceipt + totals.consumptionTaxCollected;

  return {
    milestone: "M3",
    requirement: "REQ-VISUALIZATION-006",
    scenario: {
      scenarioId: worldState.scenarioId,
      seed: worldState.seed,
      configVersion: worldState.configVersion,
      ticksExecuted: ticks.length,
    },
    market: {
      marketId: fixture.marketId,
      regionId: fixture.regionId,
      regionName: region?.seed.name ?? String(fixture.regionId),
      goodId: fixture.goodId,
      goodName: goodDefinition?.name ?? String(fixture.goodId),
      quantityUnitLabel: goodDefinition?.unitLabel ?? "units",
      currencyId,
      currencyCode: currency?.seed.code ?? String(currencyId),
      destinationStateId,
      destinationStateName: destinationState?.seed.name ?? null,
      pass: "MAIN",
      sellerCount: fixture.sellers.length,
      buyerCount: fixture.buyers.length,
    },
    priceBounds: {
      minimumPrice: fixture.priceConfig.minimumPrice,
      maximumPrice: fixture.priceConfig.maximumPrice,
      maxAbsoluteLogPriceMovePerTick: fixture.priceConfig.maxAbsoluteLogPriceMovePerTick,
    },
    ticks,
    totals,
    settlementIdentity: {
      buyerGrossCost: totals.buyerGrossCost,
      sellerNetReceiptPlusTax,
      residual: totals.buyerGrossCost - sellerNetReceiptPlusTax,
      moneyEpsilon: required(worldState.simulationConfig.numeric.moneyEpsilon, "numeric.moneyEpsilon"),
    },
  };
}

/**
 * The canonical M3 golden run the published preview is generated from.
 *
 * Alpha Farmland (`r:2`) is the first baseline region that carries both food-selling
 * `ProductionUnit`s and funded `Cohort`s under one controller State, so its market is the
 * only kind of slice M3 can actually settle: a `PRODUCTION_UNIT` debiting `OUTPUT` against
 * a `COHORT` household inventory, paid in the region's settlement currency, with collected
 * consumption tax landing in the controller's treasury.
 *
 * The numbers stage Handoff/04 section 40 scenario A — a local shortage — against fixed
 * buyer endowments: three sellers offer 30 units a tick into a desire for 54, so the
 * market starts short and Phase-6 raises the price; the rising gross price rations
 * effective demand until the fixed buyer cash is spent, after which the same offer clears
 * nothing and the price falls back. M3 has no production, wages or income (that is M4), so
 * the depletion is the honest end of this slice rather than a defect to paper over.
 *
 * `minimumPrice`/`maximumPrice` are fixture values: no canonical config section owns them
 * yet (see `Phase6PriceConfig`), which is why the preview exports the bounds it ran under.
 */
export function m3GoldenRunFixture(world: WorldState): M3GoldenRunFixture {
  const markets = world.simulationConfig.markets;
  const read = (value: number | undefined, name: string): number => required(value, `markets.${name}`);
  return {
    regionId: "r:2" as RegionId,
    marketId: "m:2" as MarketId,
    goodId: "good:food" as GoodId,
    sellers: [{ productionUnitId: "pu:13" }, { productionUnitId: "pu:14" }, { productionUnitId: "pu:21" }],
    buyers: [{ cohortId: "pc:11" }, { cohortId: "pc:12" }, { cohortId: "pc:10" }],
    offerQuantityPerSeller: 10,
    desiredQuantityPerBuyer: 18,
    maxSpendPerBuyer: 200,
    // Ten ticks is the whole arc and no more: the market starts short, the price rises,
    // effective demand is rationed against fixed cash until the offer outstrips it, and the
    // last tick still settles real money. Running further would only append ticks in which
    // nothing at all trades, which would make the default (latest) view an empty market.
    ticks: 10,
    // The values Phase 8 used to pin internally, now stated where the scenario can be read.
    // Holding them fixed keeps this published preview's story unchanged; the collection
    // efficiency this fixture does not exercise is proven by the Phase-8 regression instead.
    taxPolicy: { consumptionTaxRate: 0.1, collectionEfficiency: 1 },
    priceConfig: {
      shortageSignalWeight: read(markets.shortageSignalWeight, "shortageSignalWeight"),
      inventorySignalWeight: read(markets.inventorySignalWeight, "inventorySignalWeight"),
      basePriceAdjustmentSpeed: read(markets.basePriceAdjustmentSpeed, "basePriceAdjustmentSpeed"),
      maxAbsoluteLogPriceMovePerTick: read(
        markets.maxAbsoluteLogPriceMovePerTick,
        "maxAbsoluteLogPriceMovePerTick",
      ),
      targetInventoryCoverageTicks: read(
        markets.targetInventoryCoverageTicks,
        "targetInventoryCoverageTicks",
      ),
      minimumPrice: 1,
      maximumPrice: 100,
    },
  };
}

/**
 * Read a configured value that the preview must not substitute a default for.
 *
 * `CANONICAL_CONFIG_AND_WORLD_GENERATION` section 4 is the sole owner of the baseline
 * market numbers (HANDOFF-REPAIR-005/010). A `?? 0.65` here would quietly create a second
 * owner and let the published preview describe a price path the configured simulation
 * would not produce, so a missing value is an error rather than a fallback.
 */
function required(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(
      `m3Preview: SimulationConfig.${name} is not set. The preview reports the configured ` +
        `simulation and must not substitute a default for a value config owns.`,
    );
  }
  return value;
}
