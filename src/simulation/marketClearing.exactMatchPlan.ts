/** Exact, side-effect-free residual reconciliation and two-pointer matching. */
import { exactBinary64QuantityScaled as scaled } from "./marketClearing.exactBinary64Quantity";

export interface BoundedFill<T> {
  readonly intent: T;
  readonly correctedFill: number;
  /** Physical sellable stock or budget-backed effective demand, not a rationed target. */
  readonly capacity: number;
}

export interface ExactMatch<T> {
  readonly seller: T;
  readonly buyer: T;
  readonly quantity: number;
}

const minimum = (a: bigint, b: bigint): bigint => a < b ? a : b;
const absolute = (value: bigint): bigint => value < 0n ? -value : value;

/**
 * Validate actual capacity separately from the proportional target. Rationing is
 * not an inventory limit. The allowed target correction is its computed aggregate
 * rounding residual plus epsilon, rather than an invented per-intent hard cap.
 */
export function exactPlanWithinCapacities<T extends { readonly id: string }>(
  plan: ReadonlyArray<ExactMatch<T>>,
  sellers: ReadonlyArray<BoundedFill<T>>,
  buyers: ReadonlyArray<BoundedFill<T>>,
  clearedQuantity: number,
  epsilon: number,
): boolean {
  const declared = new Set<string>();
  const target = scaled(clearedQuantity);
  const tolerance = scaled(epsilon);
  for (const [fills, side] of [[sellers, "seller"], [buyers, "buyer"]] as const) {
    const actual = new Map<string, bigint>();
    for (const lot of plan) {
      if (!(lot.quantity > 0 && Number.isFinite(lot.quantity))) return false;
      const id = lot[side].id;
      actual.set(id, (actual.get(id) ?? 0n) + scaled(lot.quantity));
    }
    const nominalTotal = fills.reduce((sum, fill) => sum + scaled(fill.correctedFill), 0n);
    const correctionBudget = absolute(nominalTotal - target) + tolerance;
    for (const fill of fills) {
      const id = fill.intent.id;
      if (!id || declared.has(id)) return false;
      declared.add(id);
      const received = actual.get(id) ?? 0n;
      const nominal = scaled(fill.correctedFill);
      if (received > scaled(fill.capacity)) return false;
      if (nominal > 0n && received === 0n) return false;
      if (absolute(received - nominal) > correctionBudget) return false;
      actual.delete(id);
    }
    if (actual.size !== 0) return false;
  }
  return true;
}

/**
 * Split an exact nonnegative dyadic amount into representable positive lots.
 * A binary64 amount has at most 2098 significant bit positions, so this takes
 * at most 40 chunks per matched pair. No positive remainder is rounded away.
 */
function representableLots(units: bigint): number[] {
  const result: number[] = [];
  while (units > 0n) {
    const shift = Math.max(0, units.toString(2).length - 53);
    const leading = units >> BigInt(shift);
    const quantity = Number(leading) * 2 ** (shift - 1074);
    const consumed = scaled(quantity);
    if (consumed <= 0n || consumed > units) {
      throw new Error("Exact clearing cannot represent a positive matched quantity");
    }
    result.push(quantity);
    units -= consumed;
  }
  return result;
}

/** Reconcile only the computed rounding residual, in the supplied stable order. */
function reconcile<T>(fills: ReadonlyArray<BoundedFill<T>>, target: bigint, epsilon: number): bigint[] {
  const capacities = fills.map((fill) => scaled(fill.capacity));
  const quantities = fills.map((fill, index) => minimum(scaled(fill.correctedFill), capacities[index]!));
  let residual = target - quantities.reduce((sum, value) => sum + value, 0n);
  if (residual > 0n) {
    for (let index = 0; index < quantities.length && residual > 0n; index++) {
      const increment = minimum(residual, capacities[index]! - quantities[index]!);
      quantities[index] = quantities[index]! + increment;
      residual -= increment;
    }
  } else if (residual < 0n) {
    // Prefer non-micro targets so a tiny genuine trade is not consumed by the
    // rounding correction of a large participant. Keep actor/intent order within each pass.
    for (const micro of [false, true]) {
      for (let index = 0; index < quantities.length && residual < 0n; index++) {
        if ((fills[index]!.correctedFill <= epsilon) !== micro) continue;
        const quantity = quantities[index]!;
        const floor = fills[index]!.correctedFill > 0 ? 1n : 0n;
        const available = quantity > floor ? quantity - floor : 0n;
        const decrement = minimum(-residual, available);
        quantities[index] = quantity - decrement;
        residual += decrement;
      }
    }
  }
  if (residual !== 0n) {
    throw new Error("Exact clearing cannot reconcile positive fills within physical capacities");
  }
  return quantities;
}

/**
 * Used only when the ordinary Number plan fails validation. Keep proportional
 * targets, correct their actual residual rather than guessing epsilon/2, and
 * match with exact remaining balances. O(B + S) after the caller's stable sort;
 * the number of binary64 chunks per pair is bounded by the representation.
 */
export function buildExactMatchPlan<T>(
  sellers: ReadonlyArray<BoundedFill<T>>,
  buyers: ReadonlyArray<BoundedFill<T>>,
  clearedQuantity: number,
  epsilon: number,
): ExactMatch<T>[] {
  const wanted = scaled(clearedQuantity);
  const tolerance = scaled(epsilon);
  const sellerCapacity = sellers.reduce((sum, fill) => sum + scaled(fill.capacity), 0n);
  const buyerCapacity = buyers.reduce((sum, fill) => sum + scaled(fill.capacity), 0n);
  // Q is a Number reduction and may round above the exact available stock.
  // Never create stock to hit that rounded target or widen the tolerance.
  const target = minimum(wanted, minimum(sellerCapacity, buyerCapacity));
  if (wanted - target > tolerance) {
    throw new Error("Exact clearing target exceeds physical capacity beyond epsilon");
  }
  const sellerRemaining = reconcile(sellers, target, epsilon);
  const buyerRemaining = reconcile(buyers, target, epsilon);
  const plan: ExactMatch<T>[] = [];
  let seller = 0;
  let buyer = 0;
  while (seller < sellers.length && buyer < buyers.length) {
    const matched = minimum(sellerRemaining[seller]!, buyerRemaining[buyer]!);
    for (const quantity of representableLots(matched)) {
      plan.push({ seller: sellers[seller]!.intent, buyer: buyers[buyer]!.intent, quantity });
    }
    sellerRemaining[seller] = sellerRemaining[seller]! - matched;
    buyerRemaining[buyer] = buyerRemaining[buyer]! - matched;
    if (sellerRemaining[seller] === 0n) seller++;
    if (buyerRemaining[buyer] === 0n) buyer++;
  }
  return plan;
}
