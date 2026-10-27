/**
 * M5 / Issue #671 — pure finite FX pool quotes and tick-local reservations.
 *
 * This operates on a caller-supplied snapshot of the one base-issuer-owned pool.
 * It does not create a second pool authority, move currency, post ledger legs,
 * or change the current-tick spot. The canonical WorldState adapter and
 * settleFx posting are separate downstream integration units.
 * Handoff/04 §§17–18, 21–22.
 */
import type { CurrencyId } from "../domain/id";

export interface FxQuotePoolSnapshot {
  readonly pairId: string;
  readonly baseCurrencyId: CurrencyId;
  readonly quoteCurrencyId: CurrencyId;
  readonly cash: ReadonlyMap<CurrencyId, number>;
  readonly spotRateQuotePerBase: number;
  readonly transactionSpread: number;
  readonly minOperationalReserveBase: number;
  readonly minOperationalReserveQuote: number;
}

export type FxDirection = "BASE_TO_QUOTE" | "QUOTE_TO_BASE";

export interface FxQuote {
  readonly pairId: string;
  readonly direction: FxDirection;
  readonly spotRate: number;
  readonly spread: number;
  readonly desiredOutputAmount: number;
  readonly requiredInputAmountAtDesiredOutput: number;
  readonly maxOutputByPoolReserve: number;
  readonly maxOutputByProvidedInput: number | null;
  readonly feasibleOutputAmount: number;
  readonly requiredInputForFeasibleOutput: number;
  readonly reserveLimited: boolean;
}

export interface FxQuoteLimits {
  readonly maxInputAmount?: number;
  /** Existing same-tick uncommitted promises against the output currency. */
  readonly reservedOutputAmount?: number;
}

export interface FxReservationRequest {
  readonly requestId: string;
  readonly payerKey: string;
  readonly priority: number;
  readonly fromCurrencyId: CurrencyId;
  readonly toCurrencyId: CurrencyId;
  readonly desiredOutputAmount: number;
  readonly maxInputAmount: number;
}

export interface FxReservation {
  readonly requestId: string;
  readonly payerKey: string;
  readonly quote: FxQuote;
}

export interface FxBaseFlowPressure {
  readonly desiredDemandForBase: number;
  readonly desiredSupplyOfBase: number;
  readonly filledDemandForBase: number;
  readonly filledSupplyOfBase: number;
}

export interface FxReservationPlan {
  readonly reservations: readonly FxReservation[];
  /** No canonical cash is changed; these maps describe promises only. */
  readonly reservedOutputByCurrency: ReadonlyMap<CurrencyId, number>;
  readonly reservedInputByPayerCurrency: ReadonlyMap<string, number>;
  readonly pressure: FxBaseFlowPressure;
}

export function fxPayerCurrencyKey(payerKey: string, currencyId: CurrencyId): string {
  return JSON.stringify([payerKey, currencyId]);
}

function finiteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(label + " must be finite and non-negative");
  }
}

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(label + " must be finite and positive");
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reject malformed canonical pool evidence rather than inventing a direction. */
export function validateFxQuotePool(pool: FxQuotePoolSnapshot): void {
  if (!pool || typeof pool.pairId !== "string" || !pool.pairId.trim()) {
    throw new Error("FX pool requires a nonempty pairId");
  }
  if (!pool.baseCurrencyId || !pool.quoteCurrencyId ||
      pool.baseCurrencyId === pool.quoteCurrencyId) {
    throw new Error("FX pool requires distinct explicit base/quote currencies");
  }
  if (!(pool.cash instanceof Map) || pool.cash.size !== 2 ||
      !pool.cash.has(pool.baseCurrencyId) || !pool.cash.has(pool.quoteCurrencyId)) {
    throw new Error("FX pool cash must contain exactly its base and quote currency");
  }
  finitePositive(pool.spotRateQuotePerBase, "FX spot");
  finiteNonnegative(pool.transactionSpread, "FX spread");
  if (pool.transactionSpread >= 1) throw new Error("FX spread must be less than one");
  finiteNonnegative(pool.minOperationalReserveBase, "FX base floor");
  finiteNonnegative(pool.minOperationalReserveQuote, "FX quote floor");
  for (const currency of [pool.baseCurrencyId, pool.quoteCurrencyId]) {
    finiteNonnegative(pool.cash.get(currency)!, "FX cash");
  }
  if (pool.cash.get(pool.baseCurrencyId)! < pool.minOperationalReserveBase ||
      pool.cash.get(pool.quoteCurrencyId)! < pool.minOperationalReserveQuote) {
    throw new Error("FX pool starts below an operational reserve floor");
  }
}

