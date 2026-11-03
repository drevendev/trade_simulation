/**
 * M5 / #673: pure current-tick directed route/good discovery.
 *
 * Only a frozen Phase-1 permission fixture can authorize a directed link AND
 * good. Supply and demand are the canonical post-Phase-4 residual intents, not
 * invented regional market totals. This discovers candidates, not shipments:
 * the existing Phase-7 live planner still owns physical stock, cash, FX,
 * tariff, tax and capacity reservations and must revalidate each matched lot.
 *
 * M6 effective policy will replace the explicit Phase-1 legal fixture. An
 * absent fixture/entry is never permission, and Phase-14 transitions are never
 * inspected to authorize a current-tick shipment.
 */
import type { GoodId, RegionId, StateId, TransportLinkId } from "../domain/id";
import { actorRefKey } from "../domain/genesisLedger";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import { validateMarketIntent } from "./marketIntent";
import type { Phase7ActorResidualIntent } from "./phase7IntentMatching";
import { effectiveTransportLinkCapacity, hasUsableTransportCapacity } from "./transportCapacity";

/**
 * An explicit Phase-1 legal decision for each directed link and good.
 * A null cap means this policy imposes no quantity cap; zero prohibits trade.
 * An absent (link, good) is prohibited, never implicitly permitted.
 */
export interface Phase7FrozenDirectedTradePermissions {
  readonly tick: number;
  readonly permittedGoodsByDirectedLink: ReadonlyMap<
    TransportLinkId, ReadonlyMap<GoodId, number | null>
  >;
}

/**
 * Current-tick Phase-1 capture boundary for an independently owned legal-policy
 * provider. The policy must explicitly decide each configured directed link/good:
 * undefined prohibits it, null permits it without an additional quantity cap,
 * and a nonnegative number supplies a statutory quantity ceiling.
 *
 * This is NOT M6 policy generation. In particular, a link, jurisdiction or
 * future PendingTransition never implies trade permission or a zero tariff.
 * The result is tick-scoped evidence for Phase-7 route discovery; the caller
 * must retain the snapshot from Phase 1 rather than recompute it in Phase 7.
 */
export interface Phase7Phase1TradeLawQuery {
  readonly tick: number;
  readonly linkId: TransportLinkId;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly originControllerStateId: StateId | null;
  readonly destinationControllerStateId: StateId | null;
  readonly goodId: GoodId;
}

export type Phase7Phase1TradeLawProvider = (
  query: Readonly<Phase7Phase1TradeLawQuery>,
) => number | null | undefined;

export function capturePhase7DirectedTradePermissionsAtPhase1(
  world: WorldState,
  context: Pick<TickContext, "tick" | "phase" | "effectiveJurisdictionByRegion">,
  decide: Phase7Phase1TradeLawProvider,
): Phase7FrozenDirectedTradePermissions {
  const effective = context.effectiveJurisdictionByRegion;
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 ||
      context.phase !== 1 || !(effective instanceof Map) ||
      typeof decide !== "function") {
    throw new Error("Phase-1 trade permission capture requires current Phase-1 law authority");
  }
  // Validate the WHOLE activated jurisdiction snapshot before asking for any
  // law decision. No partial/stale Map may silently authorize a different border.
  if (effective.size !== world.regions.size) {
    throw new Error("Phase-1 trade permission capture has incomplete jurisdiction");
  }
  for (const [regionId, region] of [...world.regions].sort(([a], [b]) => cmp(a, b))) {
    if (!effective.has(regionId) ||
        effective.get(regionId) !== region.controllerStateId ||
        (region.controllerStateId !== null &&
         !world.states.has(region.controllerStateId))) {
      throw new Error("Phase-1 trade permission capture has stale jurisdiction");
    }
  }
  const goods = Object.entries(world.definitionRegistry.goods)
    .filter(([, definition]) => definition.tradable)
    .sort(([a], [b]) => cmp(a, b));
  const permittedGoodsByDirectedLink =
    new Map<TransportLinkId, ReadonlyMap<GoodId, number | null>>();
  for (const [linkId, link] of [...world.transportLinks].sort(([a], [b]) => cmp(a, b))) {
    const origin = world.regions.get(link.fromRegionId);
    const destination = world.regions.get(link.toRegionId);
    if (link.linkId !== linkId || !origin || !destination) {
      throw new Error("Phase-1 trade permission capture references an invalid directed link");
    }
    const permitted = new Map<GoodId, number | null>();
    for (const [goodKey] of goods) {
      const goodId = goodKey as GoodId;
      const cap = decide(Object.freeze({
        tick: context.tick, linkId,
        originRegionId: origin.regionId,
        destinationRegionId: destination.regionId,
        originControllerStateId: origin.controllerStateId,
        destinationControllerStateId: destination.controllerStateId,
        goodId,
      }));
      if (cap === undefined) continue; // An absent legal decision is NOT permission.
      if (cap !== null) {
        if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) {
          throw new Error("Phase-1 trade permission capture requires a finite nonnegative legal cap");
        }
      }
      permitted.set(goodId, cap);
    }
    if (permitted.size > 0) permittedGoodsByDirectedLink.set(linkId, permitted);
  }
  return { tick: context.tick, permittedGoodsByDirectedLink };
}

