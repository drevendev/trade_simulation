/** M5 / #675: reconcile real FX postings at Phase 11; publish quotes only at close.
 * Handoff/08 section 14 and M5-FX-CLOSE-001. No converter, liquidity injection or M7 policy.
 * Coefficients are explicit inputs, never guessed defaults or UI telemetry.
 */
import type { CurrencyId, MonetaryAuthorityId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import type { EconomicTransaction, TickContext } from "./tickOrchestrator";
import type { FxLedgerLeg } from "./fxSettlement";
import type { FxReservation } from "./fxQuoteReservation";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import type { FxLiquidityPoolState, WorldState } from "./worldState";

export interface FxClosePolicy {
  readonly flowPressureAlpha: number;
  readonly flowCoefficient: number;
  readonly reserveCoefficient: number;
  readonly maxAbsoluteLogMovePerTick: number;
}
interface PoolSnapshot {
  readonly owningAuthorityId: MonetaryAuthorityId;
  readonly pool: FxLiquidityPoolState;
}
export interface FxCloseOpening {
  readonly tick: number;
  readonly pools: readonly PoolSnapshot[];
  /** Exact diagnostic sums of binary64 stocks in units of 2^-1074. Not money storage. */
  readonly money: ReadonlyMap<CurrencyId, bigint>;
  readonly moneyEpsilon: number;
}
export interface FxPoolClose {
  readonly pairId: string;
  readonly owningAuthorityId: MonetaryAuthorityId;
  readonly baseCurrencyId: CurrencyId;
  readonly quoteCurrencyId: CurrencyId;
  readonly baseReserve: number;
  readonly quoteReserve: number;
  readonly desiredDemandForBase: number;
  readonly desiredSupplyOfBase: number;
  readonly filledDemandForBase: number;
  readonly filledSupplyOfBase: number;
  readonly netFlowPressure: number;
  readonly reserveImbalance: number;
  readonly previousFlowPressureEma: number;
  readonly nextFlowPressureEma: number;
  readonly currentSpot: number;
  readonly nextSpot: number;
  readonly logMove: number;
  readonly maxLogMove: number;
  readonly settlements: number;
}
export interface FxMonetaryClose {
  readonly tick: number;
  readonly activateTick: number;
  readonly pools: readonly FxPoolClose[];
  readonly fxJournal: string;
}
declare module "./tickOrchestrator" {
  interface TickContext {
    /** Detached actual Phase-7 reservation evidence, including unfilled reserved demand. */
    readonly phase7FxReservations?: readonly FxReservation[];
    /** Read-only Phase-11 result; not active quotes until Phase-15 publication. */
    readonly fxMonetaryClose?: FxMonetaryClose;
  }
}
function fail(reason: string): never { throw new Error(`M5 FX close: ${reason}`); }
const ordered = <T>(values: Iterable<T>, key: (v: T) => string): T[] =>
  [...values].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
function finite(value: number, name: string, minimum = 0, maximum = Number.MAX_VALUE): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail(`invalid ${name}`);
  return value;
}
/** Exact summation avoids registry-order cancellation and aggregate overflow.
 * It does not quantize, round, migrate or mutate any canonical wallet. */
