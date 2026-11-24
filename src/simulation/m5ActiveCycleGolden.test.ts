/**
 * #676 / REQ-ACCEPTANCE-006: active production/consumption/trade replay.
 * Unlike the passive 600-tick fixture, this short window opts in to the
 * canonical M4 labor, physical production and household realization owners.
 * No synthetic orders, stock replenishment or wage forecasts during the run.
 */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import type { CurrencyId, GoodId } from "../domain/id";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import type { WorldState } from "./worldState";

const IRON = "good:iron" as GoodId;
const WOOD = "good:wood" as GoodId;
const WINDOW = 12;
const phase1: PhaseHandler = (world, context) => context.phase === 1 ? {
  ...context,
  effectiveJurisdictionByRegion: new Map([...world.regions].map(
    ([id, region]) => [id, region.controllerStateId] as const,
  )),
} : context;

function add<K>(totals: Map<K, number>, key: K, delta: number): void {
  expect(Number.isFinite(delta)).toBe(true);
  totals.set(key, (totals.get(key) ?? 0) + delta);
}

function readStocks<K>(stocks: Iterable<ReadonlyMap<K, number>>): Map<K, number> {
  const totals = new Map<K, number>();
  for (const stock of stocks) for (const [key, quantity] of stock) {
    expect(quantity, "nonnegative stock " + String(key)).toBeGreaterThanOrEqual(0);
    add(totals, key, quantity);
  }
  return totals;
}

function goods(world: WorldState): Map<GoodId, number> {
  const totals = readStocks([
    ...[...world.productionUnits.values()].flatMap(unit =>
      [unit.inputInventory, unit.outputInventory, unit.investmentInventory]),
    ...[...world.states.values()].map(state => state.publicInventory),
    ...[...world.cohorts.values()].map(cohort => cohort.householdInventory),
  ]);
  for (const cargo of world.shipments?.values() ?? []) {
    expect(cargo.quantity).toBeGreaterThanOrEqual(0);
    add(totals, cargo.goodId, cargo.quantity);
  }
  return totals;
}

function cash(world: WorldState): Map<CurrencyId, number> {
  return readStocks([
    ...[...world.productionUnits.values()].map(unit => unit.wallet),
    ...[...world.states.values()].map(state => state.treasury),
    ...[...world.clans.values()].map(clan => clan.treasury),
    ...[...world.cohorts.values()].map(cohort => cohort.wallet),
    ...[...world.monetaryAuthorities.values()].flatMap(authority =>
      [...authority.fxPools.values()].map(pool => pool.cash)),
  ]);
}

function reconcile<K>(expected: ReadonlyMap<K, number>, actual: ReadonlyMap<K, number>,
  label: string): void {
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    expect(actual.get(key) ?? 0, label + " " + String(key))
      .toBeCloseTo(expected.get(key) ?? 0, 6);
  }
}

/** Reverse both registries and nested economic stores without changing values. */
function reversedRegistries(world: WorldState): WorldState {
  const rev = <K, V>(map: ReadonlyMap<K, V>): Map<K, V> => new Map([...map].reverse());
  return {
    ...world,
    regions: new Map([...world.regions].reverse().map(([id, region]) =>
      [id, { ...region, resourceDeposits: rev(region.resourceDeposits) }] as const)),
    states: new Map([...world.states].reverse().map(([id, state]) =>
      [id, { ...state, treasury: rev(state.treasury),
        publicInventory: rev(state.publicInventory) }] as const)),
    currencies: rev(world.currencies),
    monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(([id, authority]) =>
      [id, { ...authority, fxPools: new Map([...authority.fxPools].reverse().map(([poolId, pool]) =>
        [poolId, { ...pool, cash: rev(pool.cash) }] as const)) }] as const)),
    clans: new Map([...world.clans].reverse().map(([id, clan]) =>
      [id, { ...clan, treasury: rev(clan.treasury) }] as const)),
    cohorts: new Map([...world.cohorts].reverse().map(([id, cohort]) =>
      [id, { ...cohort, wallet: rev(cohort.wallet),
        householdInventory: rev(cohort.householdInventory) }] as const)),
    productionUnits: new Map([...world.productionUnits].reverse().map(([id, unit]) =>
      [id, { ...unit, wallet: rev(unit.wallet),
        inputInventory: rev(unit.inputInventory),
        outputInventory: rev(unit.outputInventory),
        investmentInventory: rev(unit.investmentInventory) }] as const)),
    markets: new Map([...world.markets].reverse().map(([id, market]) =>
      [id, { ...market, priceByGood: rev(market.priceByGood),
        expectationsByGood: rev(market.expectationsByGood) }] as const)),
    transportLinks: rev(world.transportLinks),
    ...(world.shipments ? { shipments: rev(world.shipments) } : {}),
    ...(world.outgoingTransportLinkIdsByRegion
      ? { outgoingTransportLinkIdsByRegion: rev(world.outgoingTransportLinkIdsByRegion) } : {}),
  };
}

