/**
 * M5 / #676: 600 consecutive canonical 16-phase ticks, replayed from the
 * same world. A bounded long-run golden, not all seven M5 acceptance criteria.
 *
 * Check physical iron independently of the engine's journal reconciler:
 * inventories + paid cargo in transit lose mass only on recorded transport loss.
 */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { GoodId } from "../domain/id";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import type { WorldState } from "./worldState";

const IRON = "good:iron" as GoodId;
const TICKS = 600;
const unchanged = (_phase: number, world: WorldState) => world;
const upstream: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return {
      ...context,
      effectiveJurisdictionByRegion: new Map(
        [...world.regions].map(([id, region]) =>
          [id, region.controllerStateId] as const),
      ),
    };
  }
  return context.phase === 2
    ? { ...context, householdMarketIntents: [] }
    : context;
};

/** Read every authoritative physical owner, including goods in transit. */
function physicalIron(world: WorldState): number {
  let total = 0;
  for (const unit of world.productionUnits.values()) {
    total += (unit.inputInventory.get(IRON) ?? 0)
      + (unit.outputInventory.get(IRON) ?? 0)
      + (unit.investmentInventory.get(IRON) ?? 0);
  }
  for (const state of world.states.values()) {
    total += state.publicInventory.get(IRON) ?? 0;
  }
  for (const cohort of world.cohorts.values()) {
    total += cohort.householdInventory.get(IRON) ?? 0;
  }
  for (const cargo of world.shipments?.values() ?? []) {
    if (cargo.goodId === IRON) total += cargo.quantity;
  }
  return total;
}

/**
 * AC-4: independent per-good totals, not just the headline iron stock.
 * This fixture has no Phase-5 production or Phase-9 consumption enabled;
 * Phase-7 recorded transport loss is its only legitimate mass sink.
 */
function physicalGoods(world: WorldState): Map<GoodId, number> {
  const totals = new Map<GoodId, number>();
  const addStock = (stock: ReadonlyMap<GoodId, number>) => {
    for (const [goodId, quantity] of stock) {
      totals.set(goodId, (totals.get(goodId) ?? 0) + quantity);
    }
  };
  for (const unit of world.productionUnits.values()) {
    addStock(unit.inputInventory);
    addStock(unit.outputInventory);
    addStock(unit.investmentInventory);
  }
  for (const state of world.states.values()) addStock(state.publicInventory);
  for (const cohort of world.cohorts.values()) addStock(cohort.householdInventory);
  for (const cargo of world.shipments?.values() ?? []) {
    totals.set(cargo.goodId, (totals.get(cargo.goodId) ?? 0) + cargo.quantity);
  }
  return totals;

}

/** Distinguish individual good losses from a zero-sum cross-good conversion. */
function assertPhysicalGoods(
  expected: ReadonlyMap<GoodId, number>, actual: ReadonlyMap<GoodId, number>,
  label: string,
): void {
  const ids = new Set([...expected.keys(), ...actual.keys()]);
  for (const goodId of ids) {
    expect(actual.get(goodId) ?? 0, "physical " + goodId + " " + label)
      .toBeCloseTo(expected.get(goodId) ?? 0, 6);
  }
}

