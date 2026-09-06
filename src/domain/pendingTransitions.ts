/**
 * PendingTransitions: queued future policy/jurisdiction/lifecycle effects (REQ-CORE-005).
 *
 * Phase-14 political decisions enqueue changes with activateTick = tick + 1.
 * Phase-1 applies pending transitions for currentTick only.
 * Invariant I13: Phase-14 transitions cannot change tax/FX/border treatment of tick-N transactions.
 * Invariant I17: Phase-15 policy decisions activate no earlier than N+1.
 */

import type { MonetaryAuthorityId, RegionId, StateId } from "./id";

/**
 * A jurisdiction change queued for future activation.
 * Phase-14 decisions never mutate effective jurisdiction for the current tick.
 * Activation occurs at Phase-1 of activateTick.
 */
export interface PendingJurisdictionChange {
  readonly regionId: RegionId;
  readonly nextControllerStateId: StateId | null;
  readonly activateTick: number;
}

/**
 * Placeholder for pending state creation (M3+).
 * A new State and its founding transfer are queued for Phase-1 activation.
 */
export interface PendingStateCreation {
  readonly stateId: StateId;
  readonly activateTick: number;
  readonly payload: unknown;
}

/**
 * A policy change queued for future activation.
 * Phase-14 decisions never mutate current-tick policy.
 * Activation occurs at Phase-1 of activateTick.
 */
export interface PendingPolicyChange {
  readonly stateId: StateId;
  readonly patch: unknown;
  readonly activateTick: number;
}

/**
 * A monetary policy change queued for future activation.
 * Phase-14 decisions never mutate current-tick monetary policy.
 * Activation occurs at Phase-1 of activateTick.
 */
export interface PendingMonetaryPolicyChange {
  readonly authorityId: MonetaryAuthorityId;
  readonly patch: unknown;
  readonly activateTick: number;
}

/**
 * Canonical pending transitions: future effects queued but not yet active.
 * All arrays are immutable. Phase-14 decisions enqueue with activateTick = tick + 1.
 * Phase-1 applies pending transitions matching the current tick only.
 */
export interface PendingTransitions {
  readonly jurisdictionChanges: readonly PendingJurisdictionChange[];
  readonly stateCreations: readonly PendingStateCreation[];
  readonly policyChanges: readonly PendingPolicyChange[];
  readonly monetaryPolicyChanges: readonly PendingMonetaryPolicyChange[];
}

/**
 * Creates an empty PendingTransitions for initial world state.
 */
export function createEmptyPendingTransitions(): PendingTransitions {
  return {
    jurisdictionChanges: [],
    stateCreations: [],
    policyChanges: [],
    monetaryPolicyChanges: [],
  };
}
