/**
 * PendingTransitions: future policy/jurisdiction/lifecycle effects
 * queued by Phase-14 decisions to activate in N+1 (REQ-CORE-005).
 *
 * These changes must not mutate current-tick authoritative state.
 * Activation occurs only at the Phase-1 boundary of the specified tick.
 */

import type {
  RegionId,
  StateId,
  MonetaryAuthorityId,
} from "../domain/id";

export interface PendingTransitions {
  readonly jurisdictionChanges: readonly PendingJurisdictionChange[];
  readonly stateCreations: readonly PendingStateCreation[];
  readonly policyChanges: readonly PendingPolicyChange[];
  readonly monetaryPolicyChanges: readonly PendingMonetaryPolicyChange[];
}

export interface PendingJurisdictionChange {
  readonly regionId: RegionId;
  readonly nextControllerStateId: StateId | null;
  readonly activateTick: number;
}

export interface PendingStateCreation {
  readonly stateId: StateId;
  readonly foundingRegionId: RegionId;
  readonly activateTick: number;
}

export interface PendingPolicyChange {
  readonly stateId: StateId;
  readonly patch: unknown;
  readonly activateTick: number;
}

export interface PendingMonetaryPolicyChange {
  readonly authorityId: MonetaryAuthorityId;
  readonly patch: unknown;
  readonly activateTick: number;
}

export function createEmptyPendingTransitions(): PendingTransitions {
  return {
    jurisdictionChanges: [],
    stateCreations: [],
    policyChanges: [],
    monetaryPolicyChanges: [],
  };
}
