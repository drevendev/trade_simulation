/**
 * M5 / #673 — commit an owner-matched, pre-priced SAME-CURRENCY prepared
 * Phase-7 trade plan and derive Phase-8 residuals from actual settlements.
 *
 * This is an opt-in atomic boundary. All intermediate immutable WorldState,
 * cargo and journal revisions stay local until every planned lot and the
 * committed-only Phase-8 residual projection succeed. No M4 path is changed.
 *
 * Quote components are supplied by the current-tick policy/pricing owner;
 * this adapter NEVER guesses tariffs, fees, consumption taxes or FX. Mixed
 * currency opportunities with reservations must use a later FX coordinator.
 */
import type { RegionId, ShipmentId, StateId, TransportLinkId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import type { MarketIntent } from "./marketIntent";
import {
  projectPhase8CommittedTradeResiduals,
  type CommittedPhase7ShipmentLot,
} from "./phase7CommittedIntentResiduals";
import { settleSameCurrencyTradeDispatch } from "./phase7SameCurrencyDispatch";
import {
  preparePhase7TradePlan,
  type Phase7PreparedTradePlan,
  type Phase7PreparedTradePlanInput,
} from "./phase7TradePlan";
import type { TradeShipmentState } from "./tradeShipmentState";
import {
  createTransactionBundleId, type EconomicTransaction,
} from "./tickOrchestrator";
import type { WorldState } from "./worldState";

export interface Phase7SameCurrencyPriceTerms {
  /** Frozen current-tick, destination-currency charges; no implicit receiver. */
  readonly sellerNetUnitPrice: number;
  readonly transportFeePerUnitDest: number;
  readonly tariffPerUnitDest: number;
  readonly consumptionTaxPerUnitDest: number;
}

export interface Phase7SameCurrencyExecutionInput {
  readonly tick: number;
  readonly planInput: Phase7PreparedTradePlanInput;
  readonly termsByTradePlanId: ReadonlyMap<string, Phase7SameCurrencyPriceTerms>;
  /** Phase-1 effective jurisdiction, not mutable Phase-14 policy. */
  readonly effectiveJurisdictionByRegion: ReadonlyMap<RegionId, StateId | null>;
  /** Live residual AFTER earlier real Phase-7 commitments, not reservations. */
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  readonly priorTransactions: readonly EconomicTransaction[];
  /** Actual post-Phase-4 MAIN intent evidence; not provisional plan residuals. */
  readonly phase8MainIntents: readonly MarketIntent[];
}

export interface Phase7SameCurrencyExecutionResult {
  readonly world: WorldState;
  readonly prepared: Phase7PreparedTradePlan;
  readonly transactions: readonly EconomicTransaction[];
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  readonly committedLots: readonly CommittedPhase7ShipmentLot[];
  readonly phase8MainIntents: readonly MarketIntent[];
}

function invalid(reason: string): never {
  throw new Error("Phase-7 prepared same-currency execution: " + reason);
}

function nonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) invalid(field + " must be finite and nonnegative");
}

/**
 * Re-plan from current owner-supplied budgets, re-preflight every matched lot
 * against LIVE stock/cash/capacity and only project residual intents after
 * all returned shipment and economic journal evidence has been verified.
 */
