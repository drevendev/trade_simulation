/**
 * Issue #676 / M5 acceptance: actual paid FX dispatch followed by delayed
 * physical delivery and routine transport attrition through the canonical
 * 16-phase runner. No synthetic shipment, invoice, or delivery is inserted.
 * This is one focused regression, not a complete 600-tick gate.
 */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { GoodId } from "../domain/id";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";
import type { WorldState } from "./worldState";

const IRON = "good:iron" as GoodId;
const unchanged = (_phase: number, world: WorldState) => world;

const upstream: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return { ...context, effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
    ) };
  }
  return context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
};

/** Stocks, including the shipment as the one authoritative transit owner. */
function allIron(world: WorldState): number {
  let total = 0;
  for (const unit of world.productionUnits.values()) {
    total += (unit.inputInventory.get(IRON) ?? 0) +
      (unit.outputInventory.get(IRON) ?? 0) +
      (unit.investmentInventory.get(IRON) ?? 0);
  }
  for (const state of world.states.values()) total += state.publicInventory.get(IRON) ?? 0;
  for (const cohort of world.cohorts.values()) total += cohort.householdInventory.get(IRON) ?? 0;
  for (const shipment of world.shipments.values()) {
    if (shipment.goodId === IRON) total += shipment.quantity;
  }
  return total;
}

/** The owner/bucket oracle is independent of the engine's delivery receipt. */
function assertActualArrival(
  before: WorldState, after: WorldState, cargo: TradeShipmentState,
): void {
  if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT" ||
      cargo.destinationInventoryBucket !== "INPUT") {
    throw new Error("Fixture requires a real ProductionUnit INPUT buyer");
  }
  const recipient = cargo.beneficialOwner.productionUnitId;
  for (const [id, unit] of before.productionUnits) {
    const next = after.productionUnits.get(id)!;
    const observed = (next.inputInventory.get(cargo.goodId) ?? 0) -
      (unit.inputInventory.get(cargo.goodId) ?? 0);
    expect(observed, "Phase-1 stock credit for " + id)
      .toBeCloseTo(id === recipient ? cargo.quantity : 0, 8);
  }
}

