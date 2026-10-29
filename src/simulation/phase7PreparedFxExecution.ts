/**
 * M5 / #673 — fail-atomic execution of prepared cross-currency Phase-7 lots.
 *
 * Only REAL shipment, payment and FX journal receipts reduce Phase-8 intents.
 * Caller owns the frozen Phase-1 price/fee policy and one tick-local FX
 * reservation per concrete actor lot. This adapter never invents policy,
 * reconstructs reservations or changes the existing same-currency path.
 *
 * The FX-only public entry point still rejects mixed batches. The opt-in
 * mixed entry point shares one ordered LIVE-state execution and Phase-8 commit.
 */
import type { RegionId, ShipmentId, StateId, TransportLinkId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import type { MarketIntent } from "./marketIntent";
import {
  projectPhase8CommittedTradeResiduals,
  type CommittedPhase7ShipmentLot,
} from "./phase7CommittedIntentResiduals";
import { settleCrossCurrencyTradeDispatch } from "./phase7CrossCurrencyDispatch";
import { settleSameCurrencyTradeDispatch } from "./phase7SameCurrencyDispatch";
import type { Phase7SameCurrencyPriceTerms } from "./phase7PreparedSameCurrencyExecution";
import type { TradeShipmentState } from "./tradeShipmentState";
import type { FxReservation } from "./fxQuoteReservation";
import { quoteFxForPool } from "./fxQuoteReservation";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import {
  preparePhase7TradePlan,
  type Phase7PreparedTradePlan,
  type Phase7PreparedTradePlanInput,
} from "./phase7TradePlan";
import {
  createFxSettlementId, createTransactionBundleId,
  type EconomicTransaction,
} from "./tickOrchestrator";
import type { WorldState } from "./worldState";

export interface Phase7FxPriceTerms {
  readonly sourceSellerNetUnitPrice: number;
  readonly transportFeePerUnitDest: number;
  readonly tariffPerUnitDest: number;
  readonly consumptionTaxPerUnitDest: number;
}

export interface Phase7PreparedFxExecutionInput {
  readonly tick: number;
  readonly planInput: Phase7PreparedTradePlanInput;
  readonly termsByTradePlanId: ReadonlyMap<string, Phase7FxPriceTerms>;
  /** Index into prepared.actorMatches.lots, not into caller insertion order. */
  readonly fxReservationByLotOrdinal: ReadonlyMap<number, FxReservation>;
  readonly effectiveJurisdictionByRegion: ReadonlyMap<RegionId, StateId | null>;
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  readonly priorTransactions: readonly EconomicTransaction[];
  readonly phase8MainIntents: readonly MarketIntent[];
}

/** Same ranked plan, shared live wallets/cargo/FX, and one all-or-nothing return. */
export interface Phase7PreparedMixedExecutionInput extends Phase7PreparedFxExecutionInput {
  /** Quotes for domestic matched lots only. FX quotes retain their own map. */
  readonly sameCurrencyTermsByTradePlanId: ReadonlyMap<string, Phase7SameCurrencyPriceTerms>;
}

export interface Phase7PreparedFxExecutionResult {
  readonly world: WorldState;
  readonly prepared: Phase7PreparedTradePlan;
  readonly transactions: readonly EconomicTransaction[];
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  readonly committedLots: readonly CommittedPhase7ShipmentLot[];
  /** FX scarcity may leave a prepared lot completely unfillable. */
  readonly unfilledLotOrdinals: readonly number[];
  readonly phase8MainIntents: readonly MarketIntent[];
}

function refuse(reason: string): never {
  throw new Error("Phase-7 prepared FX execution: " + reason);
}
function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) refuse(label + " must be finite and nonnegative");
}
function nearly(a: number, b: number, epsilon: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= epsilon;
}

/**
 * Every staged result is immutable and unpublished until ALL selected lots
 * and the authenticated Phase-8 projection succeed. A null FX dispatch means
 * no trade for that one lot, not speculative consumption of its reservation.
 */
