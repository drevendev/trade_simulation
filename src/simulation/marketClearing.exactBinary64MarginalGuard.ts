/**
 * Exact per-intent quantity checks for the SLP-787-01 pre-materialization boundary.
 * Number reductions can hide endpoint overruns; compare emitted lots and their
 * original per-intent limits in exact binary64 dyadic units instead.
 */
import { exactBinary64QuantityScaled as scaled } from "./marketClearing.exactBinary64Quantity";

export interface ExactFill {
  readonly intent: { readonly id: string };
  readonly correctedFill: number;
}

export interface ExactLot {
  readonly seller: { readonly id: string };
  readonly buyer: { readonly id: string };
  readonly quantity: number;
}

export interface ExactMarginalFinding {
  readonly side: "SELL" | "BUY";
  readonly intentId: string;
  readonly outcome:
    | "OVER_CAP"
    | "UNDER_TOLERANCE"
    | "LOST_POSITIVE_FILL"
    | "UNKNOWN_INTENT"
    | "DUPLICATE_INTENT"
    | "CROSS_SIDE_COLLISION";
  readonly excessScaled: bigint;
}

export function exactMarginalTotals<T extends ExactLot>(plan: ReadonlyArray<T>): {
  sellers: Map<string, bigint>;
  buyers: Map<string, bigint>;
} {
  const sellers = new Map<string, bigint>();
  const buyers = new Map<string, bigint>();
  for (const lot of plan) {
    if (!(lot.quantity > 0 && Number.isFinite(lot.quantity))) {
      throw new RangeError("Nonpositive or nonfinite match");
    }
    const quantity = scaled(lot.quantity);
    sellers.set(lot.seller.id, (sellers.get(lot.seller.id) ?? 0n) + quantity);
    buyers.set(lot.buyer.id, (buyers.get(lot.buyer.id) ?? 0n) + quantity);
  }
  return { sellers, buyers };
}

export function exactMarginalFindings<T extends ExactLot>(
  plan: ReadonlyArray<T>,
  sellerFills: ReadonlyArray<ExactFill>,
  buyerFills: ReadonlyArray<ExactFill>,
  epsilon: number,
): ExactMarginalFinding[] {
  const totals = exactMarginalTotals(plan);
  const eps = scaled(epsilon);
  const findings: ExactMarginalFinding[] = [];
  const check = (
    fills: ReadonlyArray<ExactFill>,
    actual: ReadonlyMap<string, bigint>,
    side: "SELL" | "BUY",
  ): void => {
    const declared = new Set<string>();
    for (const fill of fills) {
      const id = fill.intent?.id;
      if (typeof id !== "string" || id.length === 0 || declared.has(id)) {
        findings.push({ side, intentId: id ?? "<missing>", outcome: "DUPLICATE_INTENT", excessScaled: 0n });
        continue;
      }
      declared.add(id);
      const cap = scaled(fill.correctedFill);
      const received = actual.get(id) ?? 0n;
      if (received > cap) {
        findings.push({ side, intentId: id, outcome: "OVER_CAP", excessScaled: received - cap });
      } else if (cap > 0n && received === 0n) {
        findings.push({ side, intentId: id, outcome: "LOST_POSITIVE_FILL", excessScaled: cap });
      } else if (cap - received > eps) {
        findings.push({ side, intentId: id, outcome: "UNDER_TOLERANCE", excessScaled: cap - received - eps });
      }
    }
    // An undeclared endpoint must not manufacture goods or allocation provenance.
    for (const id of actual.keys()) {
      if (!declared.has(id)) {
        findings.push({ side, intentId: id, outcome: "UNKNOWN_INTENT", excessScaled: 0n });
      }
    }
  };
  check(sellerFills, totals.sellers, "SELL");
  check(buyerFills, totals.buyers, "BUY");

  // MarketIntent IDs identify declarations, not side-local aliases.
  const sellerIds = new Set<string>();
  for (const fill of sellerFills) {
    if (typeof fill.intent?.id === "string" && fill.intent.id.length > 0) {
      sellerIds.add(fill.intent.id);
    }
  }
  for (const fill of buyerFills) {
    const id = fill.intent?.id;
    if (typeof id === "string" && sellerIds.has(id)) {
      findings.push({ side: "BUY", intentId: id, outcome: "CROSS_SIDE_COLLISION", excessScaled: 0n });
    }
  }
  return findings;
}

export function exactMarginalsSafe<T extends ExactLot>(
  plan: ReadonlyArray<T>,
  sellers: ReadonlyArray<ExactFill>,
  buyers: ReadonlyArray<ExactFill>,
  epsilon: number,
): boolean {
  return exactMarginalFindings(plan, sellers, buyers, epsilon).length === 0;
}

/**
 * Check original limits, bounded underfill, trial fidelity and positive tails in
 * the same exact units. A rounded Number sum must not conceal an overrun or
 * falsely reject lots whose exact sum remains below the endpoint limit.
 */
export function exactTrialPreservesMarginals<T extends ExactLot>(
  plan: ReadonlyArray<T>,
  originalSellers: ReadonlyArray<ExactFill>,
  originalBuyers: ReadonlyArray<ExactFill>,
  trialSellers: ReadonlyArray<ExactFill>,
  trialBuyers: ReadonlyArray<ExactFill>,
  epsilon: number,
): boolean {
  const totals = exactMarginalTotals(plan);
  const eps = scaled(epsilon);
  const idsConsistent = (
    original: ReadonlyArray<ExactFill>,
    trial: ReadonlyArray<ExactFill>,
    actual: ReadonlyMap<string, bigint>,
  ): boolean => {
    const declared = new Set<string>();
    for (const fill of original) {
      const id = fill.intent?.id;
      if (typeof id !== "string" || id.length === 0 || declared.has(id)) return false;
      declared.add(id);
    }
    const trialIds = new Set<string>();
    for (const fill of trial) {
      const id = fill.intent?.id;
      if (typeof id !== "string" || !declared.has(id) || trialIds.has(id)) return false;
      trialIds.add(id);
    }
    if (trialIds.size !== declared.size) return false;
    for (const id of actual.keys()) if (!declared.has(id)) return false;
    return true;
  };
  if (!idsConsistent(originalSellers, trialSellers, totals.sellers) ||
      !idsConsistent(originalBuyers, trialBuyers, totals.buyers)) return false;
  const declaredSellerIds = new Set(originalSellers.map((fill) => fill.intent.id));
  for (const fill of originalBuyers) {
    if (declaredSellerIds.has(fill.intent.id)) return false;
  }
  const abs = (value: bigint): bigint => value >= 0n ? value : -value;
  const safe = (
    original: ReadonlyArray<ExactFill>,
    trial: ReadonlyArray<ExactFill>,
    actual: ReadonlyMap<string, bigint>,
  ): boolean => {
    const targets = new Map(trial.map((fill) => [fill.intent.id, scaled(fill.correctedFill)]));
    for (const fill of original) {
      const target = targets.get(fill.intent.id);
      if (target === undefined) return false;
      const cap = scaled(fill.correctedFill);
      const received = actual.get(fill.intent.id) ?? 0n;
      if (received > cap || cap - received > eps) return false;
      if (abs(target - received) > eps) return false;
      if (cap > 0n && received === 0n) return false;
    }
    return true;
  };
  return safe(originalSellers, trialSellers, totals.sellers)
    && safe(originalBuyers, trialBuyers, totals.buyers);
}
