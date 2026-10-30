/**
 * M5 / #673: derive Phase-7 opportunity quantities and actor evidence from
 * live post-Phase-4 residual MarketIntents and authoritative WorldState stocks.
 *
 * Phase-1/6 owners supply frozen legal, tax, landed and FX evidence.
 * Both destination NET price (Phase-6 market) and tax-inclusive GROSS reference
 * (current Phase-1 policy) are hydrated before ranking. This module does
 * not invent tariff, tax or FX defaults or commit provisional quantities.
 * The canonical Phase-7 dispatcher remains the only writer.
 */
import { actorRefKey } from "../domain/genesisLedger";
import { validateMarketIntent } from "./marketIntent";
import {
  phase7BuyerActorCashKey,
  phase7SellerEndpointKey,
  type Phase7ActorResidualIntent,
} from "./phase7IntentMatching";
import {
  phase7FxOutputKey,
  phase7RegionCashKey,
  phase7RegionGoodKey,
  type Phase7AggregateBudgets,
} from "./phase7AggregateReservation";
import { buildPhase7LiveActorMatchBudgets } from "./phase7LiveActorMatchBudgets";
import {
  preparePhase7TradePlan,
  type Phase7PreparedTradePlan,
  type Phase7PreparedTradePlanInput,
  type Phase7TradePlanActors,
} from "./phase7TradePlan";
import { marketPriceKey } from "./phase6MarketPriceFormation";
import { quoteFx } from "./fxWorldPoolAuthority";
import type { TickContext } from "./tickOrchestrator";
import type { GoodId, StateId } from "../domain/id";
import type { Phase7CandidateEvidence } from "./tradeCandidateSelection";
import type { LocalMarketState, WorldState } from "./worldState";

/** Only economic quotes/legal decisions come from outside WorldState's stock owner. */
export type Phase7LiveOpportunityQuote = Omit<
  Phase7CandidateEvidence,
  "exportableQuantity" | "residualImportDemandQuantity" | "buyerRemainingBudgetDest"
>;
/** Caller-owned legal, landed, source invoice and FX evidence: neither net nor gross reference price is trusted. */
export type Phase7LiveQuoteWithoutDestinationNetPrice = Omit<
  Phase7LiveOpportunityQuote, "destinationReferenceNetUnitPrice"
>;

/**
 * Frozen Phase-1 import-tariff fixture supplied by the legal-policy owner.
 * M6 will replace this explicit fixture with effective FiscalPolicyState;
 * the planner must never infer a border tariff or accept one from a quote.
 */
export interface Phase7FrozenImportTariffSnapshot {
  readonly tick: number;
  readonly ratesByDestinationStateGood: ReadonlyMap<string, number>;
}

/** Same-tick tax facts from the M3 policy-provider boundary; M6 will own effective fiscal policy. */
export interface Phase7FrozenConsumptionTaxSnapshot {
  readonly tick: number;
  readonly ratesByDestinationStateGood: ReadonlyMap<string, number>;
  readonly collectionEfficiencyByState: ReadonlyMap<StateId, number>;
}

export function phase7ConsumptionTaxKey(stateId: StateId, goodId: GoodId): string {
  return JSON.stringify([stateId, goodId]);
}

export interface Phase7LivePricingContext extends Pick<
  TickContext, "tick" | "phase" | "marketPrices" | "effectiveJurisdictionByRegion"
> {
  readonly phase1ImportTariffs?: Phase7FrozenImportTariffSnapshot | undefined;
  readonly phase1ConsumptionTaxes?: Phase7FrozenConsumptionTaxSnapshot | undefined;
}

export function phase7ImportTariffKey(stateId: StateId, goodId: GoodId): string {
  return JSON.stringify([stateId, goodId]);
}

export interface Phase7LiveWorldPlanInput extends Pick<
  Phase7PreparedTradePlanInput,
  "scorePolicy" | "infrastructureFactors" | "eligibleDirectedLinkIdsAtPhase1" |
  "fxPairIdByTradePlanId"
> {
  /** Frozen legal/landed/FX terms; supplied reference net/gross prices are overwritten. */
  readonly opportunityQuotes: readonly Phase7LiveQuoteWithoutDestinationNetPrice[];
  /** Unique intents after Phase-4 commitments; never original unspent maxSpend. */
  readonly residualIntents: readonly Phase7ActorResidualIntent[];
  /** Tick-local FX output cap after earlier reservations; clamped to LIVE pool funds. */
  readonly fxOutputByPairCurrency: ReadonlyMap<string, number>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Phase-7 live opportunity " + label + " must be finite and non-negative");
  }
}