export function executePreparedCrossCurrencyTradePlan(
  openingWorld: WorldState,
  input: Phase7PreparedFxExecutionInput,
): Phase7PreparedFxExecutionResult {
  return executePreparedCurrencyTradePlan(openingWorld, input, false);
}

/**
 * Opt-in mixed Phase-7 coordinator. All domestic and FX lots use the SAME
 * ranked actor matches and live economic state; a late failure returns no
 * staged world, cargo, journals or speculative Phase-8 residuals.
 */
export function executePreparedMixedCurrencyTradePlan(
  openingWorld: WorldState,
  input: Phase7PreparedMixedExecutionInput,
): Phase7PreparedFxExecutionResult {
  return executePreparedCurrencyTradePlan(openingWorld, input, true);
}

function executePreparedCurrencyTradePlan(
  openingWorld: WorldState,
  input: Phase7PreparedFxExecutionInput | Phase7PreparedMixedExecutionInput,
  allowDomestic: boolean,
): Phase7PreparedFxExecutionResult {
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) refuse("invalid tick");
  const domesticTermsByTradePlanId = allowDomestic
    ? (input as Phase7PreparedMixedExecutionInput).sameCurrencyTermsByTradePlanId
    : undefined;
  if (allowDomestic && !(domesticTermsByTradePlanId instanceof Map)) {
    refuse("mixed plan requires explicit same-currency frozen quotes");
  }
  if (!Array.isArray(input.priorTransactions) ||
      !(input.termsByTradePlanId instanceof Map) ||
      !(input.fxReservationByLotOrdinal instanceof Map) ||
      !(input.effectiveJurisdictionByRegion instanceof Map) ||
      !(input.remainingCargoWeightByLink instanceof Map)) {
    refuse("missing frozen quote, FX reservations, jurisdiction, capacity or journal");
  }
  const prepared = preparePhase7TradePlan(
    openingWorld, openingWorld.simulationConfig, input.planInput,
  );
  const candidates = new Map(prepared.rankedCandidates.map(c => [c.tradePlanId, c]));
  const quotes = new Map(input.planInput.opportunities.map(q => [q.planId, q]));
  const reservations = new Map(prepared.aggregate.reservations.map(r => [r.tradePlanId, r]));
  const quantityEpsilon = openingWorld.simulationConfig.numeric.quantityEpsilon;
  const moneyEpsilon = openingWorld.simulationConfig.numeric.moneyEpsilon;
  if (quantityEpsilon === undefined || moneyEpsilon === undefined ||
      !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0 ||
      !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0) {
    refuse("unresolved canonical numeric tolerances");
  }
  // Never execute a subset of an accepted mixed batch as though the rest did
  // not exist. This API is an FX-only incremental implementation boundary.
  for (const reservation of prepared.aggregate.reservations) {
    if (reservation.allocatedQuantity <= 0) continue;
    const candidate = candidates.get(reservation.tradePlanId);
    if (!candidate || (!allowDomestic &&
        candidate.sourceCurrencyId === candidate.destinationCurrencyId)) {
      refuse("reserved domestic lot requires the mixed-currency coordinator");
    }
  }
  const mains = new Map(input.phase8MainIntents.map(intent => [intent.id, intent]));
  const seenFxRequestIds = new Set<string>();
  const fxLotOrdinals = new Set<number>();
  for (const [ordinal, lot] of prepared.actorMatches.lots.entries()) {
    const seller = mains.get(lot.sellerIntentId);
    const buyer = mains.get(lot.buyerIntentId);
    if (!seller || !buyer ||
        actorRefKey(seller.actor) !== actorRefKey(lot.seller) ||
        actorRefKey(buyer.actor) !== actorRefKey(lot.buyer) ||
        (seller.inventoryBucket ?? "GENERAL") !== lot.sellerInventoryBucket ||
        (buyer.inventoryBucket ?? "GENERAL") !== lot.buyerInventoryBucket) {
      refuse("stale Phase-8 MAIN intent actor/owner or inventory bucket");
    }
    const candidate = candidates.get(lot.tradePlanId);
    if (!candidate) refuse("matched lot lacks a ranked candidate");
    if (candidate.sourceCurrencyId !== candidate.destinationCurrencyId) {
      fxLotOrdinals.add(ordinal);
      const reservation = input.fxReservationByLotOrdinal.get(ordinal);
      if (!reservation || seenFxRequestIds.has(reservation.requestId)) {
        refuse("missing or duplicated lot-specific FX reservation");
      }
      seenFxRequestIds.add(reservation.requestId);
    }
  }
  if ([...input.fxReservationByLotOrdinal.keys()].some(ordinal =>
    !Number.isSafeInteger(ordinal) || ordinal < 0 ||
    !fxLotOrdinals.has(ordinal))) {
    refuse("orphan or domestic-bound FX lot reservation");
  }

  let world = openingWorld;
  let transactions: readonly EconomicTransaction[] = input.priorTransactions;
  let capacity: ReadonlyMap<TransportLinkId, number> = input.remainingCargoWeightByLink;
  const committed: CommittedPhase7ShipmentLot[] = [];
  const unfilled: number[] = [];

  for (const [ordinal, lot] of prepared.actorMatches.lots.entries()) {
    const candidate = candidates.get(lot.tradePlanId);
    const opportunity = quotes.get(lot.tradePlanId);
    const planReservation = reservations.get(lot.tradePlanId);
    if (!candidate || !opportunity || !planReservation) {
      refuse("matched lot lacks an authorized candidate or opportunity");
    }

    if (candidate.sourceCurrencyId === candidate.destinationCurrencyId) {
      if (!allowDomestic) refuse("domestic lot requires mixed coordinator");
      const quote = domesticTermsByTradePlanId!.get(lot.tradePlanId);
      if (!quote) refuse("matched domestic lot lacks frozen price terms");
      for (const [name, value] of Object.entries(quote)) {
        if (typeof value !== "number") refuse(name + " must be numeric");
        nonnegative(value, name);
      }
      if (quote.sellerNetUnitPrice !== candidate.sourceSellerNetUnitPrice) {
        refuse("domestic seller invoice differs from ranked candidate");
      }
      const unitGross = quote.sellerNetUnitPrice +
        quote.transportFeePerUnitDest + quote.tariffPerUnitDest +
        quote.consumptionTaxPerUnitDest;
      const expectedUnitGross = opportunity.landedGrossUnitCostDest;
      const unitTolerance = Math.min(moneyEpsilon,
        Number.EPSILON * Math.max(1, unitGross, expectedUnitGross));
      if (!Number.isFinite(unitGross) || unitGross <= 0 ||
          !nearly(unitGross, expectedUnitGross, unitTolerance)) {
        refuse("domestic charges disagree with planner's gross quote");
      }
      const link = world.transportLinks.get(candidate.linkId);
      if (!link || link.travelTicks === undefined) {
        refuse("domestic trade lacks travel-time evidence");
      }
      const invoice = lot.quantity * quote.sellerNetUnitPrice;
      const fee = lot.quantity * quote.transportFeePerUnitDest;
      const tariff = lot.quantity * quote.tariffPerUnitDest;
      const tax = lot.quantity * quote.consumptionTaxPerUnitDest;
      const gross = invoice + fee + tariff + tax;
      const plannedGross = lot.quantity * expectedUnitGross;
      if (![invoice, fee, tariff, tax, gross, plannedGross].every(Number.isFinite) ||
          gross <= 0 || !nearly(gross, plannedGross, moneyEpsilon)) {
        refuse("domestic buyer debit loses numeric precision");
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
        sellerNetUnitPrice: quote.sellerNetUnitPrice,
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
      const sales = settled.newTransactions.filter(tx =>
        tx.bundleId === bundleId && tx.type === "TRADE_GOODS_SALE");
      const dispatches = settled.newTransactions.filter(tx =>
        tx.bundleId === bundleId && tx.type === "SHIPMENT_DISPATCH");
      if (!persisted || sales.length !== 1 || dispatches.length !== 1 ||
          sales[0]!.quantity !== lot.quantity ||
          sales[0]!.goodId !== candidate.goodId ||
          actorRefKey(sales[0]!.source!) !== actorRefKey(lot.buyer) ||
          actorRefKey(sales[0]!.destination!) !== actorRefKey(lot.seller) ||
          dispatches[0]!.quantity !== persisted.quantity ||
          actorRefKey(persisted.seller) !== actorRefKey(lot.seller) ||
          actorRefKey(persisted.buyer) !== actorRefKey(lot.buyer) ||
          actorRefKey(persisted.beneficialOwner) !== actorRefKey(lot.buyer) ||
          persisted.destinationInventoryBucket !== lot.buyerInventoryBucket ||
          actorRefKey(dispatches[0]!.source!) !== actorRefKey(lot.seller) ||
          actorRefKey(dispatches[0]!.destination!) !== actorRefKey(lot.buyer)) {
        refuse("committed domestic shipment, owner or journal does not match prepared lot");
      }
      const charged = settled.newTransactions.filter(tx =>
        tx.bundleId === bundleId && ["TRADE_GOODS_SALE", "TRANSPORT_FEE",
          "IMPORT_TARIFF", "CONSUMPTION_TAX"].includes(tx.type),
      ).reduce((sum, tx) => sum + (tx.moneyAmount ?? 0), 0);
      if (!nearly(charged, gross, moneyEpsilon)) {
        refuse("actual domestic buyer debit contradicts gross quote");
      }
      committed.push({
        shipmentId, sellerIntentId: lot.sellerIntentId,
        buyerIntentId: lot.buyerIntentId,
        originRegionId: candidate.originRegionId,
        destinationRegionId: candidate.destinationRegionId,
        goodId: candidate.goodId, dispatchedQuantity: lot.quantity,
        buyerTotalDebitDest: charged,
      });
      world = settled.world;
      transactions = settled.transactions;
      capacity = settled.remainingCargoWeightByLink;
      continue;
    }
    const terms = input.termsByTradePlanId.get(lot.tradePlanId);
    const pair = input.planInput.fxPairIdByTradePlanId?.get(lot.tradePlanId);
    const fxReservation = input.fxReservationByLotOrdinal.get(ordinal);
    if (!terms || !pair || !fxReservation) {
      refuse("matched FX lot lacks a pair, FX promise or frozen quote");
    }
    for (const [name, value] of Object.entries(terms)) {
      if (typeof value !== "number") refuse(name + " must be numeric");
      nonnegative(value, name);
    }
    if (terms.sourceSellerNetUnitPrice <= 0 ||
        terms.sourceSellerNetUnitPrice !== candidate.sourceSellerNetUnitPrice) {
      refuse("seller invoice differs from ranked candidate");
    }
    // Reconcile the frozen gross unit price to the canonical live spot/spread
    // before ANY lot settles. The FX primitive itself rechecks live liquidity.
    const pool = resolveCanonicalFxPool(world, pair).pool;
    const unitFxInput = quoteFxForPool(
      pool, candidate.destinationCurrencyId, candidate.sourceCurrencyId,
      terms.sourceSellerNetUnitPrice,
    ).requiredInputAmountAtDesiredOutput;
    const unitGross = unitFxInput + terms.transportFeePerUnitDest +
      terms.tariffPerUnitDest + terms.consumptionTaxPerUnitDest;
    if (!Number.isFinite(unitGross) || unitGross <= 0 ||
        !nearly(unitGross, opportunity.landedGrossUnitCostDest, moneyEpsilon)) {
      refuse("actual FX charges disagree with planner's gross quote");
    }
    const shipmentId = `sh:m5fx:${input.tick}:${candidate.tradePlanId}:${ordinal}`;
    const bundleId = createTransactionBundleId(
      `tb:m5fx:${input.tick}:${candidate.tradePlanId}:${ordinal}`,
    );
    const settlementId = createFxSettlementId(
      `fxs:m5fx:${input.tick}:${candidate.tradePlanId}:${ordinal}`,
    );
    const settled = settleCrossCurrencyTradeDispatch(world, {
      tick: input.tick, bundleId, settlementId,
      shipmentId: shipmentId as import("../domain/id").ShipmentId,
      originRegionId: candidate.originRegionId,
      destinationRegionId: candidate.destinationRegionId,
      transportLinkId: candidate.linkId, goodId: candidate.goodId,
      seller: lot.seller, buyer: lot.buyer,
      sellerInventoryBucket: lot.sellerInventoryBucket,
      destinationInventoryBucket: lot.buyerInventoryBucket,
      plannedQuantity: lot.quantity,
      sourceSellerNetUnitPrice: terms.sourceSellerNetUnitPrice,
      cargoWeightPerUnit: opportunity.cargoWeightPerUnit,
      transportFeePerUnitDest: terms.transportFeePerUnitDest,
      tariffPerUnitDest: terms.tariffPerUnitDest,
      consumptionTaxPerUnitDest: terms.consumptionTaxPerUnitDest,
      fxPairId: pair, reservation: fxReservation,
      phase1EligibleDirectedLinkIds: input.planInput.eligibleDirectedLinkIdsAtPhase1,
      effectiveJurisdictionByRegion: input.effectiveJurisdictionByRegion,
      remainingCargoWeightByLink: capacity, priorTransactions: transactions,
    });
    if (settled === null) { unfilled.push(ordinal); continue; }

    const sale = settled.newTransactions.filter(tx => tx.type === "TRADE_GOODS_SALE");
    const inputLeg = settled.newTransactions.filter(tx => tx.type === "FX_INPUT");
    const outputLeg = settled.newTransactions.filter(tx => tx.type === "FX_OUTPUT");
    const dispatch = settled.newTransactions.filter(tx => tx.type === "SHIPMENT_DISPATCH");
    const persisted = settled.world.shipments?.get(settled.shipment.id);
    const realized = settled.sizing.quantity;
    if (sale.length !== 1 || inputLeg.length !== 1 ||
        outputLeg.length !== 1 || dispatch.length !== 1 || !persisted ||
        realized <= 0 || realized > lot.quantity ||
        sale[0]!.quantity !== realized ||
        sale[0]!.goodId !== candidate.goodId ||
        actorRefKey(sale[0]!.source!) !== actorRefKey(lot.buyer) ||
        actorRefKey(sale[0]!.destination!) !== actorRefKey(lot.seller) ||
        actorRefKey(inputLeg[0]!.source!) !== actorRefKey(lot.buyer) ||
        actorRefKey(outputLeg[0]!.destination!) !== actorRefKey(lot.seller) ||
        inputLeg[0]!.fxSettlementId !== settlementId ||
        outputLeg[0]!.fxSettlementId !== settlementId ||
        actorRefKey(persisted.seller) !== actorRefKey(lot.seller) ||
        actorRefKey(persisted.buyer) !== actorRefKey(lot.buyer) ||
        actorRefKey(persisted.beneficialOwner) !== actorRefKey(lot.buyer) ||
        persisted.destinationInventoryBucket !== lot.buyerInventoryBucket ||
        dispatch[0]!.quantity !== persisted.quantity ||
        actorRefKey(dispatch[0]!.source!) !== actorRefKey(lot.seller) ||
        actorRefKey(dispatch[0]!.destination!) !== actorRefKey(lot.buyer)) {
      refuse("committed FX shipment, owner or journal does not match prepared lot");
    }
    const charged = settled.newTransactions.filter(tx =>
      tx.type === "FX_INPUT" || tx.type === "TRANSPORT_FEE" ||
      tx.type === "IMPORT_TARIFF" || tx.type === "CONSUMPTION_TAX",
    ).reduce((sum, tx) => sum + (tx.moneyAmount ?? 0), 0);
    if (!nearly(charged, settled.sizing.buyerGrossDebitDest, moneyEpsilon)) {
      refuse("actual destination buyer cash debit contradicts FX receipt");
    }
    committed.push({
      shipmentId: settled.shipment.id,
      sellerIntentId: lot.sellerIntentId, buyerIntentId: lot.buyerIntentId,
      originRegionId: candidate.originRegionId,
      destinationRegionId: candidate.destinationRegionId,
      goodId: candidate.goodId, dispatchedQuantity: realized,
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
    committedLots: committed, unfilledLotOrdinals: unfilled, phase8MainIntents,
  };
}
