/**
 * Tick reconciliation and diagnostics tests (REQ-CORE-006).
 *
 * Verifies zero-flow conservation, reconciliation, and diagnostic projection.
 */

import { describe, it, expect } from "vitest";
import {
  reconcileTickFlows,
  buildDiagnosticProjection,
  type ReconciliationResult,
} from "./reconciliation";
import {
  createEmptyRuntimeLedger,
  addMoneyFlow,
  addGoodFlow,
  addPhysicalLoss,
  createMoneyFlow,
  createGoodFlow,
  createPhysicalLoss,
} from "./ledgerFlow";
import type { SimulationConfig } from "../config/simulationConfig";

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

describe("REQ-CORE-006: Tick reconciliation", () => {
  describe("Zero-flow reconciliation", () => {
    it("passes empty ledger", () => {
      const ledger = createEmptyRuntimeLedger();
      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(true);
    });

    it("passes equal-and-opposite money transfers", () => {
      let ledger = createEmptyRuntimeLedger();
      const outflow = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "CLAN", clanId: "c1" as any },
        -100,
        "payment",
      );
      const inflow = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "STATE", stateId: "s1" as any },
        100,
        "receipt",
      );
      ledger = addMoneyFlow(ledger, outflow);
      ledger = addMoneyFlow(ledger, inflow);

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(true);
    });

    it("passes equal-and-opposite good transfers", () => {
      let ledger = createEmptyRuntimeLedger();
      const outflow = createGoodFlow(
        0,
        6,
        "wheat" as any,
        { type: "PRODUCTION_UNIT", productionUnitId: "pu1" as any },
        "r1" as any,
        -50,
        "sale",
      );
      const inflow = createGoodFlow(
        0,
        6,
        "wheat" as any,
        { type: "CLAN", clanId: "c1" as any },
        "r1" as any,
        50,
        "purchase",
      );
      ledger = addGoodFlow(ledger, outflow);
      ledger = addGoodFlow(ledger, inflow);

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(true);
    });

    it("passes multiple currencies that each reconcile", () => {
      let ledger = createEmptyRuntimeLedger();

      // USD: +100 -100 = 0
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "open"),
      );
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 2, "USD" as any, { type: "CLAN", clanId: "c1" as any }, -100, "close"),
      );

      // EUR: +50 -50 = 0
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 1, "EUR" as any, { type: "STATE", stateId: "s2" as any }, 50, "open"),
      );
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 2, "EUR" as any, { type: "CLAN", clanId: "c2" as any }, -50, "close"),
      );

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(true);
    });

    it("allows physical loss without balancing credit", () => {
      let ledger = createEmptyRuntimeLedger();
      const loss = createPhysicalLoss(0, 8, "grain" as any, "r1" as any, 10, "spoilage");
      ledger = addPhysicalLoss(ledger, loss);

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(true);
    });
  });

  describe("Reconciliation failure detection", () => {
    it("fails on unmatched money outflow", () => {
      let ledger = createEmptyRuntimeLedger();
      const outflow = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "CLAN", clanId: "c1" as any },
        -100,
        "payment",
      );
      ledger = addMoneyFlow(ledger, outflow);

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(false);
      expect(result.unmatched).toBeDefined();
      expect(result.unmatched?.category).toBe("MONEY");
      expect(result.unmatched?.residual).toBeLessThan(0);
    });

    it("fails on unmatched good outflow", () => {
      let ledger = createEmptyRuntimeLedger();
      const outflow = createGoodFlow(
        0,
        6,
        "wheat" as any,
        { type: "PRODUCTION_UNIT", productionUnitId: "pu1" as any },
        "r1" as any,
        -50,
        "sale",
      );
      ledger = addGoodFlow(ledger, outflow);

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(false);
      expect(result.unmatched).toBeDefined();
      expect(result.unmatched?.category).toBe("GOOD");
      expect(result.unmatched?.residual).toBeLessThan(0);
    });

    it("fails when residual exceeds tolerance", () => {
      let ledger = createEmptyRuntimeLedger();
      const outflow = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "CLAN", clanId: "c1" as any },
        -100,
        "payment",
      );
      const inflow = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "STATE", stateId: "s1" as any },
        99.9999,
        "partial",
      );
      ledger = addMoneyFlow(ledger, outflow);
      ledger = addMoneyFlow(ledger, inflow);

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(false);
      expect(result.unmatched?.residual).toBeLessThan(0);
      const tolerance = testConfig.numeric.reconciliationRelativeTolerance;
      if (tolerance !== undefined) {
        expect(Math.abs(result.unmatched?.residual ?? 0)).toBeGreaterThan(tolerance);
      }
    });

    it("passes when residual is within tolerance", () => {
      let ledger = createEmptyRuntimeLedger();
      const outflow = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "CLAN", clanId: "c1" as any },
        -100,
        "payment",
      );
      // Residual of 1e-7 is within default tolerance of 1e-6
      const inflow = createMoneyFlow(
        0,
        2,
        "USD" as any,
        { type: "STATE", stateId: "s1" as any },
        100 - 1e-7,
        "partial",
      );
      ledger = addMoneyFlow(ledger, outflow);
      ledger = addMoneyFlow(ledger, inflow);

      const result = reconcileTickFlows(ledger, testConfig);
      expect(result.success).toBe(true);
    });
  });

  describe("Diagnostic projection", () => {
    it("builds empty projection for empty ledger", () => {
      const ledger = createEmptyRuntimeLedger();
      const projection = buildDiagnosticProjection(ledger, 0, 0);

      expect(projection.tick).toBe(0);
      expect(projection.phase).toBe(0);
      expect(projection.moneyFlowsByFormula.size).toBe(0);
      expect(projection.goodFlowsByFormula.size).toBe(0);
      expect(projection.physicalLossByFormula.size).toBe(0);
      expect(projection.totalFlows).toBe(0);
    });

    it("filters flows by tick and phase", () => {
      let ledger = createEmptyRuntimeLedger();

      // Tick 0, Phase 0
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "open"),
      );

      // Tick 0, Phase 1
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 1, "USD" as any, { type: "STATE", stateId: "s1" as any }, 50, "phase1"),
      );

      // Tick 1, Phase 0
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(1, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 75, "tick1"),
      );

      const proj00 = buildDiagnosticProjection(ledger, 0, 0);
      const proj01 = buildDiagnosticProjection(ledger, 0, 1);
      const proj10 = buildDiagnosticProjection(ledger, 1, 0);

      expect(proj00.moneyFlowsByFormula.get("USD" as any)).toBe(100);
      expect(proj01.moneyFlowsByFormula.get("USD" as any)).toBe(50);
      expect(proj10.moneyFlowsByFormula.get("USD" as any)).toBe(75);
    });

    it("aggregates flows of same type and key", () => {
      let ledger = createEmptyRuntimeLedger();

      // Two money flows to same currency
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "part1"),
      );
      ledger = addMoneyFlow(
        ledger,
        createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s2" as any }, 50, "part2"),
      );

      const projection = buildDiagnosticProjection(ledger, 0, 0);
      expect(projection.moneyFlowsByFormula.get("USD" as any)).toBe(150);
    });

    it("exposes physical loss separately from good flows", () => {
      let ledger = createEmptyRuntimeLedger();

      // Good flow
      ledger = addGoodFlow(
        ledger,
        createGoodFlow(0, 8, "grain" as any, { type: "CLAN", clanId: "c1" as any }, "r1" as any, 100, "supply"),
      );

      // Physical loss
      ledger = addPhysicalLoss(
        ledger,
        createPhysicalLoss(0, 8, "grain" as any, "r1" as any, 10, "spoilage"),
      );

      const projection = buildDiagnosticProjection(ledger, 0, 8);
      expect(projection.goodFlowsByFormula.get("grain" as any)).toBe(100);
      expect(projection.physicalLossByFormula.get("grain" as any)).toBe(10);
    });

    it("counts total flows correctly", () => {
      let ledger = createEmptyRuntimeLedger();

      for (let i = 0; i < 5; i++) {
        ledger = addMoneyFlow(
          ledger,
          createMoneyFlow(0, 0, `USD` as any, { type: "STATE", stateId: `s${i}` as any }, 10, `flow${i}`),
        );
      }

      const projection = buildDiagnosticProjection(ledger, 0, 0);
      expect(projection.totalFlows).toBe(5);
    });
  });

  describe("Tolerance handling", () => {
    it("uses config tolerance value", () => {
      const customConfig: SimulationConfig = {
        configVersion: "1.0",
        numeric: {
          quantityEpsilon: 1e-9,
          moneyEpsilon: 1e-9,
          reconciliationRelativeTolerance: 1e-1,
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

      let ledger = createEmptyRuntimeLedger();
      const outflow = createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, -100, "pay");
      const inflow = createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s2" as any }, 99.9, "recv");

      ledger = addMoneyFlow(ledger, outflow);
      ledger = addMoneyFlow(ledger, inflow);

      const result = reconcileTickFlows(ledger, customConfig);
      expect(result.success).toBe(true);
    });

    it("respects default tolerance when very small", () => {
      const configSmallTolerance: SimulationConfig = {
        configVersion: "1.0",
        numeric: {
          quantityEpsilon: 1e-9,
          moneyEpsilon: 1e-9,
          reconciliationRelativeTolerance: 1e-12,
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

      let ledger = createEmptyRuntimeLedger();
      const flow = createMoneyFlow(0, 0, "USD" as any, { type: "STATE", stateId: "s1" as any }, 100, "open");
      ledger = addMoneyFlow(ledger, flow);

      const result = reconcileTickFlows(ledger, configSmallTolerance);
      // Should fail due to unmatched 100 > tolerance of 1e-12
      expect(result.success).toBe(false);
    });
  });
});
