/**
 * Phase-level invariant hooks tests (REQ-CORE-006).
 *
 * Verifies registration, execution, and failure detection of invariants.
 */

import { describe, it, expect } from "vitest";
import {
  createEmptyInvariantRegistry,
  registerPhaseInvariant,
  executePhaseInvariants,
  createConservationInvariant,
  createFiniteValueInvariant,
  createDefaultInvariantRegistry,
  type InvariantHook,
} from "./invariantHooks";
import {
  createEmptyRuntimeLedger,
  addMoneyFlow,
  createMoneyFlow,
} from "./ledgerFlow";
import { initializeTickContext } from "./tickOrchestrator";
import type { SimulationConfig } from "../config/simulationConfig";
import type { WorldState } from "./worldState";

const testConfig: SimulationConfig = {
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

function createTestWorldState(): WorldState {
  return {
    configVersion: "1.0",
    scenarioId: "test",
    seed: 42,
    definitionRegistry: {
      goods: {},
      recipes: {},
      eventDefinitions: {},
      metricDefinitions: {},
    },
    simulationConfig: testConfig,
    worldGenesisLedger: { records: [] },
    regions: new Map(),
    states: new Map(),
    currencies: new Map(),
    monetaryAuthorities: new Map(),
    clans: new Map(),
    cohorts: new Map(),
    productionUnits: new Map(),
    markets: new Map(),
    transportLinks: new Map(),
  };
}

describe("REQ-CORE-006: Phase-level invariant hooks", () => {
  describe("Registry creation and management", () => {
    it("creates an empty invariant registry", () => {
      const registry = createEmptyInvariantRegistry();
      expect(registry.hooksByPhase.size).toBe(0);
    });

    it("registers a hook for a phase", () => {
      let registry = createEmptyInvariantRegistry();
      const hook: InvariantHook = () => null;
      registry = registerPhaseInvariant(registry, 0, hook);

      expect(registry.hooksByPhase.has(0)).toBe(true);
      expect(registry.hooksByPhase.get(0)).toHaveLength(1);
    });

    it("registers multiple hooks for the same phase", () => {
      let registry = createEmptyInvariantRegistry();
      const hook1: InvariantHook = () => null;
      const hook2: InvariantHook = () => null;

      registry = registerPhaseInvariant(registry, 0, hook1);
      registry = registerPhaseInvariant(registry, 0, hook2);

      expect(registry.hooksByPhase.get(0)).toHaveLength(2);
    });

    it("registers hooks for different phases", () => {
      let registry = createEmptyInvariantRegistry();
      const hook: InvariantHook = () => null;

      registry = registerPhaseInvariant(registry, 0, hook);
      registry = registerPhaseInvariant(registry, 5, hook);
      registry = registerPhaseInvariant(registry, 15, hook);

      expect(registry.hooksByPhase.size).toBe(3);
      expect(registry.hooksByPhase.has(0)).toBe(true);
      expect(registry.hooksByPhase.has(5)).toBe(true);
      expect(registry.hooksByPhase.has(15)).toBe(true);
    });

    it("creates a default invariant registry with 16 phases", () => {
      const registry = createDefaultInvariantRegistry();

      for (let phase = 0; phase < 16; phase++) {
        expect(registry.hooksByPhase.has(phase)).toBe(true);
        expect((registry.hooksByPhase.get(phase) ?? []).length).toBeGreaterThan(0);
      }
    });
  });

  describe("Hook execution", () => {
    it("executes no hooks for unregistered phase", () => {
      const registry = createEmptyInvariantRegistry();
      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);
      const ledger = createEmptyRuntimeLedger();

      expect(() => {
        executePhaseInvariants(registry, 5, world, context, ledger, testConfig);
      }).not.toThrow();
    });

    it("executes registered hook and passes if it returns null", () => {
      let registry = createEmptyInvariantRegistry();
      const hook: InvariantHook = () => null;
      registry = registerPhaseInvariant(registry, 0, hook);

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);
      const ledger = createEmptyRuntimeLedger();

      expect(() => {
        executePhaseInvariants(registry, 0, world, context, ledger, testConfig);
      }).not.toThrow();
    });

    it("throws when hook returns error message", () => {
      let registry = createEmptyInvariantRegistry();
      const hook: InvariantHook = () => "Test error";
      registry = registerPhaseInvariant(registry, 0, hook);

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);
      const ledger = createEmptyRuntimeLedger();

      expect(() => {
        executePhaseInvariants(registry, 0, world, context, ledger, testConfig);
      }).toThrow("Phase 0 invariant violation: Test error");
    });

    it("executes all hooks for a phase", () => {
      let registry = createEmptyInvariantRegistry();
      let executedHooks = 0;

      const hook1: InvariantHook = () => {
        executedHooks++;
        return null;
      };
      const hook2: InvariantHook = () => {
        executedHooks++;
        return null;
      };

      registry = registerPhaseInvariant(registry, 0, hook1);
      registry = registerPhaseInvariant(registry, 0, hook2);

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);
      const ledger = createEmptyRuntimeLedger();

      executePhaseInvariants(registry, 0, world, context, ledger, testConfig);
      expect(executedHooks).toBe(2);
    });

    it("stops executing hooks on first failure", () => {
      let registry = createEmptyInvariantRegistry();
      let executedHooks = 0;

      const hook1: InvariantHook = () => {
        executedHooks++;
        return "First error";
      };
      const hook2: InvariantHook = () => {
        executedHooks++;
        return null;
      };

      registry = registerPhaseInvariant(registry, 0, hook1);
      registry = registerPhaseInvariant(registry, 0, hook2);

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);
      const ledger = createEmptyRuntimeLedger();

      expect(() => {
        executePhaseInvariants(registry, 0, world, context, ledger, testConfig);
      }).toThrow();

      expect(executedHooks).toBe(1); // Only first hook executed
    });
  });

  describe("Conservation invariant", () => {
    it("passes for empty ledger", () => {
      const hook = createConservationInvariant();
      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);
      const ledger = createEmptyRuntimeLedger();

      const error = hook(world, context, ledger, testConfig);
      expect(error).toBeNull();
    });

    it("passes for balanced flows", () => {
      const hook = createConservationInvariant();
      let ledger = createEmptyRuntimeLedger();

      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "out"),
      );
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s2" as any }, -100, "in"),
      );

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);

      const error = hook(world, context, ledger, testConfig);
      expect(error).toBeNull();
    });

    it("fails for unbalanced flows", () => {
      const hook = createConservationInvariant();
      let ledger = createEmptyRuntimeLedger();

      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "out"),
      );

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);

      const error = hook(world, context, ledger, testConfig);
      expect(error).not.toBeNull();
      expect(error).toContain("conservation");
    });
  });

  describe("Finite value invariant", () => {
    it("passes for finite flows", () => {
      const hook = createFiniteValueInvariant();
      let ledger = createEmptyRuntimeLedger();

      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100.5, "test"),
      );

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);

      const error = hook(world, context, ledger, testConfig);
      expect(error).toBeNull();
    });

    it("fails for NaN in money flow", () => {
      const hook = createFiniteValueInvariant();
      let ledger = createEmptyRuntimeLedger();

      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, NaN, "bad"),
      );

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);

      const error = hook(world, context, ledger, testConfig);
      expect(error).not.toBeNull();
      expect(error).toContain("Non-finite");
    });

    it("fails for Infinity in money flow", () => {
      const hook = createFiniteValueInvariant();
      let ledger = createEmptyRuntimeLedger();

      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, Infinity, "bad"),
      );

      const world = createTestWorldState();
      const context = initializeTickContext(0, 42);

      const error = hook(world, context, ledger, testConfig);
      expect(error).not.toBeNull();
      expect(error).toContain("Non-finite");
    });
  });
});
