/**
 * M5 / #673: freeze explicit destination-State import tariffs in Phase 1.
 *
 * This is a capture boundary for a separately owned legal-policy provider,
 * NOT a source of invented tariff defaults or M6 fiscal policy. A missing
 * decision stays absent and fails closed if Phase 7 later attempts to use
 * that State/good pair. Zero is an explicit legal rate, never an omission.
 *
 * Current-tick activated jurisdiction, not future transitions or a Phase-7
 * caller's estimated tariff, determines which destinations have a border.
 */
import type { GoodId, StateId } from "../domain/id";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import {
  phase7ImportTariffKey, type Phase7FrozenImportTariffSnapshot,
} from "./phase7LiveWorldPlan";

export interface Phase7Phase1TariffLawQuery {
  readonly tick: number;
  readonly destinationStateId: StateId;
  readonly goodId: GoodId;
}

/** Undefined means unavailable law evidence, never a zero-rate exemption. */
export type Phase7Phase1TariffLawProvider = (
  query: Readonly<Phase7Phase1TariffLawQuery>,
) => number | undefined;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Capture every destination-State/tradable-good pair with a configured inbound
 * cross-border link. A destination/good rate is jurisdiction-wide, so multiple
 * source links must not call the provider twice or produce conflicting rates.
 *
 * The output is a read-only planning snapshot, not a WorldState or treasury
 * mutation. Phase 7 separately verifies its tick and refuses missing rates.
 */
export function capturePhase7ImportTariffsAtPhase1(
  world: Pick<WorldState, "regions" | "states" | "transportLinks" | "definitionRegistry">,
  context: Pick<TickContext, "tick" | "phase" | "effectiveJurisdictionByRegion">,
  decide: Phase7Phase1TariffLawProvider,
): Phase7FrozenImportTariffSnapshot {
  const active = context.effectiveJurisdictionByRegion;
  if (!Number.isSafeInteger(context.tick) || context.tick < 0 ||
      context.phase !== 1 || !(active instanceof Map) ||
      typeof decide !== "function") {
    throw new Error("Phase-1 tariff capture requires current Phase-1 law authority");
  }
  if (active.size !== world.regions.size ||
      [...world.regions].some(([regionId, region]) =>
        !active.has(regionId) || active.get(regionId) !== region.controllerStateId ||
        (region.controllerStateId !== null &&
         !world.states.has(region.controllerStateId)))) {
    throw new Error("Phase-1 tariff capture has incomplete/stale jurisdiction");
  }

  const destinations = new Set<StateId>();
  for (const [linkId, link] of [...world.transportLinks].sort(([a], [b]) => cmp(a, b))) {
    const origin = world.regions.get(link.fromRegionId);
    const destination = world.regions.get(link.toRegionId);
    if (link.linkId !== linkId || !origin || !destination) {
      throw new Error("Phase-1 tariff capture references an invalid directed link");
    }
    const destinationState = destination.controllerStateId;
    if (destinationState !== null &&
        destinationState !== origin.controllerStateId) {
      destinations.add(destinationState);
    }
  }

  const goods = Object.entries(world.definitionRegistry.goods)
    .filter(([, definition]) => definition.tradable)
    .map(([key]) => key as GoodId)
    .sort(cmp);
  const ratesByDestinationStateGood = new Map<string, number>();
  for (const destinationStateId of [...destinations].sort(cmp)) {
    for (const goodId of goods) {
      const rate = decide(Object.freeze({
        tick: context.tick, destinationStateId, goodId,
      }));
      if (rate === undefined) continue;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
        throw new Error("Phase-1 tariff capture requires a finite nonnegative statutory rate");
      }
      ratesByDestinationStateGood.set(phase7ImportTariffKey(destinationStateId, goodId), rate);
    }
  }
  return { tick: context.tick, ratesByDestinationStateGood };
}
