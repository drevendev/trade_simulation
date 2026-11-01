/**
 * M5 / #673: atomic Phase-7 FX trade dispatch for one pre-authorized,
 * pre-priced, deterministic buyer/seller lot.
 *
 * Quantity is re-sized from LIVE seller stock, buyer cash, route capacity
 * and the current tick's FX promise before any physical transfer. The one
 * settleFx call, destination-currency charges, goods debit, shipment registry,
 * capacity residual and journal are published as a single immutable result.
 *
 * This seam does not choose candidate prices, authorize Phase-1 law, or
 * execute Phase-8 arrival / residual accounting.
 */
import type {
  GoodId, RegionId, ShipmentId, StateId, TransportLinkId,
} from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { cargoCapacityUse } from "./transportCapacity";
import {
  readActorWallet, readMarketActorInventory,
} from "./marketSettlementTransition";
import {
  sizeCrossCurrencyLotBeforeDispatch,
  type CrossCurrencyLotSizing,
  type CrossCurrencyLotSizingRequest,
} from "./phase7CrossCurrencyLotSizing";
import {
  settleFx, type FxSettlementReceipt,
} from "./fxSettlement";
import {
  applyConservingTradeMoneyLegs, sumObservableTradeMoneyAmounts,
  type Phase7TradeMoneyLeg,
} from "./phase7TradeMoneyLegs";
import {
  assertPhase7ActorLocation, debitPhase7SellerGoods,
} from "./phase7SameCurrencyDispatch";
import {
  validateTradeShipmentState,
  type TradeShipmentState, type ShipmentDestinationInventoryBucket,
} from "./tradeShipmentState";
import {
  createTransactionId, type EconomicTransaction,
  type FxSettlementId, type TransactionBundleId,
} from "./tickOrchestrator";
import type { FxReservation } from "./fxQuoteReservation";
import { applyRoutineDispatchLoss } from "./routineDispatchLoss";
import type { WorldState } from "./worldState";

export interface CrossCurrencyDispatchRequest {
  readonly tick: number;
  readonly bundleId: TransactionBundleId;
  readonly settlementId: FxSettlementId;
  readonly shipmentId: ShipmentId;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly transportLinkId: TransportLinkId;
  readonly goodId: GoodId;
  readonly seller: ActorRef;
  readonly buyer: ActorRef;
  readonly sellerInventoryBucket: ShipmentDestinationInventoryBucket;
  readonly destinationInventoryBucket: ShipmentDestinationInventoryBucket;
  readonly plannedQuantity: number;
  readonly sourceSellerNetUnitPrice: number;
  readonly cargoWeightPerUnit: number;
  /** Already evaluated Phase-1 law and per-unit charges, destination currency. */
  readonly transportFeePerUnitDest: number;
  readonly tariffPerUnitDest: number;
  readonly consumptionTaxPerUnitDest: number;
  readonly fxPairId: string;
  readonly reservation: FxReservation;
  readonly phase1EligibleDirectedLinkIds: ReadonlySet<TransportLinkId>;
  readonly effectiveJurisdictionByRegion: ReadonlyMap<RegionId, StateId | null>;
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  readonly priorTransactions: readonly EconomicTransaction[];
}

export interface CrossCurrencyDispatchResult {
  readonly world: WorldState;
  readonly shipment: TradeShipmentState;
  readonly sizing: CrossCurrencyLotSizing;
  readonly fxReceipt: FxSettlementReceipt;
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  readonly newTransactions: readonly EconomicTransaction[];
  readonly transactions: readonly EconomicTransaction[];
}

function refuse(message: string): never {
  throw new Error("Phase-7 cross-currency dispatch: " + message);
}
function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    refuse(label + " must be finite and nonnegative");
  }
}
function nonempty(value: unknown, prefix: string, label: string): void {
  if (typeof value !== "string" || !value.startsWith(prefix) ||
      value.length <= prefix.length) {
    refuse("invalid " + label);
  }
}

/**
 * Returns null only for a genuine unfillable lot. Malformed contracts and
 * non-conserving numeric transitions throw. Neither path mutates the inputs.
 */
