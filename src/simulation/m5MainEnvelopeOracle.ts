/** Test-only oracle: paid Phase-7 lots and Phase-8 MAIN share one envelope. */
import { expect } from "vitest";
import { actorRefKey } from "../domain/genesisLedger";
import type { MarketIntent, MarketIntentId } from "./marketIntent";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import { derivePhase7PostProcurementIntents } from "./phase7PostProcurementIntents";
import type {} from "./phase7CommittedIntentResiduals";

type Envelope = Map<MarketIntentId, MarketIntent>;

function near(actual: number, expected: number, epsilon: number, label: string): void {
  expect(Number.isFinite(actual) && Number.isFinite(expected), label).toBe(true);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(epsilon);
}

function index(intents: readonly MarketIntent[]): Envelope {
  const result = new Map(intents.map(intent => [intent.id, { ...intent }]));
  expect(result.size, "unique intent IDs").toBe(intents.length);
  return result;
}

/** Capture canonical post-Phase-4 envelopes before Phase-7 has run. */
export function captureMainEnvelopes(world: WorldState, context: TickContext): Envelope {
  return index(derivePhase7PostProcurementIntents(world, context, 6).phase8MainIntents);
}

/** Debit actual invoices and cargo charges, not proposed matched quantities. */
export function reconcileMainEnvelopes(
  world: WorldState, opening: Envelope, context: TickContext,
): Envelope {
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon!;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon!;
  const expected = index([...opening.values()]);
  expect(Array.isArray(context.phase7CommittedLots)).toBe(true);
  expect(Array.isArray(context.phase7DispatchedShipments)).toBe(true);
  expect(Array.isArray(context.phase7MainIntents)).toBe(true);
  const lots = context.phase7CommittedLots!;
  const cargos = new Map(context.phase7DispatchedShipments!.map(cargo => [cargo.id, cargo]));
  expect(cargos.size).toBe(context.phase7DispatchedShipments!.length);
  expect(lots).toHaveLength(cargos.size);
  const used = new Set<string>();
  for (const lot of lots) {
    expect(used.has(lot.shipmentId), "duplicate committed lot").toBe(false);
    used.add(lot.shipmentId);
    const cargo = context.phase7DispatchedShipments!.find(item => item.id === lot.shipmentId);
    expect(cargo, "paid shipment for committed lot").toBeDefined();
    const seller = expected.get(lot.sellerIntentId)!;
    const buyer = expected.get(lot.buyerIntentId)!;
    expect(seller?.side).toBe("SELL");
    expect(buyer?.side).toBe("BUY");
    expect(actorRefKey(seller.actor)).toBe(actorRefKey(cargo!.seller));
    expect(actorRefKey(buyer.actor)).toBe(actorRefKey(cargo!.buyer));
    expect(seller.regionId).toBe(cargo!.originRegionId);
    expect(buyer.regionId).toBe(cargo!.destinationRegionId);
    expect(lot.originRegionId).toBe(seller.regionId);
    expect(lot.destinationRegionId).toBe(buyer.regionId);
    expect(seller.goodId).toBe(cargo!.goodId);
    expect(buyer.goodId).toBe(cargo!.goodId);
    expect(lot.goodId).toBe(cargo!.goodId);
    expect(buyer.inventoryBucket ?? "GENERAL").toBe(cargo!.destinationInventoryBucket);
    const invoices = context.transactions.filter(tx => tx.phase === 7 &&
      tx.type === "TRADE_GOODS_SALE" && tx.bundleId === "tb:" + cargo!.id.slice(3));
    expect(invoices).toHaveLength(1);
    const gross = invoices[0]!.quantity!;
    const paid = cargo!.buyerGoodsPaymentAmount + cargo!.transportFeeAmount +
      cargo!.tariffAmount + cargo!.consumptionTaxAmount;
    expect(gross).toBeGreaterThan(0);
    expect(paid).toBeGreaterThan(0);
    near(lot.dispatchedQuantity, gross, quantityEpsilon, "gross paid quantity");
    near(lot.buyerTotalDebitDest, paid, moneyEpsilon, "full paid destination debit");
    expected.set(seller.id, { ...seller, desiredQuantity: seller.desiredQuantity - gross });
    expected.set(buyer.id, { ...buyer, desiredQuantity: buyer.desiredQuantity - gross,
      maxSpend: buyer.maxSpend! - paid });
  }
  const actual = index(context.phase7MainIntents!);
  expect(actual.size, "residual intent cardinality").toBe(expected.size);
  for (const [id, envelope] of expected) {
    const residual = actual.get(id)!;
    expect(residual, "missing residual " + id).toBeDefined();
    expect(residual.desiredQuantity).toBeGreaterThanOrEqual(0);
    near(residual.desiredQuantity, envelope.desiredQuantity, quantityEpsilon,
      "residual quantity " + id);
    if (envelope.side === "BUY") {
      expect(residual.maxSpend!).toBeGreaterThanOrEqual(0);
      near(residual.maxSpend!, envelope.maxSpend!, moneyEpsilon, "residual spend " + id);
    }
    // All endpoint and plan metadata remain unchanged.
    expect(residual).toEqual({ ...envelope, desiredQuantity: residual.desiredQuantity,
      ...(envelope.side === "BUY" ? { maxSpend: residual.maxSpend! } : {}) });
  }
  return expected;
}

