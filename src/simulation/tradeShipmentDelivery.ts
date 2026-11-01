/**
 * M5 / #674: one fail-atomic delivery boundary for already-paid shipments.
 *
 * Phase 1 accepts shipments dispatched on an earlier tick, Phase-7 close only
 * same-tick zero-travel shipments. No new sale, FX, tariff or transport fee is
 * posted on delivery: ownership transferred at dispatch. The caller publishes
 * both the returned WorldState and journal together, never an intermediate state.
 */
import { actorRefKey } from "../domain/genesisLedger";
import type { ShipmentId } from "../domain/id";
import { readMarketActorInventory } from "./marketSettlementTransition";
import { validateTradeShipmentRegistry, type TradeShipmentState } from "./tradeShipmentState";
import {
  createTransactionBundleId, createTransactionId, type EconomicTransaction,
} from "./tickOrchestrator";
import type { WorldState } from "./worldState";

export interface ShipmentDeliveryRequest {
  readonly tick: number;
  readonly phase: 1 | 7;
  readonly priorTransactions: readonly EconomicTransaction[];
}
export interface ShipmentDeliveryResult {
  readonly world: WorldState;
  readonly deliveredShipmentIds: readonly ShipmentId[];
  readonly newTransactions: readonly EconomicTransaction[];
  readonly transactions: readonly EconomicTransaction[];
}

function fail(reason: string): never {
  throw new Error("M5 shipment delivery: " + reason);
}

/** Credit exactly the dispatch-frozen beneficial owner's named stock bucket. */
function creditBuyer(world: WorldState, shipment: TradeShipmentState, epsilon: number): WorldState {
  const actor = shipment.beneficialOwner;
  const bucket = shipment.destinationInventoryBucket;
  const before = readMarketActorInventory(world, actor, bucket, "buyer");
  const initial = before.get(shipment.goodId) ?? 0;
  const closing = initial + shipment.quantity;
  const observed = closing - initial;
  if (!Number.isFinite(initial) || initial < 0 || !Number.isFinite(closing) ||
      closing <= initial || !Number.isFinite(observed) ||
      Math.abs(observed - shipment.quantity) > epsilon) {
    return fail("destination goods credit loses quantity precision or overflows");
  }
  const updated = new Map(before).set(shipment.goodId, closing);
  switch (actor.type) {
    case "COHORT": {
      if (bucket !== "GENERAL") return fail("cohort requires GENERAL destination stock");
      const cohort = world.cohorts.get(actor.cohortId);
      if (!cohort) return fail("missing destination cohort");
      return { ...world, cohorts: new Map(world.cohorts).set(actor.cohortId, {
        ...cohort, householdInventory: updated,
      }) };
    }
    case "STATE": {
      if (bucket !== "GENERAL") return fail("State requires GENERAL destination stock");
      const state = world.states.get(actor.stateId);
      if (!state) return fail("missing destination State");
      return { ...world, states: new Map(world.states).set(actor.stateId, {
        ...state, publicInventory: updated,
      }) };
    }
    case "PRODUCTION_UNIT": {
      const unit = world.productionUnits.get(actor.productionUnitId);
      if (!unit) return fail("missing destination ProductionUnit");
      if (bucket === "GENERAL") return fail("ProductionUnit requires named stock bucket");
      const field = bucket === "INPUT" ? "inputInventory"
        : bucket === "OUTPUT" ? "outputInventory" : "investmentInventory";
      return { ...world, productionUnits: new Map(world.productionUnits).set(
        actor.productionUnitId, { ...unit, [field]: updated },
      ) };
    }
    default:
      return fail("beneficial owner has no goods inventory");
  }
}

/** Neumaier-accumulated receipts prevent individually small rounding losses adding up. */
function compensatedAdd(previous: { sum: number; correction: number }, value: number) {
  const sum = previous.sum + value;
  const correction = previous.correction +
    (Math.abs(previous.sum) >= Math.abs(value)
      ? (previous.sum - sum) + value
      : (value - sum) + previous.sum);
  if (!Number.isFinite(sum) || !Number.isFinite(correction)) {
    return fail("nonfinite cumulative delivery quantity");
  }
  return { sum, correction };
}

/**
 * Deterministic due-order: arrivalTick, then persistent shipment ID.
 * An overdue shipment or a wrong-phase arrival is a sequencing defect, never
 * a silent skip. An empty due set is a no-op. No caller-owned map is mutated.
 */
