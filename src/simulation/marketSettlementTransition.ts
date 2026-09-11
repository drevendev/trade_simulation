/**
 * `MarketSettlement.executeAllocation(world, ctx, allocation)` -- the canonical
 * mutation boundary for one realized local-market `MarketAllocation` (Handoff/04
 * section 35, "Deterministic APIs"; recommended module boundary
 * `MarketSettlement.executeAllocation(world, ctx, allocation)`).
 *
 * `marketSettlement.ts` intentionally stays pure (it only constructs
 * `EconomicTransaction` records and reads no `WorldState`, per section 35: "Pure
 * planning/allocation functions should return plans/deltas. Mutation belongs in
 * explicit settlement/delivery functions."). This module is that explicit mutation
 * boundary: it applies one allocation's five-step atomic bundle (section 10) against
 * the live, canonically-owned wallet/inventory fields on `ClanState`, `StateState`
 * and `ProductionUnitState` and returns the resulting `WorldState`.
 *
 * Dispatch is strictly by `ActorRef.type` + inventory bucket to each actor's own
 * canonical field (Handoff/04 sections 5, 10-11). `ClanState` owns only a live
 * treasury and never a physical-goods inventory, so any goods-bucket transfer
 * addressed to a CLAN actor has no canonical endpoint and this module throws rather
 * than inventing or guessing one -- the same rule section 35's failure semantics
 * (section 37) require for a missing referenced stock endpoint.
 */

import type { ActorRef } from "../domain/genesisLedger";
import type { CurrencyId, GoodId } from "../domain/id";
import type { MarketAllocation } from "./marketClearing";
import type { TickContext } from "./tickOrchestrator";
import type { Inventory, Wallet, WorldState } from "./worldState";
import { preflightMarketSettlement } from "./marketSettlement";

type InventoryBucket = MarketAllocation["sellerInventoryBucket"];

function actorLabel(actor: ActorRef): string {
  switch (actor.type) {
    case "CLAN":
      return `CLAN ${actor.clanId}`;
    case "STATE":
      return `STATE ${actor.stateId}`;
    case "PRODUCTION_UNIT":
      return `PRODUCTION_UNIT ${actor.productionUnitId}`;
    case "MONETARY_AUTHORITY":
      return `MONETARY_AUTHORITY ${actor.authorityId}`;
  }
}

function getActorWallet(world: WorldState, actor: ActorRef): Wallet {
  switch (actor.type) {
    case "CLAN": {
      const clan = world.clans.get(actor.clanId);
      if (!clan) {
        throw new Error(`executeAllocation: no ClanState for ${actorLabel(actor)}`);
      }
      return clan.treasury;
    }
    case "STATE": {
      const state = world.states.get(actor.stateId);
      if (!state) {
        throw new Error(`executeAllocation: no StateState for ${actorLabel(actor)}`);
      }
      return state.treasury;
    }
    case "PRODUCTION_UNIT": {
      const productionUnit = world.productionUnits.get(actor.productionUnitId);
      if (!productionUnit) {
        throw new Error(`executeAllocation: no ProductionUnitState for ${actorLabel(actor)}`);
      }
      return productionUnit.wallet;
    }
    case "MONETARY_AUTHORITY":
      throw new Error(
        `executeAllocation: no canonical market-settlement wallet endpoint for ${actorLabel(actor)}`,
      );
  }
}

function withActorWallet(world: WorldState, actor: ActorRef, wallet: Wallet): WorldState {
  switch (actor.type) {
    case "CLAN": {
      const clan = world.clans.get(actor.clanId)!;
      const clans = new Map(world.clans);
      clans.set(actor.clanId, { ...clan, treasury: wallet });
      return { ...world, clans };
    }
    case "STATE": {
      const state = world.states.get(actor.stateId)!;
      const states = new Map(world.states);
      states.set(actor.stateId, { ...state, treasury: wallet });
      return { ...world, states };
    }
    case "PRODUCTION_UNIT": {
      const productionUnit = world.productionUnits.get(actor.productionUnitId)!;
      const productionUnits = new Map(world.productionUnits);
      productionUnits.set(actor.productionUnitId, { ...productionUnit, wallet });
      return { ...world, productionUnits };
    }
    case "MONETARY_AUTHORITY":
      throw new Error(
        `executeAllocation: no canonical market-settlement wallet endpoint for ${actorLabel(actor)}`,
      );
  }
}

function getActorInventory(world: WorldState, actor: ActorRef, bucket: InventoryBucket): Inventory {
  if (actor.type === "STATE") {
    if (bucket !== "GENERAL") {
      throw new Error(
        `executeAllocation: StateState has no canonical "${bucket}" inventory bucket (only GENERAL/publicInventory)`,
      );
    }
    const state = world.states.get(actor.stateId);
    if (!state) {
      throw new Error(`executeAllocation: no StateState for ${actorLabel(actor)}`);
    }
    return state.publicInventory;
  }

  if (actor.type === "PRODUCTION_UNIT") {
    const productionUnit = world.productionUnits.get(actor.productionUnitId);
    if (!productionUnit) {
      throw new Error(`executeAllocation: no ProductionUnitState for ${actorLabel(actor)}`);
    }
    switch (bucket) {
      case "INPUT":
        return productionUnit.inputInventory;
      case "OUTPUT":
        return productionUnit.outputInventory;
      case "INVESTMENT":
        return productionUnit.investmentInventory;
      case "GENERAL":
        throw new Error(
          `executeAllocation: ProductionUnitState has no canonical GENERAL inventory bucket ` +
            `(INPUT/OUTPUT/INVESTMENT only, Handoff/04 section 11)`,
        );
    }
  }

  throw new Error(
    `executeAllocation: no canonical "${bucket}" inventory endpoint for ${actorLabel(actor)}. ` +
      `CLAN never owns a physical-goods inventory (Handoff/04 sections 5, 10-11); settlement ` +
      `must fail here rather than invent or guess a stock endpoint.`,
  );
}

