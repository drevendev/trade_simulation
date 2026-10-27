/**
 * M5 #670 — pure shared Phase-7 REGIONAL aggregate reservations.
 *
 * Candidate selection establishes independent upper bounds, but those bounds
 * cannot be added together: different routes compete for the same regional
 * export stock, import demand, buyer cash, link weight and FX pool output.
 *
 * Inputs are frozen, owner-supplied post-Phase-4 residual budgets and Phase-1
 * eligibility. This is not actor matching, shipment creation or settlement.
 * The remaining maps are the Phase-8 residual handoff; callers must still
 * allocate among actual buyers/sellers and commit atomically before claiming
 * economic stock has changed.
 */
import type { SimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId, RegionId, TransportLinkId } from "../domain/id";
import { cargoCapacityUse, effectiveTransportLinkCapacity, hasUsableTransportCapacity } from "./transportCapacity";
import { rankWithEpsilonTies, type Phase7EligibleTradeCandidate } from "./tradeCandidateSelection";
import type { WorldState } from "./worldState";

export function phase7RegionGoodKey(region: RegionId, good: GoodId): string {
  return JSON.stringify([region, good]);
}

export function phase7RegionCashKey(region: RegionId, currency: CurrencyId): string {
  return JSON.stringify([region, currency]);
}

export function phase7FxOutputKey(pair: string, currency: CurrencyId): string {
  return JSON.stringify([pair, currency]);
}

/** All four budgets are ALREADY NET of earlier same-tick commitments. */
export interface Phase7AggregateBudgets {
  readonly exportableByOriginGood: ReadonlyMap<string, number>;
  readonly importDemandByDestinationGood: ReadonlyMap<string, number>;
  readonly buyerCashByDestinationCurrency: ReadonlyMap<string, number>;
  /** Spendable pool output after its operational floor and prior reservations. */
  readonly fxOutputByPairCurrency: ReadonlyMap<string, number>;
}

export interface Phase7AggregateReservationRequest {
  /** Output of selectPhase7TradeCandidates, not an unvetted opportunity. */
  readonly candidate: Phase7EligibleTradeCandidate;
  readonly cargoWeightPerUnit: number;
  /** Buyer total debit per unit, including transport, tariffs and FX spread. */
  readonly landedGrossUnitCostDest: number;
  /** Required only for cross-currency purchases; pair direction is explicit. */
  readonly fxPoolPairId?: string;
}

export type Phase7AggregateRefusal =
  | "LINK_NOT_ELIGIBLE"
  | "LINK_UNUSABLE"
  | "INSUFFICIENT_SHARED_RESIDUAL";

export interface Phase7AggregateReservation {
  readonly tradePlanId: string;
  readonly linkId: TransportLinkId;
  readonly goodId: GoodId;
  readonly allocatedQuantity: number;
  readonly cargoWeightReserved: number;
  readonly buyerCashReservedDest: number;
  readonly fxPoolOutputReservedSource: number;
  readonly refusal: Phase7AggregateRefusal | null;
}

export interface Phase7AggregateReservationResult {
  readonly reservations: readonly Phase7AggregateReservation[];
  /** Phase-8 must use these, not the pre-Phase-7 raw local offers/demand. */
  readonly remainingExportableByOriginGood: ReadonlyMap<string, number>;
  readonly remainingImportDemandByDestinationGood: ReadonlyMap<string, number>;
  readonly remainingBuyerCashByDestinationCurrency: ReadonlyMap<string, number>;
  readonly remainingFxOutputByPairCurrency: ReadonlyMap<string, number>;
  readonly remainingCargoWeightByLink: ReadonlyMap<TransportLinkId, number>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(label + " must be non-negative and finite");
  }
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(label + " must be positive and finite");
  }
}

function copyBudgets(budget: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...budget].sort(([a], [b]) => cmp(a, b)));
}

function requiredBudget(budgets: ReadonlyMap<string, number>, key: string, label: string): number {
  if (!budgets.has(key)) {
    throw new Error("missing explicit Phase-7 " + label + " budget for " + key);
  }
  const amount = budgets.get(key)!;
  nonnegative(amount, label);
  return amount;
}

function consume(budget: number, used: number, label: string, precisionTolerance: number): number {
  if (used === 0) return budget;
  positive(used, label + " use");
  if (used > budget) throw new Error(label + " reservation would overdraw shared budget");
  const next = budget - used;
  // An observable change is not necessarily the requested debit: IEEE-754
  // rounds 1e16 - 3 to a decrement of FOUR. Do not publish a residual
  // that consumes more (or less) than the allocation actually reserved.
  const observedUse = budget - next;
  if (next === budget || next < 0 || !Number.isFinite(next) ||
      !Number.isFinite(observedUse) ||
      Math.abs(observedUse - used) > precisionTolerance) {
    throw new Error(label + " reservation lost numeric precision");
  }
  return next;
}

