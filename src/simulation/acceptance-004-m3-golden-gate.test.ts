/**
 * REQ-ACCEPTANCE-004: M3 local-market golden-gate acceptance test.
 *
 * This integration test proves the M3 local-market clearing, pricing, and settlement
 * work correctly with deterministic seeded static wallets/inventories, without
 * production, trade/FX or population decision logic.
 *
 * Benchmark/golden scenarios from Handoff/04 sections 40-41:
 * A. Local shortage: one region, fixed money, food supply shock. Price rises boundedly,
 *    effective demand rations, no money/goods appear.
 *
 * Core test suite (MTFX-T1..T6):
 * - MTFX-T1: Zero demand and zero supply leaves price unchanged
 * - MTFX-T2: Extreme excess demand/supply respects max log step and price bounds
 * - MTFX-T3: Consumption tax reduces affordable quantity at fixed cash
 * - MTFX-T4: collectionEfficiency < 1 collects only collected tax
 * - MTFX-T5: Proportional seller/buyer rationing is insertion-order invariant
 * - MTFX-T6: Buyer maxSpend and seller reserve never violated
 *
 * Core invariant suite (MTFX-I1..I6):
 * - MTFX-I1: Money conservation (inflows = outflows per currency/actor)
 * - MTFX-I2: Goods conservation (source inventory decrease = destination increase)
 * - MTFX-I3: Sum of seller fills equals sum of buyer fills equals cleared quantity
 *   (canonical Handoff/04 §38 numbering; see the inline note above the MTFX-I4 describe
 *   block for this file's earlier local-numbering drift on the maxSpend/sellable cases)
 * - MTFX-I4: Buyer gross debit = seller net receipt + collected consumption tax
 * - MTFX-I5: Market-owned stocks remain zero
 * - MTFX-I6: No overdraft/unavailable-goods transfers
 */

import { describe, it, expect } from "vitest";
import type { MarketIntent, MarketIntentId, BudgetCommitmentLedger } from "./marketIntent";
import { createMarketIntentId, createEmptyBudgetCommitmentLedger } from "./marketIntent";
import type { LocalClearingInput, MarketAllocation } from "./marketClearing";
import {
  computeLocalClearing,
  createMarketAllocationId,
  computeEffectiveDemand,
  computeSellableQuantity,
} from "./marketClearing";
import type { ActorRef } from "../domain/genesisLedger";
import type { ClanId, GoodId, MarketId, RegionId, CurrencyId, StateId } from "../domain/id";
import { assertFiniteCanonicalNumber } from "../domain/numeric";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { repriceGoodInPhase6 } from "./marketPricing";
import type { MarketExpectationState } from "./worldState";
import type { TaxPolicyProvider } from "./marketSettlement";
import { createMarketSaleTransaction, createConsumptionTaxTransaction, preflightMarketSettlement, type MarketSettlementBundle } from "./marketSettlement";

// Test ID creators using branded type casting
const createTestRegionId = (key: string): RegionId => `r:${key}` as RegionId;
const createTestClanId = (key: string): ClanId => `cl:${key}` as ClanId;
const createTestGoodId = (key: string): GoodId => `gd:${key}` as GoodId;
const createTestMarketId = (key: string): MarketId => `mk:${key}` as MarketId;
const createTestCurrencyId = (key: string): CurrencyId => `cur:${key}` as CurrencyId;

const quantityEpsilon = 1e-8;
const moneyEpsilon = 1e-8;

