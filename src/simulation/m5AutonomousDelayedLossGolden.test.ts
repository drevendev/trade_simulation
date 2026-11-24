/**
 * Issue #676 / M5 acceptance: actual paid FX dispatch followed by delayed
 * physical delivery and routine transport attrition through the canonical
 * 16-phase runner. No synthetic shipment, invoice, or delivery is inserted.
 * This is one focused regression, not a complete 600-tick gate.
 */
import { describe, expect, it } from "vitest";
import { actorRefKey } from "../domain/genesisLedger";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { validateDefinitionPack } from "../config/validation";
import { buildDefinitionRegistry } from "../domain/definitionRegistry";
import { createFxSettlementId, type EconomicTransaction } from "./tickOrchestrator";
import type { FxLedgerLeg } from "./fxSettlement";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { CurrencyId, GoodId } from "../domain/id";
import { createMarketIntentId } from "./marketIntent";
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

/** Local procurement precedes regional trade. Require a real paid sale, not
 * equality of two empty journals. This does not assert identical Phase-8
 * residuals, which may legitimately differ after Phase 7. */
function assertPaidLocalProcurement(
  funded: readonly EconomicTransaction[], restricted: readonly EconomicTransaction[],
): void {
  const localSales = (journal: readonly EconomicTransaction[]) =>
    journal.filter(tx => tx.phase === 4 && tx.type === "MARKET_SALE");
  const paidLocal = localSales(funded);
  expect(paidLocal.some(tx => (tx.quantity ?? 0) > 0 &&
    (tx.moneyAmount ?? 0) > 0 && tx.sourceRegionId !== undefined &&
    tx.sourceRegionId === tx.destinationRegionId)).toBe(true);
  expect(localSales(restricted)).toEqual(paidLocal);
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
      "SHIPMENT_DISPATCH", "GOODS_TRANSPORT_LOSS", "TRANSPORT_FEE",
      "IMPORT_TARIFF", "CONSUMPTION_TAX",
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
    expect(afterTrade!.states).toEqual(beforeTrade!.states);
    expect(afterTrade!.cohorts).toEqual(beforeTrade!.cohorts);
    expect(afterTrade!.monetaryAuthorities).toEqual(beforeTrade!.monetaryAuthorities);
    assertPaidLocalProcurement(funded.context.transactions, blocked.context.transactions);
    // A removed domestic sale must fail even if both world registries survive.
    const withoutLocalSales = blocked.context.transactions.filter(
      tx => !(tx.phase === 4 && tx.type === "MARKET_SALE"),
    );
    expect(() => assertPaidLocalProcurement(
      funded.context.transactions, withoutLocalSales,
    )).toThrow();
    expect(blocked.world.markets.size).toBe(exhausted.markets.size);
    for (const id of exhausted.markets.keys()) {
      expect(blocked.world.markets.has(id)).toBe(true);
    }
  });


  it.each(["closed border", "zero physical capacity"] as const)(
    "blocks new dispatch at %s while retaining paid local procurement",
    (restriction) => {
      const f = createM5PreviewScenario();
      const links = [...f.opening.transportLinks.values()];
      expect(links).toHaveLength(1);
      const link = links[0]!;
      expect(link.seed.baseCapacity * link.seed.condition).toBeGreaterThan(0);
      const funded = executeM5AutonomousRegionalTradeTick(
        f.opening, M5_PREVIEW_TICK, upstream, unchanged, f.options,
      );
      expect(funded.phaseBoundaryError).toBeUndefined();
      expect(funded.reconciliationErrors).toBeNull();
      expect(funded.context.transactions.some(tx =>
        tx.phase === 7 && tx.type === "FX_OUTPUT")).toBe(true);
      expect(funded.world.shipments?.size ?? 0).toBeGreaterThan(0);

      // Change just one independent gate, not the economic stocks, prices,
      // available FX or Phase-4 local procurement inputs.
      const options = restriction === "closed border"
        ? { ...f.options, phase1TradeLawProvider: () => 0 }
        : { ...f.options, infrastructureFactors: new Map([[link.linkId, 0]]) };
      let beforeTrade: WorldState | undefined;
      let afterTrade: WorldState | undefined;
      const blocked = executeM5AutonomousRegionalTradeTick(
        f.opening, M5_PREVIEW_TICK, upstream, unchanged, options,
        (phase, before, after) => {
          if (phase === 7) { beforeTrade = before; afterTrade = after; }
        },
      );
      expect(blocked.phaseTrace).toEqual([...Array(16).keys()]);
      expect(blocked.phaseBoundaryError).toBeUndefined();
      expect(blocked.reconciliationErrors).toBeNull();
      expect(blocked.world.shipments?.size ?? 0).toBe(0);
      expect(blocked.context.transactions.filter(tx => tx.phase === 7 &&
        ["FX_INPUT", "FX_OUTPUT", "TRADE_GOODS_SALE", "SHIPMENT_DISPATCH",
          "GOODS_TRANSPORT_LOSS", "TRANSPORT_FEE", "IMPORT_TARIFF"].includes(tx.type)))
        .toHaveLength(0);
      expect(beforeTrade).toBeDefined();
      expect(afterTrade).toBeDefined();
      expect(afterTrade!.productionUnits).toEqual(beforeTrade!.productionUnits);
      expect(afterTrade!.states).toEqual(beforeTrade!.states);
      expect(afterTrade!.cohorts).toEqual(beforeTrade!.cohorts);
      expect(afterTrade!.monetaryAuthorities).toEqual(beforeTrade!.monetaryAuthorities);
      // Non-vacuous local trade: Phase 4 must still settle the same paid
      // same-region procurement that occurred with the open funded route.
      assertPaidLocalProcurement(funded.context.transactions, blocked.context.transactions);
      expect([...blocked.world.markets.keys()]).toEqual([...funded.world.markets.keys()]);
    },
  );



  it.each([0, 0.20])("settles the frozen statutory tariff on MID invoice plus freight (rate %f)", (rate) => {
    const f = createM5PreviewScenario();
    let before: WorldState | undefined;
    let after: WorldState | undefined;
    const result = executeM5AutonomousRegionalTradeTick(
      f.opening, M5_PREVIEW_TICK, upstream, unchanged, {
        ...f.options,
        phase1TariffLawProvider: query => query.goodId === IRON ? rate : 0,
      }, (phase, previous, next) => {
        if (phase === 7) { before = previous; after = next; }
      },
    );
    expect(result.phaseTrace).toEqual([...Array(16).keys()]);
    expect(result.phaseBoundaryError).toBeUndefined();
    expect(result.reconciliationErrors).toBeNull();
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    const cargos = [...(result.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(1);
    const cargo = cargos[0]!;
    const journal = result.context.transactions;
    const sale = journal.find(tx => tx.phase === 7 && tx.type === "TRADE_GOODS_SALE")!;
    expect(sale).toBeDefined();
    expect(sale.quantity).toBeGreaterThan(0);
    assertPaidFxDeparture(before!, after!, cargo, journal, sale.quantity!);
    const poolList = [...before!.monetaryAuthorities.values()].flatMap(
      authority => [...authority.fxPools.values()],
    );
    expect(poolList).toHaveLength(1);
    const pool = poolList[0]!;
    // The preview pins Alpha as the base issuer and Beta as the importer.
    // Compute the MID conversion from the actual pre-trade pool, not the
    // spread-inclusive FX debit or a self-reported tariff quote.
    expect(pool.baseCurrencyId).toBe(cargo.invoiceCurrencyId);
    expect(pool.quoteCurrencyId).toBe(cargo.buyerPaymentCurrencyId);
    const mid = sale.moneyAmount! * pool.spotRateQuotePerBase;
    const fees = journal.filter(tx => tx.phase === 7 && tx.bundleId === sale.bundleId &&
      tx.type === "TRANSPORT_FEE");
    expect(fees).toHaveLength(1);
    const fee = fees[0]!.moneyAmount!;
    expect(fee).toBeGreaterThan(0);
    const expectedTariff = (mid + fee) * rate; // fixture collection efficiency = 1
    const importer = before!.regions.get(cargo.destinationRegionId)!.controllerStateId;
    if (!importer) throw new Error("Tariff fixture requires a destination State");
    const currency = cargo.buyerPaymentCurrencyId;
    const assertTariff = (receipts: readonly EconomicTransaction[], amount: number) => {
      const tariffs = receipts.filter(tx => tx.phase === 7 && tx.type === "IMPORT_TARIFF");
      expect(amount).toBeCloseTo(expectedTariff, 8);
      if (rate === 0) {
        expect(tariffs).toHaveLength(0);
      } else {
        expect(tariffs).toHaveLength(1);
        expect(tariffs[0]).toMatchObject({
          bundleId: sale.bundleId, source: cargo.buyer,
          destination: { type: "STATE", stateId: importer }, currencyId: currency,
        });
        expect(tariffs[0]!.moneyAmount).toBeCloseTo(expectedTariff, 8);
      }
    };
    assertTariff(journal, cargo.tariffAmount);
    // Reconcile the actual importer treasury at the Phase-7 boundary;
    // freight and consumption tax may share this recipient.
    const expectedCredit = journal.filter(tx => tx.phase === 7 &&
      tx.destination?.type === "STATE" && tx.destination.stateId === importer &&
      tx.currencyId === currency).reduce((sum, tx) => sum + (tx.moneyAmount ?? 0), 0);
    const prior = before!.states.get(importer)!.treasury.get(currency) ?? 0;
    const next = after!.states.get(importer)!.treasury.get(currency) ?? 0;
    expect(next - prior).toBeCloseTo(expectedCredit, 8);
    if (rate > 0) {
      // A journal and cargo that agree on an incorrect tax base must fail
      // independently: omitting freight is not the statutory formula.
      const wrong = mid * rate;
      const forged = journal.map(tx => tx.type === "IMPORT_TARIFF"
        ? { ...tx, moneyAmount: wrong } : tx);
      expect(() => assertTariff(forged, wrong)).toThrow();
    }
  });



  it("reduces real paid import quantity when tariff makes the same household budget binding", () => {
    const f = createM5PreviewScenario();
    const link = [...f.opening.transportLinks.values()][0]!;
    const destination = f.opening.regions.get(link.toRegionId)!;
    const currency = destination.settlementCurrencyId;
    const cohort = [...f.opening.cohorts.values()].find(
      item => item.seed.regionKey === destination.seed.key,
    )!;
    expect(cohort).toBeDefined();
    // Remove competing destination production demand; retain the real source
    // procurement and closing sellers. Both tariff runs share the same world.
    const units = new Map(f.opening.productionUnits);
    const producer = [...units.values()].find(unit =>
      unit.seed.regionKey === destination.seed.key && unit.status === "ACTIVE")!;
    expect(producer).toBeDefined();
    units.set(producer.productionUnitId, { ...producer, status: "CLOSING", installedCapital: 0 });
    const actor = { type: "COHORT" as const, cohortId: cohort.cohortId };
    const run = (rate: number, budget: number) => {
      const opening: WorldState = {
        ...f.opening, productionUnits: units,
        cohorts: new Map(f.opening.cohorts).set(cohort.cohortId, {
          ...cohort, wallet: new Map([[currency, budget]]),
        }),
      };
      const household: PhaseHandler = (world, context, pending) => {
        const next = upstream(world, context, pending);
        return context.phase !== 2 ? next : {
          ...next, householdMarketIntents: [{
            id: createMarketIntentId("mi:m5-tariff-budget"),
            actor, regionId: destination.regionId, goodId: IRON,
            side: "BUY" as const, purpose: "CONSUMPTION" as const,
            desiredQuantity: 300, maxSpend: budget,
            inventoryBucket: "GENERAL" as const, sourcePlanId: "plan:m5-tariff-budget",
          }],
        };
      };
      let before: WorldState | undefined;
      let after: WorldState | undefined;
      const result = executeM5AutonomousRegionalTradeTick(
        opening, M5_PREVIEW_TICK, household, unchanged, {
          ...f.options, phase1TariffLawProvider: query => query.goodId === IRON ? rate : 0,
        }, (phase, previous, next) => {
          if (phase === 7) { before = previous; after = next; }
        },
      );
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      const cargos = [...(result.world.shipments?.values() ?? [])];
      expect(cargos).toHaveLength(1);
      const cargo = cargos[0]!;
      expect(cargo.buyer).toEqual(actor);
      expect(cargo.beneficialOwner).toEqual(actor);
      expect(cargo.fxSettlementId).toBeDefined();
      expect(cargo.quantity).toBeGreaterThan(0);
      const sales = result.context.transactions.filter(tx =>
        tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
      expect(sales).toHaveLength(1);
      expect(sales[0]!.quantity).toBeCloseTo(cargo.quantity, 8);
      const debit = result.context.transactions.filter(tx => tx.phase === 7 &&
        tx.source?.type === "COHORT" && tx.source.cohortId === cohort.cohortId &&
        ["FX_INPUT", "TRANSPORT_FEE", "IMPORT_TARIFF", "CONSUMPTION_TAX"].includes(tx.type))
        .reduce((sum, tx) => sum + tx.moneyAmount!, 0);
      expect(debit).toBeGreaterThan(0);
      expect(debit).toBeCloseTo(cargo.buyerGoodsPaymentAmount + cargo.transportFeeAmount +
        cargo.tariffAmount + cargo.consumptionTaxAmount, 8);
      const prior = before!.cohorts.get(cohort.cohortId)!.wallet.get(currency)!;
      const next = after!.cohorts.get(cohort.cohortId)!.wallet.get(currency) ?? 0;
      expect(prior).toBe(budget);
      expect(prior - next).toBeCloseTo(debit, 8);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(debit).toBeLessThanOrEqual(budget + 1e-8);
      assertActualSellerDeparture(before!, after!, cargo, cargo.quantity);
      expect(allIron(after!)).toBeCloseTo(allIron(before!), 8);
      return { cargo, debit, journal: result.context.transactions };
    };
    // Calibrate a single common budget between the two unconstrained costs.
    // The positive controls must fill the same physical quantity first.
    const free = run(0, 100_000);
    const taxed = run(0.5, 100_000);
    expect(taxed.cargo.quantity).toBeCloseTo(free.cargo.quantity, 8);
    expect(free.cargo.tariffAmount).toBe(0);
    expect(taxed.cargo.tariffAmount).toBeGreaterThan(0);
    expect(taxed.debit).toBeGreaterThan(free.debit);
    const budget = (free.debit + taxed.debit) / 2;
    const low = run(0, budget);
    const high = run(0.5, budget);
    expect(low.cargo.quantity).toBeCloseTo(free.cargo.quantity, 8);
    expect(high.cargo.quantity).toBeLessThan(low.cargo.quantity);
    expect(high.cargo.tariffAmount).toBeGreaterThan(0);
    assertPaidLocalProcurement(low.journal, high.journal);
    // Negative control: retaining the duty-free physical volume at the
    // observed taxed all-in unit price would breach the identical budget.
    const taxedUnitCost = high.debit / high.cargo.quantity;
    const assertAffordable = (quantity: number) =>
      expect(quantity * taxedUnitCost).toBeLessThanOrEqual(budget + 1e-8);
    assertAffordable(high.cargo.quantity);
    expect(() => assertAffordable(low.cargo.quantity)).toThrow();
  });

  it.each([1, 2])("bounds gross cargo weight before loss (weight per unit %i)", (weight) => {
    const f = createM5PreviewScenario();
    // Define a separate, validated test-only definition pack before execution.
    // A unit-weight fixture alone cannot distinguish quantity from weight.
    const pack = {
      ...baselineDefinitionPack,
      goods: { ...baselineDefinitionPack.goods, [IRON]: {
        ...baselineDefinitionPack.goods[IRON]!, cargoWeightPerUnit: weight,
      } },
    };
    validateDefinitionPack(pack);
    const links = [...f.opening.transportLinks.values()];
    expect(links).toHaveLength(1);
    const link = links[0]!;
    const opening: WorldState = {
      ...f.opening,
      definitionRegistry: buildDefinitionRegistry(pack),
      transportLinks: new Map([[link.linkId, {
        ...link, seed: { ...link.seed, routinePhysicalLossRate: 0.25 },
      }]]),
    };
    const run = (factor: number) => executeM5AutonomousRegionalTradeTick(
      opening, M5_PREVIEW_TICK, upstream, unchanged, {
        ...f.options, infrastructureFactors: new Map([[link.linkId, factor]]),
      },
    );
    expect(opening.definitionRegistry.goods[IRON]!.cargoWeightPerUnit).toBe(weight);
    const fullCapacity = link.seed.baseCapacity * link.seed.condition;
    const grossWeight = (journal: readonly EconomicTransaction[]) =>
      journal.filter(tx => tx.phase === 7 && tx.type === "TRADE_GOODS_SALE")
        .reduce((total, tx) => {
          expect(tx.goodId).toBe(IRON);
          expect(tx.quantity).toBeGreaterThan(0);
          return total + tx.quantity! * weight;
        }, 0);

    const funded = run(1);
    expect(funded.phaseBoundaryError).toBeUndefined();
    expect(funded.reconciliationErrors).toBeNull();
    const unrestrictedWeight = grossWeight(funded.context.transactions);
    expect(unrestrictedWeight).toBeGreaterThan(0);
    expect(unrestrictedWeight).toBeLessThanOrEqual(fullCapacity + 1e-8);

    // Pick a positive physical capacity below actual unrestricted demand.
    // The only changed input is the external infrastructure factor.
    const cap = unrestrictedWeight / 2;
    const constrained = run(cap / fullCapacity);
    expect(constrained.phaseTrace).toEqual([...Array(16).keys()]);
    expect(constrained.phaseBoundaryError).toBeUndefined();
    expect(constrained.reconciliationErrors).toBeNull();
    const shippedWeight = grossWeight(constrained.context.transactions);
    expect(shippedWeight).toBeGreaterThan(0);
    expect(shippedWeight).toBeLessThan(unrestrictedWeight);
    const assertGrossCap = (grossQuantity: number) =>
      expect(grossQuantity * weight).toBeLessThanOrEqual(cap + 1e-8);
    assertGrossCap(shippedWeight / weight);
    if (weight === 2) {
      // A quantity-only allocator can dispatch the entire unconstrained
      // quantity: it fits numerically, but consumes twice the weight cap.
      const forgedQuantity = unrestrictedWeight / weight;
      expect(forgedQuantity).toBeCloseTo(cap, 8);
      expect(() => assertGrossCap(forgedQuantity)).toThrow();
    }

    // The cap is consumed by the invoiced gross quantity, not the surviving
    // cargo. Count every new shipment and typed loss independently of the
    // market-sale records; the preview has a single directed route.
    const cargo = [...(constrained.world.shipments?.values() ?? [])];
    expect(cargo.length).toBeGreaterThan(0);
    expect(cargo.every(item => item.transportLinkId === link.linkId &&
      item.goodId === IRON && item.departureTick === M5_PREVIEW_TICK &&
      item.fxSettlementId !== undefined)).toBe(true);
    const surviving = cargo.reduce((sum, item) => sum + item.quantity * weight, 0);
    const destroyed = constrained.context.transactions
      .filter(tx => tx.phase === 7 && tx.type === "GOODS_TRANSPORT_LOSS")
      .reduce((sum, tx) => {
        expect(tx.goodId).toBe(IRON);
        return sum + tx.quantity! * weight;
      }, 0);
    expect(destroyed).toBeGreaterThan(0);
    expect(destroyed).toBeCloseTo(shippedWeight * 0.25, 8);
    expect(surviving + destroyed).toBeCloseTo(shippedWeight, 8);
    expect(constrained.context.transactions.some(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT" && (tx.moneyAmount ?? 0) > 0))
      .toBe(true);
  });

  it.each(["open", "closed border", "zero capacity", "zero FX"] as const)(
    "settles a paid domestic MAIN purchase after Phase 7 with %s",
    (restriction) => {
      const f = createM5PreviewScenario();
      const link = [...f.opening.transportLinks.values()][0]!;
      const source = f.opening.regions.get(link.fromRegionId)!;
      const cohort = [...f.opening.cohorts.values()].find(
        item => item.seed.regionKey === source.seed.key,
      )!;
      expect(cohort).toBeDefined();
      const funded = {
        ...cohort,
        wallet: new Map(cohort.wallet).set(source.settlementCurrencyId, 100_000),
      };
      const opening: WorldState = {
        ...f.opening,
        cohorts: new Map(f.opening.cohorts).set(funded.cohortId, funded),
      };
      const household: PhaseHandler = (world, context, pending) => {
        const next = upstream(world, context, pending);
        return context.phase !== 2 ? next : {
          ...next,
          householdMarketIntents: [{
            id: createMarketIntentId("mi:m5-restricted-main-iron"),
            actor: { type: "COHORT" as const, cohortId: funded.cohortId },
            regionId: source.regionId,
            goodId: IRON,
            side: "BUY" as const,
            purpose: "CONSUMPTION" as const,
            desiredQuantity: 1,
            maxSpend: 10_000,
            inventoryBucket: "GENERAL" as const,
            sourcePlanId: "plan:m5-restricted-main",
          }],
        };
      };
      const options = restriction === "closed border"
        ? { ...f.options, phase1TradeLawProvider: () => 0 }
        : restriction === "zero capacity"
          ? { ...f.options, infrastructureFactors: new Map([[link.linkId, 0]]) }
          : f.options;
      let beforeMain: WorldState | undefined;
      let afterMain: WorldState | undefined;
      const result = executeM5AutonomousRegionalTradeTick(
        restriction === "zero FX" ? freezeAvailableFx(opening) : opening,
        M5_PREVIEW_TICK, household, unchanged, options,
        (phase, before, after) => {
          if (phase === 8) { beforeMain = before; afterMain = after; }
        },
      );
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      const crossBorder = result.context.transactions.filter(tx =>
        tx.phase === 7 && ["TRADE_GOODS_SALE", "SHIPMENT_DISPATCH",
          "FX_INPUT", "FX_OUTPUT"].includes(tx.type));
      if (restriction === "open") {
        expect(crossBorder.some(tx => tx.type === "FX_OUTPUT" &&
          (tx.moneyAmount ?? 0) > 0)).toBe(true);
        expect(crossBorder.some(tx => tx.type === "SHIPMENT_DISPATCH")).toBe(true);
      } else {
        expect(crossBorder).toHaveLength(0);
      }
      expect(beforeMain).toBeDefined();
      expect(afterMain).toBeDefined();
      const assertMain = (journal: readonly EconomicTransaction[], after: WorldState) => {
        const payments = journal.filter(tx => tx.phase === 8 &&
          tx.source?.type === "COHORT" && tx.source.cohortId === funded.cohortId);
        const sales = payments.filter(tx => tx.type === "MARKET_SALE");
        expect(sales.length).toBeGreaterThan(0);
        for (const sale of sales) {
          expect(sale.goodId).toBe(IRON);
          expect(sale.sourceRegionId).toBe(source.regionId);
          expect(sale.destinationRegionId).toBe(source.regionId);
          expect(sale.currencyId).toBe(source.settlementCurrencyId);
          expect(sale.quantity).toBeGreaterThan(0);
          expect(sale.moneyAmount).toBeGreaterThan(0);
        }
        // The preview's explicit policy is 5% collected in full. Bind each
        // household tax to its taxable sale and the effective local jurisdiction,
        // independently of the transaction's self-reported taxAmount.
        const jurisdiction = source.controllerStateId;
        if (!jurisdiction) throw new Error("Taxable fixture requires a State");
        const taxes = payments.filter(tx => tx.type === "CONSUMPTION_TAX");
        expect(taxes).toHaveLength(sales.length);
        for (const sale of sales) {
          expect(sale.transactionId).toBeDefined();
          expect(sale.bundleId).toBeDefined();
          const matching = taxes.filter(tx => tx.originatingTransactionId === sale.transactionId);
          expect(matching).toHaveLength(1);
          const tax = matching[0]!;
          expect(tax.bundleId).toBe(sale.bundleId);
          expect(tax.destination).toEqual({ type: "STATE", stateId: jurisdiction });
          expect(tax.currencyId).toBe(source.settlementCurrencyId);
          expect(tax.moneyAmount).toBeGreaterThan(0);
          expect(tax.moneyAmount).toBeCloseTo(sale.moneyAmount! * 0.05, 8);
          expect(tax.taxAmount).toBeCloseTo(tax.moneyAmount!, 8);
        }
        // Other MAIN purchases may coexist. Reconcile all actual Phase-8
        // postings against every individual live cash owner, not just the
        // household or the aggregate money supply.
        const wallets = (world: WorldState) => {
          const entries = new Map<string, ReadonlyMap<CurrencyId, number>>();
          for (const [productionUnitId, unit] of world.productionUnits)
            entries.set(actorRefKey({ type: "PRODUCTION_UNIT", productionUnitId }), unit.wallet);
          for (const [cohortId, item] of world.cohorts)
            entries.set(actorRefKey({ type: "COHORT", cohortId }), item.wallet);
          for (const [stateId, state] of world.states)
            entries.set(actorRefKey({ type: "STATE", stateId }), state.treasury);
          for (const [clanId, clan] of world.clans)
            entries.set(actorRefKey({ type: "CLAN", clanId }), clan.treasury);
          return entries;
        };
        const openingCash = wallets(beforeMain!);
        const closingCash = wallets(after);
        expect([...closingCash.keys()].sort()).toEqual([...openingCash.keys()].sort());
        const expected = new Map<string, Map<CurrencyId, number>>();
        const post = (owner: string, currency: CurrencyId, amount: number) => {
          expect(openingCash.has(owner)).toBe(true);
          const balances = expected.get(owner) ?? new Map<CurrencyId, number>();
          balances.set(currency, (balances.get(currency) ?? 0) + amount);
          expected.set(owner, balances);
        };
        for (const tx of journal.filter(tx => tx.phase === 8)) {
          expect(["MARKET_SALE", "CONSUMPTION_TAX"]).toContain(tx.type);
          if (!tx.source || !tx.destination || !tx.currencyId || tx.moneyAmount === undefined)
            throw new Error("Incomplete Phase-8 cash posting");
          post(actorRefKey(tx.source), tx.currencyId, -tx.moneyAmount);
          post(actorRefKey(tx.destination), tx.currencyId, tx.moneyAmount);
        }
        for (const [owner, priorCash] of openingCash) {
          const nextCash = closingCash.get(owner)!;
          const deltas = expected.get(owner) ?? new Map<CurrencyId, number>();
          for (const currency of new Set([...priorCash.keys(), ...nextCash.keys(), ...deltas.keys()])) {
            expect((nextCash.get(currency) ?? 0) - (priorCash.get(currency) ?? 0),
              "Phase-8 cash delta " + owner + "/" + currency)
              .toBeCloseTo(deltas.get(currency) ?? 0, 8);
          }
        }
        expect(after.monetaryAuthorities).toEqual(beforeMain!.monetaryAuthorities);
        const quantity = sales.reduce((sum, tx) => sum + tx.quantity!, 0);
        expect(quantity).toBeLessThanOrEqual(1 + 1e-8);
        const debit = payments.filter(tx =>
          tx.type === "MARKET_SALE" || tx.type === "CONSUMPTION_TAX")
          .reduce((sum, tx) => sum + tx.moneyAmount!, 0);
        const prior = beforeMain!.cohorts.get(funded.cohortId)!;
        const next = after.cohorts.get(funded.cohortId)!;
        expect((next.householdInventory.get(IRON) ?? 0) -
          (prior.householdInventory.get(IRON) ?? 0)).toBeCloseTo(quantity, 8);
        expect((prior.wallet.get(source.settlementCurrencyId) ?? 0) -
          (next.wallet.get(source.settlementCurrencyId) ?? 0)).toBeCloseTo(debit, 8);
        expect(allIron(after)).toBeCloseTo(allIron(beforeMain!), 8);
      };
      // Compare actual Phase-8 stock transitions, not Phase-4 receipts or
      // equality between runs whose Phase-7 residuals may legitimately differ.
      assertMain(result.context.transactions, afterMain!);
      expect(() => assertMain(result.context.transactions.filter(tx =>
        !(tx.phase === 8 && tx.type === "MARKET_SALE")), afterMain!)).toThrow();
      const original = afterMain!.cohorts.get(funded.cohortId)!;
      const forged: WorldState = {
        ...afterMain!,
        cohorts: new Map(afterMain!.cohorts).set(funded.cohortId, {
          ...original,
          householdInventory: beforeMain!.cohorts.get(funded.cohortId)!.householdInventory,
        }),
      };
      expect(() => assertMain(result.context.transactions, forged)).toThrow();
      // A zero-sum wrong-jurisdiction mutation preserves the buyer debit and
      // even makes the forged receipt agree with the forged owner balances.
      // The independent jurisdiction check must still reject it.
      const tax = result.context.transactions.find(tx => tx.phase === 8 &&
        tx.type === "CONSUMPTION_TAX" && tx.source?.type === "COHORT" &&
        tx.source.cohortId === funded.cohortId)!;
      const rightId = source.controllerStateId;
      const wrongId = [...afterMain!.states.keys()].find(id => id !== rightId);
      if (!rightId || !wrongId || !tax || tax.moneyAmount === undefined)
        throw new Error("Wrong-recipient control requires two States and a real tax");
      const currency = source.settlementCurrencyId;
      const right = afterMain!.states.get(rightId)!;
      const wrong = afterMain!.states.get(wrongId)!;
      const amount = tax.moneyAmount;
      const misdirected: WorldState = {
        ...afterMain!,
        states: new Map(afterMain!.states)
          .set(rightId, { ...right, treasury: new Map(right.treasury)
            .set(currency, (right.treasury.get(currency) ?? 0) - amount) })
          .set(wrongId, { ...wrong, treasury: new Map(wrong.treasury)
            .set(currency, (wrong.treasury.get(currency) ?? 0) + amount) }),
      };
      expect(() => assertMain(result.context.transactions, misdirected)).toThrow();
      const misdirectedJournal = result.context.transactions.map(tx => tx === tax
        ? { ...tx, destination: { type: "STATE" as const, stateId: wrongId } }
        : tx);
      expect(() => assertMain(misdirectedJournal, misdirected)).toThrow();
    },
  );

});