/**
 * Compensated sum of accepted allocations: a fixed *absolute* epsilon cannot
 * be spent anew with every candidate sharing one stock/cash/cargo/FX pool.
 */
interface DebitSum { readonly sum: number; readonly correction: number }

function recordDebit(totals: Map<string, DebitSum>, key: string, used: number): void {
  if (used === 0) return;
  const previous = totals.get(key) ?? { sum: 0, correction: 0 };
  const next = previous.sum + used;
  const error = Math.abs(previous.sum) >= Math.abs(used)
    ? previous.sum - next + used
    : used - next + previous.sum;
  totals.set(key, { sum: next, correction: previous.correction + error });
}

function validateCumulativeDebits(
  original: ReadonlyMap<string, number>,
  remaining: ReadonlyMap<string, number>,
  totals: ReadonlyMap<string, DebitSum>,
  label: string,
  tolerance: number,
): void {
  for (const [key, { sum, correction }] of totals) {
    const committed = sum + correction;
    const observed = requiredBudget(original, key, label) - requiredBudget(remaining, key, label);
    if (!Number.isFinite(committed) || !Number.isFinite(observed) ||
        Math.abs(observed - committed) > tolerance) {
      throw new Error(label + " cumulative reservation lost numeric precision");
    }
  }
}

/**
 * Reserves the SAME scored candidate order across all shared budgets. Never
 * reserves cargo capacity before checking money, goods, demand and FX: a
 * refused candidate must not take capacity away from the following one.
 */