/** An unpriced, unreserved route opportunity; never a committed trade. */
export interface Phase7DiscoveredRouteOpportunity {
  readonly planId: string;
  readonly linkId: TransportLinkId;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
  readonly goodId: GoodId;
  readonly sourceResidualQuantity: number;
  readonly destinationResidualQuantity: number;
  readonly destinationRemainingBuyerSpend: number;
  /** Phase-7 projected shortage if local residual sellers were matched first.
   * This is NOT realized Phase-8 shortage telemetry or a new persistent EMA. */
  readonly shortageRateDestination: number;
  readonly cargoWeightPerUnit: number;
  /** Quantity ceiling before actual seller stock, cash and FX preflight. */
  readonly physicalQuantityCap: number;
  readonly legalQuantityCap?: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Phase-7 route discovery " + label + " must be finite and non-negative");
  }
}

function sumExact(previous: number, increment: number, epsilon: number, label: string): number {
  const sum = previous + increment;
  if (!Number.isFinite(sum) || (increment > 0 &&
      (sum === previous || Math.abs((sum - previous) - increment) > epsilon))) {
    throw new Error("Phase-7 route discovery " + label + " lost numeric precision");
  }
  return sum;
}

function group(regionId: RegionId, goodId: GoodId): string {
  return JSON.stringify([regionId, goodId]);
}

function assertActorRegion(world: WorldState, entry: Phase7ActorResidualIntent): void {
  const { actor, regionId } = entry.intent;
  const region = world.regions.get(regionId);
  if (!region) throw new Error("Phase-7 route discovery intent references an unknown Region");
  if (actor.type === "COHORT") {
    const cohort = world.cohorts.get(actor.cohortId);
    if (!cohort || cohort.seed.regionKey !== region.seed.key) {
      throw new Error("Phase-7 route discovery Cohort/Region ownership mismatch");
    }
  } else if (actor.type === "PRODUCTION_UNIT") {
    const unit = world.productionUnits.get(actor.productionUnitId);
    if (!unit || unit.seed.regionKey !== region.seed.key) {
      throw new Error("Phase-7 route discovery ProductionUnit/Region ownership mismatch");
    }
  } else if (actor.type === "STATE" && !world.states.has(actor.stateId)) {
    throw new Error("Phase-7 route discovery references an unknown State actor");
  }
}

/**
 * Discover only direct configured links whose Phase-1 link/good authorization,
 * residual seller quantity, buyer quantity, buyer budget and physical capacity
 * all admit a shipment. Return canonical-ID order, regardless of Map/intent
 * iteration order; economic score ranking still belongs to the Phase-7 planner.
 *
 * The buyer budget here is an independent provisional bound: buyer cash shared
 * by multiple goods is charged only once by subsequent actor matching and the
 * fail-atomic dispatcher. This helper never mutates WorldState or intents.
 */