function observedSum(current: number, increment: number, tolerance: number, label: string): number {
  const next = current + increment;
  if (!Number.isFinite(next) ||
      (increment > 0 && (next === current ||
        Math.abs((next - current) - increment) > tolerance))) {
    throw new Error("Phase-7 live opportunity " + label + " lost numeric precision");
  }
  return next;
}

function add(
  map: Map<string, number>, key: string, quantity: number, tolerance: number, label: string,
): void {
  map.set(key, observedSum(map.get(key) ?? 0, quantity, tolerance, label));
}

function ordered(entries: readonly Phase7ActorResidualIntent[]): Phase7ActorResidualIntent[] {
  return [...entries].sort((a, b) =>
    cmp(actorRefKey(a.intent.actor), actorRefKey(b.intent.actor)) ||
    cmp(a.intent.id, b.intent.id));
}

/**
 * Validate the CURRENT Phase-1 jurisdiction snapshot before consuming any
 * external legal/gross quote. Phase-1 activation persists controllerStateId
 * into WorldState; a mismatched TickContext is stale (or forged), and cannot
 * be used to classify a border or to authorize a tariff in Phase 7.
 *
 * The separate Phase-1 law owner still supplies positive cross-border tariff
 * rates and per-good trade permission. No future PendingTransitions, rate
 * default or synthetic legal permission is read or invented here.
 */
function assertCurrentPhase1LegalQuotes(
  world: Pick<WorldState, "regions" | "states">,
  context: Pick<TickContext, "phase" | "effectiveJurisdictionByRegion">,
  quotes: readonly Phase7LiveQuoteWithoutDestinationNetPrice[],
): void {
  const jurisdiction = context.effectiveJurisdictionByRegion;
  if (context.phase !== 7 || !(jurisdiction instanceof Map)) {
    throw new Error("Phase-7 live legal quote requires current Phase-1 jurisdiction evidence");
  }
  for (const quote of [...quotes].sort((a, b) =>
    cmp(a.linkId, b.linkId) || cmp(a.goodId, b.goodId) || cmp(a.planId, b.planId))) {
    const origin = world.regions.get(quote.originRegionId);
    const destination = world.regions.get(quote.destinationRegionId);
    if (!origin || !destination) {
      throw new Error("Phase-7 live legal quote references an unknown Region");
    }
    if (!jurisdiction.has(origin.regionId) || !jurisdiction.has(destination.regionId)) {
      throw new Error("Phase-7 live legal quote missing current Phase-1 jurisdiction");
    }
    const originController = jurisdiction.get(origin.regionId)!;
    const destinationController = jurisdiction.get(destination.regionId)!;
    if (originController !== origin.controllerStateId ||
        destinationController !== destination.controllerStateId) {
      throw new Error("Phase-7 live legal quote disagrees with activated Phase-1 jurisdiction");
    }
    if ((originController !== null && !world.states.has(originController)) ||
        (destinationController !== null && !world.states.has(destinationController))) {
      throw new Error("Phase-7 live legal quote references an unknown controlling State");
    }
    // Import tariff is a destination-State border charge, never a same-State
    // charge or money sink in an uncontrolled destination (Handoff/04 §23, §32).
    if ((originController === destinationController || destinationController === null) &&
        quote.estimatedTariffRate !== 0) {
      throw new Error("Phase-7 live legal quote cannot charge a tariff without a destination-State border");
    }
  }
}

/**
 * Replace caller-supplied border rates with an explicit current-tick Phase-1
 * legal-policy snapshot before ranking/booking any trade. A missing entry is
 * NOT a zero rate; M6 policy machinery is not silently implemented here.
 *
 * Zero tariffs without a destination-State border follow from jurisdiction,
 * not a caller-selected policy exemption. The rate here is statutory; later
 * gross-cost settlement separately applies collection efficiency exactly once.
 */
