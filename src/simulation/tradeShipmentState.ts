/**
 * M5 / #673: the canonical in-transit stock boundary.
 *
 * Handoff/01 §5.9 and Handoff/04 §§27-31. A shipment is a distinct physical
 * stock owner after a successful Phase-7 atomic dispatch, not an alias of
 * either endpoint inventory. This module validates persisted evidence only:
 * it NEVER creates shipments, debits goods, transfers money, executes FX, or
 * authorizes a dispatch. Those effects must commit together in a later
 * Phase-7 shipment transaction bundle.
 */
import type {
  CurrencyId, GoodId, RegionId, ShipmentId, TransportLinkId,
} from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import type { WorldState } from "./worldState";

export type ShipmentDestinationInventoryBucket =
  "GENERAL" | "INPUT" | "OUTPUT" | "INVESTMENT";

export interface TradeShipmentState {
  readonly id: ShipmentId;
  readonly goodId: GoodId;
  /** Surviving in-transit physical amount; not the original planned amount. */
  readonly quantity: number;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly seller: ActorRef;
  readonly buyer: ActorRef;
  /** Core v1 only supports one directed link per shipment. */
  readonly routeLinkIds: readonly TransportLinkId[];
  readonly transportLinkId: TransportLinkId;
  readonly departureTick: number;
  readonly arrivalTick: number;
  readonly status: "IN_TRANSIT";
  /** Dispatch-time invoice snapshot: not recomputed after a future policy change. */
  readonly invoiceCurrencyId: CurrencyId;
  readonly buyerPaymentCurrencyId: CurrencyId;
  readonly sellerNetUnitPrice: number;
  readonly buyerGoodsPaymentAmount: number;
  readonly transportFeeAmount: number;
  readonly tariffAmount: number;
  readonly consumptionTaxAmount: number;
  readonly fxSettlementId?: string;
  readonly beneficialOwner: ActorRef;
  readonly destinationInventoryBucket: ShipmentDestinationInventoryBucket;
}

function requiredId(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Shipment " + label + " must be a nonempty ID");
  }
}
function amount(value: number, label: string, positive = false): void {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error("Shipment " + label + " must be finite and " +
      (positive ? "positive" : "nonnegative"));
  }
}
function tick(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Shipment " + label + " must be a nonnegative safe tick");
  }
}

/**
 * A shipment's seller, buyer and beneficial owner must have a physical-goods
 * inventory at the relevant end of the transaction. Clan and MonetaryAuthority
 * are cash/policy owners, not goods-stock endpoints.
 */
function assertGoodsActor(world: WorldState, actor: ActorRef, label: string): void {
  if (!actor || typeof actor !== "object") {
    throw new Error("Shipment " + label + " actor is missing");
  }
  switch (actor.type) {
    case "COHORT":
      if (world.cohorts.has(actor.cohortId)) return;
      break;
    case "PRODUCTION_UNIT":
      if (world.productionUnits.has(actor.productionUnitId)) return;
      break;
    case "STATE":
      if (world.states.has(actor.stateId)) return;
      break;
    case "CLAN":
    case "MONETARY_AUTHORITY":
      throw new Error("Shipment " + label + " has no canonical goods inventory");
    default:
      throw new Error("Shipment " + label + " uses an unknown actor kind");
  }
  throw new Error("Shipment " + label + " references a missing actor");
}

/**
 * Cohort and ProductionUnit inventories have one immutable physical region.
 * A persisted shipment must not be able to credit a foreign region by swapping
 * an existing buyer/seller ID after the Phase-7 actor-location preflight.
 * State public stock is intentionally unlocated; later jurisdiction changes
 * must not retroactively invalidate a paid State-owned shipment.
 */
function assertResidentGoodsLocation(
  world: WorldState, actor: ActorRef, regionId: RegionId, role: string,
): void {
  const regionKey = world.regions.get(regionId)!.seed.key;
  if (actor.type === "COHORT" &&
      world.cohorts.get(actor.cohortId)!.seed.regionKey !== regionKey) {
    throw new Error("Shipment " + role + " region contradicts Cohort stock location");
  }
  if (actor.type === "PRODUCTION_UNIT" &&
      world.productionUnits.get(actor.productionUnitId)!.seed.regionKey !== regionKey) {
    throw new Error("Shipment " + role + " region contradicts ProductionUnit stock location");
  }
}

/**
 * Verify the persistent in-transit representation against live registry IDs.
 * Do not re-derive historical invoice currencies from current regional policy:
 * Handoff/04 freezes them when Phase-7 dispatch commits.
 */
