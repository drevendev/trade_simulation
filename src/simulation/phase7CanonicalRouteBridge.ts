/**
 * M5 / #673 — bind frozen Phase-1 directed permissions to authentic Phase-2/4/5
 * residuals before Phase-6 quote hydration and Phase-7 dispatch.
 *
 * Existing route quote objects carry scoring evidence, NOT route eligibility,
 * quantity caps, cargo weight, cash balances or prices. This bridge verifies
 * complete route/good coverage against the current tick and replaces every
 * caller-controlled legal/physical field from the canonical discovery result.
 * The downstream live planner still derives net/gross/fee/tariff/FX prices,
 * and its ordered reservations + atomic dispatcher remain sole stock writers.
 */
import type { TransportLinkId } from "../domain/id";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import type { Phase7ActorResidualIntent } from "./phase7IntentMatching";
import type { Phase7LiveQuoteWithoutMarketNetPrices } from "./phase7LiveWorldPlan";
import {
  discoverPhase7DirectedTradeOpportunities,
  type Phase7FrozenDirectedTradePermissions,
} from "./phase7AuthorizedRouteDiscovery";

export interface Phase7AuthorizedRouteQuoteBinding {
  readonly opportunityQuotes: readonly Phase7LiveQuoteWithoutMarketNetPrices[];
  readonly eligibleDirectedLinkIdsAtPhase1: ReadonlySet<TransportLinkId>;
}

/**
 * Fail closed on missing or surplus quote evidence. A caller cannot insert an
 * unpermitted route, suppress an eligible route/good, enlarge its legal cap,
 * supply a lighter cargo weight, or turn an absent Phase-1 entry into permission.
 * There is NO trade without complete current Phase-1 and Phase-2/4/5 evidence.
 *
 * The scoring shortage rate is recomputed from authenticated same-tick
 * local residual BUY/SELL envelopes, not accepted from caller quote fields.
 * It predicts the pre-Phase-8 local shortfall; realized shortage telemetry
 * and persistent market expectations remain exclusively Phase-8-owned.
 */
export function bindPhase7DiscoveredRouteQuotes(
  world: WorldState,
  context: Pick<TickContext, "tick" | "phase" | "effectiveJurisdictionByRegion">,
  residualIntents: readonly Phase7ActorResidualIntent[],
  permissions: Phase7FrozenDirectedTradePermissions,
  infrastructureFactors: ReadonlyMap<TransportLinkId, number>,
  quotedRoutes: readonly Phase7LiveQuoteWithoutMarketNetPrices[],
): Phase7AuthorizedRouteQuoteBinding {
  const discovered = discoverPhase7DirectedTradeOpportunities(
    world, context, residualIntents, permissions, infrastructureFactors,
  );
  if (!Array.isArray(quotedRoutes)) {
    throw new Error("Phase-7 route bridge requires explicit quote-scoring evidence");
  }
  const supplied = new Map<string, Phase7LiveQuoteWithoutMarketNetPrices>();
  for (const quote of quotedRoutes) {
    if (!quote || typeof quote.planId !== "string" || !quote.planId ||
        supplied.has(quote.planId)) {
      throw new Error("Phase-7 route bridge duplicate or malformed route quote identity");
    }
    supplied.set(quote.planId, quote);
  }
  if (supplied.size !== discovered.length) {
    throw new Error("Phase-7 route bridge requires complete discovered route/good quote coverage");
  }
  const eligible = new Set<TransportLinkId>();
  const opportunityQuotes = discovered.map(route => {
    const quote = supplied.get(route.planId);
    if (!quote || quote.linkId !== route.linkId ||
        quote.originRegionId !== route.originRegionId ||
        quote.destinationRegionId !== route.destinationRegionId ||
        quote.goodId !== route.goodId) {
      throw new Error("Phase-7 route bridge quote does not match authorized directed route/good");
    }
    eligible.add(route.linkId);
    // Remove even a malicious optional legal cap. An absent bound is different
    // from an externally provided large number and must not be resurrected.
    const {
      legalQuantityCap: _discarded,
      shortageRateDestination: _untrustedShortage,
      ...untrusted
    } = quote;
    return {
      ...untrusted,
      planId: route.planId,
      linkId: route.linkId,
      originRegionId: route.originRegionId,
      destinationRegionId: route.destinationRegionId,
      goodId: route.goodId,
      authorizedAtPhase1: true,
      cargoWeightPerUnit: route.cargoWeightPerUnit,
      shortageRateDestination: route.shortageRateDestination,
      ...(route.legalQuantityCap === undefined
        ? {} : { legalQuantityCap: route.legalQuantityCap }),
    };
  });
  return {
    opportunityQuotes,
    eligibleDirectedLinkIdsAtPhase1: eligible,
  };
}
