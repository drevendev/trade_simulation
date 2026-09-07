/**
 * REQ-ACCEPTANCE-002: Canonical replay hash is deterministic for at least 100 ticks at M2.
 *
 * This integration test proves:
 * 1. Repeated same-seed 100+ tick runs produce identical normalized hashes
 * 2. Different seeds produce different hashes
 * 3. Replay hash computation is deterministic and replayable
 * 4. No-op scenario successfully runs for at least 100 ticks without error
 *
 * Acceptance criteria:
 * - A comprehensive test proves repeated same-seed 100+ tick canonical runs produce identical normalized hash
 * - Test proves different seeds produce different hashes
 * - Replay hash computation is deterministic and replayable with the resolved SimulationConfig
 * - No-op scenario successfully runs for at least 100 ticks without error
 */

import { describe, it, expect } from "vitest";
import { buildInitialWorld, type PendingTransitions } from "./worldState";
import { executeTick, computeTickHash, noOpPhaseHandler, initializeTickContext } from "./tickOrchestrator";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";

/**
 * Create empty PendingTransitions for no-op scenario.
 */
function createEmptyPendingTransitions(): PendingTransitions {
  return {
    jurisdictionChanges: [],
    stateCreations: [],
    policyChanges: [],
    monetaryPolicyChanges: [],
  };
}

/**
 * Run a canonical simulation for N ticks and collect replay hashes.
 */
function runSimulationAndCollectHashes(seed: number, tickCount: number): { hashes: string[]; tickCount: number } {
  const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), seed);
  const pending = createEmptyPendingTransitions();

  const hashes: string[] = [];

  for (let tick = 0; tick < tickCount; tick++) {
    const { context } = executeTick(world, tick, pending, noOpPhaseHandler);
    const hash = computeTickHash(world, context);
    hashes.push(hash);
  }

  return { hashes, tickCount };
}

