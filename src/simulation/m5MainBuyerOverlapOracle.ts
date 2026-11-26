/** Test-only sensitivity checks for actual shared Phase-7/MAIN buyer intents. */
import { expect } from "vitest";
import { assertMainAllocations, type captureMainEnvelopes } from "./m5MainEnvelopeOracle";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import type {} from "./phase7CommittedIntentResiduals";

type Envelope = ReturnType<typeof captureMainEnvelopes>;

export function rejectOverdrawOnSharedBuyer(
  world: WorldState, opening: Envelope, residual: Envelope, context: TickContext,
): { quantity: boolean; cash: boolean } {
  assertMainAllocations(world, residual, context);
  const qEpsilon = world.simulationConfig.numeric.quantityEpsilon!;
  const mEpsilon = world.simulationConfig.numeric.moneyEpsilon!;
  const main = context.marketAllocations.filter(item => item.pass === "MAIN");
  const result = { quantity: false, cash: false };

  for (const [i, allocation] of main.entries()) {
    const paidLots = context.phase7CommittedLots!.filter(
      lot => lot.buyerIntentId === allocation.buyerIntentId);
    const paidQuantity = paidLots.reduce((sum, lot) => sum + lot.dispatchedQuantity, 0);
    const paidCash = paidLots.reduce((sum, lot) => sum + lot.buyerTotalDebitDest, 0);
    if (paidQuantity <= 2 * qEpsilon || paidCash <= 2 * mEpsilon) continue;

    const initial = opening.get(allocation.buyerIntentId)!;
    const remaining = residual.get(allocation.buyerIntentId)!;
    expect(initial.side).toBe("BUY");
    expect(allocation.quantity).toBeGreaterThan(0);
    expect(Math.abs(initial.desiredQuantity - remaining.desiredQuantity - paidQuantity))
      .toBeLessThanOrEqual(qEpsilon);
    expect(Math.abs(initial.maxSpend! - remaining.maxSpend! - paidCash))
      .toBeLessThanOrEqual(mEpsilon);

    const previous = main.slice(0, i);
    const previousBuys = previous.filter(item => item.buyerIntentId === allocation.buyerIntentId);
    const previousQuantity = previousBuys.reduce((sum, item) => sum + item.quantity, 0);
    const previousCash = previousBuys.reduce((sum, item) =>
      sum + item.quantity * item.buyerGrossUnitPrice, 0);
    const previousSales = previous.filter(item => item.sellerIntentId === allocation.sellerIntentId)
      .reduce((sum, item) => sum + item.quantity, 0);
    const buyerQuantityLeft = remaining.desiredQuantity - previousQuantity;
    const buyerCashLeft = remaining.maxSpend! - previousCash;
    const sellerQuantityLeft = residual.get(allocation.sellerIntentId)!.desiredQuantity - previousSales;

    // Quantity-only mutation: do not let an insufficient seller envelope mask
    // the buyer failure. The forged cumulative purchase still fits the opening cap.
    const forgedQuantity = buyerQuantityLeft + paidQuantity / 2;
    if (!result.quantity && forgedQuantity <= sellerQuantityLeft) {
      expect(forgedQuantity).toBeGreaterThan(buyerQuantityLeft + qEpsilon);
      expect(previousQuantity + forgedQuantity).toBeLessThanOrEqual(initial.desiredQuantity);
      const forged: TickContext = {
        ...context,
        marketAllocations: context.marketAllocations.map(item =>
          item === allocation ? { ...item, quantity: forgedQuantity } : item),
      };
      expect(() => assertMainAllocations(world, residual, forged))
        .toThrow("MAIN buyer envelope " + allocation.buyerIntentId);
      result.quantity = true;
    }

    // Cash-only mutation: keep the actual valid quantity and endpoint identity.
    // A gross price that fits the opening budget must still fail the residual cap.
    if (!result.cash) {
      const forgedPrice = (buyerCashLeft + paidCash / 2) / allocation.quantity;
      const forgedDebit = allocation.quantity * forgedPrice;
      expect(forgedDebit).toBeGreaterThan(buyerCashLeft + mEpsilon);
      expect(previousCash + forgedDebit).toBeLessThanOrEqual(initial.maxSpend!);
      const forged: TickContext = {
        ...context,
        marketAllocations: context.marketAllocations.map(item =>
          item === allocation ? { ...item, buyerGrossUnitPrice: forgedPrice } : item),
      };
      expect(() => assertMainAllocations(world, residual, forged))
        .toThrow("MAIN cash envelope " + allocation.buyerIntentId);
      result.cash = true;
    }
    if (result.quantity && result.cash) break;
  }
  return result;
}
