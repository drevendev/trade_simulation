/**
 * M5 / #674: routine physical attrition is a one-time Phase-7 dispatch effect,
 * never a monetary charge, deferred arrival adjustment, or second buyer debit.
 *
 * The seller loses the GROSS invoiced goods. The shipment registry owns only
 * the surviving stock; the difference is one typed real-goods destruction flow.
 * This pure preflight is shared by same-currency and FX settlement paths.
 */
import type { WorldState } from "./worldState";
import type { TradeShipmentState } from "./tradeShipmentState";
import {
  createTransactionId, type EconomicTransaction, type TransactionBundleId,
} from "./tickOrchestrator";

export interface RoutineDispatchLoss {
  readonly survivingShipment: TradeShipmentState;
  readonly destroyedQuantity: number;
  readonly destruction: EconomicTransaction | null;
}

export function applyRoutineDispatchLoss(
  world: WorldState, grossShipment: TradeShipmentState,
  bundleId: TransactionBundleId,
): RoutineDispatchLoss {
  const link = world.transportLinks.get(grossShipment.transportLinkId);
  if (!link) throw new Error("M5 routine loss: missing directed transport link");
  // Explicit directed-link rate overrides the optional global baseline.
  const rate = link.seed.routinePhysicalLossRate ??
    world.simulationConfig.trade.shipmentLossFromOrdinaryTrade ?? 0;
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    throw new Error("M5 routine loss: rate must be finite in [0,1)");
  }
  if (rate === 0) {
    return { survivingShipment: grossShipment, destroyedQuantity: 0, destruction: null };
  }
  const epsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
  const gross = grossShipment.quantity;
  if (!Number.isFinite(epsilon) || epsilon <= 0 ||
      !Number.isFinite(gross) || gross <= epsilon) {
    throw new Error("M5 routine loss: invalid physical quantity precision");
  }
  const expectedDestroyed = gross * rate;
  const surviving = gross - expectedDestroyed;
  // Record the ACTUAL representable stock difference, not a theoretical
  // fractional number whose rounding could create unaccounted physical goods.
  const destroyed = gross - surviving;
  if (!Number.isFinite(expectedDestroyed) || !Number.isFinite(surviving) ||
      !Number.isFinite(destroyed) || surviving <= epsilon ||
      surviving >= gross || destroyed <= 0 ||
      Math.abs((surviving + destroyed) - gross) > epsilon ||
      Math.abs(destroyed - expectedDestroyed) >
        Math.max(epsilon, 2 * Number.EPSILON * Math.max(1, Math.abs(gross)))) {
    throw new Error("M5 routine loss: unrepresentable surviving/destroyed split");
  }
  const survivingShipment: TradeShipmentState = {
    ...grossShipment, quantity: surviving,
  };
  const destruction: EconomicTransaction = {
    tick: grossShipment.departureTick, phase: 7, type: "GOODS_TRANSPORT_LOSS",
    transactionId: createTransactionId("tx:" + bundleId + ":loss"), bundleId,
    source: grossShipment.beneficialOwner,
    goodId: grossShipment.goodId, quantity: destroyed, amount: destroyed,
    sourceRegionId: grossShipment.originRegionId,
    destinationRegionId: grossShipment.destinationRegionId,
    reason: "DISPATCH_ROUTINE_PHYSICAL_LOSS:" + grossShipment.id,
  };
  return { survivingShipment, destroyedQuantity: destroyed, destruction };
}
