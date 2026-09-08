/**
 * Tests for atomic market settlement and transaction schemas (REQ-MARKET-004).
 *
 * Covers:
 * 1. MARKET_SALE transaction schema with all required fields
 * 2. CONSUMPTION_TAX transaction schema with all required fields
 * 3. Tax calculation with collectionEfficiency (only collected tax is transacted)
 * 4. Bundled paired transactions with identical bundleId
 * 5. Transaction pairing and causal linkage (originatingTransactionId)
 * 6. Preflight validation and atomic settlement
 * 7. Zero-tax settlement (no CONSUMPTION_TAX transaction created)
 * 8. Stable bundle ID creation from semantic inputs
 */

import { describe, it, expect } from "vitest";
import type {
  ClanId,
  CurrencyId,
  GoodId,
  MarketId,
  ProductionUnitId,
  RegionId,
  StateId,
} from "../domain/id";
import {
  createMarketAllocationId,
  type MarketAllocation,
} from "./marketClearing";
import { createMarketIntentId } from "./marketIntent";
import {
  computeConsumptionTax,
  preflightMarketSettlement,
  createMarketSaleTransaction,
  createConsumptionTaxTransaction,
  executeMarketSettlement,
  type TaxPolicyProvider,
  type MarketSettlementBundle,
} from "./marketSettlement";

// Test ID allocators
const testClanId = "c:test-clan" as ClanId;
const testStateId = "s:test-state" as StateId;
const testProductionUnitId = "pu:test-pu" as ProductionUnitId;
const testRegionId = "r:test-region" as RegionId;
const testGoodId = "good:wheat" as GoodId;
const testCurrencyId = "cur:gold" as CurrencyId;
const testMarketId = "m:central" as MarketId;

// Mock tax policy provider for testing
function createMockTaxPolicy(
  overrides: Partial<TaxPolicyProvider> = {},
): TaxPolicyProvider {
  return {
    getConsumptionTaxRate: (stateId: StateId | null, _goodId: string): number => {
      return stateId === null ? 0 : 0.1; // 10% consumption tax for controlled regions
    },
    getCollectionEfficiency: (stateId: StateId | null): number => {
      return stateId === null ? 0 : 0.8; // 80% collection efficiency
    },
    ...overrides,
  };
}

function createTestAllocation(
  overrides: Partial<MarketAllocation> = {},
): MarketAllocation {
  return {
    id: createMarketAllocationId("ma:test-1"),
    marketId: testMarketId,
    regionId: testRegionId,
    goodId: testGoodId,
    pass: "MAIN",
    sellerIntentId: createMarketIntentId("mi:seller-1"),
    buyerIntentId: createMarketIntentId("mi:buyer-1"),
    seller: { type: "CLAN", clanId: testClanId },
    buyer: { type: "CLAN", clanId: testClanId },
    quantity: 100,
    sellerNetUnitPrice: 10,
    buyerGrossUnitPrice: 11,
    marketCurrencyId: testCurrencyId,
    consumptionTaxAmount: 100,
    destinationStateId: testStateId,
    sellerInventoryBucket: "GENERAL",
    buyerInventoryBucket: "GENERAL",
    ...overrides,
  };
}

