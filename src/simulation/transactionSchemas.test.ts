/**
 * Tests for transaction schemas (REQ-MARKET-004).
 *
 * Verifies MARKET_SALE and CONSUMPTION_TAX transaction construction, bundling,
 * tax calculation, and compliance with spec section 12 requirements.
 */

import { describe, it, expect } from "vitest";
import type {
  CurrencyId,
  GoodId,
  RegionId,
  StateId,
  TransactionId,
  TransactionBundleId,
} from "../domain/id";
import type { ActorRef } from "../domain/genesisLedger";
import {
  createMarketSaleTransaction,
  createConsumptionTaxTransaction,
  validateMarketSaleTransaction,
  validateConsumptionTaxTransaction,
} from "./transactionSchemas";

// Test fixtures
const testClan: ActorRef = { type: "CLAN", clanId: "c:1" as any };
const testState: ActorRef = { type: "STATE", stateId: "s:1" as any };
const testRegion: RegionId = "r:1" as any;
const testCurrency: CurrencyId = "cur:1" as any;
const testGood: GoodId = "good:1" as any;
const testStateId: StateId = "s:1" as any;

describe("Transaction Schemas (REQ-MARKET-004)", () => {
  describe("MARKET_SALE transaction creation", () => {
    it("creates a valid MARKET_SALE transaction with all required fields", () => {
      const txId = "tx:1" as TransactionId;
      const bundleId = "tb:1" as TransactionBundleId;

      const tx = createMarketSaleTransaction({
        transactionId: txId,
        bundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 100,
        sellerNetUnitPrice: 5.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      expect(tx.type).toBe("MARKET_SALE");
      expect(tx.transactionId).toBe(txId);
      expect(tx.bundleId).toBe(bundleId);
      expect(tx.tick).toBe(1);
      expect(tx.phase).toBe(8);
      expect(tx.source).toBe(testClan);
      expect(tx.destination).toBe(testState);
      expect(tx.goodId).toBe(testGood);
      expect(tx.currencyId).toBe(testCurrency);
      expect(tx.unitPrice).toBe(5.0);
      expect(tx.amount).toBe(500); // 100 * 5.0
    });

    it("calculates money amount as quantity × seller net unit price", () => {
      const tx = createMarketSaleTransaction({
        transactionId: "tx:2" as TransactionId,
        bundleId: "tb:2" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 50,
        sellerNetUnitPrice: 2.5,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      expect(tx.amount).toBe(125); // 50 * 2.5
    });

    it("handles fractional quantities and prices", () => {
      const tx = createMarketSaleTransaction({
        transactionId: "tx:3" as TransactionId,
        bundleId: "tb:3" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 33.333,
        sellerNetUnitPrice: 3.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      expect(tx.amount).toBeCloseTo(99.999, 3);
    });

    it("validates correctly formatted MARKET_SALE transaction", () => {
      const tx = createMarketSaleTransaction({
        transactionId: "tx:4" as TransactionId,
        bundleId: "tb:4" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 10,
        sellerNetUnitPrice: 1.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      const errors = validateMarketSaleTransaction(tx);
      expect(errors).toHaveLength(0);
    });
  });

  describe("CONSUMPTION_TAX transaction creation", () => {
    it("creates a paired CONSUMPTION_TAX transaction with MARKET_SALE linkage", () => {
      const salesTxId = "tx:100" as TransactionId;
      const bundleId = "tb:50" as TransactionBundleId;
      const taxTxId = "tx:101" as TransactionId;

      const taxTx = createConsumptionTaxTransaction({
        transactionId: taxTxId,
        bundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: 50,
        originatingMarketSaleId: salesTxId,
      });

      expect(taxTx).not.toBeNull();
      expect(taxTx!.type).toBe("CONSUMPTION_TAX");
      expect(taxTx!.transactionId).toBe(taxTxId);
      expect(taxTx!.bundleId).toBe(bundleId);
      expect(taxTx!.source).toBe(testClan);
      expect(taxTx!.destination).toEqual({ type: "STATE", id: testStateId });
      expect(taxTx!.amount).toBe(50);
      expect(taxTx!.taxAmount).toBe(50);
      expect(taxTx!.originatingTransactionId).toBe(salesTxId);
    });

    it("uses the same bundleId as the paired MARKET_SALE transaction", () => {
      const bundleId = "tb:xyz" as TransactionBundleId;

      const saleTx = createMarketSaleTransaction({
        transactionId: "tx:200" as TransactionId,
        bundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 100,
        sellerNetUnitPrice: 10.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      const taxTx = createConsumptionTaxTransaction({
        transactionId: "tx:201" as TransactionId,
        bundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: 100,
        originatingMarketSaleId: saleTx.transactionId!,
      });

      expect(saleTx.bundleId).toBe(bundleId);
      expect(taxTx!.bundleId).toBe(bundleId);
      expect(saleTx.bundleId).toBe(taxTx!.bundleId);
    });

    it("returns null when destinationStateId is null (uncontrolled region)", () => {
      const taxTx = createConsumptionTaxTransaction({
        transactionId: "tx:301" as TransactionId,
        bundleId: "tb:301" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: null,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: 50,
        originatingMarketSaleId: "tx:300" as TransactionId,
      });

      expect(taxTx).toBeNull();
    });

    it("returns null when collectedTaxAmount is zero or negative", () => {
      const zeroTax = createConsumptionTaxTransaction({
        transactionId: "tx:401" as TransactionId,
        bundleId: "tb:401" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: 0,
        originatingMarketSaleId: "tx:400" as TransactionId,
      });

      expect(zeroTax).toBeNull();

      const negativeTax = createConsumptionTaxTransaction({
        transactionId: "tx:501" as TransactionId,
        bundleId: "tb:501" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: -10,
        originatingMarketSaleId: "tx:500" as TransactionId,
      });

      expect(negativeTax).toBeNull();
    });

    it("validates correctly formatted CONSUMPTION_TAX transaction", () => {
      const taxTx = createConsumptionTaxTransaction({
        transactionId: "tx:601" as TransactionId,
        bundleId: "tb:601" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: 75,
        originatingMarketSaleId: "tx:600" as TransactionId,
      });

      const errors = validateConsumptionTaxTransaction(taxTx!);
      expect(errors).toHaveLength(0);
    });
  });

  describe("Tax calculation with collectionEfficiency", () => {
    it("correctly applies collectionEfficiency to calculate collected tax", () => {
      // Sale value = 1000 (100 units × 10 per unit)
      // Statutory tax rate = 0.20 (20%)
      // Assessed tax = 200
      // Collection efficiency = 0.75
      // Collected tax = 200 × 0.75 = 150

      const saleTx = createMarketSaleTransaction({
        transactionId: "tx:700" as TransactionId,
        bundleId: "tb:700" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 100,
        sellerNetUnitPrice: 10.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      const collectedTax = saleTx.amount! * 0.20 * 0.75; // 1000 * 0.20 * 0.75 = 150
      const taxTx = createConsumptionTaxTransaction({
        transactionId: "tx:701" as TransactionId,
        bundleId: "tb:700" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: collectedTax,
        originatingMarketSaleId: saleTx.transactionId!,
      });

      expect(taxTx!.amount).toBe(150);
    });

    it("handles collectionEfficiency of 1.0 (full collection)", () => {
      const saleTx = createMarketSaleTransaction({
        transactionId: "tx:800" as TransactionId,
        bundleId: "tb:800" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 100,
        sellerNetUnitPrice: 20.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      const collectedTax = saleTx.amount! * 0.25 * 1.0; // 2000 * 0.25 * 1.0 = 500
      const taxTx = createConsumptionTaxTransaction({
        transactionId: "tx:801" as TransactionId,
        bundleId: "tb:800" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: collectedTax,
        originatingMarketSaleId: saleTx.transactionId!,
      });

      expect(taxTx!.amount).toBe(500);
    });

    it("handles collectionEfficiency of 0.5 (partial collection)", () => {
      const saleTx = createMarketSaleTransaction({
        transactionId: "tx:900" as TransactionId,
        bundleId: "tb:900" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 100,
        sellerNetUnitPrice: 10.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      // Assessed tax = 1000 * 0.10 = 100
      // Collection efficiency = 0.5
      // Collected tax = 100 * 0.5 = 50
      const collectedTax = saleTx.amount! * 0.10 * 0.5;
      const taxTx = createConsumptionTaxTransaction({
        transactionId: "tx:901" as TransactionId,
        bundleId: "tb:900" as TransactionBundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: collectedTax,
        originatingMarketSaleId: saleTx.transactionId!,
      });

      expect(taxTx!.amount).toBe(50);
    });
  });

  describe("Transaction validation", () => {
    it("rejects MARKET_SALE with missing required fields", () => {
      const incompleteTs: any = {
        type: "MARKET_SALE",
        tick: 1,
        phase: 8,
        // Missing transactionId, bundleId, source, destination, goodId, etc.
      };

      const errors = validateMarketSaleTransaction(incompleteTs);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("transactionId"))).toBe(true);
    });

    it("rejects CONSUMPTION_TAX with wrong destination format", () => {
      const badTax: any = {
        type: "CONSUMPTION_TAX",
        transactionId: "tx:1000" as TransactionId,
        bundleId: "tb:1000" as TransactionBundleId,
        source: testClan,
        destination: testState, // Should be {type:'STATE', id: StateId}, not an ActorRef
        tick: 1,
        phase: 8,
      };

      const errors = validateConsumptionTaxTransaction(badTax);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("Destination"))).toBe(true);
    });

    it("detects non-finite amount values", () => {
      const badTx: any = {
        type: "MARKET_SALE",
        transactionId: "tx:1001" as TransactionId,
        bundleId: "tb:1001" as TransactionBundleId,
        source: testClan,
        destination: testState,
        goodId: testGood,
        currencyId: testCurrency,
        amount: NaN,
        unitPrice: 5.0,
      };

      const errors = validateMarketSaleTransaction(badTx);
      expect(errors.some((e) => e.includes("finite"))).toBe(true);
    });

    it("enforces required quantity and region fields on MARKET_SALE", () => {
      // Missing quantity
      const noQuantity: any = {
        type: "MARKET_SALE",
        transactionId: "tx:1002" as TransactionId,
        bundleId: "tb:1002" as TransactionBundleId,
        source: testClan,
        destination: testState,
        goodId: testGood,
        currencyId: testCurrency,
        amount: 100,
        unitPrice: 10.0,
        sourceRegionId: testRegion,
        destinationRegionId: testRegion,
      };

      let errors = validateMarketSaleTransaction(noQuantity);
      expect(errors.some((e) => e.includes("quantity"))).toBe(true);

      // Missing sourceRegionId
      const noSourceRegion: any = {
        type: "MARKET_SALE",
        transactionId: "tx:1003" as TransactionId,
        bundleId: "tb:1003" as TransactionBundleId,
        source: testClan,
        destination: testState,
        goodId: testGood,
        currencyId: testCurrency,
        amount: 100,
        unitPrice: 10.0,
        quantity: 10,
        destinationRegionId: testRegion,
      };

      errors = validateMarketSaleTransaction(noSourceRegion);
      expect(errors.some((e) => e.includes("sourceRegionId"))).toBe(true);

      // Missing destinationRegionId
      const noDestRegion: any = {
        type: "MARKET_SALE",
        transactionId: "tx:1004" as TransactionId,
        bundleId: "tb:1004" as TransactionBundleId,
        source: testClan,
        destination: testState,
        goodId: testGood,
        currencyId: testCurrency,
        amount: 100,
        unitPrice: 10.0,
        quantity: 10,
        sourceRegionId: testRegion,
      };

      errors = validateMarketSaleTransaction(noDestRegion);
      expect(errors.some((e) => e.includes("destinationRegionId"))).toBe(true);
    });
  });

  describe("Bundled transaction semantics", () => {
    it("proves paired sale and tax transactions share bundleId and phase", () => {
      const bundleId = "tb:final" as TransactionBundleId;
      const tick = 5;
      const phase = 8;

      const saleTx = createMarketSaleTransaction({
        transactionId: "tx:sale" as TransactionId,
        bundleId,
        tick,
        phase,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 200,
        sellerNetUnitPrice: 15.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      const taxTx = createConsumptionTaxTransaction({
        transactionId: "tx:tax" as TransactionId,
        bundleId,
        tick,
        phase,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: 450, // 3000 * 0.15 * 1.0
        originatingMarketSaleId: saleTx.transactionId!,
      });

      expect(saleTx.bundleId).toBe(taxTx!.bundleId);
      expect(saleTx.tick).toBe(taxTx!.tick);
      expect(saleTx.phase).toBe(taxTx!.phase);
      expect(taxTx!.originatingTransactionId).toBe(saleTx.transactionId);
    });

    it("ensures CONSUMPTION_TAX originatingTransactionId links to MARKET_SALE", () => {
      const bundleId = "tb:linked" as TransactionBundleId;
      const saleId = "tx:linked-sale" as TransactionId;
      const taxId = "tx:linked-tax" as TransactionId;

      const saleTx = createMarketSaleTransaction({
        transactionId: saleId,
        bundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        seller: testState,
        goodId: testGood,
        quantity: 50,
        sellerNetUnitPrice: 20.0,
        marketCurrencyId: testCurrency,
        marketRegionId: testRegion,
      });

      const taxTx = createConsumptionTaxTransaction({
        transactionId: taxId,
        bundleId,
        tick: 1,
        phase: 8,
        buyer: testClan,
        destinationStateId: testStateId,
        marketCurrencyId: testCurrency,
        collectedTaxAmount: 200,
        originatingMarketSaleId: saleId,
      });

      expect(taxTx!.originatingTransactionId).toBe(saleId);
      expect(taxTx!.originatingTransactionId).toBe(saleTx.transactionId);
    });
  });
});
