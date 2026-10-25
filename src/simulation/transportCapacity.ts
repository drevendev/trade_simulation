/**
 * M5 #669: read-only transport capacity arithmetic (Handoff/04 §13).
 *
 * Cargo capacity is measured in cargo-weight units, NOT goods quantity.
 * Physical capacity is derived from the immutable route seed and an explicit
 * infrastructure factor supplied by its future owner; it is never another
 * authoritative WorldState stock. Phase-7 allocation and the independent
 * enabled/legal-policy gate are intentionally not implemented here.
 */
import type { SimulationConfig } from "../config/simulationConfig";
import type { TransportLinkState } from "./worldState";

function finiteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be non-negative and finite`);
  }
}

/** Handoff/04 §13: max(0, baseCapacity * clamp(condition, 0, 1) * infrastructureFactor). */
export function effectiveTransportLinkCapacity(
  link: TransportLinkState,
  externalInfrastructureCapacityFactor: number,
): number {
  const { baseCapacity, condition } = link.seed;
  finiteNonnegative(baseCapacity, "TransportLink.baseCapacity");
  if (!Number.isFinite(condition) || condition < 0 || condition > 1) {
    throw new Error("TransportLink.condition must be finite in [0,1]");
  }
  finiteNonnegative(externalInfrastructureCapacityFactor, "externalInfrastructureCapacityFactor");
  const physicalCapacity = Math.max(
    0,
    baseCapacity * Math.min(1, Math.max(0, condition)) * externalInfrastructureCapacityFactor,
  );
  finiteNonnegative(physicalCapacity, "effectiveTransportLinkCapacity");
  return physicalCapacity;
}

/**
 * Physical-capacity gate only. Full link eligibility also requires the
 * separately owned enabled/legal-policy gates, once those are implemented.
 * The utilization target is a planning target, not a multiplier of the
 * physical maximum; consuming that target here would silently shrink capacity.
 */
export function hasUsableTransportCapacity(
  link: TransportLinkState,
  config: Pick<SimulationConfig, "trade" | "numeric">,
  externalInfrastructureCapacityFactor: number,
): boolean {
  const minimum = config.trade.transportConditionMinimum;
  const epsilon = config.numeric.quantityEpsilon;
  if (minimum === undefined || !Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
    throw new Error("resolved TradeConfig.transportConditionMinimum must be finite in [0,1]");
  }
  if (epsilon === undefined || !Number.isFinite(epsilon) || epsilon < 0) {
    throw new Error("NumericConfig.quantityEpsilon must be non-negative and finite");
  }
  const effectiveCapacity = effectiveTransportLinkCapacity(link, externalInfrastructureCapacityFactor);
  return link.seed.condition >= minimum && effectiveCapacity > epsilon;
}

/** Handoff/04 §13: quantity of a good consumes quantity * cargoWeightPerUnit. */
export function cargoCapacityUse(quantity: number, cargoWeightPerUnit: number): number {
  finiteNonnegative(quantity, "cargo quantity");
  if (!Number.isFinite(cargoWeightPerUnit) || cargoWeightPerUnit <= 0) {
    throw new Error("cargoWeightPerUnit must be positive and finite");
  }
  const use = quantity * cargoWeightPerUnit;
  finiteNonnegative(use, "cargo capacity use");
  return use;
}