export function discoverPhase7DirectedTradeOpportunities(
  world: WorldState,
  context: Pick<TickContext, "tick" | "phase" | "effectiveJurisdictionByRegion">,
  residualIntents: readonly Phase7ActorResidualIntent[],
  permissions: Phase7FrozenDirectedTradePermissions,
  infrastructureFactors: ReadonlyMap<TransportLinkId, number>,
): readonly Phase7DiscoveredRouteOpportunity[] {
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 || context.phase !== 7 ||
      !(context.effectiveJurisdictionByRegion instanceof Map) ||
      !permissions || permissions.tick !== context.tick ||
      !(permissions.permittedGoodsByDirectedLink instanceof Map) ||
      !(infrastructureFactors instanceof Map)) {
    throw new Error("Phase-7 route discovery requires current frozen Phase-1 legal and capacity evidence");
  }
  // Reject partial or stale world-wide Phase-1 jurisdiction, even when the
  // altered region is not an endpoint of a currently permitted route.
  // Checking only selected links would let a forged snapshot pass discovery.
  const effective = context.effectiveJurisdictionByRegion;
  if (effective.size !== world.regions.size ||
      [...world.regions].some(([regionId, region]) =>
        !effective.has(regionId) ||
        effective.get(regionId) !== region.controllerStateId ||
        (region.controllerStateId !== null &&
         !world.states.has(region.controllerStateId)))) {
    throw new Error("Phase-7 route discovery has stale/invalid Phase-1 jurisdiction");
  }
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  const minShipment = world.simulationConfig.trade.shipmentMinimumQuantity;
  if (quantityEpsilon === undefined || moneyEpsilon === undefined || minShipment === undefined ||
      !Number.isFinite(quantityEpsilon) || quantityEpsilon < 0 ||
      !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0 ||
      !Number.isFinite(minShipment) || minShipment <= 0) {
    throw new Error("Phase-7 route discovery needs resolved numeric/shipment config");
  }

  const sellers = new Map<string, number>();
  const buyers = new Map<string, number>();
  const buyerSpend = new Map<string, number>();
  const seen = new Set<string>();
  const ordered = [...residualIntents].sort((a, b) =>
    cmp(a.intent.regionId, b.intent.regionId) ||
    cmp(a.intent.goodId, b.intent.goodId) ||
    cmp(a.intent.side, b.intent.side) ||
    cmp(actorRefKey(a.intent.actor), actorRefKey(b.intent.actor)) ||
    cmp(a.intent.id, b.intent.id));
  for (const entry of ordered) {
    const { intent, residualQuantity } = entry;
    validateMarketIntent(intent);
    assertActorRegion(world, entry);
    if (seen.has(intent.id)) throw new Error("Phase-7 route discovery duplicate residual intent ID");
    seen.add(intent.id);
    nonnegative(residualQuantity, "residual quantity");
    if (residualQuantity > intent.desiredQuantity) {
      throw new Error("Phase-7 route discovery residual quantity exceeds original intent");
    }
    const key = group(intent.regionId, intent.goodId);
    if (intent.side === "SELL") {
      if (entry.remainingBuyerSpend !== undefined) {
        throw new Error("Phase-7 route discovery SELL cannot carry buyer spend");
      }
      if (residualQuantity > quantityEpsilon) {
        sellers.set(key, sumExact(sellers.get(key) ?? 0, residualQuantity, quantityEpsilon, "seller quantity"));
      }
    } else {
      if (entry.remainingBuyerSpend === undefined) {
        throw new Error("Phase-7 route discovery BUY missing committed remaining spend");
      }
      nonnegative(entry.remainingBuyerSpend, "remaining buyer spend");
      if (entry.remainingBuyerSpend > intent.maxSpend!) {
        throw new Error("Phase-7 route discovery remaining spend exceeds original BUY budget");
      }
      if (residualQuantity > quantityEpsilon && entry.remainingBuyerSpend > moneyEpsilon) {
        buyers.set(key, sumExact(buyers.get(key) ?? 0, residualQuantity, quantityEpsilon, "buyer quantity"));
        buyerSpend.set(key, sumExact(buyerSpend.get(key) ?? 0,
          entry.remainingBuyerSpend, moneyEpsilon, "buyer spend"));
      }
    }
  }

  const opportunities: Phase7DiscoveredRouteOpportunity[] = [];
  for (const [linkId, permittedGoods] of [...permissions.permittedGoodsByDirectedLink]
    .sort(([a], [b]) => cmp(a, b))) {
    const link = world.transportLinks.get(linkId);
    if (!link || !(permittedGoods instanceof Map)) {
      throw new Error("Phase-7 route discovery permission references an invalid directed link");
    }
    const origin = world.regions.get(link.fromRegionId);
    const destination = world.regions.get(link.toRegionId);
    if (!origin || !destination ||
        !context.effectiveJurisdictionByRegion.has(origin.regionId) ||
        !context.effectiveJurisdictionByRegion.has(destination.regionId) ||
        context.effectiveJurisdictionByRegion.get(origin.regionId) !== origin.controllerStateId ||
        context.effectiveJurisdictionByRegion.get(destination.regionId) !== destination.controllerStateId ||
        (origin.controllerStateId !== null && !world.states.has(origin.controllerStateId)) ||
        (destination.controllerStateId !== null && !world.states.has(destination.controllerStateId))) {
      throw new Error("Phase-7 route discovery has stale/invalid Phase-1 jurisdiction");
    }
    if (!infrastructureFactors.has(linkId)) {
      throw new Error("Phase-7 route discovery missing independently owned infrastructure factor");
    }
    const factor = infrastructureFactors.get(linkId)!;
    const usable = hasUsableTransportCapacity(link, world.simulationConfig, factor);
    const physicalCapacity = effectiveTransportLinkCapacity(link, factor);
    for (const [goodId, legalQuantityCap] of [...permittedGoods].sort(([a], [b]) => cmp(a, b))) {
      if (legalQuantityCap !== null) nonnegative(legalQuantityCap, "legal quantity cap");
      const good = world.definitionRegistry.goods[goodId];
      if (!good) throw new Error("Phase-7 route discovery permission references unknown GoodDefinition");
      if (!good.tradable) continue;
      if (!Number.isFinite(good.cargoWeightPerUnit) || good.cargoWeightPerUnit <= 0) {
        throw new Error("Phase-7 route discovery requires positive canonical cargo weight");
      }
      const available = sellers.get(group(origin.regionId, goodId)) ?? 0;
      const demanded = buyers.get(group(destination.regionId, goodId)) ?? 0;
      const remainingSpend = buyerSpend.get(group(destination.regionId, goodId)) ?? 0;
      const localOffer = sellers.get(group(destination.regionId, goodId)) ?? 0;
      if (!usable || available <= quantityEpsilon || demanded <= quantityEpsilon ||
          remainingSpend <= moneyEpsilon) continue;
      const cap = Math.min(available, demanded, physicalCapacity / good.cargoWeightPerUnit,
        legalQuantityCap ?? Number.POSITIVE_INFINITY);
      if (!Number.isFinite(cap) || cap < 0) {
        throw new Error("Phase-7 route discovery invalid candidate physical cap");
      }
      if (cap <= quantityEpsilon || cap < minShipment) continue;
      // Phase-7 cannot observe realized Phase-8 clearing yet. Approximate
      // its shortage ratio with the same residual BUY and local SELL envelopes
      // that Phase-8 will receive after any imports are reserved. This is a
      // pre-trade scoring forecast, not a realized/EMA MarketExpectation write.
      const potentialLocalCleared = Math.min(demanded, localOffer);
      const shortageRateDestination = (demanded - potentialLocalCleared) / demanded;
      if (!Number.isFinite(shortageRateDestination) ||
          shortageRateDestination < 0 || shortageRateDestination > 1) {
        throw new Error("Phase-7 route discovery invalid projected shortage rate");
      }
      opportunities.push({
        planId: JSON.stringify(["m5:route", linkId, goodId]),
        linkId, originRegionId: origin.regionId, destinationRegionId: destination.regionId,
        goodId, sourceResidualQuantity: available, destinationResidualQuantity: demanded,
        destinationRemainingBuyerSpend: remainingSpend,
        shortageRateDestination,
        cargoWeightPerUnit: good.cargoWeightPerUnit, physicalQuantityCap: cap,
        ...(legalQuantityCap === null ? {} : { legalQuantityCap }),
      });
    }
  }
  return opportunities.sort((a, b) =>
    cmp(a.originRegionId, b.originRegionId) ||
    cmp(a.destinationRegionId, b.destinationRegionId) ||
    cmp(a.goodId, b.goodId) || cmp(a.linkId, b.linkId));
}
