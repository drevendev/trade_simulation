/**
 * M5 / #673: deterministic, tick-local FX promises for ACTUAL matched lots.
 *
 * Quotes and buyer identity come from the canonical live Phase-7 re-quote.
 * This pure preflight neither creates currency nor spends a wallet. Scarcity
 * that would partially fill a quoted lot is rejected: resizing and re-quoting
 * the whole plan is a separate upstream responsibility.
 */
import { actorRefKey } from "../domain/genesisLedger";
import type { CurrencyId } from "../domain/id";
import {
  fxPayerCurrencyKey, reserveFxForPool,
  type FxReservation, type FxReservationRequest,
} from "./fxQuoteReservation";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { readActorWallet } from "./marketSettlementTransition";
import { phase7FxOutputKey } from "./phase7AggregateReservation";
import type { Phase7ActualLotQuote } from "./phase7ActualLotQuote";
import type { WorldState } from "./worldState";

interface PendingLot {
  readonly ordinal: number;
  readonly quote: Phase7ActualLotQuote;
  readonly request: FxReservationRequest;
}

function fail(message: string): never {
  throw new Error("Phase-7 automatic FX reservation: " + message);
}

/**
 * Group by the declared canonical pool; within each pool reserve in matched
 * ordinal order. Input cash is shared ACROSS pools for the same payer and
 * currency, rather than reset independently for each pool.
 *
 * Only full, financially representable promises are accepted in the public
 * reservation API. The private partial-quote path is for READ-ONLY upstream
 * scarcity assessment; it must never be passed to atomic settlement.
 */
