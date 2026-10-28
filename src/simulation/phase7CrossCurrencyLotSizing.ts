/**
 * M5 / #673 — pure FX-constrained sizing of ONE cross-currency Phase-7 lot.
 *
 * A reservation is an upper bound, NOT permission to move goods or pay fees.
 * Reprice the smaller physical quantity against the live base-issuer-owned pool
 * and the buyer's opening destination-currency wallet. The eventual dispatch
 * must independently preflight/commit goods, settleFx exactly once, all explicit
 * fee/tax endpoints, transport capacity and the journal as one transition.
 *
 * This module never mutates WorldState, an FX reservation or a cash balance.
 */
import type { CurrencyId, RegionId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { quoteFxForPool, type FxQuote, type FxReservation } from "./fxQuoteReservation";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { readActorWallet } from "./marketSettlementTransition";
import { sumObservableTradeMoneyAmounts } from "./phase7TradeMoneyLegs";
import type { WorldState } from "./worldState";

export interface CrossCurrencyLotSizingRequest {
  readonly tick: number;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly buyer: ActorRef;
  readonly pairId: string;
  /** Maximum quantity from deterministic buyer/seller lot matching. */
  readonly plannedQuantity: number;
  /** Physical quantities/capacities after earlier committed bundles. */
  readonly sellerAvailableQuantity: number;
  readonly remainingCargoWeight: number;
  readonly cargoWeightPerUnit: number;
  readonly sourceSellerNetUnitPrice: number;
  /** Per-unit pre-authorized charges in DESTINATION currency. */
  readonly transportFeePerUnitDest: number;
  readonly tariffPerUnitDest: number;
  readonly consumptionTaxPerUnitDest: number;
  readonly reservation: FxReservation;
}

export interface CrossCurrencyLotSizing {
  readonly quantity: number;
  readonly sourceInvoiceAmount: number;
  readonly destinationGoodsFxInputAmount: number;
  readonly transportFeeAmountDest: number;
  readonly tariffAmountDest: number;
  readonly consumptionTaxAmountDest: number;
  readonly buyerGrossDebitDest: number;
  readonly inputCurrencyId: CurrencyId;
  readonly outputCurrencyId: CurrencyId;
  readonly quote: FxQuote;
  readonly reservationRequestId: string;
}

function invalid(reason: string): never {
  throw new Error("Phase-7 cross-currency lot sizing: " + reason);
}
function nonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) invalid(field + " must be finite and nonnegative");
}
function positive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) invalid(field + " must be finite and positive");
}

/** Move down one representable positive value on a tight boundary, rather
 * than a fixed percentage haircut that would arbitrarily waste FX supply. */
function nextDown(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
  return bits.getFloat64(0);
}

/**
 * Return null on genuine no-fill. A positive result is a PRE-FLIGHT sizing
 * candidate only; it must never be treated as a committed trade or FX receipt.
 */
