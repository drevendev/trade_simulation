/**
 * Issue #676 / M5 golden: two real Phase-2 BUY intents for the SAME good and
 * ProductionUnit compete for one physical import corridor and one wallet.
 * The intentional test recipe uses iron for both inputs and capital additions.
 * No Phase-2 orders, Phase-7 lots, FX receipts, or stock changes are forged.
 */
import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import { executeM5AutonomousRegionalTradeTick, type M5AutonomousRegionalTradeOptions } from "./m5AutonomousRegionalTradeTick";
import { derivePhase7PostProcurementIntents } from "./phase7PostProcurementIntents";
import type { PhaseHandler } from "./tickOrchestrator";
import { buildInitialWorld, type ProductionUnitState, type RegionState, type WorldState } from "./worldState";

const IRON = "good:iron" as GoodId;
const TICK = 9; // Phase-2 investment-review cadence is three ticks.

const upstream: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return { ...context, effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
    ) };
  }
  return context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
};

function fixture() {
  const craft = baselineDefinitionPack.recipes["recipe:tools-craft"]!;
  const pack = {
    ...baselineDefinitionPack,
    recipes: {
      ...baselineDefinitionPack.recipes,
      "recipe:tools-craft": {
        ...craft,
        // A legitimate investment and an INPUT order now require SAME good.
        investmentGoodsPerCapitalUnit: { [IRON]: 10 },
      },
    },
  };
  const initial = buildInitialWorld(
    baselineScenario, pack, createDefaultSimulationConfig(), 42,
  );
  const source = [...initial.regions.values()].find(r => r.seed.key === "region:a4-border")!;
  const destination = [...initial.regions.values()].find(r => r.seed.key === "region:b4-chokepoint")!;
  const link = [...initial.transportLinks.values()].find(l =>
    l.fromRegionId === source.regionId && l.toRegionId === destination.regionId)!;
  expect(link).toBeDefined();
  expect(source.settlementCurrencyId).not.toBe(destination.settlementCurrencyId);
  const templates = [...initial.productionUnits.values()].slice(0, 4);
  expect(templates).toHaveLength(4);
  const make = (
    template: ProductionUnitState, region: RegionState,
    status: "ACTIVE" | "CLOSING", cash: number, stock: number,
    pressure = false,
  ): ProductionUnitState => ({
    ...template,
    seed: { ...template.seed, regionKey: region.seed.key, recipeId: "recipe:tools-craft" },
    status,
    installedCapital: status === "ACTIVE" ? 5 : 0,
    wallet: new Map([[region.settlementCurrencyId, cash]]),
    inputInventory: stock === 0 ? new Map() : new Map([[IRON, stock]]),
    outputInventory: new Map(),
    investmentInventory: new Map(),
    signals: pressure
      ? { ...template.signals, utilizationEma: 1, sellThroughEma: 1, marginSignalEma: 0.9 }
      : template.signals,
  });
  const buyerA = make(templates[0]!, source, "ACTIVE", 1_000_000, 0);
  const sellerA = make(templates[1]!, source, "CLOSING", 5, 1_000);
  const buyerB = make(templates[2]!, destination, "ACTIVE", 40_000, 0, true);
  const sellerB = make(templates[3]!, destination, "CLOSING", 5, 2);
  const isPair = (base: string, quote: string) =>
    (base === source.settlementCurrencyId && quote === destination.settlementCurrencyId) ||
    (base === destination.settlementCurrencyId && quote === source.settlementCurrencyId);
  const pools = [...initial.monetaryAuthorities.values()].flatMap(a =>
    [...a.fxPools.values()].filter(pool =>
      isPair(pool.baseCurrencyId, pool.quoteCurrencyId)));
  expect(pools.length).toBeGreaterThan(1);
  const chosenPool = pools[0]!;
  const world: WorldState = {
    ...initial,
    regions: new Map([[source.regionId, source], [destination.regionId, destination]]),
    markets: new Map([...initial.markets].filter(([, market]) =>
      [source.seed.key, destination.seed.key].includes(market.seed.regionKey),
    ).map(([id, market]) => [id, {
      ...market, priceByGood: new Map(market.priceByGood).set(
        IRON, market.seed.regionKey === source.seed.key ? 1 : 100,
      ),
    }] as const)),
    productionUnits: new Map([buyerA, sellerA, buyerB, sellerB]
      .map(unit => [unit.productionUnitId, unit] as const)),
    transportLinks: new Map([[link.linkId, {
      ...link, seed: { ...link.seed, baseCapacity: 24 },
    }]]),
    monetaryAuthorities: new Map([...initial.monetaryAuthorities].map(([id, authority]) => [
      id, { ...authority, fxPools: new Map([...authority.fxPools].filter(
        ([poolId, pool]) => !isPair(pool.baseCurrencyId, pool.quoteCurrencyId) ||
          poolId === chosenPool.pairId,
      )) },
    ] as const)),
  };
  const market = world.simulationConfig.markets;
  const options: M5AutonomousRegionalTradeOptions = {
    procurement: {
      taxPolicy: { getConsumptionTaxRate: () => 0.05, getCollectionEfficiency: () => 1 },
      wageTaxPolicy: { assessWageIncomeTax: () => 0, getCollectionEfficiency: () => 1 },
      priceConfig: {
        shortageSignalWeight: market.shortageSignalWeight!,
        inventorySignalWeight: market.inventorySignalWeight!,
        basePriceAdjustmentSpeed: market.basePriceAdjustmentSpeed!,
        maxAbsoluteLogPriceMovePerTick: market.maxAbsoluteLogPriceMovePerTick!,
        targetInventoryCoverageTicks: market.targetInventoryCoverageTicks!,
        minimumPrice: 0.001, maximumPrice: 1_000_000,
      },
    },
    scorePolicy: {
      tradeProfitWeight: 1, shortageWeight: 1,
      minimumTradeScore: -100, maximumShortagePremiumShare: 1,
    },
    transportFeeCostPolicy: {
      minimumConditionForCost: 0.01, maximumConditionCostMultiplier: 10,
    },
    infrastructureFactors: new Map([[link.linkId, 1]]),
    phase1TradeLawProvider: query =>
      query.linkId === link.linkId && query.goodId === IRON ? null : undefined,
    phase1TariffLawProvider: query => query.goodId === IRON ? 0.1 : 0,
  };
  return { world, options, buyerB, sellerA, destination };
}

