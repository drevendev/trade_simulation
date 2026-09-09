/**
 * Tests for M2 typed ledger records and reconciliation (REQ-CORE-006).
 */

import {
  createEmptyTickLedger,
  addLedgerRecord,
  computeNetFlow,
  validateZeroFlowReconciliation,
  type MoneyFlowRecord,
  type GoodFlowRecord,
  type PhysicalLossRecord,
} from "./ledger";
import type { CurrencyId, RegionId } from "../domain/id";

describe("ledger", () => {
  describe("createEmptyTickLedger", () => {
    it("creates a ledger with empty records", () => {
      const ledger = createEmptyTickLedger(42);
      expect(ledger.tick).toBe(42);
      expect(ledger.records).toEqual([]);
    });
  });

  describe("addLedgerRecord", () => {
    it("adds a money flow record to a ledger", () => {
      const ledger = createEmptyTickLedger(1);
      const record: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: 100,
        reason: "wage payment",
      };

      const updated = addLedgerRecord(ledger, record);

      expect(updated.records).toHaveLength(1);
      expect(updated.records[0]).toEqual(record);
    });

    it("accumulates multiple records", () => {
      let ledger = createEmptyTickLedger(1);

      const record1: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: 100,
        reason: "wage",
      };

      const record2: GoodFlowRecord = {
        type: "GOOD",
        tick: 1,
        phase: 6,
        goodId: "wheat",
        holderType: "cohort",
        holderKey: "cohort-1",
        bucket: "household",
        delta: -50,
        reason: "consumption",
      };

      ledger = addLedgerRecord(ledger, record1);
      ledger = addLedgerRecord(ledger, record2);

      expect(ledger.records).toHaveLength(2);
    });
  });

  describe("computeNetFlow", () => {
    it("computes zero net flow for balanced money transfers", () => {
      let ledger = createEmptyTickLedger(1);

      // Debit state-1, credit state-2
      const debit: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 10,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: -100,
        reason: "tax transfer",
      };

      const credit: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 10,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-2",
        delta: 100,
        reason: "tax transfer",
      };

      ledger = addLedgerRecord(ledger, debit);
      ledger = addLedgerRecord(ledger, credit);

      const flows = computeNetFlow(ledger, "MONEY");

      expect(flows.get("currency-1:state:state-1")).toBe(-100);
      expect(flows.get("currency-1:state:state-2")).toBe(100);
    });

    it("returns empty map for no matching records", () => {
      let ledger = createEmptyTickLedger(1);

      const record: GoodFlowRecord = {
        type: "GOOD",
        tick: 1,
        phase: 6,
        goodId: "wheat",
        holderType: "cohort",
        holderKey: "cohort-1",
        bucket: "household",
        delta: -50,
        reason: "consumption",
      };

      ledger = addLedgerRecord(ledger, record);
      const flows = computeNetFlow(ledger, "MONEY");

      expect(flows.size).toBe(0);
    });
  });

  describe("validateZeroFlowReconciliation", () => {
    it("passes when all stock keys balance independently", () => {
      let ledger = createEmptyTickLedger(1);

      // state-1 receives and sends equal amounts within its own key (balanced)
      const receive: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: 100,
        reason: "receive",
      };

      const send: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: -100,
        reason: "send",
      };

      ledger = addLedgerRecord(ledger, receive);
      ledger = addLedgerRecord(ledger, send);

      const result = validateZeroFlowReconciliation(ledger);

      // Both flows are for the same key and sum to zero
      expect(result).toBeNull();
    });

    it("detects unmatched flow in a specific stock key", () => {
      let ledger = createEmptyTickLedger(1);

      const unmatched: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: 100,
        reason: "test",
      };

      ledger = addLedgerRecord(ledger, unmatched);

      const result = validateZeroFlowReconciliation(ledger);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result?.[0]?.category).toBe("MONEY");
      expect(result?.[0]?.key).toBe("currency-1:state:state-1");
      expect(result?.[0]?.residual).toBe(100);
    });

    it("detects mismatches in different keys as separate errors", () => {
      let ledger = createEmptyTickLedger(1);

      // state-1 unmatched in currency-1
      const r1: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: 100,
        reason: "test",
      };

      // state-2 unmatched in currency-2
      const r2: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-2" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-2",
        delta: 50,
        reason: "test",
      };

      ledger = addLedgerRecord(ledger, r1);
      ledger = addLedgerRecord(ledger, r2);

      const result = validateZeroFlowReconciliation(ledger);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result?.[0]?.key).toBe("currency-1:state:state-1");
      expect(result?.[0]?.residual).toBe(100);
      expect(result?.[1]?.key).toBe("currency-2:state:state-2");
      expect(result?.[1]?.residual).toBe(50);
    });

    it("respects tolerance for small residuals", () => {
      let ledger = createEmptyTickLedger(1);

      const tiny: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: 1e-10,
        reason: "test",
      };

      ledger = addLedgerRecord(ledger, tiny);

      // Default tolerance is 1e-9, so 1e-10 should pass
      const result = validateZeroFlowReconciliation(ledger);

      expect(result).toBeNull();
    });

    it("fails for residuals beyond tolerance", () => {
      let ledger = createEmptyTickLedger(1);

      const residual: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: 1e-8,
        reason: "test",
      };

      ledger = addLedgerRecord(ledger, residual);

      // Default tolerance is 1e-9, so 1e-8 should fail
      const result = validateZeroFlowReconciliation(ledger);

      expect(result).not.toBeNull();
      expect(result?.[0]?.residual).toBe(1e-8);
    });

    it("excludes PHYSICAL_LOSS from zero-sum validation (one-sided sink)", () => {
      let ledger = createEmptyTickLedger(1);

      const loss: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 15,
        resourceType: "good",
        resourceId: "wheat",
        locationKey: "region-1" as RegionId,
        amount: 100, // Non-zero loss
        reason: "spoilage",
        cause: "spoilage",
      };

      ledger = addLedgerRecord(ledger, loss);

      const result = validateZeroFlowReconciliation(ledger);

      // Non-zero PHYSICAL_LOSS must not fail zero-flow reconciliation
      expect(result).toBeNull();
    });

    it("permits non-zero PHYSICAL_LOSS with balanced GOOD transfers in same key", () => {
      let ledger = createEmptyTickLedger(1);

      // Both GOOD flows for the same holder (same key) - they balance
      const good1: GoodFlowRecord = {
        type: "GOOD",
        tick: 1,
        phase: 8,
        goodId: "wheat",
        holderType: "cohort",
        holderKey: "cohort-1",
        bucket: "household",
        delta: -100,
        reason: "consume",
      };

      const good2: GoodFlowRecord = {
        type: "GOOD",
        tick: 1,
        phase: 8,
        goodId: "wheat",
        holderType: "cohort",
        holderKey: "cohort-1",
        bucket: "household",
        delta: 100,
        reason: "receive",
      };

      const loss: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 15,
        resourceType: "good",
        resourceId: "wheat",
        locationKey: "region-1" as RegionId,
        amount: 50, // Non-zero spoilage (one-sided sink)
        reason: "storage spoilage",
        cause: "spoilage",
      };

      ledger = addLedgerRecord(ledger, good1);
      ledger = addLedgerRecord(ledger, good2);
      ledger = addLedgerRecord(ledger, loss);

      const result = validateZeroFlowReconciliation(ledger);

      // Goods for same key balance to zero, PHYSICAL_LOSS excluded from zero-sum
      expect(result).toBeNull();
    });
  });
});