function directionOf(
  pool: FxQuotePoolSnapshot,
  fromCurrencyId: CurrencyId,
  toCurrencyId: CurrencyId,
): FxDirection {
  if (fromCurrencyId === pool.baseCurrencyId && toCurrencyId === pool.quoteCurrencyId) {
    return "BASE_TO_QUOTE";
  }
  if (fromCurrencyId === pool.quoteCurrencyId && toCurrencyId === pool.baseCurrencyId) {
    return "QUOTE_TO_BASE";
  }
  throw new Error("FX quote currencies do not match the explicit pool pair/direction");
}

/**
 * Exact Handoff/04 §18 quote convention:
 * base -> quote uses e*(1-s); quote -> base uses e*(1+s).
 * The optional input cap and prior output reservations only REDUCE the fill.
 */
export function quoteFxForPool(
  pool: FxQuotePoolSnapshot,
  fromCurrencyId: CurrencyId,
  toCurrencyId: CurrencyId,
  desiredOutputAmount: number,
  limits: FxQuoteLimits = {},
): FxQuote {
  validateFxQuotePool(pool);
  const direction = directionOf(pool, fromCurrencyId, toCurrencyId);
  finiteNonnegative(desiredOutputAmount, "desired FX output");
  if (limits.maxInputAmount !== undefined) {
    finiteNonnegative(limits.maxInputAmount, "FX max input");
  }
  const priorReserved = limits.reservedOutputAmount ?? 0;
  finiteNonnegative(priorReserved, "prior FX output reservation");

  const floor = direction === "BASE_TO_QUOTE"
    ? pool.minOperationalReserveQuote : pool.minOperationalReserveBase;
  const stock = pool.cash.get(toCurrencyId)!;
  const openingAvailable = stock - floor;
  if (priorReserved > openingAvailable) {
    throw new Error("prior FX reservations exceed the operational pool output");
  }
  const available = openingAvailable - priorReserved;
  if (priorReserved > 0 && available === openingAvailable) {
    throw new Error("FX reservation cannot be represented at pool precision");
  }

  const inputPerOutput = direction === "BASE_TO_QUOTE"
    ? 1 / (pool.spotRateQuotePerBase * (1 - pool.transactionSpread))
    : pool.spotRateQuotePerBase * (1 + pool.transactionSpread);
  finitePositive(inputPerOutput, "FX input per output");
  const requiredForDesired = desiredOutputAmount * inputPerOutput;
  finiteNonnegative(requiredForDesired, "required desired FX input");

  const maxByInput = limits.maxInputAmount === undefined
    ? null : limits.maxInputAmount / inputPerOutput;
  if (maxByInput !== null) finiteNonnegative(maxByInput, "input-limited FX output");
  let feasible = Math.min(desiredOutputAmount, available, maxByInput ?? Infinity);
  let required = feasible * inputPerOutput;
  finiteNonnegative(required, "required feasible FX input");

  // A round-trip division can overshoot the caller's cash cap by one ulp.
  if (limits.maxInputAmount !== undefined && required > limits.maxInputAmount) {
    feasible *= 1 - Number.EPSILON;
    required = feasible * inputPerOutput;
  }
  if (!Number.isFinite(feasible) || feasible < 0 ||
      !Number.isFinite(required) || required < 0 ||
      feasible > available ||
      (limits.maxInputAmount !== undefined && required > limits.maxInputAmount)) {
    throw new Error("FX quote would exceed cash/reserve or lose numeric precision");
  }

  return {
    pairId: pool.pairId,
    direction,
    spotRate: pool.spotRateQuotePerBase,
    spread: pool.transactionSpread,
    desiredOutputAmount,
    requiredInputAmountAtDesiredOutput: requiredForDesired,
    maxOutputByPoolReserve: available,
    maxOutputByProvidedInput: maxByInput,
    feasibleOutputAmount: feasible,
    requiredInputForFeasibleOutput: required,
    reserveLimited: available < desiredOutputAmount,
  };
}

/**
 * Deterministic pure Phase-7 plan: priority descending, requestId ascending.
 * One actor input budget is shared by every request from that payer/currency;
 * one output budget is shared by every request on that pool/direction.
 * Even opposing direction requests cannot spend newly expected pool receipts.
 */