function shuffled(world: WorldState): WorldState {
  return {
    ...world,
    regions: new Map([...world.regions].reverse()),
    markets: new Map([...world.markets].reverse()),
    productionUnits: new Map([...world.productionUnits].reverse()),
    transportLinks: new Map([...world.transportLinks].reverse()),
    monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(
      ([id, authority]) => [id, {
        ...authority, fxPools: new Map([...authority.fxPools].reverse()),
      }] as const,
    )),
  };
}

describe("M5 #676 real same-owner same-good cash and goods competition", () => {
  it("funds distinct INPUT/INVESTMENT iron orders without cross-intent debit", () => {
    const f = fixture();
    let beforePhase7: WorldState | undefined;
    let afterPhase7: WorldState | undefined;
    const run = (opening: WorldState, observe = false) =>
      executeM5AutonomousRegionalTradeTick(
        opening, TICK, upstream, (_phase, current) => current, f.options,
        observe ? (phase, before, after) => {
          if (phase === 7) { beforePhase7 = before; afterPhase7 = after; }
        } : undefined,
      );
    const actual = run(f.world, true);
    const replay = run(shuffled(f.world));
    for (const result of [actual, replay]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
    }
    expect(actual.context.phase7CommittedLots).toEqual(replay.context.phase7CommittedLots);
    expect(actual.context.phase7MainIntents).toEqual(replay.context.phase7MainIntents);
    expect(actual.context.transactions).toEqual(replay.context.transactions);

    expect(beforePhase7).toBeDefined();
    expect(afterPhase7).toBeDefined();
    const opening = derivePhase7PostProcurementIntents(
      beforePhase7!, { ...actual.context, phase: 7 },
    ).phase8MainIntents;
    const original = opening.filter(i =>
      i.side === "BUY" && i.goodId === IRON &&
      i.actor.type === "PRODUCTION_UNIT" &&
      i.actor.productionUnitId === f.buyerB.productionUnitId &&
      (i.purpose === "INPUT" || i.purpose === "INVESTMENT"));
    expect(new Set(original.map(i => i.purpose))).toEqual(new Set(["INPUT", "INVESTMENT"]));
    expect(new Set(original.map(i => i.id)).size).toBe(2);
    expect(original.every(i => i.maxSpend! > 0 && i.desiredQuantity > 0)).toBe(true);
    const paid = (actual.context.phase7CommittedLots ?? []).filter(lot =>
      original.some(i => i.id === lot.buyerIntentId));
    expect(new Set(paid.map(lot => lot.buyerIntentId)))
      .toEqual(new Set(original.map(i => i.id)));
    expect(paid.every(lot => lot.goodId === IRON && lot.dispatchedQuantity > 0)).toBe(true);
    const dispatched = [...(afterPhase7!.shipments?.values() ?? [])];
    expect(new Set(paid.map(lot =>
      dispatched.find(cargo => String(cargo.id) === lot.shipmentId)?.destinationInventoryBucket,
    ))).toEqual(new Set(["INPUT", "INVESTMENT"]));

    const closing = actual.context.phase7MainIntents!;
    const assertDebits = (end: typeof closing, receipts: typeof paid): void => {
      const byId = new Map(end.map(i => [i.id, i] as const));
      for (const initial of original) {
        const charged = receipts.filter(lot => lot.buyerIntentId === initial.id);
        const quantity = charged.reduce((sum, lot) => sum + lot.dispatchedQuantity, 0);
        const spend = charged.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0);
        expect(initial.desiredQuantity - byId.get(initial.id)!.desiredQuantity)
          .toBeCloseTo(quantity, 6);
        expect(initial.maxSpend! - byId.get(initial.id)!.maxSpend!)
          .toBeCloseTo(spend, 6);
      }
    };
    assertDebits(closing, paid);
    const beforeCash = beforePhase7!.productionUnits.get(f.buyerB.productionUnitId)!
      .wallet.get(f.destination.settlementCurrencyId)!;
    const afterCash = afterPhase7!.productionUnits.get(f.buyerB.productionUnitId)!
      .wallet.get(f.destination.settlementCurrencyId)!;
    const totalSpend = paid.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0);
    expect(totalSpend).toBeGreaterThan(0);
    expect(beforeCash - afterCash).toBeCloseTo(totalSpend, 5);
    expect(afterCash).toBeGreaterThanOrEqual(0);
    const beforeStock = beforePhase7!.productionUnits.get(f.sellerA.productionUnitId)!
      .inputInventory.get(IRON)!;
    const afterStock = afterPhase7!.productionUnits.get(f.sellerA.productionUnitId)!
      .inputInventory.get(IRON)!;
    expect(beforeStock - afterStock).toBeCloseTo(
      paid.reduce((sum, lot) => sum + lot.dispatchedQuantity, 0), 6,
    );

    // Balanced ID relabeling is invisible to owner-level goods/cash totals.
    // Neither the physical world nor original receipts are touched.
    const wrongId = original.find(i => i.id !== paid[0]!.buyerIntentId)!.id;
    const forged = paid.map((lot, index) =>
      index === 0 ? { ...lot, buyerIntentId: wrongId } : lot);
    expect(forged.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0))
      .toBeCloseTo(totalSpend, 8);
    expect(() => assertDebits(closing, forged)).toThrow();
  }, 30_000);

  it("clamps shared same-good intent spending to one physical corridor's cargo weight", () => {
    const f = fixture();
    const [linkId, link] = [...f.world.transportLinks][0]!;
    expect(link.seed.condition).toBeGreaterThan(0);
    const weight = baselineDefinitionPack.goods[IRON]!.cargoWeightPerUnit;
    const run = (
      world: WorldState,
      options: M5AutonomousRegionalTradeOptions = f.options,
      observe?: (phase: number, before: WorldState, after: WorldState) => void,
    ) => executeM5AutonomousRegionalTradeTick(
      world, TICK, upstream, (_phase, current) => current, options, observe,
    );

    // Establish real, non-vacuous autonomous orders and dispatches before
    // constraining capacity. No receipt or trade intent is injected.
    const full = run(f.world);
    expect(full.phaseBoundaryError).toBeUndefined();
    expect(full.reconciliationErrors).toBeNull();
    const fullCargo = (full.context.phase7DispatchedShipments ?? [])
      .filter(cargo => cargo.transportLinkId === linkId);
    expect(fullCargo.length).toBeGreaterThan(0);
    expect(fullCargo.every(cargo => cargo.goodId === IRON)).toBe(true);
    const fullWeight = fullCargo.reduce((sum, cargo) => sum + cargo.quantity * weight, 0);
    expect(fullWeight).toBeGreaterThan(0);

    // One-half the actually used weight, NOT half the item count. The same
    // two Phase-2 buyers still share one wallet and a single physical link.
    const cargoBudget = fullWeight / 2;
    const narrow: WorldState = {
      ...f.world,
      transportLinks: new Map([[linkId, {
        ...link,
        seed: { ...link.seed, baseCapacity: cargoBudget / link.seed.condition },
      }]]),
    };
    let beforePhase7: WorldState | undefined;
    let afterPhase7: WorldState | undefined;
    const limited = run(narrow, f.options, (phase, before, after) => {
      if (phase === 7) { beforePhase7 = before; afterPhase7 = after; }
    });
    const reversed = run(shuffled(narrow));
    for (const result of [limited, reversed]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
    }
    expect(limited.context.phase7CommittedLots).toEqual(reversed.context.phase7CommittedLots);
    expect(limited.context.transactions).toEqual(reversed.context.transactions);
    expect(limited.world.shipments).toEqual(reversed.world.shipments);
    expect(beforePhase7).toBeDefined();
    expect(afterPhase7).toBeDefined();

    const cargo = (limited.context.phase7DispatchedShipments ?? [])
      .filter(shipment => shipment.transportLinkId === linkId);
    const usedWeight = cargo.reduce((sum, shipment) =>
      sum + shipment.quantity * weight, 0);
    expect(usedWeight).toBeGreaterThan(0); // A blocked trade is not a bottleneck proof.
    expect(usedWeight).toBeLessThan(fullWeight - 1e-8);
    expect(usedWeight).toBeLessThanOrEqual(cargoBudget + 1e-8);

    const originals = derivePhase7PostProcurementIntents(
      beforePhase7!, { ...limited.context, phase: 7 },
    ).phase8MainIntents.filter(i =>
      i.side === "BUY" && i.goodId === IRON &&
      i.actor.type === "PRODUCTION_UNIT" &&
      i.actor.productionUnitId === f.buyerB.productionUnitId &&
      (i.purpose === "INPUT" || i.purpose === "INVESTMENT"));
    expect(new Set(originals.map(i => i.purpose))).toEqual(new Set(["INPUT", "INVESTMENT"]));
    expect(new Set(originals.map(i => i.id)).size).toBe(2);
    const paid = (limited.context.phase7CommittedLots ?? [])
      .filter(lot => originals.some(i => i.id === lot.buyerIntentId));
    expect(paid.length).toBeGreaterThan(0);

    // Physical capacity alone cannot prove that competing orders were
    // decremented under THEIR OWN IDs rather than each other's.
    const closing = limited.context.phase7MainIntents!;
    const assertPerIntent = (receipts: typeof paid): void => {
      const endById = new Map(closing.map(i => [i.id, i] as const));
      for (const original of originals) {
        const end = endById.get(original.id)!;
        expect(original.desiredQuantity - end.desiredQuantity).toBeCloseTo(
          receipts.filter(lot => lot.buyerIntentId === original.id)
            .reduce((sum, lot) => sum + lot.dispatchedQuantity, 0), 6);
        expect(original.maxSpend! - end.maxSpend!).toBeCloseTo(
          receipts.filter(lot => lot.buyerIntentId === original.id)
            .reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0), 6);
      }
    };
    assertPerIntent(paid);
    const buyerBefore = beforePhase7!.productionUnits.get(f.buyerB.productionUnitId)!
      .wallet.get(f.destination.settlementCurrencyId)!;
    const buyerAfter = afterPhase7!.productionUnits.get(f.buyerB.productionUnitId)!
      .wallet.get(f.destination.settlementCurrencyId)!;
    expect(buyerBefore - buyerAfter).toBeCloseTo(
      paid.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0), 5);
    const sellerBefore = beforePhase7!.productionUnits.get(f.sellerA.productionUnitId)!
      .inputInventory.get(IRON)!;
    const sellerAfter = afterPhase7!.productionUnits.get(f.sellerA.productionUnitId)!
      .inputInventory.get(IRON)!;
    expect(sellerBefore - sellerAfter).toBeCloseTo(
      paid.reduce((sum, lot) => sum + lot.dispatchedQuantity, 0), 6);

    // Negative control preserves the total goods/cash of the constrained
    // route while attributing a paid lot to the other valid buyer intent.
    const alternate = originals.find(i => i.id !== paid[0]!.buyerIntentId)!.id;
    const misattributed = paid.map((lot, index) =>
      index === 0 ? { ...lot, buyerIntentId: alternate } : lot);
    expect(misattributed.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0))
      .toBeCloseTo(paid.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0), 8);
    expect(() => assertPerIntent(misattributed)).toThrow();

    // With the exact same real Phase-2/4 intents, zero usable link capacity
    // must halt foreign payments without suppressing domestic procurement.
    const stopped = run(f.world, {
      ...f.options, infrastructureFactors: new Map([[linkId, 0]]),
    });
    expect(stopped.phaseBoundaryError).toBeUndefined();
    expect(stopped.reconciliationErrors).toBeNull();
    expect(stopped.context.phase7CommittedLots ?? []).toHaveLength(0);
    expect(stopped.context.transactions.filter(tx =>
      tx.phase === 7 && ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT",
        "IMPORT_TARIFF", "TRANSPORT_FEE"].includes(tx.type))).toHaveLength(0);
    expect(stopped.context.transactions.filter(tx => tx.phase === 4))
      .toEqual(full.context.transactions.filter(tx => tx.phase === 4));
  }, 30_000);


  it("shrinks real same-owner iron orders against a shared finite FX output reserve before goods move", () => {
    const f = fixture();
    const sellerCurrency = [...f.sellerA.wallet.keys()][0]!;
    const buyerCurrency = f.destination.settlementCurrencyId;
    const matching = [...f.world.monetaryAuthorities].flatMap(([authorityId, authority]) =>
      [...authority.fxPools].filter(([, pool]) =>
        (pool.baseCurrencyId === sellerCurrency && pool.quoteCurrencyId === buyerCurrency) ||
        (pool.quoteCurrencyId === sellerCurrency && pool.baseCurrencyId === buyerCurrency),
      ).map(([poolId, pool]) => ({ authorityId, poolId, pool })),
    );
    expect(matching).toHaveLength(1);
    const selected = matching[0]!;
    const floor = selected.pool.baseCurrencyId === sellerCurrency
      ? selected.pool.minOperationalReserveBase
      : selected.pool.minOperationalReserveQuote;
    const run = (
      world: WorldState,
      observer?: (phase: number, before: WorldState, after: WorldState) => void,
    ) => executeM5AutonomousRegionalTradeTick(
      world, TICK, upstream, (_phase, current) => current, f.options, observer,
    );
    const fxOutput = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx =>
        tx.phase === 7 && tx.type === "FX_OUTPUT" && tx.currencyId === sellerCurrency,
      ).reduce((sum, tx) => sum + tx.moneyAmount!, 0);
    const fxInput = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx =>
        tx.phase === 7 && tx.type === "FX_INPUT" && tx.currencyId === buyerCurrency,
      ).reduce((sum, tx) => sum + tx.moneyAmount!, 0);
    const poolBalance = (world: WorldState, currency: typeof sellerCurrency) =>
      world.monetaryAuthorities.get(selected.authorityId)!
        .fxPools.get(selected.poolId)!.cash.get(currency)!;
    const withBudget = (budget: number): WorldState => ({
      ...f.world,
      monetaryAuthorities: new Map([...f.world.monetaryAuthorities].map(([id, authority]) => [
        id, id === selected.authorityId
          ? { ...authority, fxPools: new Map(authority.fxPools).set(selected.poolId, {
            ...selected.pool,
            cash: new Map(selected.pool.cash).set(sellerCurrency, floor + budget),
          }) }
          : authority,
      ] as const)),
    });

    const full = run(f.world);
    expect(full.phaseBoundaryError).toBeUndefined();
    expect(full.reconciliationErrors).toBeNull();
    const fullPayout = fxOutput(full);
    expect(fullPayout).toBeGreaterThan(0);
    expect((full.context.phase7CommittedLots ?? []).length).toBeGreaterThan(0);

    // The two genuine Phase-2 orders share one finite pool; reduce its OUTPUT
    // currency stock (not the buyer wallet, seller stock, or a forged FX quote).
    const scarceWorld = withBudget(fullPayout * 0.65);
    let beforePhase7: WorldState | undefined;
    let afterPhase7: WorldState | undefined;
    const scarce = run(scarceWorld, (phase, before, after) => {
      if (phase === 7) { beforePhase7 = before; afterPhase7 = after; }
    });
    const replay = run(shuffled(scarceWorld));
    const exhausted = run(withBudget(0));
    for (const result of [scarce, replay, exhausted]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
    }
    expect(scarce.context.phase7CommittedLots).toEqual(replay.context.phase7CommittedLots);
    expect(scarce.context.transactions).toEqual(replay.context.transactions);
    expect(scarce.world.shipments).toEqual(replay.world.shipments);
    expect(beforePhase7).toBeDefined();
    expect(afterPhase7).toBeDefined();

    const paid = scarce.context.phase7CommittedLots ?? [];
    const paidPayout = fxOutput(scarce);
    expect(paid).not.toHaveLength(0); // Non-vacuous partial fill.
    expect(paidPayout).toBeGreaterThan(0);
    expect(paidPayout).toBeLessThan(fullPayout - 1e-7);
    expect(paidPayout).toBeLessThanOrEqual(fullPayout * 0.65 + 1e-7);
    const openingIntents = derivePhase7PostProcurementIntents(
      beforePhase7!, { ...scarce.context, phase: 7 },
    ).phase8MainIntents.filter(i =>
      i.side === "BUY" && i.goodId === IRON &&
      i.actor.type === "PRODUCTION_UNIT" &&
      i.actor.productionUnitId === f.buyerB.productionUnitId &&
      (i.purpose === "INPUT" || i.purpose === "INVESTMENT"));
    expect(new Set(openingIntents.map(i => i.purpose)))
      .toEqual(new Set(["INPUT", "INVESTMENT"]));
    const residualById = new Map(scarce.context.phase7MainIntents!.map(i => [i.id, i] as const));
    for (const intent of openingIntents) {
      const residual = residualById.get(intent.id)!;
      expect(intent.desiredQuantity - residual.desiredQuantity).toBeCloseTo(
        paid.filter(lot => lot.buyerIntentId === intent.id)
          .reduce((sum, lot) => sum + lot.dispatchedQuantity, 0), 6);
      expect(intent.maxSpend! - residual.maxSpend!).toBeCloseTo(
        paid.filter(lot => lot.buyerIntentId === intent.id)
          .reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0), 6);
    }
    const buyerBefore = beforePhase7!.productionUnits.get(f.buyerB.productionUnitId)!
      .wallet.get(buyerCurrency)!;
    const buyerAfter = afterPhase7!.productionUnits.get(f.buyerB.productionUnitId)!
      .wallet.get(buyerCurrency)!;
    expect(buyerBefore - buyerAfter).toBeCloseTo(
      paid.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0), 6);
    const sellerBefore = beforePhase7!.productionUnits.get(f.sellerA.productionUnitId)!
      .inputInventory.get(IRON)!;
    const sellerAfter = afterPhase7!.productionUnits.get(f.sellerA.productionUnitId)!
      .inputInventory.get(IRON)!;
    expect(sellerBefore - sellerAfter).toBeCloseTo(
      paid.reduce((sum, lot) => sum + lot.dispatchedQuantity, 0), 6);

    // Bind every paid real shipment to its actual FX output ledger leg and
    // the named source-region seller, not just to the pool's aggregate debit.
    const dispatched = scarce.context.phase7DispatchedShipments ?? [];
    const outputLegs = scarce.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT" && tx.currencyId === sellerCurrency);
    expect(dispatched).toHaveLength(paid.length);
    expect(outputLegs).toHaveLength(paid.length);
    for (const lot of paid) {
      const cargo = dispatched.find(shipment => String(shipment.id) === lot.shipmentId);
      expect(cargo).toBeDefined();
      expect(cargo!.seller).toEqual({
        type: "PRODUCTION_UNIT", productionUnitId: f.sellerA.productionUnitId,
      });
      expect(cargo!.fxSettlementId).toBeDefined();
      const receipts = outputLegs.filter(tx => tx.fxSettlementId === cargo!.fxSettlementId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.destination).toEqual(cargo!.seller);
      expect(receipts[0]!.moneyAmount).toBeCloseTo(
        cargo!.sellerNetUnitPrice * cargo!.quantity, 6,
      );
    }
    const assertSellerReceipt = (candidate: WorldState): void => {
      const walletBefore = beforePhase7!.productionUnits.get(f.sellerA.productionUnitId)!
        .wallet.get(sellerCurrency)!;
      const walletAfter = candidate.productionUnits.get(f.sellerA.productionUnitId)!
        .wallet.get(sellerCurrency)!;
      expect(walletAfter - walletBefore).toBeCloseTo(
        outputLegs.reduce((sum, tx) => sum + tx.moneyAmount!, 0), 6,
      );
    };
    assertSellerReceipt(afterPhase7!);
    // Balanced wrong-beneficiary corruption leaves all aggregate cash, cargo,
    // FX pool and seller inventory unchanged; owner-bound receipt must fail.
    const otherSellerCurrencyUnit = [...afterPhase7!.productionUnits.values()].find(unit =>
      unit.productionUnitId !== f.sellerA.productionUnitId &&
      unit.seed.regionKey === f.sellerA.seed.regionKey);
    expect(otherSellerCurrencyUnit).toBeDefined();
    const forgedUnits = new Map(afterPhase7!.productionUnits);
    const stolen = paidPayout / 4;
    for (const [id, delta] of [
      [f.sellerA.productionUnitId, -stolen],
      [otherSellerCurrencyUnit!.productionUnitId, stolen],
    ] as const) {
      const unit = forgedUnits.get(id)!;
      forgedUnits.set(id, { ...unit, wallet: new Map(unit.wallet)
        .set(sellerCurrency, (unit.wallet.get(sellerCurrency) ?? 0) + delta) });
    }
    expect(() => assertSellerReceipt({
      ...afterPhase7!, productionUnits: forgedUnits,
    })).toThrow();

    const assertFxReserve = (claimedPayout: number) => {
      expect(poolBalance(beforePhase7!, sellerCurrency) -
        poolBalance(afterPhase7!, sellerCurrency)).toBeCloseTo(claimedPayout, 6);
      expect(poolBalance(afterPhase7!, buyerCurrency) -
        poolBalance(beforePhase7!, buyerCurrency)).toBeCloseTo(fxInput(scarce), 6);
    };
    assertFxReserve(paidPayout);
    expect(poolBalance(afterPhase7!, sellerCurrency)).toBeGreaterThanOrEqual(floor - 1e-8);
    // A forged FX output amount cannot pass the reserve-delta assertion.
    expect(() => assertFxReserve(paidPayout + 1)).toThrow();

    // A floor-only pool cannot sponsor even one of the two valid orders.
    // Earlier, genuinely paid domestic procurement remains identical.
    expect(fxOutput(exhausted)).toBe(0);
    expect(fxInput(exhausted)).toBe(0);
    expect(exhausted.context.phase7CommittedLots ?? []).toHaveLength(0);
    expect(exhausted.world.shipments?.size ?? 0).toBe(0);
    expect(exhausted.context.transactions.filter(tx => tx.phase === 7 &&
      ["SHIPMENT_DISPATCH", "TRADE_GOODS_SALE", "FX_INPUT", "FX_OUTPUT",
        "IMPORT_TARIFF", "TRANSPORT_FEE"].includes(tx.type))).toHaveLength(0);
    const paidDomestic = full.context.transactions.filter(tx =>
      tx.phase === 4 && tx.type === "MARKET_SALE" && tx.goodId === IRON &&
      tx.source?.type === "PRODUCTION_UNIT" &&
      tx.destination?.type === "PRODUCTION_UNIT" &&
      (tx.quantity ?? 0) > 0 && (tx.moneyAmount ?? 0) > 0);
    // A nonempty, paid local allocation with explicit actors, not equality
    // of two empty Phase-4 transaction lists.
    expect(paidDomestic.length).toBeGreaterThan(0);
    for (const sale of paidDomestic) {
      expect(sale.source).not.toEqual(sale.destination);
      expect(sale.sourceRegionId).toBe(sale.destinationRegionId);
      expect(sale.quantity).toBeGreaterThan(0);
      expect(sale.moneyAmount).toBeGreaterThan(0);
    }
    expect(exhausted.context.transactions.filter(tx =>
      tx.phase === 4 && tx.type === "MARKET_SALE"))
      .toEqual(full.context.transactions.filter(tx =>
        tx.phase === 4 && tx.type === "MARKET_SALE"));
    expect(exhausted.context.transactions.filter(tx => tx.phase === 4))
      .toEqual(full.context.transactions.filter(tx => tx.phase === 4));
    expect(poolBalance(exhausted.world, sellerCurrency)).toBeCloseTo(floor, 8);
  }, 30_000);

});
