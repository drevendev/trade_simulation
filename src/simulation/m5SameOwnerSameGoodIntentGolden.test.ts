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
    const [[linkId, link]] = [...f.world.transportLinks];
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

});
