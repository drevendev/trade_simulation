/**
 * M5 / #676: real paid cross-currency dispatch and future Phase-1 delivery
 * must preserve the *inventory bucket*, not merely actor/global goods totals.
 *
 * Other M5 goldens cover cash, tariffs and FX. This test closes a different
 * false-negative: moving cargo from INPUT to OUTPUT/INVESTMENT can leave the
 * beneficial owner, journal and aggregate physical goods unchanged.
 */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario } from "../diagnostics/m5PreviewScenario";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";
import type { ProductionUnitState, WorldState } from "./worldState";

type InventoryBucket = "inputInventory" | "outputInventory" | "investmentInventory";
const buckets: readonly InventoryBucket[] = [
  "inputInventory", "outputInventory", "investmentInventory",
];
const jurisdiction: PhaseHandler = (world, context) =>
  context.phase === 1 ? {
    ...context,
    effectiveJurisdictionByRegion: new Map([...world.regions].map(
      ([id, region]) => [id, region.controllerStateId] as const,
    )),
  } : context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
const unchanged = (_phase: number, world: WorldState) => world;

/** A stock oracle independent of shipment journal payees and aggregate totals. */
function assertBucketDeltas(
  before: WorldState, after: WorldState, cargo: TradeShipmentState,
  phase: 1 | 7,
): void {
  expect(after.productionUnits.size).toBe(before.productionUnits.size);
  for (const [id, original] of before.productionUnits) {
    const settled = after.productionUnits.get(id);
    expect(settled, "same production owner " + id).toBeDefined();
    for (const bucket of buckets) {
      const source = original[bucket];
      const destination = settled![bucket];
      const goods = new Set([...source.keys(), ...destination.keys()]);
      for (const good of goods) {
        let expected = 0;
        if (good === cargo.goodId && bucket === "inputInventory") {
          if (phase === 7 && cargo.seller.type === "PRODUCTION_UNIT" &&
              cargo.seller.productionUnitId === id) {
            expected = -cargo.quantity;
          }
          if (phase === 1 && cargo.beneficialOwner.type === "PRODUCTION_UNIT" &&
              cargo.beneficialOwner.productionUnitId === id) {
            expected = cargo.quantity;
          }
        }
        const actual = (destination.get(good) ?? 0) - (source.get(good) ?? 0);
        expect(actual, `phase ${phase}: ${id}/${bucket}/${good}`)
          .toBeCloseTo(expected, 7);
      }
    }
  }
}

function allPhysical(world: WorldState, good: TradeShipmentState["goodId"]): number {
  return [...world.productionUnits.values()].reduce(
    (sum, unit) => sum + buckets.reduce(
      (stock, bucket) => stock + (unit[bucket].get(good) ?? 0), 0,
    ), 0,
  ) + [...(world.shipments?.values() ?? [])].reduce(
    (sum, cargo) => sum + (cargo.goodId === good ? cargo.quantity : 0), 0,
  );
}

/**
 * An arrival is a physical handoff of an already-paid shipment. Its Phase-1
 * transition must not debit any actor a second time or silently transfer cash
 * between owners, even when a global per-currency sum would still reconcile.
 */
function assertNoArrivalMoneyMovement(before: WorldState, after: WorldState): void {
  expect(after.productionUnits.size).toBe(before.productionUnits.size);
  for (const [id, unit] of before.productionUnits) {
    expect(after.productionUnits.get(id)?.wallet, "unit money " + id).toEqual(unit.wallet);
  }
  expect(after.states.size).toBe(before.states.size);
  for (const [id, state] of before.states) {
    expect(after.states.get(id)?.treasury, "State treasury " + id).toEqual(state.treasury);
  }
  expect(after.clans.size).toBe(before.clans.size);
  for (const [id, clan] of before.clans) {
    expect(after.clans.get(id)?.treasury, "Clan treasury " + id).toEqual(clan.treasury);
  }
  expect(after.cohorts.size).toBe(before.cohorts.size);
  for (const [id, cohort] of before.cohorts) {
    expect(after.cohorts.get(id)?.wallet, "Cohort money " + id).toEqual(cohort.wallet);
  }
  expect(after.monetaryAuthorities.size).toBe(before.monetaryAuthorities.size);
  for (const [id, authority] of before.monetaryAuthorities) {
    const next = after.monetaryAuthorities.get(id);
    expect(next, "issuer " + id).toBeDefined();
    expect(next!.fxPools.size).toBe(authority.fxPools.size);
    for (const [poolId, pool] of authority.fxPools) {
      expect(next!.fxPools.get(poolId)?.cash, "FX cash " + id + "/" + poolId)
        .toEqual(pool.cash);
    }
  }
}

