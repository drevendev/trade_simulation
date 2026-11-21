/**
 * M5 / #676: 240 complete 16-phase ticks with real paid FX cargo attrition.
 * Unlike the existing lossless 600-tick replay, this proves that recurring
 * physical destruction is charged ONCE at dispatch and never on arrival.
 * Border and routine-loss policy change while previously paid cargo is in
 * flight; actual deliveries retain their original owner and quantity.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { GoodId } from "../domain/id";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler, EconomicTransaction } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";
import { cargoCapacityUse, effectiveTransportLinkCapacity } from "./transportCapacity";
import type { WorldState } from "./worldState";

const IRON = "good:iron" as GoodId;
const upstream: PhaseHandler = (world, context) =>
  context.phase === 1
    ? { ...context, effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
    ) }
    : context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
const unchanged = (_phase: number, world: WorldState) => world;

function iron(world: WorldState): number {
  let stock = 0;
  for (const unit of world.productionUnits.values()) {
    stock += (unit.inputInventory.get(IRON) ?? 0) +
      (unit.outputInventory.get(IRON) ?? 0) + (unit.investmentInventory.get(IRON) ?? 0);
  }
  for (const state of world.states.values()) stock += state.publicInventory.get(IRON) ?? 0;
  for (const cohort of world.cohorts.values()) stock += cohort.householdInventory.get(IRON) ?? 0;
  for (const cargo of world.shipments?.values() ?? []) {
    if (cargo.goodId === IRON) stock += cargo.quantity;
  }
  return stock;
}

function currencyTotal(world: WorldState, currency: string): number {
  const wallets = [
    ...[...world.states.values()].map(x => x.treasury),
    ...[...world.clans.values()].map(x => x.treasury),
    ...[...world.cohorts.values()].map(x => x.wallet),
    ...[...world.productionUnits.values()].map(x => x.wallet),
    ...[...world.monetaryAuthorities.values()].flatMap(x =>
      [...x.fxPools.values()].map(pool => pool.cash)),
  ];
  return wallets.reduce((sum, wallet) => sum + (wallet.get(currency as never) ?? 0), 0);
}

/** Reverse unordered IDs and nested economic stores, not ordered route arrays. */
function shuffled(world: WorldState): WorldState {
  const rev = <K, V>(map: ReadonlyMap<K, V>): Map<K, V> => new Map([...map].reverse());
  return {
    ...world,
    states: new Map([...world.states].reverse().map(([id, x]) =>
      [id, { ...x, treasury: rev(x.treasury), publicInventory: rev(x.publicInventory) }] as const)),
    regions: new Map([...world.regions].reverse().map(([id, x]) =>
      [id, { ...x, resourceDeposits: rev(x.resourceDeposits) }] as const)),
    currencies: rev(world.currencies),
    markets: new Map([...world.markets].reverse().map(([id, x]) =>
      [id, { ...x, priceByGood: rev(x.priceByGood),
        expectationsByGood: rev(x.expectationsByGood) }] as const)),
    productionUnits: new Map([...world.productionUnits].reverse().map(([id, x]) =>
      [id, { ...x, wallet: rev(x.wallet), inputInventory: rev(x.inputInventory),
        outputInventory: rev(x.outputInventory),
        investmentInventory: rev(x.investmentInventory) }] as const)),
    clans: new Map([...world.clans].reverse().map(([id, x]) =>
      [id, { ...x, treasury: rev(x.treasury) }] as const)),
    cohorts: new Map([...world.cohorts].reverse().map(([id, x]) =>
      [id, { ...x, wallet: rev(x.wallet), householdInventory: rev(x.householdInventory) }] as const)),
    monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(([id, x]) =>
      [id, { ...x, fxPools: new Map([...x.fxPools].reverse().map(([poolId, pool]) =>
        [poolId, { ...pool, cash: rev(pool.cash) }] as const)) }] as const)),
    transportLinks: rev(world.transportLinks),
    ...(world.shipments ? { shipments: rev(world.shipments) } : {}),
    ...(world.outgoingTransportLinkIdsByRegion
      ? { outgoingTransportLinkIdsByRegion: rev(world.outgoingTransportLinkIdsByRegion) } : {}),
  };
}

