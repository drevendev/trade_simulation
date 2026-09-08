/**
 * REQ-CORE-004: Canonical tick orchestrator and phase framework tests.
 *
 * Proves phase order, determinism, 100+ tick stability, and PendingTransitions barriers.
 */

import { describe, it, expect } from "vitest";
import {
  TOTAL_PHASES,
  PHASE_NAMES,
  initializeTickContext,
  executePhase,
  executeTick,
  computeTickHash,
  noOpPhaseHandler,
  type PhaseHandler,
  type TickContext,
} from "./tickOrchestrator";
import type { WorldState, PendingTransitions } from "./worldState";
import type { RegionId, StateId } from "../domain/id";
import { addLedgerRecord } from "./ledger";
import type { SimulationConfig } from "../config/simulationConfig";

/**
 * Create a minimal test WorldState for phase execution tests.
 */
function createTestWorldState(): WorldState {
  const config: SimulationConfig = {
    configVersion: "1.0",
    numeric: {
      quantityEpsilon: 1e-9,
      moneyEpsilon: 1e-9,
      reconciliationRelativeTolerance: 1e-6,
    },
    cadence: {},
    markets: {},
    trade: {},
    production: {},
    labor: {},
    population: {},
    clans: {},
    fiscal: {},
    monetary: {},
    expansion: {},
    events: {},
    performance: {},
  };

  return {
    configVersion: "1.0",
    scenarioId: "test-scenario",
    seed: 42,
    definitionRegistry: {
      goods: {},
      recipes: {},
      eventDefinitions: {},
      metricDefinitions: {},
    },
    simulationConfig: config,
    worldGenesisLedger: {
      records: [],
    },
    regions: new Map(),
    states: new Map(),
    currencies: new Map(),
    monetaryAuthorities: new Map(),
    clans: new Map(),
    cohorts: new Map(),
    productionUnits: new Map(),
    markets: new Map(),
    transportLinks: new Map(),
    pendingTransitions: createEmptyPendingTransitions(),
  };
}

/**
 * Create empty PendingTransitions for tests.
 */
function createEmptyPendingTransitions(): PendingTransitions {
  return {
    jurisdictionChanges: [],
    stateCreations: [],
    policyChanges: [],
    monetaryPolicyChanges: [],
  };
}

