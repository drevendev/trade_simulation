/**
 * M5 / #673 — opt-in current-tick canonical cargo capacity.
 *
 * The WorldState's directed TransportLinks own PHYSICAL capacity, while the
 * infrastructure subsystem still owns its explicit factors. A fresh Phase-7
 * pass may derive a remaining cargo budget without trusting a caller-supplied
 * residual. This is safe only before any shipment has departed this tick:
 * persistent shipment quantity is surviving cargo after routine loss, not
 * the original cargo-weight use, and zero-travel shipments may already have
 * been delivered. Neither source can reconstruct arbitrary earlier same-tick
 * reservations. Refuse them instead of manufacturing free capacity.
 *
 * This function never authorizes a route, reserves a lot or mutates the world.
 */
import type { TransportLinkId } from "../domain/id";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import { effectiveTransportLinkCapacity } from "./transportCapacity";

export function derivePhase7CanonicalCargoResiduals(
  world: Pick<WorldState, "transportLinks" | "shipments">,
  context: Pick<TickContext, "tick" | "phase" | "transactions">,
  infrastructureFactors: ReadonlyMap<TransportLinkId, number>,
  eligibleDirectedLinkIdsAtPhase1: ReadonlySet<TransportLinkId>,
): ReadonlyMap<TransportLinkId, number> {
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 ||
      context.phase !== 7 || !Array.isArray(context.transactions)) {
    throw new Error("Phase-7 canonical cargo requires a live current-tick Phase-7 journal");
  }
  if (!(world.shipments instanceof Map)) {
    throw new Error("Phase-7 canonical cargo requires a persistent shipment registry");
  }
  if (!(infrastructureFactors instanceof Map) ||
      !(eligibleDirectedLinkIdsAtPhase1 instanceof Set)) {
    throw new Error("Phase-7 canonical cargo requires explicit infrastructure and Phase-1 eligibility");
  }
  if (context.transactions.some(tx => tx.tick === context.tick &&
      tx.type === "SHIPMENT_DISPATCH")) {
    throw new Error("Phase-7 canonical cargo cannot infer earlier same-tick dispatch capacity use");
  }
  // A prior dispatch may survive in the registry even if an external caller
  // passed an incomplete journal. Never credit surviving cargo as full booked
  // capacity: dispatch-time losses and zero-travel deliveries make it unsafe.
  for (const shipment of world.shipments.values()) {
    if (shipment.departureTick === context.tick) {
      throw new Error("Phase-7 canonical cargo cannot infer earlier same-tick shipment capacity use");
    }
  }

  const residuals = new Map<TransportLinkId, number>();
  for (const linkId of [...eligibleDirectedLinkIdsAtPhase1].sort()) {
    const link = world.transportLinks.get(linkId);
    if (!link || !infrastructureFactors.has(linkId)) {
      throw new Error("Phase-7 canonical cargo missing directed link or infrastructure factor");
    }
    residuals.set(linkId, effectiveTransportLinkCapacity(
      link, infrastructureFactors.get(linkId)!,
    ));
  }
  return residuals;
}
