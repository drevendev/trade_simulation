import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import type { PhaseHandler } from "./tickOrchestrator";
import type { M4ClosedEconomyOptions } from "./m4ClosedEconomyOrchestrator";
import {
  executeM5AutonomousRegionalTradeTick, type M5AutonomousRegionalTradeOptions,
} from "./m5AutonomousRegionalTradeTick";
import {
  buildInitialWorld, type WorldState, type ProductionUnitState, type RegionState,
} from "./worldState";

const IRON = "good:iron" as GoodId;
// The fixture upstream represents the real Phase-1 jurisdiction activator.
// Frozen trade/tax law must never infer it from WorldState at Phase 7.
const households: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return {
      ...context,
      effectiveJurisdictionByRegion: new Map([...world.regions].map(
        ([id, region]) => [id, region.controllerStateId] as const,
      )),
    };
  }
  return context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
};

/** Two genuinely linked border markets, two legal currencies and real actors.
 * No caller-provided Phase-2 orders, Phase-4 fills, Phase-7 quotes, FX or cargo. */
function fixture(keepAmbiguousFx = false) {
  const initial = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
  );
  const source = [...initial.regions.values()].find(
    r => r.seed.key === "region:a4-border",
  )!;
  const destination = [...initial.regions.values()].find(
    r => r.seed.key === "region:b4-chokepoint",
  )!;
  const link = [...initial.transportLinks.values()].find(
    l => l.fromRegionId === source.regionId && l.toRegionId === destination.regionId,
  )!;
  expect(link).toBeDefined();

  const templates = [...initial.productionUnits.values()].slice(0, 4);
  expect(templates).toHaveLength(4);
  const makeUnit = (
    template: ProductionUnitState, region: RegionState,
    status: "ACTIVE" | "CLOSING", cash: number, iron: number,
  ): ProductionUnitState => ({
    ...template,
    seed: { ...template.seed, regionKey: region.seed.key, recipeId: "recipe:tools-craft" },
    status,
    installedCapital: status === "ACTIVE" ? 5 : 0,
    wallet: new Map([[region.settlementCurrencyId, cash]]),
    inputInventory: iron === 0 ? new Map() : new Map([[IRON, iron]]),
    outputInventory: new Map(),
    investmentInventory: new Map(),
  });
  const buyerA = makeUnit(templates[0]!, source, "ACTIVE", 1_000_000, 0);
  const sellerA = makeUnit(templates[1]!, source, "CLOSING", 5, 500);
  const buyerB = makeUnit(templates[2]!, destination, "ACTIVE", 1_000_000, 0);
  const sellerB = makeUnit(templates[3]!, destination, "CLOSING", 5, 2);
  const markets = new Map(
    [...initial.markets].filter(([, market]) =>
      market.seed.regionKey === source.seed.key ||
      market.seed.regionKey === destination.seed.key,
    ).map(([id, market]) => [
      id, { ...market, priceByGood: new Map(market.priceByGood).set(
        IRON, market.seed.regionKey === source.seed.key ? 1 : 100,
      ) },
    ] as const),
  );
  const matchesPool = (base: string, quote: string): boolean =>
    (base === source.settlementCurrencyId && quote === destination.settlementCurrencyId) ||
    (quote === source.settlementCurrencyId && base === destination.settlementCurrencyId);
  const pairIds = [...initial.monetaryAuthorities.values()].flatMap(
    authority => [...authority.fxPools].filter(([, pool]) =>
      matchesPool(pool.baseCurrencyId, pool.quoteCurrencyId),
    ).map(([id]) => id),
  );
  expect(pairIds.length).toBeGreaterThan(1);
  const chosenPair = pairIds[0]!;
  const monetaryAuthorities = new Map([...initial.monetaryAuthorities].map(([id, authority]) => [
    id, { ...authority, fxPools: keepAmbiguousFx
      ? authority.fxPools
      : new Map([...authority.fxPools].filter(([poolId, pool]) =>
        !matchesPool(pool.baseCurrencyId, pool.quoteCurrencyId) || poolId === chosenPair,
      )) },
  ] as const));
  const world: WorldState = {
    ...initial,
    regions: new Map([[source.regionId, source], [destination.regionId, destination]]),
    markets,
    productionUnits: new Map([
      [buyerA.productionUnitId, buyerA], [sellerA.productionUnitId, sellerA],
      [buyerB.productionUnitId, buyerB], [sellerB.productionUnitId, sellerB],
    ]),
    transportLinks: new Map([[link.linkId, link]]),
    monetaryAuthorities,
  };
  const config = world.simulationConfig.markets;
  const procurement: M4ClosedEconomyOptions = {
    taxPolicy: {
      getConsumptionTaxRate: () => 0.05,
      getCollectionEfficiency: () => 1,
    },
    wageTaxPolicy: {
      assessWageIncomeTax: () => 0,
      getCollectionEfficiency: () => 1,
    },
    priceConfig: {
      shortageSignalWeight: config.shortageSignalWeight!,
      inventorySignalWeight: config.inventorySignalWeight!,
      basePriceAdjustmentSpeed: config.basePriceAdjustmentSpeed!,
      maxAbsoluteLogPriceMovePerTick: config.maxAbsoluteLogPriceMovePerTick!,
      targetInventoryCoverageTicks: config.targetInventoryCoverageTicks!,
      minimumPrice: 0.001,
      maximumPrice: 1_000_000,
    },
  };
  const options: M5AutonomousRegionalTradeOptions = {
    procurement,
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
  return { world, options, source, destination, link, buyerA, sellerA, buyerB, sellerB };
}