function units(value: number): bigint {
  finite(value, "cash");
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value, false);
  const bits = bytes.getBigUint64(0, false);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  return exponent === 0 ? fraction : ((1n << 52n) | fraction) << BigInt(exponent - 1);
}
function liveMoney(world: WorldState): Map<CurrencyId, bigint> {
  const result = new Map<CurrencyId, bigint>();
  const add = (wallet: ReadonlyMap<CurrencyId, number>): void => {
    for (const [currency, amount] of wallet) {
      if (!world.currencies.has(currency)) fail("wallet names unknown currency");
      result.set(currency, (result.get(currency) ?? 0n) + units(amount));
    }
  };
  for (const actor of world.cohorts.values()) add(actor.wallet);
  for (const actor of world.productionUnits.values()) add(actor.wallet);
  for (const actor of world.clans.values()) add(actor.treasury);
  for (const actor of world.states.values()) add(actor.treasury);
  // M5 has no mutable MonetaryAuthority actor wallet. Genesis-only authority
  // endowments are constant, not a second representation of the live FX reserves.
  for (const authority of world.monetaryAuthorities.values()) {
    for (const pool of authority.fxPools.values()) add(pool.cash);
  }
  return result;
}
function checkMoney(opening: FxCloseOpening, world: WorldState): void {
  const current = liveMoney(world);
  const epsilon = units(opening.moneyEpsilon);
  for (const currency of new Set([...opening.money.keys(), ...current.keys()])) {
    const residual = (current.get(currency) ?? 0n) - (opening.money.get(currency) ?? 0n);
    if (residual > epsilon || residual < -epsilon) fail(`per-currency conservation mismatch: ${currency}`);
  }
}
function pools(world: WorldState): PoolSnapshot[] {
  const ids = new Set<string>();
  for (const authority of world.monetaryAuthorities.values()) {
    for (const id of authority.fxPools.keys()) {
      if (ids.has(id)) fail("duplicate pool ID");
      ids.add(id);
    }
  }
  const pairs = new Set<string>();
  return ordered(ids, String).map(id => {
    const location = resolveCanonicalFxPool(world, id);
    const p = location.pool;
    const pair = JSON.stringify([p.baseCurrencyId, p.quoteCurrencyId].sort());
    if (p.baseCurrencyId === p.quoteCurrencyId || pairs.has(pair)) fail("duplicate or identical currency pair");
    pairs.add(pair);
    if (!world.currencies.has(p.quoteCurrencyId)) fail("unknown quote currency");
    finite(p.spotRateQuotePerBase, "spot", Number.MIN_VALUE);
    finite(p.transactionSpread, "spread", 0, 1 - Number.EPSILON / 2);
    finite(p.targetBaseReserveShare, "target reserve share", 0, 1);
    finite(p.flowPressureEma, "flow EMA", -1, 1);
    finite(p.maxRateMovePerTick, "pool max log move");
    finite(p.minOperationalReserveBase, "base reserve floor");
    finite(p.minOperationalReserveQuote, "quote reserve floor");
    if (!p.cash.has(p.baseCurrencyId) || !p.cash.has(p.quoteCurrencyId)) fail("missing reserve currency");
    for (const [currency, value] of p.cash) {
      finite(value, "reserve");
      if (currency !== p.baseCurrencyId && currency !== p.quoteCurrencyId) fail("foreign reserve currency");
    }
    if (p.cash.get(p.baseCurrencyId)! < p.minOperationalReserveBase ||
        p.cash.get(p.quoteCurrencyId)! < p.minOperationalReserveQuote) fail("pool below reserve floor");
    return { owningAuthorityId: location.owningAuthorityId, pool: { ...p, cash: new Map(p.cash) } };
  });
}
export function captureFxCloseOpening(world: WorldState, tick: number): FxCloseOpening {
  if (!Number.isSafeInteger(tick) || tick < 0 || !Number.isSafeInteger(tick + 1)) fail("invalid tick");
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  if (moneyEpsilon === undefined) fail("missing canonical moneyEpsilon");
  finite(moneyEpsilon, "moneyEpsilon", Number.MIN_VALUE);
  return { tick, pools: pools(world), money: liveMoney(world), moneyEpsilon };
}
function sameTerms(a: PoolSnapshot, b: PoolSnapshot): boolean {
  const p = a.pool, q = b.pool;
  return a.owningAuthorityId === b.owningAuthorityId && p.pairId === q.pairId &&
    p.baseCurrencyId === q.baseCurrencyId && p.quoteCurrencyId === q.quoteCurrencyId &&
    p.spotRateQuotePerBase === q.spotRateQuotePerBase && p.transactionSpread === q.transactionSpread &&
    p.targetBaseReserveShare === q.targetBaseReserveShare && p.flowPressureEma === q.flowPressureEma &&
    p.maxRateMovePerTick === q.maxRateMovePerTick &&
    p.minOperationalReserveBase === q.minOperationalReserveBase &&
    p.minOperationalReserveQuote === q.minOperationalReserveQuote;
}
function fxLegs(transactions: readonly EconomicTransaction[], tick: number): FxLedgerLeg[] {
  const ids = new Set<string>();
  for (const tx of transactions) {
    if (ids.has(tx.transactionId)) fail("duplicate transaction ID");
    ids.add(tx.transactionId);
  }
  return ordered(transactions.filter(tx => tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT"),
    tx => `${tx.phase.toString().padStart(2, "0")}:${tx.transactionId}`).map(tx => {
    const leg = tx as FxLedgerLeg;
    if (leg.tick !== tick || !Number.isInteger(leg.phase) || leg.phase < 0 || leg.phase > 10 ||
        !leg.fxSettlementId || !leg.fxReservationRequestId || !leg.bundleId ||
        !leg.currencyId || !leg.fromAccount || !leg.toAccount) fail("incomplete or late FX ledger leg");
    finite(leg.moneyAmount, "posted FX money", Number.MIN_VALUE);
    if (leg.amount !== leg.moneyAmount) fail("FX amount disagrees with moneyAmount");
    if (leg.type === "FX_INPUT") {
      if (leg.fromAccount.type !== "ACTOR" || leg.toAccount.type !== "FX_POOL" ||
          !leg.source || actorRefKey(leg.source) !== actorRefKey(leg.fromAccount.actor)) fail("invalid FX input endpoints");
    } else {
      if (leg.fromAccount.type !== "FX_POOL" || leg.toAccount.type !== "ACTOR" ||
          !leg.destination || actorRefKey(leg.destination) !== actorRefKey(leg.toAccount.actor)) fail("invalid FX output endpoints");
    }
    return leg;
  });
}
function fingerprint(legs: readonly FxLedgerLeg[]): string {
  return JSON.stringify(legs.map(leg => [leg.transactionId, leg.tick, leg.phase, leg.type,
    leg.fxSettlementId, leg.fxReservationRequestId, leg.bundleId, leg.currencyId, leg.moneyAmount,
    leg.fromAccount.type === "ACTOR" ? actorRefKey(leg.fromAccount.actor)
      : [leg.fromAccount.owningAuthorityId, leg.fromAccount.pairId],
    leg.toAccount.type === "ACTOR" ? actorRefKey(leg.toAccount.actor)
      : [leg.toAccount.owningAuthorityId, leg.toAccount.pairId]]));
}
function signedPressure(demand: number, supply: number): number {
  const scale = Math.max(demand, supply);
  return scale === 0 ? 0 : (demand / scale - supply / scale) / (demand / scale + supply / scale);
}
function baseReserveShare(base: number, quote: number, spot: number): number {
  if (base === 0) return quote === 0 ? 0.5 : 0;
  if (quote === 0) return 1;
  // Value both sides at the SAME opening mid quote; logarithms avoid B*spot overflow.
  const ratioLog = Math.log(quote) - Math.log(base) - Math.log(spot);
  return ratioLog >= 0 ? Math.exp(-ratioLog) / (1 + Math.exp(-ratioLog)) : 1 / (1 + Math.exp(ratioLog));
}

/** A read-only Phase-11 plan. A rejected journal publishes no quotes or stocks. */
export function reconcileAndPlanFxClose(
  opening: FxCloseOpening, world: WorldState, context: TickContext, policy: FxClosePolicy,
): FxMonetaryClose {
  if (context.tick !== opening.tick || context.phase !== 11) fail("requires this tick's Phase 11");
  finite(policy.flowPressureAlpha, "flow alpha", 0, 1);
  finite(policy.flowCoefficient, "flow coefficient");
  finite(policy.reserveCoefficient, "reserve coefficient");
  finite(policy.maxAbsoluteLogMovePerTick, "max log move");
  const current = pools(world);
  if (current.length !== opening.pools.length || current.some((p, i) => !sameTerms(opening.pools[i]!, p))) {
    fail("pool membership, ownership or opening quote changed before close");
  }
  checkMoney(opening, world);
  const legs = fxLegs(context.transactions, context.tick);
  const groups = new Map<string, FxLedgerLeg[]>();
  for (const leg of legs) groups.set(leg.fxSettlementId, [...(groups.get(leg.fxSettlementId) ?? []), leg]);
  const reservations = new Map<string, FxReservation>();
  for (const reservation of context.phase7FxReservations ?? []) {
    if (reservation.tick !== context.tick || reservations.has(reservation.requestId)) fail("stale or duplicate reservation evidence");
    reservations.set(reservation.requestId, reservation);
  }
  const used = new Set<string>();
  const flows = new Map<string, { demand: number; supply: number; settlements: number; base: bigint; quote: bigint }>();
  for (const { pool } of opening.pools) flows.set(pool.pairId, { demand: 0, supply: 0, settlements: 0, base: 0n, quote: 0n });
  for (const group of groups.values()) {
    const input = group.find(leg => leg.type === "FX_INPUT");
    const output = group.find(leg => leg.type === "FX_OUTPUT");
    if (group.length !== 2 || !input || !output || input.bundleId !== output.bundleId ||
        input.phase !== output.phase || input.fxReservationRequestId !== output.fxReservationRequestId ||
        input.toAccount.type !== "FX_POOL" || output.fromAccount.type !== "FX_POOL" ||
        input.toAccount.pairId !== output.fromAccount.pairId ||
        input.toAccount.owningAuthorityId !== output.fromAccount.owningAuthorityId) fail("orphan or mismatched FX pair of legs");
    const pairId = input.toAccount.pairId;
    const location = opening.pools.find(p => p.pool.pairId === pairId);
    const flow = flows.get(pairId);
    if (!location || !flow || location.owningAuthorityId !== input.toAccount.owningAuthorityId) fail("unknown FX pool endpoint");
    const pool = location.pool;
    const baseToQuote = input.currencyId === pool.baseCurrencyId && output.currencyId === pool.quoteCurrencyId;
    const quoteToBase = input.currencyId === pool.quoteCurrencyId && output.currencyId === pool.baseCurrencyId;
    if (!baseToQuote && !quoteToBase) fail("FX legs name incorrect currencies");
    const expectedInput = baseToQuote
      ? output.moneyAmount / (pool.spotRateQuotePerBase * (1 - pool.transactionSpread))
      : output.moneyAmount * pool.spotRateQuotePerBase * (1 + pool.transactionSpread);
    if (!Number.isFinite(expectedInput) || Math.abs(expectedInput - input.moneyAmount) > opening.moneyEpsilon) fail("FX legs disagree with opening spot/spread");
    const reservation = reservations.get(input.fxReservationRequestId);
    if (!reservation || used.has(reservation.requestId) || reservation.quote.pairId !== pairId ||
        reservation.payerKey !== actorRefKey(input.source!) ||
        reservation.quote.direction !== (baseToQuote ? "BASE_TO_QUOTE" : "QUOTE_TO_BASE") ||
        reservation.quote.spotRate !== pool.spotRateQuotePerBase || reservation.quote.spread !== pool.transactionSpread ||
        input.moneyAmount > reservation.quote.requiredInputForFeasibleOutput + opening.moneyEpsilon ||
        output.moneyAmount > reservation.quote.feasibleOutputAmount + opening.moneyEpsilon) fail("FX settlement lacks a matching unspent reservation");
    used.add(reservation.requestId);
    flow.settlements += 1;
    if (baseToQuote) {
      flow.supply = finite(flow.supply + input.moneyAmount, "filled base supply");
      flow.base += units(input.moneyAmount); flow.quote -= units(output.moneyAmount);
    } else {
      flow.demand = finite(flow.demand + output.moneyAmount, "filled base demand");
      flow.base -= units(output.moneyAmount); flow.quote += units(input.moneyAmount);
    }
  }
  const desired = new Map<string, { demand: number; supply: number }>();
  for (const reservation of ordered(reservations.values(), r => r.requestId)) {
    const q = reservation.quote;
    const p = opening.pools.find(location => location.pool.pairId === q.pairId)?.pool;
    if (!p || q.spotRate !== p.spotRateQuotePerBase || q.spread !== p.transactionSpread) fail("reservation quote differs from opening pool");
    const flow = desired.get(q.pairId) ?? { demand: 0, supply: 0 };
    if (q.direction === "QUOTE_TO_BASE") flow.demand = finite(flow.demand + q.desiredOutputAmount, "desired base demand");
    else if (q.direction === "BASE_TO_QUOTE") flow.supply = finite(flow.supply + q.requiredInputAmountAtDesiredOutput, "desired base supply");
    else fail("unknown reservation direction");
    desired.set(q.pairId, flow);
  }
  const epsilon = units(opening.moneyEpsilon);
  const results = current.map((location, i): FxPoolClose => {
    const p = location.pool, before = opening.pools[i]!.pool, f = flows.get(p.pairId)!;
    const base = p.cash.get(p.baseCurrencyId)!, quote = p.cash.get(p.quoteCurrencyId)!;
    for (const [actual, prior, delta] of [
      [units(base), units(before.cash.get(p.baseCurrencyId)!), f.base],
      [units(quote), units(before.cash.get(p.quoteCurrencyId)!), f.quote],
    ]) {
      const residual = actual! - prior! - delta!;
      if (residual > epsilon || residual < -epsilon) fail(`pool cash does not match FX journal: ${p.pairId}`);
    }
    const pressure = signedPressure(f.demand, f.supply);
    const imbalance = p.targetBaseReserveShare - baseReserveShare(base, quote, p.spotRateQuotePerBase);
    // No actual exchange means no new price information, not a fabricated zero-rate signal.
    const nextEma = f.settlements === 0 ? p.flowPressureEma :
      (1 - policy.flowPressureAlpha) * p.flowPressureEma + policy.flowPressureAlpha * pressure;
    const raw = f.settlements === 0 ? 0 :
      policy.flowCoefficient * nextEma + policy.reserveCoefficient * imbalance;
    finite(raw, "raw log move", -Number.MAX_VALUE);
    const maxLogMove = Math.min(policy.maxAbsoluteLogMovePerTick, p.maxRateMovePerTick);
    const logMove = Math.min(maxLogMove, Math.max(-maxLogMove, raw));
    const nextSpot = finite(p.spotRateQuotePerBase * Math.exp(logMove), "next spot", Number.MIN_VALUE);
    return Object.freeze({ pairId: p.pairId, owningAuthorityId: location.owningAuthorityId,
      baseCurrencyId: p.baseCurrencyId, quoteCurrencyId: p.quoteCurrencyId,
      baseReserve: base, quoteReserve: quote,
      desiredDemandForBase: desired.get(p.pairId)?.demand ?? 0,
      desiredSupplyOfBase: desired.get(p.pairId)?.supply ?? 0,
      filledDemandForBase: f.demand, filledSupplyOfBase: f.supply,
      netFlowPressure: pressure, reserveImbalance: imbalance,
      previousFlowPressureEma: p.flowPressureEma, nextFlowPressureEma: nextEma,
      currentSpot: p.spotRateQuotePerBase, nextSpot, logMove, maxLogMove, settlements: f.settlements });
  });
  return Object.freeze({ tick: context.tick, activateTick: context.tick + 1,
    pools: Object.freeze(results), fxJournal: fingerprint(legs) });
}

/** Called after Phase-15 economic transitions. Only successor quote metadata changes. */
export function publishFxClose(
  opening: FxCloseOpening, world: WorldState, context: TickContext, close: FxMonetaryClose,
): WorldState {
  if (context.phase !== 15 || context.tick !== opening.tick || close.tick !== context.tick ||
      close.activateTick !== context.tick + 1) fail("invalid next-tick quote activation");
  if (fingerprint(fxLegs(context.transactions, context.tick)) !== close.fxJournal) fail("FX journal changed after Phase 11");
  checkMoney(opening, world);
  const current = pools(world);
  if (current.length !== close.pools.length || current.length !== opening.pools.length ||
      current.some((p, i) => !sameTerms(opening.pools[i]!, p))) fail("stale FX close");
  const authorities = new Map(world.monetaryAuthorities);
  const seenPairs = new Set<string>();
  for (const result of close.pools) {
    if (seenPairs.has(result.pairId)) fail("duplicate prospective close");
    seenPairs.add(result.pairId);
    finite(result.nextSpot, "prospective spot", Number.MIN_VALUE);
    finite(result.nextFlowPressureEma, "prospective EMA", -1, 1);
    const location = current.find(p => p.pool.pairId === result.pairId);
    if (!location || location.owningAuthorityId !== result.owningAuthorityId ||
        location.pool.baseCurrencyId !== result.baseCurrencyId ||
        location.pool.quoteCurrencyId !== result.quoteCurrencyId ||
        location.pool.spotRateQuotePerBase !== result.currentSpot ||
        location.pool.cash.get(result.baseCurrencyId) !== result.baseReserve ||
        location.pool.cash.get(result.quoteCurrencyId) !== result.quoteReserve) fail("pool cash changed after Phase 11");
    const authority = authorities.get(result.owningAuthorityId)!;
    const nextPools = new Map(authority.fxPools);
    nextPools.set(result.pairId, { ...location.pool,
      cash: authority.fxPools.get(result.pairId)!.cash,
      spotRateQuotePerBase: result.nextSpot, flowPressureEma: result.nextFlowPressureEma });
    authorities.set(authority.authorityId, { ...authority, fxPools: nextPools });
  }
  return { ...world, monetaryAuthorities: authorities };
}
