/**
 * M5 / #673 — deterministic, read-only Phase-7 intake from actual M4 planning.
 *
 * Phase-2 production/household intents and Phase-5 output offers remain
 * authoritative. Only REALIZED Phase-4 PRE_PRODUCTION allocations reduce the
 * corresponding quantity/spend envelopes; Phase-7 may not reset those budgets.
 *
 * Caller must pass the post-Phase-4/5 canonical WorldState and TickContext.
 * This function validates the tick evidence, but does not prove that arbitrary
 * externally supplied allocations were committed. No stock or money moves.
 */
import { actorRefKey } from "../domain/genesisLedger";
import type { MarketIntent, MarketIntentId } from "./marketIntent";
import { validateMarketIntent } from "./marketIntent";
import type { MarketAllocation } from "./marketClearing";
import type { Phase7ActorResidualIntent } from "./phase7IntentMatching";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import "./m4ClosedEconomyContext";
import "./productionPlanningContext";
import "./householdConsumptionPlanningContext";
import "./productionExecutionContext";

export interface Phase7PostProcurementIntentProjection {
  /** Original validated Phase-2/5 intents with post-Phase-4 commitments. */
  readonly residualIntents: readonly Phase7ActorResidualIntent[];
  /** Reduced local MAIN intents, ready for later committed Phase-7 projection. */
  readonly phase8MainIntents: readonly MarketIntent[];
}

