/**
 * M5 / #673: re-quote concrete Phase-7 matched lots at their ACTUAL quantity.
 *
 * This is a read-only final-price preflight after owner-bound planning and
 * actor matching, not a dispatch receipt. Neither the estimated one-unit
 * transport charge nor a caller-supplied FX/landed price can authorize a debit.
 * The later atomic dispatcher must revalidate the returned owners and balances
 * immediately before committing any stock, cash or shipment transition.
 */
import type { CurrencyId, StateId } from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import { phase7BuyerActorCashKey, type Phase7ActorMatchLot } from "./phase7IntentMatching";
import { phase7ConsumptionTaxKey, buildPhase7LiveWorldPlanInput,
  type Phase7LivePricingContext, type Phase7LiveWorldPlanInput } from "./phase7LiveWorldPlan";
import { phase7FxOutputKey } from "./phase7AggregateReservation";
import { preparePhase7TradePlan, type Phase7PreparedTradePlan } from "./phase7TradePlan";
import { quoteTransportFee } from "./transportFeeQuote";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import type { WorldState } from "./worldState";

export interface Phase7ActualLotQuote {
  readonly lot: Phase7ActorMatchLot;
  readonly originCurrencyId: CurrencyId;
  readonly destinationCurrencyId: CurrencyId;
  readonly destinationTreasuryStateId: StateId | null;
  readonly transportFeeReceiver: ActorRef | null;
  readonly fxPairId: string | null;
  /** Source-currency seller receipt, and FX output for cross-currency lots. */
  readonly sellerInvoiceSource: number;
  /** Destination-currency input to FX (or direct seller payment if same currency). */
  readonly goodsPaymentDest: number;
  readonly invoiceMidDest: number;
  readonly transportFeeDest: number;
  readonly importTariffDest: number;
  readonly consumptionTaxDest: number;
  readonly buyerDebitDest: number;
}

export interface Phase7ActualLotQuoteResult {
  readonly preparedPlan: Phase7PreparedTradePlan;
  readonly quotes: readonly Phase7ActualLotQuote[];
}

function finiteNonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Phase-7 actual lot " + name + " must be finite and non-negative");
  }
  return value;
}
function positive(value: number, name: string): number {
  if (finiteNonnegative(value, name) === 0) {
    throw new Error("Phase-7 actual lot " + name + " must be positive");
  }
  return value;
}

/** Preserve the fixed absolute money tolerance when staging multiple lots. */
function consume(balance: number, debit: number, tolerance: number, label: string): number {
  finiteNonnegative(balance, label + " balance");
  finiteNonnegative(debit, label + " debit");
  if (debit > balance) throw new Error("Phase-7 actual lot " + label + " budget exceeded");
  if (debit === 0) return balance;
  const next = balance - debit;
  if (next === balance || next < 0 || !Number.isFinite(next) ||
      Math.abs((balance - next) - debit) > tolerance) {
    throw new Error("Phase-7 actual lot " + label + " lost numeric precision");
  }
  return next;
}

/**
 * Compute financially exact, whole-lot fee/tax/FX previews in accepted match
 * order. Prices are freshly rebuilt from live canonical owners; no external
 * prepared plan or economic quote is trusted. A plan that only fits the
 * approximate per-unit cash/FX ceilings fails closed and must be resized
 * upstream before dispatch rather than spending more than its reservation.
 *
 * All debits here affect temporary maps only. In particular, this function
 * must never be mistaken for settleFx, a treasury credit or a goods movement.
 */
