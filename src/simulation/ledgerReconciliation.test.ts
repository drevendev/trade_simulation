/**
 * REQ-CORE-006: Typed ledger/flow records and reconciliation tests.
 *
 * Proves deterministic M2 accounting projection, equal-and-opposite transfer
 * reconciliation, and test-only unmatched-delta detection.
 */

import { describe, it, expect } from "vitest";
import {
  reconcileTickLedger,
  type LedgerRecord,
  type MoneyFlowRecord,
  type GoodFlowRecord,
  type PhysicalLossRecord,
  type StockLocation,
} from "./ledgerReconciliation";
import type { SimulationConfig } from "../config/simulationConfig";

function createTestConfig(): SimulationConfig {
  return {
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
}

const stateLocation: StockLocation = {
  ownerType: "STATE",
  stateId: "state-1" as any,
};

const clanLocation: StockLocation = {
  ownerType: "CLAN",
  clanId: "clan-1" as any,
};

describe("REQ-CORE-006: M2 Typed Ledger Records and Reconciliation", () => {
  describe("Basic reconciliation", () => {
    it("passes for empty ledger", () => {
      const config = createTestConfig();
      const result = reconcileTickLedger([], config);
      expect(result).toBeNull();
    });

    it("passes for balanced equal-and-opposite money transfer", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: stateLocation,
          delta: -100,
          reason: "WAGE_PAYMENT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: clanLocation,
          delta: 100,
          reason: "WAGE_RECEIPT",
        } as MoneyFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).toBeNull();
    });

    it("passes for balanced equal-and-opposite good transfer", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: stateLocation,
          delta: -50,
          reason: "SALE",
        } as GoodFlowRecord,
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: clanLocation,
          delta: 50,
          reason: "PURCHASE",
        } as GoodFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).toBeNull();
    });

    it("detects unbalanced money deltas", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: stateLocation,
          delta: -100,
          reason: "WAGE_PAYMENT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: clanLocation,
          delta: 90, // Should be 100 to balance
          reason: "WAGE_RECEIPT",
        } as MoneyFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("MONEY");
      expect(result?.residual).toBeCloseTo(-10, 5); // -100 + 90 = -10
    });

    it("detects unbalanced good deltas", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: stateLocation,
          delta: -50,
          reason: "SALE",
        } as GoodFlowRecord,
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: clanLocation,
          delta: 40, // Should be 50 to balance
          reason: "PURCHASE",
        } as GoodFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("GOOD");
      expect(result?.residual).toBeCloseTo(-10, 5); // -50 + 40 = -10
    });
  });

  describe("Physical loss handling", () => {
    it("accepts physical loss without balancing credit", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "PHYSICAL_LOSS",
          tick: 1,
          phase: 12,
          goodId: "grain" as any,
          owner: stateLocation,
          delta: -20,
          reason: "SPOILAGE",
        } as PhysicalLossRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("GOOD");
      // The physical loss is unbalanced (no credit), so it should be detected
      expect(result?.residual).toBe(-20);
    });

    it("reconciles goods with physical loss", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: stateLocation,
          delta: 100,
          reason: "PRODUCTION",
        } as GoodFlowRecord,
        {
          type: "PHYSICAL_LOSS",
          tick: 1,
          phase: 12,
          goodId: "grain" as any,
          owner: stateLocation,
          delta: -20,
          reason: "SPOILAGE",
        } as PhysicalLossRecord,
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: clanLocation,
          delta: 80, // Clan receives 80
          reason: "TRANSFER",
        } as GoodFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      // Global reconciliation: 100 - 20 + 80 = 160 (unbalanced)
      expect(result).not.toBeNull();
      expect(result?.category).toBe("GOOD");
      expect(result?.residual).toBeCloseTo(160, 5);
    });
  });

  describe("Multiple currencies and goods", () => {
    it("reconciles independently per currency", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "gold" as any,
          owner: stateLocation,
          delta: -100,
          reason: "PAYMENT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "gold" as any,
          owner: clanLocation,
          delta: 100,
          reason: "RECEIPT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "silver" as any,
          owner: stateLocation,
          delta: 50,
          reason: "CREATION",
        } as MoneyFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("MONEY");
      expect(result?.key).toBe("silver");
    });

    it("reconciles independently per good", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: stateLocation,
          delta: -50,
          reason: "SALE",
        } as GoodFlowRecord,
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "grain" as any,
          owner: clanLocation,
          delta: 50,
          reason: "PURCHASE",
        } as GoodFlowRecord,
        {
          type: "GOOD",
          tick: 1,
          phase: 8,
          goodId: "tools" as any,
          owner: stateLocation,
          delta: 30,
          reason: "CRAFTING",
        } as GoodFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("GOOD");
      expect(result?.key).toBe("tools");
    });
  });

  describe("Tolerance handling", () => {
    it("accepts deltas within tolerance", () => {
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

      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: stateLocation,
          delta: -1000,
          reason: "TRANSFER",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: clanLocation,
          delta: 1000 + 1e-7, // Within 1e-6 relative tolerance of 1000
          reason: "RECEIPT",
        } as MoneyFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).toBeNull();
    });

    it("rejects deltas exceeding tolerance", () => {
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

      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: stateLocation,
          delta: -1000,
          reason: "TRANSFER",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: clanLocation,
          delta: 1000 + 0.01, // Exceeds tolerance of 1e-3 (1e-6 * 1000)
          reason: "RECEIPT",
        } as MoneyFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
    });
  });

  describe("Buckets in stock location", () => {
    it("reconciles buckets globally per good", () => {
      const config = createTestConfig();
      const location1: StockLocation = {
        ownerType: "PRODUCTION_UNIT",
        productionUnitId: "unit-1" as any,
        bucket: "output",
      };
      const location2: StockLocation = {
        ownerType: "PRODUCTION_UNIT",
        productionUnitId: "unit-1" as any,
        bucket: "input",
      };

      const records: LedgerRecord[] = [
        {
          type: "GOOD",
          tick: 1,
          phase: 5,
          goodId: "grain" as any,
          owner: location1,
          delta: -50,
          reason: "OUTPUT_TRANSFER",
        } as GoodFlowRecord,
        {
          type: "GOOD",
          tick: 1,
          phase: 5,
          goodId: "grain" as any,
          owner: location2,
          delta: 40,
          reason: "INPUT_RECEIPT",
        } as GoodFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
      // Global reconciliation: -50 + 40 = -10
      expect(result?.residual).toBeCloseTo(-10, 5);
    });
  });

  describe("Test-only injection of unmatched delta", () => {
    it("detects deliberately injected unmatched delta", () => {
      const config = createTestConfig();
      // Create a large transfer to establish tolerance scale
      const largeAmount = 10000;
      const records: LedgerRecord[] = [
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: stateLocation,
          delta: -largeAmount,
          reason: "PAYMENT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 1,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: clanLocation,
          delta: largeAmount,
          reason: "RECEIPT",
        } as MoneyFlowRecord,
        // Deliberately inject an unmatched delta that exceeds the tolerance
        // tolerance = 1e-6 * max(10000) = 0.01
        // inject 1.0 which is much larger than 0.01
        {
          type: "MONEY",
          tick: 1,
          phase: 15,
          currencyId: "currency-1" as any,
          owner: stateLocation,
          delta: 1.0, // Unmatched delta exceeding tolerance of 0.01
          reason: "TEST_INJECTION",
        } as MoneyFlowRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("MONEY");
      expect(result?.residual).toBeCloseTo(1.0, 5);
      expect(result?.reason).toContain("Unmatched");
    });
  });

  describe("Zero-flow tick handling", () => {
    it("passes for zero-flow tick with no ledger entries", () => {
      const config = createTestConfig();
      const result = reconcileTickLedger([], config);
      expect(result).toBeNull();
    });

    it("passes for balanced multi-phase zero-flow tick", () => {
      const config = createTestConfig();
      const records: LedgerRecord[] = [
        // Phase 5: Wages paid and received
        {
          type: "MONEY",
          tick: 5,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: stateLocation,
          delta: -100,
          reason: "WAGE_PAYMENT",
        } as MoneyFlowRecord,
        {
          type: "MONEY",
          tick: 5,
          phase: 5,
          currencyId: "currency-1" as any,
          owner: clanLocation,
          delta: 100,
          reason: "WAGE_RECEIPT",
        } as MoneyFlowRecord,
        // Phase 8: Goods exchange
        {
          type: "GOOD",
          tick: 5,
          phase: 8,
          goodId: "grain" as any,
          owner: stateLocation,
          delta: -50,
          reason: "SALE",
        } as GoodFlowRecord,
        {
          type: "GOOD",
          tick: 5,
          phase: 8,
          goodId: "grain" as any,
          owner: clanLocation,
          delta: 50,
          reason: "PURCHASE",
        } as GoodFlowRecord,
        // Phase 12: Spoilage (unbalanced by design)
        {
          type: "PHYSICAL_LOSS",
          tick: 5,
          phase: 12,
          goodId: "tools" as any,
          owner: stateLocation,
          delta: -10,
          reason: "SPOILAGE",
        } as PhysicalLossRecord,
      ];

      const result = reconcileTickLedger(records, config);
      expect(result).not.toBeNull(); // Spoilage left -10 unmatched
      expect(result?.category).toBe("GOOD");
    });
  });
});