describe("M5 #676 600-tick real-trade physical replay golden", () => {
  it("reconciles per-tick iron ownership and replays paid FX/delivery deterministically", () => {
    const fixture = createM5PreviewScenario();
    const regions = [...fixture.opening.regions.values()];
    expect(regions).toHaveLength(2);
    expect(regions[0]!.settlementCurrencyId).not.toBe(regions[1]!.settlementCurrencyId);
    expect(fixture.opening.transportLinks.size).toBeGreaterThan(0);
    expect(fixture.opening.shipments?.size ?? 0).toBe(0);

    let original = fixture.opening;
    let replay = fixture.opening;
    let paidFx = 0;
    let dispatched = 0;
    let delivered = 0;
    let recordedLosses = 0;
    let transitWitness = false;
    let expectedIron = physicalIron(original);
    const expectedGoods = physicalGoods(original);
    expect(expectedIron).toBeGreaterThan(0);
    expect(expectedGoods.get(IRON)).toBeCloseTo(expectedIron, 8);

    // Negative control: preserve overall mass while converting real iron into
    // a different, definition-backed good without a corresponding transaction.
    // A total-mass-only oracle would accept the forged world.
    const WOOD = "good:wood" as GoodId;
    const seller = [...original.productionUnits.values()].find(unit =>
      (unit.inputInventory.get(IRON) ?? 0) >= 1);
    expect(seller).toBeDefined();
    const forgedInput = new Map(seller!.inputInventory);
    const shift = 0.25;
    forgedInput.set(IRON, forgedInput.get(IRON)! - shift);
    forgedInput.set(WOOD, (forgedInput.get(WOOD) ?? 0) + shift);
    const forgedWorld: WorldState = {
      ...original,
      productionUnits: new Map(original.productionUnits).set(
        seller!.productionUnitId, { ...seller!, inputInventory: forgedInput },
      ),
    };
    const totalMass = (goods: ReadonlyMap<GoodId, number>) =>
      [...goods.values()].reduce((sum, quantity) => sum + quantity, 0);
    const forgedGoods = physicalGoods(forgedWorld);
    expect(totalMass(forgedGoods)).toBeCloseTo(totalMass(expectedGoods), 8);
    expect(() => assertPhysicalGoods(expectedGoods, forgedGoods, "forged conversion"))
      .toThrow();

    for (let offset = 0; offset < TICKS; offset += 1) {
      const tick = M5_PREVIEW_TICK + offset;
      const a = executeM5AutonomousRegionalTradeTick(
        original, tick, upstream, unchanged, fixture.options,
      );
      const b = executeM5AutonomousRegionalTradeTick(
        replay, tick, upstream, unchanged, fixture.options,
      );
      for (const result of [a, b]) {
        expect(result.phaseTrace, "phase order at tick " + tick)
          .toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError, "phase boundary at tick " + tick)
          .toBeUndefined();
        expect(result.reconciliationErrors, "ledger close at tick " + tick)
          .toBeNull();
      }
      expect(b.context.transactions, "journal replay at tick " + tick)
        .toEqual(a.context.transactions);
      expect(b.world, "world replay at tick " + tick).toEqual(a.world);

      const journal = a.context.transactions;
      const loss = journal.filter(tx =>
        tx.type === "GOODS_TRANSPORT_LOSS" && tx.goodId === IRON
      ).reduce((sum, tx) => sum + (tx.quantity ?? 0), 0);
      expect(loss, "nonnegative real attrition at tick " + tick)
        .toBeGreaterThanOrEqual(0);
      expectedIron -= loss;
      expect(physicalIron(a.world), "goods owner conservation at tick " + tick)
        .toBeCloseTo(expectedIron, 6);
      expect(physicalIron(b.world), "replay goods at tick " + tick)
        .toBeCloseTo(expectedIron, 6);

      // Reconcile every physical good independently. An unrecorded conversion
      // from one good into another can leave total mass unchanged; the
      // single-iron oracle alone would not catch an unrelated good's loss.
      for (const tx of journal) {
        if (tx.type !== "GOODS_TRANSPORT_LOSS") continue;
        expect(tx.goodId, "loss good at tick " + tick).toBeDefined();
        expect(tx.quantity, "loss quantity at tick " + tick).toBeGreaterThanOrEqual(0);
        const goodId = tx.goodId!;
        expectedGoods.set(goodId, (expectedGoods.get(goodId) ?? 0) - tx.quantity!);
      }
      const actualGoods = physicalGoods(a.world);
      const replayGoods = physicalGoods(b.world);
      assertPhysicalGoods(expectedGoods, actualGoods, "at tick " + tick);
      assertPhysicalGoods(expectedGoods, replayGoods, "replay at tick " + tick);

      paidFx += journal.filter(tx => tx.phase === 7 && tx.type === "FX_OUTPUT").length;
      dispatched += journal.filter(tx => tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH").length;
      delivered += journal.filter(tx => tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY").length;
      recordedLosses += loss;

      if (!transitWitness && (a.world.shipments?.size ?? 0) > 0) {
        const first = [...a.world.shipments!.keys()][0]!;
        const missingCargo = {
          ...a.world,
          shipments: new Map(a.world.shipments),
        };
        missingCargo.shipments.delete(first);
        expect(physicalIron(missingCargo))
          .toBeLessThan(physicalIron(a.world));
        expect(physicalIron(missingCargo))
          .not.toBeCloseTo(expectedIron, 6);
        transitWitness = true;
      }
      original = a.world;
      replay = b.world;
    }

    // A long-running no-trade fixture would make the replay oracle vacuous.
    expect(paidFx).toBeGreaterThan(0);
    expect(dispatched).toBeGreaterThan(0);
    expect(delivered).toBeGreaterThan(0);
    expect(transitWitness).toBe(true);
    expect(recordedLosses).toBeGreaterThanOrEqual(0);
    expect(original).toEqual(replay);
  }, 120_000);
});
