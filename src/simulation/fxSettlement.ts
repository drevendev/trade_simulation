/**
 * M5 #672 — one fail-atomic cross-currency settlement boundary.
 * Handoff/04 §§19–21: FX pool cash is a ledger endpoint, never an actor wallet.
 * Phase-7's reservation remains a promise until this returns a single
 * committed WorldState plus exactly two linked EconomicTransaction legs.
 *
 * This does not dispatch goods, charge tariffs, or change spot rates.
 */
import type { CurrencyId, MonetaryAuthorityId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { actorRefKey } from "../domain/genesisLedger";
import { quoteFxForPool, type FxReservation } from "./fxQuoteReservation";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { applyActorMoneyDeltas, readActorWallet } from "./marketSettlementTransition";
import {
  createTransactionId,
  type EconomicTransaction,
  type FxSettlementId,
  type TransactionBundleId,
} from "./tickOrchestrator";
import type { WorldState } from "./worldState";

/** Separate from ActorRef: an FX pool is not an economic actor. */
export type FxLedgerAccountRef =
  | { readonly type: "ACTOR"; readonly actor: ActorRef }
  | {
      readonly type: "FX_POOL";
      readonly owningAuthorityId: MonetaryAuthorityId;
      readonly pairId: string;
    };

export interface FxSettlementRequest {
  readonly settlementId: FxSettlementId;
  readonly payer: ActorRef;
  readonly recipient: ActorRef;
  readonly pairId: string;
  readonly inputCurrencyId: CurrencyId;
  readonly outputCurrencyId: CurrencyId;
  readonly desiredOutputAmount: number;
  readonly maxInputAmount: number;
  readonly purpose: "TRADE_GOODS" | "FOREIGN_BOND" | "OWNER_TRANSFER" | "OTHER_EXPLICIT_PAYMENT";
  readonly originatingBundleId: TransactionBundleId;
}

/**
 * Recipient contract acceptance cannot be inferred from an existing wallet
 * balance: an actor may legitimately own zero units of an accepted currency.
 */
export interface FxSettlementContext {
  readonly tick: number;
  readonly reservation: FxReservation;
  readonly recipientAcceptsOutputCurrency: boolean;
  readonly priorTransactions: readonly EconomicTransaction[];
}

export interface FxLedgerLeg extends EconomicTransaction {
  readonly type: "FX_INPUT" | "FX_OUTPUT";
  readonly bundleId: TransactionBundleId;
  readonly fxSettlementId: FxSettlementId;
  readonly currencyId: CurrencyId;
  readonly moneyAmount: number;
  readonly fromAccount: FxLedgerAccountRef;
  readonly toAccount: FxLedgerAccountRef;
}

export interface FxSettlementReceipt {
  readonly settlementId: FxSettlementId;
  readonly pairId: string;
  readonly inputCurrencyId: CurrencyId;
  readonly outputCurrencyId: CurrencyId;
  readonly inputAmount: number;
  readonly outputAmount: number;
  readonly desiredOutputAmount: number;
  readonly fillRatio: number;
  readonly spotRate: number;
  readonly spread: number;
  readonly reserveLimited: boolean;
}

export interface FxSettlementResult {
  readonly world: WorldState;
  readonly receipt: FxSettlementReceipt;
  readonly ledgerLegs: readonly [FxLedgerLeg, FxLedgerLeg];
  readonly transactions: readonly EconomicTransaction[];
}

function amount(value: number, name: string, positive = false): void {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error("settleFx: " + name + " must be finite and " +
      (positive ? "positive" : "nonnegative"));
  }
}

function requiredId(value: unknown, name: string, prefix?: string): void {
  if (typeof value !== "string" || !value.trim() ||
      (prefix !== undefined && !value.startsWith(prefix))) {
    throw new Error("settleFx: invalid " + name);
  }
}

/** A real observed balance change must equal the posted amount, not just
 * fall within a relative error that grows with a large opening balance. */
function checkedBalance(
  opening: number,
  delta: number,
  tolerance: number,
  label: string,
): number {
  amount(opening, label + " opening");
  if (!Number.isFinite(delta)) throw new Error("settleFx: nonfinite " + label + " delta");
  const closing = opening + delta;
  if (!Number.isFinite(closing) || closing < 0 ||
      Math.abs((closing - opening) - delta) > tolerance) {
    throw new Error("settleFx: " + label + " cannot post at money precision");
  }
  return closing;
}

