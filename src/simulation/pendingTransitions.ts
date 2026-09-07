/**
 * PendingTransitions: Future policy/jurisdiction/lifecycle effects that cannot
 * mutate current-tick authoritative state (REQ-CORE-005).
 *
 * Phase-14 political decisions enqueue changes with activateTick = tick + 1.
 * Changes only become effective at their designated activateTick, never retroactively.
 */

import type { RegionId, StateId, MonetaryAuthorityId } from "../domain/id";
import type { PendingTransitions } from "./worldState";

export function createEmptyPendingTransitions(): PendingTransitions {
  return {
    jurisdictionChanges: [],
    stateCreations: [],
    policyChanges: [],
    monetaryPolicyChanges: [],
  };
}

export function addJurisdictionChange(
  pending: PendingTransitions,
  regionId: RegionId,
  nextControllerStateId: StateId | null,
  activateTick: number,
): PendingTransitions {
  return {
    ...pending,
    jurisdictionChanges: [
      ...pending.jurisdictionChanges,
      { regionId, nextControllerStateId, activateTick },
    ],
  };
}

export function addStateCreation(
  pending: PendingTransitions,
  stateCreation: {
    readonly stateId: StateId;
    readonly regionKey: string;
    readonly seed: unknown;
    readonly activateTick: number;
  },
): PendingTransitions {
  return {
    ...pending,
    stateCreations: [...pending.stateCreations, stateCreation],
  };
}

export function addPolicyChange(
  pending: PendingTransitions,
  stateId: StateId,
  patch: unknown,
  activateTick: number,
): PendingTransitions {
  return {
    ...pending,
    policyChanges: [
      ...pending.policyChanges,
      { stateId, patch, activateTick },
    ],
  };
}

export function addMonetaryPolicyChange(
  pending: PendingTransitions,
  authorityId: MonetaryAuthorityId,
  patch: unknown,
  activateTick: number,
): PendingTransitions {
  return {
    ...pending,
    monetaryPolicyChanges: [
      ...pending.monetaryPolicyChanges,
      { authorityId, patch, activateTick },
    ],
  };
}

export function getActiveTransitionsAtTick(
  pending: PendingTransitions,
  currentTick: number,
): PendingTransitions {
  return {
    jurisdictionChanges: pending.jurisdictionChanges.filter(
      (c) => c.activateTick === currentTick,
    ),
    stateCreations: pending.stateCreations.filter(
      (s) => s.activateTick === currentTick,
    ),
    policyChanges: pending.policyChanges.filter(
      (p) => p.activateTick === currentTick,
    ),
    monetaryPolicyChanges: pending.monetaryPolicyChanges.filter(
      (m) => m.activateTick === currentTick,
    ),
  };
}

export function removeActivatedTransitions(
  pending: PendingTransitions,
  currentTick: number,
): PendingTransitions {
  return {
    jurisdictionChanges: pending.jurisdictionChanges.filter(
      (c) => c.activateTick !== currentTick,
    ),
    stateCreations: pending.stateCreations.filter(
      (s) => s.activateTick !== currentTick,
    ),
    policyChanges: pending.policyChanges.filter(
      (p) => p.activateTick !== currentTick,
    ),
    monetaryPolicyChanges: pending.monetaryPolicyChanges.filter(
      (m) => m.activateTick !== currentTick,
    ),
  };
}