/** Stable economic replay fingerprint independent of JS Map insertion order. */
function normalized(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([key, item]) =>
    [String(key), normalized(item)] as const).sort(([a], [b]) => a.localeCompare(b));
  if (value instanceof Set) return [...value].map(normalized).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}
function replayHash(world: WorldState, transactions: readonly EconomicTransaction[]): string {
  return createHash("sha256").update(JSON.stringify(normalized({ world, transactions }))).digest("hex");
}

function assertDeliveryOwners(
  before: WorldState, after: WorldState, due: readonly TradeShipmentState[],
): void {
  for (const [id, unit] of before.productionUnits) {
    const expected = due.reduce((sum, cargo) =>
      sum + (cargo.goodId === IRON && cargo.beneficialOwner.type === "PRODUCTION_UNIT" &&
        cargo.beneficialOwner.productionUnitId === id ? cargo.quantity : 0), 0);
    const next = after.productionUnits.get(id)!;
    expect((next.inputInventory.get(IRON) ?? 0) - (unit.inputInventory.get(IRON) ?? 0))
      .toBeCloseTo(expected, 6);
  }
}

function assertLossReconciliation(
  before: WorldState, after: WorldState, journal: readonly EconomicTransaction[],
): void {
  const destroyed = journal.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS");
  expect(iron(before) - iron(after)).toBeCloseTo(
    destroyed.reduce((sum, tx) => sum + tx.quantity!, 0), 6);
  for (const tx of destroyed) {
    expect(tx.phase).toBe(7);
    expect(tx.goodId).toBe(IRON);
    expect(tx.quantity).toBeGreaterThan(0);
    expect(tx.moneyAmount).toBeUndefined();
    expect(tx.currencyId).toBeUndefined();
  }
}