export function settleCrossCurrencyTradeDispatch(
  world: WorldState, request: CrossCurrencyDispatchRequest,
): CrossCurrencyDispatchResult | null {
  if (!Number.isSafeInteger(request.tick) || request.tick < 0) {
    return refuse("tick must be a nonnegative safe integer");
  }
  nonempty(request.bundleId, "tb:", "bundle ID");
  nonempty(request.settlementId, "fxs:", "FX settlement ID");
  nonempty(request.shipmentId, "sh:", "shipment ID");
  if (!Array.isArray(request.priorTransactions)) {
    return refuse("priorTransactions must be the committed journal");
  }
  if (!(world.shipments instanceof Map)) {
    return refuse("persistent shipment registry missing");
  }
  if (world.shipments.has(request.shipmentId) ||
      request.priorTransactions.some((tx) =>
        tx.bundleId === request.bundleId ||
        tx.fxSettlementId === request.settlementId)) {
    return refuse("replayed shipment, bundle or FX settlement");
  }
  if (actorRefKey(request.seller) === actorRefKey(request.buyer)) {
    return refuse("buyer and seller must be distinct goods owners");
  }
  const origin = world.regions.get(request.originRegionId);
  const destination = world.regions.get(request.destinationRegionId);
  if (!origin || !destination || request.originRegionId === request.destinationRegionId ||
      origin.settlementCurrencyId === destination.settlementCurrencyId) {
    return refuse("two distinct regions with different live currencies are required");
  }
  if (!(request.phase1EligibleDirectedLinkIds instanceof Set) ||
      !request.phase1EligibleDirectedLinkIds.has(request.transportLinkId)) {
    return refuse("directed transport link is not eligible under current Phase-1 law");
  }
  if (!(request.effectiveJurisdictionByRegion instanceof Map) ||
      !request.effectiveJurisdictionByRegion.has(request.originRegionId) ||
      !request.effectiveJurisdictionByRegion.has(request.destinationRegionId)) {
    return refuse("current-tick jurisdiction is missing");
  }
  assertPhase7ActorLocation(world, request.seller, request.originRegionId,
    request.effectiveJurisdictionByRegion, "seller");
  assertPhase7ActorLocation(world, request.buyer, request.destinationRegionId,
    request.effectiveJurisdictionByRegion, "buyer");
  const link = world.transportLinks.get(request.transportLinkId);
  if (!link || link.fromRegionId !== request.originRegionId ||
      link.toRegionId !== request.destinationRegionId) {
    return refuse("directed link endpoints contradict the shipment regions");
  }
  if (!(request.remainingCargoWeightByLink instanceof Map)) {
    return refuse("missing current cargo residuals");
  }
  const availableCargo = request.remainingCargoWeightByLink.get(request.transportLinkId);
  if (availableCargo === undefined) return refuse("missing directed link cargo residual");
  nonnegative(availableCargo, "available cargo");
  // Check canonical mass BEFORE FX sizing: the prepared plan and its caller
  // are not authorities for physical weight or directed-link capacity.
  const goodDefinition = world.definitionRegistry.goods[request.goodId];
  if (!goodDefinition || !goodDefinition.tradable ||
      !Number.isFinite(goodDefinition.cargoWeightPerUnit) ||
      goodDefinition.cargoWeightPerUnit <= 0 ||
      request.cargoWeightPerUnit !== goodDefinition.cargoWeightPerUnit) {
    return refuse("cargo weight must equal canonical tradable GoodDefinition");
  }
  const goods = readMarketActorInventory(world, request.seller,
    request.sellerInventoryBucket, "seller");
  const sellerAvailable = goods.get(request.goodId) ?? 0;
  nonnegative(sellerAvailable, "seller opening goods");
  const destinationController = request.effectiveJurisdictionByRegion.get(
    request.destinationRegionId,
  )!;
  if (destinationController !== null && !world.states.has(destinationController)) {
    return refuse("current destination controller State is missing");
  }
  if (destinationController === null &&
      (request.tariffPerUnitDest !== 0 || request.consumptionTaxPerUnitDest !== 0)) {
    return refuse("uncontrolled destination cannot charge State taxes");
  }

  const sizingRequest: CrossCurrencyLotSizingRequest = {
    tick: request.tick,
    originRegionId: request.originRegionId,
    destinationRegionId: request.destinationRegionId,
    buyer: request.buyer,
    pairId: request.fxPairId,
    plannedQuantity: request.plannedQuantity,
    sellerAvailableQuantity: sellerAvailable,
    remainingCargoWeight: availableCargo,
    cargoWeightPerUnit: request.cargoWeightPerUnit,
    sourceSellerNetUnitPrice: request.sourceSellerNetUnitPrice,
    transportFeePerUnitDest: request.transportFeePerUnitDest,
    tariffPerUnitDest: request.tariffPerUnitDest,
    consumptionTaxPerUnitDest: request.consumptionTaxPerUnitDest,
    reservation: request.reservation,
  };
  const sizing = sizeCrossCurrencyLotBeforeDispatch(world, sizingRequest);
  if (sizing === null) return null;

  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  const closingGoods = sellerAvailable - sizing.quantity;
  if (!Number.isFinite(closingGoods) || closingGoods < 0 ||
      closingGoods === sellerAvailable ||
      Math.abs((sellerAvailable - closingGoods) - sizing.quantity) > quantityEpsilon) {
    return refuse("seller goods debit loses physical precision");
  }
  const cargoUsed = cargoCapacityUse(sizing.quantity, request.cargoWeightPerUnit);
  const closingCargo = availableCargo - cargoUsed;
  if (!Number.isFinite(closingCargo) || closingCargo < 0 ||
      cargoUsed <= 0 || closingCargo === availableCargo ||
      Math.abs((availableCargo - closingCargo) - cargoUsed) > quantityEpsilon) {
    return refuse("transport capacity debit loses physical precision");
  }
  if (link.travelTicks === undefined || !Number.isSafeInteger(link.travelTicks) ||
      link.travelTicks < 0 ||
      !Number.isSafeInteger(request.tick + link.travelTicks)) {
    return refuse("invalid current link travel time");
  }
  const shipment: TradeShipmentState = {
    id: request.shipmentId,
    goodId: request.goodId,
    quantity: sizing.quantity,
    originRegionId: request.originRegionId,
    destinationRegionId: request.destinationRegionId,
    seller: request.seller, buyer: request.buyer,
    beneficialOwner: request.buyer,
    routeLinkIds: [request.transportLinkId],
    transportLinkId: request.transportLinkId,
    departureTick: request.tick,
    arrivalTick: request.tick + link.travelTicks,
    status: "IN_TRANSIT",
    invoiceCurrencyId: sizing.outputCurrencyId,
    buyerPaymentCurrencyId: sizing.inputCurrencyId,
    sellerNetUnitPrice: request.sourceSellerNetUnitPrice,
    buyerGoodsPaymentAmount: sizing.destinationGoodsFxInputAmount,
    transportFeeAmount: sizing.transportFeeAmountDest,
    tariffAmount: sizing.tariffAmountDest,
    consumptionTaxAmount: sizing.consumptionTaxAmountDest,
    fxSettlementId: request.settlementId,
    destinationInventoryBucket: request.destinationInventoryBucket,
  };
  validateTradeShipmentState(world, shipment);
  const routineLoss = applyRoutineDispatchLoss(world, shipment, request.bundleId);
  validateTradeShipmentState(world, routineLoss.survivingShipment);

  const destinationTreasury: ActorRef | null = destinationController === null ? null :
    { type: "STATE", stateId: destinationController };
  const feeReceiver = link.feeReceiver ?? null;
  if (sizing.transportFeeAmountDest > 0 && feeReceiver === null) {
    return refuse("positive transport fee has no explicit recipient");
  }
  const tx = (suffix: string) => createTransactionId("tx:" + request.bundleId + ":" + suffix);
  const saleId = tx("goods");
  const dispatchId = tx("dispatch");
  const charges = [
    { suffix: "transport", type: "TRANSPORT_FEE",
      amount: sizing.transportFeeAmountDest, receiver: feeReceiver },
    { suffix: "tariff", type: "IMPORT_TARIFF",
      amount: sizing.tariffAmountDest, receiver: destinationTreasury },
    { suffix: "tax", type: "CONSUMPTION_TAX",
      amount: sizing.consumptionTaxAmountDest, receiver: destinationTreasury },
  ] as const;
  const ids = [saleId, dispatchId, ...charges.map((part) => tx(part.suffix)),
    ...(routineLoss.destruction ? [routineLoss.destruction.transactionId] : [])];
  const usedIds = new Set(request.priorTransactions.map((part) => part.transactionId));
  if (ids.some((id) => usedIds.has(id))) {
    return refuse("reused journal transaction identity");
  }
  const chargeLegs: Phase7TradeMoneyLeg[] = charges.filter((part) => part.amount > 0)
    .map((part) => {
      if (!part.receiver) return refuse("positive destination charge lacks a recipient");
      return {
        legId: tx(part.suffix),
        from: request.buyer, to: part.receiver,
        currencyId: sizing.inputCurrencyId, amount: part.amount,
      };
    });
  const allBuyerMoney = sumObservableTradeMoneyAmounts([
    sizing.destinationGoodsFxInputAmount,
    ...charges.map((part) => part.amount),
  ], moneyEpsilon);
  if (allBuyerMoney !== sizing.buyerGrossDebitDest) {
    return refuse("staged destination debits contradict approved FX sizing");
  }

  // Execute the single approved FX conversion; a smaller fill must NEVER be
  // accompanied by a full-size goods dispatch or tax/fee charge.
  const fx = settleFx(world, {
    settlementId: request.settlementId,
    payer: request.buyer, recipient: request.seller,
    pairId: request.fxPairId,
    inputCurrencyId: sizing.inputCurrencyId,
    outputCurrencyId: sizing.outputCurrencyId,
    desiredOutputAmount: sizing.sourceInvoiceAmount,
    maxInputAmount: sizing.destinationGoodsFxInputAmount,
    purpose: "TRADE_GOODS",
    originatingBundleId: request.bundleId,
  }, {
    tick: request.tick, reservation: request.reservation,
    recipientAcceptsOutputCurrency: true,
    priorTransactions: request.priorTransactions,
  });
  if (fx === null) return null;
  if (fx.receipt.outputAmount !== sizing.sourceInvoiceAmount ||
      fx.receipt.inputAmount !== sizing.destinationGoodsFxInputAmount) {
    return refuse("FX underfill or re-quote changed the full seller payment");
  }
  // FX payer already paid the principal. Fees are funded by its remaining
  // ACTUAL wallet and can never borrow a same-bundle incoming fee credit.
  const remainingBuyerCash = readActorWallet(fx.world, request.buyer)
    .get(sizing.inputCurrencyId) ?? 0;
  const feeGross = sumObservableTradeMoneyAmounts(
    charges.map((part) => part.amount), moneyEpsilon,
  );
  if (feeGross > remainingBuyerCash) {
    return refuse("FX leaves insufficient actual cash for destination fees");
  }
  const chargedWorld = chargeLegs.length
    ? applyConservingTradeMoneyLegs(fx.world, chargeLegs)
    : fx.world;
  const debitedWorld = debitPhase7SellerGoods(chargedWorld,
    request.seller, request.sellerInventoryBucket, request.goodId, closingGoods);
  const frozenShipment: TradeShipmentState = Object.freeze({
    ...routineLoss.survivingShipment,
    seller: Object.freeze({ ...shipment.seller }),
    buyer: Object.freeze({ ...shipment.buyer }),
    beneficialOwner: Object.freeze({ ...shipment.beneficialOwner }),
    routeLinkIds: Object.freeze([...shipment.routeLinkIds]),
  });
  const committedWorld: WorldState = {
    ...debitedWorld,
    shipments: new Map(debitedWorld.shipments).set(shipment.id, frozenShipment),
  };

  // TRADE_GOODS_SALE is the invoice evidence; FX_INPUT/FX_OUTPUT are the
  // ONLY source and destination cash postings for this invoice. Do not post
  // the sale annotation as an additional wallet transfer.
  const sale: EconomicTransaction = {
    tick: request.tick, phase: 7, type: "TRADE_GOODS_SALE",
    transactionId: saleId, bundleId: request.bundleId,
    source: request.buyer, destination: request.seller,
    currencyId: sizing.outputCurrencyId,
    goodId: shipment.goodId, quantity: shipment.quantity,
    unitPrice: shipment.sellerNetUnitPrice,
    moneyAmount: sizing.sourceInvoiceAmount, amount: sizing.sourceInvoiceAmount,
    sourceRegionId: shipment.originRegionId,
    destinationRegionId: shipment.destinationRegionId,
    fxSettlementId: request.settlementId,
    reason: "PHASE7_FX_INVOICE_REFERENCE_NONPOSTING",
  };
  const feeTransactions: EconomicTransaction[] = charges
    .filter((part) => part.amount > 0)
    .map((part) => ({
      tick: request.tick, phase: 7, type: part.type,
      transactionId: tx(part.suffix), bundleId: request.bundleId,
      source: request.buyer,
      ...(part.receiver ? { destination: part.receiver } : {}),
      currencyId: sizing.inputCurrencyId,
      moneyAmount: part.amount, amount: part.amount,
      ...(part.suffix === "tax" ? { originatingTransactionId: saleId } : {}),
      sourceRegionId: shipment.originRegionId,
      destinationRegionId: shipment.destinationRegionId,
      reason: "PHASE7_PREPRICED_DESTINATION_CHARGE",
    }));
  const dispatch: EconomicTransaction = {
    tick: request.tick, phase: 7, type: "SHIPMENT_DISPATCH",
    transactionId: dispatchId, bundleId: request.bundleId,
    source: request.seller, destination: request.buyer,
    goodId: shipment.goodId, quantity: frozenShipment.quantity,
    amount: frozenShipment.quantity,
    sourceRegionId: shipment.originRegionId,
    destinationRegionId: shipment.destinationRegionId,
    reason: "PHASE7_TRANSFER_TO_IN_TRANSIT_STOCK",
  };
  const newTransactions: EconomicTransaction[] = [
    sale, ...fx.ledgerLegs, ...feeTransactions, dispatch,
    ...(routineLoss.destruction ? [routineLoss.destruction] : []),
  ];
  return {
    world: committedWorld,
    shipment: frozenShipment,
    sizing, fxReceipt: fx.receipt,
    remainingCargoWeightByLink: new Map(request.remainingCargoWeightByLink)
      .set(request.transportLinkId, closingCargo),
    newTransactions,
    transactions: [...request.priorTransactions, ...newTransactions],
  };
}
