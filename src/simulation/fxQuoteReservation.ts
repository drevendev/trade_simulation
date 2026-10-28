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

/**
 * Each published FX aggregate must be replayable as its constituent money
 * reservations. Binary64 can round a nonzero debit UP (1e16 + 3 -> 1e16 + 4)
 * without disappearing; checking next !== previous misses that discrepancy.
 * Error-free TwoSum reconstructs the rounding residual on each addition.
 * Subtracting previous from the rounded next aggregate loses the low part
 * when a small reservation comes before a large one (3 + 1e16).
 * Compare both each low part and its compensated cumulative drift to the
 * Handoff/03 default fixed moneyEpsilon, never a relative tolerance.
 */
const FX_RESERVATION_MONEY_EPSILON = 1e-9;

interface ReservationDrift {
  readonly sum: number;
  readonly correction: number;
}

function assertReconciledReservationIncrement(
  driftByKey: Map<string, ReservationDrift>,
  key: string,
  previous: number,
  next: number,
  quoted: number,
  label: string,
): void {
  // Knuth TwoSum: next + exactLowPart == previous + quoted exactly as reals.
  // The subtraction (next - previous) - quoted can cancel a full-unit
  // overcount to zero when previous=3, quoted=1e16, next=1e16+4.
  const reconstructedQuoted = next - previous;
  const reconstructedPrevious = next - reconstructedQuoted;
  const exactLowPart = (previous - reconstructedPrevious) +
    (quoted - reconstructedQuoted);
  const drift = -exactLowPart;
  if (!Number.isFinite(drift) || Math.abs(drift) > FX_RESERVATION_MONEY_EPSILON) {
    throw new Error(`FX ${label} reservation cannot reconcile at money precision`);
  }
  const prior = driftByKey.get(key) ?? { sum: 0, correction: 0 };
  // Neumaier accumulation: sub-epsilon errors from individual accepted quotes
  // must not silently compound beyond one fixed absolute tolerance.
  const sum = prior.sum + drift;
  const correction = prior.correction + (Math.abs(prior.sum) >= Math.abs(drift)
    ? (prior.sum - sum) + drift
    : (drift - sum) + prior.sum);
  if (!Number.isFinite(sum) || !Number.isFinite(correction) ||
      Math.abs(sum + correction) > FX_RESERVATION_MONEY_EPSILON) {
    throw new Error(`FX ${label} cumulative reservation cannot reconcile at money precision`);
  }
  driftByKey.set(key, { sum, correction });
}

/**
 * Exact comparison of two finite nonnegative monetary obligations with stock.
 * Comparing just (output + floor) <= stock can lose a positive reserve floor
 * when IEEE-754 rounds that sum down to stock (e.g. 1e16 + 1 === 1e16).
 * TwoSum exposes the discarded low part without changing the money tolerance.
 */
function preservesFxPoolFloor(stock: number, floor: number, output: number): boolean {
  const total = output + floor;
  if (!Number.isFinite(total) || total > stock) return false;
  if (total < stock) return true;
  const reconstructedFloor = total - output;
  const reconstructedOutput = total - reconstructedFloor;
  const discarded = (output - reconstructedOutput) + (floor - reconstructedFloor);
  return discarded <= 0;
}

/** The immediately smaller positive binary64 value, without a relative haircut. */
function nextDownPositive(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error("FX output budget must be finite and positive");
  }
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, false);
  bits.setBigUint64(0, bits.getBigUint64(0, false) - 1n, false);
  return bits.getFloat64(0, false);
}

/** Conservatively round an unsafe stock-minus-floor budget DOWN by one ulp. */
function safeFxPoolOutputBudget(stock: number, floor: number): number {
  let budget = stock - floor;
  if (budget > 0 && !preservesFxPoolFloor(stock, floor, budget)) {
    budget = nextDownPositive(budget);
  }
  if (!Number.isFinite(budget) || budget < 0 ||
      !preservesFxPoolFloor(stock, floor, budget)) {
    throw new Error("FX output budget cannot preserve pool reserve floor at numeric precision");
  }
  return budget;
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
  const openingAvailable = safeFxPoolOutputBudget(stock, floor);
  if (priorReserved > openingAvailable ||
      !preservesFxPoolFloor(stock, floor, priorReserved)) {
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
      !preservesFxPoolFloor(stock, floor, priorReserved + feasible) ||
      (limits.maxInputAmount !== undefined && required > limits.maxInputAmount)) {
    throw new Error("FX quote would exceed cash/reserve or lose numeric precision");
  }
  // Underflow can erase the price of a positive output, minting a free FX
  // reservation even though both the spot and pool balances are finite.
  if (feasible > 0 && required === 0) {
    throw new Error("FX positive output has unrepresentable zero input cost");
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
  const inputDrift = new Map<string, ReservationDrift>();
  const outputDrift = new Map<string, ReservationDrift>();
  const pressureDrift = new Map<string, ReservationDrift>();
  const addPressure = (label: string, previous: number, quoted: number): number => {
    const next = previous + quoted;
    // Pressure is also a published monetary aggregate. A cross-actor sum
    // must not misstate its constituent fills even if payer keys differ.
    assertReconciledReservationIncrement(
      pressureDrift, label, previous, next, quoted, `pressure ${label}`,
    );
    return next;
  };
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
    const outputStock = pool.cash.get(request.toCurrencyId)!;
    const budgetOutput = safeFxPoolOutputBudget(outputStock, floor);
    if (nextInput > openingCash || nextOutput > budgetOutput ||
        !preservesFxPoolFloor(outputStock, floor, nextOutput) ||
        !Number.isFinite(nextInput) || !Number.isFinite(nextOutput) ||
        (quote.feasibleOutputAmount > 0 && !(quote.requiredInputForFeasibleOutput > 0)) ||
        (quote.requiredInputForFeasibleOutput > 0 && nextInput === alreadyInput) ||
        (quote.feasibleOutputAmount > 0 && nextOutput === alreadyOutput)) {
      throw new Error("FX reservation would overdraw or disappear at budget precision");
    }
    // Check observable aggregate deltas, not only whether an increment vanished.
    // A rounded-UP increment may otherwise promise more money than its quote.
    assertReconciledReservationIncrement(
      inputDrift, key, alreadyInput, nextInput,
      quote.requiredInputForFeasibleOutput, "payer input",
    );
    assertReconciledReservationIncrement(
      outputDrift, request.toCurrencyId, alreadyOutput, nextOutput,
      quote.feasibleOutputAmount, "pool output",
    );
    reservedInputs.set(key, nextInput);
    reservedOutputs.set(request.toCurrencyId, nextOutput);
    results.push({ requestId: request.requestId, payerKey: request.payerKey, quote });

    if (quote.direction === "BASE_TO_QUOTE") {
      desiredSupplyOfBase = addPressure(
        "desired supply of base", desiredSupplyOfBase, quote.requiredInputAmountAtDesiredOutput,
      );
      filledSupplyOfBase = addPressure(
        "filled supply of base", filledSupplyOfBase, quote.requiredInputForFeasibleOutput,
      );
    } else {
      desiredDemandForBase = addPressure(
        "desired demand for base", desiredDemandForBase, request.desiredOutputAmount,
      );
      filledDemandForBase = addPressure(
        "filled demand for base", filledDemandForBase, quote.feasibleOutputAmount,
      );
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
