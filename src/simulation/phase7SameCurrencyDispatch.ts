/**
 * M5 / #673: one immutable same-currency Phase-7 physical shipment and money bundle.
 *
 * This is a bounded settlement seam for a PREPRICED, legally authorized lot.
 * Phase-7 candidate pricing, current law/tax-rate computation, selection, FX,
 * routine transport loss and Phase-8 residual accounting are separate owners.
 * In particular, this function MUST NOT be used to bypass the current-tick
 * Phase-1 transport-law and proportional buyer/seller allocation planners.
 *
 * Cash, physical goods, in-transit stock, capacity residual and journal entries
 * are returned together; the caller publishes the returned result atomically.
 * Failure changes NONE of the supplied WorldState, residuals or journal.
 */
import type { GoodId, RegionId, StateId, TransportLinkId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { cargoCapacityUse } from "./transportCapacity";
import { readMarketActorInventory } from "./marketSettlementTransition";
import {
  applyConservingTradeMoneyLegs, type Phase7TradeMoneyLeg,
} from "./phase7TradeMoneyLegs";
import {
  validateTradeShipmentRegistry, validateTradeShipmentState, type ShipmentDestinationInventoryBucket,
  type TradeShipmentState,
} from "./tradeShipmentState";
import {
  createTransactionId, type EconomicTransaction, type TransactionBundleId,
} from "./tickOrchestrator";
import { applyRoutineDispatchLoss } from "./routineDispatchLoss";
import type { WorldState } from "./worldState";

export interface SameCurrencyDispatchRequest {
  readonly tick: number;
  readonly bundleId: TransactionBundleId;
  readonly shipment: TradeShipmentState;
  readonly sellerInventoryBucket: ShipmentDestinationInventoryBucket;
  readonly cargoWeightPerUnit: number;
  /** Phase-1 and legal-policy eligibility, already resolved for this tick. */
  readonly phase1EligibleDirectedLinkIds: ReadonlySet<TransportLinkId>;
  /** Remaining physical weight AFTER earlier committed Phase-7 lots. */
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  /** Current-tick Phase-1 jurisdiction, NOT the historical seed controller. */
  readonly effectiveJurisdictionByRegion: ReadonlyMap<RegionId, StateId | null>;
  /** Previously committed transactions in the same authoritative tick. */
  readonly priorTransactions: readonly EconomicTransaction[];
}

export interface SameCurrencyDispatchResult {
  readonly world: WorldState;
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
  readonly newTransactions: readonly EconomicTransaction[];
  readonly transactions: readonly EconomicTransaction[];
}

function refuse(message: string): never {
  throw new Error("Phase-7 same-currency dispatch: " + message);
}
function validNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) refuse(label + " must be finite and nonnegative");
}
/** Prior committed rows are provenance records; optional links must be real typed IDs. */
export function hasMalformedPhase7JournalReference(part: EconomicTransaction): boolean {
  const malformed = (value: unknown, prefix: string): boolean =>
    value !== undefined &&
    (typeof value !== "string" || !value.startsWith(prefix) ||
      value.slice(prefix.length).trim().length === 0);
  return malformed(part.bundleId, "tb:") ||
    malformed(part.originatingTransactionId, "tx:") ||
    malformed(part.fxSettlementId, "fxs:");
}

function actorLocation(world: WorldState, actor: ActorRef, regionId: RegionId,
  jurisdiction: ReadonlyMap<RegionId, StateId | null>, role: string): void {
  const region = world.regions.get(regionId);
  if (!region) refuse(role + " region missing");
  if (actor.type === "COHORT") {
    if (world.cohorts.get(actor.cohortId)?.seed.regionKey === region.seed.key) return;
  } else if (actor.type === "PRODUCTION_UNIT") {
    if (world.productionUnits.get(actor.productionUnitId)?.seed.regionKey === region.seed.key) return;
  } else if (actor.type === "STATE") {
    if (world.states.has(actor.stateId) && jurisdiction.get(regionId) === actor.stateId) return;
  }
  refuse(role + " cannot use goods located in the specified region");
}