export function sizeCrossCurrencyLotBeforeDispatch(
  world: WorldState,
  request: CrossCurrencyLotSizingRequest,
): CrossCurrencyLotSizing | null {
  if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
    return invalid("tick must be a nonnegative safe integer");
  }
  for (const key of ["plannedQuantity", "sellerAvailableQuantity", "remainingCargoWeight",
    "transportFeePerUnitDest", "tariffPerUnitDest", "consumptionTaxPerUnitDest"] as const) {
    nonnegative(request[key], key);
  }
  positive(request.cargoWeightPerUnit, "cargoWeightPerUnit");
  positive(request.sourceSellerNetUnitPrice, "sourceSellerNetUnitPrice");
  const origin = world.regions.get(request.originRegionId);
  const destination = world.regions.get(request.destinationRegionId);
  if (!origin || !destination || request.originRegionId === request.destinationRegionId) {
    return invalid("two distinct live regions are required");
  }
  const sourceCurrency = origin.settlementCurrencyId;
  const destinationCurrency = destination.settlementCurrencyId;
  if (sourceCurrency === destinationCurrency) {
    return invalid("same-currency lots must bypass FX");
  }
  const { pool } = resolveCanonicalFxPool(world, request.pairId);
  const direction = destinationCurrency === pool.baseCurrencyId &&
    sourceCurrency === pool.quoteCurrencyId ? "BASE_TO_QUOTE" :
    destinationCurrency === pool.quoteCurrencyId &&
    sourceCurrency === pool.baseCurrencyId ? "QUOTE_TO_BASE" : null;
  if (!direction) return invalid("FX pair does not match live regional currencies");
  const reservation = request.reservation;
  if (!reservation || reservation.tick !== request.tick ||
      !reservation.requestId?.trim() ||
      reservation.payerKey !== actorRefKey(request.buyer) ||
      reservation.quote.pairId !== request.pairId ||
      reservation.quote.direction !== direction ||
      reservation.quote.spotRate !== pool.spotRateQuotePerBase ||
      reservation.quote.spread !== pool.transactionSpread) {
    return invalid("stale or mismatched Phase-7 FX reservation");
  }
  nonnegative(reservation.quote.feasibleOutputAmount, "reserved FX output");
  nonnegative(reservation.quote.requiredInputForFeasibleOutput, "reserved FX input");
  if (reservation.quote.feasibleOutputAmount > reservation.quote.desiredOutputAmount ||
      (reservation.quote.feasibleOutputAmount > 0 &&
        reservation.quote.requiredInputForFeasibleOutput === 0)) {
    return invalid("invalid FX reservation bound");
  }
  const buyerCash = readActorWallet(world, request.buyer).get(destinationCurrency) ?? 0;
  nonnegative(buyerCash, "buyer opening destination cash");
  const epsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
  const minimumShipment = world.simulationConfig.trade.shipmentMinimumQuantity ?? 0;
  positive(epsilon, "quantityEpsilon");
  nonnegative(minimumShipment, "shipmentMinimumQuantity");
  const maximumQuantity = Math.min(
    request.plannedQuantity,
    request.sellerAvailableQuantity,
    request.remainingCargoWeight / request.cargoWeightPerUnit,
    reservation.quote.feasibleOutputAmount / request.sourceSellerNetUnitPrice,
  );
  if (!Number.isFinite(maximumQuantity) || maximumQuantity < 0) {
    return invalid("quantity cap is not representable");
  }
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  positive(moneyEpsilon, "moneyEpsilon");
  // Budget the ENTIRE per-unit FX input plus all independent fee/tax promises.
  // This analytical bound avoids converging slowly on a fee-constrained wallet.
  const unitFxInput = quoteFxForPool(
    pool, destinationCurrency, sourceCurrency, request.sourceSellerNetUnitPrice,
  ).requiredInputAmountAtDesiredOutput;
  const unitGross = sumObservableTradeMoneyAmounts([
    unitFxInput, request.transportFeePerUnitDest, request.tariffPerUnitDest,
    request.consumptionTaxPerUnitDest,
  ], moneyEpsilon);
  positive(unitGross, "destination unit gross");
  let quantity = Math.min(maximumQuantity, buyerCash / unitGross);
  // Each retry is strict monotonic shrink. If an IEEE-754 boundary does not
  // converge within a bounded number of re-quotes, fail closed, never dispatch.
  for (let attempt = 0; attempt < 24; attempt++) {
    if (quantity <= epsilon || quantity < minimumShipment) return null;
    const sourceInvoiceAmount = quantity * request.sourceSellerNetUnitPrice;
    const transportFeeAmountDest = quantity * request.transportFeePerUnitDest;
    const tariffAmountDest = quantity * request.tariffPerUnitDest;
    const consumptionTaxAmountDest = quantity * request.consumptionTaxPerUnitDest;
    positive(sourceInvoiceAmount, "source invoice");
    for (const [name, value] of [
      ["transport fee", transportFeeAmountDest],
      ["tariff", tariffAmountDest],
      ["consumption tax", consumptionTaxAmountDest],
    ] as const) nonnegative(value, name);
    if ((request.transportFeePerUnitDest > 0 && transportFeeAmountDest === 0) ||
        (request.tariffPerUnitDest > 0 && tariffAmountDest === 0) ||
        (request.consumptionTaxPerUnitDest > 0 && consumptionTaxAmountDest === 0)) {
      return invalid("positive per-unit charge vanished at numeric precision");
    }

    const quote = quoteFxForPool(pool, destinationCurrency, sourceCurrency,
      sourceInvoiceAmount, {
        maxInputAmount: Math.min(buyerCash, reservation.quote.requiredInputForFeasibleOutput),
      });
    // Never reinterpret an underfilled quote as a fully paid shipment.
    if (quote.feasibleOutputAmount < sourceInvoiceAmount) {
      if (quote.feasibleOutputAmount <= 0) return null;
      quantity = nextDown(Math.min(quantity, quote.feasibleOutputAmount /
        request.sourceSellerNetUnitPrice));
      continue;
    }
    if (quote.requiredInputForFeasibleOutput >
        reservation.quote.requiredInputForFeasibleOutput ||
        quote.feasibleOutputAmount > reservation.quote.feasibleOutputAmount) {
      return invalid("live quote exceeds the tick-local FX reservation");
    }
    const buyerGrossDebitDest = sumObservableTradeMoneyAmounts([
      quote.requiredInputForFeasibleOutput,
      transportFeeAmountDest, tariffAmountDest, consumptionTaxAmountDest,
    ], moneyEpsilon);
    if (buyerGrossDebitDest > buyerCash) {
      quantity = nextDown(quantity * (buyerCash / buyerGrossDebitDest));
      continue;
    }
    return {
      quantity, sourceInvoiceAmount,
      destinationGoodsFxInputAmount: quote.requiredInputForFeasibleOutput,
      transportFeeAmountDest, tariffAmountDest, consumptionTaxAmountDest,
      buyerGrossDebitDest, inputCurrencyId: destinationCurrency,
      outputCurrencyId: sourceCurrency, quote,
      reservationRequestId: reservation.requestId,
    };
  }
  return invalid("numerically unstable FX/fee quantity boundary");
}