/**
 * One pure, all-or-nothing FX conversion. The caller commits both returned
 * world and journal together; neither input is mutated, even on refusal.
 * No-fill from genuine budget/pool exhaustion is null (no legs), while
 * invalid contracts, stale reservations and numerical corruption throw.
 */
export function settleFx(
  world: WorldState,
  request: FxSettlementRequest,
  context: FxSettlementContext,
): FxSettlementResult | null {
  requiredId(request.settlementId, "settlementId", "fxs:");
  requiredId(request.pairId, "pairId");
  requiredId(request.originatingBundleId, "originatingBundleId", "tb:");
  if (!Number.isSafeInteger(context.tick) || context.tick < 0) {
    throw new Error("settleFx: tick must be a nonnegative safe integer");
  }
  if (!context.recipientAcceptsOutputCurrency) {
    throw new Error("settleFx: recipient does not accept output currency");
  }
  if (request.inputCurrencyId === request.outputCurrencyId) {
    throw new Error("settleFx: same-currency payment must use direct settlement");
  }
  if (!["TRADE_GOODS", "FOREIGN_BOND", "OWNER_TRANSFER", "OTHER_EXPLICIT_PAYMENT"]
    .includes(request.purpose)) {
    throw new Error("settleFx: unsupported payment purpose");
  }
  amount(request.desiredOutputAmount, "desiredOutputAmount", true);
  amount(request.maxInputAmount, "maxInputAmount");
  if (!Array.isArray(context.priorTransactions)) {
    throw new Error("settleFx: priorTransactions must be a committed journal");
  }
  const inputTxId = createTransactionId("tx:fx:" + request.settlementId + ":input");
  const outputTxId = createTransactionId("tx:fx:" + request.settlementId + ":output");
  if (context.priorTransactions.some((tx) =>
    tx.fxSettlementId === request.settlementId ||
    tx.transactionId === inputTxId || tx.transactionId === outputTxId)) {
    throw new Error("settleFx: duplicate settlement or transaction identity");
  }

  const payerKey = actorRefKey(request.payer);
  const reservation = context.reservation;
  const { owningAuthorityId, pool } = resolveCanonicalFxPool(world, request.pairId);
  const direction = request.inputCurrencyId === pool.baseCurrencyId &&
    request.outputCurrencyId === pool.quoteCurrencyId ? "BASE_TO_QUOTE" :
    request.inputCurrencyId === pool.quoteCurrencyId &&
    request.outputCurrencyId === pool.baseCurrencyId ? "QUOTE_TO_BASE" : null;
  if (!direction) throw new Error("settleFx: currencies do not match FX pair");

  if (!reservation || !reservation.requestId?.trim() ||
      reservation.payerKey !== payerKey ||
      reservation.quote.pairId !== request.pairId ||
      reservation.quote.direction !== direction ||
      reservation.quote.spotRate !== pool.spotRateQuotePerBase ||
      reservation.quote.spread !== pool.transactionSpread) {
    throw new Error("settleFx: missing, mismatched or stale Phase-7 reservation");
  }
  amount(reservation.quote.feasibleOutputAmount, "reserved output");
  amount(reservation.quote.requiredInputForFeasibleOutput, "reserved input");
  if (reservation.quote.feasibleOutputAmount > reservation.quote.desiredOutputAmount ||
      (reservation.quote.feasibleOutputAmount > 0 &&
       reservation.quote.requiredInputForFeasibleOutput === 0)) {
    throw new Error("settleFx: invalid reserved amount");
  }

  const payerCash = readActorWallet(world, request.payer).get(request.inputCurrencyId) ?? 0;
  const recipientCash = readActorWallet(world, request.recipient).get(request.outputCurrencyId) ?? 0;
  amount(payerCash, "payer input cash");
  amount(recipientCash, "recipient output cash");
  const maxInput = Math.min(
    request.maxInputAmount,
    reservation.quote.requiredInputForFeasibleOutput,
    payerCash,
  );
  const desired = Math.min(request.desiredOutputAmount, reservation.quote.feasibleOutputAmount);
  const quoted = quoteFxForPool(
    pool, request.inputCurrencyId, request.outputCurrencyId, desired,
    { maxInputAmount: maxInput },
  );
  const input = quoted.requiredInputForFeasibleOutput;
  const output = quoted.feasibleOutputAmount;
  if (output === 0) return null;
  if (input === 0 || input > maxInput ||
      input > reservation.quote.requiredInputForFeasibleOutput ||
      output > reservation.quote.feasibleOutputAmount) {
    throw new Error("settleFx: settlement exceeds its reservation");
  }

  // Optional in older fixtures; Handoff/03 fixes the baseline to 1e-9.
  const tolerance = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  amount(tolerance, "moneyEpsilon", true);
  const inputPoolBefore = pool.cash.get(request.inputCurrencyId);
  const outputPoolBefore = pool.cash.get(request.outputCurrencyId);
  if (inputPoolBefore === undefined || outputPoolBefore === undefined) {
    throw new Error("settleFx: missing live FX reserve");
  }
  const payerAfter = checkedBalance(payerCash, -input, tolerance, "payer debit");
  const inputPoolAfter = checkedBalance(inputPoolBefore, input, tolerance, "pool input credit");
  const outputPoolAfter = checkedBalance(outputPoolBefore, -output, tolerance, "pool output debit");
  const recipientAfter = checkedBalance(recipientCash, output, tolerance, "recipient credit");

  const floor = direction === "BASE_TO_QUOTE"
    ? pool.minOperationalReserveQuote : pool.minOperationalReserveBase;
  if (outputPoolAfter < floor) {
    throw new Error("settleFx: pool output would violate operational floor");
  }
  // Check each currency independently, using observed (binary64) stock deltas.
  if (Math.abs((payerAfter - payerCash) + (inputPoolAfter - inputPoolBefore)) > tolerance ||
      Math.abs((outputPoolAfter - outputPoolBefore) +
        (recipientAfter - recipientCash)) > tolerance) {
    throw new Error("settleFx: non-conserving observed currency transfer");
  }

  // Existing actor endpoint adapter owns wallet layout and shared preflight.
  // It constructs immutable maps; all numerical checks above happen first.
  const actorsUpdated = applyActorMoneyDeltas(world, [
    { actor: request.payer, currencyId: request.inputCurrencyId, delta: -input },
    { actor: request.recipient, currencyId: request.outputCurrencyId, delta: output },
  ], "settleFx");
  const authority = actorsUpdated.monetaryAuthorities.get(owningAuthorityId);
  if (!authority) throw new Error("settleFx: canonical owning authority disappeared");
  const nextCash = new Map(pool.cash);
  nextCash.set(request.inputCurrencyId, inputPoolAfter);
  nextCash.set(request.outputCurrencyId, outputPoolAfter);
  const nextAuthorities = new Map(actorsUpdated.monetaryAuthorities);
  nextAuthorities.set(owningAuthorityId, {
    ...authority,
    fxPools: new Map(authority.fxPools).set(request.pairId, {
      ...pool,
      cash: nextCash,
    }),
  });
  const committedWorld: WorldState = {
    ...actorsUpdated,
    monetaryAuthorities: nextAuthorities,
  };

  const actorIn: FxLedgerAccountRef = { type: "ACTOR", actor: request.payer };
  const actorOut: FxLedgerAccountRef = { type: "ACTOR", actor: request.recipient };
  const poolAccount: FxLedgerAccountRef = {
    type: "FX_POOL", owningAuthorityId, pairId: request.pairId,
  };
  const inputLeg: FxLedgerLeg = {
    tick: context.tick, phase: 7, type: "FX_INPUT",
    transactionId: inputTxId, bundleId: request.originatingBundleId,
    fxSettlementId: request.settlementId,
    source: request.payer,
    currencyId: request.inputCurrencyId,
    moneyAmount: input, amount: input,
    fromAccount: actorIn, toAccount: poolAccount,
    reason: request.purpose,
  };
  const outputLeg: FxLedgerLeg = {
    tick: context.tick, phase: 7, type: "FX_OUTPUT",
    transactionId: outputTxId, bundleId: request.originatingBundleId,
    fxSettlementId: request.settlementId,
    destination: request.recipient,
    currencyId: request.outputCurrencyId,
    moneyAmount: output, amount: output,
    fromAccount: poolAccount, toAccount: actorOut,
    reason: request.purpose,
  };
  const receipt: FxSettlementReceipt = {
    settlementId: request.settlementId,
    pairId: request.pairId,
    inputCurrencyId: request.inputCurrencyId,
    outputCurrencyId: request.outputCurrencyId,
    inputAmount: input,
    outputAmount: output,
    desiredOutputAmount: request.desiredOutputAmount,
    fillRatio: output / request.desiredOutputAmount,
    spotRate: pool.spotRateQuotePerBase,
    spread: pool.transactionSpread,
    reserveLimited: quoted.reserveLimited,
  };
  return {
    world: committedWorld,
    receipt,
    ledgerLegs: [inputLeg, outputLeg],
    transactions: [...context.priorTransactions, inputLeg, outputLeg],
  };
}