export function reserveFxForPool(
  pool: FxQuotePoolSnapshot,
  requests: readonly FxReservationRequest[],
  openingInputCashByPayerCurrency: ReadonlyMap<string, number>,
): FxReservationPlan {
  validateFxQuotePool(pool);
  if (!(openingInputCashByPayerCurrency instanceof Map)) {
    throw new Error("FX reservation requires explicit actor input cash budgets");
  }
  const seen = new Set<string>();
  for (const request of requests) {
    if (typeof request.requestId !== "string" || !request.requestId.trim() ||
        seen.has(request.requestId) ||
        typeof request.payerKey !== "string" || !request.payerKey.trim()) {
      throw new Error("FX request IDs must be unique; payer keys must be nonempty");
    }
    seen.add(request.requestId);
    if (!Number.isFinite(request.priority)) throw new Error("FX priority must be finite");
    finitePositive(request.desiredOutputAmount, "FX request desired output");
    finiteNonnegative(request.maxInputAmount, "FX request max input");
    directionOf(pool, request.fromCurrencyId, request.toCurrencyId);
    const key = fxPayerCurrencyKey(request.payerKey, request.fromCurrencyId);
    if (!openingInputCashByPayerCurrency.has(key)) {
      throw new Error("missing FX payer cash budget for " + key);
    }
    finiteNonnegative(openingInputCashByPayerCurrency.get(key)!, "FX payer cash");
  }

  const reservedOutputs = new Map<CurrencyId, number>();
  const reservedInputs = new Map<string, number>();
  const results: FxReservation[] = [];
  let desiredDemandForBase = 0;
  let desiredSupplyOfBase = 0;
  let filledDemandForBase = 0;
  let filledSupplyOfBase = 0;

  for (const request of [...requests].sort((a, b) =>
    b.priority - a.priority || compare(a.requestId, b.requestId))) {
    const key = fxPayerCurrencyKey(request.payerKey, request.fromCurrencyId);
    const openingCash = openingInputCashByPayerCurrency.get(key)!;
    const alreadyInput = reservedInputs.get(key) ?? 0;
    const remainingInput = openingCash - alreadyInput;
    if (remainingInput < 0) throw new Error("FX payer reservation overdraw");
    const quote = quoteFxForPool(
      pool,
      request.fromCurrencyId,
      request.toCurrencyId,
      request.desiredOutputAmount,
      {
        maxInputAmount: Math.min(request.maxInputAmount, remainingInput),
        reservedOutputAmount: reservedOutputs.get(request.toCurrencyId) ?? 0,
      },
    );
    const nextInput = alreadyInput + quote.requiredInputForFeasibleOutput;
    const alreadyOutput = reservedOutputs.get(request.toCurrencyId) ?? 0;
    const nextOutput = alreadyOutput + quote.feasibleOutputAmount;
    const floor = request.toCurrencyId === pool.baseCurrencyId
      ? pool.minOperationalReserveBase : pool.minOperationalReserveQuote;
    const budgetOutput = pool.cash.get(request.toCurrencyId)! - floor;
    if (nextInput > openingCash || nextOutput > budgetOutput ||
        !Number.isFinite(nextInput) || !Number.isFinite(nextOutput) ||
        (quote.requiredInputForFeasibleOutput > 0 && nextInput === alreadyInput) ||
        (quote.feasibleOutputAmount > 0 && nextOutput === alreadyOutput)) {
      throw new Error("FX reservation would overdraw or disappear at budget precision");
    }
    reservedInputs.set(key, nextInput);
    reservedOutputs.set(request.toCurrencyId, nextOutput);
    results.push({ requestId: request.requestId, payerKey: request.payerKey, quote });

    if (quote.direction === "BASE_TO_QUOTE") {
      desiredSupplyOfBase += quote.requiredInputAmountAtDesiredOutput;
      filledSupplyOfBase += quote.requiredInputForFeasibleOutput;
    } else {
      desiredDemandForBase += request.desiredOutputAmount;
      filledDemandForBase += quote.feasibleOutputAmount;
    }
  }
  for (const v of [desiredDemandForBase, desiredSupplyOfBase, filledDemandForBase, filledSupplyOfBase]) {
    finiteNonnegative(v, "FX pressure");
  }
  return {
    reservations: results,
    reservedOutputByCurrency: reservedOutputs,
    reservedInputByPayerCurrency: reservedInputs,
    pressure: {
      desiredDemandForBase,
      desiredSupplyOfBase,
      filledDemandForBase,
      filledSupplyOfBase,
    },
  };
}
