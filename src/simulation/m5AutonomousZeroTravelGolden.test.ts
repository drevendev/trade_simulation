/**
 * M5 #676: a real, fully funded Phase-7 zero-travel shipment, not a
 * pre-paid synthetic delivery inserted by a test-only transition.
 *
 * This closes the same-tick ownership boundary: paid FX, tariff and transport
 * charges settle once, while the physical cargo goes straight to its
 * beneficial owner's INPUT inventory without surviving in-transit at close.
 */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario } from "../diagnostics/m5PreviewScenario";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";
import type { WorldState, ProductionUnitState } from "./worldState";

const upstream: PhaseHandler = (world, context) =>
  context.phase === 1 ? {
    ...context,
    effectiveJurisdictionByRegion: new Map([...world.regions].map(
      ([id, region]) => [id, region.controllerStateId] as const,
    )),
  } : context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;

const unchanged = (_phase: number, world: WorldState) => world;
const physicalStock = (unit: ProductionUnitState, good: TradeShipmentState["goodId"]) =>
  (unit.inputInventory.get(good) ?? 0) +
  (unit.outputInventory.get(good) ?? 0) +
  (unit.investmentInventory.get(good) ?? 0);

function totalCurrency(world: WorldState, currency: string): number {
  const wallets = [
    ...[...world.states.values()].map(state => state.treasury),
    ...[...world.clans.values()].map(clan => clan.treasury),
    ...[...world.cohorts.values()].map(cohort => cohort.wallet),
    ...[...world.productionUnits.values()].map(unit => unit.wallet),
    ...[...world.monetaryAuthorities.values()].flatMap(authority =>
      [...authority.fxPools.values()].map(pool => pool.cash)),
  ];
  return wallets.reduce((sum, wallet) => sum + (wallet.get(currency as never) ?? 0), 0);
}

/** Stock and cash expected from the persisted paid cargo, never its journal payees. */
function assertPaidOwnerDeltas(
  before: WorldState, after: WorldState, cargo: TradeShipmentState,
): void {
  if (cargo.seller.type !== "PRODUCTION_UNIT" ||
      cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
    throw new Error("M5 autonomous zero-travel fixture requires production-unit owners");
  }
  const sellerId = cargo.seller.productionUnitId;
  const buyerId = cargo.beneficialOwner.productionUnitId;
  expect(sellerId).not.toBe(buyerId);
  expect(cargo.destinationInventoryBucket).toBe("INPUT");
  for (const [unitId, original] of before.productionUnits) {
    const settled = after.productionUnits.get(unitId)!;
    const expectedPhysical =
      (unitId === sellerId ? -cargo.quantity : 0) +
      (unitId === buyerId ? cargo.quantity : 0);
    expect(physicalStock(settled, cargo.goodId) - physicalStock(original, cargo.goodId),
      "Phase-7 owner-bound goods " + unitId).toBeCloseTo(expectedPhysical, 8);

    const expectedBuyerDebit =
      cargo.buyerGoodsPaymentAmount + cargo.tariffAmount +
      cargo.transportFeeAmount + cargo.consumptionTaxAmount;
    const currencies = new Set([
      ...original.wallet.keys(), ...settled.wallet.keys(),
      cargo.buyerPaymentCurrencyId, cargo.invoiceCurrencyId,
    ]);
    for (const currency of currencies) {
      const expectedMoney =
        (unitId === sellerId && currency === cargo.invoiceCurrencyId
          ? cargo.sellerNetUnitPrice * cargo.quantity : 0) -
        (unitId === buyerId && currency === cargo.buyerPaymentCurrencyId
          ? expectedBuyerDebit : 0);
      expect((settled.wallet.get(currency) ?? 0) - (original.wallet.get(currency) ?? 0),
        "Phase-7 owner-bound cash " + unitId + "/" + currency)
        .toBeCloseTo(expectedMoney, 6);
    }
  }
  const priorBuyer = before.productionUnits.get(buyerId)!;
  const paidBuyer = after.productionUnits.get(buyerId)!;
  expect((paidBuyer.inputInventory.get(cargo.goodId) ?? 0) -
    (priorBuyer.inputInventory.get(cargo.goodId) ?? 0))
    .toBeCloseTo(cargo.quantity, 8);
}