export function derivePhase7Phase1ImportTariffs(
  world: Pick<WorldState, "regions" | "states">,
  context: Phase7LivePricingContext,
  quotes: readonly Phase7LiveQuoteWithoutDestinationNetPrice[],
): readonly Phase7LiveQuoteWithoutDestinationNetPrice[] {
  assertCurrentPhase1LegalQuotes(world, context, quotes);
  const snapshot = context.phase1ImportTariffs;
  if (snapshot !== undefined &&
      (!Number.isSafeInteger(context.tick) || context.tick < 0 ||
       snapshot.tick !== context.tick ||
       !(snapshot.ratesByDestinationStateGood instanceof Map))) {
    throw new Error("Phase-7 import tariff requires a current-tick frozen Phase-1 policy snapshot");
  }
  return [...quotes].sort((a, b) =>
    cmp(a.linkId, b.linkId) || cmp(a.goodId, b.goodId) || cmp(a.planId, b.planId))
    .map((quote) => {
      const origin = world.regions.get(quote.originRegionId)!;
      const destination = world.regions.get(quote.destinationRegionId)!;
      let rate = 0;
      if (destination.controllerStateId !== null &&
          destination.controllerStateId !== origin.controllerStateId) {
        if (!snapshot) {
          throw new Error("Phase-7 cross-border import tariff requires frozen Phase-1 policy evidence");
        }
        const key = phase7ImportTariffKey(destination.controllerStateId, quote.goodId);
        if (!snapshot.ratesByDestinationStateGood.has(key)) {
          throw new Error("Phase-7 cross-border import tariff missing destination State/good policy rate");
        }
        rate = snapshot.ratesByDestinationStateGood.get(key)!;
        if (!Number.isFinite(rate) || rate < 0) {
          throw new Error("Phase-7 cross-border import tariff policy rate must be finite and non-negative");
        }
      }
      return { ...quote, estimatedTariffRate: rate };
    });
}

/**
 * Hydrate the gross destination reference from the SAME Phase-6 net price and
 * Phase-1 tax terms that Phase-8 local clearing consumes (Handoff/04 section 2).
 * A missing tax rate/collection efficiency is NOT a zero-rate default.
 *
 * The aggregate route can hold multiple buyer intents. Destination-State
 * PUBLIC_PROCUREMENT is exempt in Phase-8; all other buyers are taxed.
 * A single aggregate candidate cannot truthfully represent mixed gross buyer
 * prices, so refuse that ambiguity instead of mis-ranking or under-reserving it.
 * No money, goods, policy or WorldState stock changes in this preview.
 */