function debitSellerGoods(world: WorldState, actor: ActorRef,
  bucket: ShipmentDestinationInventoryBucket, goodId: GoodId,
  closing: number): WorldState {
  if (actor.type === "COHORT") {
    const cohort = world.cohorts.get(actor.cohortId);
    if (!cohort || bucket !== "GENERAL") return refuse("invalid cohort goods endpoint");
    return { ...world, cohorts: new Map(world.cohorts).set(actor.cohortId, {
      ...cohort, householdInventory: new Map(cohort.householdInventory).set(goodId, closing),
    }) };
  }
  if (actor.type === "STATE") {
    const state = world.states.get(actor.stateId);
    if (!state || bucket !== "GENERAL") return refuse("invalid State goods endpoint");
    return { ...world, states: new Map(world.states).set(actor.stateId, {
      ...state, publicInventory: new Map(state.publicInventory).set(goodId, closing),
    }) };
  }
  if (actor.type === "PRODUCTION_UNIT") {
    const unit = world.productionUnits.get(actor.productionUnitId);
    if (!unit || bucket === "GENERAL") return refuse("invalid ProductionUnit goods endpoint");
    const field = bucket === "INPUT" ? "inputInventory"
      : bucket === "OUTPUT" ? "outputInventory" : "investmentInventory";
    return { ...world, productionUnits: new Map(world.productionUnits).set(actor.productionUnitId, {
      ...unit, [field]: new Map(unit[field]).set(goodId, closing),
    }) };
  }
  return refuse("seller has no physical inventory");
}

/**
 * Settle ONE already-matched, pre-priced, legally eligible same-currency lot.
 * The pure return value is the commit boundary, not a partial payment receipt.
 * Distinct-currency trade MUST go through the later settleFx coordinator.
 */