describe("M5 #676 real paid FX shipment with delayed physical loss", () => {
  it("destroys cargo once at dispatch, retains surviving ownership, and credits only its buyer on arrival", () => {
    const f = createM5PreviewScenario();
    const links = [...f.opening.transportLinks];
    expect(links).toHaveLength(1);
    const [linkId, link] = links[0]!;
    const opening: WorldState = {
      ...f.opening,
      transportLinks: new Map([[linkId, {
        ...link, travelTicks: 2,
        seed: { ...link.seed, routinePhysicalLossRate: 0.25 },
      }]]),
    };
    let beforeDispatch: WorldState | undefined;
    let afterDispatch: WorldState | undefined;
    const run = (
      world: WorldState, tick: number,
      options = f.options,
      observe?: (phase: number, before: WorldState, after: WorldState) => void,
    ) => executeM5AutonomousRegionalTradeTick(
      world, tick, upstream, unchanged, options, observe,
    );

    const departed = run(opening, M5_PREVIEW_TICK, f.options, (phase, before, after) => {
      if (phase === 7) { beforeDispatch = before; afterDispatch = after; }
    });
    const replay = run(opening, M5_PREVIEW_TICK);
    for (const result of [departed, replay]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
    }
    expect(departed.context.transactions).toEqual(replay.context.transactions);
    expect(departed.world.shipments).toEqual(replay.world.shipments);
    expect(beforeDispatch).toBeDefined();
    expect(afterDispatch).toBeDefined();

    const cargoList = [...departed.world.shipments.values()];
    expect(cargoList).toHaveLength(1);
    const cargo = cargoList[0]!;
    expect(cargo.goodId).toBe(IRON);
    expect(cargo.departureTick).toBe(M5_PREVIEW_TICK);
    expect(cargo.travelTicksAtDispatch).toBe(2);
    expect(cargo.arrivalTick).toBe(M5_PREVIEW_TICK + 2);
    expect(cargo.fxSettlementId).toBeDefined();
    const loss = departed.context.transactions.filter(
      tx => tx.type === "GOODS_TRANSPORT_LOSS",
    );
    expect(loss).toHaveLength(1);
    expect(loss[0]).toMatchObject({
      tick: M5_PREVIEW_TICK, phase: 7,
      goodId: IRON, source: cargo.beneficialOwner,
    });
    expect(loss[0]!.moneyAmount).toBeUndefined();
    expect(loss[0]!.currencyId).toBeUndefined();
    const destroyed = loss[0]!.quantity!;
    const gross = cargo.quantity + destroyed;
    expect(gross).toBeGreaterThan(0);
    expect(destroyed).toBeCloseTo(gross * 0.25, 8);
    expect(cargo.quantity).toBeCloseTo(gross * 0.75, 8);
    expect(allIron(afterDispatch!)).toBeCloseTo(allIron(beforeDispatch!) - destroyed, 8);
    expect(departed.context.transactions.filter(tx => tx.type === "FX_INPUT"))
      .toHaveLength(1);
    expect(departed.context.transactions.filter(tx => tx.type === "FX_OUTPUT"))
      .toHaveLength(1);

    // Altering current transport policy after paid dispatch must not undo
    // frozen arrival timing, reprice the invoice, or destroy cargo again.
    const laterLink = departed.world.transportLinks.get(linkId)!;
    const changedRoute: WorldState = {
      ...departed.world,
      transportLinks: new Map(departed.world.transportLinks).set(linkId, {
        ...laterLink, travelTicks: 0,
        seed: { ...laterLink.seed, routinePhysicalLossRate: 0 },
      }),
    };
    const noNewTrade = { ...f.options, phase1TradeLawProvider: () => undefined };
    let beforeArrival: WorldState | undefined;
    let afterArrival: WorldState | undefined;
    const enRoute = run(changedRoute, M5_PREVIEW_TICK + 1, noNewTrade);
    expect(enRoute.phaseBoundaryError).toBeUndefined();
    expect(enRoute.reconciliationErrors).toBeNull();
    expect(enRoute.world.shipments.get(cargo.id)).toEqual(cargo);
    expect(enRoute.context.transactions.filter(tx => [
      "SHIPMENT_DELIVERY", "GOODS_TRANSPORT_LOSS",
      "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF",
    ].includes(tx.type))).toHaveLength(0);

    const arrived = run(enRoute.world, M5_PREVIEW_TICK + 2, noNewTrade,
      (phase, before, after) => {
        if (phase === 1) { beforeArrival = before; afterArrival = after; }
      },
    );
    expect(arrived.phaseTrace).toEqual([...Array(16).keys()]);
    expect(arrived.phaseBoundaryError).toBeUndefined();
    expect(arrived.reconciliationErrors).toBeNull();
    expect(beforeArrival).toBeDefined();
    expect(afterArrival).toBeDefined();
    expect(arrived.world.shipments.has(cargo.id)).toBe(false);
    expect(arrived.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
      .toMatchObject([{
        tick: M5_PREVIEW_TICK + 2, phase: 1,
        goodId: IRON, quantity: cargo.quantity,
        destination: cargo.beneficialOwner,
      }]);
    expect(arrived.context.transactions.filter(tx => [
      "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF", "GOODS_TRANSPORT_LOSS",
    ].includes(tx.type))).toHaveLength(0);
    expect(allIron(afterArrival!)).toBeCloseTo(allIron(beforeArrival!), 8);
    assertActualArrival(beforeArrival!, afterArrival!, cargo);

    // Balanced misdelivery: keep the aggregate goods total unchanged while
    // taking stock away from the paid owner and giving it to another unit.
    if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") throw new Error("No buyer");
    const recipient = cargo.beneficialOwner.productionUnitId;
    const other = [...afterArrival!.productionUnits.keys()].find(id => id !== recipient);
    expect(other).toBeDefined();
    const swapped = new Map(afterArrival!.productionUnits);
    const shift = cargo.quantity / 4;
    for (const [id, delta] of [[recipient, -shift], [other!, shift]] as const) {
      const unit = swapped.get(id)!;
      swapped.set(id, {
        ...unit, inputInventory: new Map(unit.inputInventory).set(
          IRON, (unit.inputInventory.get(IRON) ?? 0) + delta,
        ),
      });
    }
    const forged = { ...afterArrival!, productionUnits: swapped };
    expect(allIron(forged)).toBeCloseTo(allIron(afterArrival!), 8);
    expect(() => assertActualArrival(beforeArrival!, forged, cargo)).toThrow();

    const next = run(arrived.world, M5_PREVIEW_TICK + 3, noNewTrade);
    expect(next.phaseBoundaryError).toBeUndefined();
    expect(next.reconciliationErrors).toBeNull();
    expect(next.world.shipments.has(cargo.id)).toBe(false);
    expect(next.context.transactions.filter(tx => [
      "SHIPMENT_DELIVERY", "FX_INPUT", "FX_OUTPUT",
      "GOODS_TRANSPORT_LOSS", "IMPORT_TARIFF",
    ].includes(tx.type))).toHaveLength(0);
  }, 30_000);
});
