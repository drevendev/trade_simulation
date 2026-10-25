/**
 * M5 #852 — deterministic Phase-7 cargo-weight capacity preflight.
 *
 * Pure ephemeral reservation evidence only. The caller supplies the external
 * infrastructure and enabled/legal-policy decisions explicitly; neither this
 * module nor WorldState derives policy or settles shipments, cash, or goods.
 * Canonical contract: Handoff/04 §§13, 24–26, MTFX-I9/T10/T21.
 */
import type { SimulationConfig } from "../config/simulationConfig";
import type { GoodId, RegionId, TransportLinkId } from "../domain/id";
import {
  cargoCapacityUse,
  effectiveTransportLinkCapacity,
  hasUsableTransportCapacity,
} from "./transportCapacity";
import type { WorldState } from "./worldState";

export interface TransportCapacityRequest {
  /** Unique deterministic candidate/plan identifier within this Phase-7 preflight. */
  readonly planId: string;
  readonly linkId: TransportLinkId;
  readonly fromRegionId: RegionId;
  readonly toRegionId: RegionId;
  readonly goodId: GoodId;
  /** Precomputed candidate score; this module does not calculate eligibility. */
  readonly score: number;
  readonly requestedQuantity: number;
  readonly cargoWeightPerUnit: number;
}

export type CapacityRefusal =
  | "LINK_NOT_ELIGIBLE"
  | "NO_PHYSICAL_CAPACITY"
  | "CAPACITY_EXHAUSTED"
  | "QUANTITY_BELOW_EPSILON";

export interface TransportCapacityReservation {
  readonly planId: string;
  readonly linkId: TransportLinkId;
  readonly goodId: GoodId;
  readonly requestedQuantity: number;
  readonly reservedQuantity: number;
  readonly capacityUsed: number;
  readonly refusal: CapacityRefusal | null;
}

