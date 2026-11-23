/**
 * Issue #676 / M5 acceptance: actual paid FX dispatch followed by delayed
 * physical delivery and routine transport attrition through the canonical
 * 16-phase runner. No synthetic shipment, invoice, or delivery is inserted.
 * This is one focused regression, not a complete 600-tick gate.
 */
import { describe, expect, it } from "vitest";
import { actorRefKey } from "../domain/genesisLedger";
import { createFxSettlementId, type EconomicTransaction } from "./tickOrchestrator";
import type { FxLedgerLeg } from "./fxSettlement";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { GoodId } from "../domain/id";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import { quoteFxForPool } from "./fxQuoteReservation";
import type { PhaseHandler } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";
import type { WorldState } from "./worldState";

const IRON = "good:iron" as GoodId;
const unchanged = (_phase: number, world: WorldState) => world;

const upstream: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return { ...context, effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
    ) };
  }
  return context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
};

/** Stocks, including the shipment as the one authoritative transit owner. */
function allIron(world: WorldState): number {
  let total = 0;
  for (const unit of world.productionUnits.values()) {
    total += (unit.inputInventory.get(IRON) ?? 0) +
      (unit.outputInventory.get(IRON) ?? 0) +
      (unit.investmentInventory.get(IRON) ?? 0);
  }
  for (const state of world.states.values()) total += state.publicInventory.get(IRON) ?? 0;
  for (const cohort of world.cohorts.values()) total += cohort.householdInventory.get(IRON) ?? 0;
  for (const shipment of (world.shipments?.values() ?? [])) {
    if (shipment.goodId === IRON) total += shipment.quantity;
  }
  return total;
}

/** The owner/bucket oracle is independent of the engine's delivery receipt. */
function assertActualArrival(
  before: WorldState, after: WorldState, cargo: TradeShipmentState,
): void {
  if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT" ||
      cargo.destinationInventoryBucket !== "INPUT") {
    throw new Error("Fixture requires a real ProductionUnit INPUT buyer");
  }
  const recipient = cargo.beneficialOwner.productionUnitId;
  for (const [id, unit] of before.productionUnits) {
    const next = after.productionUnits.get(id)!;
    const observed = (next.inputInventory.get(cargo.goodId) ?? 0) -
      (unit.inputInventory.get(cargo.goodId) ?? 0);
    expect(observed, "Phase-1 stock credit for " + id)
      .toBeCloseTo(id === recipient ? cargo.quantity : 0, 8);
  }
}

/**
 * Independent source-endpoint oracle: this fixture's CLOSING iron exporter
 * owns its iron in the ProductionUnit INPUT bucket. Gross invoiced quantity
 * leaves that exact bucket, not another unit or another inventory bucket.
 */
function assertActualSellerDeparture(
  before: WorldState, after: WorldState, cargo: TradeShipmentState, gross: number,
): void {
  if (cargo.seller.type !== "PRODUCTION_UNIT") {
    throw new Error("Fixture requires a ProductionUnit seller");
  }
  const sellerId = cargo.seller.productionUnitId;
  expect(before.productionUnits.has(sellerId)).toBe(true);
  const buckets = ["inputInventory", "outputInventory", "investmentInventory"] as const;
  for (const [id, unit] of before.productionUnits) {
    const next = after.productionUnits.get(id)!;
    for (const bucket of buckets) {
      const delta = (next[bucket].get(cargo.goodId) ?? 0) -
        (unit[bucket].get(cargo.goodId) ?? 0);
      expect(delta, "Phase-7 physical source " + id + "/" + bucket)
        .toBeCloseTo(id === sellerId && bucket === "inputInventory" ? -gross : 0, 8);
    }
  }
  for (const [id, state] of before.states) {
    expect(after.states.get(id)!.publicInventory.get(cargo.goodId) ?? 0)
      .toBeCloseTo(state.publicInventory.get(cargo.goodId) ?? 0, 8);
  }
  for (const [id, cohort] of before.cohorts) {
    expect(after.cohorts.get(id)!.householdInventory.get(cargo.goodId) ?? 0)
      .toBeCloseTo(cohort.householdInventory.get(cargo.goodId) ?? 0, 8);
  }
}

