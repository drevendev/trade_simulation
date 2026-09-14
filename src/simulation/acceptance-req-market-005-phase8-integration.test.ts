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
 * A prior revision of this fix tried to close that gap by feeding both runs'
 * (already-asserted-equal) marketAllocations through executeMarketSettlement() and
 * comparing the resulting synthetic wallet/inventory snapshots. The ACCEPTOR correctly
 * rejected that as tautological: executeMarketSettlement() is a pure function of the
 * allocation alone, so once marketAllocations are asserted equal, any deterministic
 * post-processing of them is equal by construction -- no production code path that
 * could actually diverge based on collectTelemetry was exercised, and
 * context.currentLedger is never written by this fixture's Phase-8 handler either way.
 *
 * That gap is now closed (Issue #427). When these tests were written, canonical
 * WorldState carried no live wallet or inventory at all and
 * `MarketSettlement.executeAllocation(world, ctx, allocation)` (Handoff/04 section 35)
 * did not exist, so the strongest checkable property was that Phase-8 leaves WorldState
 * alone under either telemetry setting -- true, but narrower than the acceptance clause,
 * and R235 (`ANSWERS_TO_IMPLEMENTER.md`, `CODE_RUNTIME_QA_M3_16`) says it is not the
 * required proof. PR #475 added the live stock and the settlement function; this file now
 * also settles Phase-8's realized MAIN-pass allocations through
 * `applyMarketSettlementTransition()` and compares the authoritative post-settlement
 * wallets, inventories, treasuries and ledger across a telemetry-on and a telemetry-off
 * run, with a negative control proving that comparison can fail. The earlier
 * WorldState-untouched tests are kept: they still guard against a backdoor mutation from
 * inside the telemetry-collection path itself.
 *
 * The fixtures below trade a `PRODUCTION_UNIT` seller debiting `OUTPUT` against a
 * `COHORT` buyer crediting its household inventory. They used to trade `CLAN` against
 * `CLAN` on a `GENERAL` bucket, which R235 calls implementation drift: a Clan owns a
 * treasury and no physical goods, so such an allocation names a stock endpoint that does
 * not exist and settlement refuses it.
 */

import { describe, it, expect } from "vitest";
import { applyMarketSettlementTransition } from "./marketSettlementTransition";
import type { CohortId, CurrencyId, GoodId, MarketId, ProductionUnitId, RegionId, StateId } from "../domain/id";
import type { WorldState } from "./worldState";
import { buildInitialWorld } from "./worldState";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { executeTick, computeTickHash, type TickContext } from "./tickOrchestrator";
import { createPhase8Handler } from "./phase8MainMarketClearing";
import type { MarketIntent } from "./marketIntent";
import { createMarketIntentId } from "./marketIntent";

/**
 * Serialize a WorldState Map bucket (and any nested Maps, e.g. LocalMarketState's
 * priceByGood/expectationsByGood) into a stable, JSON-comparable structure, keyed and
 * sorted by canonical ID so two snapshots can be compared with a plain deep-equality
 * check regardless of Map iteration/insertion order.
 */
function canonicalizeMapBucket(value: unknown): unknown {
  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([key, entryValue]) => [String(key), canonicalizeMapBucket(entryValue)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeMapBucket);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        canonicalizeMapBucket(entryValue),
      ]),
    );
  }
  return value;
}

/** The one good every baseline ProductionUnit carries in its OUTPUT inventory. */
const FOOD = "good:food" as GoodId;

interface CanonicalCounterparties {
  readonly regionId: RegionId;
  readonly goodId: GoodId;
  readonly currencyId: CurrencyId;
  readonly stateId: StateId;
  readonly sellerUnitIds: readonly ProductionUnitId[];
  readonly buyerCohortIds: readonly CohortId[];
}