export function settleSameCurrencyTradeDispatch(
  world: WorldState, request: SameCurrencyDispatchRequest,
): SameCurrencyDispatchResult {
  const { shipment, tick, bundleId } = request;
  if (!Number.isSafeInteger(tick) || tick < 0 || shipment.departureTick !== tick) {
    return refuse("shipment departure tick differs from current Phase-7 tick");
  }
  if (typeof bundleId !== "string" || !bundleId.startsWith("tb:") ||
      bundleId.slice("tb:".length).trim().length === 0) {
    return refuse("invalid transaction bundle ID");
  }
  if (!Array.isArray(request.priorTransactions)) {
    return refuse("priorTransactions must be the committed journal");
  }
  if (!(world.shipments instanceof Map)) {
    return refuse("canonical shipment registry missing");
  }
  // Existing in-transit stock must be valid before another paid dispatch.
  // Otherwise a corrupt persisted registry could survive a new cash/goods commit.
  validateTradeShipmentRegistry(world);
  validateTradeShipmentState(world, shipment);
  // A prepared caller may forge cargoWeightPerUnit even if the live route
  // planner correctly hydrated it. The physical settlement boundary must
  // independently bind capacity debit to the immutable goods definition.
  const goodDefinition = world.definitionRegistry.goods[shipment.goodId];
  if (!goodDefinition || !goodDefinition.tradable ||
      !Number.isFinite(goodDefinition.cargoWeightPerUnit) ||
      goodDefinition.cargoWeightPerUnit <= 0 ||
      request.cargoWeightPerUnit !== goodDefinition.cargoWeightPerUnit) {
    return refuse("cargo weight must equal canonical tradable GoodDefinition");
  }
  const routineLoss = applyRoutineDispatchLoss(world, shipment, bundleId);
  validateTradeShipmentState(world, routineLoss.survivingShipment);
  if (world.shipments.has(shipment.id)) {
    return refuse("duplicate shipment identity");
  }
  if (actorRefKey(shipment.seller) === actorRefKey(shipment.buyer)) {
    return refuse("seller and buyer must be distinct goods owners");
  }
  const source = world.regions.get(shipment.originRegionId)!;
  const destination = world.regions.get(shipment.destinationRegionId)!;
  const currency = source.settlementCurrencyId;
  if (destination.settlementCurrencyId !== currency ||
      shipment.invoiceCurrencyId !== currency ||
      shipment.buyerPaymentCurrencyId !== currency ||
      shipment.fxSettlementId !== undefined) {
    return refuse("same-currency dispatch must use both regions' live settlement currency and no FX");
  }
  if (!(request.phase1EligibleDirectedLinkIds instanceof Set) ||
      !request.phase1EligibleDirectedLinkIds.has(shipment.transportLinkId)) {
    return refuse("directed link not authorized by current Phase-1 law");
  }
  if (!(request.effectiveJurisdictionByRegion instanceof Map) ||
      !request.effectiveJurisdictionByRegion.has(shipment.originRegionId) ||
      !request.effectiveJurisdictionByRegion.has(shipment.destinationRegionId)) {
    return refuse("current-tick effective jurisdiction is missing");
  }
  actorLocation(world, shipment.seller, shipment.originRegionId,
    request.effectiveJurisdictionByRegion, "seller");
  actorLocation(world, shipment.buyer, shipment.destinationRegionId,
    request.effectiveJurisdictionByRegion, "buyer");

  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  if (!Number.isFinite(quantityEpsilon) || quantityEpsilon <= 0 ||
      !Number.isFinite(moneyEpsilon) || moneyEpsilon <= 0) {
    return refuse("canonical quantity/money epsilon must be finite and positive");
  }
  if (shipment.quantity <= quantityEpsilon) return refuse("shipment below quantity epsilon");
  const sellerInventory = readMarketActorInventory(
    world, shipment.seller, request.sellerInventoryBucket, "seller",
  );
  const opening = sellerInventory.get(shipment.goodId) ?? 0;
  validNonnegative(opening, "seller opening goods");
  if (shipment.quantity > opening) return refuse("insufficient seller goods");
  const closing = opening - shipment.quantity;
  if (closing < 0 || closing === opening ||
      Math.abs((opening - closing) - shipment.quantity) > quantityEpsilon) {
    return refuse("seller goods removal loses physical quantity precision");
  }
  const priced = shipment.quantity * shipment.sellerNetUnitPrice;
  // The absolute money epsilon is NOT a license to underpay small invoices.
  // Compare the prepriced invoice within at most one relative binary64 rounding
  // step, capped by canonical money epsilon. At 1e-10, an absolute 1e-9
  // tolerance would otherwise permit even a 49% invoice shortfall.
  const priceGap = Math.abs(priced - shipment.buyerGoodsPaymentAmount);
  const invoiceRoundingTolerance = Math.min(
    moneyEpsilon,
    Number.EPSILON * Math.max(Math.abs(priced), Math.abs(shipment.buyerGoodsPaymentAmount)),
  );
  if (!Number.isFinite(priced) ||
      (shipment.sellerNetUnitPrice > 0 &&
        (priced === 0 || shipment.buyerGoodsPaymentAmount === 0)) ||
      priceGap > invoiceRoundingTolerance) {
    return refuse("buyer goods payment contradicts the seller invoice");
  }
  if (!(request.remainingCargoWeightByLink instanceof Map)) {
    return refuse("missing current residual cargo-capacity map");
  }
  const available = request.remainingCargoWeightByLink.get(shipment.transportLinkId);
  if (available === undefined) return refuse("missing link residual capacity");
  validNonnegative(available, "available cargo capacity");
  const cargoUsed = cargoCapacityUse(shipment.quantity, request.cargoWeightPerUnit);
  if (cargoUsed <= 0 || cargoUsed > available) return refuse("insufficient transport capacity");
  const cargoClosing = available - cargoUsed;
  if (cargoClosing < 0 || cargoClosing === available ||
      Math.abs((available - cargoClosing) - cargoUsed) > quantityEpsilon) {
    return refuse("cargo use loses physical capacity precision");
  }

  const originController = request.effectiveJurisdictionByRegion.get(
    shipment.originRegionId,
  )!;
  const destinationController = request.effectiveJurisdictionByRegion.get(
    shipment.destinationRegionId,
  )!;
  if (originController !== null && !world.states.has(originController)) {
    return refuse("origin jurisdiction State is missing");
  }
  if (destinationController !== null && !world.states.has(destinationController)) {
    return refuse("destination jurisdiction State is missing");
  }
  // A direct prepared-lot caller must not bypass Phase-1's world-wide
  // jurisdiction snapshot contract just because its chosen route is present.
  // The effective map may reflect legal succession rather than seed geography,
  // but it must cover precisely the live regions and name only existing States.
  if (request.effectiveJurisdictionByRegion.size !== world.regions.size ||
      [...world.regions.keys()].some((regionId) => {
        if (!request.effectiveJurisdictionByRegion.has(regionId)) return true;
        const controller = request.effectiveJurisdictionByRegion.get(regionId);
        return controller !== null && (controller === undefined || !world.states.has(controller));
      })) {
    return refuse("current-tick jurisdiction snapshot is incomplete or references an unknown State");
  }
  // Phase-1 law, not the currency or original seed controller, defines an
  // international border. Same-State routes may incur transport and ordinary
  // consumption taxes, but NEVER an import tariff.
  if (originController === destinationController && shipment.tariffAmount !== 0) {
    return refuse("same-State route cannot charge an import tariff");
  }
  if (destinationController === null &&
      (shipment.tariffAmount !== 0 || shipment.consumptionTaxAmount !== 0)) {
    return refuse("uncontrolled destination cannot collect State tariff or tax");
  }
  const destinationTreasury: ActorRef | null = destinationController === null ? null :
    { type: "STATE", stateId: destinationController };
  const link = world.transportLinks.get(shipment.transportLinkId)!;
  // Persisted cargo validates against its frozen duration, but a NEW paid
  // Phase-7 dispatch must use this tick's live directed-link duration.
  // Never let a caller-supplied snapshot authorize an earlier arrival that
  // becomes inconsistent once we freeze the canonical duration below.
  if (link.travelTicks === undefined || !Number.isSafeInteger(link.travelTicks) ||
      link.travelTicks < 0 || !Number.isSafeInteger(tick + link.travelTicks) ||
      shipment.arrivalTick !== tick + link.travelTicks) {
    return refuse("shipment arrival tick must match current directed link travel duration");
  }
  const feeReceiver = link.feeReceiver ?? null;
  if (shipment.transportFeeAmount > 0 && feeReceiver === null) {
    return refuse("positive transport fee has no explicit recipient");
  }

  const steps = [
    { suffix: "goods", type: "TRADE_GOODS_SALE", amount: shipment.buyerGoodsPaymentAmount,
      receiver: shipment.seller },
    { suffix: "transport", type: "TRANSPORT_FEE", amount: shipment.transportFeeAmount,
      receiver: feeReceiver },
    { suffix: "tariff", type: "IMPORT_TARIFF", amount: shipment.tariffAmount,
      receiver: destinationTreasury },
    { suffix: "tax", type: "CONSUMPTION_TAX", amount: shipment.consumptionTaxAmount,
      receiver: destinationTreasury },
  ] as const;
  const tx = (suffix: string) => createTransactionId("tx:" + bundleId + ":" + suffix);
  const transactionIds = steps.filter((part) => part.amount > 0).map((part) => tx(part.suffix));
  transactionIds.push(tx("dispatch"));
  if (routineLoss.destruction) transactionIds.push(routineLoss.destruction.transactionId);
  // Even a zero-price sale remains an explicit journal record for stock provenance.
  if (!transactionIds.includes(tx("goods"))) transactionIds.push(tx("goods"));
  // A persisted journal is untrusted runtime evidence. A unique undefined,
  // prefix-only or non-string ID would otherwise survive duplicate detection
  // and be returned as a committed transaction alongside the new trade.
  if (request.priorTransactions.some((part) =>
    !part || typeof part.transactionId !== "string" ||
    !part.transactionId.startsWith("tx:") ||
    part.transactionId.slice(3).trim().length === 0)) {
    return refuse("malformed committed journal transaction identity");
  }
  if (request.priorTransactions.some(hasMalformedPhase7JournalReference)) {
    return refuse("malformed committed journal reference identity");
  }
  // Phase-7 may carry earlier commits from THIS tick only. A caller cannot
  // smuggle an older/future tick or a later phase into the returned journal.
  if (request.priorTransactions.some((part) =>
    part.tick !== tick || !Number.isSafeInteger(part.phase) ||
    part.phase < 0 || part.phase > 7)) {
    return refuse("committed journal contains an out-of-tick or future-phase transaction");
  }
  // A prior committed journal may contain legitimate signed economic deltas,
  // but NEVER NaN/Infinity or absent required amounts. Re-publishing those
  // records would poison downstream conservation and diagnostic sums even when
  // this new shipment's own money/goods movements are otherwise valid.
  if (request.priorTransactions.some((part) =>
    !Number.isFinite(part.amount) ||
    [part.quantity, part.unitPrice, part.moneyAmount, part.grossMoneyAmount,
      part.assessedTaxAmount, part.taxAmount].some((value) =>
      value !== undefined && !Number.isFinite(value)))) {
    return refuse("committed journal contains non-finite economic amount");
  }
  const seen = new Set(request.priorTransactions.map((item) => item.transactionId));
  // The returned journal must not inherit ambiguous transaction identities,
  // even when the duplicate was in a prior bundle unrelated to this trade.
  // The delivery path enforces the same prior-journal uniqueness invariant.
  if (seen.size !== request.priorTransactions.length) {
    return refuse("duplicate committed journal transaction identity");
  }
  if (request.priorTransactions.some((item) => item.bundleId === bundleId) ||
      transactionIds.some((id) => seen.has(id))) {
    return refuse("reused bundle or transaction identity");
  }

  const legs: Phase7TradeMoneyLeg[] = steps.filter((part) => part.amount > 0).map((part) => {
    if (!part.receiver) return refuse("positive money amount missing recipient");
    return {
      legId: tx(part.suffix), from: shipment.buyer, to: part.receiver,
      currencyId: currency, amount: part.amount,
    };
  });
  // Pure money adapter performs the complete shared balance/conservation preflight.
  const paidWorld = legs.length === 0 ? world : applyConservingTradeMoneyLegs(world, legs);
  const depletedWorld = debitSellerGoods(
    paidWorld, shipment.seller, request.sellerInventoryBucket, shipment.goodId, closing,
  );
  const frozenShipment: TradeShipmentState = Object.freeze({
    ...routineLoss.survivingShipment,
    travelTicksAtDispatch: link.travelTicks,
    routeLinkIds: Object.freeze([...shipment.routeLinkIds]),
    seller: Object.freeze({ ...shipment.seller }),
    buyer: Object.freeze({ ...shipment.buyer }),
    beneficialOwner: Object.freeze({ ...shipment.beneficialOwner }),
  });
  const committedWorld: WorldState = {
    ...depletedWorld,
    shipments: new Map(depletedWorld.shipments).set(shipment.id, frozenShipment),
  };
  const newTransactions: EconomicTransaction[] = steps
    .filter((part) => part.amount > 0 || part.suffix === "goods")
    .map((part) => ({
      tick, phase: 7, type: part.type, transactionId: tx(part.suffix), bundleId,
      source: shipment.buyer,
      ...(part.receiver ? { destination: part.receiver } : {}),
      currencyId: currency,
      ...(part.suffix === "goods" ? {
        goodId: shipment.goodId, quantity: shipment.quantity,
        unitPrice: shipment.sellerNetUnitPrice,
      } : {}),
      sourceRegionId: shipment.originRegionId,
      destinationRegionId: shipment.destinationRegionId,
      moneyAmount: part.amount, amount: part.amount,
      reason: "PHASE7_PREPRICED_TRADE",
    }));
  newTransactions.push({
    tick, phase: 7, type: "SHIPMENT_DISPATCH",
    transactionId: tx("dispatch"), bundleId, source: shipment.seller,
    destination: shipment.buyer, goodId: shipment.goodId,
    quantity: frozenShipment.quantity, amount: frozenShipment.quantity,
    sourceRegionId: shipment.originRegionId,
    destinationRegionId: shipment.destinationRegionId,
    reason: "PHASE7_TRANSFER_TO_IN_TRANSIT_STOCK",
  });
  if (routineLoss.destruction) newTransactions.push(routineLoss.destruction);
  return {
    world: committedWorld,
    remainingCargoWeightByLink: new Map(request.remainingCargoWeightByLink)
      .set(shipment.transportLinkId, cargoClosing),
    newTransactions,
    transactions: [...request.priorTransactions, ...newTransactions],
  };
}

// Shared pure physical endpoint helpers for the cross-currency coordinator.
export { actorLocation as assertPhase7ActorLocation,
  debitSellerGoods as debitPhase7SellerGoods };
