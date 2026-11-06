/**
 * M5 / #673: capture consumption-tax rate and collection-efficiency facts
 * once in Phase 1, before Phase-7 cross-region trade is matched and paid.
 *
 * The injected M3 TaxPolicyProvider is an explicit authority, not a fallback
 * or an M6 policy generator. Missing rates/efficiencies fail closed; zero must
 * be an explicit provider answer. No economic stock is mutated here.
 */
import type { GoodId, StateId } from "../domain/id";
import type { TaxPolicyProvider } from "./marketSettlement";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import {
  phase7ConsumptionTaxKey,
  type Phase7FrozenConsumptionTaxSnapshot,
} from "./phase7LiveWorldPlan";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Capture one tax rate per destination State/tradable-good and one collection
 * efficiency per State. Multiple incoming links must not cause repeat policy
 * reads, and object/Map insertion order must not influence the snapshot.
 *
 * A destination with no controlling State does not create a tax liability.
 * A destination State with an incoming configured link must supply explicit
 * policy even if later market matching produces no shipment.
 */
export function capturePhase7ConsumptionTaxesAtPhase1(
  world: Pick<
    WorldState, "regions" | "states" | "transportLinks" | "definitionRegistry"
  >,
  context: Pick<TickContext, "tick" | "phase" | "effectiveJurisdictionByRegion">,
  provider: TaxPolicyProvider,
): Phase7FrozenConsumptionTaxSnapshot {
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 ||
      context.phase !== 1 ||
      !(context.effectiveJurisdictionByRegion instanceof Map) ||
      !provider || typeof provider.getConsumptionTaxRate !== "function" ||
      typeof provider.getCollectionEfficiency !== "function") {
    throw new Error("Phase-1 consumption-tax capture requires explicit current-tick policy");
  }
  const active = context.effectiveJurisdictionByRegion;
  if (active.size !== world.regions.size ||
      [...world.regions].some(([regionId, region]) =>
        !active.has(regionId) || active.get(regionId) !== region.controllerStateId ||
        (region.controllerStateId !== null &&
         !world.states.has(region.controllerStateId)))) {
    throw new Error("Phase-1 consumption-tax capture has incomplete/stale jurisdiction");
  }

  const destinationStates = new Set<StateId>();
  for (const [linkId, link] of [...world.transportLinks].sort(([a], [b]) => cmp(a, b))) {
    const origin = world.regions.get(link.fromRegionId);
    const destination = world.regions.get(link.toRegionId);
    if (link.linkId !== linkId || !origin || !destination) {
      throw new Error("Phase-1 consumption-tax capture references an invalid directed link");
    }
    if (destination.controllerStateId !== null) {
      destinationStates.add(destination.controllerStateId);
    }
  }
  const tradableGoods = Object.entries(world.definitionRegistry.goods)
    .filter(([, definition]) => definition.tradable)
    .map(([id]) => id as GoodId)
    .sort(cmp);

  const ratesByDestinationStateGood = new Map<string, number>();
  const collectionEfficiencyByState = new Map<StateId, number>();
  for (const stateId of [...destinationStates].sort(cmp)) {
    const efficiency = provider.getCollectionEfficiency(stateId);
    if (typeof efficiency !== "number" ||
        !Number.isFinite(efficiency) || efficiency < 0 || efficiency > 1) {
      throw new Error("Phase-1 consumption-tax capture needs explicit finite collection efficiency in [0, 1]");
    }
    collectionEfficiencyByState.set(stateId, efficiency);
    for (const goodId of tradableGoods) {
      const rate = provider.getConsumptionTaxRate(stateId, goodId);
      if (typeof rate !== "number" ||
          !Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new Error("Phase-1 consumption-tax capture needs explicit finite statutory rate in [0, 1]");
      }
      ratesByDestinationStateGood.set(phase7ConsumptionTaxKey(stateId, goodId), rate);
    }
  }
  return { tick: context.tick, ratesByDestinationStateGood, collectionEfficiencyByState };
}