export function deliverDueTradeShipments(
  world: WorldState, request: ShipmentDeliveryRequest,
): ShipmentDeliveryResult {
  if (!Number.isSafeInteger(request.tick) || request.tick < 0 ||
      (request.phase !== 1 && request.phase !== 7) ||
      !Array.isArray(request.priorTransactions)) {
    return fail("invalid tick, phase or committed journal");
  }
  const epsilon = world.simulationConfig.numeric.quantityEpsilon;
  if (epsilon === undefined || !Number.isFinite(epsilon) || epsilon < 0) {
    return fail("invalid canonical quantity precision");
  }
  const registry = world.shipments;
  if (!(registry instanceof Map)) return fail("missing canonical shipment registry");
  validateTradeShipmentRegistry(world);
  const due: TradeShipmentState[] = [];
  for (const shipment of registry.values()) {
    // Phase 1 sees only shipments dispatched on prior ticks. New same-tick
    // cargo cannot exist until Phase-7 dispatch has actually committed.
    if (shipment.departureTick > request.tick ||
        (request.phase === 1 && shipment.departureTick === request.tick)) {
      return fail("shipment exists before its dispatch phase (Phase-7 close)");
    }
    if (shipment.arrivalTick < request.tick) return fail("overdue shipment was not delivered");
    if (shipment.arrivalTick !== request.tick) continue;
    if (request.phase === 1 && shipment.departureTick >= request.tick) {
      return fail("same-tick shipment must be delivered in Phase-7 close");
    }
    if (request.phase === 7 && shipment.departureTick !== request.tick) {
      return fail("earlier-tick shipment must be delivered in Phase 1");
    }
    due.push(shipment);
  }
  due.sort((a, b) => a.arrivalTick - b.arrivalTick ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const priorIds = new Set(request.priorTransactions.map(tx => tx.transactionId));
  const priorBundles = new Set(request.priorTransactions.map(tx => tx.bundleId));
  const totals = new Map<string, {
    first: number; sum: number; correction: number;
    last: number;
  }>();
  let working = world;
  const newTransactions: EconomicTransaction[] = [];
  for (const shipment of due) {
    const transactionId = createTransactionId("tx:delivery:" + shipment.id);
    const bundleId = createTransactionBundleId("tb:delivery:" + shipment.id);
    if (priorIds.has(transactionId) || priorBundles.has(bundleId)) {
      return fail("duplicate delivery transaction or bundle identity");
    }
    const key = actorRefKey(shipment.beneficialOwner) + "|" +
      shipment.destinationInventoryBucket + "|" + shipment.goodId;
    const before = readMarketActorInventory(working, shipment.beneficialOwner,
      shipment.destinationInventoryBucket, "buyer").get(shipment.goodId) ?? 0;
    const previous = totals.get(key) ?? { first: before, sum: 0, correction: 0, last: before };
    working = creditBuyer(working, shipment, epsilon);
    const last = readMarketActorInventory(working, shipment.beneficialOwner,
      shipment.destinationInventoryBucket, "buyer").get(shipment.goodId) ?? 0;
    totals.set(key, { first: previous.first,
      ...compensatedAdd(previous, shipment.quantity), last });
    newTransactions.push({
      tick: request.tick, phase: request.phase,
      type: "SHIPMENT_DELIVERY", transactionId, bundleId,
      destination: shipment.beneficialOwner,
      goodId: shipment.goodId, quantity: shipment.quantity,
      amount: shipment.quantity,
      sourceRegionId: shipment.originRegionId,
      destinationRegionId: shipment.destinationRegionId,
      reason: "IN_TRANSIT_TO_" + shipment.destinationInventoryBucket +
        "_STOCK:" + shipment.id,
    });
  }
  for (const { first, last, sum, correction } of totals.values()) {
    if (!Number.isFinite(last - first) ||
        Math.abs((last - first) - (sum + correction)) > epsilon) {
      return fail("cumulative destination goods credit loses quantity precision");
    }
  }
  if (due.length > 0) {
    const shipments = new Map(working.shipments);
    for (const shipment of due) shipments.delete(shipment.id);
    working = { ...working, shipments };
    validateTradeShipmentRegistry(working);
  }
  return {
    world: working,
    deliveredShipmentIds: due.map(shipment => shipment.id),
    newTransactions,
    transactions: [...request.priorTransactions, ...newTransactions],
  };
}