describe("M5 #676 autonomous paid zero-travel cross-currency arrival", () => {
  it("settles FX and charges once, delivers in Phase 7 and refuses balanced wrong-owner mutations", () => {
    const fixture = createM5PreviewScenario();
    const links = [...fixture.opening.transportLinks];
    expect(links).toHaveLength(1);
    const [linkId, link] = links[0]!;
    const opening: WorldState = {
      ...fixture.opening,
      transportLinks: new Map([[linkId, { ...link, travelTicks: 0 }]]),
    };
    let beforePhase7: WorldState | undefined;
    let afterPhase7: WorldState | undefined;
    const result = executeM5AutonomousRegionalTradeTick(
      opening, 7, upstream, unchanged, fixture.options,
      (phase, before, after) => {
        if (phase === 7) {
          beforePhase7 = before;
          afterPhase7 = after;
        }
      },
    );
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(beforePhase7).toBeDefined();
    expect(afterPhase7).toBeDefined();

    const cargo = result.context.phase7DispatchedShipments ?? [];
    expect(cargo).toHaveLength(1);
    const paid = cargo[0]!;
    expect(paid.travelTicksAtDispatch).toBe(0);
    expect(paid.departureTick).toBe(7);
    expect(paid.arrivalTick).toBe(7);
    expect(paid.quantity).toBeGreaterThan(0);
    expect(paid.fxSettlementId).toBeDefined();
    expect(paid.buyerPaymentCurrencyId).not.toBe(paid.invoiceCurrencyId);
    expect(result.world.shipments?.size ?? 0).toBe(0);

    const phase7 = result.context.transactions.filter(tx => tx.phase === 7);
    const ofType = (type: string) => phase7.filter(tx => tx.type === type);
    expect(ofType("SHIPMENT_DISPATCH")).toHaveLength(1);
    expect(ofType("FX_INPUT")).toHaveLength(1);
    expect(ofType("FX_OUTPUT")).toHaveLength(1);
    expect(ofType("IMPORT_TARIFF")).toHaveLength(1);
    expect(ofType("TRANSPORT_FEE")).toHaveLength(1);
    expect(ofType("CONSUMPTION_TAX")).toHaveLength(1);
    const delivery = ofType("SHIPMENT_DELIVERY");
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({
      tick: 7, phase: 7, goodId: paid.goodId, quantity: paid.quantity,
      destination: paid.beneficialOwner,
      reason: "IN_TRANSIT_TO_INPUT_STOCK:" + paid.id,
    });
    expect(delivery[0]!.moneyAmount).toBeUndefined();
    expect(ofType("FX_INPUT")[0]!.source).toEqual(paid.beneficialOwner);
    expect(ofType("FX_OUTPUT")[0]!.destination).toEqual(paid.seller);
    expect(ofType("FX_INPUT")[0]!.fxSettlementId).toBe(paid.fxSettlementId);
    expect(ofType("FX_OUTPUT")[0]!.fxSettlementId).toBe(paid.fxSettlementId);

    assertPaidOwnerDeltas(beforePhase7!, afterPhase7!, paid);
    for (const currency of [paid.invoiceCurrencyId, paid.buyerPaymentCurrencyId]) {
      expect(totalCurrency(afterPhase7!, currency))
        .toBeCloseTo(totalCurrency(beforePhase7!, currency), 5);
    }

    // A balanced misdelivery does not change the total physical goods or
    // journal, but MUST fail the per-beneficiary stock oracle.
    if (paid.beneficialOwner.type !== "PRODUCTION_UNIT") {
      throw new Error("Expected a ProductionUnit buyer");
    }
    const recipientId = paid.beneficialOwner.productionUnitId;
    const otherId = [...afterPhase7!.productionUnits.keys()].find(id =>
      id !== recipientId && !(paid.seller.type === "PRODUCTION_UNIT" &&
        id === paid.seller.productionUnitId));
    expect(otherId).toBeDefined();
    const forged = new Map(afterPhase7!.productionUnits);
    for (const [id, delta] of [
      [recipientId, -paid.quantity / 4],
      [otherId!, paid.quantity / 4],
    ] as const) {
      const unit = forged.get(id)!;
      forged.set(id, { ...unit, inputInventory: new Map(unit.inputInventory)
        .set(paid.goodId, (unit.inputInventory.get(paid.goodId) ?? 0) + delta) });
    }
    expect(() => assertPaidOwnerDeltas(beforePhase7!, {
      ...afterPhase7!, productionUnits: forged,
    }, paid)).toThrow();

    // Closing the border next tick must not deliver a phantom second time,
    // charge FX again, or collect a duplicate tariff.
    const next = executeM5AutonomousRegionalTradeTick(
      result.world, 8, upstream, unchanged,
      { ...fixture.options, phase1TradeLawProvider: () => undefined },
    );
    expect(next.phaseBoundaryError).toBeUndefined();
    expect(next.reconciliationErrors).toBeNull();
    expect(next.world.shipments?.size ?? 0).toBe(0);
    expect(next.context.transactions.filter(tx => [
      "SHIPMENT_DELIVERY", "SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT",
      "IMPORT_TARIFF", "TRANSPORT_FEE",
    ].includes(tx.type))).toHaveLength(0);
    expect(opening.shipments?.size ?? 0).toBe(0);
  });
});
