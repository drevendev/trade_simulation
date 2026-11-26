/** Test-only sensitivity check for actual same-intent Phase-7/8 overlap. */
import { expect } from "vitest";
import { assertMainAllocations, type captureMainEnvelopes } from "./m5MainEnvelopeOracle";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import type {} from "./phase7CommittedIntentResiduals";

type Envelope = ReturnType<typeof captureMainEnvelopes>;

/** A genuine allocation supplies all endpoint metadata; mutate quantity alone.
 * Return false if this tick has no load-bearing paid seller overlap.
 */
export function rejectOverdrawOnSharedSeller(
  world: WorldState, opening: Envelope, residual: Envelope, context: TickContext,
): boolean {
  assertMainAllocations(world, residual, context);
  const epsilon = world.simulationConfig.numeric.quantityEpsilon!;
  const lots = context.phase7CommittedLots!;
  for (const allocation of context.marketAllocations) {
    if (allocation.pass !== "MAIN") continue;
    const paid = lots.filter(lot => lot.sellerIntentId === allocation.sellerIntentId)
      .reduce((sum, lot) => sum + lot.dispatchedQuantity, 0);
    if (paid <= 2 * epsilon) continue;
    const initial = opening.get(allocation.sellerIntentId)!;
    const remaining = residual.get(allocation.sellerIntentId)!;
    expect(initial.side).toBe("SELL");
    expect(allocation.quantity).toBeGreaterThan(0);
    expect(initial.desiredQuantity - remaining.desiredQuantity).toBeCloseTo(paid, 6);
    const forgedQuantity = remaining.desiredQuantity + paid / 2;
    expect(forgedQuantity).toBeGreaterThan(remaining.desiredQuantity + epsilon);
    expect(forgedQuantity).toBeLessThanOrEqual(initial.desiredQuantity);
    const forged: TickContext = {
      ...context,
      marketAllocations: context.marketAllocations.map(item =>
        item === allocation ? { ...item, quantity: forgedQuantity } : item),
    };
    expect(() => assertMainAllocations(world, residual, forged))
      .toThrow("MAIN seller envelope " + allocation.sellerIntentId);
    return true;
  }
  return false;
}