export function validateTradeShipmentState(
  world: WorldState,
  shipment: TradeShipmentState,
): void {
  if (!shipment || typeof shipment !== "object") {
    throw new Error("Shipment record is missing");
  }
  requiredId(shipment.id, "id");
  if (!shipment.id.startsWith("sh:")) {
    throw new Error("Shipment id must carry the sh: prefix");
  }
  requiredId(shipment.goodId, "goodId");
  if (!Object.prototype.hasOwnProperty.call(world.definitionRegistry.goods, shipment.goodId)) {
    throw new Error("Shipment goodId references an unknown GoodDefinition");
  }
  requiredId(shipment.originRegionId, "originRegionId");
  requiredId(shipment.destinationRegionId, "destinationRegionId");
  requiredId(shipment.transportLinkId, "transportLinkId");
  requiredId(shipment.invoiceCurrencyId, "invoiceCurrencyId");
  requiredId(shipment.buyerPaymentCurrencyId, "buyerPaymentCurrencyId");

  amount(shipment.quantity, "quantity", true);
  amount(shipment.sellerNetUnitPrice, "sellerNetUnitPrice");
  amount(shipment.buyerGoodsPaymentAmount, "buyerGoodsPaymentAmount");
  amount(shipment.transportFeeAmount, "transportFeeAmount");
  amount(shipment.tariffAmount, "tariffAmount");
  amount(shipment.consumptionTaxAmount, "consumptionTaxAmount");
  tick(shipment.departureTick, "departureTick");
  tick(shipment.arrivalTick, "arrivalTick");
  if (shipment.status !== "IN_TRANSIT") {
    throw new Error("Shipment registry retains only IN_TRANSIT stock");
  }
  if (shipment.originRegionId === shipment.destinationRegionId ||
      !world.regions.has(shipment.originRegionId) ||
      !world.regions.has(shipment.destinationRegionId)) {
    throw new Error("Shipment needs two existing distinct regions");
  }
  if (!world.currencies.has(shipment.invoiceCurrencyId) ||
      !world.currencies.has(shipment.buyerPaymentCurrencyId)) {
    throw new Error("Shipment references a missing invoice/payment currency");
  }
  if (!Array.isArray(shipment.routeLinkIds) ||
      shipment.routeLinkIds.length !== 1 ||
      shipment.routeLinkIds[0] !== shipment.transportLinkId) {
    throw new Error("Shipment core-v1 route must contain its one directed link");
  }
  const link = world.transportLinks.get(shipment.transportLinkId);
  if (!link || link.fromRegionId !== shipment.originRegionId ||
      link.toRegionId !== shipment.destinationRegionId) {
    throw new Error("Shipment route does not connect its dispatched regions");
  }
  if (link.travelTicks === undefined ||
      !Number.isSafeInteger(link.travelTicks) || link.travelTicks < 0 ||
      !Number.isSafeInteger(shipment.departureTick + link.travelTicks) ||
      shipment.arrivalTick !== shipment.departureTick + link.travelTicks) {
    throw new Error("Shipment arrival tick contradicts its directed link");
  }

  assertGoodsActor(world, shipment.seller, "seller");
  assertGoodsActor(world, shipment.buyer, "buyer");
  assertGoodsActor(world, shipment.beneficialOwner, "beneficialOwner");
  assertResidentGoodsLocation(world, shipment.seller, shipment.originRegionId, "seller");
  assertResidentGoodsLocation(world, shipment.buyer, shipment.destinationRegionId, "buyer");
  // Preserve region-first diagnostics for forged resident endpoints. State
  // public stock has no region, so also reject otherwise-valid self-transfers.
  // Both Phase-7 dispatch paths enforce this same distinct-owner invariant.
  if (actorRefKey(shipment.seller) === actorRefKey(shipment.buyer)) {
    throw new Error("Shipment seller and buyer must be distinct goods owners");
  }
  if (actorRefKey(shipment.beneficialOwner) !== actorRefKey(shipment.buyer)) {
    throw new Error("Shipment core-v1 beneficial owner must be its paid buyer");
  }
  const buyerIsUnit = shipment.buyer.type === "PRODUCTION_UNIT";
  if (buyerIsUnit
    ? !["INPUT", "OUTPUT", "INVESTMENT"].includes(shipment.destinationInventoryBucket)
    : shipment.destinationInventoryBucket !== "GENERAL") {
    throw new Error("Shipment destination inventory bucket contradicts buyer ownership");
  }
  if (shipment.invoiceCurrencyId === shipment.buyerPaymentCurrencyId) {
    if (shipment.fxSettlementId !== undefined) {
      throw new Error("Shipment same-currency payment must not record FX");
    }
  } else {
    requiredId(shipment.fxSettlementId, "fxSettlementId");
    if (!shipment.fxSettlementId!.startsWith("fxs:")) {
      throw new Error("Shipment FX settlement id must carry fxs: prefix");
    }
  }
}

/**
 * Fail closed on missing registries, corrupt keys or malformed in-transit
 * stock. The dispatcher will call this after it atomically moves physical
 * goods and all economic transaction legs; this validator is not a substitute
 * for that stock/flow accounting proof.
 */
export function validateTradeShipmentRegistry(world: WorldState): void {
  if (!(world.shipments instanceof Map)) {
    throw new Error("Canonical shipment registry is missing");
  }
  for (const [id, shipment] of world.shipments) {
    if (id !== shipment.id) {
      throw new Error("Shipment registry key differs from persistent id");
    }
    validateTradeShipmentState(world, shipment);
  }
}