export interface TransportCapacityPreflight {
  /** Score-ordered candidate results; no shipment or financial transaction. */
  readonly reservations: readonly TransportCapacityReservation[];
  /** Weight-unit budgets are independent for each directed link ID. */
  readonly usedByLink: ReadonlyMap<TransportLinkId, number>;
  readonly remainingByLink: ReadonlyMap<TransportLinkId, number>;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Handoff/04 §24: score descending, then origin, destination, good, link. */
function compareRequests(a: TransportCapacityRequest, b: TransportCapacityRequest): number {
  return b.score - a.score ||
    compareString(a.fromRegionId, b.fromRegionId) ||
    compareString(a.toRegionId, b.toRegionId) ||
    compareString(a.goodId, b.goodId) ||
    compareString(a.linkId, b.linkId) ||
    compareString(a.planId, b.planId);
}

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite and positive`);
  }
}

/**
 * Reserve shared capacity across independently scored candidate goods, without
 * mutation. Does NOT discover candidates or authorize their sale/trade.
 *
 * An explicit eligible-link set is mandatory: callers must make their own
 * enabled/legal-policy decision; an unlisted route cannot be used. Every
 * referenced link also requires an explicit infrastructure factor.
 */
export function planTransportCapacityPreflight(
  world: Pick<WorldState, "transportLinks">,
  config: Pick<SimulationConfig, "trade" | "numeric">,
  requests: readonly TransportCapacityRequest[],
  infrastructureFactors: ReadonlyMap<TransportLinkId, number>,
  eligibleDirectedLinkIds: ReadonlySet<TransportLinkId>,
): TransportCapacityPreflight {
  const epsilon = config.numeric.quantityEpsilon;
  if (epsilon === undefined || !Number.isFinite(epsilon) || epsilon < 0) {
    throw new Error("NumericConfig.quantityEpsilon must be resolved and finite");
  }
  if (!infrastructureFactors || !eligibleDirectedLinkIds) {
    throw new Error("explicit infrastructure factors and route eligibility are required");
  }

  // Validate EVERY candidate before reserving any capacity; failures cannot
  // expose a partially successful plan to a caller.
  const seen = new Set<string>();
  for (const candidate of requests) {
    if (typeof candidate.planId !== "string" || candidate.planId.trim().length === 0 ||
        seen.has(candidate.planId)) {
      throw new Error("transport capacity planId must be unique and nonempty");
    }
    seen.add(candidate.planId);
    if (typeof candidate.goodId !== "string" || candidate.goodId.length === 0) {
      throw new Error("transport capacity candidate requires a GoodId");
    }
    if (!Number.isFinite(candidate.score)) {
      throw new Error("transport capacity candidate score must be finite");
    }
    finitePositive(candidate.requestedQuantity, "requestedQuantity");
    finitePositive(candidate.cargoWeightPerUnit, "cargoWeightPerUnit");
    const fullUse = cargoCapacityUse(candidate.requestedQuantity, candidate.cargoWeightPerUnit);
    finitePositive(fullUse, "requested cargo-weight use");
    const link = world.transportLinks.get(candidate.linkId);
    if (!link || link.fromRegionId !== candidate.fromRegionId ||
        link.toRegionId !== candidate.toRegionId) {
      throw new Error(`transport capacity candidate ${candidate.planId} references an unknown/mismatched directed link`);
    }
    if (!infrastructureFactors.has(candidate.linkId)) {
      throw new Error(`transport link ${candidate.linkId} has no explicit infrastructure factor`);
    }
  }

  const budgets = new Map<TransportLinkId, number>();
  const remaining = new Map<TransportLinkId, number>();
  const usability = new Map<TransportLinkId, boolean>();
  for (const candidate of requests) {
    if (budgets.has(candidate.linkId)) continue;
    const link = world.transportLinks.get(candidate.linkId)!;
    const factor = infrastructureFactors.get(candidate.linkId)!;
    const capacity = effectiveTransportLinkCapacity(link, factor);
    const usable = hasUsableTransportCapacity(link, config, factor);
    budgets.set(candidate.linkId, capacity);
    remaining.set(candidate.linkId, capacity);
    usability.set(candidate.linkId, usable);
  }

  const reservations: TransportCapacityReservation[] = [];
  for (const request of [...requests].sort(compareRequests)) {
    const available = remaining.get(request.linkId)!;
    const allowed = eligibleDirectedLinkIds.has(request.linkId);
    const physicallyUsable = usability.get(request.linkId)!;
    let refusal: CapacityRefusal | null = !allowed ? "LINK_NOT_ELIGIBLE"
      : !physicallyUsable ? "NO_PHYSICAL_CAPACITY"
        : available <= 0 ? "CAPACITY_EXHAUSTED" : null;
    let quantity = 0;
    let use = 0;

    if (refusal === null) {
      quantity = Math.min(request.requestedQuantity, available / request.cargoWeightPerUnit);
      if (quantity <= epsilon) {
        refusal = "QUANTITY_BELOW_EPSILON";
        quantity = 0;
      } else {
        use = cargoCapacityUse(quantity, request.cargoWeightPerUnit);
        // Division/multiplication can round a full-capacity fill upward by
        // one ulp. Shrink conservatively, never book more than available.
        if (use > available) {
          quantity *= 1 - Number.EPSILON;
          use = cargoCapacityUse(quantity, request.cargoWeightPerUnit);
        }
        if (!Number.isFinite(use) || use <= 0 || use > available) {
          throw new Error("transport cargo reservation exceeds or underflows available capacity");
        }
        const after = available - use;
        if (after === available) {
          throw new Error("transport reservation is too small for link-budget precision");
        }
        remaining.set(request.linkId, after);
      }
    }

    reservations.push({
      planId: request.planId,
      linkId: request.linkId,
      goodId: request.goodId,
      requestedQuantity: request.requestedQuantity,
      reservedQuantity: quantity,
      capacityUsed: use,
      refusal,
    });
  }

  const usedByLink = new Map<TransportLinkId, number>();
  for (const [linkId, capacity] of budgets) {
    usedByLink.set(linkId, capacity - remaining.get(linkId)!);
  }
  return { reservations, usedByLink, remainingByLink: remaining };
}