function relabelStock(
  world: WorldState, id: ProductionUnitState["productionUnitId"],
  cargo: TradeShipmentState, target: "outputInventory" | "investmentInventory",
): WorldState {
  const unit = world.productionUnits.get(id)!;
  const misrouted: ProductionUnitState = {
    ...unit,
    inputInventory: new Map(unit.inputInventory)
      .set(cargo.goodId, (unit.inputInventory.get(cargo.goodId) ?? 0) - 0.25),
    [target]: new Map(unit[target])
      .set(cargo.goodId, (unit[target].get(cargo.goodId) ?? 0) + 0.25),
  };
  return {
    ...world,
    productionUnits: new Map(world.productionUnits).set(id, misrouted),
  };
}

describe("M5 #676 paid cargo bucket-level ownership", () => {
  it("charges and dispatches once, then credits only the owner's INPUT bucket on arrival", () => {
    const scenario = createM5PreviewScenario();
    const links = [...scenario.opening.transportLinks];
    expect(links).toHaveLength(1);
    const [linkId, link] = links[0]!;
    const opening: WorldState = {
      ...scenario.opening,
      transportLinks: new Map([[linkId, { ...link, travelTicks: 2 }]]),
    };
    let beforeDispatch: WorldState | undefined;
    let afterDispatch: WorldState | undefined;
    const dispatched = executeM5AutonomousRegionalTradeTick(
      opening, 7, jurisdiction, unchanged, scenario.options,
      (phase, before, after) => {
        if (phase === 7) {
          beforeDispatch = before;
          afterDispatch = after;
        }
      },
    );
    expect(dispatched.phaseBoundaryError).toBeUndefined();
    expect(dispatched.reconciliationErrors).toBeNull();
    expect(dispatched.phaseTrace).toEqual([...Array(16).keys()]);
    const cargoList = [...(dispatched.world.shipments?.values() ?? [])];
    expect(cargoList).toHaveLength(1);
    const cargo = cargoList[0]!;
    expect(cargo.departureTick).toBe(7);
    expect(cargo.arrivalTick).toBe(9);
    expect(cargo.fxSettlementId).toBeDefined();
    expect(cargo.buyerPaymentCurrencyId).not.toBe(cargo.invoiceCurrencyId);
    expect(cargo.quantity).toBeGreaterThan(0);
    expect(cargo.seller.type).toBe("PRODUCTION_UNIT");
    expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
    expect(cargo.destinationInventoryBucket).toBe("INPUT");
    expect(beforeDispatch).toBeDefined();
    expect(afterDispatch).toBeDefined();
    assertBucketDeltas(beforeDispatch!, afterDispatch!, cargo, 7);

    if (cargo.seller.type !== "PRODUCTION_UNIT" ||
        cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
      throw new Error("Expected two real ProductionUnit stock owners");
    }
    const badDispatch = relabelStock(
      afterDispatch!, cargo.seller.productionUnitId, cargo, "outputInventory",
    );
    expect(allPhysical(badDispatch, cargo.goodId))
      .toBeCloseTo(allPhysical(afterDispatch!, cargo.goodId), 8);
    expect(() => assertBucketDeltas(beforeDispatch!, badDispatch, cargo, 7))
      .toThrow();

    const closed = { ...scenario.options, phase1TradeLawProvider: () => undefined };
    const waiting = executeM5AutonomousRegionalTradeTick(
      dispatched.world, 8, jurisdiction, unchanged, closed,
    );
    expect(waiting.phaseBoundaryError).toBeUndefined();
    expect(waiting.reconciliationErrors).toBeNull();
    expect(waiting.world.shipments?.has(cargo.id)).toBe(true);
    expect(waiting.context.transactions.filter(tx =>
      ["SHIPMENT_DELIVERY", "SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT"].includes(tx.type)
    )).toHaveLength(0);

    let beforeArrival: WorldState | undefined;
    let afterArrival: WorldState | undefined;
    const arrived = executeM5AutonomousRegionalTradeTick(
      waiting.world, 9, jurisdiction, unchanged, closed,
      (phase, before, after) => {
        if (phase === 1) {
          beforeArrival = before;
          afterArrival = after;
        }
      },
    );
    expect(arrived.phaseBoundaryError).toBeUndefined();
    expect(arrived.reconciliationErrors).toBeNull();
    expect(arrived.world.shipments?.size ?? 0).toBe(0);
    expect(arrived.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
      .toMatchObject([{
        tick: 9, phase: 1, goodId: cargo.goodId, quantity: cargo.quantity,
        destination: cargo.beneficialOwner,
        reason: "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id,
      }]);
    expect(arrived.context.transactions.filter(tx =>
      ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"].includes(tx.type)
    )).toHaveLength(0);
    expect(beforeArrival).toBeDefined();
    expect(afterArrival).toBeDefined();
    assertBucketDeltas(beforeArrival!, afterArrival!, cargo, 1);
    assertNoArrivalMoneyMovement(beforeArrival!, afterArrival!);

    // Negative control: forge a second (unrecorded) buyer-currency payment at
    // delivery. The global monetary total is unchanged, so a sum-only oracle
    // and an unchanged delivery journal would both miss the wrong owners.
    const peers = [...afterArrival!.productionUnits.values()].filter(
      unit => unit.wallet.has(cargo.buyerPaymentCurrencyId),
    );
    expect(peers.length).toBeGreaterThanOrEqual(2);
    const payer = peers.find(unit =>
      (unit.wallet.get(cargo.buyerPaymentCurrencyId) ?? 0) > 0.25);
    expect(payer).toBeDefined();
    const payee = peers.find(unit => unit.productionUnitId !== payer!.productionUnitId);
    expect(payee).toBeDefined();
    const forgedUnits = new Map(afterArrival!.productionUnits);
    const transfer = 0.25;
    for (const [owner, delta] of [[payer!, -transfer], [payee!, transfer]] as const) {
      forgedUnits.set(owner.productionUnitId, {
        ...owner,
        wallet: new Map(owner.wallet).set(
          cargo.buyerPaymentCurrencyId,
          (owner.wallet.get(cargo.buyerPaymentCurrencyId) ?? 0) + delta,
        ),
      });
    }
    const forgedPayment: WorldState = {
      ...afterArrival!, productionUnits: forgedUnits,
    };
    const sumBuyerCurrency = (world: WorldState) =>
      [...world.productionUnits.values()].reduce(
        (sum, unit) => sum + (unit.wallet.get(cargo.buyerPaymentCurrencyId) ?? 0), 0,
      );
    expect(sumBuyerCurrency(forgedPayment))
      .toBeCloseTo(sumBuyerCurrency(afterArrival!), 8);
    expect(() => assertNoArrivalMoneyMovement(beforeArrival!, forgedPayment))
      .toThrow();

    const badArrival = relabelStock(
      afterArrival!, cargo.beneficialOwner.productionUnitId, cargo, "investmentInventory",
    );
    expect(allPhysical(badArrival, cargo.goodId))
      .toBeCloseTo(allPhysical(afterArrival!, cargo.goodId), 8);
    expect(() => assertBucketDeltas(beforeArrival!, badArrival, cargo, 1))
      .toThrow();

    for (const world of [opening, dispatched.world, waiting.world, arrived.world]) {
      expect(allPhysical(world, cargo.goodId))
        .toBeCloseTo(allPhysical(opening, cargo.goodId), 7);
    }
    // No synthetic delivery or replayed charge appears after the due tick.
    const closedAgain = executeM5AutonomousRegionalTradeTick(
      arrived.world, 10, jurisdiction, unchanged, closed,
    );
    expect(closedAgain.reconciliationErrors).toBeNull();
    expect(closedAgain.context.transactions.filter(tx =>
      ["SHIPMENT_DELIVERY", "SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT"].includes(tx.type)
    )).toHaveLength(0);
  });
});
