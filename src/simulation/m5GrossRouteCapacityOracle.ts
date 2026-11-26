/** Test-only capacity oracle. Charge paid gross weight, not surviving cargo. */
import { expect } from "vitest";
import type { TransportLinkId } from "../domain/id";
import type { WorldState } from "./worldState";
import type { TickContext } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";

type Usage = { gross: number; surviving: number };

export function reconcileGrossRouteCapacity(
  before: WorldState, cargos: readonly TradeShipmentState[], context: TickContext,
): Map<TransportLinkId, Usage> {
  const usage = new Map<TransportLinkId, Usage>();
  for (const cargo of cargos) {
    const invoices = context.transactions.filter(tx => tx.phase === 7 &&
      tx.type === "TRADE_GOODS_SALE" && tx.bundleId === "tb:" + cargo.id.slice(3));
    expect(invoices).toHaveLength(1);
    const gross = invoices[0]!.quantity!;
    const weight = before.definitionRegistry.goods[cargo.goodId]!.cargoWeightPerUnit;
    expect(Number.isFinite(gross) && gross > 0).toBe(true);
    expect(Number.isFinite(weight) && weight > 0).toBe(true);
    expect(Number.isFinite(cargo.quantity) && cargo.quantity >= 0).toBe(true);
    const prior = usage.get(cargo.transportLinkId) ?? { gross: 0, surviving: 0 };
    usage.set(cargo.transportLinkId, {
      gross: prior.gross + gross * weight,
      surviving: prior.surviving + cargo.quantity * weight,
    });
  }
  for (const [id, use] of usage) {
    const link = before.transportLinks.get(id)!;
    expect(link).toBeDefined();
    const cap = link.seed.baseCapacity * link.seed.condition; // fixture factor = 1
    expect(use.gross, "gross route capacity " + id)
      .toBeLessThanOrEqual(cap + before.simulationConfig.numeric.quantityEpsilon!);
  }
  return usage;
}

/** A net-only check would accept this forged opening; the gross oracle must not. */
export function rejectCapacityHiddenByLoss(
  before: WorldState, cargos: readonly TradeShipmentState[], context: TickContext,
  id: TransportLinkId, use: Usage,
): boolean {
  const link = before.transportLinks.get(id)!;
  const epsilon = before.simulationConfig.numeric.quantityEpsilon!;
  if (link.seed.condition <= 0 || use.gross - use.surviving <= 4 * epsilon) return false;
  const forgedCap = (use.gross + use.surviving) / 2;
  const forgedLink = { ...link, seed: { ...link.seed,
    baseCapacity: forgedCap / link.seed.condition } };
  const actualCap = forgedLink.seed.baseCapacity * forgedLink.seed.condition;
  expect(use.surviving).toBeLessThan(actualCap);
  expect(use.gross).toBeGreaterThan(actualCap + epsilon);
  const forged: WorldState = { ...before,
    transportLinks: new Map(before.transportLinks).set(id, forgedLink) };
  expect(() => reconcileGrossRouteCapacity(forged, cargos, context))
    .toThrow("gross route capacity " + id);
  // Positive control: the original opening and exact same paid evidence pass.
  expect(reconcileGrossRouteCapacity(before, cargos, context).get(id)).toEqual(use);
  return true;
}
