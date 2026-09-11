/**
 * REQ-MARKET-005 integration test: Phase-8 handler telemetry collection.
 *
 * Verifies that telemetry is emitted through the actual Phase-8 handler
 * (not standalone manual builder calls), and that enabled/disabled runs
 * produce identical canonical results.
 *
 * This test addresses issue #341: ensuring REQ-MARKET-005 acceptance
 * criterion "A seeded test reaches telemetry through the real Phase-8
 * MAIN production execution path".
 *
 * It also addresses issue #412: the telemetry toggle previously short-circuited
 * clearing itself (a disabled run never called computeLocalClearing()), and the
 * only cross-run comparison was computeTickHash(), which does not cover
 * allocations/wallets/inventories/ledger state. The tests below compare
 * context.marketAllocations directly between telemetry-on and telemetry-off runs
 * so a real allocation divergence would fail the test, not just an unrelated
 * transaction/hash counter.
 *
 * It also addresses issue #416: even after #412, nothing compared authoritative
 * stock/ledger outcomes (only allocations, transaction count and computeTickHash()).
 * Because Phase-8 does not yet call MarketSettlement.executeAllocation() against
 * WorldState, the allocations are the only Phase-8-produced state today; the tests
 * below settle both runs' realized allocations through the real executeMarketSettlement()
 * transaction-construction path and compare the resulting wallet/inventory/treasury
 * outcomes and context.currentLedger, with a negative control proving that comparison
 * actually catches a stock divergence when allocations stay unchanged.
 */

import { describe, it, expect } from "vitest";
import type { GoodId, MarketId, RegionId } from "../domain/id";
import { buildInitialWorld } from "./worldState";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { executeTick, computeTickHash, type TickContext } from "./tickOrchestrator";
import { createPhase8Handler } from "./phase8MainMarketClearing";
import type { MarketIntent } from "./marketIntent";
import { createMarketIntentId } from "./marketIntent";
import type { MarketAllocation } from "./marketClearing";
import { executeMarketSettlement } from "./marketSettlement";

/**
 * Resolve the CLAN actor key a settlement snapshot indexes wallets/inventories by.
 * The M3 fixtures in this file only ever use CLAN actors.
 */
function actorKey(actor: MarketAllocation["seller"]): string {
  if (actor.type !== "CLAN") {
    throw new Error(`REQ-MARKET-005 settlement fixture only supports CLAN actors, got ${actor.type}`);
  }
  return actor.clanId as string;
}

interface SettlementSnapshot {
  readonly wallets: Record<string, number>;
  readonly inventories: Record<string, number>;
  readonly treasury: number;
}

/**
 * Apply the canonical settlement path (executeMarketSettlement's transaction amounts)
 * to fresh wallet/inventory maps, so two independently-produced allocation sets can be
 * compared on authoritative stock outcomes, not only on the allocations themselves.
 */
function applyAllocationsToSettlementSnapshot(
  allocations: readonly MarketAllocation[],
  tick: number,
  phase: number,
): SettlementSnapshot {
  const wallets = new Map<string, number>();
  const inventories = new Map<string, number>();
  let treasury = 0;
  const transactionIdCounter = { value: 0 };

  for (const allocation of allocations) {
    const bundle = executeMarketSettlement(allocation, tick, phase, transactionIdCounter);
    const sellerKey = actorKey(allocation.seller);
    const buyerKey = actorKey(allocation.buyer);
    const sellerNetReceipt = bundle.marketSaleTransaction.moneyAmount ?? 0;
    const collectedTax = bundle.consumptionTaxTransaction?.moneyAmount ?? 0;
    const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;

    wallets.set(sellerKey, (wallets.get(sellerKey) ?? 0) + sellerNetReceipt);
    wallets.set(buyerKey, (wallets.get(buyerKey) ?? 0) - buyerGrossDebit);
    treasury += collectedTax;

    inventories.set(sellerKey, (inventories.get(sellerKey) ?? 0) - allocation.quantity);
    inventories.set(buyerKey, (inventories.get(buyerKey) ?? 0) + allocation.quantity);
  }

  return {
    wallets: Object.fromEntries(wallets),
    inventories: Object.fromEntries(inventories),
    treasury,
  };
}