function withActorInventory(
  world: WorldState,
  actor: ActorRef,
  bucket: InventoryBucket,
  inventory: Inventory,
): WorldState {
  if (actor.type === "STATE" && bucket === "GENERAL") {
    const state = world.states.get(actor.stateId)!;
    const states = new Map(world.states);
    states.set(actor.stateId, { ...state, publicInventory: inventory });
    return { ...world, states };
  }

  if (actor.type === "PRODUCTION_UNIT") {
    const productionUnit = world.productionUnits.get(actor.productionUnitId)!;
    const productionUnits = new Map(world.productionUnits);
    if (bucket === "INPUT") {
      productionUnits.set(actor.productionUnitId, { ...productionUnit, inputInventory: inventory });
      return { ...world, productionUnits };
    }
    if (bucket === "OUTPUT") {
      productionUnits.set(actor.productionUnitId, { ...productionUnit, outputInventory: inventory });
      return { ...world, productionUnits };
    }
    if (bucket === "INVESTMENT") {
      productionUnits.set(actor.productionUnitId, { ...productionUnit, investmentInventory: inventory });
      return { ...world, productionUnits };
    }
  }

  throw new Error(
    `executeAllocation: no canonical "${bucket}" inventory endpoint for ${actorLabel(actor)}`,
  );
}

function creditWallet(
  world: WorldState,
  actor: ActorRef,
  currencyId: CurrencyId,
  delta: number,
  moneyEpsilon: number,
): WorldState {
  const wallet = getActorWallet(world, actor);
  const balance = wallet.get(currencyId) ?? 0;
  let next = balance + delta;
  if (Math.abs(next) < moneyEpsilon) {
    next = 0;
  }
  if (next < 0) {
    throw new Error(
      `executeAllocation: settlement would leave ${actorLabel(actor)} with a negative balance ` +
        `(${next}) in currency ${currencyId}`,
    );
  }
  const nextWallet = new Map(wallet);
  nextWallet.set(currencyId, next);
  return withActorWallet(world, actor, nextWallet);
}

function creditInventory(
  world: WorldState,
  actor: ActorRef,
  bucket: InventoryBucket,
  goodId: GoodId,
  delta: number,
  quantityEpsilon: number,
): WorldState {
  const inventory = getActorInventory(world, actor, bucket);
  const balance = inventory.get(goodId) ?? 0;
  let next = balance + delta;
  if (Math.abs(next) < quantityEpsilon) {
    next = 0;
  }
  if (next < 0) {
    throw new Error(
      `executeAllocation: settlement would leave ${actorLabel(actor)} with negative ${bucket} ` +
        `inventory (${next}) of good ${goodId}`,
    );
  }
  const nextInventory = new Map(inventory);
  nextInventory.set(goodId, next);
  return withActorInventory(world, actor, bucket, nextInventory);
}

/**
 * Apply one realized `MarketAllocation`'s atomic settlement bundle (Handoff/04
 * section 10) against live `WorldState` actor stock, and return the resulting
 * `WorldState`. Precondition: `allocation` must pass `preflightMarketSettlement`;
 * this function re-runs that check and throws rather than applying a partial
 * mutation if it fails.
 *
 * Mutation order matches section 10 exactly:
 * 1) seller inventory[goodId] -= quantity
 * 2) buyer inventory[goodId] += quantity
 * 3) buyer wallet[marketCurrency] -= quantity * buyerGrossUnitPrice
 * 4) seller wallet[marketCurrency] += quantity * sellerNetUnitPrice
 * 5) destination State treasury += collected consumption tax, if any
 *
 * A zero-quantity allocation is a no-op and returns `world` unchanged.
 */
export function executeAllocation(
  world: WorldState,
  ctx: TickContext,
  allocation: MarketAllocation,
): WorldState {
  const preflightError = preflightMarketSettlement(allocation, ctx.tick, ctx.phase);
  if (preflightError) {
    throw new Error(`executeAllocation: preflight failed: ${preflightError}`);
  }

  if (allocation.quantity === 0) {
    return world;
  }

  const quantityEpsilon = world.simulationConfig.numeric.quantityEpsilon ?? 1e-9;
  const moneyEpsilon = world.simulationConfig.numeric.moneyEpsilon ?? 1e-9;

  let next = world;

  next = creditInventory(
    next,
    allocation.seller,
    allocation.sellerInventoryBucket,
    allocation.goodId,
    -allocation.quantity,
    quantityEpsilon,
  );

  next = creditInventory(
    next,
    allocation.buyer,
    allocation.buyerInventoryBucket,
    allocation.goodId,
    allocation.quantity,
    quantityEpsilon,
  );

  const grossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;
  next = creditWallet(next, allocation.buyer, allocation.marketCurrencyId, -grossDebit, moneyEpsilon);

  const netReceipt = allocation.quantity * allocation.sellerNetUnitPrice;
  next = creditWallet(next, allocation.seller, allocation.marketCurrencyId, netReceipt, moneyEpsilon);

  if (allocation.consumptionTaxAmount > 0 && allocation.destinationStateId) {
    const stateActor: ActorRef = { type: "STATE", stateId: allocation.destinationStateId };
    next = creditWallet(
      next,
      stateActor,
      allocation.marketCurrencyId,
      allocation.consumptionTaxAmount,
      moneyEpsilon,
    );
  }

  return next;
}