interface Compensated {
  readonly sum: number;
  readonly correction: number;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addDebit(
  totals: Map<MarketIntentId, Compensated>,
  id: MarketIntentId,
  debit: number,
): void {
  const prev = totals.get(id) ?? { sum: 0, correction: 0 };
  const sum = prev.sum + debit;
  const rounding = Math.abs(prev.sum) >= Math.abs(debit)
    ? (prev.sum - sum) + debit
    : (debit - sum) + prev.sum;
  const correction = prev.correction + rounding;
  if (!Number.isFinite(sum) || !Number.isFinite(correction)) {
    throw new Error("Phase-7 intake Phase-4 allocation total lost precision");
  }
  totals.set(id, { sum, correction });
}

function exactResidual(
  initial: number,
  debit: Compensated | undefined,
  epsilon: number,
  label: string,
): number {
  if (debit === undefined) return initial;
  const used = debit.sum + debit.correction;
  if (!Number.isFinite(used) || used < 0 || used > initial) {
    throw new Error("Phase-7 intake " + label + " exceeds committed envelope");
  }
  if (used === 0) return initial;
  const remaining = initial - used;
  if (!Number.isFinite(remaining) || remaining < 0 ||
      remaining === initial ||
      Math.abs((initial - remaining) - used) > epsilon) {
    throw new Error("Phase-7 intake " + label + " lost observable debit precision");
  }
  return remaining;
}

function assertActorAtRegion(world: WorldState, intent: MarketIntent): void {
  const region = world.regions.get(intent.regionId);
  if (!region) throw new Error("Phase-7 intake intent references unknown Region");
  if (intent.actor.type === "PRODUCTION_UNIT") {
    const unit = world.productionUnits.get(intent.actor.productionUnitId);
    if (!unit || unit.seed.regionKey !== region.seed.key) {
      throw new Error("Phase-7 intake ProductionUnit ownership/Region mismatch");
    }
  } else if (intent.actor.type === "COHORT") {
    const cohort = world.cohorts.get(intent.actor.cohortId);
    if (!cohort || cohort.seed.regionKey !== region.seed.key) {
      throw new Error("Phase-7 intake Cohort ownership/Region mismatch");
    }
  } else if (intent.actor.type === "STATE") {
    if (!world.states.has(intent.actor.stateId)) {
      throw new Error("Phase-7 intake missing State actor");
    }
  }
}

function validateCommittedAllocation(
  world: WorldState,
  allocation: MarketAllocation,
  originals: ReadonlyMap<MarketIntentId, MarketIntent>,
): void {
  const buyer = originals.get(allocation.buyerIntentId);
  const seller = originals.get(allocation.sellerIntentId);
  const region = world.regions.get(allocation.regionId);
  const market = world.markets.get(allocation.marketId);
  if (allocation.pass !== "PRE_PRODUCTION" || !buyer || !seller ||
      buyer.side !== "BUY" || buyer.purpose !== "INPUT" || seller.side !== "SELL" ||
      !region || !market || market.seed.regionKey !== region.seed.key ||
      buyer.regionId !== region.regionId || seller.regionId !== region.regionId ||
      buyer.goodId !== allocation.goodId || seller.goodId !== allocation.goodId ||
      actorRefKey(buyer.actor) !== actorRefKey(allocation.buyer) ||
      actorRefKey(seller.actor) !== actorRefKey(allocation.seller) ||
      (buyer.inventoryBucket ?? "GENERAL") !== allocation.buyerInventoryBucket ||
      (seller.inventoryBucket ?? "GENERAL") !== allocation.sellerInventoryBucket ||
      allocation.marketCurrencyId !== region.settlementCurrencyId) {
    throw new Error("Phase-7 intake Phase-4 allocation lacks matching original owner/market evidence");
  }
  if (!Number.isFinite(allocation.quantity) || allocation.quantity <= 0 ||
      !Number.isFinite(allocation.buyerGrossUnitPrice) ||
      allocation.buyerGrossUnitPrice < 0) {
    throw new Error("Phase-7 intake Phase-4 allocation has invalid quantity or gross price");
  }
}

/**
 * Materialize the single post-procurement owner-verified intent set for both
 * Phase-7 matching and Phase-8 fallback. Sorting is stable under any input
 * insertion order. Do not use caller-supplied "remaining" quantities.
 */
export function derivePhase7PostProcurementIntents(
  world: WorldState,
  context: TickContext,
): Phase7PostProcurementIntentProjection {
  if (context.phase !== 7 || !Number.isSafeInteger(context.tick) || context.tick < 0 ||
      !Array.isArray(context.productionMarketIntents) ||
      !Array.isArray(context.householdMarketIntents) ||
      !Array.isArray(context.phase4MarketAllocations)) {
    throw new Error("Phase-7 intake requires complete same-tick Phase-2/4/5 evidence at Phase 7");
  }
  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon;
  if (!Number.isFinite(quantityEpsilon) || quantityEpsilon < 0 ||
      !Number.isFinite(moneyEpsilon) || moneyEpsilon < 0) {
    throw new Error("Phase-7 intake requires finite nonnegative numeric tolerances");
  }

  const originals = new Map<MarketIntentId, MarketIntent>();
  const all = [...context.productionMarketIntents, ...context.householdMarketIntents]
    .sort((a, b) => compare(a.id, b.id));
  for (const intent of all) {
    validateMarketIntent(intent);
    assertActorAtRegion(world, intent);
    if (originals.has(intent.id)) {
      throw new Error("Phase-7 intake duplicate Phase-2/5 MarketIntent ID");
    }
    originals.set(intent.id, intent);
  }

  const filledQuantity = new Map<MarketIntentId, Compensated>();
  const spentGross = new Map<MarketIntentId, Compensated>();
  const seenAllocations = new Set<string>();
  const allocations = [...context.phase4MarketAllocations]
    .sort((a, b) => compare(a.id, b.id));
  for (const allocation of allocations) {
    if (seenAllocations.has(allocation.id)) {
      throw new Error("Phase-7 intake duplicate realized Phase-4 allocation ID");
    }
    seenAllocations.add(allocation.id);
    validateCommittedAllocation(world, allocation, originals);
    const grossSpend = allocation.quantity * allocation.buyerGrossUnitPrice;
    if (!Number.isFinite(grossSpend) ||
        (allocation.buyerGrossUnitPrice > 0 && grossSpend === 0)) {
      throw new Error("Phase-7 intake Phase-4 gross spend is not representable");
    }
    addDebit(filledQuantity, allocation.sellerIntentId, allocation.quantity);
    addDebit(filledQuantity, allocation.buyerIntentId, allocation.quantity);
    addDebit(spentGross, allocation.buyerIntentId, grossSpend);
  }

  const residualIntents: Phase7ActorResidualIntent[] = [];
  const phase8MainIntents: MarketIntent[] = [];
  for (const intent of all) {
    const residualQuantity = exactResidual(
      intent.desiredQuantity, filledQuantity.get(intent.id),
      quantityEpsilon, "remaining quantity",
    );
    if (residualQuantity <= quantityEpsilon) continue;
    if (intent.side === "BUY") {
      const remainingBuyerSpend = exactResidual(
        intent.maxSpend!, spentGross.get(intent.id),
        moneyEpsilon, "remaining buyer spend",
      );
      if (remainingBuyerSpend <= moneyEpsilon) continue;
      residualIntents.push({ intent, residualQuantity, remainingBuyerSpend });
      phase8MainIntents.push({
        ...intent, desiredQuantity: residualQuantity, maxSpend: remainingBuyerSpend,
      });
    } else {
      residualIntents.push({ intent, residualQuantity });
      phase8MainIntents.push({ ...intent, desiredQuantity: residualQuantity });
    }
  }
  return { residualIntents, phase8MainIntents };
}
