/** REQ-CORE-005: tick identities must remain exact across the N -> N+1 boundary. */
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { addJurisdictionChange, assertValidJurisdictionActivateTick } from "./pendingTransitions";
import { applyJurisdictionTransitionsAtPhase1, resolveEffectiveJurisdictionAtPhase1 } from "./phase1JurisdictionTransition";
import { buildInitialWorld, type WorldState } from "./worldState";

function baselineWorld(): WorldState {
  return buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
}

function authoritySnapshot(world: WorldState) {
  return [...world.regions].map(([id, region]) => [id, region.controllerStateId]);
}

const unsafeTicks = [2 ** 53, 2 ** 54, Number.MAX_VALUE];

describe("jurisdiction safe-integer tick frontier", () => {
  it.each(unsafeTicks)("refuses an integer-valued but unsafe activation tick %s at enqueue and activation", (activateTick) => {
    const opening = baselineWorld();
    const region = [...opening.regions.values()][0]!;
    const before = authoritySnapshot(opening);
    // This is the negative control: all three values passed the previous integer-only guard.
    expect(Number.isInteger(activateTick)).toBe(true);
    expect(Number.isSafeInteger(activateTick)).toBe(false);
    expect(() => assertValidJurisdictionActivateTick(activateTick)).toThrow(/activateTick/);
    expect(() => addJurisdictionChange(opening.pendingTransitions, region.regionId, null, activateTick))
      .toThrow(/activateTick/);
    const change = { regionId: region.regionId, nextControllerStateId: null, activateTick };
    const world: WorldState = {
      ...opening, pendingTransitions: { ...opening.pendingTransitions, jurisdictionChanges: [change] },
    };
    expect(() => resolveEffectiveJurisdictionAtPhase1(world, 1)).toThrow(/Invalid Phase-1 jurisdiction change/);
    expect(() => applyJurisdictionTransitionsAtPhase1(world, 1)).toThrow(/Invalid Phase-1 jurisdiction change/);
    expect(authoritySnapshot(world)).toEqual(before);
    expect(world.pendingTransitions.jurisdictionChanges).toEqual([change]);
    expect(opening.pendingTransitions.jurisdictionChanges).toEqual([]);
  });

  it.each(unsafeTicks)("refuses unsafe current tick %s even with an empty queue", (currentTick) => {
    const world = baselineWorld();
    const before = authoritySnapshot(world);
    expect(() => resolveEffectiveJurisdictionAtPhase1(world, currentTick)).toThrow(/Phase-1 jurisdiction tick/);
    expect(() => applyJurisdictionTransitionsAtPhase1(world, currentTick)).toThrow(/Phase-1 jurisdiction tick/);
    expect(authoritySnapshot(world)).toEqual(before);
    expect(world.pendingTransitions.jurisdictionChanges).toEqual([]);
  });

  it("retains the last safe N/N+1 activation boundary without early application", () => {
    const opening = baselineWorld();
    const region = [...opening.regions.values()].find((entry) => entry.controllerStateId !== null)!;
    expect(region).toBeDefined();
    const activateTick = Number.MAX_SAFE_INTEGER;
    const pendingTransitions = addJurisdictionChange(opening.pendingTransitions, region.regionId, null, activateTick);
    const world: WorldState = { ...opening, pendingTransitions };
    const before = authoritySnapshot(world);
    expect(() => assertValidJurisdictionActivateTick(activateTick)).not.toThrow();
    expect(applyJurisdictionTransitionsAtPhase1(world, activateTick - 1)).toBe(world);
    expect(resolveEffectiveJurisdictionAtPhase1(world, activateTick - 1).get(region.regionId))
      .toBe(region.controllerStateId);
    const next = applyJurisdictionTransitionsAtPhase1(world, activateTick);
    expect(next.regions.get(region.regionId)!.controllerStateId).toBeNull();
    expect(resolveEffectiveJurisdictionAtPhase1(world, activateTick).get(region.regionId)).toBeNull();
    expect(next.pendingTransitions.jurisdictionChanges).toEqual([]);
    expect(next.pendingTransitions.policyChanges).toBe(world.pendingTransitions.policyChanges);
    expect(next.pendingTransitions.monetaryPolicyChanges).toBe(world.pendingTransitions.monetaryPolicyChanges);
    expect(next.pendingTransitions.stateCreations).toBe(world.pendingTransitions.stateCreations);
    expect(next.pendingTransitions.productionUnitLifecycleChanges).toBe(world.pendingTransitions.productionUnitLifecycleChanges);
    expect(authoritySnapshot(world)).toEqual(before);
    expect(world.pendingTransitions.jurisdictionChanges).toHaveLength(1);
  });

  it("preflights an unsafe future carrier before publishing any valid due change, in either order", () => {
    const opening = baselineWorld();
    const regions = [...opening.regions.values()];
    const due = { regionId: regions[0]!.regionId, nextControllerStateId: null, activateTick: 3 };
    const unsafe = { regionId: regions[1]!.regionId, nextControllerStateId: null, activateTick: 2 ** 53 };
    const before = authoritySnapshot(opening);
    for (const jurisdictionChanges of [[due, unsafe], [unsafe, due]]) {
      const world: WorldState = { ...opening, pendingTransitions: { ...opening.pendingTransitions, jurisdictionChanges } };
      expect(() => resolveEffectiveJurisdictionAtPhase1(world, 3)).toThrow(/Invalid Phase-1 jurisdiction change/);
      expect(() => applyJurisdictionTransitionsAtPhase1(world, 3)).toThrow(/Invalid Phase-1 jurisdiction change/);
      expect(authoritySnapshot(world)).toEqual(before);
      expect(world.pendingTransitions.jurisdictionChanges).toEqual(jurisdictionChanges);
    }
  });
});