function planPhase7QuotedFxLots(
  world: WorldState,
  tick: number,
  quotes: readonly Phase7ActualLotQuote[],
  allowPartialForPlanning: boolean,
): ReadonlyMap<number, FxReservation> {
  if (!Number.isSafeInteger(tick) || tick < 0 || !Array.isArray(quotes)) {
    return fail("invalid tick or matched quotes");
  }
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  if (moneyEpsilon === undefined || !Number.isFinite(moneyEpsilon) ||
      moneyEpsilon < 0) {
    return fail("unresolved money precision");
  }
  const byPool = new Map<string, PendingLot[]>();
  const cashByPayerCurrency = new Map<string, number>();
  for (const [ordinal, quote] of quotes.entries()) {
    if (!quote || !quote.lot) return fail("missing matched lot evidence");
    if (quote.fxPairId === null) {
      if (quote.originCurrencyId !== quote.destinationCurrencyId) {
        return fail("cross-currency lot lacks canonical FX pair");
      }
      continue;
    }
    if (!quote.fxPairId || quote.originCurrencyId === quote.destinationCurrencyId ||
        !Number.isFinite(quote.sellerInvoiceSource) || quote.sellerInvoiceSource <= 0 ||
        !Number.isFinite(quote.goodsPaymentDest) || quote.goodsPaymentDest <= 0 ||
        !Number.isFinite(quote.buyerDebitDest) ||
        quote.buyerDebitDest < quote.goodsPaymentDest) {
      return fail("invalid cross-currency invoice or FX pair");
    }
    const pool = resolveCanonicalFxPool(world, quote.fxPairId).pool;
    if (![pool.baseCurrencyId, pool.quoteCurrencyId].includes(quote.originCurrencyId) ||
        ![pool.baseCurrencyId, pool.quoteCurrencyId].includes(quote.destinationCurrencyId)) {
      return fail("matched lot currencies differ from canonical FX pool");
    }
    const payerKey = actorRefKey(quote.lot.buyer);
    const currencyId: CurrencyId = quote.destinationCurrencyId;
    const cashKey = fxPayerCurrencyKey(payerKey, currencyId);
    const cash = readActorWallet(world, quote.lot.buyer).get(currencyId) ?? 0;
    if (!Number.isFinite(cash) || cash < 0 || quote.buyerDebitDest > cash) {
      return fail("buyer lacks live destination cash for quoted lot");
    }
    if (cashByPayerCurrency.has(cashKey) &&
        cashByPayerCurrency.get(cashKey) !== cash) {
      return fail("inconsistent opening buyer cash authority");
    }
    cashByPayerCurrency.set(cashKey, cash);
    const request: FxReservationRequest = {
      requestId: "fx:req:m5:" + tick + ":" + ordinal,
      payerKey, priority: -ordinal,
      fromCurrencyId: currencyId,
      toCurrencyId: quote.originCurrencyId,
      desiredOutputAmount: quote.sellerInvoiceSource,
      maxInputAmount: cash,
    };
    const group = byPool.get(quote.fxPairId) ?? [];
    group.push({ ordinal, quote, request });
    byPool.set(quote.fxPairId, group);
  }

  const spentByPayerCurrency = new Map<string, number>();
  // The same payer can reserve input in different FX pools. A rounded aggregate
  // must reconcile with the sum of the individual pool promises, not just fit
  // the opening wallet. Track rounding drift across ALL pools for each payer.
  const inputDriftByPayerCurrency = new Map<string, { sum: number; correction: number }>();
  const resulting = new Map<number, FxReservation>();
  for (const pairId of [...byPool.keys()].sort()) {
    const lots = byPool.get(pairId)!;
    const available = new Map<string, number>();
    for (const { request } of lots) {
      const key = fxPayerCurrencyKey(request.payerKey, request.fromCurrencyId);
      const opening = cashByPayerCurrency.get(key)!;
      const already = spentByPayerCurrency.get(key) ?? 0;
      const balance = opening - already;
      if (!Number.isFinite(balance) || balance < 0 ||
          (already > 0 && balance === opening)) {
        return fail("buyer input cash budget loses precision across FX pools");
      }
      available.set(key, balance);
    }
    const plan = reserveFxForPool(
      resolveCanonicalFxPool(world, pairId).pool,
      lots.map(lot => lot.request), available, tick,
    );
    const ordinalById = new Map(lots.map(lot =>
      [lot.request.requestId, lot] as const));
    for (const reservation of plan.reservations) {
      const lot = ordinalById.get(reservation.requestId);
      if (!lot) return fail("reservation has no matched lot");
      if (!allowPartialForPlanning &&
          (reservation.quote.feasibleOutputAmount !== lot.quote.sellerInvoiceSource ||
           Math.abs(reservation.quote.requiredInputForFeasibleOutput -
             lot.quote.goodsPaymentDest) > moneyEpsilon)) {
        return fail("FX liquidity requires quantity shrink and re-quote before dispatch");
      }
      resulting.set(lot.ordinal, reservation);
    }
    for (const [key, amount] of plan.reservedInputByPayerCurrency) {
      const prior = spentByPayerCurrency.get(key) ?? 0;
      const total = prior + amount;
      const opening = cashByPayerCurrency.get(key);
      // Error-free TwoSum: subtraction of the rounded total cannot reveal
      // lost low bits (1 + 1e16 rounds to 1e16). Match the fixed absolute
      // moneyEpsilon used by reserveFxForPool; never use a relative tolerance.
      const highAmount = total - prior;
      const reconstructedPrior = total - highAmount;
      const lostLowPart = (prior - reconstructedPrior) + (amount - highAmount);
      const roundingDrift = -lostLowPart;
      const previousDrift = inputDriftByPayerCurrency.get(key) ??
        { sum: 0, correction: 0 };
      // Neumaier compensation prevents individually sub-epsilon differences
      // accumulating into an unreconciled multi-pool money promise.
      const driftSum = previousDrift.sum + roundingDrift;
      const driftCorrection = previousDrift.correction +
        (Math.abs(previousDrift.sum) >= Math.abs(roundingDrift)
          ? (previousDrift.sum - driftSum) + roundingDrift
          : (roundingDrift - driftSum) + previousDrift.sum);
      if (opening === undefined || !Number.isFinite(total) || total > opening ||
          (amount > 0 && total === prior) ||
          !Number.isFinite(roundingDrift) ||
          Math.abs(roundingDrift) > moneyEpsilon ||
          !Number.isFinite(driftSum) || !Number.isFinite(driftCorrection) ||
          Math.abs(driftSum + driftCorrection) > moneyEpsilon) {
        return fail("cumulative FX payer reservation cannot reconcile across pools");
      }
      inputDriftByPayerCurrency.set(key, {
        sum: driftSum, correction: driftCorrection,
      });
      spentByPayerCurrency.set(key, total);
    }
  }
  return new Map([...resulting].sort(([a], [b]) => a - b));
}

/** Strict dispatch promises. Partially funded quotes are NEVER settlement inputs. */
export function reservePhase7QuotedFxLots(
  world: WorldState,
  tick: number,
  quotes: readonly Phase7ActualLotQuote[],
): ReadonlyMap<number, FxReservation> {
  return planPhase7QuotedFxLots(world, tick, quotes, false);
}

export interface Phase7FxScarcityCaps {
  /** True only when an actual FX lot could not be completely funded. */
  readonly requiresShrink: boolean;
  /** READ-ONLY aggregate output ceilings; replace only these FX keys upstream,
   * re-match and re-quote quantities BEFORE requesting strict reservations. */
  readonly reducedOutputByPairCurrency: ReadonlyMap<string, number>;
  /** Maximum feasible goods quantities per original matched FX lot. These are
   * indicative ceilings only, not approved dispatch lots or frozen prices. */
  readonly feasibleQuantityByLotOrdinal: ReadonlyMap<number, number>;
}

