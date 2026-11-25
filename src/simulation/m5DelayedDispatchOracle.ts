/** Test-only stock oracle for the active M5 delayed iron liquidation fixture. */
import { expect } from "vitest";
import { actorRefKey } from "../domain/genesisLedger";
import type { WorldState } from "./worldState";
import type { TickContext } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";

export function reconcileDelayedDispatch(
  before: WorldState, after: WorldState,
  cargos: readonly TradeShipmentState[], context: TickContext,
  ownerBuckets: (world: WorldState) => Map<string, number>,
): void {
  const expected = ownerBuckets(before);
  const carried = new Map(before.shipments ?? []);
  for (const cargo of cargos) {
    expect(cargo.departureTick).toBe(context.tick);
    expect(cargo.arrivalTick).toBeGreaterThan(context.tick);
    expect(carried.has(cargo.id), "duplicate or overwritten cargo ID").toBe(false);
    const sales = context.transactions.filter(tx => tx.phase === 7 &&
      tx.type === "TRADE_GOODS_SALE" && tx.bundleId === "tb:" + cargo.id.slice(3));
    expect(sales).toHaveLength(1);
    const gross = sales[0]!.quantity!;
    expect(gross).toBeGreaterThan(0);
    const seller = cargo.seller;
    if (seller.type !== "PRODUCTION_UNIT") throw new Error("expected workshop seller");
    expect(before.productionUnits.get(seller.productionUnitId)!.status).toBe("CLOSING");
    const key = JSON.stringify([actorRefKey(seller), "INPUT", cargo.goodId]);
    const stock = expected.get(key) ?? 0;
    expect(stock + (before.simulationConfig.numeric.quantityEpsilon ?? 1e-9),
      "remaining seller stock").toBeGreaterThanOrEqual(gross);
    expected.set(key, stock - gross);
    carried.set(cargo.id, cargo);
  }
  const actual = ownerBuckets(after);
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    expect(actual.get(key) ?? 0, "phase-7 owner bucket " + key)
      .toBeCloseTo(expected.get(key) ?? 0, 6);
  }
  expect(after.shipments ?? new Map(), "exact delayed shipment registry").toEqual(carried);
}