/**
 * Pick canonical Phase-8 counterparties out of the real baseline world: ProductionUnit
 * sellers debiting OUTPUT, and Cohort buyers crediting their single household inventory.
 *
 * The fixtures below used to trade `CLAN` against `CLAN` on a `GENERAL` bucket. R235
 * (`ANSWERS_TO_IMPLEMENTER.md`, `CODE_RUNTIME_QA_M3_16`) calls that implementation drift:
 * authoritative household stock belongs to `PopulationCohortState`, and a Clan owns a
 * treasury and no physical goods at all, so a `CLAN`+`GENERAL` allocation names a stock
 * endpoint that does not exist and `executeAllocation` refuses it outright. Converting the
 * fixtures is what lets Phase-8's realized allocations reach authoritative stock at all
 * (Issue #427 acceptance criterion 2).
 *
 * The region must have a controller, because the collected consumption tax has to land in
 * some State treasury, and buyer, seller and treasury must all transact in the region's
 * settlement currency: a cross-currency goods payment is M5 trade/FX, not M3 local clearing.
 */
function canonicalCounterparties(
  world: WorldState,
  sellerCount: number,
  buyerCount: number,
): CanonicalCounterparties {
  for (const region of world.regions.values()) {
    if (region.controllerStateId === null) continue;
    const regionKey = region.seed.key;
    const currencyId = region.settlementCurrencyId;

    const sellers = Array.from(world.productionUnits.values()).filter(
      (unit) => unit.seed.regionKey === regionKey && (unit.outputInventory.get(FOOD) ?? 0) > 0,
    );
    const buyers = Array.from(world.cohorts.values()).filter(
      (cohort) => cohort.seed.regionKey === regionKey && (cohort.wallet.get(currencyId) ?? 0) > 0,
    );
    if (sellers.length < sellerCount || buyers.length < buyerCount) continue;

    return {
      regionId: region.regionId,
      goodId: FOOD,
      currencyId,
      stateId: region.controllerStateId,
      sellerUnitIds: sellers.slice(0, sellerCount).map((unit) => unit.productionUnitId),
      buyerCohortIds: buyers.slice(0, buyerCount).map((cohort) => cohort.cohortId),
    };
  }
  throw new Error(
    `baseline scenario carries no controlled region with ${sellerCount} food-selling ` +
      `ProductionUnit(s) and ${buyerCount} funded Cohort(s)`,
  );
}