export function quotePhase7ActualMatchedLots(
  world: WorldState,
  context: Phase7LivePricingContext,
  input: Phase7LiveWorldPlanInput,
): Phase7ActualLotQuoteResult {
  const built = buildPhase7LiveWorldPlanInput(world, context, input);
  const preparedPlan = preparePhase7TradePlan(world, world.simulationConfig, built);
  const byPlan = new Map(built.opportunities.map(q => [q.planId, q]));
  const walletRemaining = new Map(built.actorBudgets.buyerCashByActorCurrency);
  const spendRemaining = new Map(input.residualIntents
    .filter(entry => entry.intent.side === "BUY")
    .map(entry => [entry.intent.id, entry.remainingBuyerSpend!] as const));
  const buyerIntentById = new Map(input.residualIntents
    .filter(entry => entry.intent.side === "BUY")
    .map(entry => [entry.intent.id, entry.intent] as const));
  const outputRemaining = new Map(built.aggregateBudgets.fxOutputByPairCurrency);
  const outputReserved = new Map<string, number>();
  const perPlan = new Map<string, { quantity: number; buyerDebit: number }>();
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon;
  if (moneyEpsilon === undefined || !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0 ||
      quantityEpsilon === undefined || !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0) {
    throw new Error("Phase-7 actual lot requires resolved money and quantity epsilons");
  }

  const quotes: Phase7ActualLotQuote[] = [];
  for (const lot of preparedPlan.actorMatches.lots) {
    const quote = byPlan.get(lot.tradePlanId);
    const buyerIntent = buyerIntentById.get(lot.buyerIntentId);
    if (!quote || !buyerIntent || buyerIntent.actor.type !== lot.buyer.type ||
        buyerIntent.regionId !== quote.destinationRegionId ||
        buyerIntent.goodId !== quote.goodId) {
      throw new Error("Phase-7 actual lot lacks owner-matched route or buyer intent");
    }
    const origin = world.regions.get(quote.originRegionId);
    const destination = world.regions.get(quote.destinationRegionId);
    const link = world.transportLinks.get(quote.linkId);
    if (!origin || !destination || !link ||
        link.fromRegionId !== origin.regionId || link.toRegionId !== destination.regionId) {
      throw new Error("Phase-7 actual lot has no canonical directed transport link");
    }
    const quantity = positive(lot.quantity, "quantity");
    const sellerInvoiceSource = positive(
      quantity * quote.sourceSellerNetUnitPrice, "seller invoice",
    );
    const fee = quoteTransportFee(
      world, link, quantity, quote.cargoWeightPerUnit,
      world.simulationConfig, context.transportFeeCostPolicy!,
    );
    if (fee.destinationCurrencyId !== destination.settlementCurrencyId) {
      throw new Error("Phase-7 actual lot transport fee currency mismatch");
    }
    const transportFeeDest = finiteNonnegative(fee.amount, "transport fee");

    const originCurrencyId = origin.settlementCurrencyId;
    const destinationCurrencyId = destination.settlementCurrencyId;
    let goodsPaymentDest = sellerInvoiceSource;
    let invoiceMidDest = sellerInvoiceSource;
    let fxPairId: string | null = null;
    if (originCurrencyId !== destinationCurrencyId) {
      const pair = built.fxPairIdByTradePlanId?.get(lot.tradePlanId);
      if (!pair) throw new Error("Phase-7 actual lot missing canonical FX pair");
      const key = phase7FxOutputKey(pair, originCurrencyId);
      const remaining = outputRemaining.get(key);
      if (remaining === undefined) {
        throw new Error("Phase-7 actual lot missing canonical FX output budget");
      }
      const already = outputReserved.get(key) ?? 0;
      // Use the live pool's operational floor plus our own earlier lot
      // promises; tick-local prior reservations are a separate stricter cap.
      const fx = quoteFx(
        world, pair, destinationCurrencyId, originCurrencyId,
        sellerInvoiceSource, { reservedOutputAmount: already },
      );
      if (fx.feasibleOutputAmount < sellerInvoiceSource ||
          sellerInvoiceSource > remaining) {
        throw new Error("Phase-7 actual lot requires FX quantity shrink before dispatch");
      }
      goodsPaymentDest = positive(
        fx.requiredInputAmountAtDesiredOutput, "FX input",
      );
      const pool = resolveCanonicalFxPool(world, pair).pool;
      invoiceMidDest = pool.baseCurrencyId === originCurrencyId
        ? sellerInvoiceSource * pool.spotRateQuotePerBase
        : sellerInvoiceSource / pool.spotRateQuotePerBase;
      positive(invoiceMidDest, "MID invoice");
      outputRemaining.set(
        key, consume(remaining, sellerInvoiceSource, moneyEpsilon, "FX output"),
      );
      const nextReserved = already + sellerInvoiceSource;
      if (!Number.isFinite(nextReserved) || nextReserved === already ||
          Math.abs((nextReserved - already) - sellerInvoiceSource) > moneyEpsilon) {
        throw new Error("Phase-7 actual lot cumulative FX reservation lost precision");
      }
      outputReserved.set(key, nextReserved);
      fxPairId = pair;
    }

    const destinationTreasuryStateId = destination.controllerStateId;
    let importTariffDest = 0;
    let consumptionTaxDest = 0;
    if (destinationTreasuryStateId !== null) {
      const taxes = context.phase1ConsumptionTaxes;
      const rate = taxes?.ratesByDestinationStateGood.get(
        phase7ConsumptionTaxKey(destinationTreasuryStateId, quote.goodId),
      );
      const efficiency = taxes?.collectionEfficiencyByState.get(destinationTreasuryStateId);
      if (taxes?.tick !== context.tick || rate === undefined || efficiency === undefined ||
          !Number.isFinite(rate) || rate < 0 || rate > 1 ||
          !Number.isFinite(efficiency) || efficiency < 0 || efficiency > 1) {
        throw new Error("Phase-7 actual lot missing current destination tax policy");
      }
      importTariffDest = finiteNonnegative(
        (invoiceMidDest + transportFeeDest) * quote.estimatedTariffRate * efficiency,
        "import tariff",
      );
      const exempt = buyerIntent.actor.type === "STATE" &&
        buyerIntent.actor.stateId === destinationTreasuryStateId &&
        buyerIntent.purpose === "PUBLIC_PROCUREMENT";
      consumptionTaxDest = exempt ? 0 : finiteNonnegative(
        invoiceMidDest * rate * efficiency, "consumption tax",
      );
    } else if (quote.estimatedTariffRate !== 0) {
      throw new Error("Phase-7 actual lot cannot charge a tariff without treasury");
    }
    const buyerDebitDest = positive(
      goodsPaymentDest + transportFeeDest + importTariffDest + consumptionTaxDest,
      "buyer debit",
    );
    if ((transportFeeDest + importTariffDest + consumptionTaxDest > 0 &&
         buyerDebitDest === goodsPaymentDest) ||
        Math.abs(buyerDebitDest - quote.landedGrossUnitCostDest * quantity) > moneyEpsilon) {
      throw new Error("Phase-7 actual lot does not reconcile reserved landed cash");
    }

    const cashKey = phase7BuyerActorCashKey(lot.buyer, destinationCurrencyId);
    const wallet = walletRemaining.get(cashKey);
    const spend = spendRemaining.get(lot.buyerIntentId);
    if (wallet === undefined || spend === undefined) {
      throw new Error("Phase-7 actual lot missing buyer money authority");
    }
    walletRemaining.set(cashKey, consume(wallet, buyerDebitDest, moneyEpsilon, "buyer wallet"));
    spendRemaining.set(
      lot.buyerIntentId, consume(spend, buyerDebitDest, moneyEpsilon, "buyer intent spend"),
    );
    const prior = perPlan.get(lot.tradePlanId) ?? { quantity: 0, buyerDebit: 0 };
    perPlan.set(lot.tradePlanId, {
      quantity: prior.quantity + quantity,
      buyerDebit: prior.buyerDebit + buyerDebitDest,
    });
    quotes.push({
      lot, originCurrencyId, destinationCurrencyId, destinationTreasuryStateId,
      transportFeeReceiver: fee.receiver, fxPairId, sellerInvoiceSource,
      goodsPaymentDest, invoiceMidDest, transportFeeDest,
      importTariffDest, consumptionTaxDest, buyerDebitDest,
    });
  }

  for (const reservation of preparedPlan.aggregate.reservations) {
    const actual = perPlan.get(reservation.tradePlanId) ?? { quantity: 0, buyerDebit: 0 };
    if (!Number.isFinite(actual.quantity) || !Number.isFinite(actual.buyerDebit) ||
        Math.abs(actual.quantity - reservation.allocatedQuantity) > quantityEpsilon ||
        Math.abs(actual.buyerDebit - reservation.buyerCashReservedDest) > moneyEpsilon) {
      throw new Error("Phase-7 actual lot bundle cannot reconcile aggregate reservation");
    }
  }
  return { preparedPlan, quotes };
}