function run(f: ReturnType<typeof fixture>) {
  return executeM5AutonomousRegionalTradeTick(
    f.world, 7, households, (_phase, world) => world, f.options,
  );
}

function totalIron(world: WorldState): number {
  return [...world.productionUnits.values()].reduce(
    (total, unit) => total +
      (unit.inputInventory.get(IRON) ?? 0) +
      (unit.outputInventory.get(IRON) ?? 0) +
      (unit.investmentInventory.get(IRON) ?? 0),
    0,
  ) + [...(world.shipments?.values() ?? [])].reduce(
    (total, shipment) => total + (shipment.goodId === IRON ? shipment.quantity : 0), 0,
  );
}

describe("M5/#673 autonomous regional Phase-2/4/6 -> Phase-7 FX dispatch", () => {
  it("executes paid local procurement and a real tariff/tax/FX shipment from the same tick", () => {
    const f = fixture();
    const result = run(f);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.context.phase4MarketAllocations?.length).toBe(2);
    expect(result.context.transactions.filter(tx => tx.phase === 4 && tx.type === "MARKET_SALE"))
      .toHaveLength(2);
    expect(result.context.productionMarketIntents?.length).toBeGreaterThan(0);

    const dispatched = result.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH");
    expect(dispatched).toHaveLength(1);
    expect(result.context.transactions.filter(tx => tx.type === "FX_INPUT")).toHaveLength(1);
    expect(result.context.transactions.filter(tx => tx.type === "FX_OUTPUT")).toHaveLength(1);
    const tariffs = result.context.transactions.filter(tx => tx.type === "IMPORT_TARIFF");
    const taxes = result.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "CONSUMPTION_TAX");
    expect(tariffs).toHaveLength(1);
    expect(taxes).toHaveLength(1);
    expect(tariffs[0]!.currencyId).toBe(f.destination.settlementCurrencyId);
    expect(taxes[0]!.currencyId).toBe(f.destination.settlementCurrencyId);
    expect(tariffs[0]!.moneyAmount).toBeGreaterThan(0);
    expect(taxes[0]!.moneyAmount).toBeGreaterThan(0);

    const shipments = [...(result.world.shipments?.values() ?? [])];
    expect(shipments).toHaveLength(1);
    expect(shipments[0]!.quantity).toBeGreaterThan(0);
    expect(result.world.productionUnits.get(f.sellerA.productionUnitId)!.inputInventory.get(IRON))
      .toBeLessThan(500);
    expect(result.world.productionUnits.get(f.buyerB.productionUnitId)!.wallet
      .get(f.destination.settlementCurrencyId)).toBeLessThan(1_000_000);
    expect(totalIron(result.world)).toBeCloseTo(totalIron(f.world), 8);
    expect(f.world.shipments?.size ?? 0).toBe(0);
    expect(f.world.productionUnits.get(f.sellerA.productionUnitId)!.inputInventory.get(IRON))
      .toBe(500);
    expect(run(f).context.transactions).toEqual(result.context.transactions);
    expect(run(f).world.shipments).toEqual(result.world.shipments);
  });

  it("prohibits the route without Phase-1 authorization but retains real local procurement", () => {
    const f = fixture();
    const noRoute = { ...f, options: {
      ...f.options, phase1TradeLawProvider: () => undefined,
    } };
    const result = run(noRoute);
    expect(result.reconciliationErrors).toBeNull();
    expect(result.context.phase4MarketAllocations).toHaveLength(2);
    expect(result.context.transactions.filter(tx => tx.type === "SHIPMENT_DISPATCH"))
      .toHaveLength(0);
    expect(result.world.shipments?.size ?? 0).toBe(0);
    expect(result.context.phase7MainIntents).toBeDefined();
    expect(f.world.productionUnits.get(f.sellerA.productionUnitId)!.inputInventory.get(IRON))
      .toBe(500);
  });

  it("refuses ambiguous issuer-owned FX pools before moving cross-border cargo", () => {
    const f = fixture(true);
    expect(() => run(f)).toThrow(/exactly one live pool/);
    expect(f.world.shipments?.size ?? 0).toBe(0);
    expect(f.world.productionUnits.get(f.sellerA.productionUnitId)!.inputInventory.get(IRON))
      .toBe(500);
  });

  it("delivers a real autonomous FX shipment on its future Phase-1 tick, only once", () => {
    const f = fixture();
    // Force a two-tick physical route: this is the same link used by the
    // actual Phase-7 candidate, tariff, FX and paid dispatch authorities.
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([[f.link.linkId, { ...f.link, travelTicks: 2 }]]),
    };
    const noTransition = (_phase: number, world: WorldState) => world;
    const departed = executeM5AutonomousRegionalTradeTick(
      opening, 7, households, noTransition, f.options,
    );
    expect(departed.reconciliationErrors).toBeNull();
    const cargo = [...(departed.world.shipments?.values() ?? [])];
    expect(cargo).toHaveLength(1);
    const shipment = cargo[0]!;
    expect(shipment.departureTick).toBe(7);
    expect(shipment.arrivalTick).toBe(9);
    expect(shipment.status).toBe("IN_TRANSIT");
    expect(shipment.beneficialOwner).toEqual({
      type: "PRODUCTION_UNIT", productionUnitId: f.buyerB.productionUnitId,
    });
    expect(shipment.destinationInventoryBucket).toBe("INPUT");

    const destinationStock = (world: WorldState) =>
      world.productionUnits.get(f.buyerB.productionUnitId)!.inputInventory.get(IRON) ?? 0;
    const originalGoods = totalIron(opening);
    const stockAtDispatch = destinationStock(departed.world);
    expect(totalIron(departed.world)).toBeCloseTo(originalGoods, 8);

    // New trade can be prohibited by a later Phase-1 law change. That does
    // not cancel beneficial ownership or re-charge the already-paid cargo.
    const noNewCrossBorder = {
      ...f.options, phase1TradeLawProvider: () => undefined,
    };
    const observedPhase2: { tick: number; stock: number }[] = [];
    const observeArrival: PhaseHandler = (world, context, pending) => {
      if (context.phase === 2) {
        observedPhase2.push({ tick: context.tick, stock: destinationStock(world) });
      }
      return households(world, context, pending);
    };
    const enRoute = executeM5AutonomousRegionalTradeTick(
      departed.world, 8, observeArrival, noTransition, noNewCrossBorder,
    );
    expect(enRoute.reconciliationErrors).toBeNull();
    expect(enRoute.world.shipments?.has(shipment.id)).toBe(true);
    expect(enRoute.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
      .toHaveLength(0);
    expect(observedPhase2).toContainEqual({ tick: 8, stock: stockAtDispatch });
    expect(totalIron(enRoute.world)).toBeCloseTo(originalGoods, 8);

    const stockBeforeArrival = destinationStock(enRoute.world);
    const arrived = executeM5AutonomousRegionalTradeTick(
      enRoute.world, 9, observeArrival, noTransition, noNewCrossBorder,
    );
    expect(arrived.phaseTrace).toEqual([...Array(16).keys()]);
    expect(arrived.phaseBoundaryError).toBeUndefined();
    expect(arrived.reconciliationErrors).toBeNull();
    expect(arrived.world.shipments?.has(shipment.id)).toBe(false);
    expect(arrived.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
      .toMatchObject([{
        tick: 9, phase: 1, goodId: IRON, quantity: shipment.quantity,
      }]);
    expect(observedPhase2).toContainEqual({
      tick: 9, stock: stockBeforeArrival + shipment.quantity,
    });
    expect(totalIron(arrived.world)).toBeCloseTo(originalGoods, 8);
    expect(arrived.context.transactions.filter(tx =>
      tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT" ||
      tx.type === "IMPORT_TARIFF" || tx.type === "SHIPMENT_DISPATCH",
    )).toHaveLength(0);
    expect(arrived.context.transactions.find(tx => tx.type === "SHIPMENT_DELIVERY")
      ?.moneyAmount).toBeUndefined();
    expect(departed.world.shipments?.has(shipment.id)).toBe(true);
    expect(enRoute.world.shipments?.has(shipment.id)).toBe(true);
  });

});