/** Verify actual local MAIN fills against the independently reconstructed cap. */
export function assertMainAllocations(
  world: WorldState, expected: Envelope, context: TickContext,
): void {
  const remaining = index([...expected.values()]);
  const seen = new Set<string>();
  for (const allocation of context.marketAllocations.filter(item => item.pass === "MAIN")) {
    expect(seen.has(allocation.id), "duplicate MAIN allocation").toBe(false);
    seen.add(allocation.id);
    const seller = remaining.get(allocation.sellerIntentId)!;
    const buyer = remaining.get(allocation.buyerIntentId)!;
    expect(seller?.side).toBe("SELL");
    expect(buyer?.side).toBe("BUY");
    expect(actorRefKey(seller.actor)).toBe(actorRefKey(allocation.seller));
    expect(actorRefKey(buyer.actor)).toBe(actorRefKey(allocation.buyer));
    expect(seller.regionId).toBe(allocation.regionId);
    expect(buyer.regionId).toBe(allocation.regionId);
    expect(seller.goodId).toBe(allocation.goodId);
    expect(buyer.goodId).toBe(allocation.goodId);
    expect(seller.inventoryBucket ?? "GENERAL").toBe(allocation.sellerInventoryBucket);
    expect(buyer.inventoryBucket ?? "GENERAL").toBe(allocation.buyerInventoryBucket);
    const quantity = allocation.quantity;
    const debit = quantity * allocation.buyerGrossUnitPrice;
    expect(Number.isFinite(quantity) && quantity > 0).toBe(true);
    expect(Number.isFinite(debit) && debit >= 0).toBe(true);
    const sellLeft = seller.desiredQuantity - quantity;
    const buyLeft = buyer.desiredQuantity - quantity;
    const cashLeft = buyer.maxSpend! - debit;
    expect(sellLeft, "MAIN seller envelope " + seller.id)
      .toBeGreaterThanOrEqual(-world.simulationConfig.numeric.quantityEpsilon!);
    expect(buyLeft, "MAIN buyer envelope " + buyer.id)
      .toBeGreaterThanOrEqual(-world.simulationConfig.numeric.quantityEpsilon!);
    expect(cashLeft, "MAIN cash envelope " + buyer.id)
      .toBeGreaterThanOrEqual(-world.simulationConfig.numeric.moneyEpsilon!);
    remaining.set(seller.id, { ...seller, desiredQuantity: sellLeft });
    remaining.set(buyer.id, { ...buyer, desiredQuantity: buyLeft, maxSpend: cashLeft });
  }
}