/**
 * Read-only M5 scarcity probe: use the SAME finite pool/payer allocation as the
 * strict reservation path, but expose reduced output ceilings rather than
 * pretending a partially funded original lot was accepted. The next planner
 * must rerun actor matching, tariff/fee/FX quotation, and strict reservations.
 *
 * This unit supplies the deterministic scarcity budgets; it deliberately does
 * NOT mutate the caller's plan or post any stock, money or shipment transition.
 */
export function assessPhase7QuotedFxScarcity(
  world: WorldState,
  tick: number,
  quotes: readonly Phase7ActualLotQuote[],
): Phase7FxScarcityCaps {
  const partial = planPhase7QuotedFxLots(world, tick, quotes, true);
  const epsilon = world.simulationConfig.numeric.moneyEpsilon!;
  const totals = new Map<string, { desired: number; feasible: number; partial: boolean }>();
  const feasibleQuantityByLotOrdinal = new Map<number, number>();

  const addExact = (previous: number, amount: number): number => {
    const next = previous + amount;
    const highAmount = next - previous;
    const reconstructedPrevious = next - highAmount;
    const lost = (previous - reconstructedPrevious) + (amount - highAmount);
    if (!Number.isFinite(next) || (amount > 0 && next === previous) ||
        !Number.isFinite(lost) || Math.abs(lost) > epsilon) {
      return fail("scarcity aggregate output cannot reconcile at money precision");
    }
    return next;
  };

  for (const [ordinal, quote] of quotes.entries()) {
    if (quote.fxPairId === null) continue;
    const promise = partial.get(ordinal);
    if (!promise) return fail("scarcity probe lacks a matched FX lot");
    const available = promise.quote.feasibleOutputAmount;
    const invoice = quote.sellerInvoiceSource;
    if (!Number.isFinite(available) || available < 0 || available > invoice) {
      return fail("scarcity probe has an invalid feasible output");
    }
    if (available === invoice &&
        Math.abs(promise.quote.requiredInputForFeasibleOutput -
          quote.goodsPaymentDest) > epsilon) {
      return fail("FX input quote mismatch cannot be fixed by shrinking quantity");
    }
    const originalQuantity = quote.lot.quantity;
    // Invoice / quantity is NOT the canonical source price: binary64 division
    // can round it DOWN. Shrinking against that reconstructed price may promise
    // more FX output than a real Phase-7 re-quote at the live source NET price.
    const sourceUnitPrice = quote.sourceSellerNetUnitPrice;
    if (!Number.isFinite(originalQuantity) || originalQuantity <= 0 ||
        !Number.isFinite(sourceUnitPrice) || sourceUnitPrice <= 0 ||
        originalQuantity * sourceUnitPrice !== invoice) {
      return fail("scarcity probe requires the canonical source unit price");
    }
    let quantity = originalQuantity;
    if (available < invoice) {
      quantity = Math.min(originalQuantity, available / sourceUnitPrice);
      if (!Number.isFinite(quantity) || quantity < 0) {
        return fail("scarcity probe cannot represent reduced goods quantity");
      }
      // Divide by the SAME canonical price used by actual re-quotation.
      // Floating division may still round the proposed quantity UP beyond the
      // pool promise. Move one representable float lower when necessary.
      if (quantity > 0 && quantity * sourceUnitPrice > available) {
        const bits = new DataView(new ArrayBuffer(8));
        bits.setFloat64(0, quantity, false);
        bits.setBigUint64(0, bits.getBigUint64(0, false) - 1n, false);
        quantity = bits.getFloat64(0, false);
      }
      if (quantity > 0 && quantity * sourceUnitPrice > available) {
        return fail("scarcity probe cannot round quantity down to FX output");
      }
    }
    feasibleQuantityByLotOrdinal.set(ordinal, quantity);
    const key = phase7FxOutputKey(quote.fxPairId, quote.originCurrencyId);
    const prior = totals.get(key) ?? { desired: 0, feasible: 0, partial: false };
    totals.set(key, {
      desired: addExact(prior.desired, invoice),
      feasible: addExact(prior.feasible, available),
      partial: prior.partial || available < invoice,
    });
  }
  const reduced = new Map<string, number>();
  for (const [key, value] of [...totals].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0)) {
    if (value.partial) {
      if (!(value.feasible < value.desired)) {
        return fail("scarcity output reduction was lost in aggregate rounding");
      }
      reduced.set(key, value.feasible);
    }
  }
  return {
    requiresShrink: reduced.size > 0,
    reducedOutputByPairCurrency: reduced,
    feasibleQuantityByLotOrdinal,
  };
}
