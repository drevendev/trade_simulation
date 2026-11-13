/**
 * M5 / #677: one-way trade facts for the static Pages milestone preview.
 *
 * Only accepted WorldState stocks and committed transaction receipts are read.
 * This module cannot settle a trade, consume RNG, infer a tariff law from a
 * price, or replay economics with different parameters.
 */
import type { TransportLinkId } from "../domain/id";
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
  const departures = [...(closing.shipments?.values() ?? [])].filter(s => s.departureTick === tick);
  const arrivals = [...(opening.shipments?.values() ?? [])].filter(s => s.arrivalTick === tick);
  const journalDispatch = result.context.transactions.filter(tx =>
    tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH");
  const journalDelivery = result.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY");
  const unmatchedDispatch = [...journalDispatch];
  for (const shipment of departures) {
    const index = unmatchedDispatch.findIndex(tx =>
      tx.sourceRegionId === shipment.originRegionId &&
      tx.destinationRegionId === shipment.destinationRegionId &&
      tx.goodId === shipment.goodId && tx.quantity === shipment.quantity);
    if (index < 0) throw new Error("M5 preview found in-transit cargo without its paid dispatch receipt");
    unmatchedDispatch.splice(index, 1);
  }
  if (unmatchedDispatch.length) throw new Error("M5 preview found a dispatch without in-transit cargo");
  for (const shipment of arrivals) {
    if ((closing.shipments?.has(shipment.id) ?? false) ||
        journalDelivery.filter(tx =>
          tx.reason?.endsWith(":" + shipment.id) && tx.quantity === shipment.quantity).length !== 1) {
      throw new Error("M5 preview found an unmatched or duplicate shipment delivery");
    }
  }
  if (journalDelivery.length !== arrivals.length) {
    throw new Error("M5 preview found a delivery without an opening in-transit owner");
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