function activeFixture() {
  const { opening: base, options } = createM5PreviewScenario();
  const recipe = base.definitionRegistry.recipes["recipe:tools-craft"]!;
  const workers = [...base.regions.values()].map(region => {
    const worker = [...base.cohorts.values()].find(cohort =>
      cohort.seed.regionKey === region.seed.key && cohort.seed.ageBand === "WORKING")!;
    expect(worker).toBeDefined();
    return {
      ...worker,
      seed: { ...worker.seed, laborCategory: recipe.laborCategory,
        population: 1000, healthIndex: 1, employmentRateEma: 1 },
      wallet: new Map([[region.settlementCurrencyId, 0]]),
      householdInventory: new Map<GoodId, number>(),
    };
  });
  const need = (id: string, goodId: GoodId, priority: number, target: number):
    NeedCategoryDefinition => ({
      id, perCapitaTarget: target, priority,
      substitutionGoods: [{ goodId, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1, inventoryCarryoverTicks: 0,
    });
  const opening: WorldState = {
    ...base,
    productionUnits: new Map([...base.productionUnits].map(([id, unit]) => [
      id, unit.status === "ACTIVE" ? {
        ...unit, inputInventory: new Map(unit.inputInventory).set(WOOD, 1000),
      } : unit,
    ] as const)),
    cohorts: new Map(workers.map(worker => [worker.cohortId, worker] as const)),
    simulationConfig: { ...base.simulationConfig,
      population: { ...base.simulationConfig.population,
        minHouseholdCashPerCapita: 0, liquidityFloorShare: 0 } },
    definitionRegistry: { ...base.definitionRegistry, needCategories: {
      ESSENTIAL_FOOD: need("ESSENTIAL_FOOD", "good:grain" as GoodId, 4, 0),
      BASIC_GOODS: need("BASIC_GOODS", IRON, 3, 0.01),
      SERVICES: need("SERVICES", "good:tools" as GoodId, 2, 0),
      COMFORT: need("COMFORT", "good:cloth" as GoodId, 1, 0),
    } },
  };
  const tick = (world: WorldState, number: number) =>
    executeM5AutonomousRegionalTradeTick(world, number, phase1, (_phase, current) => current, {
      ...options,
      planHouseholdNeedsInPhase2: true,
      settleLaborAndProductionInPhase5: true,
      settleMainMarketInPhase8: true,
      realizeHouseholdConsumptionInPhase9: true,
    });
  return { opening, tick };
}

describe("M5 #676 active-cycle physical golden", () => {
  it("reconciles actual production, consumption and regional trade over a replayed and registry-reordered 12-tick window", () => {
    const { opening, tick } = activeFixture();
    let world = opening;
    let replay = opening;
    let reordered = reversedRegistries(opening);
    expect(opening.cohorts.size).toBeGreaterThan(1);
    expect([...reordered.cohorts.keys()]).toEqual([...opening.cohorts.keys()].reverse());
    expect([...reordered.cohorts.keys()]).not.toEqual([...opening.cohorts.keys()]);
    const market = [...opening.markets.values()].find(item => item.priceByGood.size > 1)!;
    expect(market).toBeDefined();
    expect([...reordered.markets.get(market.marketId)!.priceByGood.keys()])
      .toEqual([...market.priceByGood.keys()].reverse());
    const issuer = [...opening.monetaryAuthorities.entries()].find(([, authority]) =>
      [...authority.fxPools.values()].some(pool => pool.cash.size > 1))!;
    expect(issuer).toBeDefined();
    const [poolId, pool] = [...issuer[1].fxPools.entries()].find(([, p]) => p.cash.size > 1)!;
    expect([...reordered.monetaryAuthorities.get(issuer[0])!.fxPools.get(poolId)!.cash.keys()])
      .toEqual([...pool.cash.keys()].reverse());
    const expectedCash = cash(opening);
    const expectedGoods = goods(opening);
    let productiveTicks = 0;
    let consumptionTicks = 0;
    let dispatchTicks = 0;
    let deliveryTicks = 0;
    let omittedOutputRejected = false;
    let omittedConsumptionRejected = false;

    for (let offset = 0; offset < WINDOW; offset += 1) {
      const number = M5_PREVIEW_TICK + offset;
      const a = tick(world, number);
      const b = tick(replay, number);
      // Reorder the carried state too, including shipments created after genesis.
      const c = tick(reordered, number);
      for (const result of [a, b, c]) {
        expect(result.phaseTrace).toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
      }
      expect(b.context.transactions).toEqual(a.context.transactions);
      expect(b.world).toEqual(a.world);
      expect(c.context.transactions, "reordered journal at tick " + number)
        .toEqual(a.context.transactions);
      expect(c.world, "reordered world at tick " + number).toEqual(a.world);

      // Use realized physical flows, not stock differences or the engine's
      // own reconciliation result, to carry the expected per-good balance.
      const production = a.context.productionExecutions!;
      const consumption = a.context.householdConsumptionExecutions!;
      expect(Array.isArray(production)).toBe(true);
      expect(Array.isArray(consumption)).toBe(true);
      for (const item of production) {
        for (const [goodId, quantity] of Object.entries(item.inputConsumedByGood)) {
          add(expectedGoods, goodId as GoodId, -quantity);
        }
        add(expectedGoods, item.outputGoodId, item.outputProducedQuantity);
      }
      for (const item of consumption) {
        for (const flows of [item.consumedByGood, item.spoiledByGood]) {
          for (const [goodId, quantity] of Object.entries(flows)) {
            add(expectedGoods, goodId as GoodId, -quantity);
          }
        }
      }
      for (const tx of a.context.transactions) {
        if (tx.type !== "GOODS_TRANSPORT_LOSS") continue;
        expect(tx.goodId).toBeDefined();
        expect(tx.quantity).toBeGreaterThanOrEqual(0);
        add(expectedGoods, tx.goodId!, -tx.quantity!);
      }
      const actual = goods(a.world);
      reconcile(expectedGoods, actual, "physical tick " + number);
      reconcile(expectedGoods, goods(b.world), "replay physical tick " + number);
      reconcile(expectedCash, cash(a.world), "currency tick " + number);
      reconcile(expectedCash, cash(b.world), "replay currency tick " + number);
      reconcile(expectedGoods, goods(c.world), "reordered physical tick " + number);
      reconcile(expectedCash, cash(c.world), "reordered currency tick " + number);

      const output = production.find(item => item.outputProducedQuantity > 0);
      if (output) {
        productiveTicks++;
        if (!omittedOutputRejected) {
          const forged = new Map(expectedGoods);
          add(forged, output.outputGoodId, -output.outputProducedQuantity);
          expect(() => reconcile(forged, actual, "omitted real output")).toThrow();
          omittedOutputRejected = true;
        }
      }
      const consumed = consumption.reduce((sum, item) =>
        sum + (item.consumedByGood[IRON] ?? 0), 0);
      if (consumed > 0) {
        consumptionTicks++;
        if (!omittedConsumptionRejected) {
          const forged = new Map(expectedGoods);
          add(forged, IRON, consumed);
          expect(() => reconcile(forged, actual, "omitted real consumption")).toThrow();
          omittedConsumptionRejected = true;
        }
      }
      const journal = a.context.transactions;
      if (journal.some(tx => tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH")) {
        expect(journal.some(tx => tx.phase === 7 && tx.type === "FX_OUTPUT")).toBe(true);
        dispatchTicks++;
      }
      if (journal.some(tx => tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY")) {
        deliveryTicks++;
      }
      world = a.world;
      replay = b.world;
      reordered = reversedRegistries(c.world);
    }
    // A dormant fixture cannot pass simply by replaying a static balance.
    expect(productiveTicks).toBeGreaterThanOrEqual(3);
    expect(consumptionTicks).toBeGreaterThanOrEqual(3);
    expect(dispatchTicks).toBeGreaterThanOrEqual(2);
    expect(deliveryTicks).toBeGreaterThan(0);
    expect(omittedOutputRejected).toBe(true);
    expect(omittedConsumptionRejected).toBe(true);
  }, 120_000);
});