export function derivePhase7DestinationGrossReferencePrices(
  world: Pick<WorldState, "regions" | "states">,
  context: Phase7LivePricingContext,
  pricedQuotes: readonly Phase7LiveOpportunityQuote[],
  residualIntents: readonly Phase7ActorResidualIntent[],
): readonly Phase7LiveOpportunityQuote[] {
  if (context.phase !== 7 || !(context.effectiveJurisdictionByRegion instanceof Map)) {
    throw new Error("Phase-7 gross reference requires current Phase-1 jurisdiction");
  }
  const snapshot = context.phase1ConsumptionTaxes;
  if (snapshot !== undefined &&
      (!Number.isSafeInteger(context.tick) || context.tick < 0 ||
       snapshot.tick !== context.tick ||
       !(snapshot.ratesByDestinationStateGood instanceof Map) ||
       !(snapshot.collectionEfficiencyByState instanceof Map))) {
    throw new Error("Phase-7 gross reference requires a current-tick frozen tax-policy snapshot");
  }

  const treatmentByRegionGood = new Map<string, Set<"TAXED" | "EXEMPT">>();
  for (const { intent, residualQuantity } of ordered(residualIntents)) {
    if (intent.side !== "BUY" || residualQuantity <= 0) continue;
    const destination = world.regions.get(intent.regionId);
    if (!destination || !context.effectiveJurisdictionByRegion.has(intent.regionId) ||
        context.effectiveJurisdictionByRegion.get(intent.regionId) !== destination.controllerStateId) {
      throw new Error("Phase-7 gross reference requires activated destination jurisdiction");
    }
    const controller = destination.controllerStateId;
    const isSelfProcurement = controller !== null &&
      intent.actor.type === "STATE" && intent.actor.stateId === controller &&
      intent.purpose === "PUBLIC_PROCUREMENT";
    const key = phase7RegionGoodKey(intent.regionId, intent.goodId);
    const classes = treatmentByRegionGood.get(key) ?? new Set<"TAXED" | "EXEMPT">();
    classes.add(isSelfProcurement ? "EXEMPT" : "TAXED");
    treatmentByRegionGood.set(key, classes);
  }

  return [...pricedQuotes].sort((a, b) =>
    cmp(a.linkId, b.linkId) || cmp(a.goodId, b.goodId) || cmp(a.planId, b.planId))
    .map((quote) => {
      const destination = world.regions.get(quote.destinationRegionId);
      if (!destination || !context.effectiveJurisdictionByRegion.has(destination.regionId) ||
          context.effectiveJurisdictionByRegion.get(destination.regionId) !== destination.controllerStateId) {
        throw new Error("Phase-7 gross reference requires activated destination jurisdiction");
      }
      const net = quote.destinationReferenceNetUnitPrice;
      if (!Number.isFinite(net) || net <= 0) {
        throw new Error("Phase-7 gross reference requires a positive finite Phase-6 net price");
      }
      const controller = destination.controllerStateId;
      if (controller === null) {
        return { ...quote, destinationReferenceGrossUnitPrice: net };
      }
      if (!world.states.has(controller)) {
        throw new Error("Phase-7 gross reference references an unknown destination State");
      }
      const classes = treatmentByRegionGood.get(
        phase7RegionGoodKey(quote.destinationRegionId, quote.goodId),
      );
      if (classes?.size === 2) {
        throw new Error("Phase-7 gross reference cannot mix taxable and exempt buyer classes");
      }
      if (!snapshot) {
        throw new Error("Phase-7 gross reference requires frozen Phase-1 consumption-tax policy");
      }
      const key = phase7ConsumptionTaxKey(controller, quote.goodId);
      if (!snapshot.ratesByDestinationStateGood.has(key) ||
          !snapshot.collectionEfficiencyByState.has(controller)) {
        throw new Error("Phase-7 gross reference missing destination State tax-policy evidence");
      }
      const rate = snapshot.ratesByDestinationStateGood.get(key)!;
      const efficiency = snapshot.collectionEfficiencyByState.get(controller)!;
      if (!Number.isFinite(rate) || rate < 0 || rate > 1 ||
          !Number.isFinite(efficiency) || efficiency < 0 || efficiency > 1) {
        throw new Error("Phase-7 gross reference tax policy must be finite in [0, 1]");
      }
      // No buyer intents yet: use the canonical household-facing reference,
      // as Phase-8 does, rather than a caller-selected taxable class.
      const collectedPerUnit = classes?.has("EXEMPT") ? 0 : net * rate * efficiency;
      const gross = net + collectedPerUnit;
      if (!Number.isFinite(gross) || gross < net ||
          (collectedPerUnit > 0 && gross === net)) {
        throw new Error("Phase-7 gross reference tax-inclusive price lost money precision");
      }
      return { ...quote, destinationReferenceGrossUnitPrice: gross };
    });
}

/**
 * Clamp each explicitly reserved Phase-7 FX output budget to the canonical
 * base-issuer-owned live pool, net of its operational reserve floor. The
 * supplied tick-local bound may be smaller because another component has
 * already promised liquidity; it must never manufacture money above the
 * current live pool's spendable output. Pair/direction are explicit; no
 * exchange rate, pool, or uncommitted reservation is inferred.
 *
 * This is a pure planner bound, NOT an FX reservation or permission to settle.
 * Actual cross-currency dispatch re-quotes against live WorldState again.
 */
export function derivePhase7LiveFxOutputBudgets(
  world: WorldState,
  quotes: readonly Phase7LiveQuoteWithoutDestinationNetPrice[],
  pairsByPlan: ReadonlyMap<string, string> | undefined,
  remainingOutput: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  if (!(remainingOutput instanceof Map) ||
      (pairsByPlan !== undefined && !(pairsByPlan instanceof Map))) {
    throw new Error("Phase-7 live FX requires explicit tick-local budgets and pair IDs");
  }
  const bounded = new Map<string, number>();
  for (const quote of [...quotes].sort((a, b) =>
    cmp(a.planId, b.planId) || cmp(a.linkId, b.linkId))) {
    const origin = world.regions.get(quote.originRegionId);
    const destination = world.regions.get(quote.destinationRegionId);
    if (!origin || !destination) {
      throw new Error("Phase-7 live FX quote references unknown Regions");
    }
    const pairId = pairsByPlan?.get(quote.planId);
    if (origin.settlementCurrencyId === destination.settlementCurrencyId) {
      if (pairId !== undefined) {
        throw new Error("Phase-7 live same-currency quote must not reserve FX");
      }
      continue;
    }
    if (!pairId || !pairId.trim()) {
      throw new Error("Phase-7 live cross-currency quote requires an explicit FX pair");
    }
    const key = phase7FxOutputKey(pairId, origin.settlementCurrencyId);
    if (!remainingOutput.has(key)) {
      throw new Error("Phase-7 live FX quote missing explicit tick-local output budget");
    }
    const promisedAvailable = remainingOutput.get(key)!;
    requireNonnegative(promisedAvailable, "FX available output");
    // quoteFx validates canonical pool owner, currencies, rate, spread,
    // reserve floors and live balances. A zero output quote returns its
    // reserve-limited ceiling without reserving or consuming any liquidity.
    const physicalAvailable = quoteFx(
      world, pairId, destination.settlementCurrencyId,
      origin.settlementCurrencyId, 0,
    ).maxOutputByPoolReserve;
    bounded.set(key, Math.min(promisedAvailable, physicalAvailable));
  }
  return bounded;
}

