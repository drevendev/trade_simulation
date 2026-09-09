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
    it("computes zero net flow for balanced money transfers between different owners", () => {
      let ledger = createEmptyTickLedger(1);

      // Debit state-1, credit state-2 (different owners, same currency)
      // Keys should be just currencyId, not owner-inclusive
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

      // Single key for the currency: transfers between different owners cancel out
      expect(flows.get("currency-1")).toBe(0);
      expect(flows.size).toBe(1);
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
    it("passes when equal-and-opposite transfers between different owners balance at currency level", () => {
      let ledger = createEmptyTickLedger(1);

      // state-1 sends, state-2 receives (different owners, same currency)
      // Flows balance at the currency level, not at the owner level
      const send: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: -100,
        reason: "transfer",
      };

      const receive: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-2",
        delta: 100,
        reason: "transfer",
      };

      ledger = addLedgerRecord(ledger, send);
      ledger = addLedgerRecord(ledger, receive);

      const result = validateZeroFlowReconciliation(ledger);

      // Key "currency-1" nets to 0: transfer between different owners balances
      expect(result).toBeNull();
    });

    it("detects unmatched flow in a specific currency", () => {
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
      expect(result?.[0]?.key).toBe("currency-1");
      expect(result?.[0]?.residual).toBe(100);
    });

    it("detects mismatches in different currencies as separate errors", () => {
      let ledger = createEmptyTickLedger(1);

      // Unmatched in currency-1 (from any owner)
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

      // Unmatched in currency-2 (from any owner, different currency)
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
      expect(result?.[0]?.key).toBe("currency-1");
      expect(result?.[0]?.residual).toBe(100);
      expect(result?.[1]?.key).toBe("currency-2");
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

    it("permits non-zero PHYSICAL_LOSS with balanced GOOD transfers at good-level key", () => {
      let ledger = createEmptyTickLedger(1);

      // GOOD flows between different holders for same good - balance at good-level key
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
        holderKey: "cohort-2",
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

      // Key "wheat" nets to 0: transfer between different holders balances
      // PHYSICAL_LOSS excluded from zero-sum validation
      expect(result).toBeNull();
    });

    it("rejects PHYSICAL_LOSS with NaN amount", () => {
      let ledger = createEmptyTickLedger(1);

      const invalidLoss: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 15,
        resourceType: "good",
        resourceId: "wheat",
        locationKey: "region-1" as RegionId,
        amount: NaN,
        reason: "invalid",
        cause: "spoilage",
      };

      expect(() => {
        addLedgerRecord(ledger, invalidLoss);
      }).toThrow("PHYSICAL_LOSS amount must be finite");
    });

    it("rejects PHYSICAL_LOSS with Infinity amount", () => {
      let ledger = createEmptyTickLedger(1);

      const invalidLoss: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 15,
        resourceType: "good",
        resourceId: "wheat",
        locationKey: "region-1" as RegionId,
        amount: Infinity,
        reason: "invalid",
        cause: "spoilage",
      };

      expect(() => {
        addLedgerRecord(ledger, invalidLoss);
      }).toThrow("PHYSICAL_LOSS amount must be finite");
    });

    it("rejects PHYSICAL_LOSS with negative amount", () => {
      let ledger = createEmptyTickLedger(1);

      const invalidLoss: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 15,
        resourceType: "good",
        resourceId: "wheat",
        locationKey: "region-1" as RegionId,
        amount: -50,
        reason: "invalid",
        cause: "spoilage",
      };

      expect(() => {
        addLedgerRecord(ledger, invalidLoss);
      }).toThrow("PHYSICAL_LOSS amount must be non-negative");
    });

    it("accepts valid PHYSICAL_LOSS with positive finite amount", () => {
      let ledger = createEmptyTickLedger(1);

      const validLoss: PhysicalLossRecord = {
        type: "PHYSICAL_LOSS",
        tick: 1,
        phase: 15,
        resourceType: "good",
        resourceId: "wheat",
        locationKey: "region-1" as RegionId,
        amount: 100,
        reason: "spoilage",
        cause: "spoilage",
      };

      const updated = addLedgerRecord(ledger, validLoss);

      expect(updated.records).toHaveLength(1);
      expect(updated.records[0]).toEqual(validLoss);
    });
  });
});