describe("M5 #676: 240-tick paid FX attrition and delayed-arrival replay", () => {
  it("conserves owner-bound paid cargo and cumulative loss across changing border policy", () => {
    const fixture = createM5PreviewScenario();
    const [linkId, link] = [...fixture.opening.transportLinks][0]!;
    expect(fixture.opening.transportLinks.size).toBe(1);
    const initial: WorldState = {
      ...fixture.opening,
      transportLinks: new Map([[linkId, { ...link, travelTicks: 3,
        seed: { ...link.seed, routinePhysicalLossRate: 0.25 } }]]),
    };
    const policyAt = (world: WorldState, rate: number): WorldState => {
      const current = world.transportLinks.get(linkId)!;
      return { ...world, transportLinks: new Map(world.transportLinks).set(linkId,
        { ...current, seed: { ...current.seed, routinePhysicalLossRate: rate } }) };
    };
    const currencyBaselines = new Map([...initial.currencies.keys()].map(
      id => [id, currencyTotal(initial, id)] as const));
    let standard = initial;
    let reverse = shuffled(initial);
    let destroyedTotal = 0;
    let sent = 0;
    let checkedPaidCapacity = false;
    let rejectedOverCapacity = false;
    let delivered = 0;
    let blockedWithLocalSale = 0;
    let sawBadLossReject = false;
    let sawWrongDeliveryReject = false;
    let sawWrongTransitReject = false;
    const sentIds = new Set<string>();
    const deliveredIds = new Set<string>();
    // Evidence must include actual paid, positive-loss dispatch for BOTH policy
    // values. A 240-tick loop with a single opening shipment is not a witness.
    const openingWitnesses = new Map<number, {
      rate: number; paidCargoCount: number; physicalLossQuantity: number;
    }>();

    for (let offset = 0; offset < 240; offset++) {
      const tick = M5_PREVIEW_TICK + offset;
      const open = offset % 12 === 0;
      // The route's present policy must NOT revalue a previously paid shipment.
      const rate = open ? (offset % 24 === 0 ? 0.25 : 0.10) : 0;
      standard = policyAt(standard, rate);
      reverse = policyAt(reverse, rate);
      const start = standard;
      const due = [...start.shipments?.values() ?? []].filter(
        cargo => cargo.arrivalTick === tick);
      const preexisting = new Set(start.shipments?.keys());
      let beforePhase1: WorldState | undefined;
      let afterPhase1: WorldState | undefined;
      let beforePhase7: WorldState | undefined;
      let afterPhase7: WorldState | undefined;
      const options = open ? fixture.options : {
        ...fixture.options, phase1TradeLawProvider: () => undefined,
      };
      const actual = executeM5AutonomousRegionalTradeTick(
        standard, tick, upstream, unchanged, options, (phase, before, after) => {
          if (phase === 1) { beforePhase1 = before; afterPhase1 = after; }
          if (phase === 7) { beforePhase7 = before; afterPhase7 = after; }
        },
      );
      const replay = executeM5AutonomousRegionalTradeTick(
        reverse, tick, upstream, unchanged, options,
      );
      for (const result of [actual, replay]) {
        expect(result.phaseTrace, `tick ${tick}: all phases`)
          .toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
        expect(iron(result.world)).toBeCloseTo(iron(start) -
          actual.context.transactions.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS")
            .reduce((sum, tx) => sum + tx.quantity!, 0), 6);
        for (const [currency, initialCash] of currencyBaselines) {
          expect(currencyTotal(result.world, currency)).toBeCloseTo(initialCash, 5);
        }
      }
      expect(replay.context.transactions).toEqual(actual.context.transactions);
      expect(replayHash(replay.world, replay.context.transactions))
        .toBe(replayHash(actual.world, actual.context.transactions));
      const journal = actual.context.transactions;
      assertLossReconciliation(start, actual.world, journal);
      const losses = journal.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS");
      destroyedTotal += losses.reduce((sum, tx) => sum + tx.quantity!, 0);
      expect(iron(actual.world)).toBeCloseTo(iron(initial) - destroyedTotal, 6);
      const incoming = journal.filter(tx => tx.type === "SHIPMENT_DELIVERY");
      const fresh = [...actual.world.shipments?.values() ?? []].filter(
        cargo => !preexisting.has(cargo.id));
      const dispatched = journal.filter(tx =>
        tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH");
      // Capacity is consumed by goods loaded at the origin, BEFORE routine
      // loss reduces the in-transit cargo. Checking surviving cargo alone
      // would permit overbooking a damaged route without detecting it.
      const link = start.transportLinks.get(linkId)!;
      const factor = options.infrastructureFactors.get(linkId);
      expect(factor).toBeDefined();
      const weight = start.definitionRegistry.goods[IRON]?.cargoWeightPerUnit;
      expect(weight).toBeGreaterThan(0);
      const physicalCapacity = effectiveTransportLinkCapacity(link, factor!);
      const sales = journal.filter(tx =>
        tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
      const assertGrossCapacity = (quantities: readonly number[]): void => {
        const loaded = quantities.reduce((sum, quantity) =>
          sum + cargoCapacityUse(quantity, weight!), 0);
        expect(loaded, `tick ${tick}: gross loaded link capacity`)
          .toBeLessThanOrEqual(physicalCapacity + 1e-8);
      };
      assertGrossCapacity(sales.map(tx => tx.quantity!));
      if (sales.length && !rejectedOverCapacity) {
        // Negative control: make the sale exceed the real physical ceiling.
        // A net-of-transport-loss capacity oracle would miss this forgery.
        const forged = [physicalCapacity / weight! + 1,
          ...sales.slice(1).map(tx => tx.quantity!)];
        expect(() => assertGrossCapacity(forged)).toThrow();
        rejectedOverCapacity = true;
      }
      if (sales.length) checkedPaidCapacity = true;
      if (open) {
        openingWitnesses.set(tick, {
          rate, paidCargoCount: fresh.length,
          physicalLossQuantity: losses.reduce((sum, tx) => sum + tx.quantity!, 0),
        });
      }
      const inputs = journal.filter(tx => tx.phase === 7 && tx.type === "FX_INPUT");
      const outputs = journal.filter(tx => tx.phase === 7 && tx.type === "FX_OUTPUT");
      // A count or global iron sum is not a proof of custody: every cargo
      // already in transit must retain its PAID identity, owner and quantity.
      const expectedTransit = new Map([
        ...[...start.shipments?.values() ?? []]
          .filter(cargo => cargo.arrivalTick !== tick)
          .map(cargo => [cargo.id, cargo] as const),
        ...fresh.map(cargo => [cargo.id, cargo] as const),
      ]);
      const assertTransit = (world: WorldState): void => {
        expect(world.shipments?.size ?? 0).toBe(expectedTransit.size);
        for (const [id, expected] of expectedTransit) {
          expect(world.shipments?.get(id)).toEqual(expected);
        }
      };
      assertTransit(actual.world);
      assertTransit(replay.world);
      if (fresh.length && !sawWrongTransitReject) {
        const cargo = fresh[0]!;
        expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
        if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
          throw new Error("Expected real FX-paid ProductionUnit beneficiary");
        }
        const paidOwnerId = cargo.beneficialOwner.productionUnitId;
        const wrongOwner = [...actual.world.productionUnits.keys()].find(
          id => id !== paidOwnerId);
        expect(wrongOwner).toBeDefined();
        const forged: WorldState = {
          ...actual.world,
          shipments: new Map(actual.world.shipments).set(cargo.id, {
            ...cargo,
            beneficialOwner: { type: "PRODUCTION_UNIT", productionUnitId: wrongOwner! },
          }),
        };
        expect(iron(forged)).toBeCloseTo(iron(actual.world), 8);
        expect(() => assertTransit(forged)).toThrow();
        sawWrongTransitReject = true;
      }
      expect(fresh).toHaveLength(dispatched.length);
      expect(inputs).toHaveLength(fresh.length);
      expect(outputs).toHaveLength(fresh.length);
      expect(losses).toHaveLength(fresh.length);
      if (!open) {
        expect(fresh).toHaveLength(0);
        if (journal.some(tx => tx.phase === 4 && tx.type === "MARKET_SALE" &&
          (tx.moneyAmount ?? 0) > 0)) blockedWithLocalSale++;
      }
      expect(incoming).toHaveLength(due.length);
      assertDeliveryOwners(beforePhase1!, afterPhase1!, due);
      for (const cargo of due) {
        const matched = incoming.filter(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
        expect(matched).toHaveLength(1);
        expect(matched[0]).toMatchObject({
          phase: 1, tick, quantity: cargo.quantity, goodId: cargo.goodId,
          destination: cargo.beneficialOwner,
        });
        expect(matched[0]!.moneyAmount).toBeUndefined();
        expect(sentIds.has(cargo.id)).toBe(true);
        expect(deliveredIds.has(cargo.id)).toBe(false);
        deliveredIds.add(cargo.id);
        delivered++;
      }
      for (const cargo of fresh) {
        expect(cargo.arrivalTick).toBe(tick + 3);
        expect(cargo.departureTick).toBe(tick);
        expect(sentIds.has(cargo.id)).toBe(false);
        const loss = losses.filter(tx =>
          tx.reason === "DISPATCH_ROUTINE_PHYSICAL_LOSS:" + cargo.id);
        expect(loss).toHaveLength(1);
        const gross = cargo.quantity + loss[0]!.quantity!;
        const sale = journal.filter(tx =>
          tx.type === "TRADE_GOODS_SALE" && tx.bundleId === loss[0]!.bundleId);
        expect(sale).toHaveLength(1);
        expect(sale[0]!.quantity).toBeCloseTo(gross, 6);
        expect(loss[0]!.quantity).toBeCloseTo(gross * rate, 6);
        expect(cargo.quantity).toBeCloseTo(gross * (1 - rate), 6);
        expect(inputs.filter(tx => tx.bundleId === loss[0]!.bundleId))
          .toHaveLength(1);
        expect(outputs.filter(tx => tx.bundleId === loss[0]!.bundleId))
          .toHaveLength(1);
        sentIds.add(cargo.id);
        sent++;
      }
      if (losses.length && !sawBadLossReject) {
        const counterfeit = journal.map(tx => tx === losses[0]
          ? { ...tx, quantity: tx.quantity! + 0.25, amount: tx.amount! + 0.25 } : tx);
        expect(() => assertLossReconciliation(start, actual.world, counterfeit)).toThrow();
        sawBadLossReject = true;
      }
      if (due.length && !sawWrongDeliveryReject) {
        const recipient = due[0]!.beneficialOwner;
        expect(recipient.type).toBe("PRODUCTION_UNIT");
        if (recipient.type !== "PRODUCTION_UNIT") throw new Error("Expected paid producer");
        const other = [...afterPhase1!.productionUnits.keys()].find(
          id => id !== recipient.productionUnitId);
        expect(other).toBeDefined();
        const units = new Map(afterPhase1!.productionUnits);
        const shift = due[0]!.quantity / 4;
        for (const [id, delta] of [
          [recipient.productionUnitId, -shift], [other!, shift],
        ] as const) {
          const current = units.get(id)!;
          units.set(id, { ...current, inputInventory: new Map(current.inputInventory)
            .set(IRON, (current.inputInventory.get(IRON) ?? 0) + delta) });
        }
        const fake = { ...afterPhase1!, productionUnits: units };
        expect(iron(fake)).toBeCloseTo(iron(afterPhase1!), 8);
        expect(() => assertDeliveryOwners(beforePhase1!, fake, due)).toThrow();
        sawWrongDeliveryReject = true;
      }
      expect(beforePhase7).toBeDefined();
      expect(afterPhase7).toBeDefined();
      expect(iron(afterPhase7!)).toBeCloseTo(iron(beforePhase7!) -
        losses.reduce((sum, tx) => sum + tx.quantity!, 0), 6);
      standard = actual.world;
      reverse = shuffled(replay.world);
    }
    // Non-vacuous witness on distinct real dispatch ticks with the actual
    // Phase-7 loss journal. No synthetic settlements or cumulative totals.
    const paidWindows = [...openingWitnesses].filter(([, witness]) =>
      witness.paidCargoCount > 0 && witness.physicalLossQuantity > 0);
    for (const policy of [0.25, 0.10]) {
      expect(paidWindows.filter(([, witness]) => witness.rate === policy).length,
        `actual FX-paid loss-bearing opening at routine loss rate ${policy}`)
        .toBeGreaterThan(0);
    }
    expect(paidWindows.length).toBeGreaterThanOrEqual(2);
    expect(sent).toBeGreaterThan(0);
    expect(destroyedTotal).toBeGreaterThan(0);
    expect(delivered).toBe(sent);
    expect(deliveredIds).toEqual(sentIds);
    expect(standard.shipments?.size ?? 0).toBe(0);
    expect(blockedWithLocalSale).toBeGreaterThan(0);
    expect(sawBadLossReject).toBe(true);
    expect(sawWrongDeliveryReject).toBe(true);
    expect(sawWrongTransitReject).toBe(true);
    expect(checkedPaidCapacity).toBe(true);
    expect(rejectedOverCapacity).toBe(true);
  }, 60_000);
});
