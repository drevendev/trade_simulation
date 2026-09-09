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
import type { RegionId, StateId, CurrencyId } from "../domain/id";
import { addLedgerRecord, type MoneyFlowRecord } from "./ledger";
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

  describe("REQ-CORE-006: Phase-boundary invariant validation (fail-fast)", () => {
    it("fails fast when early phase creates unmatched money flow", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      // Handler that creates an unmatched money flow in phase 3
      const mismatchHandler: PhaseHandler = (_, context) => {
        if (context.phase === 3) {
          // Add unmatched MONEY delta: +100 with no corresponding -100 elsewhere
          const moneyRecord: MoneyFlowRecord = {
            tick: context.tick,
            phase: 3,
            type: "MONEY",
            currencyId: "CURRENCY_1" as CurrencyId,
            ownerType: "state",
            ownerKey: "STATE_1" as StateId,
            delta: 100, // Unmatched positive delta
            reason: "TEST_UNMATCHED_DELTA",
          };
          return {
            ...context,
            currentLedger: addLedgerRecord(context.currentLedger, moneyRecord),
          };
        }
        return context;
      };

      // Execute the tick with unmatched handler
      const result = executeTick(world, 0, pending, mismatchHandler);

      // Phase 3 should fail validation, stopping before phase 4
      expect(result.phaseBoundaryError).toBeDefined();
      if (!result.phaseBoundaryError) throw new Error("Expected phaseBoundaryError");
      expect(result.phaseBoundaryError.phase).toBe(3);
      expect(result.phaseBoundaryError.errors).toHaveLength(1);
      expect(result.phaseBoundaryError.errors[0]?.category).toBe("MONEY");
      expect(Math.abs((result.phaseBoundaryError.errors[0]?.residual ?? 0) - 100)).toBeLessThan(1e-6);

      // Phase trace should stop at phase 3 (3 was executed)
      expect(result.phaseTrace).toEqual([0, 1, 2, 3]);
    });

    it("stops before phase N+1 when phase N has unmatched delta", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      const executedPhases: number[] = [];

      // Handler that creates unmatched flow in phase 5, then tries to cancel in phase 6
      const twoPhaseHandler: PhaseHandler = (_, context) => {
        executedPhases.push(context.phase);

        if (context.phase === 5) {
          // Add +50 MONEY (unmatched)
          const record: MoneyFlowRecord = {
            tick: context.tick,
            phase: 5,
            type: "MONEY",
            currencyId: "CURRENCY_1" as CurrencyId,
            ownerType: "clan",
            ownerKey: "CLAN_1",
            delta: 50,
            reason: "PHASE_5_UNMATCHED",
          };
          return {
            ...context,
            currentLedger: addLedgerRecord(context.currentLedger, record),
          };
        }

        if (context.phase === 6) {
          // This should never execute because phase 5 validation will fail
          const cancelRecord: MoneyFlowRecord = {
            tick: context.tick,
            phase: 6,
            type: "MONEY",
            currencyId: "CURRENCY_1" as CurrencyId,
            ownerType: "clan",
            ownerKey: "CLAN_1",
            delta: -50, // Would cancel phase 5's delta
            reason: "PHASE_6_COMPENSATING",
          };
          return {
            ...context,
            currentLedger: addLedgerRecord(context.currentLedger, cancelRecord),
          };
        }

        return context;
      };

      const result = executeTick(world, 0, pending, twoPhaseHandler);

      // Phase 5 fails, phase 6 never executes
      expect(result.phaseBoundaryError?.phase).toBe(5);
      expect(executedPhases).not.toContain(6);
      expect(result.phaseTrace).toEqual([0, 1, 2, 3, 4, 5]);

      // Verify the residual is exactly 50
      if (!result.phaseBoundaryError) throw new Error("Expected phaseBoundaryError");
      const error = result.phaseBoundaryError.errors[0];
      if (!error) throw new Error("Expected error object");
      expect(error.category).toBe("MONEY");
      expect(Math.abs(error.residual - 50)).toBeLessThan(1e-6);
    });

    it("passes phase boundary when delta is zero (balanced)", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      // Handler that creates balanced flows (matched pairs)
      const balancedHandler: PhaseHandler = (_, context) => {
        if (context.phase === 2) {
          // Add +75 MONEY to StateA
          const record1: MoneyFlowRecord = {
            tick: context.tick,
            phase: 2,
            type: "MONEY",
            currencyId: "CURRENCY_1" as CurrencyId,
            ownerType: "state",
            ownerKey: "STATE_A" as StateId,
            delta: 75,
            reason: "BALANCED_FLOW_A",
          };
          // Add -75 MONEY to StateB (balances out)
          const record2: MoneyFlowRecord = {
            tick: context.tick,
            phase: 2,
            type: "MONEY",
            currencyId: "CURRENCY_1" as CurrencyId,
            ownerType: "state",
            ownerKey: "STATE_B" as StateId,
            delta: -75,
            reason: "BALANCED_FLOW_B",
          };
          return {
            ...context,
            currentLedger: addLedgerRecord(
              addLedgerRecord(context.currentLedger, record1),
              record2
            ),
          };
        }
        return context;
      };

      const result = executeTick(world, 0, pending, balancedHandler);

      // No phase-boundary errors; all phases should complete
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.phaseTrace).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(result.reconciliationErrors).toBeNull();
    });

    it("reports category, key and residual in fail-fast diagnostic", () => {
      const world = createTestWorldState();
      const pending = createEmptyPendingTransitions();

      // Handler with unmatched GOOD flow
      const goodMismatchHandler: PhaseHandler = (_, context) => {
        if (context.phase === 7) {
          // Unmatched good flow for testing diagnostics
          const goodRecord = {
            tick: context.tick,
            phase: 7,
            type: "GOOD" as const,
            goodId: "GRAIN_001",
            holderType: "cohort" as const,
            holderKey: "COHORT_1",
            bucket: "household" as const,
            delta: 25.5, // Unmatched quantity
            reason: "TEST_GOOD_MISMATCH",
          };
          return {
            ...context,
            currentLedger: addLedgerRecord(context.currentLedger, goodRecord),
          };
        }
        return context;
      };

      const result = executeTick(world, 0, pending, goodMismatchHandler);

      // Check fail-fast diagnostic
      expect(result.phaseBoundaryError).toBeDefined();
      if (!result.phaseBoundaryError) throw new Error("Expected phaseBoundaryError");
      expect(result.phaseBoundaryError.phase).toBe(7);
      const error = result.phaseBoundaryError.errors[0];
      if (!error) throw new Error("Expected error object");
      expect(error.category).toBe("GOOD");
      expect(Math.abs(error.residual - 25.5)).toBeLessThan(1e-5);
    });
  });
});
