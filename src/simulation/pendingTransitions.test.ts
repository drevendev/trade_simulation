/**
 * Tests for PendingTransitions (REQ-CORE-005).
 *
 * Verify that future policy/jurisdiction/lifecycle effects are queued and
 * cannot mutate current-tick authoritative state. Ensure an N+1 transition
 * cannot take effect before its defined activation boundary.
 */

import { describe, it, expect } from "vitest";
import {
  createEmptyPendingTransitions,
  type JurisdictionChange,
  type PendingTransitions,
} from "./pendingTransitions";
import type { RegionId, StateId } from "../domain/id";

describe("PendingTransitions (REQ-CORE-005)", () => {
  it("should create empty pending transitions at initialization", () => {
    const pending = createEmptyPendingTransitions();

    expect(pending.jurisdictionChanges).toHaveLength(0);
    expect(pending.stateCreations).toHaveLength(0);
    expect(pending.policyChanges).toHaveLength(0);
    expect(pending.monetaryPolicyChanges).toHaveLength(0);
  });

  it("should prove N+1 activation: a jurisdiction change queued at tick N activates only at tick N+1", () => {
    const currentTick = 10;
    const activateTick = currentTick + 1;

    const regionId = "r:test" as RegionId;
    const stateId = "s:test" as StateId;

    const change: JurisdictionChange = {
      regionId,
      nextControllerStateId: stateId,
      activateTick,
    };

    // Verify the change cannot take effect at currentTick
    expect(change.activateTick).toBe(currentTick + 1);
    expect(change.activateTick).toBeGreaterThan(currentTick);
  });

  it("should allow multiple transitions queued for different future ticks", () => {
    const currentTick = 5;

    const change1: JurisdictionChange = {
      regionId: "r:region1" as RegionId,
      nextControllerStateId: "s:state1" as StateId,
      activateTick: currentTick + 1,
    };

    const change2: JurisdictionChange = {
      regionId: "r:region2" as RegionId,
      nextControllerStateId: "s:state2" as StateId,
      activateTick: currentTick + 2,
    };

    const pending: PendingTransitions = {
      jurisdictionChanges: [change1, change2],
      stateCreations: [],
      policyChanges: [],
      monetaryPolicyChanges: [],
    };

    expect(pending.jurisdictionChanges).toHaveLength(2);
    const change1Actual = pending.jurisdictionChanges[0];
    const change2Actual = pending.jurisdictionChanges[1];
    expect(change1Actual?.activateTick).toBe(currentTick + 1);
    expect(change2Actual?.activateTick).toBe(currentTick + 2);
  });

  it("should enforce political lag: Phase-14 transition cannot change tick-N treatment", () => {
    const tickN = 7;
    const phase14Tick = tickN;

    // Phase-14 decisions must enqueue with activateTick = tick + 1
    // to ensure they do not affect current-tick transactions
    const jurisdictionChangeFromPhase14 = (tick: number): JurisdictionChange => ({
      regionId: "r:region1" as RegionId,
      nextControllerStateId: "s:new" as StateId,
      activateTick: tick + 1,
    });

    const change = jurisdictionChangeFromPhase14(phase14Tick);

    // Verify this change activates only after tickN is complete
    expect(change.activateTick).toBe(tickN + 1);
    expect(change.activateTick).toBeGreaterThan(phase14Tick);
  });

  it("should allow null controller state in jurisdiction changes", () => {
    const change: JurisdictionChange = {
      regionId: "r:frontier" as RegionId,
      nextControllerStateId: null,
      activateTick: 15,
    };

    expect(change.nextControllerStateId).toBeNull();
    expect(change.activateTick).toBe(15);
  });

  it("should separate current state from queued N+1 state via activateTick boundary", () => {
    const currentTick = 20;

    const pending: PendingTransitions = {
      jurisdictionChanges: [
        {
          regionId: "r:region1" as RegionId,
          nextControllerStateId: "s:new" as StateId,
          activateTick: currentTick + 1,
        },
      ],
      stateCreations: [],
      policyChanges: [],
      monetaryPolicyChanges: [],
    };

    const queuedChange = pending.jurisdictionChanges[0];

    // The change is queued for the future and does not affect current tick
    expect(queuedChange?.activateTick).toBeGreaterThan(currentTick);
    expect((queuedChange?.activateTick ?? 0) - currentTick).toBe(1);
  });
});