export function reservePhase7AggregateTrades(
  world: Pick<WorldState, "regions" | "transportLinks">,
  config: Pick<SimulationConfig, "numeric" | "trade">,
  requests: readonly Phase7AggregateReservationRequest[],
  budgets: Phase7AggregateBudgets,
  infrastructureFactors: ReadonlyMap<TransportLinkId, number>,
  phase1EligibleDirectedLinks: ReadonlySet<TransportLinkId>,
): Phase7AggregateReservationResult {
  if (!budgets || !infrastructureFactors || !phase1EligibleDirectedLinks) {
    throw new Error("Phase-7 requires explicit shared budgets, infrastructure and frozen Phase-1 eligibility");
  }
  const scoreEpsilon = config.numeric.rateEpsilon;
  const quantityEpsilon = config.numeric.quantityEpsilon;
  const moneyEpsilon = config.numeric.moneyEpsilon;
  const minimumShipment = config.trade.shipmentMinimumQuantity;
  if (scoreEpsilon === undefined || quantityEpsilon === undefined ||
      moneyEpsilon === undefined || minimumShipment === undefined) {
    throw new Error("Phase-7 requires resolved score, quantity and shipment minimum thresholds");
  }
  positive(scoreEpsilon, "rateEpsilon");
  nonnegative(quantityEpsilon, "quantityEpsilon");
  nonnegative(moneyEpsilon, "moneyEpsilon");
  positive(minimumShipment, "shipmentMinimumQuantity");

  const remainingStock = copyBudgets(budgets.exportableByOriginGood);
  const remainingDemand = copyBudgets(budgets.importDemandByDestinationGood);
  const remainingCash = copyBudgets(budgets.buyerCashByDestinationCurrency);
  const remainingFx = copyBudgets(budgets.fxOutputByPairCurrency);
  const links = new Map<TransportLinkId, number>();
  const linkUsable = new Map<TransportLinkId, boolean>();
  const seen = new Set<string>();
  // A scored aggregate candidate is unique per directed link and good.
  // Different plan IDs cannot replay one route/good's legal or policy cap.
  const seenDirectedLinkGoods = new Set<string>();
  const prepared = requests.map((request) => {
    const c = request.candidate;
    if (!c || typeof c.tradePlanId !== "string" || !c.tradePlanId.trim() || seen.has(c.tradePlanId)) {
      throw new Error("Phase-7 aggregate planId must be unique and nonempty");
    }
    seen.add(c.tradePlanId);
    if (typeof c.goodId !== "string" || !c.goodId || !Number.isFinite(c.score)) {
      throw new Error("Phase-7 aggregate candidate good/score is invalid");
    }
    const directedLinkGood = JSON.stringify([c.linkId, c.goodId]);
    if (seenDirectedLinkGoods.has(directedLinkGood)) {
      throw new Error("duplicate aggregate Phase-7 candidate for directed link and good");
    }
    seenDirectedLinkGoods.add(directedLinkGood);
    positive(c.maximumOwnQuantity, "maximumOwnQuantity");
    positive(request.cargoWeightPerUnit, "cargoWeightPerUnit");
    nonnegative(request.landedGrossUnitCostDest, "landedGrossUnitCostDest");
    const link = world.transportLinks.get(c.linkId);
    const origin = world.regions.get(c.originRegionId);
    const destination = world.regions.get(c.destinationRegionId);
    if (!link || !origin || !destination ||
        link.fromRegionId !== c.originRegionId || link.toRegionId !== c.destinationRegionId ||
        origin.settlementCurrencyId !== c.sourceCurrencyId ||
        destination.settlementCurrencyId !== c.destinationCurrencyId) {
      throw new Error("Phase-7 aggregate candidate has stale region, currency or directed link");
    }
    if (!infrastructureFactors.has(c.linkId)) {
      throw new Error("Phase-7 aggregate missing infrastructure factor");
    }
    if (!links.has(c.linkId)) {
      const factor = infrastructureFactors.get(c.linkId)!;
      links.set(c.linkId, effectiveTransportLinkCapacity(link, factor));
      linkUsable.set(c.linkId, hasUsableTransportCapacity(link, config, factor));
    }

    const stockKey = phase7RegionGoodKey(c.originRegionId, c.goodId);
    const demandKey = phase7RegionGoodKey(c.destinationRegionId, c.goodId);
    const cashKey = phase7RegionCashKey(c.destinationRegionId, c.destinationCurrencyId);
    requiredBudget(remainingStock, stockKey, "export stock");
    requiredBudget(remainingDemand, demandKey, "import demand");
    requiredBudget(remainingCash, cashKey, "buyer cash");

    let fxKey: string | null = null;
    if (c.sourceCurrencyId !== c.destinationCurrencyId) {
      if (!request.fxPoolPairId || !String(request.fxPoolPairId).trim()) {
        throw new Error("cross-currency trade requires an explicit FX pair");
      }
      positive(c.sourceSellerNetUnitPrice, "cross-currency seller invoice per unit");
      fxKey = phase7FxOutputKey(request.fxPoolPairId, c.sourceCurrencyId);
      requiredBudget(remainingFx, fxKey, "FX pool output");
    } else if (request.fxPoolPairId !== undefined) {
      throw new Error("same-currency trade must not reserve an FX pool");
    }
    return { request, stockKey, demandKey, cashKey, fxKey };
  });

  const byId = new Map(prepared.map((item) => [item.request.candidate.tradePlanId, item]));
  // Frozen initial budgets are witnesses for whole-call conservation. These are
  // independent copies, never the caller-owned maps or WorldState.
  const initialStock = new Map(remainingStock);
  const initialDemand = new Map(remainingDemand);
  const initialCash = new Map(remainingCash);
  const initialFx = new Map(remainingFx);
  const initialLinks = new Map(links);
  const stockDebits = new Map<string, DebitSum>();
  const demandDebits = new Map<string, DebitSum>();
  const cashDebits = new Map<string, DebitSum>();
  const linkDebits = new Map<string, DebitSum>();
  const fxDebits = new Map<string, DebitSum>();
  const reservations: Phase7AggregateReservation[] = [];
  for (const candidate of rankWithEpsilonTies(requests.map((request) => request.candidate), scoreEpsilon)) {
    const item = byId.get(candidate.tradePlanId)!;
    const linkId = candidate.linkId;
    const stock = remainingStock.get(item.stockKey)!;
    const demand = remainingDemand.get(item.demandKey)!;
    const cash = remainingCash.get(item.cashKey)!;
    const capacity = links.get(linkId)!;
    const fx = item.fxKey === null ? Number.POSITIVE_INFINITY : remainingFx.get(item.fxKey)!;
    const weight = item.request.cargoWeightPerUnit;
    const unitCost = item.request.landedGrossUnitCostDest;
    const sourceInvoicePerUnit = item.fxKey === null ? 0 : candidate.sourceSellerNetUnitPrice;
    const authorized = phase1EligibleDirectedLinks.has(linkId);
    const usable = linkUsable.get(linkId)!;
    let quantity = 0;
    let cargoUse = 0;
    let cashUse = 0;
    let fxUse = 0;
    let refusal: Phase7AggregateRefusal | null = !authorized ? "LINK_NOT_ELIGIBLE"
      : !usable ? "LINK_UNUSABLE" : null;

    if (refusal === null) {
      quantity = Math.min(
        candidate.maximumOwnQuantity, stock, demand, capacity / weight,
        unitCost > 0 ? cash / unitCost : Number.POSITIVE_INFINITY,
        sourceInvoicePerUnit > 0 ? fx / sourceInvoicePerUnit : Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new Error("Phase-7 aggregate allocated quantity must be finite and non-negative");
      }
      if (quantity <= quantityEpsilon || quantity < minimumShipment) {
        refusal = "INSUFFICIENT_SHARED_RESIDUAL";
        quantity = 0;
      } else {
        let fits = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          cargoUse = cargoCapacityUse(quantity, weight);
          cashUse = quantity * unitCost;
          fxUse = quantity * sourceInvoicePerUnit;
          // Even finite, strictly positive unit costs can underflow to zero
          // when multiplied by a legitimate shipment quantity. Never grant
          // a positive shipment free cargo, FX output or payable cash.
          if (cargoUse === 0 || (unitCost > 0 && cashUse === 0) ||
              (item.fxKey !== null && fxUse === 0)) {
            throw new Error("Phase-7 aggregate required positive resource use lost numeric precision");
          }
          if (Number.isFinite(cashUse) && Number.isFinite(fxUse) &&
              cargoUse <= capacity && cashUse <= cash && fxUse <= fx) {
            fits = true;
            break;
          }
          quantity *= 1 - Number.EPSILON;
        }
        if (!fits) throw new Error("Phase-7 aggregate cannot safely round a shared reservation");
        if (quantity <= quantityEpsilon || quantity < minimumShipment) {
          refusal = "INSUFFICIENT_SHARED_RESIDUAL";
          quantity = cargoUse = cashUse = fxUse = 0;
        } else {
          // Commit only to LOCAL ephemeral maps after every leg is proven.
          const afterStock = consume(stock, quantity, "export stock", quantityEpsilon);
          const afterDemand = consume(demand, quantity, "import demand", quantityEpsilon);
          const afterCash = consume(cash, cashUse, "buyer cash", moneyEpsilon);
          const afterLink = consume(capacity, cargoUse, "cargo weight", quantityEpsilon);
          const afterFx = item.fxKey === null ? null : consume(fx, fxUse, "FX pool output", moneyEpsilon);
          remainingStock.set(item.stockKey, afterStock);
          remainingDemand.set(item.demandKey, afterDemand);
          remainingCash.set(item.cashKey, afterCash);
          links.set(linkId, afterLink);
          if (item.fxKey !== null) remainingFx.set(item.fxKey, afterFx!);
          recordDebit(stockDebits, item.stockKey, quantity);
          recordDebit(demandDebits, item.demandKey, quantity);
          recordDebit(cashDebits, item.cashKey, cashUse);
          recordDebit(linkDebits, linkId, cargoUse);
          if (item.fxKey !== null) recordDebit(fxDebits, item.fxKey, fxUse);
        }
      }
    }
    reservations.push({
      tradePlanId: candidate.tradePlanId,
      linkId,
      goodId: candidate.goodId,
      allocatedQuantity: quantity,
      cargoWeightReserved: cargoUse,
      buyerCashReservedDest: cashUse,
      fxPoolOutputReservedSource: fxUse,
      refusal,
    });
  }

  // An individually acceptable binary64 subtraction can still accumulate
  // beyond ONE absolute epsilon: e.g. two 0.3 debits from 10_000_000 each
  // deviate < 1e-9, while their combined observed debit deviates > 1e-9.
  // Fail closed before publishing any provisional Phase-8 residuals.
  validateCumulativeDebits(initialStock, remainingStock, stockDebits, "export stock", quantityEpsilon);
  validateCumulativeDebits(initialDemand, remainingDemand, demandDebits, "import demand", quantityEpsilon);
  validateCumulativeDebits(initialCash, remainingCash, cashDebits, "buyer cash", moneyEpsilon);
  validateCumulativeDebits(initialLinks, links, linkDebits, "cargo weight", quantityEpsilon);
  validateCumulativeDebits(initialFx, remainingFx, fxDebits, "FX pool output", moneyEpsilon);

  return {
    reservations,
    remainingExportableByOriginGood: remainingStock,
    remainingImportDemandByDestinationGood: remainingDemand,
    remainingBuyerCashByDestinationCurrency: remainingCash,
    remainingFxOutputByPairCurrency: remainingFx,
    remainingCargoWeightByLink: new Map([...links].sort(([a], [b]) => cmp(a, b))),
  };
}