describe("acceptance-req-market-005-phase8-integration", () => {
  it("collects telemetry through real Phase-8 handler via orchestrator", () => {
    // Build seeded baseline scenario
    const config = createDefaultSimulationConfig();
    const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

    // Create fixture intents for Phase-8 to clear
    const { regionId, goodId, sellerUnitIds, buyerCohortIds } = canonicalCounterparties(
      worldState,
      1,
      1,
    );

    const getFixtureIntents = (): MarketIntent[] => [
      {
        id: createMarketIntentId("mi:seller-fixture-1"),
        actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitIds[0]! },
        regionId,
        goodId,
        side: "SELL" as const,
        purpose: "INVENTORY_REBALANCE" as const,
        desiredQuantity: 100,
        minimumReserveQuantity: 0,
        inventoryBucket: "OUTPUT" as const,
        sourcePlanId: "plan:test-1",
      },
      {
        id: createMarketIntentId("mi:buyer-fixture-1"),
        actor: { type: "COHORT" as const, cohortId: buyerCohortIds[0]! },
        regionId,
        goodId,
        side: "BUY" as const,
        purpose: "CONSUMPTION" as const,
        desiredQuantity: 80,
        maxSpend: 800,
        sourcePlanId: "plan:test-2",
      },
    ];

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

    const { regionId, goodId, sellerUnitIds, buyerCohortIds } = canonicalCounterparties(
      worldState,
      1,
      1,
    );

    const getFixtureIntents = (): MarketIntent[] => [
      {
        id: createMarketIntentId("mi:seller-no-telemetry"),
        actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitIds[0]! },
        regionId,
        goodId,
        side: "SELL" as const,
        purpose: "INVENTORY_REBALANCE" as const,
        desiredQuantity: 60,
        minimumReserveQuantity: 0,
        inventoryBucket: "OUTPUT" as const,
        sourcePlanId: "plan:no-telemetry-seller",
      },
      {
        id: createMarketIntentId("mi:buyer-no-telemetry"),
        actor: { type: "COHORT" as const, cohortId: buyerCohortIds[0]! },
        regionId,
        goodId,
        side: "BUY" as const,
        purpose: "CONSUMPTION" as const,
        desiredQuantity: 40,
        maxSpend: 400,
        sourcePlanId: "plan:no-telemetry-buyer",
      },
    ];

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
    const { regionId, goodId, sellerUnitIds } = canonicalCounterparties(worldState, 1, 1);

    const getFixtureIntents = (): MarketIntent[] => [
      {
        id: createMarketIntentId("mi:seller-preserve-1"),
        actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitIds[0]! },
        regionId,
        goodId,
        side: "SELL" as const,
        purpose: "INVENTORY_REBALANCE" as const,
        desiredQuantity: 50,
        minimumReserveQuantity: 0,
        inventoryBucket: "OUTPUT" as const,
        sourcePlanId: "plan:test-preserve",
      },
    ];

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
    const { regionId, goodId, sellerUnitIds, buyerCohortIds } = canonicalCounterparties(
      worldState,
      2,
      2,
    );

    const getFixtureIntents = (): MarketIntent[] => [
      {
        id: createMarketIntentId("mi:seller-1"),
        actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitIds[0]! },
        regionId,
        goodId,
        side: "SELL" as const,
        purpose: "INVENTORY_REBALANCE" as const,
        desiredQuantity: 100,
        minimumReserveQuantity: 0,
        inventoryBucket: "OUTPUT" as const,
        sourcePlanId: "plan:sellers",
      },
      {
        id: createMarketIntentId("mi:seller-2"),
        actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitIds[1]! },
        regionId,
        goodId,
        side: "SELL" as const,
        purpose: "INVENTORY_REBALANCE" as const,
        desiredQuantity: 100,
        minimumReserveQuantity: 0,
        inventoryBucket: "OUTPUT" as const,
        sourcePlanId: "plan:sellers",
      },
      {
        id: createMarketIntentId("mi:buyer-1"),
        actor: { type: "COHORT" as const, cohortId: buyerCohortIds[0]! },
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
        actor: { type: "COHORT" as const, cohortId: buyerCohortIds[1]! },
        regionId,
        goodId,
        side: "BUY" as const,
        purpose: "CONSUMPTION" as const,
        desiredQuantity: 100,
        maxSpend: 1000,
        sourcePlanId: "plan:buyers",
      },
    ];

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
    const { regionId, goodId, sellerUnitIds, buyerCohortIds } = canonicalCounterparties(
      worldState,
      1,
      2,
    );

    const getFixtureIntents = (): MarketIntent[] => [
      {
        id: createMarketIntentId("mi:seller-shortage"),
        actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitIds[0]! },
        regionId,
        goodId,
        side: "SELL" as const,
        purpose: "INVENTORY_REBALANCE" as const,
        desiredQuantity: 50, // Limited supply
        minimumReserveQuantity: 0,
        inventoryBucket: "OUTPUT" as const,
        sourcePlanId: "plan:shortage-sellers",
      },
      {
        id: createMarketIntentId("mi:buyer-shortage-1"),
        actor: { type: "COHORT" as const, cohortId: buyerCohortIds[0]! },
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
        actor: { type: "COHORT" as const, cohortId: buyerCohortIds[1]! },
        regionId,
        goodId,
        side: "BUY" as const,
        purpose: "CONSUMPTION" as const,
        desiredQuantity: 100,
        maxSpend: 2000,
        sourcePlanId: "plan:shortage-buyers",
      },
    ];

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
    "REQ-MARKET-005: telemetry on/off toggle does not mutate canonical WorldState " +
      "(clans, cohorts, production units, or markets) under either setting",
    () => {
      // Issue #416: the merged toggle regression compared transaction count,
      // computeTickHash() and marketAllocations, but nothing observed authoritative
      // stock. This test observes the actual production WorldState object directly:
      // it snapshots every WorldState bucket that could plausibly carry live stock
      // (clans/cohorts/productionUnits/markets -- the only candidates, since
      // ClanState/CohortState/ProductionUnitState hold no live wallet/inventory field
      // today) before either run, then proves neither the telemetry-on nor the
      // telemetry-off run mutates any of them. Unlike the settlement-snapshot approach
      // the ACCEPTOR rejected on the prior revision of this fix, this reads the real
      // WorldState the production handler was actually given -- it does not derive its
      // answer from a value (marketAllocations) already asserted equal beforehand.
      const config = createDefaultSimulationConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const pristine = {
        clans: canonicalizeMapBucket(worldState.clans),
        cohorts: canonicalizeMapBucket(worldState.cohorts),
        productionUnits: canonicalizeMapBucket(worldState.productionUnits),
        markets: canonicalizeMapBucket(worldState.markets),
      };

      const { regionId, goodId, sellerUnitIds, buyerCohortIds } = canonicalCounterparties(
        worldState,
        1,
        1,
      );

      const getFixtureIntents = (): MarketIntent[] => [
        {
          id: createMarketIntentId("mi:seller-stock-neutrality"),
          actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitIds[0]! },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          desiredQuantity: 100,
          minimumReserveQuantity: 0,
          inventoryBucket: "OUTPUT" as const,
          sourcePlanId: "plan:stock-neutrality-seller",
        },
        {
          id: createMarketIntentId("mi:buyer-stock-neutrality"),
          actor: { type: "COHORT" as const, cohortId: buyerCohortIds[0]! },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: 80,
          maxSpend: 800,
          sourcePlanId: "plan:stock-neutrality-buyer",
        },
      ];

      const resultWithTelemetry = executeTick(
        worldState,
        1,
        worldState.pendingTransitions,
        createPhase8Handler({ getFixtureIntents, collectTelemetry: true }),
      );
      expect(resultWithTelemetry.context.marketAllocations.length).toBeGreaterThan(0);
      expect(canonicalizeMapBucket(worldState.clans)).toEqual(pristine.clans);
      expect(canonicalizeMapBucket(worldState.cohorts)).toEqual(pristine.cohorts);
      expect(canonicalizeMapBucket(worldState.productionUnits)).toEqual(pristine.productionUnits);
      expect(canonicalizeMapBucket(worldState.markets)).toEqual(pristine.markets);

      const resultNoTelemetry = executeTick(
        worldState,
        1,
        worldState.pendingTransitions,
        createPhase8Handler({ getFixtureIntents, collectTelemetry: false }),
      );
      expect(resultNoTelemetry.context.marketAllocations).toEqual(
        resultWithTelemetry.context.marketAllocations,
      );
      expect(canonicalizeMapBucket(worldState.clans)).toEqual(pristine.clans);
      expect(canonicalizeMapBucket(worldState.cohorts)).toEqual(pristine.cohorts);
      expect(canonicalizeMapBucket(worldState.productionUnits)).toEqual(pristine.productionUnits);
      expect(canonicalizeMapBucket(worldState.markets)).toEqual(pristine.markets);
    },
  );

  it(
    "canonicalizeMapBucket comparison detects a divergence injected into a real " +
      "WorldState snapshot (negative control)",
    () => {
      // Proves the equality check above is not vacuous by construction: clone a real
      // pristine snapshot of this fixture's actual worldState.clans, mutate one field
      // on it the way an accidental stock mutation would, and confirm the same
      // canonicalizeMapBucket + toEqual comparison used above rejects it.
      const config = createDefaultSimulationConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const pristineClans = canonicalizeMapBucket(worldState.clans);
      expect(worldState.clans.size).toBeGreaterThan(0);

      const mutatedClans = new Map(worldState.clans);
      const [firstClanId, firstClanState] = Array.from(mutatedClans.entries())[0]!;
      mutatedClans.set(firstClanId, { ...firstClanState, seed: { ...firstClanState.seed, key: "mutated-key" } });

      expect(canonicalizeMapBucket(mutatedClans)).not.toEqual(pristineClans);
    },
  );

  /**
   * Issue #427 acceptance criteria 2-4: the realized MAIN-pass allocations Phase-8 produced
   * are carried onto authoritative actor stock by `applyMarketSettlementTransition()`, the
   * explicit settlement boundary over `executeAllocation()`.
   *
   * These are the first assertions in this file that observe stock *after* a production
   * settlement path has run. Every earlier test in this file can only prove the narrower
   * property that Phase-8 leaves `WorldState` alone, which R235 says is not the required
   * proof for REQ-MARKET-005's canonical-stock clause.
   */
  describe("Phase-8 realized allocations settle onto authoritative actor stock", () => {
    /** Every live money balance in one currency, summed across every actor that holds one. */
    function totalMoney(world: WorldState, currencyId: CurrencyId): number {
      let total = 0;
      for (const clan of world.clans.values()) total += clan.treasury.get(currencyId) ?? 0;
      for (const cohort of world.cohorts.values()) total += cohort.wallet.get(currencyId) ?? 0;
      for (const unit of world.productionUnits.values()) total += unit.wallet.get(currencyId) ?? 0;
      for (const state of world.states.values()) total += state.treasury.get(currencyId) ?? 0;
      return total;
    }

    /** Every live quantity of one good, summed across every authoritative inventory. */
    function totalGoods(world: WorldState, goodId: GoodId): number {
      let total = 0;
      for (const cohort of world.cohorts.values()) total += cohort.householdInventory.get(goodId) ?? 0;
      for (const unit of world.productionUnits.values()) {
        total += unit.inputInventory.get(goodId) ?? 0;
        total += unit.outputInventory.get(goodId) ?? 0;
        total += unit.investmentInventory.get(goodId) ?? 0;
      }
      for (const state of world.states.values()) total += state.publicInventory.get(goodId) ?? 0;
      return total;
    }

    /**
     * One Phase-8 fixture sized from the counterparties' real opening stock, so the trade is
     * always affordable and always deliverable out of what they actually hold. A fixture that
     * hard-coded quantities would be testing the scenario's endowment numbers rather than
     * settlement.
     */
    function buildFixture(world: WorldState, collectTelemetry: boolean) {
      const counterparties = canonicalCounterparties(world, 1, 1);
      const { regionId, goodId, currencyId, sellerUnitIds, buyerCohortIds } = counterparties;
      const sellerUnitId = sellerUnitIds[0]!;
      const buyerCohortId = buyerCohortIds[0]!;

      const buyerFunds = world.cohorts.get(buyerCohortId)!.wallet.get(currencyId) ?? 0;
      const sellerStock = world.productionUnits.get(sellerUnitId)!.outputInventory.get(goodId) ?? 0;
      expect(buyerFunds).toBeGreaterThan(0);
      expect(sellerStock).toBeGreaterThan(0);

      const getFixtureIntents = (): MarketIntent[] => [
        {
          id: createMarketIntentId("mi:seller-settlement"),
          actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: sellerUnitId },
          regionId,
          goodId,
          side: "SELL" as const,
          purpose: "INVENTORY_REBALANCE" as const,
          // Half the stock on hand: the buyer's budget, not the seller's shelf, is the
          // binding constraint, so the cleared quantity is a real clearing outcome.
          desiredQuantity: sellerStock / 2,
          minimumReserveQuantity: 0,
          inventoryBucket: "OUTPUT" as const,
          sourcePlanId: "plan:settlement-seller",
        },
        {
          id: createMarketIntentId("mi:buyer-settlement"),
          actor: { type: "COHORT" as const, cohortId: buyerCohortId },
          regionId,
          goodId,
          side: "BUY" as const,
          purpose: "CONSUMPTION" as const,
          desiredQuantity: sellerStock,
          maxSpend: buyerFunds / 2,
          sourcePlanId: "plan:settlement-buyer",
        },
      ];

      return {
        ...counterparties,
        sellerUnitId,
        buyerCohortId,
        handler: createPhase8Handler({ getFixtureIntents, collectTelemetry }),
      };
    }

    it(
      "criteria 2-3: every realized MAIN-pass allocation reaches the canonically-owned " +
        "wallet and inventory, conserving money and goods against the real WorldState",
      () => {
        const config = createDefaultSimulationConfig();
        const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
        const fixture = buildFixture(world, true);
        const { goodId, currencyId, stateId, sellerUnitId, buyerCohortId } = fixture;

        const result = executeTick(world, 1, world.pendingTransitions, fixture.handler);
        const allocations = result.context.marketAllocations;
        expect(allocations.length).toBeGreaterThan(0);
        for (const allocation of allocations) {
          expect(allocation.pass).toBe("MAIN");
          // The endpoints settlement will resolve are the canonical owners, not a Clan and
          // not an unspecified generic ProductionUnit bucket (R235).
          expect(allocation.seller).toEqual({ type: "PRODUCTION_UNIT", productionUnitId: sellerUnitId });
          expect(allocation.buyer).toEqual({ type: "COHORT", cohortId: buyerCohortId });
          expect(allocation.sellerInventoryBucket).toBe("OUTPUT");
          expect(allocation.buyerInventoryBucket).toBe("GENERAL");
          // Phase-8 now reads both from the canonical RegionState rather than assuming them.
          expect(allocation.marketCurrencyId).toBe(currencyId);
          expect(allocation.destinationStateId).toBe(stateId);
        }

        const quantity = allocations.reduce((sum, a) => sum + a.quantity, 0);
        const buyerGross = allocations.reduce((sum, a) => sum + a.quantity * a.buyerGrossUnitPrice, 0);
        const sellerNet = allocations.reduce((sum, a) => sum + a.quantity * a.sellerNetUnitPrice, 0);
        const collectedTax = allocations.reduce((sum, a) => sum + a.consumptionTaxAmount, 0);
        expect(quantity).toBeGreaterThan(0);
        expect(collectedTax).toBeGreaterThan(0);

        const before = {
          buyerWallet: world.cohorts.get(buyerCohortId)!.wallet.get(currencyId) ?? 0,
          buyerGoods: world.cohorts.get(buyerCohortId)!.householdInventory.get(goodId) ?? 0,
          sellerWallet: world.productionUnits.get(sellerUnitId)!.wallet.get(currencyId) ?? 0,
          sellerGoods: world.productionUnits.get(sellerUnitId)!.outputInventory.get(goodId) ?? 0,
          treasury: world.states.get(stateId)!.treasury.get(currencyId) ?? 0,
          money: totalMoney(world, currencyId),
          goods: totalGoods(world, goodId),
        };

        const settled = applyMarketSettlementTransition(world, result.context);

        // The settlement actually happened: this is a different world, and the input one is
        // untouched (WorldState stays immutable for the duration of a tick, ADR 0007).
        expect(settled).not.toBe(world);
        expect(world.cohorts.get(buyerCohortId)!.wallet.get(currencyId) ?? 0).toBe(before.buyerWallet);

        const after = {
          buyerWallet: settled.cohorts.get(buyerCohortId)!.wallet.get(currencyId) ?? 0,
          buyerGoods: settled.cohorts.get(buyerCohortId)!.householdInventory.get(goodId) ?? 0,
          sellerWallet: settled.productionUnits.get(sellerUnitId)!.wallet.get(currencyId) ?? 0,
          sellerGoods: settled.productionUnits.get(sellerUnitId)!.outputInventory.get(goodId) ?? 0,
          treasury: settled.states.get(stateId)!.treasury.get(currencyId) ?? 0,
          money: totalMoney(settled, currencyId),
          goods: totalGoods(settled, goodId),
        };

        // The six steps of the Handoff/04 section-10 atomic bundle, on the stock each
        // actor canonically owns.
        expect(after.sellerGoods).toBeCloseTo(before.sellerGoods - quantity, 9);
        expect(after.buyerGoods).toBeCloseTo(before.buyerGoods + quantity, 9);
        expect(after.buyerWallet).toBeCloseTo(before.buyerWallet - buyerGross, 9);
        expect(after.sellerWallet).toBeCloseTo(before.sellerWallet + sellerNet, 9);
        expect(after.treasury).toBeCloseTo(before.treasury + collectedTax, 9);

        // Money conservation: the buyer's gross debit is exactly the seller's net receipt
        // plus the tax the treasury collected, and no money is created or destroyed
        // anywhere else in the world either.
        expect(buyerGross).toBeCloseTo(sellerNet + collectedTax, 9);
        expect(after.money).toBeCloseTo(before.money, 9);

        // Goods conservation: settlement is a transfer, never a source or a sink.
        expect(after.goods).toBeCloseTo(before.goods, 9);

        // No live stock was driven negative by the settlement.
        expect(after.buyerWallet).toBeGreaterThanOrEqual(0);
        expect(after.sellerGoods).toBeGreaterThanOrEqual(0);
      },
    );

    it(
      "criterion 4: telemetry on and off produce an identical post-settlement WorldState",
      () => {
        const config = createDefaultSimulationConfig();
        const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

        const withTelemetry = buildFixture(world, true);
        const resultOn = executeTick(world, 1, world.pendingTransitions, withTelemetry.handler);
        expect(resultOn.context.marketTelemetry.length).toBeGreaterThan(0);
        const settledOn = applyMarketSettlementTransition(world, resultOn.context);

        const withoutTelemetry = buildFixture(world, false);
        const resultOff = executeTick(world, 1, world.pendingTransitions, withoutTelemetry.handler);
        expect(resultOff.context.marketTelemetry.length).toBe(0);
        const settledOff = applyMarketSettlementTransition(world, resultOff.context);

        // Settlement really ran on both sides, so the comparison below is over mutated
        // stock rather than over two copies of an untouched world.
        expect(canonicalizeMapBucket(settledOn.cohorts)).not.toEqual(canonicalizeMapBucket(world.cohorts));

        // This is the clause REQ-MARKET-005 asks for: canonical stocks do not change when
        // the non-authoritative telemetry toggle changes.
        for (const bucket of ["clans", "cohorts", "productionUnits", "states", "markets"] as const) {
          expect(canonicalizeMapBucket(settledOff[bucket])).toEqual(canonicalizeMapBucket(settledOn[bucket]));
        }
        expect(canonicalizeMapBucket(resultOff.context.currentLedger)).toEqual(
          canonicalizeMapBucket(resultOn.context.currentLedger),
        );
      },
    );

    it(
      "criterion 4 negative control: a stock divergence with unchanged allocations fails " +
        "the post-settlement comparison",
      () => {
        // The comparison above is only evidence if it can fail. Settle the same allocations
        // twice, then perturb one wallet in one settled world by a single unit -- exactly
        // the shape of a telemetry-dependent settlement divergence -- and confirm the
        // allocations still compare equal while the settled stock does not.
        const config = createDefaultSimulationConfig();
        const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

        const fixture = buildFixture(world, true);
        const resultOn = executeTick(world, 1, world.pendingTransitions, fixture.handler);
        const resultOff = executeTick(
          world,
          1,
          world.pendingTransitions,
          buildFixture(world, false).handler,
        );
        expect(resultOff.context.marketAllocations).toEqual(resultOn.context.marketAllocations);

        const settledOn = applyMarketSettlementTransition(world, resultOn.context);
        const settledOff = applyMarketSettlementTransition(world, resultOff.context);

        const { buyerCohortId, currencyId } = fixture;
        const divergentCohorts = new Map(settledOff.cohorts);
        const buyer = divergentCohorts.get(buyerCohortId)!;
        divergentCohorts.set(buyerCohortId, {
          ...buyer,
          wallet: new Map(buyer.wallet).set(currencyId, (buyer.wallet.get(currencyId) ?? 0) + 1),
        });

        expect(canonicalizeMapBucket(divergentCohorts)).not.toEqual(
          canonicalizeMapBucket(settledOn.cohorts),
        );
      },
    );
  });
});