/**
 * Independent journal-to-stock oracle for the *same* paid shipment.
 * An invoice is non-posting: the two FX legs, not the invoice annotation,
 * must change buyer/seller wallets and the issuer's pairwise pool reserves.
 */
function assertPaidFxDeparture(
  before: WorldState, after: WorldState, cargo: TradeShipmentState,
  journal: readonly EconomicTransaction[], gross: number,
): void {
  if (cargo.buyer.type !== "PRODUCTION_UNIT" ||
      cargo.seller.type !== "PRODUCTION_UNIT") {
    throw new Error("Fixture requires production-unit cash endpoints");
  }
  const sales = journal.filter(tx => tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
  const inputs = journal.filter(tx => tx.phase === 7 && tx.type === "FX_INPUT");
  const outputs = journal.filter(tx => tx.phase === 7 && tx.type === "FX_OUTPUT");
  expect(sales).toHaveLength(1);
  expect(inputs).toHaveLength(1);
  expect(outputs).toHaveLength(1);
  const sale = sales[0]!;
  const input = inputs[0]! as FxLedgerLeg;
  const output = outputs[0]! as FxLedgerLeg;
  expect(sale.bundleId).toBeDefined();
  const bundleId = sale.bundleId;
  expect(sale.tick).toBe(cargo.departureTick);
  expect(sale.goodId).toBe(cargo.goodId);
  expect(sale.quantity).toBeCloseTo(gross, 8);
  expect(gross).toBeGreaterThan(0);
  expect(sale.source && actorRefKey(sale.source)).toBe(actorRefKey(cargo.buyer));
  expect(sale.destination && actorRefKey(sale.destination)).toBe(actorRefKey(cargo.seller));
  expect(sale.currencyId).toBe(cargo.invoiceCurrencyId);
  expect(sale.fxSettlementId).toBe(cargo.fxSettlementId);
  expect(sale.moneyAmount).toBeCloseTo(gross * cargo.sellerNetUnitPrice, 8);
  expect(sale.moneyAmount).toBeGreaterThan(0);

  for (const leg of [input, output]) {
    expect(leg.tick).toBe(cargo.departureTick);
    expect(leg.phase).toBe(7);
    expect(leg.bundleId).toBe(bundleId);
    expect(leg.fxSettlementId).toBe(cargo.fxSettlementId);
    expect(leg.fxReservationRequestId).toBeTruthy();
    expect(leg.reason).toBe("TRADE_GOODS");
    expect(leg.moneyAmount).toBeGreaterThan(0);
  }
  expect(input.currencyId).toBe(cargo.buyerPaymentCurrencyId);
  expect(output.currencyId).toBe(cargo.invoiceCurrencyId);
  expect(input.moneyAmount).toBeCloseTo(cargo.buyerGoodsPaymentAmount, 8);
  expect(output.moneyAmount).toBeCloseTo(sale.moneyAmount!, 8);
  expect(input.fxReservationRequestId).toBe(output.fxReservationRequestId);
  expect(input.source && actorRefKey(input.source)).toBe(actorRefKey(cargo.buyer));
  expect(output.destination && actorRefKey(output.destination)).toBe(actorRefKey(cargo.seller));
  expect(input.fromAccount).toEqual({ type: "ACTOR", actor: cargo.buyer });
  expect(output.toAccount).toEqual({ type: "ACTOR", actor: cargo.seller });
  expect(input.toAccount.type).toBe("FX_POOL");
  expect(output.fromAccount).toEqual(input.toAccount);
  if (input.toAccount.type !== "FX_POOL") throw new Error("Missing FX pool endpoint");
  const poolRef = input.toAccount;
  const priorPool = before.monetaryAuthorities
    .get(poolRef.owningAuthorityId)?.fxPools.get(poolRef.pairId);
  const currentPool = after.monetaryAuthorities
    .get(poolRef.owningAuthorityId)?.fxPools.get(poolRef.pairId);
  expect(priorPool).toBeDefined();
  expect(currentPool).toBeDefined();
  expect((currentPool!.cash.get(input.currencyId) ?? 0) -
    (priorPool!.cash.get(input.currencyId) ?? 0))
    .toBeCloseTo(input.moneyAmount, 8);
  expect((priorPool!.cash.get(output.currencyId) ?? 0) -
    (currentPool!.cash.get(output.currencyId) ?? 0))
    .toBeCloseTo(output.moneyAmount, 8);

  const payerBefore = before.productionUnits.get(cargo.buyer.productionUnitId)!;
  const payerAfter = after.productionUnits.get(cargo.buyer.productionUnitId)!;
  const sellerBefore = before.productionUnits.get(cargo.seller.productionUnitId)!;
  const sellerAfter = after.productionUnits.get(cargo.seller.productionUnitId)!;
  const extraCharges = journal.filter(tx => tx.bundleId === bundleId &&
    ["TRANSPORT_FEE", "IMPORT_TARIFF", "CONSUMPTION_TAX"].includes(tx.type));
  for (const charge of extraCharges) {
    expect(charge.currencyId).toBe(cargo.buyerPaymentCurrencyId);
    expect(charge.source && actorRefKey(charge.source)).toBe(actorRefKey(cargo.buyer));
    expect(charge.moneyAmount).toBeGreaterThan(0);
  }
  const feeAmount = extraCharges.reduce((sum, tx) => sum + tx.moneyAmount!, 0);
  expect((payerBefore.wallet.get(input.currencyId) ?? 0) -
    (payerAfter.wallet.get(input.currencyId) ?? 0))
    .toBeCloseTo(input.moneyAmount + feeAmount, 8);
  expect((sellerAfter.wallet.get(output.currencyId) ?? 0) -
    (sellerBefore.wallet.get(output.currencyId) ?? 0))
    .toBeCloseTo(output.moneyAmount, 8);
}

/**
 * Exhaust every *future* FX payout budget without touching money stocks.
 * The departure was already settled in Phase 7, so later policy floors must
 * not retroactively cancel or recharge the physical cargo in transit.
 */
function freezeAvailableFx(world: WorldState): WorldState {
  const authorities = new Map(world.monetaryAuthorities);
  let frozenPools = 0;
  for (const [id, authority] of authorities) {
    const pools = new Map(authority.fxPools);
    for (const [pairId, pool] of pools) {
      const frozen = {
        ...pool,
        minOperationalReserveBase: pool.cash.get(pool.baseCurrencyId)!,
        minOperationalReserveQuote: pool.cash.get(pool.quoteCurrencyId)!,
      };
      expect(quoteFxForPool(frozen, frozen.baseCurrencyId,
        frozen.quoteCurrencyId, 1).feasibleOutputAmount).toBe(0);
      expect(quoteFxForPool(frozen, frozen.quoteCurrencyId,
        frozen.baseCurrencyId, 1).feasibleOutputAmount).toBe(0);
      pools.set(pairId, frozen);
      frozenPools += 1;
    }
    authorities.set(id, { ...authority, fxPools: pools });
  }
  expect(frozenPools).toBeGreaterThan(0);
  return { ...world, monetaryAuthorities: authorities };
}

describe("M5 #676 real paid FX shipment with delayed physical loss", () => {
  it("destroys cargo once at dispatch, retains surviving ownership, and credits only its buyer on arrival", () => {
    const f = createM5PreviewScenario();
    const links = [...f.opening.transportLinks];
    expect(links).toHaveLength(1);
    const [linkId, link] = links[0]!;
    const opening: WorldState = {
      ...f.opening,
      transportLinks: new Map([[linkId, {
        ...link, travelTicks: 2,
        seed: { ...link.seed, routinePhysicalLossRate: 0.25 },
      }]]),
    };
    let beforeDispatch: WorldState | undefined;
    let afterDispatch: WorldState | undefined;
    const run = (
      world: WorldState, tick: number,
      options = f.options,
      observe?: (phase: number, before: WorldState, after: WorldState) => void,
    ) => executeM5AutonomousRegionalTradeTick(
      world, tick, upstream, unchanged, options, observe,
    );

    const departed = run(opening, M5_PREVIEW_TICK, f.options, (phase, before, after) => {
      if (phase === 7) { beforeDispatch = before; afterDispatch = after; }
    });
    const replay = run(opening, M5_PREVIEW_TICK);
    for (const result of [departed, replay]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
    }
    expect(departed.context.transactions).toEqual(replay.context.transactions);
    expect(departed.world.shipments).toEqual(replay.world.shipments);
    expect(beforeDispatch).toBeDefined();
    expect(afterDispatch).toBeDefined();

    const cargoList = [...(departed.world.shipments?.values() ?? [])];
    expect(cargoList).toHaveLength(1);
    const cargo = cargoList[0]!;
    expect(cargo.goodId).toBe(IRON);
    expect(cargo.departureTick).toBe(M5_PREVIEW_TICK);
    expect(cargo.travelTicksAtDispatch).toBe(2);
    expect(cargo.arrivalTick).toBe(M5_PREVIEW_TICK + 2);
    expect(cargo.fxSettlementId).toBeDefined();
    const loss = departed.context.transactions.filter(
      tx => tx.type === "GOODS_TRANSPORT_LOSS",
    );
    expect(loss).toHaveLength(1);
    expect(loss[0]).toMatchObject({
      tick: M5_PREVIEW_TICK, phase: 7,
      goodId: IRON, source: cargo.beneficialOwner,
    });
    expect(loss[0]!.moneyAmount).toBeUndefined();
    expect(loss[0]!.currencyId).toBeUndefined();
    const destroyed = loss[0]!.quantity!;
    const gross = cargo.quantity + destroyed;
    expect(gross).toBeGreaterThan(0);
    expect(destroyed).toBeCloseTo(gross * 0.25, 8);
    expect(cargo.quantity).toBeCloseTo(gross * 0.75, 8);
    expect(allIron(afterDispatch!)).toBeCloseTo(allIron(beforeDispatch!) - destroyed, 8);
    assertActualSellerDeparture(beforeDispatch!, afterDispatch!, cargo, gross);
    assertPaidFxDeparture(beforeDispatch!, afterDispatch!, cargo, departed.context.transactions, gross);

    // Balanced wrong-source mutation: total iron and the recorded paid cargo
    // remain unchanged, but part of the real seller debit is shifted onto
    // a different producer. This MUST fail the exact source bucket oracle.
    if (cargo.seller.type !== "PRODUCTION_UNIT") throw new Error("No seller");
    const sellerId = cargo.seller.productionUnitId;
    const otherSource = [...beforeDispatch!.productionUnits.values()].find(unit =>
      unit.productionUnitId !== sellerId && (unit.inputInventory.get(IRON) ?? 0) > 0);
    expect(otherSource).toBeDefined();
    const shiftSource = Math.min(gross / 4, (otherSource!.inputInventory.get(IRON) ?? 0) / 2);
    expect(shiftSource).toBeGreaterThan(0);
    const wrongSourceUnits = new Map(afterDispatch!.productionUnits);
    for (const [id, delta] of [
      [sellerId, shiftSource], [otherSource!.productionUnitId, -shiftSource],
    ] as const) {
      const unit = wrongSourceUnits.get(id)!;
      wrongSourceUnits.set(id, {
        ...unit, inputInventory: new Map(unit.inputInventory).set(
          IRON, (unit.inputInventory.get(IRON) ?? 0) + delta,
        ),
      });
    }
    const wrongSource = { ...afterDispatch!, productionUnits: wrongSourceUnits };
    expect(allIron(wrongSource)).toBeCloseTo(allIron(afterDispatch!), 8);
    expect(() => assertActualSellerDeparture(beforeDispatch!, wrongSource, cargo, gross))
      .toThrow();

    // A correct-looking pair of FX records is not enough. Both must belong
    // to this cargo's settlement, in the proper currencies and cash endpoints.
    const unrelatedFx = departed.context.transactions.map(tx =>
      tx.type === "FX_OUTPUT" ? { ...tx, fxSettlementId: createFxSettlementId("fxs:unrelated") } : tx);
    expect(() => assertPaidFxDeparture(beforeDispatch!, afterDispatch!, cargo, unrelatedFx, gross))
      .toThrow();
    const wrongCurrencyFx = departed.context.transactions.map(tx =>
      tx.type === "FX_INPUT" ? { ...tx, currencyId: cargo.invoiceCurrencyId } : tx);
    expect(() => assertPaidFxDeparture(beforeDispatch!, afterDispatch!, cargo, wrongCurrencyFx, gross))
      .toThrow();

    // Exhaust all prospective FX payout headroom and alter transport policy
    // AFTER actual FX-paid dispatch. Neither condition can cancel a paid
    // cargo, reprice/recharge it at arrival, or cause a second loss.
    const laterLink = departed.world.transportLinks.get(linkId)!;
    const changedRoute: WorldState = {
      ...freezeAvailableFx(departed.world),
      transportLinks: new Map(departed.world.transportLinks).set(linkId, {
        ...laterLink, travelTicks: 0,
        seed: { ...laterLink.seed, routinePhysicalLossRate: 0 },
      }),
    };
    const noNewTrade = { ...f.options, phase1TradeLawProvider: () => undefined };
    let beforeArrival: WorldState | undefined;
    let afterArrival: WorldState | undefined;
    const enRoute = run(changedRoute, M5_PREVIEW_TICK + 1, noNewTrade);
    expect(enRoute.phaseBoundaryError).toBeUndefined();
    expect(enRoute.reconciliationErrors).toBeNull();
    expect(enRoute.world.shipments?.get(cargo.id)).toEqual(cargo);
    expect(enRoute.context.transactions.filter(tx => [
      "SHIPMENT_DELIVERY", "GOODS_TRANSPORT_LOSS",
      "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF",
    ].includes(tx.type))).toHaveLength(0);

    const arrived = run(enRoute.world, M5_PREVIEW_TICK + 2, noNewTrade,
      (phase, before, after) => {
        if (phase === 1) { beforeArrival = before; afterArrival = after; }
      },
    );
    expect(arrived.phaseTrace).toEqual([...Array(16).keys()]);
    expect(arrived.phaseBoundaryError).toBeUndefined();
    expect(arrived.reconciliationErrors).toBeNull();
    expect(beforeArrival).toBeDefined();
    expect(afterArrival).toBeDefined();
    expect(arrived.world.shipments?.has(cargo.id)).toBe(false);
    expect(arrived.context.transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY"))
      .toMatchObject([{
        tick: M5_PREVIEW_TICK + 2, phase: 1,
        goodId: IRON, quantity: cargo.quantity,
        destination: cargo.beneficialOwner,
      }]);
    expect(arrived.context.transactions.filter(tx => [
      "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF", "GOODS_TRANSPORT_LOSS",
    ].includes(tx.type))).toHaveLength(0);
    expect(allIron(afterArrival!)).toBeCloseTo(allIron(beforeArrival!), 8);
    assertActualArrival(beforeArrival!, afterArrival!, cargo);

    // Balanced misdelivery: keep the aggregate goods total unchanged while
    // taking stock away from the paid owner and giving it to another unit.
    if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") throw new Error("No buyer");
    const recipient = cargo.beneficialOwner.productionUnitId;
    const other = [...afterArrival!.productionUnits.keys()].find(id => id !== recipient);
    expect(other).toBeDefined();
    const swapped = new Map(afterArrival!.productionUnits);
    const shift = cargo.quantity / 4;
    for (const [id, delta] of [[recipient, -shift], [other!, shift]] as const) {
      const unit = swapped.get(id)!;
      swapped.set(id, {
        ...unit, inputInventory: new Map(unit.inputInventory).set(
          IRON, (unit.inputInventory.get(IRON) ?? 0) + delta,
        ),
      });
    }
    const forged = { ...afterArrival!, productionUnits: swapped };
    expect(allIron(forged)).toBeCloseTo(allIron(afterArrival!), 8);
    expect(() => assertActualArrival(beforeArrival!, forged, cargo)).toThrow();

    const next = run(arrived.world, M5_PREVIEW_TICK + 3, noNewTrade);
    expect(next.phaseBoundaryError).toBeUndefined();
    expect(next.reconciliationErrors).toBeNull();
    expect(next.world.shipments?.has(cargo.id)).toBe(false);
    expect(next.context.transactions.filter(tx => [
      "SHIPMENT_DELIVERY", "FX_INPUT", "FX_OUTPUT",
      "GOODS_TRANSPORT_LOSS", "IMPORT_TARIFF",
    ].includes(tx.type))).toHaveLength(0);
  }, 30_000);
  it("blocks new FX-dependent shipments without corrupting the canonical local tick", () => {
    const scenario = createM5PreviewScenario();
    const execute = (world: WorldState,
      observe?: (phase: number, before: WorldState, after: WorldState) => void,
    ) => executeM5AutonomousRegionalTradeTick(
      world, M5_PREVIEW_TICK, upstream, unchanged, scenario.options, observe,
    );

    // Positive control: identical market/route/stock inputs with actual FX
    // liquidity do dispatch and pay for a real cross-currency shipment.
    const funded = execute(scenario.opening);
    expect(funded.phaseBoundaryError).toBeUndefined();
    expect(funded.reconciliationErrors).toBeNull();
    expect(funded.world.shipments?.size ?? 0).toBeGreaterThan(0);
    expect(funded.context.transactions.some(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT")).toBe(true);

    // The ONLY changed input is each FX pool's usable payout headroom.
    // Preserve actual pool cash, physical inventory and local-market state.
    const exhausted = freezeAvailableFx(scenario.opening);
    let beforeTrade: WorldState | undefined;
    let afterTrade: WorldState | undefined;
    const blocked = execute(exhausted, (phase, before, after) => {
      if (phase === 7) { beforeTrade = before; afterTrade = after; }
    });
    expect(blocked.phaseTrace).toEqual([...Array(16).keys()]);
    expect(blocked.phaseBoundaryError).toBeUndefined();
    expect(blocked.reconciliationErrors).toBeNull();
    expect(beforeTrade).toBeDefined();
    expect(afterTrade).toBeDefined();
    expect(blocked.world.shipments?.size ?? 0).toBe(0);
    expect(blocked.context.transactions.filter(tx => tx.phase === 7 && [
      "FX_INPUT", "FX_OUTPUT", "TRADE_GOODS_SALE",
      "SHIPMENT_DISPATCH", "GOODS_TRANSPORT_LOSS",
    ].includes(tx.type))).toHaveLength(0);
    expect(allIron(afterTrade!)).toBeCloseTo(allIron(beforeTrade!), 8);

    // Failed route settlement must not debit a different owner or quietly
    // relabel its stock. Local markets still pass the complete 16-phase tick.
    expect(afterTrade!.productionUnits.size).toBe(beforeTrade!.productionUnits.size);
    for (const [id, original] of beforeTrade!.productionUnits) {
      const next = afterTrade!.productionUnits.get(id);
      expect(next, "FX-exhausted Phase-7 producer " + id).toBeDefined();
      expect(next!.inputInventory).toEqual(original.inputInventory);
      expect(next!.outputInventory).toEqual(original.outputInventory);
      expect(next!.investmentInventory).toEqual(original.investmentInventory);
      expect(next!.wallet).toEqual(original.wallet);
    }
    expect(blocked.world.markets.size).toBe(exhausted.markets.size);
    for (const id of exhausted.markets.keys()) {
      expect(blocked.world.markets.has(id)).toBe(true);
    }
  });

});