/**
 * Build actual owner-constrained stocks, aggregated regional upper bounds and
 * per-route actors in one deterministic pass. Same physical State inventory
 * may appear as an upper bound at different origin Regions, but is represented
 * by ONE global physical endpoint in actorBudgets. If such provisional regional
 * reservations overdraw it, preparePhase7TradePlan fails closed; no invented
 * per-region State stock is ever accepted as an economic commitment.
 */
export function buildPhase7LiveWorldPlanInput(
  world: WorldState,
  context: Phase7LivePricingContext,
  input: Phase7LiveWorldPlanInput,
): Phase7PreparedTradePlanInput {
  // Freeze current Phase-1 jurisdiction and explicit destination tariff policy.
  const lawfulQuotes = derivePhase7Phase1ImportTariffs(world, context, input.opportunityQuotes);
  // Hydrate before reservations: no caller-controlled market net price enters the plan.
  const pricedQuotes = derivePhase7DestinationNetPrices(world, context, lawfulQuotes);
  const grossPricedQuotes = derivePhase7DestinationGrossReferencePrices(
    world, context, pricedQuotes, input.residualIntents,
  );
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  if (quantityEpsilon === undefined || moneyEpsilon === undefined ||
      !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0 ||
      !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0) {
    throw new Error("Phase-7 live opportunity requires resolved numeric tolerances");
  }

  const seenIntentIds = new Set<string>();
  const sellers = new Map<string, Phase7ActorResidualIntent[]>();
  const buyers = new Map<string, Phase7ActorResidualIntent[]>();
  const protectedByEndpoint = new Map<string, number>();
  const demand = new Map<string, number>();
  const actorSpendByRegionCurrency = new Map<string, Map<string, number>>();
  const sellDemandByRegionEndpoint = new Map<string, Map<string, number>>();

  for (const entry of ordered(input.residualIntents)) {
    const intent = entry.intent;
    validateMarketIntent(intent);
    if (seenIntentIds.has(intent.id)) {
      throw new Error("Phase-7 live opportunity duplicate residual intent ID");
    }
    seenIntentIds.add(intent.id);
    if (!world.regions.has(intent.regionId)) {
      throw new Error("Phase-7 live opportunity references an unknown intent Region");
    }
    requireNonnegative(entry.residualQuantity, "residual quantity");
    if (entry.residualQuantity > intent.desiredQuantity) {
      throw new Error("Phase-7 live opportunity residual exceeds original intent");
    }
    const groupKey = phase7RegionGoodKey(intent.regionId, intent.goodId);
    if (intent.side === "SELL") {
      if (entry.remainingBuyerSpend !== undefined) {
        throw new Error("Phase-7 live SELL must not carry buyer spend");
      }
      const endpoint = phase7SellerEndpointKey(intent);
      protectedByEndpoint.set(
        endpoint,
        Math.max(protectedByEndpoint.get(endpoint) ?? 0, intent.minimumReserveQuantity ?? 0),
      );
      const group = sellers.get(groupKey) ?? [];
      group.push(entry);
      sellers.set(groupKey, group);
      const endpointDemand = sellDemandByRegionEndpoint.get(groupKey) ?? new Map<string, number>();
      add(endpointDemand, endpoint, entry.residualQuantity, quantityEpsilon, "seller residual");
      sellDemandByRegionEndpoint.set(groupKey, endpointDemand);
    } else {
      if (entry.remainingBuyerSpend === undefined) {
        throw new Error("Phase-7 live BUY requires post-Phase-4 remaining spend");
      }
      requireNonnegative(entry.remainingBuyerSpend, "buyer remaining spend");
      if (entry.remainingBuyerSpend > (intent.maxSpend ?? 0)) {
        throw new Error("Phase-7 live BUY spend exceeds original maxSpend");
      }
      const group = buyers.get(groupKey) ?? [];
      group.push(entry);
      buyers.set(groupKey, group);
      add(demand, groupKey, entry.residualQuantity, quantityEpsilon, "import demand");

      const currency = world.regions.get(intent.regionId)!.settlementCurrencyId;
      const regionCashKey = phase7RegionCashKey(intent.regionId, currency);
      const actorCashKey = phase7BuyerActorCashKey(intent.actor, currency);
      const spendByActor = actorSpendByRegionCurrency.get(regionCashKey) ?? new Map<string, number>();
      add(spendByActor, actorCashKey, entry.remainingBuyerSpend, moneyEpsilon, "actor spend");
      actorSpendByRegionCurrency.set(regionCashKey, spendByActor);
    }
  }

  const actorsByTradePlanId = new Map<string, Phase7TradePlanActors>();
  const seenPlans = new Set<string>();
  const seenLinkGoods = new Set<string>();
  for (const quote of [...grossPricedQuotes].sort((a, b) =>
    cmp(a.linkId, b.linkId) || cmp(a.goodId, b.goodId) || cmp(a.planId, b.planId))) {
    if (seenPlans.has(quote.planId) ||
        seenLinkGoods.has(JSON.stringify([quote.linkId, quote.goodId]))) {
      throw new Error("Phase-7 live opportunity duplicate plan or link/good");
    }
    seenPlans.add(quote.planId);
    seenLinkGoods.add(JSON.stringify([quote.linkId, quote.goodId]));
    const link = world.transportLinks.get(quote.linkId);
    if (!link || link.fromRegionId !== quote.originRegionId ||
        link.toRegionId !== quote.destinationRegionId) {
      throw new Error("Phase-7 live opportunity references a mismatched directed link");
    }
    actorsByTradePlanId.set(quote.planId, {
      sellers: sellers.get(phase7RegionGoodKey(quote.originRegionId, quote.goodId)) ?? [],
      buyers: buyers.get(phase7RegionGoodKey(quote.destinationRegionId, quote.goodId)) ?? [],
    });
  }
  const actorBudgets = buildPhase7LiveActorMatchBudgets(
    world, actorsByTradePlanId, protectedByEndpoint,
  );

  const exportableByOriginGood = new Map<string, number>();
  for (const [regionGood, endpointDemands] of [...sellDemandByRegionEndpoint].sort(([a], [b]) => cmp(a, b))) {
    let total = 0;
    for (const [endpoint, requested] of [...endpointDemands].sort(([a], [b]) => cmp(a, b))) {
      const physical = actorBudgets.sellerExportableByEndpoint.get(endpoint);
      // An intent without a quoted route does not have to become a matcher input.
      // Its region/good bound is still computed only if the endpoint is actually quoted.
      if (physical !== undefined) {
        total = observedSum(total, Math.min(requested, physical), quantityEpsilon, "export supply");
      }
    }
    exportableByOriginGood.set(regionGood, total);
  }

  const buyerCashByDestinationCurrency = new Map<string, number>();
  for (const [regionCurrency, byActor] of [...actorSpendByRegionCurrency].sort(([a], [b]) => cmp(a, b))) {
    let cash = 0;
    for (const [actorKey, spend] of [...byActor].sort(([a], [b]) => cmp(a, b))) {
      const physical = actorBudgets.buyerCashByActorCurrency.get(actorKey);
      if (physical !== undefined) {
        cash = observedSum(cash, Math.min(spend, physical), moneyEpsilon, "regional buyer cash");
      }
    }
    buyerCashByDestinationCurrency.set(regionCurrency, cash);
  }

  const fxOutputByPairCurrency = derivePhase7LiveFxOutputBudgets(
    world, grossPricedQuotes, input.fxPairIdByTradePlanId, input.fxOutputByPairCurrency,
  );
  const aggregateBudgets: Phase7AggregateBudgets = {
    exportableByOriginGood, importDemandByDestinationGood: demand,
    buyerCashByDestinationCurrency, fxOutputByPairCurrency,
  };

  const opportunities: Phase7CandidateEvidence[] = grossPricedQuotes.map((quote) => {
    const sourceKey = phase7RegionGoodKey(quote.originRegionId, quote.goodId);
    const destinationKey = phase7RegionGoodKey(quote.destinationRegionId, quote.goodId);
    const currency = world.regions.get(quote.destinationRegionId)?.settlementCurrencyId;
    if (!currency) throw new Error("Phase-7 live opportunity destination currency missing");
    return {
      ...quote,
      exportableQuantity: exportableByOriginGood.get(sourceKey) ?? 0,
      residualImportDemandQuantity: demand.get(destinationKey) ?? 0,
      buyerRemainingBudgetDest: buyerCashByDestinationCurrency.get(
        phase7RegionCashKey(quote.destinationRegionId, currency),
      ) ?? 0,
    };
  });
  return {
    opportunities, scorePolicy: input.scorePolicy,
    infrastructureFactors: input.infrastructureFactors,
    eligibleDirectedLinkIdsAtPhase1: input.eligibleDirectedLinkIdsAtPhase1,
    aggregateBudgets, actorBudgets, actorsByTradePlanId,
    ...(input.fxPairIdByTradePlanId !== undefined
      ? { fxPairIdByTradePlanId: input.fxPairIdByTradePlanId } : {}),
  };
}