export function executePreparedSameCurrencyTradePlan(
  openingWorld: WorldState,
  input: Phase7SameCurrencyExecutionInput,
): Phase7SameCurrencyExecutionResult {
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) invalid("invalid tick");
  if (!Array.isArray(input.priorTransactions)) invalid("missing committed journal");
  if (!(input.remainingCargoWeightByLink instanceof Map) ||
      !(input.effectiveJurisdictionByRegion instanceof Map) ||
      !(input.termsByTradePlanId instanceof Map)) {
    invalid("missing explicit live capacity, jurisdiction or quote map");
  }

  const prepared = preparePhase7TradePlan(
    openingWorld, openingWorld.simulationConfig, input.planInput,
  );
  const candidates = new Map(prepared.rankedCandidates.map((c) => [c.tradePlanId, c]));
  const quotes = new Map(input.planInput.opportunities.map((o) => [o.planId, o]));
  const quantityEpsilon = openingWorld.simulationConfig.numeric.quantityEpsilon;
  const moneyEpsilon = openingWorld.simulationConfig.numeric.moneyEpsilon;
  if (quantityEpsilon === undefined || moneyEpsilon === undefined ||
      !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0 ||
      !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0) {
    invalid("unresolved canonical numeric tolerances");
  }

  // Do not silently discard prepared FX trades when executing a same-currency
  // batch. In particular, reject BEFORE settling any earlier domestic lot.
  for (const reservation of prepared.aggregate.reservations) {
    if (reservation.allocatedQuantity <= 0) continue;
    const candidate = candidates.get(reservation.tradePlanId);
    if (!candidate || candidate.sourceCurrencyId !== candidate.destinationCurrencyId) {
      invalid("reserved cross-currency lot requires an FX coordinator");
    }
  }

  let world = openingWorld;
  let transactions: readonly EconomicTransaction[] = input.priorTransactions;
  let capacity: ReadonlyMap<TransportLinkId, number> = input.remainingCargoWeightByLink;
  const committed: CommittedPhase7ShipmentLot[] = [];

  for (const [ordinal, lot] of prepared.actorMatches.lots.entries()) {
    const candidate = candidates.get(lot.tradePlanId);
    const opportunity = quotes.get(lot.tradePlanId);
    const terms = input.termsByTradePlanId.get(lot.tradePlanId);
    if (!candidate || !opportunity || !terms) invalid("matched lot lacks frozen quote");
    if (candidate.sourceCurrencyId !== candidate.destinationCurrencyId) {
      invalid("cross-currency matched lot cannot use same-currency settlement");
    }
    nonnegative(terms.sellerNetUnitPrice, "seller net unit price");
    nonnegative(terms.transportFeePerUnitDest, "transport fee");
    nonnegative(terms.tariffPerUnitDest, "tariff");
    nonnegative(terms.consumptionTaxPerUnitDest, "consumption tax");
    if (terms.sellerNetUnitPrice !== candidate.sourceSellerNetUnitPrice) {
      invalid("settlement seller unit price differs from ranked candidate");
    }
    const unitGross = terms.sellerNetUnitPrice + terms.transportFeePerUnitDest +
      terms.tariffPerUnitDest + terms.consumptionTaxPerUnitDest;
    const expectedUnitGross = opportunity.landedGrossUnitCostDest;
    const tolerance = Math.min(moneyEpsilon,
      Number.EPSILON * Math.max(1, unitGross, expectedUnitGross));
    if (!Number.isFinite(unitGross) || unitGross <= 0 ||
        Math.abs(unitGross - expectedUnitGross) > tolerance) {
      invalid("actual charges disagree with planner's buyer gross quote");
    }
    const link = world.transportLinks.get(candidate.linkId);
    if (!link || link.travelTicks === undefined) invalid("missing travel-time evidence");
    const invoice = lot.quantity * terms.sellerNetUnitPrice;
    const fee = lot.quantity * terms.transportFeePerUnitDest;
    const tariff = lot.quantity * terms.tariffPerUnitDest;
    const tax = lot.quantity * terms.consumptionTaxPerUnitDest;
    const buyerGross = invoice + fee + tariff + tax;
    const plannedGross = lot.quantity * expectedUnitGross;
    if (![invoice, fee, tariff, tax, buyerGross, plannedGross].every(Number.isFinite) ||
        buyerGross <= 0 || Math.abs(buyerGross - plannedGross) > moneyEpsilon) {
      invalid("lot invoice or gross payment loses numeric precision");
    }
    const shipmentId = `sh:m5:${input.tick}:${candidate.tradePlanId}:${ordinal}` as ShipmentId;
    const bundleId = createTransactionBundleId(
      `tb:m5:${input.tick}:${candidate.tradePlanId}:${ordinal}`,
    );
    const shipment: TradeShipmentState = {
      id: shipmentId,
      originRegionId: candidate.originRegionId,
      destinationRegionId: candidate.destinationRegionId,
      transportLinkId: candidate.linkId,
      routeLinkIds: [candidate.linkId],
      goodId: candidate.goodId,
      quantity: lot.quantity,
      seller: lot.seller,
      buyer: lot.buyer,
      beneficialOwner: lot.buyer,
      destinationInventoryBucket: lot.buyerInventoryBucket,
      departureTick: input.tick,
      arrivalTick: input.tick + link.travelTicks,
      status: "IN_TRANSIT",
      invoiceCurrencyId: candidate.sourceCurrencyId,
      buyerPaymentCurrencyId: candidate.destinationCurrencyId,
      sellerNetUnitPrice: terms.sellerNetUnitPrice,
      buyerGoodsPaymentAmount: invoice,
      transportFeeAmount: fee,
      tariffAmount: tariff,
      consumptionTaxAmount: tax,
    };
    const settled = settleSameCurrencyTradeDispatch(world, {
      tick: input.tick, bundleId, shipment,
      sellerInventoryBucket: lot.sellerInventoryBucket,
      cargoWeightPerUnit: opportunity.cargoWeightPerUnit,
      phase1EligibleDirectedLinkIds: input.planInput.eligibleDirectedLinkIdsAtPhase1,
      effectiveJurisdictionByRegion: input.effectiveJurisdictionByRegion,
      remainingCargoWeightByLink: capacity,
      priorTransactions: transactions,
    });
    const persisted = settled.world.shipments?.get(shipmentId);
    const sales = settled.newTransactions.filter((tx) =>
      tx.bundleId === bundleId && tx.type === "TRADE_GOODS_SALE");
    const dispatches = settled.newTransactions.filter((tx) =>
      tx.bundleId === bundleId && tx.type === "SHIPMENT_DISPATCH");
    if (!persisted || sales.length !== 1 || dispatches.length !== 1 ||
        sales[0]!.quantity !== lot.quantity ||
        sales[0]!.goodId !== candidate.goodId ||
        actorRefKey(sales[0]!.source!) !== actorRefKey(lot.buyer) ||
        dispatches[0]!.quantity !== persisted.quantity ||
        actorRefKey(persisted.seller) !== actorRefKey(lot.seller) ||
        actorRefKey(persisted.buyer) !== actorRefKey(lot.buyer)) {
      invalid("atomic dispatch did not commit matching goods, shipment and journal");
    }
    const charged = settled.newTransactions
      .filter((tx) => tx.bundleId === bundleId &&
        ["TRADE_GOODS_SALE", "TRANSPORT_FEE", "IMPORT_TARIFF",
          "CONSUMPTION_TAX"].includes(tx.type))
      .reduce((sum, tx) => sum + (tx.moneyAmount ?? 0), 0);
    if (!Number.isFinite(charged) || Math.abs(charged - buyerGross) > moneyEpsilon) {
      invalid("committed buyer debit differs from gross settlement");
    }
    committed.push({
      shipmentId, sellerIntentId: lot.sellerIntentId,
      buyerIntentId: lot.buyerIntentId,
      originRegionId: candidate.originRegionId,
      destinationRegionId: candidate.destinationRegionId,
      goodId: candidate.goodId,
      dispatchedQuantity: lot.quantity,
      buyerTotalDebitDest: charged,
    });
    world = settled.world;
    transactions = settled.transactions;
    capacity = settled.remainingCargoWeightByLink;
  }
  const phase8MainIntents = projectPhase8CommittedTradeResiduals(
    input.phase8MainIntents, committed, { quantityEpsilon, moneyEpsilon },
  );
  return {
    world, prepared, transactions, remainingCargoWeightByLink: capacity,
    committedLots: committed, phase8MainIntents,
  };
}
