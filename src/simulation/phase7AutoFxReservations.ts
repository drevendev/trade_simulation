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
 * Only full, financially representable promises are accepted. A partial
 * feasible FX output must be shrunk before matched-lot quoting and settlement.
 */
export function reservePhase7QuotedFxLots(
  world: WorldState,
  tick: number,
  quotes: readonly Phase7ActualLotQuote[],
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
      if (reservation.quote.feasibleOutputAmount !== lot.quote.sellerInvoiceSource ||
          Math.abs(reservation.quote.requiredInputForFeasibleOutput -
            lot.quote.goodsPaymentDest) > moneyEpsilon) {
        return fail("FX liquidity requires quantity shrink and re-quote before dispatch");
      }
      resulting.set(lot.ordinal, reservation);
    }
    for (const [key, amount] of plan.reservedInputByPayerCurrency) {
      const prior = spentByPayerCurrency.get(key) ?? 0;
      const total = prior + amount;
      const opening = cashByPayerCurrency.get(key);
      if (opening === undefined || !Number.isFinite(total) || total > opening ||
          (amount > 0 && total === prior) ||
          Math.abs((total - prior) - amount) > moneyEpsilon) {
        return fail("cumulative FX payer reservation cannot reconcile across pools");
      }
      spentByPayerCurrency.set(key, total);
    }
  }
  return new Map([...resulting].sort(([a], [b]) => a - b));
}