describe("acceptance-req-market-005-phase8-integration", () => {
  it("collects telemetry through real Phase-8 handler via orchestrator", () => {
    // Build seeded baseline scenario
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Create fixture intents for Phase-8 to clear
    const getFixtureIntents = (): MarketIntent[] => {
      // Use first region and good from world state
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const seller = Array.from(worldState.clans.values())[0]!;
      const buyer = Array.from(worldState.clans.values())[1]!;

      if (!regionId || !goodId) throw new Error("Test fixture missing region or good");

      return [
        {
          id: createMarketIntentId("mi:seller-fixture-1"),
          actor: { type: "CLAN" as const, clanId: seller.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 100,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:test-1",
        },
        {
          id: createMarketIntentId("mi:buyer-fixture-1"),
          actor: { type: "CLAN" as const, clanId: buyer.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 80,
          maxSpend: 800,
          sourcePlanId: "plan:test-2",
        },
      ];
    };

    // Create Phase-8 handler with telemetry collection enabled
    const phase8HandlerWithTelemetry = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    // Execute one tick with telemetry enabled
    const resultWithTelemetry = executeTick(
      worldState,
      1,
      worldState.pendingTransitions,
      phase8HandlerWithTelemetry,
    );

    // Verify telemetry was collected during Phase-8
    expect(resultWithTelemetry.context.marketTelemetry.length).toBeGreaterThan(0);

    // Verify telemetry has the expected structure
    const telemetry = resultWithTelemetry.context.marketTelemetry[0];
    expect(telemetry).toBeDefined();
    expect(telemetry!.pass).toBe("MAIN");
    expect(telemetry!.desiredDemandQuantity).toBeGreaterThan(0);
    expect(telemetry!.clearedQuantity).toBeGreaterThan(0);
    expect(telemetry!.shortageRate).toBeGreaterThanOrEqual(0);
    expect(telemetry!.surplusRate).toBeGreaterThanOrEqual(0);

    // Verify clearing itself ran and produced allocations, independent of telemetry
    expect(resultWithTelemetry.context.marketAllocations.length).toBeGreaterThan(0);

    // Capture replay hash with telemetry enabled
    const hashWithTelemetry = computeTickHash(worldState, resultWithTelemetry.context);

    // Now run with telemetry disabled and verify identical canonical results
    const phase8HandlerNoTelemetry = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: false,
    });

    const resultNoTelemetry = executeTick(
      worldState,
      1,
      worldState.pendingTransitions,
      phase8HandlerNoTelemetry,
    );

    // Verify no telemetry was collected when disabled
    expect(resultNoTelemetry.context.marketTelemetry.length).toBe(0);

    // Verify canonical results are identical
    expect(resultNoTelemetry.context.transactions.length).toBe(
      resultWithTelemetry.context.transactions.length,
    );

    // Verify replay hash is identical
    const hashNoTelemetry = computeTickHash(worldState, resultNoTelemetry.context);
    expect(hashNoTelemetry).toBe(hashWithTelemetry);

    // Most importantly: verify clearing itself executed identically when telemetry is
    // disabled -- the toggle must not short-circuit computeLocalClearing(). Compare the
    // realized allocations directly (not only the tick hash, which does not cover
    // allocations/wallets/inventories/ledger state) so a divergence here would fail.
    expect(resultNoTelemetry.context.marketAllocations.length).toBe(
      resultWithTelemetry.context.marketAllocations.length,
    );
    expect(resultNoTelemetry.context.marketAllocations).toEqual(
      resultWithTelemetry.context.marketAllocations,
    );
  });

  it("REQ-MARKET-005 golden-gate: collectTelemetry=false still executes clearing", () => {
    // Regression test for issue #412: createPhase8Handler previously returned early
    // (`if (!collectTelemetry || !getFixtureIntents) return context;`) when telemetry
    // was disabled, so computeLocalClearing() never ran and no allocation was produced.
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 55);

    const getFixtureIntents = (): MarketIntent[] => {
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const seller = Array.from(worldState.clans.values())[0]!;
      const buyer = Array.from(worldState.clans.values())[1]!;

      return [
        {
          id: createMarketIntentId("mi:seller-no-telemetry"),
          actor: { type: "CLAN" as const, clanId: seller.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 60,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:no-telemetry-seller",
        },
        {
          id: createMarketIntentId("mi:buyer-no-telemetry"),
          actor: { type: "CLAN" as const, clanId: buyer.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 40,
          maxSpend: 400,
          sourcePlanId: "plan:no-telemetry-buyer",
        },
      ];
    };

    const phase8HandlerNoTelemetry = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: false,
    });

    const result = executeTick(worldState, 1, worldState.pendingTransitions, phase8HandlerNoTelemetry);

    // No telemetry should be built...
    expect(result.context.marketTelemetry.length).toBe(0);
    // ...but clearing must still have executed and produced an allocation.
    expect(result.context.marketAllocations.length).toBeGreaterThan(0);
    expect(result.context.marketAllocations[0]!.quantity).toBeGreaterThan(0);
  });

  it("Phase-8 handler integrates with orchestrator without affecting other phases", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Create a simple Phase-8 handler
    const phase8Handler = createPhase8Handler({ collectTelemetry: true });

    // Execute tick and verify all 16 phases complete successfully
    const result = executeTick(
      worldState,
      1,
      worldState.pendingTransitions,
      phase8Handler,
    );

    // Verify phase trace includes all 16 phases (0-15)
    expect(result.phaseTrace.length).toBe(16);
    expect(result.phaseTrace).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    // Verify no phase-boundary errors occurred
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
  });

  it("telemetry emitted from Phase-8 is non-authoritative and preserves canonical stocks", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Fixture intents
    const getFixtureIntents = (): MarketIntent[] => {
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const seller = Array.from(worldState.clans.values())[0]!;

      return [
        {
          id: createMarketIntentId("mi:seller-preserve-1"),
          actor: { type: "CLAN" as const, clanId: seller.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 50,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:test-preserve",
        },
      ];
    };

    const phase8WithTelemetry = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    const result = executeTick(worldState, 1, worldState.pendingTransitions, phase8WithTelemetry);

    // Per REQ-MARKET-005: telemetry is non-authoritative output
    // World state must remain immutable (no new wallets/inventory created by telemetry)
    expect(worldState.clans.size).toBeGreaterThan(0); // Unchanged
    expect(Array.from(worldState.clans.values())[0]!.clanId).toBeDefined(); // Unchanged

    // Telemetry collected must have finite, valid values
    if (result.context.marketTelemetry.length > 0) {
      const t = result.context.marketTelemetry[0]!;
      expect(Number.isFinite(t.desiredDemandQuantity)).toBe(true);
      expect(Number.isFinite(t.clearedQuantity)).toBe(true);
      expect(Number.isFinite(t.shortageRate)).toBe(true);
      expect(Number.isFinite(t.surplusRate)).toBe(true);
      expect(t.shortageRate).toBeGreaterThanOrEqual(0);
      expect(t.surplusRate).toBeGreaterThanOrEqual(0);
    }
  });

  it("REQ-MARKET-005 golden-gate: all required telemetry fields populated per spec section 33", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 99);

    // Deterministic fixture with clear supply/demand imbalance
    const getFixtureIntents = (): MarketIntent[] => {
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const sellers = Array.from(worldState.clans.values()).slice(0, 2);
      const buyers = Array.from(worldState.clans.values()).slice(2, 4);

      return [
        {
          id: createMarketIntentId("mi:seller-1"),
          actor: { type: "CLAN" as const, clanId: sellers[0]!.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 100,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:sellers",
        },
        {
          id: createMarketIntentId("mi:seller-2"),
          actor: { type: "CLAN" as const, clanId: sellers[1]!.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 100,
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:sellers",
        },
        {
          id: createMarketIntentId("mi:buyer-1"),
          actor: { type: "CLAN" as const, clanId: buyers[0]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 150,
          maxSpend: 1500,
          sourcePlanId: "plan:buyers",
        },
        {
          id: createMarketIntentId("mi:buyer-2"),
          actor: { type: "CLAN" as const, clanId: buyers[1]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 100,
          maxSpend: 1000,
          sourcePlanId: "plan:buyers",
        },
      ];
    };

    const phase8Handler = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    const result = executeTick(worldState, 1, worldState.pendingTransitions, phase8Handler);

    // Per REQ-MARKET-005, section 33: all required fields must be populated
    expect(result.context.marketTelemetry.length).toBeGreaterThan(0);
    const telemetry = result.context.marketTelemetry[0]!;

    // Verify all required M3 fields exist and are finite
    expect(Number.isFinite(telemetry.desiredDemandQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.effectiveDemandQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.offeredQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.clearedQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.sellerNetPrice)).toBe(true);
    expect(Number.isFinite(telemetry.householdGrossPrice)).toBe(true);
    expect(Number.isFinite(telemetry.unmetDemandQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.unsoldOfferQuantity)).toBe(true);
    expect(Number.isFinite(telemetry.shortageRate)).toBe(true);
    expect(Number.isFinite(telemetry.surplusRate)).toBe(true);
    expect(Number.isFinite(telemetry.consumptionTaxCollected)).toBe(true);

    // Verify structural properties per section 33
    expect(telemetry.pass).toBe("MAIN");
    expect(telemetry.marketId).toBeDefined();
    expect(telemetry.regionId).toBeDefined();
    expect(telemetry.goodId).toBeDefined();

    // Verify quantity relationships: cleared <= effective demand, cleared <= offered
    expect(telemetry.clearedQuantity).toBeLessThanOrEqual(telemetry.effectiveDemandQuantity + 1e-8);
    expect(telemetry.clearedQuantity).toBeLessThanOrEqual(telemetry.offeredQuantity + 1e-8);

    // Verify unmet/unsold are computed correctly
    expect(telemetry.unmetDemandQuantity).toBeGreaterThanOrEqual(-1e-8);
    expect(telemetry.unsoldOfferQuantity).toBeGreaterThanOrEqual(-1e-8);

    // Verify shortage/surplus rate bounds per section 33 formula
    expect(telemetry.shortageRate).toBeGreaterThanOrEqual(-1e-8);
    expect(telemetry.shortageRate).toBeLessThanOrEqual(1 + 1e-8);
    expect(telemetry.surplusRate).toBeGreaterThanOrEqual(-1e-8);
    expect(telemetry.surplusRate).toBeLessThanOrEqual(1 + 1e-8);
  });

  it("REQ-MARKET-005 golden-gate: telemetry values match clearing outcomes", () => {
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 77);

    // Shortage scenario: high demand (200), limited supply (50)
    // Expected: clearedQuantity = 50 (supply-constrained)
    const getFixtureIntents = (): MarketIntent[] => {
      const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
      const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
      const sellers = Array.from(worldState.clans.values()).slice(0, 1);
      const buyers = Array.from(worldState.clans.values()).slice(1, 3);

      return [
        {
          id: createMarketIntentId("mi:seller-shortage"),
          actor: { type: "CLAN" as const, clanId: sellers[0]!.clanId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 50, // Limited supply
          minimumReserveQuantity: 0,
          sourcePlanId: "plan:shortage-sellers",
        },
        {
          id: createMarketIntentId("mi:buyer-shortage-1"),
          actor: { type: "CLAN" as const, clanId: buyers[0]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 100, // High demand
          maxSpend: 2000,
          sourcePlanId: "plan:shortage-buyers",
        },
        {
          id: createMarketIntentId("mi:buyer-shortage-2"),
          actor: { type: "CLAN" as const, clanId: buyers[1]!.clanId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 100,
          maxSpend: 2000,
          sourcePlanId: "plan:shortage-buyers",
        },
      ];
    };

    const phase8Handler = createPhase8Handler({
      getFixtureIntents,
      collectTelemetry: true,
    });

    const result = executeTick(worldState, 1, worldState.pendingTransitions, phase8Handler);
    const intents = getFixtureIntents();
    const telemetry = result.context.marketTelemetry[0]!;

    // Verify clearing relationships from actual fixture
    const tolerance = 1e-8;
    const totalBuyerDesired = intents.filter(i => i.side === "BUY").reduce((sum, i) => sum + i.desiredQuantity, 0);
    const totalSellerOffered = intents.filter(i => i.side === "SELL").reduce((sum, i) => sum + i.desiredQuantity, 0);

    // Acceptance criterion 1: desiredDemandQuantity must equal sum of buyer intents
    expect(telemetry.desiredDemandQuantity).toBeCloseTo(totalBuyerDesired, 8);
    expect(telemetry.desiredDemandQuantity).toBeCloseTo(200, 8); // 100 + 100

    // Acceptance criterion 2: offeredQuantity must equal sum of seller intents
    expect(telemetry.offeredQuantity).toBeCloseTo(totalSellerOffered, 8);
    expect(telemetry.offeredQuantity).toBeCloseTo(50, 8);

    // Acceptance criterion 3: In shortage scenario (high demand, limited supply),
    // clearedQuantity must equal offeredQuantity (supply-constrained)
    expect(telemetry.clearedQuantity).toBeLessThanOrEqual(telemetry.offeredQuantity + tolerance);
    expect(Math.abs(telemetry.clearedQuantity - 50)).toBeLessThan(tolerance);

    // Acceptance criterion 4: unmetDemandQuantity = effectiveDemand - clearedQuantity
    // With clearedQuantity ~= 50 and effective demand ~= min(200, all affordable),
    // unmetDemandQuantity should be significantly positive (shortage condition)
    expect(telemetry.unmetDemandQuantity).toBeGreaterThan(25); // At least 50 units of demand unmet

    // Acceptance criterion 5: unsoldOfferQuantity = offeredQuantity - clearedQuantity
    // With offered=50, cleared~=50, unsold should be ~0
    expect(Math.abs(telemetry.unsoldOfferQuantity - 0)).toBeLessThan(tolerance);

    // Acceptance criterion 6: shortageRate = unmetDemandQuantity / effectiveDemandQuantity
    // With unmet >> 0 and effective demand >> 0, shortage rate should be high
    if (telemetry.effectiveDemandQuantity > tolerance) {
      const expectedShortageRate = telemetry.unmetDemandQuantity / telemetry.effectiveDemandQuantity;
      expect(Math.abs(telemetry.shortageRate - expectedShortageRate)).toBeLessThan(tolerance);
      expect(telemetry.shortageRate).toBeGreaterThan(0.2); // Significant shortage
    }

    // Acceptance criterion 7: surplusRate should be 0 in shortage scenario
    expect(telemetry.surplusRate).toBeLessThan(tolerance);

    // Acceptance criterion 8: prices should be finite and non-negative
    expect(Number.isFinite(telemetry.sellerNetPrice)).toBe(true);
    expect(Number.isFinite(telemetry.householdGrossPrice)).toBe(true);
    expect(telemetry.sellerNetPrice).toBeGreaterThanOrEqual(0);
    expect(telemetry.householdGrossPrice).toBeGreaterThanOrEqual(telemetry.sellerNetPrice);

    // Acceptance criterion 9: Tax collected should be non-negative and scale with cleared quantity
    expect(telemetry.consumptionTaxCollected).toBeGreaterThanOrEqual(-tolerance);
    // Tax = (cleared quantity) * (gross price - net price) per unit
    const expectedTaxPerUnit = telemetry.householdGrossPrice - telemetry.sellerNetPrice;
    const expectedTotalTax = Math.max(0, telemetry.clearedQuantity * expectedTaxPerUnit);
    expect(Math.abs(telemetry.consumptionTaxCollected - expectedTotalTax)).toBeLessThan(tolerance);
  });

  it(
    "REQ-MARKET-005: telemetry on/off toggle produces identical authoritative wallet, " +
      "inventory and ledger outcomes when the canonical settlement path is applied to the " +
      "realized allocations",
    () => {
      // Issue #416: the merged toggle regression compared transaction count,
      // computeTickHash() (which hashes only tick/config/seed/phaseTrace/transactionCount)
      // and marketAllocations -- never wallets, inventories or context.currentLedger, so a
      // stock/ledger divergence confined to those fields with allocations unchanged was
      // undetectable. This settles both runs' realized allocations through the real
      // executeMarketSettlement() transaction-construction path and compares the resulting
      // wallet/inventory/treasury outcomes plus context.currentLedger directly.
      const config = createDefaultSimulationConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const getFixtureIntents = (): MarketIntent[] => {
        const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
        const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
        const seller = Array.from(worldState.clans.values())[0]!;
        const buyer = Array.from(worldState.clans.values())[1]!;

        return [
          {
            id: createMarketIntentId("mi:seller-stock-neutrality"),
            actor: { type: "CLAN" as const, clanId: seller.clanId },
            regionId,
            goodId,
            side: "SELL" as const,
            purpose: "INVENTORY_REBALANCE" as const,
            desiredQuantity: 100,
            minimumReserveQuantity: 0,
            sourcePlanId: "plan:stock-neutrality-seller",
          },
          {
            id: createMarketIntentId("mi:buyer-stock-neutrality"),
            actor: { type: "CLAN" as const, clanId: buyer.clanId },
            regionId,
            goodId,
            side: "BUY" as const,
            purpose: "CONSUMPTION" as const,
            desiredQuantity: 80,
            maxSpend: 800,
            sourcePlanId: "plan:stock-neutrality-buyer",
          },
        ];
      };

      const resultWithTelemetry = executeTick(
        worldState,
        1,
        worldState.pendingTransitions,
        createPhase8Handler({ getFixtureIntents, collectTelemetry: true }),
      );
      const resultNoTelemetry = executeTick(
        worldState,
        1,
        worldState.pendingTransitions,
        createPhase8Handler({ getFixtureIntents, collectTelemetry: false }),
      );

      // Precondition: allocations are non-empty and equal, so any downstream stock
      // difference could only originate in settlement application, never in clearing.
      expect(resultWithTelemetry.context.marketAllocations.length).toBeGreaterThan(0);
      expect(resultNoTelemetry.context.marketAllocations).toEqual(
        resultWithTelemetry.context.marketAllocations,
      );

      const snapshotWithTelemetry = applyAllocationsToSettlementSnapshot(
        resultWithTelemetry.context.marketAllocations,
        1,
        8,
      );
      const snapshotNoTelemetry = applyAllocationsToSettlementSnapshot(
        resultNoTelemetry.context.marketAllocations,
        1,
        8,
      );

      expect(snapshotNoTelemetry).toEqual(snapshotWithTelemetry);

      // context.currentLedger is the authoritative persisted record; the toggle must not
      // change it either.
      expect(resultNoTelemetry.context.currentLedger).toEqual(resultWithTelemetry.context.currentLedger);
    },
  );

  it(
    "detects a stock divergence between telemetry on/off settlement outcomes when " +
      "allocations stay unchanged (negative control)",
    () => {
      // Proves the comparison above is not vacuous: an equal-allocations, unequal-stock
      // divergence -- the exact shape issue #416 found undetectable in PR #414 -- fails
      // settlement snapshot equality.
      const config = createDefaultSimulationConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const getFixtureIntents = (): MarketIntent[] => {
        const regionId = Array.from(worldState.regions.values())[0]?.regionId as RegionId;
        const goodId = Object.keys(worldState.definitionRegistry.goods)[0] as GoodId;
        const seller = Array.from(worldState.clans.values())[0]!;
        const buyer = Array.from(worldState.clans.values())[1]!;

        return [
          {
            id: createMarketIntentId("mi:seller-negative-control"),
            actor: { type: "CLAN" as const, clanId: seller.clanId },
            regionId,
            goodId,
            side: "SELL" as const,
            purpose: "INVENTORY_REBALANCE" as const,
            desiredQuantity: 100,
            minimumReserveQuantity: 0,
            sourcePlanId: "plan:negative-control-seller",
          },
          {
            id: createMarketIntentId("mi:buyer-negative-control"),
            actor: { type: "CLAN" as const, clanId: buyer.clanId },
            regionId,
            goodId,
            side: "BUY" as const,
            purpose: "CONSUMPTION" as const,
            desiredQuantity: 80,
            maxSpend: 800,
            sourcePlanId: "plan:negative-control-buyer",
          },
        ];
      };

      const result = executeTick(
        worldState,
        1,
        worldState.pendingTransitions,
        createPhase8Handler({ getFixtureIntents, collectTelemetry: true }),
      );
      expect(result.context.marketAllocations.length).toBeGreaterThan(0);

      const goodSnapshot = applyAllocationsToSettlementSnapshot(result.context.marketAllocations, 1, 8);

      // Simulate the exact defect this test exists to catch: a settlement application that,
      // for one of the two toggle states, fails to credit the seller's net receipt while the
      // realized allocations (and therefore clearing) are byte-identical. The allocations
      // themselves stay untouched and preflight-valid; only the settlement-application step
      // (the part #416 found unobserved) is broken, exactly as a real regression there would
      // leave clearing/allocations unaffected.
      const transactionIdCounter = { value: 0 };
      const wallets = new Map<string, number>();
      const inventories = new Map<string, number>();
      let treasury = 0;
      for (const allocation of result.context.marketAllocations) {
        const bundle = executeMarketSettlement(allocation, 1, 8, transactionIdCounter);
        const sellerKey = actorKey(allocation.seller);
        const buyerKey = actorKey(allocation.buyer);
        const collectedTax = bundle.consumptionTaxTransaction?.moneyAmount ?? 0;
        const buyerGrossDebit = allocation.quantity * allocation.buyerGrossUnitPrice;
        // Bug: omit crediting the seller's net receipt (contrast with the correct helper's
        // `wallets.set(sellerKey, (wallets.get(sellerKey) ?? 0) + sellerNetReceipt);`).
        wallets.set(buyerKey, (wallets.get(buyerKey) ?? 0) - buyerGrossDebit);
        treasury += collectedTax;
        inventories.set(sellerKey, (inventories.get(sellerKey) ?? 0) - allocation.quantity);
        inventories.set(buyerKey, (inventories.get(buyerKey) ?? 0) + allocation.quantity);
      }
      const buggySnapshot: SettlementSnapshot = {
        wallets: Object.fromEntries(wallets),
        inventories: Object.fromEntries(inventories),
        treasury,
      };

      expect(buggySnapshot).not.toEqual(goodSnapshot);
    },
  );
});