/** Read-only Phase-7 preview using live goods and cash rather than caller stock claims. */
export function preparePhase7LiveWorldTradePlan(
  world: WorldState,
  context: Phase7LivePricingContext,
  input: Phase7LiveWorldPlanInput,
): Phase7PreparedTradePlan {
  return preparePhase7TradePlan(
    world, world.simulationConfig, buildPhase7LiveWorldPlanInput(world, context, input),
  );
}

/**
 * Derive the destination market's net reference price from the SAME Phase-6
 * evidence that Phase-8 will clear against. This removes a caller-controlled
 * price from the live Phase-7 opportunity builder. The next hydration pass
 * computes the destination gross reference from frozen Phase-1 tax evidence;
 * source invoices, landed costs, FX and legal decisions retain their owners.
 *
 * Only valid at the Phase-7 boundary. A Phase-6 price in TickContext takes
 * precedence over the live carried market price, matching Phase-8's rule.
 * Missing/ambiguous markets or malformed prices fail closed; there is no
 * invented default price and the supplied WorldState/context are untouched.
 */
export function derivePhase7DestinationNetPrices(
  world: Pick<WorldState, "regions" | "markets" | "transportLinks">,
  context: Pick<TickContext, "phase" | "marketPrices">,
  quotes: readonly Phase7LiveQuoteWithoutDestinationNetPrice[],
): readonly Phase7LiveOpportunityQuote[] {
  if (context.phase !== 7 || !(context.marketPrices instanceof Map)) {
    throw new Error("Phase-7 net price evidence requires live Phase-7 market prices");
  }
  const marketsByRegionKey = new Map<string, LocalMarketState[]>();
  for (const market of world.markets.values()) {
    const current = marketsByRegionKey.get(market.seed.regionKey) ?? [];
    current.push(market);
    marketsByRegionKey.set(market.seed.regionKey, current);
  }
  return [...quotes].sort((a, b) =>
    cmp(a.linkId, b.linkId) || cmp(a.goodId, b.goodId) || cmp(a.planId, b.planId))
    .map((quote) => {
      const destination = world.regions.get(quote.destinationRegionId);
      const link = world.transportLinks.get(quote.linkId);
      if (!destination || !link ||
          link.fromRegionId !== quote.originRegionId ||
          link.toRegionId !== quote.destinationRegionId) {
        throw new Error("Phase-7 net price quote references a mismatched directed link or Region");
      }
      const matching = marketsByRegionKey.get(destination.seed.key) ?? [];
      if (matching.length !== 1) {
        throw new Error("Phase-7 net price quote requires exactly one destination LocalMarket");
      }
      const market = matching[0]!;
      const key = marketPriceKey(market.marketId, quote.goodId);
      const netPrice = context.marketPrices.get(key) ?? market.priceByGood.get(quote.goodId);
      if (netPrice === undefined || !Number.isFinite(netPrice) || netPrice <= 0) {
        throw new Error("Phase-7 net price quote requires a finite positive canonical market price");
      }
      return { ...quote, destinationReferenceNetUnitPrice: netPrice };
    });
}
