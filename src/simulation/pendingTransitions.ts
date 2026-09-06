/**
 * PendingTransitions: Future policy/jurisdiction/lifecycle effects (REQ-CORE-005).
 *
 * Future policy/jurisdiction/lifecycle effects are queued and cannot mutate
 * current-tick authoritative state. Phase-14 political decisions enqueue changes
 * with activateTick = tick + 1, ensuring political lag: Phase-14 transitions
 * cannot change the tax/FX/border treatment of tick-N transactions (Invariant I13).
 */

import type { RegionId, StateId, MonetaryAuthorityId } from "../domain/id";

export interface JurisdictionChange {
  readonly regionId: RegionId;
  readonly nextControllerStateId: StateId | null;
  readonly activateTick: number;
}

export interface PendingStateCreation {
  readonly stateId: StateId;
  readonly activateTick: number;
  readonly patch: unknown;
}

export interface PolicyChange {
  readonly stateId: StateId;
  readonly activateTick: number;
  readonly patch: unknown;
}

export interface MonetaryPolicyChange {
  readonly authorityId: MonetaryAuthorityId;
  readonly activateTick: number;
  readonly patch: unknown;
}

export interface PendingTransitions {
  readonly jurisdictionChanges: readonly JurisdictionChange[];
  readonly stateCreations: readonly PendingStateCreation[];
  readonly policyChanges: readonly PolicyChange[];
  readonly monetaryPolicyChanges: readonly MonetaryPolicyChange[];
}

export function createEmptyPendingTransitions(): PendingTransitions {
  return {
    jurisdictionChanges: [],
    stateCreations: [],
    policyChanges: [],
    monetaryPolicyChanges: [],
  };
}