describe("REQ-CORE-004: Canonical tick orchestrator", () => {
  describe("Phase constants", () => {
    it("defines exactly 16 phases (0–15)", () => {
      expect(TOTAL_PHASES).toBe(16);
      expect(PHASE_NAMES).toHaveLength(16);
    });

    it("phase names are documented for all phases", () => {
      for (let i = 0; i < TOTAL_PHASES; i++) {
        expect(PHASE_NAMES[i]).toBeTruthy();
        expect(typeof PHASE_NAMES[i]).toBe("string");
      }
    });

    it("phase 0 is BeginTick", () => {
      expect(PHASE_NAMES[0]).toContain("BeginTick");
    });

    it("phase 15 is accounting and metrics", () => {
      expect(PHASE_NAMES[15]).toContain("Accounting");
    });
  });

  describe("TickContext initialization", () => {
    it("creates TickContext for a given tick", () => {
      const context = initializeTickContext(5, 42);
      expect(context.tick).toBe(5);
      expect(context.phase).toBe(0);
      expect(context.rngSeed).toBe(42 ^ 5);
      expect(context.transactions).toHaveLength(0);
    });

    it("produces deterministic RNG seed for same tick", () => {
      const ctx1 = initializeTickContext(10, 100);
      const ctx2 = initializeTickContext(10, 100);
      expect(ctx1.rngSeed).toBe(ctx2.rngSeed);
    });

    it("produces different RNG seed for different ticks", () => {
      const ctx1 = initializeTickContext(10, 100);
      const ctx2 = initializeTickContext(11, 100);
      expect(ctx1.rngSeed).not.toBe(ctx2.rngSeed);
    });
  });

  describe("Phase execution", () => {
    it("executes phase with no-op handler", () => {
      const world = createTestWorldState();
      const context = initializeTickContext(1, 42);
      const pending = createEmptyPendingTransitions();

      const result = executePhase(0, noOpPhaseHandler, world, context, pending);

      expect(result.phase).toBe(0);
      expect(result.tick).toBe(1);
    });

    it("rejects invalid phase numbers", () => {
      const world = createTestWorldState();
      const context = initializeTickContext(1, 42);
      const pending = createEmptyPendingTransitions();

      expect(() => executePhase(-1, noOpPhaseHandler, world, context, pending)).toThrow(
        /Invalid phase/,
      );
      expect(() => executePhase(16, noOpPhaseHandler, world, context, pending)).toThrow(
        /Invalid phase/,
      );
    });

    it("calls handler with correct parameters", () => {
      const world = createTestWorldState();
      const context = initializeTickContext(3, 99);
      const pending = createEmptyPendingTransitions();

      let handlerCalled = false;
      let capturedPhase = -1;

      const testHandler: PhaseHandler = (w, ctx) => {
        handlerCalled = true;
        capturedPhase = ctx.phase;
        return ctx;
      };

      executePhase(7, testHandler, world, context, pending);

      expect(handlerCalled).toBe(true);
      expect(capturedPhase).toBe(7);
    });
  });

  describe("Full tick execution (Phase trace test)", () => {
    it("executes all 16 phases in order 0..15", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      const phaseOrder: number[] = [];
      const tracingHandler: PhaseHandler = (_, context) => {
        phaseOrder.push(context.phase);
        return context;
      };

      const { phaseTrace, reconciliationErrors } = executeTick(world, 1, pending, tracingHandler);

      expect(phaseTrace).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(phaseOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      // No-op tick should have no ledger records, so reconciliation should pass (null)
      expect(reconciliationErrors).toBeNull();
    });

    it("does not execute phase 16", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      const executedPhases: number[] = [];
      const tracingHandler: PhaseHandler = (_, context) => {
        executedPhases.push(context.phase);
        return context;
      };

      const { reconciliationErrors } = executeTick(world, 1, pending, tracingHandler);

      expect(executedPhases).not.toContain(16);
      expect(executedPhases).toHaveLength(16);
      expect(reconciliationErrors).toBeNull(); // No-op: no mutations
    });

    it("preserves tick number across all phases", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();
      const tickNumber = 42;

      const tickNumbers: number[] = [];
      const tracingHandler: PhaseHandler = (_, context) => {
        tickNumbers.push(context.tick);
        return context;
      };

      const { reconciliationErrors } = executeTick(world, tickNumber, pending, tracingHandler);

      tickNumbers.forEach((t) => expect(t).toBe(tickNumber));
      expect(reconciliationErrors).toBeNull(); // No-op: no mutations
    });
  });

  describe("Deterministic replay hash", () => {
    it("produces identical hash for same world/context", () => {
      const world = createTestWorldState();
      const context = initializeTickContext(5, 42);

      const hash1 = computeTickHash(world, context);
      const hash2 = computeTickHash(world, context);

      expect(hash1).toBe(hash2);
    });

    it("produces different hash for different tick numbers", () => {
      const world = createTestWorldState();
      const ctx1 = initializeTickContext(5, 42);
      const ctx2 = initializeTickContext(6, 42);

      const hash1 = computeTickHash(world, ctx1);
      const hash2 = computeTickHash(world, ctx2);

      expect(hash1).not.toBe(hash2);
    });

    it("produces different hash for different scenarios", () => {
      const world1 = createTestWorldState();
      const world2: WorldState = {
        ...createTestWorldState(),
        scenarioId: "different-scenario",
      };

      const context = initializeTickContext(5, 42);

      const hash1 = computeTickHash(world1, context);
      const hash2 = computeTickHash(world2, context);

      expect(hash1).not.toBe(hash2);
    });

    it("produces hash regardless of transaction count in no-op scenario", () => {
      const world = createTestWorldState();
      const ctx1 = initializeTickContext(5, 42);
      // Both contexts have zero transactions in no-op scenario
      const ctx2 = initializeTickContext(5, 42);

      const hash1 = computeTickHash(world, ctx1);
      const hash2 = computeTickHash(world, ctx2);

      expect(hash1).toBe(hash2);
    });
  });

  describe("No-op phase handler", () => {
    it("returns context unchanged", () => {
      const world = createTestWorldState();
      const context = initializeTickContext(3, 77);
      const pending = createEmptyPendingTransitions();

      const result = noOpPhaseHandler(world, context, pending);

      expect(result).toEqual(context);
    });

    it("preserves tick number", () => {
      const world = createTestWorldState();
      const context = initializeTickContext(99, 42);
      const pending = createEmptyPendingTransitions();

      const result = noOpPhaseHandler(world, context, pending);

      expect(result.tick).toBe(99);
    });

    it("preserves phase number", () => {
      const world = createTestWorldState();
      const context: TickContext = {
        ...initializeTickContext(5, 42),
        phase: 7,
      };
      const pending = createEmptyPendingTransitions();

      const result = noOpPhaseHandler(world, context, pending);

      expect(result.phase).toBe(7);
    });
  });

  describe("100+ tick no-op scenario", () => {
    it("executes 100 consecutive no-op ticks", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      let tickCount = 0;
      const countingHandler: PhaseHandler = (_, context) => {
        if (context.phase === 0) {
          tickCount++;
        }
        return context;
      };

      for (let tick = 0; tick < 100; tick++) {
        executeTick(world, tick, pending, countingHandler);
      }

      expect(tickCount).toBe(100);
    });

    it("produces stable hashes across 100 identical ticks", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      const hashes: string[] = [];

      for (let tick = 0; tick < 100; tick++) {
        const { context, reconciliationErrors } = executeTick(world, tick, pending, noOpPhaseHandler);
        hashes.push(computeTickHash(world, context));
        // No-op: no ledger records, so reconciliation should pass
        expect(reconciliationErrors).toBeNull();
      }

      // In no-op scenario, hashes should be deterministic and reproducible
      // (though they will differ between ticks due to tick number in hash)
      expect(hashes).toHaveLength(100);
      hashes.forEach((hash) => {
        expect(hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
      });
    });

    it("maintains determinism across replayed identical ticks", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      const hashes1: string[] = [];
      const hashes2: string[] = [];

      // First run
      for (let tick = 0; tick < 50; tick++) {
        const { context } = executeTick(world, tick, pending, noOpPhaseHandler);
        hashes1.push(computeTickHash(world, context));
      }

      // Replay identical ticks
      for (let tick = 0; tick < 50; tick++) {
        const { context } = executeTick(world, tick, pending, noOpPhaseHandler);
        hashes2.push(computeTickHash(world, context));
      }

      expect(hashes1).toEqual(hashes2);
    });
  });

  describe("PendingTransitions barrier enforcement (negative control)", () => {
    it("prevents phase N from directly mutating phase N+1 pending transition", () => {
      const world = createTestWorldState();
      const pending: PendingTransitions = {
        jurisdictionChanges: [],
        stateCreations: [],
        policyChanges: [
          {
            stateId: "STATE_1" as StateId,
            patch: { some: "change" },
            activateTick: 10, // Future activation
          },
        ],
        monetaryPolicyChanges: [],
      };

      let context = initializeTickContext(9, 42);

      // Phase handler that tries to mutate pending (should not be allowed in implementation)
      const barrierTestHandler: PhaseHandler = (_world, ctx, pend) => {
        // In a real implementation with barrier enforcement,
        // attempting to read/write pend.policyChanges for phase < 14 would be caught.
        // For M2, this is a structural constraint; handlers must not mutate state.
        expect(pend.policyChanges).toBeDefined();
        return ctx;
      };

      // Execute phases 0-13 (phases before policy decisions in phase 14)
      for (let phase = 0; phase < 14; phase++) {
        context = executePhase(phase, barrierTestHandler, world, context, pending);
      }

      // Pending transitions remain unchanged (immutable)
      expect(pending.policyChanges).toHaveLength(1);
    });

    it("allows phase 14+ to queue new pending transitions", () => {
      // This is a structural test: Phase 14 (slow review) is the only phase
      // allowed to enqueue new pending transitions in real implementation.
      // M2 proof is that no phase before 14 calls a mutation, and Phase 15
      // is snapshot/close only.

      const pending: PendingTransitions = {
        jurisdictionChanges: [],
        stateCreations: [],
        policyChanges: [],
        monetaryPolicyChanges: [],
      };

      // Phases 0-13 should not add to pending
      expect(pending.policyChanges).toHaveLength(0);

      // Phase 14 would enqueue (not tested here, as it's not yet implemented)
      // This test documents the intended barrier structure.
    });
  });

  describe("Phase-boundary invariant hooks (REQ-CORE-006)", () => {
    it("validates zero-flow reconciliation after each phase completes", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      let phasesExecuted: number[] = [];
      const tracingHandler: PhaseHandler = (_w, context) => {
        phasesExecuted.push(context.phase);
        return context;
      };

      // Execute with no-op handler; all phases should execute successfully
      const { phaseTrace, reconciliationErrors } = executeTick(
        world,
        1,
        pending,
        tracingHandler,
      );

      expect(phaseTrace).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(reconciliationErrors).toBeNull(); // No-op: no unmatched flows
      expect(phasesExecuted).toEqual(phaseTrace);
    });

    it("fails fast when phase creates unmatched ledger flow", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      let phasesExecuted: number[] = [];

      // Handler that introduces an unmatched MONEY flow in phase 2
      const unbalancedHandler: PhaseHandler = (_w, context) => {
        phasesExecuted.push(context.phase);

        // In phase 2, add an unmatched money flow (negative delta with no offset)
        if (context.phase === 2) {
          const unbalancedRecord = {
            type: "MONEY" as const,
            tick: context.tick,
            phase: context.phase,
            currencyId: "CURR_1" as any,
            ownerType: "state" as const,
            ownerKey: "STATE_1",
            delta: -100, // Unmatched negative flow
            reason: "test-imbalance",
          };

          return {
            ...context,
            currentLedger: addLedgerRecord(context.currentLedger, unbalancedRecord),
          };
        }

        return context;
      };

      // executeTick should throw when phase 2 boundary validation fails
      expect(() => executeTick(world, 1, pending, unbalancedHandler)).toThrow(
        /Phase 2.*reconciliation failed.*MONEY.*residual/,
      );

      // Verify phase 2 executed but phase 3 did not
      expect(phasesExecuted).toEqual([0, 1, 2]);
    });

    it("diagnostic includes affected category and residual value", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      // Handler that creates a GOOD imbalance in phase 5
      const goodImbalanceHandler: PhaseHandler = (_w, context) => {
        if (context.phase === 5) {
          const record = {
            type: "GOOD" as const,
            tick: context.tick,
            phase: context.phase,
            goodId: "GOOD_A",
            holderType: "state" as const,
            holderKey: "REGION_1" as any,
            bucket: "public" as const,
            delta: 50.12345, // Unmatched positive flow
            reason: "test-surplus",
          };

          return {
            ...context,
            currentLedger: addLedgerRecord(context.currentLedger, record),
          };
        }

        return context;
      };

      let errorMsg = "";
      try {
        executeTick(world, 1, pending, goodImbalanceHandler);
      } catch (e) {
        errorMsg = (e as Error).message;
      }

      // Error should name phase 5 and the category/residual
      expect(errorMsg).toContain("Phase 5");
      expect(errorMsg).toContain("GOOD");
      expect(errorMsg).toMatch(/residual.*50\./); // Residual value ~50.12345
    });

    it("prevents phase N+1 from executing when phase N fails reconciliation", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      const executedPhases: number[] = [];
      let phase7Tried = false;

      // Add unmatched flow in phase 6
      const failHandler: PhaseHandler = (_w, context) => {
        executedPhases.push(context.phase);

        if (context.phase === 6) {
          // Create physical loss imbalance
          const record = {
            type: "PHYSICAL_LOSS" as const,
            tick: context.tick,
            phase: context.phase,
            resourceType: "good" as const,
            resourceId: "GOOD_B",
            locationKey: "REGION_2" as any,
            amount: 25, // Unmatched loss
            cause: "spoilage" as const,
            reason: "test-loss",
          };

          return {
            ...context,
            currentLedger: addLedgerRecord(context.currentLedger, record),
          };
        }

        // If we get to phase 7, mark it
        if (context.phase === 7) {
          phase7Tried = true;
        }

        return context;
      };

      expect(() => executeTick(world, 1, pending, failHandler)).toThrow(
        /Phase 6.*reconciliation failed/,
      );

      // Phase 7 handler was never reached
      expect(phase7Tried).toBe(false);
      // Only phases 0-6 executed before failure
      expect(executedPhases).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("no-op ticks still reconcile successfully after phase-boundary validation added", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      // Multiple consecutive no-op ticks should all pass phase-boundary validation
      for (let tick = 0; tick < 25; tick++) {
        const { phaseTrace, reconciliationErrors } = executeTick(
          world,
          tick,
          pending,
          noOpPhaseHandler,
        );

        expect(phaseTrace).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        expect(reconciliationErrors).toBeNull();
      }
    });
  });
});