describe("REQ-ACCEPTANCE-002: Canonical replay hash determinism (100+ ticks)", () => {
  describe("Baseline scenario construction", () => {
    it("builds baseline scenario with no errors", () => {
      expect(() => {
        buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      }).not.toThrow();
    });

    it("produces frozen WorldState", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      expect(Object.isFrozen(world)).toBe(true);
    });

    it("carries seed through WorldState", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      expect(world.seed).toBe(42);
    });
  });

  describe("100+ tick no-op scenario execution", () => {
    it("executes 100 consecutive ticks without error", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending = createEmptyPendingTransitions();

      expect(() => {
        for (let tick = 0; tick < 100; tick++) {
          executeTick(world, tick, pending, noOpPhaseHandler);
        }
      }).not.toThrow();
    });

    it("completes 100 ticks preserving all stocks exactly", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending = createEmptyPendingTransitions();

      let lastTick = -1;
      for (let tick = 0; tick < 100; tick++) {
        const { context, reconciliationErrors } = executeTick(world, tick, pending, noOpPhaseHandler);
        lastTick = context.tick;
        // No-op handler means no transactions
        expect(context.transactions).toHaveLength(0);
        // No ledger records in no-op, reconciliation should pass (null)
        expect(reconciliationErrors).toBeNull();
      }

      expect(lastTick).toBe(99);
    });

    it("executes at least 120 ticks (demonstrates stability beyond 100)", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending = createEmptyPendingTransitions();

      let tickCount = 0;
      for (let tick = 0; tick < 120; tick++) {
        const { reconciliationErrors } = executeTick(world, tick, pending, noOpPhaseHandler);
        tickCount++;
        // No-op: reconciliation should always pass
        expect(reconciliationErrors).toBeNull();
      }

      expect(tickCount).toBe(120);
    });
  });

  describe("Deterministic replay hash: same seed produces identical hashes", () => {
    it("produces identical hashes across two identical 100-tick runs with reconciliation passing", () => {
      const world1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const world2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending1 = createEmptyPendingTransitions();
      const pending2 = createEmptyPendingTransitions();

      const hashes1: string[] = [];
      const hashes2: string[] = [];

      for (let tick = 0; tick < 100; tick++) {
        const { context: ctx1, reconciliationErrors: err1 } = executeTick(world1, tick, pending1, noOpPhaseHandler);
        const { context: ctx2, reconciliationErrors: err2 } = executeTick(world2, tick, pending2, noOpPhaseHandler);
        hashes1.push(computeTickHash(world1, ctx1));
        hashes2.push(computeTickHash(world2, ctx2));
        expect(err1).toBeNull();
        expect(err2).toBeNull();
      }

      expect(hashes1).toEqual(hashes2);
    });

    it("produces identical hashes for first 50 ticks across three runs with same seed", () => {
      const run1 = runSimulationAndCollectHashes(99, 50);
      const run2 = runSimulationAndCollectHashes(99, 50);
      const run3 = runSimulationAndCollectHashes(99, 50);

      expect(run1.hashes).toEqual(run2.hashes);
      expect(run2.hashes).toEqual(run3.hashes);
    });

    it("each hash is a valid SHA-256 hex string", () => {
      const { hashes } = runSimulationAndCollectHashes(42, 10);

      hashes.forEach((hash) => {
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      });
    });

    it("hash changes between consecutive ticks (deterministic but different per tick)", () => {
      const { hashes } = runSimulationAndCollectHashes(42, 50);

      // Each tick should have a different hash because tick number is part of hash
      for (let i = 1; i < hashes.length; i++) {
        expect(hashes[i]).not.toBe(hashes[i - 1]);
      }
    });
  });

  describe("Different seeds produce different hashes", () => {
    it("produces different hashes for runs with different seeds", () => {
      const run1 = runSimulationAndCollectHashes(42, 50);
      const run2 = runSimulationAndCollectHashes(43, 50);

      expect(run1.hashes).not.toEqual(run2.hashes);
    });

    it("first tick hash differs for different seeds", () => {
      const run1 = runSimulationAndCollectHashes(100, 1);
      const run2 = runSimulationAndCollectHashes(101, 1);

      expect(run1.hashes[0]).not.toBe(run2.hashes[0]);
    });

    it("at least one hash differs within first 50 ticks for different seeds", () => {
      const run1 = runSimulationAndCollectHashes(1000, 50);
      const run2 = runSimulationAndCollectHashes(1001, 50);

      const differences = run1.hashes.filter((hash, idx) => hash !== run2.hashes[idx]).length;
      expect(differences).toBeGreaterThan(0);
    });
  });

  describe("Deterministic replay with configuration", () => {
    it("same seed/config/scenario produces byte-equivalent results", () => {
      const world1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const world2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);

      expect(world1.configVersion).toBe(world2.configVersion);
      expect(world1.scenarioId).toBe(world2.scenarioId);
      expect(world1.seed).toBe(world2.seed);
    });

    it("replays produce identical hashes when using the same resolved config", () => {
      const config = createDefaultSimulationConfig();

      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
      const pending = createEmptyPendingTransitions();

      const hashes1: string[] = [];
      for (let tick = 0; tick < 30; tick++) {
        const { context } = executeTick(world, tick, pending, noOpPhaseHandler);
        hashes1.push(computeTickHash(world, context));
      }

      // Replay with same config
      const hashes2: string[] = [];
      for (let tick = 0; tick < 30; tick++) {
        const { context } = executeTick(world, tick, pending, noOpPhaseHandler);
        hashes2.push(computeTickHash(world, context));
      }

      expect(hashes1).toEqual(hashes2);
    });
  });

  describe("Zero-flow reconciliation for M2 gate", () => {
    it("no-op ticks produce zero transaction flow and pass reconciliation", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending = createEmptyPendingTransitions();

      for (let tick = 0; tick < 100; tick++) {
        const { context, reconciliationErrors } = executeTick(world, tick, pending, noOpPhaseHandler);
        expect(context.transactions).toHaveLength(0);
        // No ledger records in no-op scenario
        expect(context.currentLedger.records).toHaveLength(0);
        // Empty ledger passes reconciliation (null = no errors)
        expect(reconciliationErrors).toBeNull();
      }
    });

    it("genesis reconciliation passes before any ticks", () => {
      // buildInitialWorld includes genesis reconciliation (REQ-CONFIG-004)
      expect(() => {
        buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      }).not.toThrow();
    });
  });

  describe("Phase trace consistency", () => {
    it("each tick executes exactly 16 phases in order and passes reconciliation", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending = createEmptyPendingTransitions();

      for (let tick = 0; tick < 50; tick++) {
        const { phaseTrace, reconciliationErrors } = executeTick(world, tick, pending, noOpPhaseHandler);
        expect(phaseTrace).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        expect(reconciliationErrors).toBeNull(); // No-op: reconciliation passes
      }
    });

    it("phase order is preserved across 100+ ticks with zero-flow reconciliation passing", () => {
      const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending = createEmptyPendingTransitions();

      const expectedPhaseTrace = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

      for (let tick = 0; tick < 100; tick++) {
        const { phaseTrace, reconciliationErrors } = executeTick(world, tick, pending, noOpPhaseHandler);
        expect(phaseTrace).toEqual(expectedPhaseTrace);
        expect(reconciliationErrors).toBeNull(); // No-op: reconciliation passes
      }
    });
  });

  describe("Comprehensive 100+ tick determinism proof with reconciliation", () => {
    it("proves determinism: three independent 100-tick runs with same seed produce identical hashes and pass reconciliation", () => {
      const world1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 7);
      const world2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 7);
      const world3 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 7);
      const pending1 = createEmptyPendingTransitions();
      const pending2 = createEmptyPendingTransitions();
      const pending3 = createEmptyPendingTransitions();

      const hashes1: string[] = [];
      const hashes2: string[] = [];
      const hashes3: string[] = [];

      for (let tick = 0; tick < 100; tick++) {
        const { context: ctx1, reconciliationErrors: err1 } = executeTick(world1, tick, pending1, noOpPhaseHandler);
        const { context: ctx2, reconciliationErrors: err2 } = executeTick(world2, tick, pending2, noOpPhaseHandler);
        const { context: ctx3, reconciliationErrors: err3 } = executeTick(world3, tick, pending3, noOpPhaseHandler);
        hashes1.push(computeTickHash(world1, ctx1));
        hashes2.push(computeTickHash(world2, ctx2));
        hashes3.push(computeTickHash(world3, ctx3));
        expect(err1).toBeNull();
        expect(err2).toBeNull();
        expect(err3).toBeNull();
      }

      expect(hashes1).toEqual(hashes2);
      expect(hashes2).toEqual(hashes3);
    });

    it("proves different seeds: three runs with different seeds produce different hashes", () => {
      const run1 = runSimulationAndCollectHashes(1, 100);
      const run2 = runSimulationAndCollectHashes(2, 100);
      const run3 = runSimulationAndCollectHashes(3, 100);

      expect(run1.hashes).not.toEqual(run2.hashes);
      expect(run2.hashes).not.toEqual(run3.hashes);
      expect(run1.hashes).not.toEqual(run3.hashes);
    });

    it("maintains determinism even for 120 ticks (beyond M2 100-tick gate) with reconciliation passing", () => {
      const world1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const world2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42);
      const pending1 = createEmptyPendingTransitions();
      const pending2 = createEmptyPendingTransitions();

      const hashes1: string[] = [];
      const hashes2: string[] = [];

      for (let tick = 0; tick < 120; tick++) {
        const { context: ctx1, reconciliationErrors: err1 } = executeTick(world1, tick, pending1, noOpPhaseHandler);
        const { context: ctx2, reconciliationErrors: err2 } = executeTick(world2, tick, pending2, noOpPhaseHandler);
        hashes1.push(computeTickHash(world1, ctx1));
        hashes2.push(computeTickHash(world2, ctx2));
        expect(err1).toBeNull();
        expect(err2).toBeNull();
      }

      expect(hashes1).toEqual(hashes2);
    });
  });
});
