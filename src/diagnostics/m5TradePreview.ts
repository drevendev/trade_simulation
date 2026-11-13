/**
 * M5 / #677: one-way trade facts for the static Pages milestone preview.
 *
 * Only accepted WorldState stocks and committed transaction receipts are read.
 * This module cannot settle a trade, consume RNG, infer a tariff law from a
 * price, or replay economics with different parameters.
 */
import type { TransportLinkId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { validateTradeShipmentState } from "../simulation/tradeShipmentState";
import type { EconomicTransaction } from "../simulation/tickOrchestrator";
import { effectiveTransportLinkCapacity } from "../simulation/transportCapacity";
import type { StatefulTickExecutionResult } from "../simulation/statefulTickOrchestrator";
import type { WorldState } from "../simulation/worldState";
import type { TradeShipmentState } from "../simulation/tradeShipmentState";

export interface M5PreviewShipment {
  readonly id: string;
  readonly good: string;
  readonly unit: string;
  readonly quantity: number;
  readonly arrivalTick: number;
  readonly invoiceCurrency: string;
  readonly buyerCurrency: string;
  readonly buyerGoodsPaymentAmount: number;
  readonly transportFeeAmount: number;
  readonly tariffAmount: number;
  readonly consumptionTaxAmount: number;
  readonly fxSettlementId: string | null;
}

export interface M5PreviewRoute {
  readonly linkId: string;
  readonly from: string;
  readonly to: string;
  readonly capacityWeightUnits: number;
  /** No paid dispatch does not by itself prove a border or FX block. */
  readonly status: "NO_PHYSICAL_CAPACITY" | "PAID_DISPATCH" | "NO_PAID_DISPATCH";
  readonly departures: readonly M5PreviewShipment[];
  readonly arrivals: readonly M5PreviewShipment[];
  readonly inTransitCount: number;
  readonly dispatchedWeightUnits: number;
}

export interface M5PreviewFxPool {
  readonly authorityId: string;
  readonly poolId: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly baseReserve: number;
  readonly quoteReserve: number;
  readonly baseSpendable: number;
  readonly quoteSpendable: number;
  readonly spotBefore: number;
  readonly spotAfter: number;
  readonly reserveFloorReached: boolean;
}

export interface M5TradeTickPreview {
  readonly milestone: "M5";
  readonly tick: number;
  readonly routes: readonly M5PreviewRoute[];
  readonly fxPools: readonly M5PreviewFxPool[];
}

function ordered<T>(values: Iterable<T>, id: (item: T) => string): T[] {
  return [...values].sort((a, b) => {
    const aa = id(a), bb = id(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
}

/** Project a frozen paid-cargo receipt; all amounts retain their own currencies. */
function shipmentView(world: WorldState, shipment: TradeShipmentState): M5PreviewShipment {
  const good = world.definitionRegistry.goods[shipment.goodId];
  if (good === undefined) throw new Error("M5 preview cannot display an unknown good");
  const currency = (id: string) => {
    const found = [...world.currencies].find(([key]) => String(key) === id)?.[1];
    if (found === undefined) throw new Error("M5 preview cannot display an unknown currency");
    return found.seed.code;
  };
  return {
    id: String(shipment.id),
    good: good.name,
    unit: good.unitLabel,
    quantity: shipment.quantity,
    arrivalTick: shipment.arrivalTick,
    invoiceCurrency: currency(String(shipment.invoiceCurrencyId)),
    buyerCurrency: currency(String(shipment.buyerPaymentCurrencyId)),
    buyerGoodsPaymentAmount: shipment.buyerGoodsPaymentAmount,
    transportFeeAmount: shipment.transportFeeAmount,
    tariffAmount: shipment.tariffAmount,
    consumptionTaxAmount: shipment.consumptionTaxAmount,
    fxSettlementId: shipment.fxSettlementId ?? null,
  };
}

/**
 * Project a *completed* canonical tick, never pending intentions.
 * The journal/physical-registry cross-check prevents a plausible-looking
 * Pages artifact from displaying an unpaid or duplicate cargo.
 */
export function projectM5TradeTick(
  opening: WorldState,
  result: StatefulTickExecutionResult,
  tick: number,
  infrastructureFactors: ReadonlyMap<TransportLinkId, number>,
): M5TradeTickPreview {
  if (!Number.isSafeInteger(tick) || tick < 0 || result.context.tick !== tick ||
      result.phaseTrace.length !== 16 || result.phaseTrace.some((phase, index) => phase !== index) ||
      result.phaseBoundaryError !== undefined || result.reconciliationErrors !== null) {
    throw new Error("M5 preview requires a successful canonical 16-phase tick");
  }

  const closing = result.world;
  // Phase-7 committed stock is captured BEFORE zero-travel delivery removes it.
  // The snapshot is not an intention and contains the same frozen paid terms
  // used by the physical settlement. Without it, zero-travel cannot be proved.
  const departures = result.context.phase7DispatchedShipments;
  if (!Array.isArray(departures)) {
    throw new Error("M5 preview requires the Phase-7 committed shipment snapshot");
  }
  const oldArrivals = [...(opening.shipments?.values() ?? [])]
    .filter(shipment => shipment.arrivalTick === tick);
  const instantArrivals = departures.filter(shipment => shipment.arrivalTick === tick);
  const arrivals = [...oldArrivals, ...instantArrivals];
  const journal = result.context.transactions;
  const journalDispatch = journal.filter(tx =>
    tx.tick === tick && tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH");
  const journalDelivery = journal.filter(tx =>
    tx.tick === tick && tx.type === "SHIPMENT_DELIVERY");
  const usedBundleIds = new Set<string>();
  const seenShipmentIds = new Set<string>();

  // The current M5 prepared settlement issues matching sh:m5[fx]:... and
  // tb:m5[fx]:... identities. The bundle also owns the sale and FX legs.
  // A noncanonical name is not permission to guess a shipment from quantity.
  function dispatchBundle(shipment: TradeShipmentState): string {
    const id = String(shipment.id);
    if (!/^sh:m5(?:fx)?:/.test(id)) {
      throw new Error("M5 preview cannot identify the paid dispatch bundle");
    }
    return "tb:" + id.slice(3);
  }
  const sameActor = (left: ActorRef | undefined, right: ActorRef): boolean =>
    left !== undefined && actorRefKey(left) === actorRefKey(right);
  const moneyEquals = (left: number | undefined, right: number): boolean =>
    left !== undefined && Number.isFinite(left) && Number.isFinite(right) &&
    Math.abs(left - right) <= Math.max(1e-8, Math.max(Math.abs(left), Math.abs(right)) * 1e-10);
  const expectedReceipt = (
    tx: EconomicTransaction, shipment: TradeShipmentState,
    source: ActorRef, destination: ActorRef,
  ): boolean =>
    tx.sourceRegionId === shipment.originRegionId &&
    tx.destinationRegionId === shipment.destinationRegionId &&
    tx.goodId === shipment.goodId &&
    sameActor(tx.source, source) && sameActor(tx.destination, destination);

  for (const shipment of departures) {
    validateTradeShipmentState(opening, shipment);
    if (shipment.departureTick !== tick || seenShipmentIds.has(shipment.id)) {
      throw new Error("M5 preview found a repeated or off-tick paid shipment");
    }
    seenShipmentIds.add(shipment.id);
    const stored = closing.shipments?.get(shipment.id);
    if (shipment.arrivalTick === tick ? stored !== undefined : stored === undefined) {
      throw new Error("M5 preview closing cargo contradicts its delivery tick");
    }
    // A later phase cannot alter the dispatch snapshot while the same physical
    // stock is still in transit.
    if (stored !== undefined && (
      stored.transportLinkId !== shipment.transportLinkId ||
      stored.goodId !== shipment.goodId || stored.quantity !== shipment.quantity ||
      stored.arrivalTick !== shipment.arrivalTick ||
      stored.fxSettlementId !== shipment.fxSettlementId ||
      stored.invoiceCurrencyId !== shipment.invoiceCurrencyId ||
      stored.buyerPaymentCurrencyId !== shipment.buyerPaymentCurrencyId ||
      stored.buyerGoodsPaymentAmount !== shipment.buyerGoodsPaymentAmount ||
      stored.transportFeeAmount !== shipment.transportFeeAmount ||
      stored.tariffAmount !== shipment.tariffAmount ||
      stored.consumptionTaxAmount !== shipment.consumptionTaxAmount ||
      !sameActor(stored.seller, shipment.seller) ||
      !sameActor(stored.buyer, shipment.buyer) ||
      !sameActor(stored.beneficialOwner, shipment.beneficialOwner)
    )) {
      throw new Error("M5 preview in-transit cargo differs from its paid snapshot");
    }
    const bundle = dispatchBundle(shipment);
    if (usedBundleIds.has(bundle)) {
      throw new Error("M5 preview reuses a shipment settlement bundle");
    }
    usedBundleIds.add(bundle);
    const dispatches = journalDispatch.filter(tx => tx.bundleId === bundle);
    if (dispatches.length !== 1 || !expectedReceipt(dispatches[0]!, shipment,
        shipment.seller, shipment.beneficialOwner) ||
        dispatches[0]!.quantity !== shipment.quantity ||
        dispatches[0]!.amount !== shipment.quantity) {
      throw new Error("M5 preview found in-transit cargo without its paid dispatch receipt");
    }
    const sales = journal.filter(tx =>
      tx.tick === tick && tx.phase === 7 &&
      tx.type === "TRADE_GOODS_SALE" && tx.bundleId === bundle);
    if (sales.length !== 1 || !expectedReceipt(sales[0]!, shipment,
        shipment.buyer, shipment.seller) ||
        sales[0]!.currencyId !== shipment.invoiceCurrencyId ||
        sales[0]!.quantity === undefined ||
        sales[0]!.quantity < shipment.quantity ||
        !moneyEquals(sales[0]!.moneyAmount,
          shipment.sellerNetUnitPrice * sales[0]!.quantity) ||
        !moneyEquals(sales[0]!.amount, sales[0]!.moneyAmount!)) {
      throw new Error("M5 preview found dispatch without its paid invoice");
    }
    if (shipment.fxSettlementId !== undefined) {
      const fxInput = journal.filter(tx => tx.tick === tick && tx.phase === 7 &&
        tx.type === "FX_INPUT" && tx.bundleId === bundle);
      const fxOutput = journal.filter(tx => tx.tick === tick && tx.phase === 7 &&
        tx.type === "FX_OUTPUT" && tx.bundleId === bundle);
      if (fxInput.length !== 1 || fxOutput.length !== 1 ||
          sales[0]!.fxSettlementId !== shipment.fxSettlementId ||
          fxInput[0]!.fxSettlementId !== shipment.fxSettlementId ||
          fxOutput[0]!.fxSettlementId !== shipment.fxSettlementId ||
          fxInput[0]!.currencyId !== shipment.buyerPaymentCurrencyId ||
          fxOutput[0]!.currencyId !== shipment.invoiceCurrencyId ||
          !sameActor(fxInput[0]!.source, shipment.buyer) ||
          !sameActor(fxOutput[0]!.destination, shipment.seller) ||
          !moneyEquals(fxInput[0]!.moneyAmount, shipment.buyerGoodsPaymentAmount) ||
          !moneyEquals(fxOutput[0]!.moneyAmount, sales[0]!.moneyAmount!)) {
        throw new Error("M5 preview found inconsistent FX payment ownership");
      }
    } else if (!moneyEquals(sales[0]!.moneyAmount,
        shipment.buyerGoodsPaymentAmount) ||
        journal.some(tx => tx.bundleId === bundle &&
          (tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT"))) {
      throw new Error("M5 preview found inconsistent same-currency payment");
    }
    for (const [kind, expected] of [
      ["TRANSPORT_FEE", shipment.transportFeeAmount],
      ["IMPORT_TARIFF", shipment.tariffAmount],
      ["CONSUMPTION_TAX", shipment.consumptionTaxAmount],
    ] as const) {
      const fees = journal.filter(tx =>
        tx.tick === tick && tx.phase === 7 && tx.bundleId === bundle &&
        tx.type === kind);
      if (fees.length !== (expected > 0 ? 1 : 0) ||
          (expected > 0 && (fees[0]!.currencyId !== shipment.buyerPaymentCurrencyId ||
            !sameActor(fees[0]!.source, shipment.buyer) ||
            !moneyEquals(fees[0]!.moneyAmount, expected)))) {
        throw new Error("M5 preview found a missing or mismatched payment charge");
      }
    }
  }
  if (journalDispatch.length !== departures.length ||
      [...(closing.shipments?.values() ?? [])].some(shipment =>
        shipment.departureTick === tick && !seenShipmentIds.has(shipment.id))) {
    throw new Error("M5 preview found a dispatch without committed cargo");
  }
  const arrivalIds = new Set<string>();
  for (const shipment of arrivals) {
    validateTradeShipmentState(opening, shipment);
    if (arrivalIds.has(shipment.id) || closing.shipments?.has(shipment.id)) {
      throw new Error("M5 preview found an unmatched or duplicate shipment delivery");
    }
    arrivalIds.add(shipment.id);
    const deliveries = journalDelivery.filter(tx =>
      tx.transactionId === "tx:delivery:" + shipment.id);
    const expectedPhase = shipment.departureTick === tick ? 7 : 1;
    if (deliveries.length !== 1 || deliveries[0]!.phase !== expectedPhase ||
        deliveries[0]!.bundleId !== "tb:delivery:" + shipment.id ||
        deliveries[0]!.reason !== "IN_TRANSIT_TO_" +
          shipment.destinationInventoryBucket + "_STOCK:" + shipment.id ||
        deliveries[0]!.goodId !== shipment.goodId ||
        deliveries[0]!.sourceRegionId !== shipment.originRegionId ||
        deliveries[0]!.destinationRegionId !== shipment.destinationRegionId ||
        !sameActor(deliveries[0]!.destination, shipment.beneficialOwner) ||
        deliveries[0]!.source !== undefined ||
        deliveries[0]!.quantity !== shipment.quantity ||
        deliveries[0]!.amount !== shipment.quantity ||
        deliveries[0]!.moneyAmount !== undefined) {
      throw new Error("M5 preview found an unmatched or duplicate shipment delivery");
    }
  }
  if (journalDelivery.length !== arrivals.length) {
    throw new Error("M5 preview found a delivery without committed cargo");
  }

  const routes: M5PreviewRoute[] = ordered(opening.transportLinks.values(), link => String(link.linkId))
    .map(link => {
      const factor = infrastructureFactors.get(link.linkId);
      if (factor === undefined) throw new Error("M5 preview requires the actual link infrastructure factor");
      const capacity = effectiveTransportLinkCapacity(link, factor);
      const from = opening.regions.get(link.fromRegionId);
      const to = opening.regions.get(link.toRegionId);
      if (from === undefined || to === undefined) throw new Error("M5 preview route references a missing region");
      const outbound = ordered(departures.filter(s => s.transportLinkId === link.linkId), s => String(s.id));
      const incoming = ordered(arrivals.filter(s => s.transportLinkId === link.linkId), s => String(s.id));
      const dispatchedWeightUnits = outbound.reduce((sum, cargo) => {
        const good = opening.definitionRegistry.goods[cargo.goodId];
        if (good === undefined) throw new Error("M5 preview requires canonical cargo weight");
        return sum + cargo.quantity * good.cargoWeightPerUnit;
      }, 0);
      return {
        linkId: String(link.linkId),
        from: from.seed.name,
        to: to.seed.name,
        capacityWeightUnits: capacity,
        status: capacity === 0 ? "NO_PHYSICAL_CAPACITY" as const :
          outbound.length ? "PAID_DISPATCH" as const : "NO_PAID_DISPATCH" as const,
        departures: outbound.map(s => shipmentView(opening, s)),
        arrivals: incoming.map(s => shipmentView(opening, s)),
        inTransitCount: [...(closing.shipments?.values() ?? [])]
          .filter(s => s.transportLinkId === link.linkId).length,
        dispatchedWeightUnits,
      };
    });

  const beforePool = new Map([...opening.monetaryAuthorities].flatMap(([ownerId, authority]) =>
    [...authority.fxPools].map(([poolId, pool]) => [String(ownerId) + "/" + poolId, pool] as const)));
  const closingPools = [...closing.monetaryAuthorities].flatMap(([ownerId, authority]) =>
    [...authority.fxPools].map(([poolId, pool]) => ({
      authorityId: String(ownerId), poolId, pool,
    })));
  if (closingPools.length !== beforePool.size) {
    throw new Error("M5 preview cannot silently change the FX pool registry");
  }
  const fxPools: M5PreviewFxPool[] = ordered(closingPools, p => p.authorityId + "/" + p.poolId)
    .map(({ authorityId, poolId, pool }) => {
      const previous = beforePool.get(authorityId + "/" + poolId);
      if (previous === undefined) throw new Error("M5 preview cannot invent an FX pool");
      const base = pool.cash.get(pool.baseCurrencyId);
      const quote = pool.cash.get(pool.quoteCurrencyId);
      if (base === undefined || quote === undefined) {
        throw new Error("M5 preview FX pool is missing a currency reserve");
      }
      const currencyCode = (id: typeof pool.baseCurrencyId) =>
        closing.currencies.get(id)?.seed.code ?? String(id);
      return {
        authorityId, poolId,
        baseCurrency: currencyCode(pool.baseCurrencyId),
        quoteCurrency: currencyCode(pool.quoteCurrencyId),
        baseReserve: base,
        quoteReserve: quote,
        baseSpendable: Math.max(0, base - pool.minOperationalReserveBase),
        quoteSpendable: Math.max(0, quote - pool.minOperationalReserveQuote),
        spotBefore: previous.spotRateQuotePerBase,
        spotAfter: pool.spotRateQuotePerBase,
        reserveFloorReached: base <= pool.minOperationalReserveBase ||
          quote <= pool.minOperationalReserveQuote,
      };
    });
  return { milestone: "M5", tick, routes, fxPools };
}
