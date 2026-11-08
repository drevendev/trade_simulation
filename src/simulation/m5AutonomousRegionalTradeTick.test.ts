import { describe, expect, it } from "vitest";
import { createMarketIntentId } from "./marketIntent";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import { createPhase2LaborSupplyPlanningHandler } from "./laborSupplyPlanning";
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
    // FX reserves are separately owned money stocks. The two Phase-7 legs
    // must fund their exact reserve deltas; arrival never settles FX again.
    const fxPoolCash = (world: WorldState, currencyId: string) =>
      [...world.monetaryAuthorities.values()].reduce(
        (total, authority) => total + [...authority.fxPools.values()].reduce(
          (sum, pool) => sum + [...pool.cash].reduce(
            (cash, [currency, amount]) => cash + (currency === currencyId ? amount : 0), 0,
          ), 0,
        ), 0,
      );
    const fxInputs = departed.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_INPUT");
    const fxOutputs = departed.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT");
    expect(fxInputs).toHaveLength(1);
    expect(fxOutputs).toHaveLength(1);
    const fxInput = fxInputs[0]!;
    const fxOutput = fxOutputs[0]!;
    expect(Number.isFinite(fxInput.moneyAmount)).toBe(true);
    expect(Number.isFinite(fxOutput.moneyAmount)).toBe(true);
    expect(fxInput.moneyAmount).toBeGreaterThan(0);
    expect(fxOutput.moneyAmount).toBeGreaterThan(0);
    expect(fxInput.currencyId).not.toBe(fxOutput.currencyId);
    expect(fxPoolCash(departed.world, fxInput.currencyId!) -
      fxPoolCash(opening, fxInput.currencyId!)).toBeCloseTo(fxInput.moneyAmount!, 8);
    expect(fxPoolCash(departed.world, fxOutput.currencyId!) -
      fxPoolCash(opening, fxOutput.currencyId!)).toBeCloseTo(-fxOutput.moneyAmount!, 8);
    const paidInputReserve = fxPoolCash(departed.world, fxInput.currencyId!);
    const paidOutputReserve = fxPoolCash(departed.world, fxOutput.currencyId!);
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
    // Transit may not re-dispatch cargo, settle FX or collect the tariff again.
    expect(enRoute.context.transactions.filter(tx =>
      tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT" ||
      tx.type === "IMPORT_TARIFF" || tx.type === "SHIPMENT_DISPATCH",
    )).toHaveLength(0);
    expect(observedPhase2).toContainEqual({ tick: 8, stock: stockAtDispatch });
    expect(totalIron(enRoute.world)).toBeCloseTo(originalGoods, 8);
    expect(fxPoolCash(enRoute.world, fxInput.currencyId!)).toBeCloseTo(paidInputReserve, 8);
    expect(fxPoolCash(enRoute.world, fxOutput.currencyId!)).toBeCloseTo(paidOutputReserve, 8);

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
    expect(fxPoolCash(arrived.world, fxInput.currencyId!)).toBeCloseTo(paidInputReserve, 8);
    expect(fxPoolCash(arrived.world, fxOutput.currencyId!)).toBeCloseTo(paidOutputReserve, 8);
    expect(arrived.context.transactions.filter(tx =>
      tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT" ||
      tx.type === "IMPORT_TARIFF" || tx.type === "SHIPMENT_DISPATCH",
    )).toHaveLength(0);
    expect(arrived.context.transactions.find(tx => tx.type === "SHIPMENT_DELIVERY")
      ?.moneyAmount).toBeUndefined();
    expect(departed.world.shipments?.has(shipment.id)).toBe(true);
    expect(enRoute.world.shipments?.has(shipment.id)).toBe(true);

    // A further complete tick must not resurrect or re-deliver the cargo,
    // collect the import tariff a second time, or rebalance the FX pool.
    const afterArrival = executeM5AutonomousRegionalTradeTick(
      arrived.world, 10, observeArrival, noTransition, noNewCrossBorder,
    );
    expect(afterArrival.phaseBoundaryError).toBeUndefined();
    expect(afterArrival.reconciliationErrors).toBeNull();
    expect(afterArrival.world.shipments?.has(shipment.id)).toBe(false);
    expect(afterArrival.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY" || tx.type === "FX_INPUT" ||
      tx.type === "FX_OUTPUT" || tx.type === "IMPORT_TARIFF" ||
      tx.type === "SHIPMENT_DISPATCH",
    )).toHaveLength(0);
    expect(observedPhase2).toContainEqual({
      tick: 10, stock: destinationStock(arrived.world),
    });
    expect(totalIron(afterArrival.world)).toBeCloseTo(originalGoods, 8);
    expect(fxPoolCash(afterArrival.world, fxInput.currencyId!))
      .toBeCloseTo(paidInputReserve, 8);
    expect(fxPoolCash(afterArrival.world, fxOutput.currencyId!))
      .toBeCloseTo(paidOutputReserve, 8);
  });

  it("optionally clears real Phase-7 MAIN residuals in Phase 8 exactly once", () => {
    const f = fixture();
    const sourceCohort = [...f.world.cohorts.values()].find(
      cohort => cohort.seed.regionKey === f.source.seed.key,
    );
    expect(sourceCohort).toBeDefined();
    const funded = {
      ...sourceCohort!,
      wallet: new Map(sourceCohort!.wallet).set(f.source.settlementCurrencyId, 100_000),
    };
    const opening: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts).set(funded.cohortId, funded),
    };
    // Real household Phase-2 demand cannot be spent during input-only
    // procurement; its explicit GENERAL inventory must be credited in MAIN.
    const householdWithIronDemand: PhaseHandler = (world, context, pending) => {
      const next = households(world, context, pending);
      if (context.phase !== 2) return next;
      return {
        ...next,
        householdMarketIntents: [{
          id: createMarketIntentId("mi:m5-main-real-household-iron"),
          actor: { type: "COHORT" as const, cohortId: funded.cohortId },
          regionId: f.source.regionId,
          goodId: IRON,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 1,
          maxSpend: 10_000,
          inventoryBucket: "GENERAL" as const,
          sourcePlanId: "plan:m5-main-household",
        }],
      };
    };
    const opts = { ...f.options, settleMainMarketInPhase8: true as const };
    const execute = () => executeM5AutonomousRegionalTradeTick(
      opening, 7, householdWithIronDemand, (_phase, world) => world, opts,
    );
    const result = execute();
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.context.transactions.some(tx => tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH"))
      .toBe(true);
    const localMain = result.context.marketAllocations.filter(
      allocation => allocation.pass === "MAIN" &&
        allocation.buyer.type === "COHORT" &&
        allocation.buyer.cohortId === funded.cohortId,
    );
    expect(localMain).toHaveLength(1);
    expect(localMain[0]!.quantity).toBeGreaterThan(0);
    expect(localMain[0]!.quantity).toBeLessThanOrEqual(1);
    expect(result.context.transactions.filter(tx =>
      tx.phase === 8 && tx.type === "MARKET_SALE")).toHaveLength(localMain.length);
    expect(result.context.transactions.filter(tx =>
      tx.phase === 8 && tx.type === "CONSUMPTION_TAX")).toHaveLength(localMain.length);

    const closingCohort = result.world.cohorts.get(funded.cohortId)!;
    const gained = (closingCohort.householdInventory.get(IRON) ?? 0) -
      (funded.householdInventory.get(IRON) ?? 0);
    expect(gained).toBeCloseTo(localMain[0]!.quantity, 8);
    expect(closingCohort.wallet.get(f.source.settlementCurrencyId))
      .toBeLessThan(funded.wallet.get(f.source.settlementCurrencyId)!);
    const totalWithHouseholdIron = (world: WorldState) =>
      totalIron(world) + [...world.cohorts.values()].reduce(
        (sum, cohort) => sum + (cohort.householdInventory.get(IRON) ?? 0), 0,
      );
    expect(totalWithHouseholdIron(result.world)).toBeCloseTo(totalWithHouseholdIron(opening), 8);
    expect(opening.cohorts.get(funded.cohortId)!.householdInventory)
      .toEqual(funded.householdInventory);
    expect(execute().context.transactions).toEqual(result.context.transactions);
    expect(execute().world.cohorts).toEqual(result.world.cohorts);

    // Without opt-in, the existing upstream-owned Phase-8 path remains inert.
    const legacy = executeM5AutonomousRegionalTradeTick(
      opening, 7, householdWithIronDemand, (_phase, world) => world, f.options,
    );
    expect(legacy.context.marketAllocations).toHaveLength(0);
    expect(legacy.context.transactions.filter(tx => tx.phase === 8)).toHaveLength(0);
    expect(legacy.world.cohorts.get(funded.cohortId)!.householdInventory)
      .toEqual(funded.householdInventory);
  });

  it("caps two same-cohort Phase-8 purchases against one post-Phase-7 wallet, independent of intent order", () => {
    const f = fixture();
    const cohort = [...f.world.cohorts.values()].find(
      c => c.seed.regionKey === f.source.seed.key,
    )!;
    const startingCash = 20;
    const funded = {
      ...cohort,
      wallet: new Map(cohort.wallet).set(f.source.settlementCurrencyId, startingCash),
    };
    const opening: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts).set(funded.cohortId, funded),
    };
    const buy = (suffix: string) => ({
      id: createMarketIntentId(`mi:m5-phase8-shared-wallet-${suffix}`),
      actor: { type: "COHORT" as const, cohortId: funded.cohortId },
      regionId: f.source.regionId,
      goodId: IRON,
      side: "BUY" as const,
      purpose: "CONSUMPTION" as const,
      desiredQuantity: 1_000,
      // Each intent's Phase-2 forecast is individually affordable only on
      // paper; both together would overdraw the one real post-Phase-7 wallet.
      maxSpend: 1_000_000,
      inventoryBucket: "GENERAL" as const,
      sourcePlanId: `plan:m5-phase8-${suffix}`,
    });
    const intents = [buy("a"), buy("b")];
    const options = {
      ...f.options,
      // Keep the test focused on the Phase-8 post-procurement wallet:
      // no cross-border route is legal at the current Phase-1 snapshot.
      phase1TradeLawProvider: () => undefined,
      settleMainMarketInPhase8: true as const,
    };
    const execute = (reverse: boolean) => {
      const householdDemand: PhaseHandler = (world, context, pending) => {
        const next = households(world, context, pending);
        return context.phase === 2
          ? { ...next, householdMarketIntents: reverse ? [...intents].reverse() : intents }
          : next;
      };
      return executeM5AutonomousRegionalTradeTick(
        opening, 7, householdDemand, (_phase, world) => world, options,
      );
    };
    const result = execute(false);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    const fills = result.context.marketAllocations.filter(
      a => a.pass === "MAIN" && a.buyer.type === "COHORT" &&
        a.buyer.cohortId === funded.cohortId,
    );
    expect(fills.length).toBeGreaterThan(0);
    const quantity = fills.reduce((sum, a) => sum + a.quantity, 0);
    const debit = fills.reduce(
      (sum, a) => sum + a.quantity * a.buyerGrossUnitPrice, 0,
    );
    expect(debit).toBeGreaterThan(0);
    expect(debit).toBeLessThanOrEqual(startingCash + 1e-8);
    const closing = result.world.cohorts.get(funded.cohortId)!;
    expect(closing.wallet.get(f.source.settlementCurrencyId)!).toBeGreaterThanOrEqual(0);
    expect(startingCash - closing.wallet.get(f.source.settlementCurrencyId)!)
      .toBeCloseTo(debit, 8);
    expect(
      (closing.householdInventory.get(IRON) ?? 0) -
      (funded.householdInventory.get(IRON) ?? 0),
    ).toBeCloseTo(quantity, 8);
    expect(result.context.transactions.filter(tx =>
      tx.phase === 8 && tx.type === "MARKET_SALE" &&
      tx.source?.type === "COHORT" && tx.source.cohortId === funded.cohortId,
    )).toHaveLength(fills.length);
    expect(execute(true).context.transactions).toEqual(result.context.transactions);
    expect(execute(true).world.cohorts).toEqual(result.world.cohorts);
    expect(opening.cohorts.get(funded.cohortId)!.wallet.get(f.source.settlementCurrencyId))
      .toBe(startingCash);
  });

  it("releases the sellerless earlier good's shared wallet budget for a later executable good", () => {
    const f = fixture();
    const cohort = [...f.world.cohorts.values()].find(
      c => c.seed.regionKey === f.source.seed.key,
    )!;
    const cash = 20;
    const funded = {
      ...cohort,
      wallet: new Map(cohort.wallet).set(f.source.settlementCurrencyId, cash),
    };
    const opening: WorldState = {
      ...f.world,
      cohorts: new Map(f.world.cohorts).set(funded.cohortId, funded),
    };
    const GRAIN = "good:grain" as GoodId; // Defined in the baseline pack; no source SELL.
    const buy = (suffix: string, goodId: GoodId, desiredQuantity: number) => ({
      id: createMarketIntentId(`mi:m5-phase8-release-${suffix}`),
      actor: { type: "COHORT" as const, cohortId: funded.cohortId },
      regionId: f.source.regionId,
      goodId,
      side: "BUY" as const,
      purpose: "CONSUMPTION" as const,
      desiredQuantity,
      maxSpend: 1_000_000,
      inventoryBucket: "GENERAL" as const,
      sourcePlanId: `plan:m5-phase8-release-${suffix}`,
    });
    // Grain sorts before iron in Phase-8 grouping and has no seller. A
    // pre-clearing reservation of the full wallet for grain starves iron.
    const intents = [buy("a-grain", GRAIN, 10), buy("b-iron", IRON, 5)];
    const opts = {
      ...f.options,
      phase1TradeLawProvider: () => undefined,
      settleMainMarketInPhase8: true as const,
    };
    const execute = (reverse: boolean) => {
      const householdDemand: PhaseHandler = (world, context, pending) => {
        const next = households(world, context, pending);
        return context.phase === 2
          ? { ...next, householdMarketIntents: reverse ? [...intents].reverse() : intents }
          : next;
      };
      return executeM5AutonomousRegionalTradeTick(
        opening, 7, householdDemand, (_phase, world) => world, opts,
      );
    };
    const result = execute(false);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    // Negative control: the no-seller BUY really survived Phase 7. Otherwise
    // the test could pass without exercising unused-budget release at all.
    expect(result.context.phase7MainIntents?.some(intent =>
      intent.side === "BUY" && intent.goodId === GRAIN &&
      intent.actor.type === "COHORT" && intent.actor.cohortId === funded.cohortId,
    )).toBe(true);
    const cohortFills = result.context.marketAllocations.filter(allocation =>
      allocation.pass === "MAIN" && allocation.buyer.type === "COHORT" &&
      allocation.buyer.cohortId === funded.cohortId,
    );
    expect(cohortFills.length).toBeGreaterThan(0);
    expect(cohortFills.every(allocation => allocation.goodId === IRON)).toBe(true);
    const quantity = cohortFills.reduce((sum, allocation) => sum + allocation.quantity, 0);
    const debit = cohortFills.reduce(
      (sum, allocation) => sum + allocation.quantity * allocation.buyerGrossUnitPrice, 0,
    );
    expect(quantity).toBeGreaterThan(0);
    expect(quantity).toBeLessThanOrEqual(5);
    expect(debit).toBeGreaterThan(0);
    expect(debit).toBeLessThanOrEqual(cash + 1e-8);
    const closing = result.world.cohorts.get(funded.cohortId)!;
    expect(cash - closing.wallet.get(f.source.settlementCurrencyId)!)
      .toBeCloseTo(debit, 8);
    expect((closing.householdInventory.get(IRON) ?? 0) -
      (funded.householdInventory.get(IRON) ?? 0)).toBeCloseTo(quantity, 8);
    expect(closing.householdInventory.get(GRAIN) ?? 0)
      .toBe(funded.householdInventory.get(GRAIN) ?? 0);
    expect(execute(true).context.transactions).toEqual(result.context.transactions);
    expect(execute(true).world.cohorts).toEqual(result.world.cohorts);
    expect(opening.cohorts.get(funded.cohortId)!.wallet.get(f.source.settlementCurrencyId))
      .toBe(cash);
  });


  it("optionally consumes already-settled household purchases in Phase 9 exactly once", () => {
    const f = fixture();
    const cohort = [...f.world.cohorts.values()].find(
      item => item.seed.regionKey === f.source.seed.key,
    )!;
    const funded = {
      ...cohort,
      wallet: new Map(cohort.wallet).set(f.source.settlementCurrencyId, 100_000),
      householdInventory: new Map<GoodId, number>(),
    };
    const categories: Readonly<Record<string, NeedCategoryDefinition>> = {
      ESSENTIAL_FOOD: {
        id: "ESSENTIAL_FOOD", perCapitaTarget: 0, priority: 4,
        substitutionGoods: [{ goodId: "good:grain" as GoodId, basePreference: 1, qualityFactor: 1 }],
        priceSensitivity: 1, inventoryCarryoverTicks: 1,
      },
      BASIC_GOODS: {
        id: "BASIC_GOODS", perCapitaTarget: 10, priority: 3,
        // Deliberately synthetic need: the available Phase-8 sale is iron.
        substitutionGoods: [{ goodId: IRON, basePreference: 1, qualityFactor: 1 }],
        priceSensitivity: 1, inventoryCarryoverTicks: 0,
      },
      SERVICES: {
        id: "SERVICES", perCapitaTarget: 0, priority: 2,
        substitutionGoods: [{ goodId: "good:tools" as GoodId, basePreference: 1, qualityFactor: 1 }],
        priceSensitivity: 1, inventoryCarryoverTicks: 0,
      },
      COMFORT: {
        id: "COMFORT", perCapitaTarget: 0, priority: 1,
        substitutionGoods: [{ goodId: "good:cloth" as GoodId, basePreference: 1, qualityFactor: 1 }],
        priceSensitivity: 1, inventoryCarryoverTicks: 0,
      },
    };
    const allowedRegionKeys = new Set([f.source.seed.key, f.destination.seed.key]);
    const opening: WorldState = {
      ...f.world,
      definitionRegistry: { ...f.world.definitionRegistry, needCategories: categories },
      cohorts: new Map([...f.world.cohorts].filter(
        ([, item]) => allowedRegionKeys.has(item.seed.regionKey),
      )).set(funded.cohortId, funded),
    };
    const laborSupply = createPhase2LaborSupplyPlanningHandler();
    const householdDemand: PhaseHandler = (world, context, pending) => {
      const next = laborSupply(world, households(world, context, pending), pending);
      if (context.phase !== 2) return next;
      return {
        ...next,
        householdMarketIntents: [{
          id: createMarketIntentId("mi:m5-phase9-bought-iron"),
          actor: { type: "COHORT" as const, cohortId: funded.cohortId },
          regionId: f.source.regionId,
          goodId: IRON,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 1,
          maxSpend: 10_000,
          inventoryBucket: "GENERAL" as const,
          sourcePlanId: "plan:m5-phase9-bought-iron",
        }],
      };
    };
    const baseOptions = { ...f.options, settleMainMarketInPhase8: true as const };
    const execute = (realize: boolean) => executeM5AutonomousRegionalTradeTick(
      opening, 7, householdDemand, (_phase, world) => world,
      realize ? { ...baseOptions, realizeHouseholdConsumptionInPhase9: true } : baseOptions,
    );
    const result = execute(true);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    const fills = result.context.marketAllocations.filter(
      allocation => allocation.pass === "MAIN" &&
        allocation.buyer.type === "COHORT" && allocation.buyer.cohortId === funded.cohortId,
    );
    expect(fills).toHaveLength(1);
    const boughtIron = fills[0]!.quantity;
    expect(boughtIron).toBeGreaterThan(0);
    const execution = result.context.householdConsumptionExecutions?.find(
      item => item.cohortId === funded.cohortId,
    );
    expect(execution).toBeDefined();
    expect(execution!.postMarketInventoryByGood[IRON]).toBeCloseTo(boughtIron, 8);
    expect(execution!.consumedByGood[IRON]).toBeCloseTo(boughtIron, 8);
    expect(execution!.spoiledByGood[IRON] ?? 0).toBe(0);
    expect(result.world.cohorts.get(funded.cohortId)!.householdInventory.get(IRON) ?? 0).toBe(0);
    expect(result.world.lastHouseholdConsumptionTransitionTick).toBe(7);
    const phase9Losses = result.context.transactions.filter(
      tx => tx.phase === 9 && tx.type === "HOUSEHOLD_CONSUMPTION" &&
        tx.goodId === IRON && tx.source?.type === "COHORT" &&
        tx.source.cohortId === funded.cohortId,
    );
    expect(phase9Losses).toHaveLength(1);
    expect(phase9Losses[0]!.quantity).toBeCloseTo(boughtIron, 8);
    const totalIncludingHouseholds = (world: WorldState) =>
      totalIron(world) + [...world.cohorts.values()].reduce(
        (sum, item) => sum + (item.householdInventory.get(IRON) ?? 0), 0,
      );
    const lostIron = result.context.householdConsumptionExecutions!.reduce(
      (sum, item) => sum + (item.consumedByGood[IRON] ?? 0) + (item.spoiledByGood[IRON] ?? 0),
      0,
    );
    expect(totalIncludingHouseholds(result.world) + lostIron)
      .toBeCloseTo(totalIncludingHouseholds(opening), 8);

    // Negative control: Phase-8 purchases do not disappear unless Phase-9
    // consumption is explicitly enabled; the upstream handler is unchanged.
    const without = execute(false);
    expect(without.context.householdConsumptionExecutions).toBeUndefined();
    expect(without.world.cohorts.get(funded.cohortId)!.householdInventory.get(IRON))
      .toBeCloseTo(boughtIron, 8);
    expect(without.context.transactions.filter(tx => tx.phase === 9)).toHaveLength(0);
    expect(execute(true).context.transactions).toEqual(result.context.transactions);
    expect(execute(true).world.cohorts).toEqual(result.world.cohorts);
    expect(opening.cohorts.get(funded.cohortId)!.householdInventory.size).toBe(0);
  });


  it("plans live household Phase-2 needs without external intents and settles the actual Phase-8 purchase", () => {
    const f = fixture();
    const cohort = [...f.world.cohorts.values()].find(
      item => item.seed.regionKey === f.source.seed.key,
    )!;
    const funded = {
      ...cohort,
      wallet: new Map(cohort.wallet).set(f.source.settlementCurrencyId, 100_000),
      householdInventory: new Map<GoodId, number>(),
    };
    const need = (
      id: string, goodId: GoodId, priority: number, perCapitaTarget: number,
    ): NeedCategoryDefinition => ({
      id, perCapitaTarget, priority,
      substitutionGoods: [{ goodId, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1, inventoryCarryoverTicks: 0,
    });
    const opening: WorldState = {
      ...f.world,
      cohorts: new Map([[funded.cohortId, funded]]),
      definitionRegistry: {
        ...f.world.definitionRegistry,
        needCategories: {
          ESSENTIAL_FOOD: need("ESSENTIAL_FOOD", "good:grain" as GoodId, 4, 0),
          BASIC_GOODS: need("BASIC_GOODS", IRON, 3, 10),
          SERVICES: need("SERVICES", "good:tools" as GoodId, 2, 0),
          COMFORT: need("COMFORT", "good:cloth" as GoodId, 1, 0),
        },
      },
    };
    // Only Phase-1 jurisdiction is upstream-owned. No external household
    // plans or intents may be substituted for the canonical Phase-2 owner.
    const jurisdictionOnly: PhaseHandler = (world, context, pending) =>
      context.phase === 1 ? households(world, context, pending) : context;
    const opts: M5AutonomousRegionalTradeOptions = {
      ...f.options,
      phase1TradeLawProvider: () => undefined,
      planHouseholdNeedsInPhase2: true,
      settleMainMarketInPhase8: true,
    };
    const execute = (upstream: PhaseHandler = jurisdictionOnly) =>
      executeM5AutonomousRegionalTradeTick(
        opening, 7, upstream, (_phase, world) => world, opts,
      );
    const result = execute();
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    const plan = result.context.householdConsumptionPlans?.find(
      item => item.cohortId === funded.cohortId,
    );
    expect(plan).toBeDefined();
    expect(plan!.openingSpendableCash).toBe(100_000);
    expect(plan!.expectedCurrentTickIncome).toBe(0);
    const desires = result.context.householdMarketIntents?.filter(intent =>
      intent.actor.type === "COHORT" && intent.actor.cohortId === funded.cohortId &&
      intent.goodId === IRON && intent.side === "BUY");
    expect(desires?.length).toBe(1);
    expect(desires![0]!.sourcePlanId).toBe(plan!.planId);
    expect(desires![0]!.maxSpend).toBeGreaterThan(0);
    expect(desires![0]!.maxSpend).toBeLessThanOrEqual(plan!.planningCashEnvelope);
    const fills = result.context.marketAllocations.filter(allocation =>
      allocation.pass === "MAIN" && allocation.buyer.type === "COHORT" &&
      allocation.buyer.cohortId === funded.cohortId && allocation.goodId === IRON);
    expect(fills.length).toBeGreaterThan(0);
    const bought = fills.reduce((sum, item) => sum + item.quantity, 0);
    expect(bought).toBeGreaterThan(0);
    expect(result.world.cohorts.get(funded.cohortId)!.householdInventory.get(IRON))
      .toBeCloseTo(bought, 8);
    expect(result.world.cohorts.get(funded.cohortId)!.wallet.get(f.source.settlementCurrencyId))
      .toBeLessThan(100_000);
    expect(execute().context.transactions).toEqual(result.context.transactions);
    expect(execute().world.cohorts).toEqual(result.world.cohorts);
    expect(opening.cohorts.get(funded.cohortId)!.householdInventory.size).toBe(0);

    // Negative control: a second household intent authority must fail closed,
    // including an explicitly empty upstream intent array.
    const duplicate: PhaseHandler = (world, context, pending) => {
      const next = jurisdictionOnly(world, context, pending);
      return context.phase === 2
        ? { ...next, householdMarketIntents: [] }
        : next;
    };
    expect(() => execute(duplicate)).toThrow(
      "M5 canonical household Phase-2 forbids externally supplied household plans/intents",
    );
  });


  it("optionally allocates multi-region labor, pays wages and executes Phase-5 production once", () => {
    const f = fixture();
    const regionKeys = new Set([f.source.seed.key, f.destination.seed.key]);
    const recipe = f.world.definitionRegistry.recipes["recipe:tools-craft"]!;
    const cohorts = new Map([...f.world.cohorts].filter(
      ([, item]) => regionKeys.has(item.seed.regionKey),
    ));
    const working = [...cohorts.values()].find(
      item => item.seed.regionKey === f.source.seed.key && item.seed.ageBand === "WORKING",
    )!;
    expect(working).toBeDefined();
    cohorts.set(working.cohortId, {
      ...working,
      seed: { ...working.seed, laborCategory: recipe.laborCategory,
        population: 1000, healthIndex: 1, employmentRateEma: 1 },
    });
    const opening: WorldState = { ...f.world, cohorts };
    const options: M5AutonomousRegionalTradeOptions = {
      ...f.options, settleLaborAndProductionInPhase5: true,
    };
    const execute = (upstream: PhaseHandler = households, labor = true) =>
      executeM5AutonomousRegionalTradeTick(
        opening, 7, upstream, (_phase, world) => world,
        labor ? options : f.options,
      );
    const result = execute();
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.context.laborSupplyPlans?.length).toBeGreaterThan(0);
    expect(result.context.laborDemandPlans?.length).toBe(opening.productionUnits.size);
    expect(result.context.laborAllocations?.some(a => a.workerEquivalents > 0)).toBe(true);
    expect(result.context.wageSettlements?.some(s => s.grossWage > 0)).toBe(true);
    expect(result.context.productionExecutions?.length).toBe(opening.productionUnits.size);
    expect(result.world.lastWageSettlementTransitionTick).toBe(7);
    expect(result.world.lastProductionExecutionTransitionTick).toBe(7);
    const wages = result.context.transactions.filter(tx => tx.phase === 5 && tx.type === "WAGE_PAYMENT");
    expect(wages.length).toBeGreaterThan(0);
    const totalGross = result.context.wageSettlements!.reduce((sum, w) => sum + w.grossWage, 0);
    const totalNet = result.context.wageSettlements!.reduce((sum, w) => sum + w.netWage, 0);
    const totalCollected = result.context.wageSettlements!.reduce((sum, w) => sum + w.collectedTax, 0);
    expect(totalGross).toBeCloseTo(totalNet + totalCollected, 8);
    expect(execute().context.transactions).toEqual(result.context.transactions);
    expect(execute().world.cohorts).toEqual(result.world.cohorts);
    expect(opening.lastWageSettlementTransitionTick ?? -1).not.toBe(7);

    const legacy = execute(households, false);
    expect(legacy.context.wageSettlements).toBeUndefined();
    expect(legacy.world.lastWageSettlementTransitionTick ?? -1).not.toBe(7);

    // A second Phase-3 allocation authority must be refused before settlement.
    const duplicate: PhaseHandler = (world, context, pending) => {
      const next = households(world, context, pending);
      return context.phase === 3 ? { ...next, laborAllocations: [] } : next;
    };
    expect(() => execute(duplicate)).toThrow(
      "M5 autonomous labor forbids externally supplied Phase-3 labor allocations",
    );
    const duplicatePhase2: PhaseHandler = (world, context, pending) => {
      const next = households(world, context, pending);
      return context.phase === 2 ? { ...next, laborSupplyPlans: [] } : next;
    };
    expect(() => execute(duplicatePhase2)).toThrow(
      "M5 autonomous labor forbids externally supplied Phase-2 labor supply",
    );
    const duplicatePhase5: PhaseHandler = (world, context, pending) => {
      const next = households(world, context, pending);
      return context.phase === 5 ? { ...next, wageSettlements: [] } : next;
    };
    expect(() => execute(duplicatePhase5)).toThrow(
      "M5 autonomous labor forbids externally supplied Phase-5 settlement/production",
    );
  });

  it("composes household Phase-2 demand and regional Phase-3/5 labor on the same tick", () => {
    const f = fixture();
    const recipe = f.world.definitionRegistry.recipes["recipe:tools-craft"]!;
    const regionKeys = new Set([f.source.seed.key, f.destination.seed.key]);
    const cohorts = new Map([...f.world.cohorts].filter(
      ([, item]) => regionKeys.has(item.seed.regionKey),
    ));
    const worker = [...cohorts.values()].find(
      item => item.seed.regionKey === f.source.seed.key && item.seed.ageBand === "WORKING",
    )!;
    expect(worker).toBeDefined();
    const funded = {
      ...worker,
      seed: { ...worker.seed, laborCategory: recipe.laborCategory,
        population: 1000, healthIndex: 1, employmentRateEma: 1 },
      wallet: new Map(worker.wallet).set(f.source.settlementCurrencyId, 100_000),
      householdInventory: new Map<GoodId, number>(),
    };
    cohorts.set(funded.cohortId, funded);
    const need = (id: string, goodId: GoodId, priority: number, target: number):
      NeedCategoryDefinition => ({
        id, perCapitaTarget: target, priority,
        substitutionGoods: [{ goodId, basePreference: 1, qualityFactor: 1 }],
        priceSensitivity: 1, inventoryCarryoverTicks: 0,
      });
    const opening: WorldState = {
      ...f.world,
      cohorts,
      definitionRegistry: { ...f.world.definitionRegistry, needCategories: {
        ESSENTIAL_FOOD: need("ESSENTIAL_FOOD", "good:grain" as GoodId, 4, 0),
        BASIC_GOODS: need("BASIC_GOODS", IRON, 3, 10),
        SERVICES: need("SERVICES", "good:tools" as GoodId, 2, 0),
        COMFORT: need("COMFORT", "good:cloth" as GoodId, 1, 0),
      } },
    };
    const jurisdictionOnly: PhaseHandler = (world, context, pending) =>
      context.phase === 1 ? households(world, context, pending) : context;
    const options: M5AutonomousRegionalTradeOptions = {
      ...f.options,
      phase1TradeLawProvider: () => undefined,
      planHouseholdNeedsInPhase2: true,
      settleLaborAndProductionInPhase5: true,
      settleMainMarketInPhase8: true,
    };
    const execute = () => executeM5AutonomousRegionalTradeTick(
      opening, 7, jurisdictionOnly, (_phase, world) => world, options,
    );
    const result = execute();
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    const plan = result.context.householdConsumptionPlans?.find(
      item => item.cohortId === funded.cohortId,
    );
    expect(plan).toBeDefined();
    expect(result.context.householdMarketIntents?.some(
      intent => intent.actor.type === "COHORT" && intent.actor.cohortId === funded.cohortId &&
        intent.goodId === IRON && intent.side === "BUY",
    )).toBe(true);
    expect(result.context.laborSupplyPlans?.length).toBeGreaterThan(0);
    expect(result.context.laborAllocations?.some(a => a.workerEquivalents > 0)).toBe(true);
    expect(result.context.wageSettlements?.some(w => w.grossWage > 0)).toBe(true);
    expect(result.world.lastWageSettlementTransitionTick).toBe(7);
    expect(result.world.lastProductionExecutionTransitionTick).toBe(7);
    expect(result.context.marketAllocations.some(
      allocation => allocation.pass === "MAIN" &&
        allocation.buyer.type === "COHORT" && allocation.buyer.cohortId === funded.cohortId &&
        allocation.goodId === IRON && allocation.quantity > 0,
    )).toBe(true);
    expect(result.context.transactions.some(
      tx => tx.phase === 5 && tx.type === "WAGE_PAYMENT",
    )).toBe(true);
    expect(execute().context.transactions).toEqual(result.context.transactions);
    expect(execute().world.cohorts).toEqual(result.world.cohorts);
    expect(opening.lastProductionExecutionTransitionTick ?? -1).not.toBe(7);
  });

  it("spends a prior tick's actual wages on the next tick without duplicating money or goods", () => {
    const f = fixture();
    const recipe = f.world.definitionRegistry.recipes["recipe:tools-craft"]!;
    const worker = [...f.world.cohorts.values()].find(
      cohort => cohort.seed.regionKey === f.source.seed.key &&
        cohort.seed.ageBand === "WORKING",
    )!;
    const wageEarner = {
      ...worker,
      seed: { ...worker.seed, laborCategory: recipe.laborCategory,
        population: 1000, healthIndex: 1, employmentRateEma: 1 },
      wallet: new Map([[f.source.settlementCurrencyId, 0]]),
      householdInventory: new Map<GoodId, number>(),
    };
    const need = (id: string, goodId: GoodId, priority: number, target: number):
      NeedCategoryDefinition => ({
        id, perCapitaTarget: target, priority,
        substitutionGoods: [{ goodId, basePreference: 1, qualityFactor: 1 }],
        priceSensitivity: 1, inventoryCarryoverTicks: 0,
      });
    const opening: WorldState = {
      ...f.world,
      // The two-input tool recipe otherwise cannot produce anything: Phase-4
      // buys iron, while wood has no fixture seller. Supply opening wood stock
      // to exercise positive Phase-5 output and its physical input sink.
      productionUnits: new Map(f.world.productionUnits).set(
        f.buyerA.productionUnitId, {
          ...f.buyerA,
          inputInventory: new Map(f.buyerA.inputInventory).set("good:wood" as GoodId, 100),
        },
      ),
      cohorts: new Map([[wageEarner.cohortId, wageEarner]]),
      // Isolate earned-income funding: no precautionary floor in this explicit
      // test scenario, and no credit or same-tick wage forecasts.
      simulationConfig: {
        ...f.world.simulationConfig,
        population: { ...f.world.simulationConfig.population,
          minHouseholdCashPerCapita: 0, liquidityFloorShare: 0 },
      },
      definitionRegistry: { ...f.world.definitionRegistry, needCategories: {
        ESSENTIAL_FOOD: need("ESSENTIAL_FOOD", "good:grain" as GoodId, 4, 0),
        BASIC_GOODS: need("BASIC_GOODS", IRON, 3, 10),
        SERVICES: need("SERVICES", "good:tools" as GoodId, 2, 0),
        COMFORT: need("COMFORT", "good:cloth" as GoodId, 1, 0),
      } },
    };
    const jurisdictionOnly: PhaseHandler = (world, context, pending) =>
      context.phase === 1 ? households(world, context, pending) : context;
    const options: M5AutonomousRegionalTradeOptions = {
      ...f.options,
      phase1TradeLawProvider: () => undefined,
      planHouseholdNeedsInPhase2: true,
      settleLaborAndProductionInPhase5: true,
      settleMainMarketInPhase8: true,
      realizeHouseholdConsumptionInPhase9: true,
    };
    const tick = (world: WorldState, number: number) =>
      executeM5AutonomousRegionalTradeTick(
        world, number, jurisdictionOnly, (_phase, current) => current, options,
      );
    const first = tick(opening, 7);
    expect(first.phaseBoundaryError).toBeUndefined();
    expect(first.reconciliationErrors).toBeNull();
    expect(first.phaseTrace).toEqual([...Array(16).keys()]);
    const plannedFirst = first.context.householdConsumptionPlans!.find(
      plan => plan.cohortId === wageEarner.cohortId,
    )!;
    expect(plannedFirst.openingSpendableCash).toBe(0);
    expect(plannedFirst.expectedCurrentTickIncome).toBe(0);
    expect(plannedFirst.planningCashEnvelope).toBe(0);
    const householdFills = (result: typeof first) =>
      result.context.marketAllocations.filter(allocation =>
        allocation.pass === "MAIN" && allocation.buyer.type === "COHORT" &&
          allocation.buyer.cohortId === wageEarner.cohortId && allocation.goodId === IRON,
      );
    expect(householdFills(first)).toHaveLength(0);
    const netWages = (result: typeof first) =>
      result.context.wageSettlements!.filter(
        item => item.cohortId === wageEarner.cohortId,
      ).reduce((sum, item) => sum + item.netWage, 0);
    expect(netWages(first)).toBeGreaterThan(0);
    expect(first.context.productionExecutions!.some(
      item => item.realizedBatches > 0 && item.outputProducedQuantity > 0,
    )).toBe(true);
    const cashAfterFirst = first.world.cohorts.get(wageEarner.cohortId)!.wallet
      .get(f.source.settlementCurrencyId)!;
    expect(cashAfterFirst).toBeCloseTo(netWages(first), 8);

    const second = tick(first.world, 8);
    expect(second.phaseBoundaryError).toBeUndefined();
    expect(second.reconciliationErrors).toBeNull();
    expect(second.phaseTrace).toEqual([...Array(16).keys()]);
    expect(second.context.householdConsumptionPlans!.find(
      plan => plan.cohortId === wageEarner.cohortId,
    )!.openingSpendableCash).toBeCloseTo(cashAfterFirst, 8);
    const paidFills = householdFills(second);
    expect(paidFills.length).toBeGreaterThan(0);
    const spent = paidFills.reduce(
      (sum, allocation) => sum + allocation.quantity * allocation.buyerGrossUnitPrice, 0,
    );
    expect(spent).toBeGreaterThan(0);
    const cashAfterSecond = second.world.cohorts.get(wageEarner.cohortId)!.wallet
      .get(f.source.settlementCurrencyId)!;
    expect(cashAfterSecond).toBeGreaterThanOrEqual(0);
    expect(cashAfterSecond).toBeCloseTo(cashAfterFirst + netWages(second) - spent, 7);
    const householdLoss = second.context.householdConsumptionExecutions!.reduce(
      (sum, item) => sum + (item.consumedByGood[IRON] ?? 0) +
        (item.spoiledByGood[IRON] ?? 0), 0,
    );
    expect(householdLoss).toBeGreaterThan(0);
    const totalPhysicalIron = (world: WorldState) =>
      totalIron(world) + [...world.cohorts.values()].reduce(
        (sum, item) => sum + (item.householdInventory.get(IRON) ?? 0), 0,
      );
    const industrialInputLoss = second.context.productionExecutions!.reduce(
      (sum, item) => sum + (item.inputConsumedByGood[IRON] ?? 0), 0,
    );
    expect(totalPhysicalIron(second.world) + industrialInputLoss + householdLoss)
      .toBeCloseTo(totalPhysicalIron(first.world), 7);

    // Full two-tick replay produces the same physical state and postings.
    const replayFirst = tick(opening, 7);
    const replaySecond = tick(replayFirst.world, 8);
    expect(replaySecond.context.transactions).toEqual(second.context.transactions);
    expect(replaySecond.world.cohorts).toEqual(second.world.cohorts);
    expect(replaySecond.world.productionUnits).toEqual(second.world.productionUnits);
    expect(replaySecond.world.markets).toEqual(second.world.markets);
    expect(opening.cohorts.get(wageEarner.cohortId)!.wallet
      .get(f.source.settlementCurrencyId)).toBe(0);
  });

  it("settles two independent currency pairs and delivers both paid cargos without recharging", () => {
    const first = fixture();
    const initial = buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
    );
    const gamma = [...initial.regions.values()].find(
      region => region.seed.key === "region:c4-trade",
    )!;
    const delta = [...initial.regions.values()].find(
      region => region.seed.key === "region:d1-capital",
    )!;
    const secondLink = [...initial.transportLinks.values()].find(
      link => link.fromRegionId === gamma.regionId && link.toRegionId === delta.regionId,
    )!;
    expect(secondLink).toBeDefined();

    const templates = [...initial.productionUnits.values()].slice(4, 8);
    expect(templates).toHaveLength(4);
    const unit = (
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
    const additionalUnits = [
      unit(templates[0]!, gamma, "ACTIVE", 1_000_000, 0),
      unit(templates[1]!, gamma, "CLOSING", 5, 500),
      unit(templates[2]!, delta, "ACTIVE", 1_000_000, 0),
      unit(templates[3]!, delta, "CLOSING", 5, 2),
    ];
    const secondMarkets = [...initial.markets].filter(([, market]) =>
      market.seed.regionKey === gamma.seed.key ||
      market.seed.regionKey === delta.seed.key,
    ).map(([id, market]) => [id, {
      ...market,
      priceByGood: new Map(market.priceByGood).set(
        IRON, market.seed.regionKey === gamma.seed.key ? 1 : 100,
      ),
    }] as const);

    // Preserve the existing alpha/beta pool, but choose exactly one live
    // gamma/delta pool: the baseline seeds multiple candidate pools.
    const isSecondPair = (base: string, quote: string) =>
      (base === gamma.settlementCurrencyId && quote === delta.settlementCurrencyId) ||
      (quote === gamma.settlementCurrencyId && base === delta.settlementCurrencyId);
    const possiblePools = [...first.world.monetaryAuthorities.values()].flatMap(
      authority => [...authority.fxPools].filter(([, pool]) =>
        isSecondPair(pool.baseCurrencyId, pool.quoteCurrencyId)).map(([id]) => id),
    );
    expect(possiblePools.length).toBeGreaterThan(1);
    const selectedPool = possiblePools[0]!;
    const monetaryAuthorities = new Map([...first.world.monetaryAuthorities].map(
      ([id, authority]) => [id, {
        ...authority,
        fxPools: new Map([...authority.fxPools].filter(([poolId, pool]) =>
          !isSecondPair(pool.baseCurrencyId, pool.quoteCurrencyId) ||
          poolId === selectedPool,
        )),
      }] as const,
    ));
    const opening: WorldState = {
      ...first.world,
      regions: new Map([...first.world.regions, [gamma.regionId, gamma] as const, [delta.regionId, delta] as const]),
      productionUnits: new Map([
        ...first.world.productionUnits,
        ...additionalUnits.map(item => [item.productionUnitId, item] as const),
      ]),
      markets: new Map([...first.world.markets, ...secondMarkets]),
      transportLinks: new Map([
        [first.link.linkId, { ...first.link, travelTicks: 2 }],
        [secondLink.linkId, { ...secondLink, travelTicks: 2 }],
      ]),
      monetaryAuthorities,
    };
    const currencies = [
      first.source.settlementCurrencyId, first.destination.settlementCurrencyId,
      gamma.settlementCurrencyId, delta.settlementCurrencyId,
    ];
    expect(new Set(currencies).size).toBe(4);
    const cashStocks = (world: WorldState): ReadonlyMap<string, number> => {
      const totals = new Map<string, number>();
      const wallets = [
        ...[...world.states.values()].map(state => state.treasury),
        ...[...world.clans.values()].map(clan => clan.treasury),
        ...[...world.cohorts.values()].map(cohort => cohort.wallet),
        ...[...world.productionUnits.values()].map(item => item.wallet),
        ...[...world.monetaryAuthorities.values()].flatMap(authority =>
          [...authority.fxPools.values()].map(pool => pool.cash)),
      ];
      for (const wallet of wallets) for (const [currency, amount] of wallet) {
        totals.set(currency, (totals.get(currency) ?? 0) + amount);
      }
      return totals;
    };
    const poolStocks = (world: WorldState): ReadonlyMap<string, number> => {
      const totals = new Map<string, number>();
      for (const authority of world.monetaryAuthorities.values()) {
        for (const pool of authority.fxPools.values()) {
          for (const [currency, amount] of pool.cash) {
            totals.set(currency, (totals.get(currency) ?? 0) + amount);
          }
        }
      }
      return totals;
    };
    const openingCash = cashStocks(opening);
    const openingPoolCash = poolStocks(opening);
    const openingIron = totalIron(opening);
    const options: M5AutonomousRegionalTradeOptions = {
      ...first.options,
      infrastructureFactors: new Map([
        [first.link.linkId, 1], [secondLink.linkId, 1],
      ]),
      phase1TradeLawProvider: query =>
        query.goodId === IRON &&
        (query.linkId === first.link.linkId || query.linkId === secondLink.linkId)
          ? null : undefined,
    };
    // Phase-1 delivers cargo before Phase-2 planning and later production
    // may consume input stock. Observe the actual recipient's INPUT inventory
    // at Phase 2 to prove physical credit, not only a global goods total.
    const phase2InputByTick = new Map<number, ReadonlyMap<string, number>>();
    const observeHouseholds: PhaseHandler = (world, context, pending) => {
      if (context.phase === 2) {
        phase2InputByTick.set(context.tick, new Map(
          [first.buyerB.productionUnitId, additionalUnits[2]!.productionUnitId].map(
            id => [id, world.productionUnits.get(id)!.inputInventory.get(IRON) ?? 0] as const,
          ),
        ));
      }
      return households(world, context, pending);
    };
    const tick = (world: WorldState, tickNumber: number, allowTrade: boolean) =>
      executeM5AutonomousRegionalTradeTick(
        world, tickNumber, observeHouseholds, (_phase, current) => current,
        allowTrade ? options : { ...options, phase1TradeLawProvider: () => undefined },
      );
    const assertConserved = (world: WorldState) => {
      expect(totalIron(world)).toBeCloseTo(openingIron, 7);
      const current = cashStocks(world);
      for (const currency of currencies) {
        expect(current.get(currency)).toBeCloseTo(openingCash.get(currency)!, 6);
      }
    };
    const departed = tick(opening, 7, true);
    expect(departed.phaseBoundaryError).toBeUndefined();
    expect(departed.reconciliationErrors).toBeNull();
    expect(departed.phaseTrace).toEqual([...Array(16).keys()]);
    const cargos = [...(departed.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(2);
    expect(new Set(cargos.map(cargo => cargo.transportLinkId))).toEqual(
      new Set([first.link.linkId, secondLink.linkId]),
    );
    expect(cargos.every(cargo => cargo.quantity > 0 && cargo.arrivalTick === 9))
      .toBe(true);
    const dispatchTypes = departed.context.transactions.filter(
      tx => tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH",
    );
    expect(dispatchTypes).toHaveLength(2);
    expect(departed.context.transactions.filter(tx => tx.type === "IMPORT_TARIFF"))
      .toHaveLength(2);
    const fxInputs = departed.context.transactions.filter(
      tx => tx.phase === 7 && tx.type === "FX_INPUT",
    );
    const fxOutputs = departed.context.transactions.filter(
      tx => tx.phase === 7 && tx.type === "FX_OUTPUT",
    );
    expect(fxInputs).toHaveLength(2);
    expect(fxOutputs).toHaveLength(2);
    // Each paid cargo must have its *own* dispatch bundle and FX receipt.
    // Global counts and aggregated pool deltas alone let zero-value legs or
    // both conversions on one route masquerade as two funded settlements.
    const shipmentBundles = new Set<string>();
    const settlementIds = new Set<string>();
    const coveredBuyers = new Set<string>();
    for (const cargo of cargos) {
      expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
      if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
        throw new Error("The test fixture must deliver to a production unit");
      }
      expect(cargo.destinationInventoryBucket).toBe("INPUT");
      coveredBuyers.add(cargo.beneficialOwner.productionUnitId);
      const associated = dispatchTypes.filter(tx =>
        tx.goodId === cargo.goodId &&
        tx.sourceRegionId === cargo.originRegionId &&
        tx.destinationRegionId === cargo.destinationRegionId &&
        tx.quantity === cargo.quantity &&
        JSON.stringify(tx.source) === JSON.stringify(cargo.seller) &&
        JSON.stringify(tx.destination) === JSON.stringify(cargo.beneficialOwner));
      expect(associated).toHaveLength(1);
      const dispatch = associated[0]!;
      expect(dispatch.bundleId).toBeDefined();
      expect(cargo.fxSettlementId).toMatch(/^fxs:/);
      shipmentBundles.add(dispatch.bundleId!);
      settlementIds.add(cargo.fxSettlementId!);
      const inputs = fxInputs.filter(tx =>
        tx.bundleId === dispatch.bundleId && tx.fxSettlementId === cargo.fxSettlementId);
      const outputs = fxOutputs.filter(tx =>
        tx.bundleId === dispatch.bundleId && tx.fxSettlementId === cargo.fxSettlementId);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(1);
      expect(inputs[0]!.currencyId).toBe(cargo.buyerPaymentCurrencyId);
      expect(outputs[0]!.currencyId).toBe(cargo.invoiceCurrencyId);
      expect(inputs[0]!.source).toEqual(cargo.beneficialOwner);
      expect(outputs[0]!.destination).toEqual(cargo.seller);
      for (const leg of [inputs[0]!, outputs[0]!]) {
        expect(Number.isFinite(leg.moneyAmount)).toBe(true);
        expect(leg.moneyAmount).toBeGreaterThan(0);
      }
    }
    expect(shipmentBundles.size).toBe(2);
    expect(settlementIds.size).toBe(2);
    expect(coveredBuyers).toEqual(new Set([
      first.buyerB.productionUnitId, additionalUnits[2]!.productionUnitId,
    ]));
    expect(new Set([...fxInputs, ...fxOutputs].map(tx => tx.currencyId)))
      .toEqual(new Set(currencies));
    const afterDispatchPool = poolStocks(departed.world);
    for (const currency of currencies) {
      const posted = fxInputs.filter(tx => tx.currencyId === currency).reduce(
        (sum, tx) => sum + tx.moneyAmount!, 0,
      ) - fxOutputs.filter(tx => tx.currencyId === currency).reduce(
        (sum, tx) => sum + tx.moneyAmount!, 0,
      );
      expect(afterDispatchPool.get(currency)! - openingPoolCash.get(currency)!)
        .toBeCloseTo(posted, 7);
    }
    assertConserved(departed.world);
    expect(tick(opening, 7, true).context.transactions).toEqual(
      departed.context.transactions,
    );

    // New routes are forbidden after departure. Already-paid independent
    // cargos must arrive once, with no later FX, tax or dispatch legs.
    const forbidden = ["FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF", "SHIPMENT_DISPATCH"];
    let previous = departed.world;
    for (const nextTick of [8, 9, 10]) {
      const result = tick(previous, nextTick, false);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(result.context.transactions.filter(tx => forbidden.includes(tx.type)))
        .toHaveLength(0);
      const arrivals = result.context.transactions.filter(
        tx => tx.type === "SHIPMENT_DELIVERY",
      );
      expect(arrivals).toHaveLength(nextTick === 9 ? 2 : 0);
      expect(result.world.shipments?.size ?? 0).toBe(nextTick < 9 ? 2 : 0);
      if (nextTick === 9) {
        // Match each immutable cargo ID to *its* receipt and beneficiary.
        // A duplicate receipt for one route or two wrong recipients must fail.
        const deliveryIds = new Set<string>();
        for (const cargo of cargos) {
          if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
            throw new Error("The test fixture must deliver to a production unit");
          }
          const receipts = arrivals.filter(tx =>
            tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
          expect(receipts).toHaveLength(1);
          const receipt = receipts[0]!;
          deliveryIds.add(receipt.transactionId);
          expect(receipt.transactionId).toBe("tx:delivery:" + cargo.id);
          expect(receipt.destination).toEqual(cargo.beneficialOwner);
          expect(receipt.sourceRegionId).toBe(cargo.originRegionId);
          expect(receipt.destinationRegionId).toBe(cargo.destinationRegionId);
          expect(receipt.goodId).toBe(IRON);
          expect(receipt.quantity).toBeCloseTo(cargo.quantity, 8);
          const buyerId = cargo.beneficialOwner.productionUnitId;
          const before = previous.productionUnits.get(buyerId)!.inputInventory.get(IRON) ?? 0;
          expect(phase2InputByTick.get(9)?.get(buyerId))
            .toBeCloseTo(before + cargo.quantity, 8);
        }
        expect(deliveryIds.size).toBe(2);
      }
      for (const currency of currencies) {
        expect(poolStocks(result.world).get(currency))
          .toBeCloseTo(afterDispatchPool.get(currency)!, 7);
      }
      assertConserved(result.world);
      previous = result.world;
    }
    expect(opening.shipments?.size ?? 0).toBe(0);
  });


  it("caps scarce issuer-owned FX output and never partially posts an exhausted route", () => {
    const f = fixture();
    const sourceCurrency = f.source.settlementCurrencyId;
    const destinationCurrency = f.destination.settlementCurrencyId;
    const eligible = [...f.world.monetaryAuthorities].flatMap(([authorityId, authority]) =>
      [...authority.fxPools].filter(([, pool]) =>
        (pool.baseCurrencyId === sourceCurrency && pool.quoteCurrencyId === destinationCurrency) ||
        (pool.quoteCurrencyId === sourceCurrency && pool.baseCurrencyId === destinationCurrency),
      ).map(([poolId, pool]) => ({ authorityId, poolId, pool })),
    );
    expect(eligible).toHaveLength(1);
    const selected = eligible[0]!;
    const floor = selected.pool.baseCurrencyId === sourceCurrency
      ? selected.pool.minOperationalReserveBase
      : selected.pool.minOperationalReserveQuote;

    // Preserve every real owner, pair, input reserve and actor wallet. Only
    // reduce the *seller-invoice* output currency in the unique issuer pool.
    const withOutputBudget = (outputBudget: number): WorldState => ({
      ...f.world,
      monetaryAuthorities: new Map([...f.world.monetaryAuthorities].map(([id, authority]) =>
        [id, id === selected.authorityId
          ? {
            ...authority,
            fxPools: new Map(authority.fxPools).set(selected.poolId, {
              ...selected.pool,
              cash: new Map(selected.pool.cash).set(sourceCurrency, floor + outputBudget),
            }),
          }
          : authority] as const,
      )),
    });

    const ordinary = run(f);
    expect(ordinary.reconciliationErrors).toBeNull();
    const ordinaryCargo = [...(ordinary.world.shipments?.values() ?? [])];
    expect(ordinaryCargo).toHaveLength(1);
    const ordinaryOutput = ordinary.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT");
    expect(ordinaryOutput).toHaveLength(1);
    const originallyPaidOutput = ordinaryOutput[0]!.moneyAmount!;
    expect(originallyPaidOutput).toBeGreaterThan(0);

    // A strictly smaller available pool reserve must cause a smaller
    // re-quoted, fully paid physical lot, not the original unfunded cargo.
    const scarceOpening = withOutputBudget(originallyPaidOutput / 4);
    const scarce = run({ ...f, world: scarceOpening });
    expect(scarce.phaseBoundaryError).toBeUndefined();
    expect(scarce.reconciliationErrors).toBeNull();
    expect(scarce.phaseTrace).toEqual([...Array(16).keys()]);
    const scarceCargo = [...(scarce.world.shipments?.values() ?? [])];
    expect(scarceCargo).toHaveLength(1);
    expect(scarceCargo[0]!.quantity).toBeGreaterThan(0);
    expect(scarceCargo[0]!.quantity).toBeLessThan(ordinaryCargo[0]!.quantity);
    const scarceFxInput = scarce.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_INPUT");
    const scarceFxOutput = scarce.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT");
    expect(scarceFxInput).toHaveLength(1);
    expect(scarceFxOutput).toHaveLength(1);
    expect(scarceFxOutput[0]!.moneyAmount).toBeGreaterThan(0);
    expect(scarceFxOutput[0]!.moneyAmount).toBeLessThan(originallyPaidOutput);
    expect(scarceFxOutput[0]!.moneyAmount).toBeCloseTo(
      scarceCargo[0]!.quantity * (
        scarceFxOutput[0]!.moneyAmount! / scarceCargo[0]!.quantity
      ), 8,
    );
    const scarcePool = scarce.world.monetaryAuthorities.get(selected.authorityId)!
      .fxPools.get(selected.poolId)!;
    expect(scarcePool.cash.get(sourceCurrency)!).toBeGreaterThanOrEqual(floor);
    expect(totalIron(scarce.world)).toBeCloseTo(totalIron(scarceOpening), 8);
    expect(run({ ...f, world: scarceOpening }).context.transactions)
      .toEqual(scarce.context.transactions);

    // At the exact reserve floor, no invoice can be funded. Phase-4 local
    // purchases remain live, but Phase-7 must publish zero dispatch, FX,
    // import tariff or tax and must not touch any cross-border ledger owner.
    const exhaustedOpening = withOutputBudget(0);
    const exhausted = run({ ...f, world: exhaustedOpening });
    const legallyClosed = run({
      ...f, world: exhaustedOpening,
      options: { ...f.options, phase1TradeLawProvider: () => undefined },
    });
    expect(exhausted.phaseBoundaryError).toBeUndefined();
    expect(exhausted.reconciliationErrors).toBeNull();
    expect(exhausted.phaseTrace).toEqual([...Array(16).keys()]);
    expect(exhausted.context.phase4MarketAllocations).toHaveLength(2);
    expect(exhausted.context.transactions.filter(tx =>
      tx.phase === 7 && [
        "SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT",
        "IMPORT_TARIFF", "CONSUMPTION_TAX",
      ].includes(tx.type))).toHaveLength(0);
    expect(exhausted.world.shipments?.size ?? 0).toBe(0);
    expect(exhausted.world.productionUnits).toEqual(legallyClosed.world.productionUnits);
    expect(exhausted.world.states).toEqual(legallyClosed.world.states);
    expect(exhausted.world.monetaryAuthorities).toEqual(exhaustedOpening.monetaryAuthorities);
    expect(totalIron(exhausted.world)).toBeCloseTo(totalIron(exhaustedOpening), 8);
    expect(exhaustedOpening.monetaryAuthorities.get(selected.authorityId)!
      .fxPools.get(selected.poolId)!.cash.get(sourceCurrency)).toBe(floor);
    expect(run({ ...f, world: exhaustedOpening }).context.transactions)
      .toEqual(exhausted.context.transactions);
  });

});
