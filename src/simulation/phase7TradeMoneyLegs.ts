/**
 * M5 / #673 — exact-observable, conserving money legs for Phase-7 trade.
 *
 * A dispatched shipment may pay its seller, destination treasury and transport
 * receiver in the same currency. Every one of those transfers must have an
 * explicit owner at both ends; no transport/tariff/tax money may disappear.
 *
 * This is a narrow atomic money-stock adapter, NOT authorization to dispatch:
 * the caller must verify Phase-1 law/fee/tax authority, goods/route/FX capacity,
 * allocate journal identities and commit the returned WorldState, shipment,
 * goods movement and journal as one transaction. No input is ever mutated.
 */
import type { CurrencyId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import {
  applyActorMoneyDeltas,
  readActorWallet,
  type ActorMoneyDelta,
} from "./marketSettlementTransition";
import type { WorldState } from "./worldState";

export interface Phase7TradeMoneyLeg {
  /** Unique identity inside the eventual all-or-nothing shipment bundle. */
  readonly legId: string;
  readonly from: ActorRef;
  readonly to: ActorRef;
  readonly currencyId: CurrencyId;
  readonly amount: number;
}

interface CompensatedSum {
  sum: number;
  correction: number;
}
interface EndpointStage {
  readonly key: string;
  readonly actor: ActorRef;
  readonly currencyId: CurrencyId;
  readonly debits: CompensatedSum;
  readonly credits: CompensatedSum;
}

function add(sum: CompensatedSum, amount: number): void {
  const next = sum.sum + amount;
  if (Math.abs(sum.sum) >= Math.abs(amount)) {
    sum.correction += (sum.sum - next) + amount;
  } else {
    sum.correction += (amount - next) + sum.sum;
  }
  sum.sum = next;
}

function total(sum: CompensatedSum): number {
  return sum.sum + sum.correction;
}

/**
 * The compensated remainder is part of the promised GROSS amount, not optional
 * rounding slack. A binary64 total may round it back out (for example, 1e16 + 1
 * becomes 1e16), even when equal debit/credit endpoints still conserve cash.
 * Reject the loss before any transfer. Ordinary sub-epsilon decimal arithmetic
 * roundoff (such as 0.1 + 0.2) remains permissible.
 */
function representableGross(sum: CompensatedSum, moneyEpsilon: number): number {
  const rounded = total(sum);
  const lostRemainder = sum.correction - (rounded - sum.sum);
  if (!Number.isFinite(rounded) || !Number.isFinite(lostRemainder) ||
      Math.abs(lostRemainder) > moneyEpsilon) {
    return fail("gross money leg amount cannot be represented without precision loss");
  }
  return rounded;
}
function emptySum(): CompensatedSum {
  return { sum: 0, correction: 0 };
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function fail(reason: string): never {
  throw new Error("Phase-7 money bundle: " + reason);
}

/**
 * Stage and atomically apply already-priced, same-currency transfers.
 *
 * Gross outgoing money must exist at the OPENING of this bundle: circular
 * promises within a bundle cannot create spendable money. Per-endpoint debit,
 * credit and net changes must be observable at binary64 precision, and the
 * actual closing changes must conserve each currency separately. This is
 * stricter than merely checking that the last wallet is nonnegative.
 *
 * FX transfers use settleFx, not this function's same-currency owner legs.
 * No EconomicTransaction is minted here; the outer dispatcher must commit
 * one corresponding journal entry per supplied leg or commit nothing.
 */
export function applyConservingTradeMoneyLegs(
  world: WorldState,
  legs: readonly Phase7TradeMoneyLeg[],
): WorldState {
  if (!Array.isArray(legs) || legs.length === 0) {
    return fail("bundle must contain at least one money leg");
  }
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  if (!Number.isFinite(moneyEpsilon) || moneyEpsilon <= 0) {
    return fail("moneyEpsilon must be finite and positive");
  }

  const ordered = [...legs].sort((a, b) => compare(a.legId, b.legId));
  const seen = new Set<string>();
  const endpoints = new Map<string, EndpointStage>();
  const stage = (
    actor: ActorRef, currencyId: CurrencyId, amount: number, kind: "debits" | "credits",
  ): void => {
    const key = JSON.stringify([actorRefKey(actor), currencyId]);
    let endpoint = endpoints.get(key);
    if (!endpoint) {
      endpoint = { key, actor, currencyId, debits: emptySum(), credits: emptySum() };
      endpoints.set(key, endpoint);
    }
    const previous = endpoint[kind].sum;
    add(endpoint[kind], amount);
    // A positive leg must not vanish into an existing large endpoint total.
    // Do not let moneyEpsilon convert an unobservable micro-leg into a receipt.
    if (endpoint[kind].sum === previous) {
      return fail("positive money leg cannot be represented at this endpoint precision");
    }
  };

  for (const leg of ordered) {
    if (typeof leg.legId !== "string" || leg.legId.trim() === "" ||
        seen.has(leg.legId)) {
      return fail("missing or duplicate legId");
    }
    seen.add(leg.legId);
    if (!Number.isFinite(leg.amount) || leg.amount <= 0) {
      return fail("money leg amount must be finite and positive");
    }
    if (!world.currencies.has(leg.currencyId)) {
      return fail("money leg currency is not in the live currency registry");
    }
    const fromKey = actorRefKey(leg.from);
    const toKey = actorRefKey(leg.to);
    if (fromKey === toKey) {
      return fail("self-payment cannot authorize a journal transfer");
    }
    // Read both ACTUAL wallets now: an endpoint not present in WorldState must
    // not become a plausible-looking "COHORT:undefined" key.
    readActorWallet(world, leg.from);
    readActorWallet(world, leg.to);
    stage(leg.from, leg.currencyId, leg.amount, "debits");
    stage(leg.to, leg.currencyId, leg.amount, "credits");
  }

  const deltas: ActorMoneyDelta[] = [];
  const byCurrency = new Map<CurrencyId, CompensatedSum>();
  const expected = new Map<string, number>();
  for (const endpoint of [...endpoints.values()].sort((a, b) => compare(a.key, b.key))) {
    const debit = representableGross(endpoint.debits, moneyEpsilon);
    const credit = representableGross(endpoint.credits, moneyEpsilon);
    const opening = readActorWallet(world, endpoint.actor).get(endpoint.currencyId) ?? 0;
    if (![debit, credit, opening].every((value) =>
      Number.isFinite(value) && value >= 0)) {
      return fail("non-finite or negative opening/gross money amount");
    }
    if (debit > opening) {
      return fail("gross debit exceeds opening money; inbound legs cannot fund outflow");
    }

    const afterDebit = opening - debit;
    const afterGrossCredit = afterDebit + credit;
    const net = credit - debit;
    const closing = opening + net;
    if (![afterDebit, afterGrossCredit, net, closing].every(Number.isFinite) ||
        closing < 0 ||
        (debit > 0 && (afterDebit === opening ||
          Math.abs((opening - afterDebit) - debit) > moneyEpsilon)) ||
        (credit > 0 && (afterGrossCredit === afterDebit ||
          Math.abs((afterGrossCredit - afterDebit) - credit) > moneyEpsilon)) ||
        (net !== 0 && closing === opening) ||
        Math.abs(afterGrossCredit - closing) > moneyEpsilon ||
        Math.abs((closing - opening) - net) > moneyEpsilon) {
      return fail("money leg cannot be represented without silent stock loss or creation");
    }

    let currencySum = byCurrency.get(endpoint.currencyId);
    if (!currencySum) {
      currencySum = emptySum();
      byCurrency.set(endpoint.currencyId, currencySum);
    }
    add(currencySum, closing - opening);
    expected.set(endpoint.key, closing);
    if (net !== 0) {
      deltas.push({ actor: endpoint.actor, currencyId: endpoint.currencyId, delta: net });
    }
  }

  for (const [currencyId, sum] of byCurrency) {
    if (!Number.isFinite(total(sum)) || Math.abs(total(sum)) > moneyEpsilon) {
      return fail("non-conserving observed cash in currency " + currencyId);
    }
  }

  // All preflights completed before mutation. This existing adapter clones
  // actor maps, and one aggregated delta per endpoint avoids a second,
  // differently-rounded sequence of updates on the same wallet.
  const next = applyActorMoneyDeltas(world, deltas, "Phase-7 money bundle");
  for (const endpoint of endpoints.values()) {
    const key = endpoint.key;
    const actual = readActorWallet(next, endpoint.actor).get(endpoint.currencyId) ?? 0;
    if (actual !== expected.get(key)) {
      return fail("committed balance differs from the verified preflight");
    }
  }
  return next;
}
