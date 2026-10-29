/**
 * M5 / #673 — fail-atomic execution of prepared cross-currency Phase-7 lots.
 *
 * Only REAL shipment, payment and FX journal receipts reduce Phase-8 intents.
 * Caller owns the frozen Phase-1 price/fee policy and one tick-local FX
 * reservation per concrete actor lot. This adapter never invents policy,
 * reconstructs reservations or changes the existing same-currency path.
 *
 * A mixed-currency plan is deliberately rejected (not silently truncated);
 * combining domestic and FX execution in one ordered batch is a later unit.
 */
import type { RegionId, StateId, TransportLinkId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import type { MarketIntent } from "./marketIntent";
import {
  projectPhase8CommittedTradeResiduals,
  type CommittedPhase7ShipmentLot,
} from "./phase7CommittedIntentResiduals";
import { settleCrossCurrencyTradeDispatch } from "./phase7CrossCurrencyDispatch";
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
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) refuse("invalid tick");
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
    if (!candidate || candidate.sourceCurrencyId === candidate.destinationCurrencyId) {
      refuse("reserved domestic lot requires the mixed-currency coordinator");
    }
  }
  const mains = new Map(input.phase8MainIntents.map(intent => [intent.id, intent]));
  const seenFxRequestIds = new Set<string>();
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
    const reservation = input.fxReservationByLotOrdinal.get(ordinal);
    if (!reservation || seenFxRequestIds.has(reservation.requestId)) {
      refuse("missing or duplicated lot-specific FX reservation");
    }
    seenFxRequestIds.add(reservation.requestId);
  }
  if ([...input.fxReservationByLotOrdinal.keys()].some(ordinal =>
    !Number.isSafeInteger(ordinal) || ordinal < 0 ||
    ordinal >= prepared.actorMatches.lots.length)) {
    refuse("orphan FX lot reservation");
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
    const terms = input.termsByTradePlanId.get(lot.tradePlanId);
    const pair = input.planInput.fxPairIdByTradePlanId?.get(lot.tradePlanId);
    const fxReservation = input.fxReservationByLotOrdinal.get(ordinal)!;
    if (!candidate || !opportunity || !planReservation || !terms || !pair ||
        candidate.sourceCurrencyId === candidate.destinationCurrencyId) {
      refuse("matched FX lot lacks an authorized candidate, pair or frozen quote");
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