describe("Market settlement transaction schemas (REQ-MARKET-004)", () => {
  describe("consumeConsumptionTax", () => {
    it("computes tax with collection efficiency < 1", () => {
      const taxPolicy = createMockTaxPolicy();
      const result = computeConsumptionTax(testStateId, testGoodId, 1000, taxPolicy);

      expect(result.assessedTaxRate).toBe(0.1);
      expect(result.collectionEfficiency).toBe(0.8);
      expect(result.assessedTaxPerUnit).toBe(100); // 1000 × 0.1
      expect(result.collectedTaxAmount).toBe(80); // 100 × 0.8
    });

    it("computes zero tax for uncontrolled region", () => {
      const taxPolicy = createMockTaxPolicy();
      const result = computeConsumptionTax(null, testGoodId, 1000, taxPolicy);

      expect(result.assessedTaxRate).toBe(0);
      expect(result.collectionEfficiency).toBe(0);
      expect(result.collectedTaxAmount).toBe(0);
    });

    it("computes full collection with efficiency = 1", () => {
      const taxPolicy = createMockTaxPolicy({
        getCollectionEfficiency: () => 1,
      });
      const result = computeConsumptionTax(testStateId, testGoodId, 1000, taxPolicy);

      expect(result.collectedTaxAmount).toBe(100); // Full assessed tax collected
    });

    it("rejects invalid collection efficiency > 1", () => {
      const taxPolicy = createMockTaxPolicy({
        getCollectionEfficiency: () => 1.5,
      });

      expect(() => {
        computeConsumptionTax(testStateId, testGoodId, 1000, taxPolicy);
      }).toThrow("collectionEfficiency must be in [0, 1]");
    });

    it("rejects invalid tax rate > 1", () => {
      const taxPolicy = createMockTaxPolicy({
        getConsumptionTaxRate: () => 1.5,
      });

      expect(() => {
        computeConsumptionTax(testStateId, testGoodId, 1000, taxPolicy);
      }).toThrow("assessedTaxRate must be in [0, 1]");
    });
  });

  describe("preflightMarketSettlement", () => {
    it("passes valid allocation", () => {
      const allocation = createTestAllocation();
      const error = preflightMarketSettlement(allocation, 5, 8);

      expect(error).toBeNull();
    });

    it("rejects negative quantity", () => {
      const allocation = createTestAllocation({ quantity: -10 });
      const error = preflightMarketSettlement(allocation, 5, 8);

      expect(error).toMatch(/quantity must be >= 0/);
    });

    it("rejects negative sellerNetUnitPrice", () => {
      const allocation = createTestAllocation({ sellerNetUnitPrice: -5 });
      const error = preflightMarketSettlement(allocation, 5, 8);

      expect(error).toMatch(/sellerNetUnitPrice must be >= 0/);
    });

    it("rejects negative buyerGrossUnitPrice", () => {
      const allocation = createTestAllocation({ buyerGrossUnitPrice: -5 });
      const error = preflightMarketSettlement(allocation, 5, 8);

      expect(error).toMatch(/buyerGrossUnitPrice must be >= 0/);
    });

    it("rejects negative consumptionTaxAmount", () => {
      const allocation = createTestAllocation({ consumptionTaxAmount: -10 });
      const error = preflightMarketSettlement(allocation, 5, 8);

      expect(error).toMatch(/consumptionTaxAmount must be >= 0/);
    });

    it("rejects when buyer debit < seller net + tax", () => {
      // quantity=100, sellerNetUnitPrice=10, buyerGrossUnitPrice=11, tax=50
      // seller net = 1000, buyer debit = 1100, required = 1050 ✓
      // But if buyerGrossUnitPrice too low: buyer debit < 1050
      const allocation = createTestAllocation({
        quantity: 100,
        sellerNetUnitPrice: 10,
        buyerGrossUnitPrice: 10.4, // debit = 1040, required = 1050
        consumptionTaxAmount: 50,
      });
      const error = preflightMarketSettlement(allocation, 5, 8);

      expect(error).toMatch(/Buyer debit.*must be >=/);
    });
  });

  describe("createMarketSaleTransaction", () => {
    it("creates MARKET_SALE with all required fields", () => {
      const allocation = createTestAllocation();
      const bundleId = "tb:test-bundle" as any;
      const counter = { value: 0 };

      const tx = createMarketSaleTransaction(allocation, bundleId, 5, 8, counter);

      expect(tx.type).toBe("MARKET_SALE");
      expect(tx.tick).toBe(5);
      expect(tx.phase).toBe(8);
      expect(tx.transactionId).toBeDefined();
      expect(tx.transactionId).toMatch(/^tx:/);
      expect(tx.bundleId).toBe(bundleId);
      expect(tx.source).toEqual(allocation.buyer);
      expect(tx.destination).toEqual(allocation.seller);
      expect(tx.goodId).toBe(testGoodId);
      expect(tx.quantity).toBe(100);
      expect(tx.currencyId).toBe(testCurrencyId);
      expect(tx.unitPrice).toBe(10); // sellerNetUnitPrice
      expect(tx.moneyAmount).toBe(1000); // quantity × sellerNetUnitPrice
      expect(tx.sourceRegionId).toBe(testRegionId);
      expect(tx.destinationRegionId).toBe(testRegionId);
      expect(tx.amount).toBe(1000); // seller net value
    });

    it("increments transaction ID counter", () => {
      const allocation = createTestAllocation();
      const bundleId = "tb:test-bundle" as any;
      const counter = { value: 0 };

      const tx1 = createMarketSaleTransaction(allocation, bundleId, 5, 8, counter);
      const tx2 = createMarketSaleTransaction(allocation, bundleId, 5, 8, counter);

      expect(counter.value).toBe(2);
      expect(tx1.transactionId).not.toBe(tx2.transactionId);
    });

    it("correctly computes seller net value", () => {
      const allocation = createTestAllocation({
        quantity: 50,
        sellerNetUnitPrice: 25,
      });
      const bundleId = "tb:test-bundle" as any;
      const counter = { value: 0 };

      const tx = createMarketSaleTransaction(allocation, bundleId, 5, 8, counter);

      expect(tx.moneyAmount).toBe(1250); // 50 × 25
      expect(tx.amount).toBe(1250);
    });
  });

  describe("createConsumptionTaxTransaction", () => {
    it("creates CONSUMPTION_TAX when tax amount > 0", () => {
      const allocation = createTestAllocation({ consumptionTaxAmount: 100 });
      const marketSaleId = "tx:5:8:market-sale:0" as any;
      const bundleId = "tb:test-bundle" as any;
      const counter = { value: 0 };

      const tx = createConsumptionTaxTransaction(
        allocation,
        marketSaleId,
        bundleId,
        5,
        8,
        counter,
      );

      expect(tx).not.toBeNull();
      expect(tx!.type).toBe("CONSUMPTION_TAX");
      expect(tx!.tick).toBe(5);
      expect(tx!.phase).toBe(8);
      expect(tx!.transactionId).toBeDefined();
      expect(tx!.bundleId).toBe(bundleId);
      expect(tx!.originatingTransactionId).toBe(marketSaleId);
      expect(tx!.source).toEqual(allocation.buyer);
      expect(tx!.destination).toEqual({
        type: "STATE",
        stateId: testStateId,
      });
      expect(tx!.currencyId).toBe(testCurrencyId);
      expect(tx!.moneyAmount).toBe(100);
      expect(tx!.taxAmount).toBe(100);
      expect(tx!.amount).toBe(100);
    });

    it("returns null when tax amount = 0", () => {
      const allocation = createTestAllocation({ consumptionTaxAmount: 0 });
      const marketSaleId = "tx:5:8:market-sale:0" as any;
      const bundleId = "tb:test-bundle" as any;
      const counter = { value: 0 };

      const tx = createConsumptionTaxTransaction(
        allocation,
        marketSaleId,
        bundleId,
        5,
        8,
        counter,
      );

      expect(tx).toBeNull();
    });

    it("returns null when no destination state", () => {
      const allocation = createTestAllocation({
        consumptionTaxAmount: 100,
        destinationStateId: null,
      });
      const marketSaleId = "tx:5:8:market-sale:0" as any;
      const bundleId = "tb:test-bundle" as any;
      const counter = { value: 0 };

      const tx = createConsumptionTaxTransaction(
        allocation,
        marketSaleId,
        bundleId,
        5,
        8,
        counter,
      );

      expect(tx).toBeNull();
    });
  });

  describe("executeMarketSettlement", () => {
    it("executes settlement with both transactions", () => {
      const allocation = createTestAllocation();
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      expect(bundle.bundleId).toBeDefined();
      expect(bundle.marketSaleTransaction).toBeDefined();
      expect(bundle.consumptionTaxTransaction).toBeDefined();
    });

    it("pairs transactions with identical bundleId", () => {
      const allocation = createTestAllocation();
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      expect(bundle.marketSaleTransaction.bundleId).toBe(bundle.bundleId);
      expect(bundle.consumptionTaxTransaction?.bundleId).toBe(bundle.bundleId);
    });

    it("links tax transaction to MARKET_SALE via originatingTransactionId", () => {
      const allocation = createTestAllocation();
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      expect(bundle.consumptionTaxTransaction?.originatingTransactionId).toBe(
        bundle.marketSaleTransaction.transactionId,
      );
    });

    it("throws on preflight validation failure", () => {
      const allocation = createTestAllocation({
        quantity: -10, // Invalid
      });
      const counter = { value: 0 };

      expect(() => {
        executeMarketSettlement(allocation, 5, 8, counter);
      }).toThrow("preflight failed");
    });

    it("creates stable bundleId from semantic inputs", () => {
      const allocation = createTestAllocation();
      const counter1 = { value: 0 };
      const counter2 = { value: 100 };

      const bundle1 = executeMarketSettlement(allocation, 5, 8, counter1);
      const bundle2 = executeMarketSettlement(allocation, 5, 8, counter2);

      expect(bundle1.bundleId).toBe(bundle2.bundleId);
    });

    it("creates different bundleId for different allocations", () => {
      const allocation1 = createTestAllocation({
        sellerIntentId: createMarketIntentId("mi:seller-1"),
      });
      const allocation2 = createTestAllocation({
        sellerIntentId: createMarketIntentId("mi:seller-2"),
      });
      const counter = { value: 0 };

      const bundle1 = executeMarketSettlement(allocation1, 5, 8, counter);
      const bundle2 = executeMarketSettlement(allocation2, 5, 8, counter);

      expect(bundle1.bundleId).not.toBe(bundle2.bundleId);
    });

    it("omits CONSUMPTION_TAX when tax = 0", () => {
      const allocation = createTestAllocation({ consumptionTaxAmount: 0 });
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      expect(bundle.marketSaleTransaction).toBeDefined();
      expect(bundle.consumptionTaxTransaction).toBeNull();
    });

    it("correctly handles partial collection efficiency", () => {
      // Test case MTFX-T4: fixture with 0 < collectionEfficiency < 1
      // proves only collected tax is debited/credited
      const allocation = createTestAllocation({
        quantity: 100,
        sellerNetUnitPrice: 100,
        buyerGrossUnitPrice: 112, // Must include 10% tax with 80% collection
        consumptionTaxAmount: 80, // Only collected portion (100 × 0.1 × 0.8)
        destinationStateId: testStateId,
      });
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      // MARKET_SALE: buyer pays gross (seller net + collected tax)
      expect(bundle.marketSaleTransaction.quantity).toBe(100);
      expect(bundle.marketSaleTransaction.unitPrice).toBe(100);
      expect(bundle.marketSaleTransaction.amount).toBe(10000);

      // CONSUMPTION_TAX: only collected portion transferred to state
      expect(bundle.consumptionTaxTransaction?.moneyAmount).toBe(80);
      expect(bundle.consumptionTaxTransaction?.taxAmount).toBe(80);

      // Buyer debit = 100 × 112 = 11200
      // Seller net receipt = 10000
      // Collected tax = 80
      // Assessed but uncollected = 20 (100 × 0.1 × 0.2) remains with buyer
    });

    it("handles ProductionUnit actors correctly", () => {
      const allocation = createTestAllocation({
        seller: {
          type: "PRODUCTION_UNIT",
          productionUnitId: testProductionUnitId,
        },
      });
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      expect(bundle.marketSaleTransaction.destination).toEqual({
        type: "PRODUCTION_UNIT",
        productionUnitId: testProductionUnitId,
      });
    });

    it("handles uncontrolled region (null state) correctly", () => {
      const allocation = createTestAllocation({
        consumptionTaxAmount: 0,
        destinationStateId: null,
      });
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      expect(bundle.marketSaleTransaction).toBeDefined();
      expect(bundle.consumptionTaxTransaction).toBeNull();
    });

    it("records proper source/destination for trade", () => {
      const sellerClan = { type: "CLAN" as const, clanId: "c:seller" as ClanId };
      const buyerState = { type: "STATE" as const, stateId: testStateId };

      const allocation = createTestAllocation({
        seller: sellerClan,
        buyer: buyerState,
      });
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      // source = buyer (who pays)
      expect(bundle.marketSaleTransaction.source).toEqual(buyerState);
      // destination = seller (who receives payment)
      expect(bundle.marketSaleTransaction.destination).toEqual(sellerClan);
    });
  });

  describe("MTFX transaction accounting invariants", () => {
    it("MTFX-I1: seller inventory decrease == buyer inventory increase", () => {
      // Test validates that allocation quantity field is preserved in transaction
      const allocation = createTestAllocation();
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      expect(bundle.marketSaleTransaction.quantity).toBe(allocation.quantity);
    });

    it("MTFX-I2: buyer gross debit == seller net receipt + collected consumption tax", () => {
      const allocation = createTestAllocation({
        quantity: 100,
        sellerNetUnitPrice: 10,
        buyerGrossUnitPrice: 11,
        consumptionTaxAmount: 100,
      });
      const counter = { value: 0 };

      const bundle = executeMarketSettlement(allocation, 5, 8, counter);

      const sellerNetReceipt = bundle.marketSaleTransaction.moneyAmount!;
      const collectedTax = bundle.consumptionTaxTransaction?.moneyAmount ?? 0;
      const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;

      expect(buyerGrossDebit).toBe(sellerNetReceipt + collectedTax);
    });
  });
});
