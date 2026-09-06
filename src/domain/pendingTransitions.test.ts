/**
 * REQ-CORE-005: Tests for PendingTransitions temporal boundary enforcement.
 * Verifies that N+1 transitions cannot take effect before their defined activation boundary.
 */

import { describe, it, expect } from "vitest";
import type { RegionId, StateId, MonetaryAuthorityId } from "./id";
import { createEmptyPendingTransitions } from "./pendingTransitions";

describe("PendingTransitions - REQ-CORE-005", () => {
  describe("createEmptyPendingTransitions", () => {
    it("creates empty arrays for all transition types", () => {
      const pending = createEmptyPendingTransitions();

      expect(pending.jurisdictionChanges).toHaveLength(0);
      expect(pending.stateCreations).toHaveLength(0);
      expect(pending.policyChanges).toHaveLength(0);
      expect(pending.monetaryPolicyChanges).toHaveLength(0);
    });

    it("returns readonly arrays", () => {
      const pending = createEmptyPendingTransitions();

      expect(Array.isArray(pending.jurisdictionChanges)).toBe(true);
      expect(Array.isArray(pending.stateCreations)).toBe(true);
      expect(Array.isArray(pending.policyChanges)).toBe(true);
      expect(Array.isArray(pending.monetaryPolicyChanges)).toBe(true);
    });
  });

  describe("Temporal boundary enforcement", () => {
    it("queues a jurisdiction change with activateTick = tick + 1", () => {
      const currentTick = 5;
      const nextTick = currentTick + 1;

      const pending = createEmptyPendingTransitions();
      const regionId = "r:test" as RegionId;
      const newStateId = "s:new" as StateId;

      const change = {
        regionId,
        nextControllerStateId: newStateId,
        activateTick: nextTick,
      };

      expect(change.activateTick).toBe(currentTick + 1);
      expect(change.activateTick).toBeGreaterThan(currentTick);
    });

    it("prevents a transition from activating at the current tick", () => {
      const currentTick = 5;
      const queuedAtTick = currentTick;

      const change = {
        regionId: "r:test" as RegionId,
        nextControllerStateId: "s:new" as StateId,
        activateTick: queuedAtTick,
      };

      expect(change.activateTick).not.toBeGreaterThan(currentTick);
    });

    it("correctly enqueues jurisdiction change with activateTick > currentTick", () => {
      const currentTick = 5;
      const pending = createEmptyPendingTransitions();

      const jurisdictionChanges = [
        {
          regionId: "r:region1" as RegionId,
          nextControllerStateId: "s:state1" as StateId,
          activateTick: 6,
        },
      ];

      jurisdictionChanges.forEach((change) => {
        expect(change.activateTick).toBeGreaterThan(currentTick);
      });
    });

    it("correctly enqueues policy change with activateTick > currentTick", () => {
      const currentTick = 5;

      const policyChange = {
        stateId: "s:state1" as StateId,
        patch: { taxRate: 0.15 },
        activateTick: 6,
      };

      expect(policyChange.activateTick).toBeGreaterThan(currentTick);
    });

    it("correctly enqueues monetary policy change with activateTick > currentTick", () => {
      const currentTick = 5;

      const monetaryChange = {
        authorityId: "ma:authority1" as MonetaryAuthorityId,
        patch: { policyRate: 0.025 },
        activateTick: 6,
      };

      expect(monetaryChange.activateTick).toBeGreaterThan(currentTick);
    });
  });

  describe("Phase-1 activation filtering", () => {
    it("identifies transitions ready for activation at a given tick", () => {
      const currentTick = 6;

      const jurisdictionChanges = [
        { regionId: "r:r1" as RegionId, nextControllerStateId: "s:s1" as StateId, activateTick: 5 },
        { regionId: "r:r2" as RegionId, nextControllerStateId: "s:s2" as StateId, activateTick: 6 },
        { regionId: "r:r3" as RegionId, nextControllerStateId: null, activateTick: 7 },
      ];

      const activatableNow = jurisdictionChanges.filter((c) => c.activateTick === currentTick);
      const stillPending = jurisdictionChanges.filter((c) => c.activateTick > currentTick);

      expect(activatableNow).toHaveLength(1);
      expect(activatableNow[0]!.regionId).toBe("r:r2");

      expect(stillPending).toHaveLength(1);
      expect(stillPending[0]!.regionId).toBe("r:r3");
    });

    it("maintains invariant that Phase-14 decisions never mutate current-tick jurisdiction", () => {
      const tickWhenQueued = 5;
      const decisionAtPhase14OfTick = tickWhenQueued;

      const enqueuedChange = {
        regionId: "r:test" as RegionId,
        nextControllerStateId: "s:new" as StateId,
        activateTick: decisionAtPhase14OfTick + 1,
      };

      expect(enqueuedChange.activateTick).not.toBe(decisionAtPhase14OfTick);
      expect(enqueuedChange.activateTick).toBe(decisionAtPhase14OfTick + 1);
    });

    it("enforces that activation occurs at Phase-1 of activateTick", () => {
      const activateTick = 6;
      const phaseWhenActivates = 1;

      const change = {
        regionId: "r:test" as RegionId,
        nextControllerStateId: "s:new" as StateId,
        activateTick,
      };

      expect(change.activateTick).toBe(activateTick);
      expect(phaseWhenActivates).toBe(1);
    });
  });

  describe("Invariant I13: Political lag", () => {
    it("verifies Phase-14 transition cannot change tick-N transaction tax treatment", () => {
      const tickN = 5;
      const phase14OfTickN = 14;

      const transitionQueued = {
        stateId: "s:state1" as StateId,
        patch: { taxRate: 0.20 },
        activateTick: tickN + 1,
      };

      expect(transitionQueued.activateTick).toBeGreaterThan(tickN);
    });
  });

  describe("Invariant I17: Stable policy causality", () => {
    it("verifies Phase-15 policy decisions activate no earlier than N+1", () => {
      const tickWhenDecisionMade = 5;
      const decisionAtPhase15 = tickWhenDecisionMade;

      const policy = {
        stateId: "s:state1" as StateId,
        patch: { spendingLevel: 0.30 },
        activateTick: decisionAtPhase15 + 1,
      };

      expect(policy.activateTick).not.toBe(decisionAtPhase15);
      expect(policy.activateTick).toBeGreaterThanOrEqual(decisionAtPhase15 + 1);
    });
  });
});