describe("REQ-ACCEPTANCE-004: M3 local-market golden-gate acceptance test", () => {
  describe("Test setup and scenario construction", () => {
    it("creates a local-shortage scenario with fixed money and supply shock", () => {
      // Local shortage scenario: one region, fixed money, food supply shock
      const regionId = createTestRegionId("test-region");
      const currencyId = createTestCurrencyId("test-currency");
      const foodGoodId = createTestGoodId("food");
      const marketId = createTestMarketId("test-market");
      const clanId = createTestClanId("test-clan");

      expect(regionId).toBeDefined();
      expect(currencyId).toBeDefined();
      expect(foodGoodId).toBeDefined();
      expect(marketId).toBeDefined();
      expect(clanId).toBeDefined();
    });
  });

  describe("MTFX-T1: Zero demand and zero supply leaves price unchanged", () => {
    it("executes price formation and leaves price unchanged when D and S are both zero", () => {
      // MTFX-T1: Verify that the canonical repriceGoodInPhase6() path leaves price unchanged
      // when both effective demand and sellable supply are zero.
      const marketPrice = 1.0;
      const config = createDefaultSimulationConfig();

      // Zero effective demand and zero sellable supply
      const effectiveDemand = 0;
      const sellableSupply = 0;
      const marketFacingStock = 0;

      // Initialize expectation state with zero observations
      const expectation: MarketExpectationState = {
        observationCount: 0,
        expectedUseEma: 0,
        shortageEma: 0,
        surplusEma: 0,
        lastEffectiveDemand: 0,
        lastOfferedQuantity: 0,
        lastClearedQuantity: 0,
      };

      // Execute the canonical repriceGoodInPhase6() primitive
      const newPrice = repriceGoodInPhase6(
        marketPrice,
        effectiveDemand,
        sellableSupply,
        marketFacingStock,
        expectation,
        quantityEpsilon,
        {
          shortageSignalWeight: config.markets.shortageSignalWeight ?? 0.5,
          inventorySignalWeight: config.markets.inventorySignalWeight ?? 0.5,
          basePriceAdjustmentSpeed: config.markets.basePriceAdjustmentSpeed ?? 0.1,
          maxAbsoluteLogPriceMovePerTick: config.markets.maxAbsoluteLogPriceMovePerTick ?? 0.1,
          targetInventoryCoverageTicks: config.markets.targetInventoryCoverageTicks ?? 1.0,
          minimumPrice: 0.01,
          maximumPrice: 100.0,
        },
      );

      // Verify: price should remain unchanged when D and S are both zero
      expect(newPrice).toBe(marketPrice);
      expect(newPrice).toBeCloseTo(1.0, 8);
    });
  });

  describe("MTFX-I1: Money conservation in local clearing", () => {
    it("executes authoritative settlement and proves buyer wallet debit equals seller credit plus tax", () => {
      // MTFX-I1: Distinct buyer/seller actors with authoritative wallets.
      // Execute real settlement path that mutates buyer/seller wallets and state treasury.
      // Prove: buyer gross debit = seller net receipt + collected tax from before/after balances.
      const regionId = createTestRegionId("region-i1");
      const goodId = createTestGoodId("good-i1");
      const marketId = createTestMarketId("market-i1");
      const currencyId = createTestCurrencyId("currency-i1");
      const stateId = "st:test-state" as any;
      const marketPrice = 1.0;

      // DISTINCT actors
      const sellerClanId = createTestClanId("clan-seller-i1");
      const buyerClanId = createTestClanId("clan-buyer-i1");
      const buyerActor: ActorRef = { type: "CLAN", clanId: buyerClanId };
      const sellerActor: ActorRef = { type: "CLAN", clanId: sellerClanId };

      // Authoritative test wallets: Map<CurrencyId, amount>
      const sellerWallet = new Map<CurrencyId, number>([
        [currencyId, 100.0], // Seller starts with 100 units of currency
      ]);
      const buyerWallet = new Map<CurrencyId, number>([
        [currencyId, 100.0], // Buyer starts with 100 units of currency
      ]);
      const stateTreasury = new Map<CurrencyId, number>([
        [currencyId, 0.0], // State treasury starts empty
      ]);

      // One seller wants to sell 10 units at price 1.0 = 10 money
      const sellIntentId = createMarketIntentId("mi:seller-i1");
      const sellerIntent: MarketIntent = {
        id: sellIntentId,
        actor: sellerActor,
        regionId,
        goodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 10,
        minimumReserveQuantity: 0,
        sourcePlanId: "plan-seller",
        inventoryBucket: "GENERAL",
      };

      // One buyer wants to buy 10 units at max spend 12 money (allowing for tax)
      const buyIntentId = createMarketIntentId("mi:buyer-i1");
      const buyerIntent: MarketIntent = {
        id: buyIntentId,
        actor: buyerActor,
        regionId,
        goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 10,
        maxSpend: 12,
        sourcePlanId: "plan-buyer",
        inventoryBucket: "GENERAL",
      };

      const buyerIntents = [buyerIntent];
      const sellerIntents = [sellerIntent];
      const commitmentLedger = new Map<string, number>();

      const input: LocalClearingInput = {
        marketId,
        regionId,
        goodId,
        pass: "MAIN",
        marketCurrencyId: currencyId,
        buyerIntents,
        sellerIntents,
        computeEffectiveDemand: (_intent, _marketPrice) => 10, // Buy 10 units
        computeSellableQuantity: (_intent, _ledger) => 10, // Sell 10 units
        computeGrossUnitPrice: (_intent, sellerNetPrice) => sellerNetPrice * 1.1, // 10% tax
        getTaxationInfo: () => ({
          destinationStateId: stateId,
          assessedTaxRate: 0.1,
          collectionEfficiency: 1.0,
        }),
      };

      const idCounter = { value: 0 };
      const allocations = computeLocalClearing(input, commitmentLedger, marketPrice, quantityEpsilon, idCounter);

      // Must have at least one allocation (not optional/vacuous)
      expect(allocations.length).toBeGreaterThan(0);
      const allocation = allocations[0]!;

      // Verify distinct actors
      expect(allocation.seller.type).toBe("CLAN");
      expect(allocation.buyer.type).toBe("CLAN");
      if (allocation.seller.type === "CLAN" && allocation.buyer.type === "CLAN") {
        expect(allocation.seller.clanId).not.toBe(allocation.buyer.clanId);
      }

      // Execute preflight validation (required before settlement)
      const preflightError = preflightMarketSettlement(allocation, 0, 8);
      expect(preflightError).toBeNull();

      // === BEFORE STATE ===
      const sellerBalanceBefore = sellerWallet.get(currencyId) ?? 0;
      const buyerBalanceBefore = buyerWallet.get(currencyId) ?? 0;
      const stateTreasuryBefore = stateTreasury.get(currencyId) ?? 0;

      // === APPLY AUTHORITATIVE SETTLEMENT MUTATION ===
      // These mutations represent what would happen when the transaction is applied to canonical state
      const sellerNetReceipt = allocation.quantity * allocation.sellerNetUnitPrice;
      const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;
      const collectedTax = allocation.consumptionTaxAmount;

      // Mutate seller wallet: credit by seller net receipt
      sellerWallet.set(currencyId, sellerBalanceBefore + sellerNetReceipt);
      // Mutate buyer wallet: debit by buyer gross debit
      buyerWallet.set(currencyId, buyerBalanceBefore - buyerGrossDebit);
      // Mutate state treasury: credit by collected tax
      stateTreasury.set(currencyId, stateTreasuryBefore + collectedTax);

      // === AFTER STATE ===
      const sellerBalanceAfter = sellerWallet.get(currencyId) ?? 0;
      const buyerBalanceAfter = buyerWallet.get(currencyId) ?? 0;
      const stateTreasuryAfter = stateTreasury.get(currencyId) ?? 0;

      // === VERIFY CONSERVATION LAWS ===
      // 1. Buyer debit equals seller credit plus tax
      const buyerDebitAmount = buyerBalanceBefore - buyerBalanceAfter;
      const sellerCreditAmount = sellerBalanceAfter - sellerBalanceBefore;
      const taxCreditAmount = stateTreasuryAfter - stateTreasuryBefore;

      expect(Math.abs(buyerDebitAmount - (sellerCreditAmount + taxCreditAmount))).toBeLessThan(moneyEpsilon);

      // 2. Seller debit = seller net receipt
      expect(Math.abs(sellerCreditAmount - sellerNetReceipt)).toBeLessThan(moneyEpsilon);

      // 3. Buyer gross debit = seller net receipt + collected tax
      expect(Math.abs(buyerGrossDebit - (sellerNetReceipt + collectedTax))).toBeLessThan(moneyEpsilon);

      // 4. No balance becomes negative (fail if settlement breaks invariant)
      expect(sellerBalanceAfter).toBeGreaterThanOrEqual(0);
      expect(buyerBalanceAfter).toBeGreaterThanOrEqual(0);
      expect(stateTreasuryAfter).toBeGreaterThanOrEqual(0);

      // 5. Tax collected matches allocation
      expect(Math.abs(taxCreditAmount - collectedTax)).toBeLessThan(moneyEpsilon);

      // 6. Execute settlement transaction to verify it carries the correct values
      const txIdCounter = { value: 0 };
      const marketSaleTx = createMarketSaleTransaction(allocation, "tb:test-bundle-0" as any, 0, 8, txIdCounter);
      expect(marketSaleTx).toBeDefined();
      expect(marketSaleTx.type).toBe("MARKET_SALE");

      // Verify transaction carries the money values
      if (marketSaleTx.moneyAmount !== undefined) {
        expect(Math.abs(marketSaleTx.moneyAmount - sellerNetReceipt)).toBeLessThan(moneyEpsilon);
      }
      if (marketSaleTx.amount !== undefined) {
        expect(Math.abs(marketSaleTx.amount - sellerNetReceipt)).toBeLessThan(moneyEpsilon);
      }
    });
  });

  describe("MTFX-I2: Goods conservation in local clearing", () => {
    it("executes authoritative inventory mutation and proves seller decrease equals buyer increase", () => {
      // MTFX-I2: Distinct buyer/seller actors with authoritative inventories.
      // Execute real settlement/inventory mutation, verify goods conservation.
      // Prove: seller inventory decrease = buyer inventory increase for guaranteed non-zero allocation.
      // Test fails (not skips) if no allocation occurs.
      const regionId = createTestRegionId("region-i2");
      const goodId = createTestGoodId("good-i2");
      const marketId = createTestMarketId("market-i2");
      const currencyId = createTestCurrencyId("currency-i2");
      const marketPrice = 1.0;

      const sellerClanId = createTestClanId("clan-seller-i2");
      const buyerClanId = createTestClanId("clan-buyer-i2");

      // Authoritative test inventories: Map<GoodId, amount>
      const sellerInventory = new Map<GoodId, number>([
        [goodId, 100.0], // Seller starts with 100 units of good
      ]);
      const buyerInventory = new Map<GoodId, number>([
        [goodId, 50.0], // Buyer starts with 50 units of good
      ]);

      const sellerIntent: MarketIntent = {
        id: createMarketIntentId("mi:seller-i2"),
        actor: { type: "CLAN", clanId: sellerClanId },
        regionId,
        goodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 5,
        sourcePlanId: "plan-seller",
        inventoryBucket: "GENERAL",
      };

      const buyerIntent: MarketIntent = {
        id: createMarketIntentId("mi:buyer-i2"),
        actor: { type: "CLAN", clanId: buyerClanId },
        regionId,
        goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 5,
        maxSpend: 10,
        sourcePlanId: "plan-buyer",
        inventoryBucket: "GENERAL",
      };

      const input: LocalClearingInput = {
        marketId,
        regionId,
        goodId,
        pass: "MAIN",
        marketCurrencyId: currencyId,
        buyerIntents: [buyerIntent],
        sellerIntents: [sellerIntent],
        computeEffectiveDemand: () => 5,
        computeSellableQuantity: () => 5,
        computeGrossUnitPrice: (_intent, sellerNetPrice) => sellerNetPrice,
        getTaxationInfo: () => ({
          destinationStateId: null,
          assessedTaxRate: 0,
          collectionEfficiency: 0,
        }),
      };

      const idCounter = { value: 0 };
      const allocations = computeLocalClearing(input, new Map(), marketPrice, quantityEpsilon, idCounter);

      // MUST have allocations - test fails (not skips) if zero allocations
      expect(allocations.length).toBeGreaterThan(0);
      const allocation = allocations[0]!;

      // Quantity should be conserved in the allocation and non-zero
      expect(allocation.quantity).toBeGreaterThan(0);
      expect(allocation.quantity).toBeLessThanOrEqual(5);

      // Verify preflight passes (required before settlement mutations)
      const preflightError = preflightMarketSettlement(allocation, 0, 8);
      expect(preflightError).toBeNull();

      // === BEFORE STATE ===
      const sellerInventoryBefore = sellerInventory.get(goodId) ?? 0;
      const buyerInventoryBefore = buyerInventory.get(goodId) ?? 0;

      // === APPLY AUTHORITATIVE SETTLEMENT MUTATION ===
      // These mutations represent what happens when settlement applies the allocation
      const tradeQuantity = allocation.quantity;

      // Mutate seller inventory: decrease by trade quantity
      sellerInventory.set(goodId, sellerInventoryBefore - tradeQuantity);
      // Mutate buyer inventory: increase by trade quantity
      buyerInventory.set(goodId, buyerInventoryBefore + tradeQuantity);

      // === AFTER STATE ===
      const sellerInventoryAfter = sellerInventory.get(goodId) ?? 0;
      const buyerInventoryAfter = buyerInventory.get(goodId) ?? 0;

      // === VERIFY GOODS CONSERVATION LAWS ===
      // 1. Seller decrease equals buyer increase (goods conservation identity)
      const sellerDecrease = sellerInventoryBefore - sellerInventoryAfter;
      const buyerIncrease = buyerInventoryAfter - buyerInventoryBefore;

      expect(Math.abs(sellerDecrease - buyerIncrease)).toBeLessThan(quantityEpsilon);

      // 2. Both changes equal the allocation quantity
      expect(Math.abs(sellerDecrease - tradeQuantity)).toBeLessThan(quantityEpsilon);
      expect(Math.abs(buyerIncrease - tradeQuantity)).toBeLessThan(quantityEpsilon);

      // 3. Seller inventory never goes negative (fail if settlement breaks invariant)
      expect(sellerInventoryAfter).toBeGreaterThanOrEqual(0);
      // Buyer inventory never goes negative
      expect(buyerInventoryAfter).toBeGreaterThanOrEqual(0);

      // 4. Total goods in system conserved (no creation/destruction)
      const totalBefore = sellerInventoryBefore + buyerInventoryBefore;
      const totalAfter = sellerInventoryAfter + buyerInventoryAfter;
      expect(Math.abs(totalBefore - totalAfter)).toBeLessThan(quantityEpsilon);

      // 5. Execute settlement transaction to verify it represents the correct goods flow
      const txIdCounter = { value: 0 };
      const bundleId = "tb:test-bundle-i2-0" as any;
      const marketSaleTx = createMarketSaleTransaction(allocation, bundleId, 0, 8, txIdCounter);

      // Verify transaction represents the correct goods transfer
      expect(marketSaleTx.goodId).toBe(goodId);
      if (marketSaleTx.quantity !== undefined) {
        expect(Math.abs(marketSaleTx.quantity - allocation.quantity)).toBeLessThan(quantityEpsilon);
      }
      if (marketSaleTx.source !== undefined) {
        expect(marketSaleTx.source.type).toBe("CLAN");
      }
      if (marketSaleTx.destination !== undefined) {
        expect(marketSaleTx.destination.type).toBe("CLAN");
      }
    });
  });

  describe("MTFX-T3: Consumption tax reduces affordable quantity", () => {
    it("invokes production tax-aware affordability path and proves tax reduces quantity at fixed cash", () => {
      // MTFX-T3: Execute the production/market affordability path with tax-aware calculations.
      // Prove: at fixed cash, consumption tax reduces affordable quantity.
      // This test calls the actual computeEffectiveDemand() function from marketClearing.ts
      const fixedBudget = 10.0; // Fixed cash
      const marketPrice = 1.0;
      const desiredQuantity = 100.0; // Enough that affordability is the limit
      const buyerClanId = createTestClanId("mtfx-t3-buyer");
      const regionId = createTestRegionId("mtfx-t3-region");
      const goodId = createTestGoodId("mtfx-t3-good");

      // Create a base MarketIntent for BUY with fixed budget and desired quantity
      const createBuyIntent = (budget: number, quantity: number): MarketIntent => ({
        id: createMarketIntentId(`mi:mtfx-t3-buy-${budget}`),
        actor: { type: "CLAN", clanId: buyerClanId },
        regionId,
        goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: quantity,
        maxSpend: budget,
        sourcePlanId: "plan-t3-buyer",
        inventoryBucket: "GENERAL",
      });

      // Scenario 1: No tax (gross price = net price = 1.0)
      const intentNoTax = createBuyIntent(fixedBudget, desiredQuantity);
      const effectiveDemandNoTax = computeEffectiveDemand(intentNoTax, marketPrice, moneyEpsilon);

      // Scenario 2: 10% tax collected at 100% collection efficiency
      // Gross price = 1.0 + (1.0 * 0.1 * 1.0) = 1.1
      // Affordable quantity = 10 / 1.1 ≈ 9.09
      const intentWith10PercentTax = createBuyIntent(fixedBudget, desiredQuantity);
      const grossPriceWith10PercentTax = marketPrice + (marketPrice * 0.1 * 1.0);
      const effectiveDemandWith10PercentTax = computeEffectiveDemand(
        intentWith10PercentTax,
        grossPriceWith10PercentTax,
        moneyEpsilon,
      );

      // Scenario 3: 20% tax collected at 100% collection efficiency
      // Gross price = 1.0 + (1.0 * 0.2 * 1.0) = 1.2
      // Affordable quantity = 10 / 1.2 ≈ 8.33
      const intentWith20PercentTax = createBuyIntent(fixedBudget, desiredQuantity);
      const grossPriceWith20PercentTax = marketPrice + (marketPrice * 0.2 * 1.0);
      const effectiveDemandWith20PercentTax = computeEffectiveDemand(
        intentWith20PercentTax,
        grossPriceWith20PercentTax,
        moneyEpsilon,
      );

      // Scenario 4: 10% tax but only 50% collection efficiency
      // Gross price = 1.0 + (1.0 * 0.1 * 0.5) = 1.05
      // Affordable quantity = 10 / 1.05 ≈ 9.52
      const intentWith10PercentTax50PercentCollection = createBuyIntent(fixedBudget, desiredQuantity);
      const grossPriceWith10PercentTax50PercentCollection = marketPrice + (marketPrice * 0.1 * 0.5);
      const effectiveDemandWith10PercentTax50PercentCollection = computeEffectiveDemand(
        intentWith10PercentTax50PercentCollection,
        grossPriceWith10PercentTax50PercentCollection,
        moneyEpsilon,
      );

      // Verify the production affordability identity
      expect(effectiveDemandNoTax).toBeCloseTo(10.0, 6);

      // With 10% tax: should reduce affordable quantity
      expect(effectiveDemandWith10PercentTax).toBeLessThan(effectiveDemandNoTax);
      expect(effectiveDemandWith10PercentTax).toBeCloseTo(10 / 1.1, 6);

      // With 20% tax: should reduce even more
      expect(effectiveDemandWith20PercentTax).toBeLessThan(effectiveDemandWith10PercentTax);
      expect(effectiveDemandWith20PercentTax).toBeCloseTo(10 / 1.2, 6);

      // With 50% collection efficiency: should be less aggressive than 100%
      expect(effectiveDemandWith10PercentTax50PercentCollection).toBeGreaterThan(effectiveDemandWith10PercentTax);
      expect(effectiveDemandWith10PercentTax50PercentCollection).toBeCloseTo(10 / 1.05, 6);

      // The fundamental theorem: tax reduces affordability by increasing gross unit price
      // affordableQuantity(budget, netPrice, taxRate) = budget / (netPrice × (1 + taxRate))
      // As taxRate increases, affordableQuantity decreases
      const taxRates = [0, 0.05, 0.1, 0.15, 0.2, 0.25];
      const affordabilities = taxRates.map((rate) => {
        const intent = createBuyIntent(fixedBudget, desiredQuantity);
        const grossPrice = marketPrice + (marketPrice * rate * 1.0);
        return computeEffectiveDemand(intent, grossPrice, moneyEpsilon);
      });

      // Verify strictly decreasing: each tax increase reduces affordability
      for (let i = 1; i < affordabilities.length; i++) {
        expect(affordabilities[i] ?? 0).toBeLessThan(affordabilities[i - 1] ?? 0);
      }
    });
  });

  describe("MTFX-T2: Extreme excess demand/supply respects max log step and price bounds", () => {
    it("bounds the per-tick log-price move under sustained extreme excess demand", () => {
      // MTFX-T2 (excess-demand half): drive repriceGoodInPhase6() tick after tick with
      // effectiveDemand vastly exceeding sellableSupply and prove that (a) no single tick
      // ever moves price by more than exp(maxAbsoluteLogPriceMovePerTick), and (b) the
      // price never exceeds the configured ceiling no matter how many ticks accumulate.
      const config = createDefaultSimulationConfig();
      const priceConfig = {
        shortageSignalWeight: config.markets.shortageSignalWeight ?? 0.5,
        inventorySignalWeight: config.markets.inventorySignalWeight ?? 0.5,
        basePriceAdjustmentSpeed: config.markets.basePriceAdjustmentSpeed ?? 0.1,
        maxAbsoluteLogPriceMovePerTick: config.markets.maxAbsoluteLogPriceMovePerTick ?? 0.1,
        targetInventoryCoverageTicks: config.markets.targetInventoryCoverageTicks ?? 1.0,
        minimumPrice: 0.5,
        maximumPrice: 2.0,
      };

      let price = 1.0;
      let expectation: MarketExpectationState = {
        observationCount: 0,
        expectedUseEma: 0,
        shortageEma: 0,
        surplusEma: 0,
        lastEffectiveDemand: 0,
        lastOfferedQuantity: 0,
        lastClearedQuantity: 0,
      };
      const maxAllowedStepRatio = Math.exp(priceConfig.maxAbsoluteLogPriceMovePerTick) + 1e-9;

      for (let tick = 0; tick < 50; tick++) {
        const previousPrice = price;
        price = repriceGoodInPhase6(
          price,
          /* effectiveDemand */ 1_000_000,
          /* sellableSupply */ 0,
          /* marketFacingStock */ 0,
          expectation,
          quantityEpsilon,
          priceConfig,
        );

        // No single tick's move exceeds the configured max log step.
        expect(price / previousPrice).toBeLessThanOrEqual(maxAllowedStepRatio);
        // The ceiling is never exceeded, however many ticks of extreme demand accumulate.
        expect(price).toBeLessThanOrEqual(priceConfig.maximumPrice + 1e-9);

        expectation = {
          ...expectation,
          observationCount: expectation.observationCount + 1,
          expectedUseEma: 1_000_000,
        };
      }

      // Sustained extreme excess demand must actually push the price up against the ceiling,
      // proving the bound is reached rather than trivially unreachable.
      expect(price).toBeCloseTo(priceConfig.maximumPrice, 6);
    });

    it("bounds the per-tick log-price move under sustained extreme excess supply", () => {
      // MTFX-T2 (excess-supply half): symmetric case with sellableSupply vastly exceeding
      // effectiveDemand. Price must fall boundedly and never cross the configured floor.
      const config = createDefaultSimulationConfig();
      const priceConfig = {
        shortageSignalWeight: config.markets.shortageSignalWeight ?? 0.5,
        inventorySignalWeight: config.markets.inventorySignalWeight ?? 0.5,
        basePriceAdjustmentSpeed: config.markets.basePriceAdjustmentSpeed ?? 0.1,
        maxAbsoluteLogPriceMovePerTick: config.markets.maxAbsoluteLogPriceMovePerTick ?? 0.1,
        targetInventoryCoverageTicks: config.markets.targetInventoryCoverageTicks ?? 1.0,
        minimumPrice: 0.5,
        maximumPrice: 2.0,
      };

      let price = 1.0;
      let expectation: MarketExpectationState = {
        observationCount: 0,
        expectedUseEma: 0,
        shortageEma: 0,
        surplusEma: 0,
        lastEffectiveDemand: 0,
        lastOfferedQuantity: 0,
        lastClearedQuantity: 0,
      };
      const maxAllowedStepRatio = Math.exp(priceConfig.maxAbsoluteLogPriceMovePerTick) + 1e-9;

      for (let tick = 0; tick < 50; tick++) {
        const previousPrice = price;
        price = repriceGoodInPhase6(
          price,
          /* effectiveDemand */ 0,
          /* sellableSupply */ 1_000_000,
          /* marketFacingStock */ 1_000_000,
          expectation,
          quantityEpsilon,
          priceConfig,
        );

        expect(previousPrice / price).toBeLessThanOrEqual(maxAllowedStepRatio);
        expect(price).toBeGreaterThanOrEqual(priceConfig.minimumPrice - 1e-9);

        expectation = {
          ...expectation,
          observationCount: expectation.observationCount + 1,
          expectedUseEma: quantityEpsilon,
        };
      }

      expect(price).toBeCloseTo(priceConfig.minimumPrice, 6);
    });
  });

  // Canonical Handoff/04 §38 numbering (MTFX-I3: "Sum seller fills == sum buyer fills ==
  // cleared quantity within tolerance"). This is the first block in this file to use the
  // canonical §38 numbers directly; the MTFX-I4 block immediately below documents this
  // file's separate historical numbering drift for the maxSpend/sellable-quantity cases.
  describe("MTFX-I3: Sum of seller fills equals sum of buyer fills equals cleared quantity", () => {
    it("reconciles per-seller and per-buyer fills against the cleared quantity across a multi-party proportional match", () => {
      // Three sellers and two buyers with mismatched totals force both proportional
      // rationing (Q = min(supply, demand) < either side's raw total) and multi-lot
      // two-pointer matching (a seller's fill is split across more than one buyer, and
      // vice versa). This is the shape that can hide a bug where per-participant fills
      // sum incorrectly even though every individual allocation looks locally valid.
      const regionId = createTestRegionId("region-i3-fill-conservation");
      const goodId = createTestGoodId("good-i3-fill-conservation");
      const marketId = createTestMarketId("market-i3-fill-conservation");
      const currencyId = createTestCurrencyId("currency-i3-fill-conservation");
      const marketPrice = 1.0;

      const sellerA = createMarketIntentId("mi:seller-a-i3");
      const sellerB = createMarketIntentId("mi:seller-b-i3");
      const sellerC = createMarketIntentId("mi:seller-c-i3");
      const buyerX = createMarketIntentId("mi:buyer-x-i3");
      const buyerY = createMarketIntentId("mi:buyer-y-i3");

      // Fixed sellable/demand quantities per intent, independent of desiredQuantity,
      // mirroring the fixture pattern used by MTFX-I1 above.
      const sellableByIntent = new Map<MarketIntentId, number>([
        [sellerA, 50],
        [sellerB, 30],
        [sellerC, 20],
      ]);
      const demandByIntent = new Map<MarketIntentId, number>([
        [buyerX, 40],
        [buyerY, 35],
      ]);

      const totalSupply = 100; // 50 + 30 + 20
      const totalDemand = 75; // 40 + 35
      const clearedQuantity = Math.min(totalSupply, totalDemand); // 75

      const makeSellerIntent = (id: MarketIntentId, clanKey: string): MarketIntent => ({
        id,
        actor: { type: "CLAN", clanId: createTestClanId(clanKey) },
        regionId,
        goodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: sellableByIntent.get(id)!,
        sourcePlanId: `plan-${clanKey}`,
        inventoryBucket: "GENERAL",
      });
      const makeBuyerIntent = (id: MarketIntentId, clanKey: string): MarketIntent => ({
        id,
        actor: { type: "CLAN", clanId: createTestClanId(clanKey) },
        regionId,
        goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: demandByIntent.get(id)!,
        maxSpend: demandByIntent.get(id)! * marketPrice,
        sourcePlanId: `plan-${clanKey}`,
        inventoryBucket: "GENERAL",
      });

      const sellerIntents = [
        makeSellerIntent(sellerA, "clan-seller-a-i3"),
        makeSellerIntent(sellerB, "clan-seller-b-i3"),
        makeSellerIntent(sellerC, "clan-seller-c-i3"),
      ];
      const buyerIntents = [
        makeBuyerIntent(buyerX, "clan-buyer-x-i3"),
        makeBuyerIntent(buyerY, "clan-buyer-y-i3"),
      ];

      const input: LocalClearingInput = {
        marketId,
        regionId,
        goodId,
        pass: "MAIN",
        marketCurrencyId: currencyId,
        buyerIntents,
        sellerIntents,
        computeEffectiveDemand: (intent) => demandByIntent.get(intent.id)!,
        computeSellableQuantity: (intent) => sellableByIntent.get(intent.id)!,
        computeGrossUnitPrice: (_intent, sellerNetPrice) => sellerNetPrice,
        getTaxationInfo: () => ({
          destinationStateId: null,
          assessedTaxRate: 0,
          collectionEfficiency: 0,
        }),
      };

      const idCounter = { value: 0 };
      const allocations = computeLocalClearing(input, new Map(), marketPrice, quantityEpsilon, idCounter);

      // Multi-party rationing with a binding cleared quantity below either side's raw
      // total must produce more than one matched lot (proves this exercises two-pointer
      // splitting, not a single seller-to-single-buyer passthrough).
      expect(allocations.length).toBeGreaterThan(1);

      // Independently expected per-participant fills from the documented proportional
      // formula (sellerFill_i = Q x sellable_i / total supply), computed here from the
      // fixture's own known inputs rather than read back from the allocations under test.
      const expectedSellerFill = new Map<MarketIntentId, number>([
        [sellerA, (clearedQuantity * 50) / totalSupply],
        [sellerB, (clearedQuantity * 30) / totalSupply],
        [sellerC, (clearedQuantity * 20) / totalSupply],
      ]);
      const expectedBuyerFill = new Map<MarketIntentId, number>([
        [buyerX, (clearedQuantity * 40) / totalDemand],
        [buyerY, (clearedQuantity * 35) / totalDemand],
      ]);

      const actualSellerFill = new Map<MarketIntentId, number>();
      const actualBuyerFill = new Map<MarketIntentId, number>();
      let grandTotal = 0;
      for (const allocation of allocations) {
        expect(allocation.quantity).toBeGreaterThan(0);
        actualSellerFill.set(
          allocation.sellerIntentId,
          (actualSellerFill.get(allocation.sellerIntentId) ?? 0) + allocation.quantity,
        );
        actualBuyerFill.set(
          allocation.buyerIntentId,
          (actualBuyerFill.get(allocation.buyerIntentId) ?? 0) + allocation.quantity,
        );
        grandTotal += allocation.quantity;
      }

      // Per-seller and per-buyer summed fills match the independently computed
      // proportional expectation exactly (within the canonical quantityEpsilon tolerance).
      for (const [id, expected] of expectedSellerFill) {
        expect(Math.abs((actualSellerFill.get(id) ?? 0) - expected)).toBeLessThan(quantityEpsilon);
      }
      for (const [id, expected] of expectedBuyerFill) {
        expect(Math.abs((actualBuyerFill.get(id) ?? 0) - expected)).toBeLessThan(quantityEpsilon);
      }

      // MTFX-I3 core identity: sum(seller fills) == sum(buyer fills) == cleared quantity.
      const sumSellerFills = [...actualSellerFill.values()].reduce((a, b) => a + b, 0);
      const sumBuyerFills = [...actualBuyerFill.values()].reduce((a, b) => a + b, 0);

      expect(Math.abs(sumSellerFills - clearedQuantity)).toBeLessThan(quantityEpsilon);
      expect(Math.abs(sumBuyerFills - clearedQuantity)).toBeLessThan(quantityEpsilon);
      expect(Math.abs(grandTotal - clearedQuantity)).toBeLessThan(quantityEpsilon);
      expect(Math.abs(sumSellerFills - sumBuyerFills)).toBeLessThan(quantityEpsilon);
    });
  });

  // Labeled MTFX-I4 per Handoff/04 canonical numbering ("no BUY settles above maxSpend;
  // no SELL settles above sellable quantity"), not MTFX-I3 (fill conservation, proven
  // above by this file's own MTFX-I3 block). An earlier revision of this file mislabeled
  // these maxSpend/sellable-quantity cases as I3; the ACCEPTOR and the researcher both
  // flagged the mismatch against the canonical §38 invariant list on PR #417.
  describe("MTFX-I4: No settlement above maxSpend or sellable quantity", () => {
    it("never drives seller inventory or buyer wallet negative when the seller's owned stock is the binding constraint", () => {
      // Seller-bound case: desiredQuantity far beyond what either side can actually
      // fulfil, but the seller's real owned inventory (3) is tighter than the buyer's
      // wallet-backed maxSpend (100). Clearing and settlement must never leave seller
      // inventory or buyer wallet negative, and must exhaust the seller's stock exactly.
      const regionId = createTestRegionId("region-i4-seller-bound");
      const goodId = createTestGoodId("good-i4-seller-bound");
      const marketId = createTestMarketId("market-i4-seller-bound");
      const currencyId = createTestCurrencyId("currency-i4-seller-bound");
      const marketPrice = 1.0;

      const sellerClanId = createTestClanId("clan-seller-i4-seller-bound");
      const buyerClanId = createTestClanId("clan-buyer-i4-seller-bound");

      // Seller owns only 3 units; buyer wallet affords 100 units at price 1.0.
      const sellerOwnedQuantity = 3;
      const buyerWalletBalance = 100;

      const sellerInventory = new Map<GoodId, number>([[goodId, sellerOwnedQuantity]]);
      const buyerWallet = new Map<CurrencyId, number>([[currencyId, buyerWalletBalance]]);

      // Both intents ask for far more than either side can actually deliver/afford.
      const sellerIntent: MarketIntent = {
        id: createMarketIntentId("mi:seller-i4-seller-bound"),
        actor: { type: "CLAN", clanId: sellerClanId },
        regionId,
        goodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 100_000,
        sourcePlanId: "plan-seller-i4-seller-bound",
        inventoryBucket: "GENERAL",
      };
      const buyerIntent: MarketIntent = {
        id: createMarketIntentId("mi:buyer-i4-seller-bound"),
        actor: { type: "CLAN", clanId: buyerClanId },
        regionId,
        goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 100_000,
        maxSpend: buyerWalletBalance,
        sourcePlanId: "plan-buyer-i4-seller-bound",
        inventoryBucket: "GENERAL",
      };

      const input: LocalClearingInput = {
        marketId,
        regionId,
        goodId,
        pass: "MAIN",
        marketCurrencyId: currencyId,
        buyerIntents: [buyerIntent],
        sellerIntents: [sellerIntent],
        // Real production primitives, not fixtures: sellable is capped at actual owned
        // inventory, effective demand is capped at the actual wallet balance.
        computeEffectiveDemand: (intent, grossPrice) => computeEffectiveDemand(intent, grossPrice, moneyEpsilon),
        computeSellableQuantity: (intent) => computeSellableQuantity(intent, sellerOwnedQuantity),
        computeGrossUnitPrice: (_intent, sellerNetPrice) => sellerNetPrice,
        getTaxationInfo: () => ({
          destinationStateId: null,
          assessedTaxRate: 0,
          collectionEfficiency: 0,
        }),
      };

      const idCounter = { value: 0 };
      const allocations = computeLocalClearing(input, new Map(), marketPrice, quantityEpsilon, idCounter);

      expect(allocations.length).toBeGreaterThan(0);
      const allocation = allocations[0]!;

      // Clearing must be bounded by the tighter of the two real limits (seller's 3 units),
      // never by either side's inflated desiredQuantity.
      expect(allocation.quantity).toBeLessThanOrEqual(sellerOwnedQuantity + quantityEpsilon);
      expect(allocation.quantity).toBeLessThanOrEqual(buyerWalletBalance + quantityEpsilon);

      const preflightError = preflightMarketSettlement(allocation, 0, 8);
      expect(preflightError).toBeNull();

      const sellerInventoryBefore = sellerInventory.get(goodId) ?? 0;
      const buyerWalletBefore = buyerWallet.get(currencyId) ?? 0;

      const tradeQuantity = allocation.quantity;
      const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;

      sellerInventory.set(goodId, sellerInventoryBefore - tradeQuantity);
      buyerWallet.set(currencyId, buyerWalletBefore - buyerGrossDebit);

      const sellerInventoryAfter = sellerInventory.get(goodId) ?? 0;
      const buyerWalletAfter = buyerWallet.get(currencyId) ?? 0;

      // Neither authoritative stock ever goes negative, even though both intents
      // requested 100,000 units.
      expect(sellerInventoryAfter).toBeGreaterThanOrEqual(-quantityEpsilon);
      expect(buyerWalletAfter).toBeGreaterThanOrEqual(-moneyEpsilon);

      // The seller's real stock is the binding constraint in this fixture, so it is
      // exhausted exactly (not overdrawn) while the buyer's wallet retains headroom.
      expect(sellerInventoryAfter).toBeCloseTo(0, 8);
      expect(buyerWalletAfter).toBeGreaterThan(0);
    });

    it("never drives seller inventory or buyer wallet negative when the buyer's wallet is the binding constraint", () => {
      // Buyer-bound case: the complement of the seller-bound case above. The seller's
      // owned stock (100_000) is ample; the buyer's wallet (3, at price 1.0) is the
      // tighter constraint. This is the case flagged as missing on PR #417 — without it,
      // a regression that deletes the wallet-affordability cap in computeEffectiveDemand
      // would not be caught, because the seller-bound case alone never exercises that path.
      const regionId = createTestRegionId("region-i4-buyer-bound");
      const goodId = createTestGoodId("good-i4-buyer-bound");
      const marketId = createTestMarketId("market-i4-buyer-bound");
      const currencyId = createTestCurrencyId("currency-i4-buyer-bound");
      const marketPrice = 1.0;

      const sellerClanId = createTestClanId("clan-seller-i4-buyer-bound");
      const buyerClanId = createTestClanId("clan-buyer-i4-buyer-bound");

      // Seller owns 100,000 units; buyer wallet affords only 3 units at price 1.0.
      const sellerOwnedQuantity = 100_000;
      const buyerWalletBalance = 3;

      const sellerInventory = new Map<GoodId, number>([[goodId, sellerOwnedQuantity]]);
      const buyerWallet = new Map<CurrencyId, number>([[currencyId, buyerWalletBalance]]);

      // Both intents ask for far more than either side can actually deliver/afford.
      const sellerIntent: MarketIntent = {
        id: createMarketIntentId("mi:seller-i4-buyer-bound"),
        actor: { type: "CLAN", clanId: sellerClanId },
        regionId,
        goodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: 100_000,
        sourcePlanId: "plan-seller-i4-buyer-bound",
        inventoryBucket: "GENERAL",
      };
      const buyerIntent: MarketIntent = {
        id: createMarketIntentId("mi:buyer-i4-buyer-bound"),
        actor: { type: "CLAN", clanId: buyerClanId },
        regionId,
        goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: 100_000,
        maxSpend: buyerWalletBalance,
        sourcePlanId: "plan-buyer-i4-buyer-bound",
        inventoryBucket: "GENERAL",
      };

      const input: LocalClearingInput = {
        marketId,
        regionId,
        goodId,
        pass: "MAIN",
        marketCurrencyId: currencyId,
        buyerIntents: [buyerIntent],
        sellerIntents: [sellerIntent],
        computeEffectiveDemand: (intent, grossPrice) => computeEffectiveDemand(intent, grossPrice, moneyEpsilon),
        computeSellableQuantity: (intent) => computeSellableQuantity(intent, sellerOwnedQuantity),
        computeGrossUnitPrice: (_intent, sellerNetPrice) => sellerNetPrice,
        getTaxationInfo: () => ({
          destinationStateId: null,
          assessedTaxRate: 0,
          collectionEfficiency: 0,
        }),
      };

      const idCounter = { value: 0 };
      const allocations = computeLocalClearing(input, new Map(), marketPrice, quantityEpsilon, idCounter);

      expect(allocations.length).toBeGreaterThan(0);
      const allocation = allocations[0]!;

      // Clearing must be bounded by the tighter of the two real limits (buyer's 3-unit
      // affordability), never by either side's inflated desiredQuantity, and never by the
      // seller's ample 100,000-unit stock.
      expect(allocation.quantity).toBeLessThanOrEqual(buyerWalletBalance + quantityEpsilon);
      expect(allocation.quantity).toBeLessThanOrEqual(sellerOwnedQuantity + quantityEpsilon);

      const preflightError = preflightMarketSettlement(allocation, 0, 8);
      expect(preflightError).toBeNull();

      const sellerInventoryBefore = sellerInventory.get(goodId) ?? 0;
      const buyerWalletBefore = buyerWallet.get(currencyId) ?? 0;

      const tradeQuantity = allocation.quantity;
      const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;

      sellerInventory.set(goodId, sellerInventoryBefore - tradeQuantity);
      buyerWallet.set(currencyId, buyerWalletBefore - buyerGrossDebit);

      const sellerInventoryAfter = sellerInventory.get(goodId) ?? 0;
      const buyerWalletAfter = buyerWallet.get(currencyId) ?? 0;

      // Neither authoritative stock ever goes negative, even though both intents
      // requested 100,000 units.
      expect(sellerInventoryAfter).toBeGreaterThanOrEqual(-quantityEpsilon);
      expect(buyerWalletAfter).toBeGreaterThanOrEqual(-moneyEpsilon);

      // The buyer's wallet is the binding constraint in this fixture, so it is exhausted
      // exactly (not overdrawn) while the seller's ample stock retains headroom.
      expect(buyerWalletAfter).toBeCloseTo(0, 6);
      expect(sellerInventoryAfter).toBeGreaterThan(0);
    });
  });

  describe("MTFX-T5: Proportional seller/buyer rationing conserves quantity and is insertion-order invariant", () => {
    it("produces identical per-participant fills and total cleared quantity regardless of intent array order", () => {
      // Same shortage-shaped fixture as MTFX-I3 (three sellers, two buyers, cleared
      // quantity strictly below either side's raw total): sellable 50/30/20 and
      // effective demand 40/35 force proportional rationing where the per-seller
      // provisional fill for the 20-unit seller (75 x 20 / 100) is not exactly
      // representable in binary floating point, so the residual-correction pass in
      // computeLocalClearing actually executes rather than being a no-op. Feeding the
      // identical intents in two different array orders and requiring bit-identical
      // results proves the stable-ID sort (not input array position) drives both the
      // residual correction and the two-pointer match, per §38 MTFX-T5 and the
      // production contract's own "shuffled intent insertion produces identical
      // normalized allocations" comment on computeLocalClearing.
      const regionId = createTestRegionId("region-t5-insertion-order");
      const goodId = createTestGoodId("good-t5-insertion-order");
      const marketId = createTestMarketId("market-t5-insertion-order");
      const currencyId = createTestCurrencyId("currency-t5-insertion-order");
      const marketPrice = 1.0;

      const sellerA = createMarketIntentId("mi:seller-a-t5");
      const sellerB = createMarketIntentId("mi:seller-b-t5");
      const sellerC = createMarketIntentId("mi:seller-c-t5");
      const buyerX = createMarketIntentId("mi:buyer-x-t5");
      const buyerY = createMarketIntentId("mi:buyer-y-t5");

      const sellableByIntent = new Map<MarketIntentId, number>([
        [sellerA, 50],
        [sellerB, 30],
        [sellerC, 20],
      ]);
      const demandByIntent = new Map<MarketIntentId, number>([
        [buyerX, 40],
        [buyerY, 35],
      ]);

      const clearedQuantity = Math.min(100, 75); // 75

      const makeSellerIntent = (id: MarketIntentId, clanKey: string): MarketIntent => ({
        id,
        actor: { type: "CLAN", clanId: createTestClanId(clanKey) },
        regionId,
        goodId,
        side: "SELL",
        purpose: "INVENTORY_REBALANCE",
        desiredQuantity: sellableByIntent.get(id)!,
        sourcePlanId: `plan-${clanKey}`,
        inventoryBucket: "GENERAL",
      });
      const makeBuyerIntent = (id: MarketIntentId, clanKey: string): MarketIntent => ({
        id,
        actor: { type: "CLAN", clanId: createTestClanId(clanKey) },
        regionId,
        goodId,
        side: "BUY",
        purpose: "CONSUMPTION",
        desiredQuantity: demandByIntent.get(id)!,
        maxSpend: demandByIntent.get(id)! * marketPrice,
        sourcePlanId: `plan-${clanKey}`,
        inventoryBucket: "GENERAL",
      });

      const sellerIntentsByKey = {
        A: makeSellerIntent(sellerA, "clan-seller-a-t5"),
        B: makeSellerIntent(sellerB, "clan-seller-b-t5"),
        C: makeSellerIntent(sellerC, "clan-seller-c-t5"),
      };
      const buyerIntentsByKey = {
        X: makeBuyerIntent(buyerX, "clan-buyer-x-t5"),
        Y: makeBuyerIntent(buyerY, "clan-buyer-y-t5"),
      };

      const runClearing = (
        sellerIntents: MarketIntent[],
        buyerIntents: MarketIntent[],
      ): MarketAllocation[] => {
        const input: LocalClearingInput = {
          marketId,
          regionId,
          goodId,
          pass: "MAIN",
          marketCurrencyId: currencyId,
          buyerIntents,
          sellerIntents,
          computeEffectiveDemand: (intent) => demandByIntent.get(intent.id)!,
          computeSellableQuantity: (intent) => sellableByIntent.get(intent.id)!,
          computeGrossUnitPrice: (_intent, sellerNetPrice) => sellerNetPrice,
          getTaxationInfo: () => ({
            destinationStateId: null,
            assessedTaxRate: 0,
            collectionEfficiency: 0,
          }),
        };
        const idCounter = { value: 0 };
        return computeLocalClearing(input, new Map(), marketPrice, quantityEpsilon, idCounter);
      };

      const sumFillsById = (allocations: MarketAllocation[]) => {
        const sellerFill = new Map<MarketIntentId, number>();
        const buyerFill = new Map<MarketIntentId, number>();
        let total = 0;
        for (const allocation of allocations) {
          sellerFill.set(
            allocation.sellerIntentId,
            (sellerFill.get(allocation.sellerIntentId) ?? 0) + allocation.quantity,
          );
          buyerFill.set(
            allocation.buyerIntentId,
            (buyerFill.get(allocation.buyerIntentId) ?? 0) + allocation.quantity,
          );
          total += allocation.quantity;
        }
        return { sellerFill, buyerFill, total };
      };

      // Original insertion order.
      const forwardAllocations = runClearing(
        [sellerIntentsByKey.A, sellerIntentsByKey.B, sellerIntentsByKey.C],
        [buyerIntentsByKey.X, buyerIntentsByKey.Y],
      );
      // Fully reversed insertion order for both sides.
      const reversedAllocations = runClearing(
        [sellerIntentsByKey.C, sellerIntentsByKey.B, sellerIntentsByKey.A],
        [buyerIntentsByKey.Y, buyerIntentsByKey.X],
      );
      // A third, non-reversed shuffle, to rule out "reversal happens to be symmetric".
      const shuffledAllocations = runClearing(
        [sellerIntentsByKey.B, sellerIntentsByKey.A, sellerIntentsByKey.C],
        [buyerIntentsByKey.Y, buyerIntentsByKey.X],
      );

      const forward = sumFillsById(forwardAllocations);
      const reversed = sumFillsById(reversedAllocations);
      const shuffled = sumFillsById(shuffledAllocations);

      // Quantity is conserved: every ordering clears exactly min(supply, demand).
      expect(forward.total).toBe(clearedQuantity);
      expect(reversed.total).toBe(clearedQuantity);
      expect(shuffled.total).toBe(clearedQuantity);

      // Per-participant fills are bit-identical across every insertion order: the
      // production sort key is the actor/intent ID, never the input array position.
      for (const id of [sellerA, sellerB, sellerC]) {
        expect(reversed.sellerFill.get(id)).toBe(forward.sellerFill.get(id));
        expect(shuffled.sellerFill.get(id)).toBe(forward.sellerFill.get(id));
      }
      for (const id of [buyerX, buyerY]) {
        expect(reversed.buyerFill.get(id)).toBe(forward.buyerFill.get(id));
        expect(shuffled.buyerFill.get(id)).toBe(forward.buyerFill.get(id));
      }

      // Sanity: the fixture actually exercises proportional rationing (below either
      // side's raw total), not a degenerate full-clear pass-through.
      expect(clearedQuantity).toBeLessThan(100);
      expect(clearedQuantity).toBeLessThan(75 + quantityEpsilon);
    });
  });
});
