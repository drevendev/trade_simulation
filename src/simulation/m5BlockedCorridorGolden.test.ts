/** #676 / REQ-ACCEPTANCE-006 — independent legal and physical route gates. */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import type { GoodId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import type { PhaseWorldTransitionObserver } from "./statefulTickOrchestrator";
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

function fixture() {
  const { opening: base, options } = createM5PreviewScenario();
  const recipe = base.definitionRegistry.recipes["recipe:tools-craft"]!;
  const workers = [...base.regions.values()].map(region => {
    const worker = [...base.cohorts.values()].find(c =>
      c.seed.regionKey === region.seed.key && c.seed.ageBand === "WORKING")!;
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
  return { opening, options: { ...options,
    planHouseholdNeedsInPhase2: true,
    settleLaborAndProductionInPhase5: true,
    settleMainMarketInPhase8: true,
    realizeHouseholdConsumptionInPhase9: true,
  } };
}

function add(map: Map<string, number>, key: string, value: number) {
  expect(Number.isFinite(value)).toBe(true);
  map.set(key, (map.get(key) ?? 0) + value);
}
function totals(stocks: Iterable<ReadonlyMap<string, number>>) {
  const map = new Map<string, number>();
  for (const stock of stocks) for (const [key, quantity] of stock) {
    expect(quantity).toBeGreaterThanOrEqual(0);
    add(map, key, quantity);
  }
  return map;
}
function cash(world: WorldState) {
  return totals([
    ...[...world.productionUnits.values()].map(u => u.wallet),
    ...[...world.cohorts.values()].map(c => c.wallet),
    ...[...world.states.values()].map(s => s.treasury),
    ...[...world.clans.values()].map(c => c.treasury),
    ...[...world.monetaryAuthorities.values()].flatMap(a => [...a.fxPools.values()].map(p => p.cash)),
  ]);
}
function goods(world: WorldState) {
  const result = totals([
    ...[...world.productionUnits.values()].flatMap(u => [u.inputInventory, u.outputInventory, u.investmentInventory]),
    ...[...world.cohorts.values()].map(c => c.householdInventory),
    ...[...world.states.values()].map(s => s.publicInventory),
  ]);
  for (const cargo of world.shipments?.values() ?? []) add(result, cargo.goodId, cargo.quantity);
  return result;
}
function reconcile(expected: ReadonlyMap<string, number>, actual: ReadonlyMap<string, number>) {
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    expect(actual.get(key) ?? 0, key).toBeCloseTo(expected.get(key) ?? 0, 6);
  }
}
function reorder(world: WorldState): WorldState {
  const rev = <K, V>(map: ReadonlyMap<K, V>) => new Map([...map].reverse());
  return { ...world, regions: rev(world.regions), states: rev(world.states),
    productionUnits: rev(world.productionUnits), cohorts: rev(world.cohorts),
    markets: rev(world.markets), currencies: rev(world.currencies),
    monetaryAuthorities: rev(world.monetaryAuthorities), clans: rev(world.clans),
    transportLinks: rev(world.transportLinks) };
}

describe("M5 blocked corridor acceptance", () => {
  it.each(["closed-border", "zero-capacity"] as const)(
    "%s halts cross-border settlement without stopping local paid trade", restriction => {
      const { opening, options } = fixture();
      expect(opening.transportLinks.size).toBe(1);
      const link = [...opening.transportLinks.values()][0]!;
      const source = opening.regions.get(link.fromRegionId)!;
      const destination = opening.regions.get(link.toRegionId)!;
      expect(source.controllerStateId).not.toBe(destination.controllerStateId);
      expect(source.settlementCurrencyId).not.toBe(destination.settlementCurrencyId);
      expect(link.seed.baseCapacity * link.seed.condition).toBeGreaterThan(0);
      expect(options.infrastructureFactors.get(link.linkId)).toBe(1);
      const restricted = restriction === "closed-border"
        ? { ...options, phase1TradeLawProvider: () => undefined }
        : { ...options, infrastructureFactors: new Map([[link.linkId, 0]]) };
      const run = (world: WorldState, tick: number, blocked: boolean,
        observer?: PhaseWorldTransitionObserver) => executeM5AutonomousRegionalTradeTick(
          world, tick, phase1, (_phase, current) => current,
          blocked ? restricted : options, observer,
        );

      // The unchanged, funded route must actually produce a paid shipment.
      const control = run(opening, M5_PREVIEW_TICK, false);
      expect(control.phaseBoundaryError).toBeUndefined();
      expect(control.reconciliationErrors).toBeNull();
      expect(control.context.phase7DispatchedShipments!.length).toBeGreaterThan(0);
      expect(control.context.transactions.some(tx =>
        tx.phase === 7 && tx.type === "FX_OUTPUT" && (tx.moneyAmount ?? 0) > 0)).toBe(true);

      const localActors = new Set([
        ...[...opening.productionUnits.values()].filter(u => u.seed.regionKey === source.seed.key)
          .map(u => actorRefKey({ type: "PRODUCTION_UNIT", productionUnitId: u.productionUnitId })),
        ...[...opening.cohorts.values()].filter(c => c.seed.regionKey === source.seed.key)
          .map(c => actorRefKey({ type: "COHORT", cohortId: c.cohortId })),
      ]);
      const expectedCash = cash(opening);
      const expectedGoods = goods(opening);
      let world = opening;
      let replayWorld = reorder(opening);
      let localPaidTicks = 0;
      let observedPhase7 = 0;
      for (let offset = 0; offset < WINDOW; offset++) {
        const number = M5_PREVIEW_TICK + offset;
        const actual = run(world, number, true, (phase, before, after, context) => {
          if (phase !== 7) return;
          observedPhase7++;
          expect(context.phase7DispatchedShipments).toEqual([]);
          expect(context.transactions.filter(tx => tx.phase === 7)).toEqual([]);
          // No paid or unpaid dispatch, stock debit, reserve debit or actor payment.
          expect(after.productionUnits).toEqual(before.productionUnits);
          expect(after.cohorts).toEqual(before.cohorts);
          expect(after.states).toEqual(before.states);
          expect(after.clans).toEqual(before.clans);
          expect(after.monetaryAuthorities).toEqual(before.monetaryAuthorities);
          expect(after.shipments).toEqual(before.shipments);
        });
        const replay = run(replayWorld, number, true);
        for (const result of [actual, replay]) {
          expect(result.phaseTrace).toEqual([...Array(16).keys()]);
          expect(result.phaseBoundaryError).toBeUndefined();
          expect(result.reconciliationErrors).toBeNull();
          expect(result.world.shipments?.size ?? 0).toBe(0);
        }
        expect(replay.context.transactions).toEqual(actual.context.transactions);
        expect(replay.world).toEqual(actual.world);
        for (const item of actual.context.productionExecutions!) {
          for (const [id, quantity] of Object.entries(item.inputConsumedByGood)) {
            add(expectedGoods, id, -quantity);
          }
          add(expectedGoods, item.outputGoodId, item.outputProducedQuantity);
        }
        for (const item of actual.context.householdConsumptionExecutions!) {
          for (const flows of [item.consumedByGood, item.spoiledByGood]) {
            for (const [id, quantity] of Object.entries(flows)) add(expectedGoods, id, -quantity);
          }
        }
        if (actual.context.transactions.some(tx => tx.phase === 8 && tx.goodId === IRON &&
            (tx.moneyAmount ?? 0) > 0 && tx.source && tx.destination &&
            localActors.has(actorRefKey(tx.source)) && localActors.has(actorRefKey(tx.destination)))) {
          localPaidTicks++;
        }
        reconcile(expectedCash, cash(actual.world));
        reconcile(expectedGoods, goods(actual.world));
        world = actual.world;
        replayWorld = reorder(replay.world);
      }
      expect(observedPhase7).toBe(WINDOW);
      expect(localPaidTicks, "real local iron sales in the affected source").toBeGreaterThan(0);
    }, 120_000,
  );
});
