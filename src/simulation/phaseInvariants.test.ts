/**
 * REQ-CORE-006: Phase-level invariant hooks tests.
 *
 * Proves fail-fast diagnostic mode and reconciliation gates.
 */

import { describe, it, expect } from "vitest";
import {
  checkLedgerReconciliation,
  checkFiniteNumbers,
  checkPhase15Invariants,
} from "./phaseInvariants";
import type { TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";
import type { LedgerRecord, MoneyFlowRecord } from "./ledgerReconciliation";
import type { SimulationConfig } from "../config/simulationConfig";

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
  };
}

function createTestTickContext(ledgerRecords?: readonly LedgerRecord[]): TickContext {
  return {
    tick: 1,
    phase: 15,
    effectiveJurisdictionByRegion: new Map(),
    rngSeed: 42,
    transactions: [],
    ledgerRecords: ledgerRecords ?? [],
  };
}

describe("REQ-CORE-006: Phase-level Invariant Hooks", () => {
  describe("checkFiniteNumbers", () => {
    it("passes for empty ledger", () => {
      const context = createTestTickContext();
      const failures = checkFiniteNumbers(context);
      expect(failures).toHaveLength(0);
    });

    it("passes for finite ledger deltas", () => {
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "STATE", stateId: "state-1" as any },
          delta: 100.5,
          reason: "TEST",
        } as MoneyFlowRecord,
      ];
      const context = createTestTickContext(records);

      const failures = checkFiniteNumbers(context);
      expect(failures).toHaveLength(0);
    });

    it("detects NaN delta", () => {
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "STATE", stateId: "state-1" as any },
          delta: NaN,
          reason: "TEST",
        } as MoneyFlowRecord,
      ];
      const context = createTestTickContext(records);

      const failures = checkFiniteNumbers(context);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.invariantId).toBe("FINITE_LEDGER_DELTAS");
    });

    it("detects Infinity delta", () => {
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "STATE", stateId: "state-1" as any },
          delta: Infinity,
          reason: "TEST",
        } as MoneyFlowRecord,
      ];
      const context = createTestTickContext(records);

      const failures = checkFiniteNumbers(context);
      expect(failures).toHaveLength(1);
    });

    it("detects -Infinity delta", () => {
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "STATE", stateId: "state-1" as any },
          delta: -Infinity,
          reason: "TEST",
        } as MoneyFlowRecord,
      ];
      const context = createTestTickContext(records);

      const failures = checkFiniteNumbers(context);
      expect(failures).toHaveLength(1);
    });
  });

  describe("checkLedgerReconciliation", () => {
    it("passes for balanced ledger", () => {
      const world = createTestWorldState();
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "STATE", stateId: "state-1" as any },
          delta: -100,
          reason: "PAYMENT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "CLAN", clanId: "clan-1" as any },
          delta: 100,
          reason: "RECEIPT",
        } as MoneyFlowRecord,
      ];
      const context = createTestTickContext(records);

      const result = checkLedgerReconciliation(world, context);
      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("fails for unbalanced ledger", () => {
      const world = createTestWorldState();
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "STATE", stateId: "state-1" as any },
          delta: -100,
          reason: "PAYMENT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: { ownerType: "CLAN", clanId: "clan-1" as any },
          delta: 50, // Unbalanced
          reason: "RECEIPT",
        } as MoneyFlowRecord,
      ];
      const context = createTestTickContext(records);

      const result = checkLedgerReconciliation(world, context);
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.invariantId).toBe("LEDGER_RECONCILIATION");
    });
  });

  describe("checkPhase15Invariants", () => {
    it("passes for valid phase-15 state", () => {
      const world = createTestWorldState();
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 15,
          currencyId: "currency-1" as any,
          owner: { ownerType: "STATE", stateId: "state-1" as any },
          delta: -50,
          reason: "TRANSFER",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 15,
          currencyId: "currency-1" as any,
          owner: { ownerType: "CLAN", clanId: "clan-1" as any },
          delta: 50,
          reason: "RECEIPT",
        } as MoneyFlowRecord,
      ];
      const context = createTestTickContext(records);

      const result = checkPhase15Invariants(world, context);
      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("detects NaN delta through finite number check", () => {
      const world = createTestWorldState();
      const context = createTestTickContext();
      // Create a context with NaN by type-casting to bypass the type system
      const badContext = {
        ...context,
        ledgerRecords: [
          {
            type: "MONEY",
            tick: 1,
            phase: 15,
            currencyId: "currency-1" as any,
            owner: { ownerType: "STATE", stateId: "state-1" as any },
            delta: NaN, // Non-finite
            reason: "BAD_TRANSFER",
          },
        ] as any,
      };

      const finiteFailures = checkFiniteNumbers(badContext);
      expect(finiteFailures).toHaveLength(1);
      expect(finiteFailures[0].invariantId).toBe("FINITE_LEDGER_DELTAS");
    });

    it("empty ledger passes all invariants", () => {
      const world = createTestWorldState();
      const context = createTestTickContext([]);

      const result = checkPhase15Invariants(world, context);
      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });
  });
});
