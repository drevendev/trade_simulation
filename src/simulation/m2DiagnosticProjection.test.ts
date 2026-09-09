/**
 * M2 diagnostic projection tests for Milestone Preview visualization.
 *
 * Tests the normalized read-only view of MONEY/GOOD/PHYSICAL_LOSS flows
 * used for GitHub Pages Milestone Preview without affecting replay hash.
 */

import { describe, it, expect } from "vitest";
import {
  projectM2DiagnosticTick,
  aggregateM2DiagnosticRun,
  type M2DiagnosticTickProjection,
  type M2DiagnosticRunProjection,
} from "./m2DiagnosticProjection";
import {
  createEmptyTickLedger,
  addLedgerRecord,
  validateZeroFlowReconciliation,
  type TickLedger,
  type MoneyFlowRecord,
  type GoodFlowRecord,
  type PhysicalLossRecord,
} from "./ledger";

describe("M2 diagnostic projection", () => {
  describe("Empty tick projection", () => {
    it("projects empty ledger as zero records with passing reconciliation", () => {
      const ledger = createEmptyTickLedger(1);
      const projection = projectM2DiagnosticTick(ledger, null);

      expect(projection.tick).toBe(1);
      expect(projection.ledgerRecordCount).toBe(0);
      expect(projection.flowSummaries).toHaveLength(0);
      expect(projection.reconciliationStatus.passed).toBe(true);
      expect(projection.reconciliationStatus.unmatched).toHaveLength(0);
    });

    it("projects with reconciliation errors when provided", () => {
      const ledger = createEmptyTickLedger(1);
      const errors = [{ category: "MONEY", residual: 100 }];
      const projection = projectM2DiagnosticTick(ledger, errors);

      expect(projection.reconciliationStatus.passed).toBe(false);
      expect(projection.reconciliationStatus.unmatched).toEqual(errors);
    });
  });

  describe("Money flow projection", () => {
    it("projects single money flow record", () => {
      let ledger = createEmptyTickLedger(1);
      const record: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 0,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 100,
      };

      ledger = addLedgerRecord(ledger, record);
      const projection = projectM2DiagnosticTick(ledger, null);

      expect(projection.ledgerRecordCount).toBe(1);
      expect(projection.flowSummaries).toHaveLength(1);
      expect(projection.flowSummaries[0]!.category).toBe("MONEY");
      expect(projection.flowSummaries[0]!.totalDelta).toBe(100);
      expect(projection.flowSummaries[0]!.recordCount).toBe(1);
    });

    it("aggregates multiple money records for same key and phase", () => {
      let ledger = createEmptyTickLedger(1);

      const record1: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 0,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 100,
      };

      const record2: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 0,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 50,
      };

      ledger = addLedgerRecord(ledger, record1);
      ledger = addLedgerRecord(ledger, record2);
      const projection = projectM2DiagnosticTick(ledger, null);

      expect(projection.ledgerRecordCount).toBe(2);
      expect(projection.flowSummaries).toHaveLength(1);
      expect(projection.flowSummaries[0]!.totalDelta).toBe(150);
      expect(projection.flowSummaries[0]!.recordCount).toBe(2);
    });

    it("separates money flows for different phases", () => {
      let ledger = createEmptyTickLedger(1);

      const record1: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 0,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 100,
      };

      const record2: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 1,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 50,
      };

      ledger = addLedgerRecord(ledger, record1);
      ledger = addLedgerRecord(ledger, record2);
      const projection = projectM2DiagnosticTick(ledger, null);

      expect(projection.ledgerRecordCount).toBe(2);
      expect(projection.flowSummaries).toHaveLength(2);
      expect(projection.flowSummaries[0]!.phase).toBe(0);
      expect(projection.flowSummaries[1]!.phase).toBe(1);
    });
  });

  describe("Good flow projection", () => {
    it("projects good flow records with bucket attribution", () => {
      let ledger = createEmptyTickLedger(1);
      const record: GoodFlowRecord = {
        type: "GOOD",
        tick: 1,
        phase: 2,
        reason: "TEST",
        goodId: "WHEAT",
        holderType: "cohort",
        holderKey: "COHORT_1" as any,
        bucket: "household",
        delta: -25,
      };

      ledger = addLedgerRecord(ledger, record);
      const projection = projectM2DiagnosticTick(ledger, null);

      expect(projection.flowSummaries).toHaveLength(1);
      expect(projection.flowSummaries[0]!.category).toBe("GOOD");
      expect(projection.flowSummaries[0]!.totalDelta).toBe(-25);
      expect(projection.flowSummaries[0]!.key).toContain("WHEAT");
      expect(projection.flowSummaries[0]!.key).toContain("household");
    });
  });

  describe("Physical loss projection", () => {
    it("projects physical loss records with cause attribution", () => {
      let ledger = createEmptyTickLedger(1);
      const record: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 12,
        reason: "TEST",
        resourceType: "good",
        resourceId: "WHEAT",
        locationKey: "REGION_1" as any,
        amount: 10,
        cause: "spoilage",
      };

      ledger = addLedgerRecord(ledger, record);
      const projection = projectM2DiagnosticTick(ledger, null);

      expect(projection.flowSummaries).toHaveLength(1);
      expect(projection.flowSummaries[0]!.category).toBe("PHYSICAL_LOSS");
      expect(projection.flowSummaries[0]!.totalDelta).toBe(10);
      expect(projection.flowSummaries[0]!.ownerType).toContain("spoilage");
    });
  });

  describe("Mixed flow projection", () => {
    it("projects and separates money, good and loss records", () => {
      let ledger = createEmptyTickLedger(1);

      const moneyRecord: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 0,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 100,
      };

      const goodRecord: GoodFlowRecord = {
        type: "GOOD",
        tick: 1,
        phase: 0,
        reason: "TEST",
        goodId: "WHEAT",
        holderType: "cohort",
        holderKey: "COHORT_1" as any,
        bucket: "household",
        delta: -25,
      };

      const lossRecord: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 0,
        reason: "TEST",
        resourceType: "good",
        resourceId: "WHEAT",
        locationKey: "REGION_1" as any,
        amount: 10,
        cause: "spoilage",
      };

      ledger = addLedgerRecord(ledger, moneyRecord);
      ledger = addLedgerRecord(ledger, goodRecord);
      ledger = addLedgerRecord(ledger, lossRecord);
      const projection = projectM2DiagnosticTick(ledger, null);

      expect(projection.ledgerRecordCount).toBe(3);
      expect(projection.flowSummaries).toHaveLength(3);

      const byCategory = projection.flowSummaries.reduce(
        (acc, s) => {
          acc[s.category] = (acc[s.category] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      expect(byCategory.MONEY).toBe(1);
      expect(byCategory.GOOD).toBe(1);
      expect(byCategory.PHYSICAL_LOSS).toBe(1);
    });
  });

  describe("Stable sorting", () => {
    it("sorts flow summaries deterministically by category, phase, key", () => {
      let ledger = createEmptyTickLedger(1);

      // Add in non-sorted order
      const records = [
        {
          type: "GOOD" as const,
          tick: 1,
          phase: 1,
          reason: "TEST",
          goodId: "B_GOOD",
          holderType: "cohort" as const,
          holderKey: "COHORT_1" as any,
          bucket: "household" as const,
          delta: -5,
        } as GoodFlowRecord,
        {
          type: "MONEY" as const,
          tick: 1,
          phase: 0,
          reason: "TEST",
          currencyId: "USD" as any,
          ownerType: "state" as const,
          ownerKey: "STATE_1" as any,
          delta: 100,
        } as MoneyFlowRecord,
        {
          type: "GOOD" as const,
          tick: 1,
          phase: 0,
          reason: "TEST",
          goodId: "A_GOOD",
          holderType: "cohort" as const,
          holderKey: "COHORT_1" as any,
          bucket: "household" as const,
          delta: -3,
        } as GoodFlowRecord,
      ];

      for (const record of records) {
        ledger = addLedgerRecord(ledger, record);
      }

      const projection = projectM2DiagnosticTick(ledger, null);

      // Should be sorted: GOOD (phase 0, key A), GOOD (phase 1, key B), MONEY (phase 0)
      expect(projection.flowSummaries[0]!.category).toBe("GOOD");
      expect(projection.flowSummaries[0]!.phase).toBe(0);
      expect(projection.flowSummaries[1]!.category).toBe("GOOD");
      expect(projection.flowSummaries[1]!.phase).toBe(1);
      expect(projection.flowSummaries[2]!.category).toBe("MONEY");
    });
  });

  describe("Run aggregation", () => {
    it("aggregates empty tick projections", () => {
      const projections: M2DiagnosticTickProjection[] = [
        projectM2DiagnosticTick(createEmptyTickLedger(0), null),
        projectM2DiagnosticTick(createEmptyTickLedger(1), null),
        projectM2DiagnosticTick(createEmptyTickLedger(2), null),
      ];

      const runSummary = aggregateM2DiagnosticRun(projections);

      expect(runSummary.firstTick).toBe(0);
      expect(runSummary.lastTick).toBe(2);
      expect(runSummary.tickCount).toBe(3);
      expect(runSummary.totalRecordCount).toBe(0);
      expect(runSummary.reconciliationPassCount).toBe(3);
      expect(runSummary.reconciliationFailCount).toBe(0);
      expect(runSummary.failedTicks).toHaveLength(0);
    });

    it("tracks reconciliation failures in run summary", () => {
      let ledger0 = createEmptyTickLedger(0);
      let ledger1 = createEmptyTickLedger(1);

      const moneyRecord: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 0,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 100,
      };

      ledger1 = addLedgerRecord(ledger1, moneyRecord);

      const proj0 = projectM2DiagnosticTick(ledger0, null);
      const proj1 = projectM2DiagnosticTick(ledger1, [{ category: "MONEY", residual: 100 }]);

      const runSummary = aggregateM2DiagnosticRun([proj0, proj1]);

      expect(runSummary.tickCount).toBe(2);
      expect(runSummary.reconciliationPassCount).toBe(1);
      expect(runSummary.reconciliationFailCount).toBe(1);
      expect(runSummary.failedTicks).toHaveLength(1);
      expect(runSummary.failedTicks[0]!.tick).toBe(1);
    });

    it("accumulates record counts across ticks", () => {
      let ledger0 = createEmptyTickLedger(0);
      let ledger1 = createEmptyTickLedger(1);

      const record1: MoneyFlowRecord = {
        type: "MONEY",
        tick: 0,
        phase: 0,
        reason: "TEST",
        currencyId: "USD" as any,
        ownerType: "state",
        ownerKey: "STATE_1" as any,
        delta: 100,
      };

      const record2: GoodFlowRecord = {
        type: "GOOD",
        tick: 1,
        phase: 0,
        reason: "TEST",
        goodId: "WHEAT",
        holderType: "cohort",
        holderKey: "COHORT_1" as any,
        bucket: "household",
        delta: -25,
      };

      ledger0 = addLedgerRecord(ledger0, record1);
      ledger1 = addLedgerRecord(ledger1, record2);

      const proj0 = projectM2DiagnosticTick(ledger0, null);
      const proj1 = projectM2DiagnosticTick(ledger1, null);

      const runSummary = aggregateM2DiagnosticRun([proj0, proj1]);

      expect(runSummary.totalRecordCount).toBe(2);
    });
  });
});
