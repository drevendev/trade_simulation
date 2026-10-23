/**
 * Read-only M4 WorldState bridge for #798 / HANDOFF-REPAIR-M4-009.
 *
 * This projects EXISTING binary64 balances into exact dyads solely for
 * previewing a staged posting. It does not establish exact v2 stock authority:
 * no EconomicTransaction is appended, no stock is written, no ID is reserved
 * and it must NEVER be used to claim lifetime conservation of Number storage.
 * A later #797-approved atomic bridge must replace this projection boundary.
 */
import type { WorldState } from "./worldState";
import { readActorWallet, readMarketActorInventory } from "./marketSettlementTransition";
import { exactFromNumber } from "../domain/exactStockAmount";
import {
  stageExactPostingBundle,
  type ExactPostingEndpoint,
  type ExactPostingLeg,
  type StagedExactEndpoint,
} from "./exactPostingBundle";

/**
 * Look up the ONE canonical live M4 wallet/inventory for a staged endpoint.
 *
 * Reuses settlement's owner/bucket resolution instead of introducing a second
 * interpretation of WorldState. A valid empty holding is zero; an unknown
 * currency, good, actor or forbidden bucket is NOT a valid empty holding.
 * stageExactPostingBundle validates endpoint identity before invoking this.
 */
function readLegacyOpening(world: WorldState, endpoint: ExactPostingEndpoint) {
  if (endpoint.kind === "MONEY") {
    if (!world.currencies.has(endpoint.currencyId)) {
      throw new Error(`exact posting: unknown live currency ${endpoint.currencyId}`);
    }
    return exactFromNumber(readActorWallet(world, endpoint.owner).get(endpoint.currencyId) ?? 0);
  }

  if (!Object.prototype.hasOwnProperty.call(world.definitionRegistry.goods, endpoint.goodId)) {
    throw new Error(`exact posting: unknown live good ${endpoint.goodId}`);
  }
  return exactFromNumber(
    readMarketActorInventory(world, endpoint.owner, endpoint.bucket).get(endpoint.goodId) ?? 0,
  );
}

export function stageLegacyWorldPostingPreview(
  world: WorldState,
  legs: readonly ExactPostingLeg[],
): readonly StagedExactEndpoint[] {
  return stageExactPostingBundle(legs, (endpoint) => readLegacyOpening(world, endpoint));
}
