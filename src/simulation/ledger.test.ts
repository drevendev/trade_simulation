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
} from "./ledger";
import type { CurrencyId } from "../domain/id";

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
    it("passes for balanced transfers (zero total flow per category)", () => {
      let ledger = createEmptyTickLedger(1);

      const debit: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-1",
        delta: -100,
        reason: "test",
      };

      const credit: MoneyFlowRecord = {
        type: "MONEY",
        tick: 1,
        phase: 5,
        currencyId: "currency-1" as CurrencyId,
        ownerType: "state",
        ownerKey: "state-2",
        delta: 100,
        reason: "test",
      };

      ledger = addLedgerRecord(ledger, debit);
      ledger = addLedgerRecord(ledger, credit);

      const result = validateZeroFlowReconciliation(ledger);

      expect(result).toBeNull();
    });

    it("fails for unmatched flow (non-zero category total)", () => {
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
      expect(result?.[0]?.residual).toBe(100);
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
  });
});
