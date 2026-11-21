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
import type { ActorRef } from "../domain/genesisLedger";
import { actorRefKey } from "../domain/genesisLedger";
import { readActorWallet } from "./marketSettlementTransition";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { FxLedgerLeg } from "./fxSettlement";
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


/**
 * Phase-7 seller custody must lose the GROSS invoice quantity, not merely
 * surviving cargo after dispatch loss. In this fixture CLOSING producers sell
 * their INPUT stock; check every producer, including non-sellers, each tick.
 */
function assertGrossSellerDebits(
  before: WorldState, after: WorldState,
  fresh: readonly TradeShipmentState[], sales: readonly EconomicTransaction[],
): void {
  expect(sales).toHaveLength(fresh.length);
  const bySeller = new Map<string, number>();
  for (const cargo of fresh) {
    expect(cargo.seller.type).toBe("PRODUCTION_UNIT");
    if (cargo.seller.type !== "PRODUCTION_UNIT") {
      throw new Error("Expected a physical producer seller");
    }
    const matched = sales.filter(tx => tx.fxSettlementId === cargo.fxSettlementId);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.destination).toEqual(cargo.seller);
    expect(matched[0]!.goodId).toBe(IRON);
    expect(matched[0]!.quantity).toBeGreaterThan(0);
    const id = cargo.seller.productionUnitId;
    bySeller.set(id, (bySeller.get(id) ?? 0) + matched[0]!.quantity!);
  }
  for (const [id, seller] of before.productionUnits) {
    const next = after.productionUnits.get(id);
    expect(next).toBeDefined();
    const debit = (seller.inputInventory.get(IRON) ?? 0) -
      (next!.inputInventory.get(IRON) ?? 0);
    expect(debit, "Phase-7 gross stock debit for producer " + id)
      .toBeCloseTo(bySeller.get(id) ?? 0, 6);
  }
}


/**
 * Every Phase-7 FX leg must post to its named physical issuer pool, in the
 * correct currency and direction. Global currency conservation alone cannot
 * detect money moved from a seller wallet into the wrong reserve account.
 */
function actorExists(world: WorldState, actor: ActorRef): boolean {
  switch (actor.type) {
    case "COHORT": return world.cohorts.has(actor.cohortId);
    case "CLAN": return world.clans.has(actor.clanId);
    case "STATE": return world.states.has(actor.stateId);
    case "PRODUCTION_UNIT": return world.productionUnits.has(actor.productionUnitId);
    case "MONETARY_AUTHORITY": return world.monetaryAuthorities.has(actor.authorityId);
  }
}

function assertPhase7FxPoolCash(
  before: WorldState, after: WorldState, legs: readonly FxLedgerLeg[],
): void {
  for (const leg of legs) {
    expect(leg.phase).toBe(7);
    expect(leg.moneyAmount).toBeGreaterThan(0);
    const endpoint = leg.type === "FX_INPUT" ? leg.toAccount : leg.fromAccount;
    const counterparty = leg.type === "FX_INPUT" ? leg.fromAccount : leg.toAccount;
    expect(endpoint.type).toBe("FX_POOL");
    expect(counterparty.type).toBe("ACTOR");
    if (endpoint.type !== "FX_POOL") throw new Error("FX leg has no physical pool endpoint");
    if (counterparty.type !== "ACTOR") throw new Error("FX leg has no physical actor endpoint");
    const owner = leg.type === "FX_INPUT" ? leg.source : leg.destination;
    expect(owner, "FX journal must name its actual payer/recipient").toBeDefined();
    if (!owner) throw new Error("FX leg has no journal actor");
    expect(counterparty.actor, "FX account must name the actual journal actor").toEqual(owner);
    expect(actorExists(before, owner), "FX payer/recipient must exist before Phase 7").toBe(true);
    expect(actorExists(after, owner), "FX payer/recipient must exist after Phase 7").toBe(true);
    const pool = before.monetaryAuthorities.get(endpoint.owningAuthorityId)
      ?.fxPools.get(endpoint.pairId);
    expect(pool, "FX journal must name an existing authority-owned pool").toBeDefined();
    expect(pool!.cash.has(leg.currencyId)).toBe(true);
  }
  for (const [authorityId, authority] of before.monetaryAuthorities) {
    const nextAuthority = after.monetaryAuthorities.get(authorityId);
    expect(nextAuthority).toBeDefined();
    expect(nextAuthority!.fxPools.size).toBe(authority.fxPools.size);
    for (const [pairId, pool] of authority.fxPools) {
      const nextPool = nextAuthority!.fxPools.get(pairId);
      expect(nextPool).toBeDefined();
      for (const currencyId of new Set([...pool.cash.keys(), ...nextPool!.cash.keys()])) {
        const postedDelta = legs.reduce((sum, leg) => {
          const endpoint = leg.type === "FX_INPUT" ? leg.toAccount : leg.fromAccount;
          return endpoint.type === "FX_POOL" &&
            endpoint.owningAuthorityId === authorityId &&
            endpoint.pairId === pairId && leg.currencyId === currencyId
            ? sum + (leg.type === "FX_INPUT" ? leg.moneyAmount : -leg.moneyAmount)
            : sum;
        }, 0);
        const observedDelta = (nextPool!.cash.get(currencyId) ?? 0) -
          (pool.cash.get(currencyId) ?? 0);
        // settleFx uses this absolute (not relative) money posting bound.
        const epsilon = before.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
        expect(Math.abs(observedDelta - postedDelta),
          "Phase-7 issuer pool " + pairId + " / " + currencyId + " posting error")
          .toBeLessThanOrEqual(epsilon);
      }
    }
  }
}


/**
 * A balanced Phase-7 journal must land on the exact buyer, seller, transporter
 * and taxing-State wallets. The invoice SALE is informational: FX_INPUT/OUTPUT
 * are the actual principal postings, with separate fee/tax cash legs.
 * Aggregate currency and FX-pool conservation cannot catch a wrong recipient.
 */
function assertPhase7ActorCash(
  before: WorldState, after: WorldState, journal: readonly EconomicTransaction[],
): void {
  const expectedDeltas = new Map<string, number>();
  const key = (actor: ActorRef, currency: string): string =>
    JSON.stringify([actorRefKey(actor), currency]);
  const stage = (actor: ActorRef, currency: string, delta: number): void => {
    expect(actor.type).not.toBe("MONETARY_AUTHORITY");
    expect(actorExists(before, actor)).toBe(true);
    expect(actorExists(after, actor)).toBe(true);
    expect(before.currencies.has(currency as never)).toBe(true);
    const id = key(actor, currency);
    expectedDeltas.set(id, (expectedDeltas.get(id) ?? 0) + delta);
  };
  for (const tx of journal) {
    if (tx.phase !== 7) continue;
    if (tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT") {
      const leg = tx as FxLedgerLeg;
      const endpoint = leg.type === "FX_INPUT" ? leg.fromAccount : leg.toAccount;
      expect(endpoint.type).toBe("ACTOR");
      if (endpoint.type !== "ACTOR") throw new Error("FX principal has no actor endpoint");
      stage(endpoint.actor, leg.currencyId,
        leg.type === "FX_INPUT" ? -leg.moneyAmount : leg.moneyAmount);
    } else if (tx.type === "TRANSPORT_FEE" ||
               tx.type === "IMPORT_TARIFF" || tx.type === "CONSUMPTION_TAX") {
      expect(tx.source).toBeDefined();
      expect(tx.destination).toBeDefined();
      expect(tx.currencyId).toBeDefined();
      expect(tx.moneyAmount).toBeGreaterThan(0);
      if (!tx.source || !tx.destination || !tx.currencyId ||
          tx.moneyAmount === undefined) throw new Error("Charge has missing cash endpoint");
      stage(tx.source, tx.currencyId, -tx.moneyAmount);
      stage(tx.destination, tx.currencyId, tx.moneyAmount);
    }
  }
  const actors: ActorRef[] = [
    ...[...before.states.keys()].map(stateId => ({ type: "STATE" as const, stateId })),
    ...[...before.clans.keys()].map(clanId => ({ type: "CLAN" as const, clanId })),
    ...[...before.cohorts.keys()].map(cohortId => ({ type: "COHORT" as const, cohortId })),
    ...[...before.productionUnits.keys()].map(productionUnitId =>
      ({ type: "PRODUCTION_UNIT" as const, productionUnitId })),
  ];
  const epsilon = before.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  for (const actor of actors) {
    expect(actorExists(after, actor)).toBe(true);
    const opening = readActorWallet(before, actor);
    const closing = readActorWallet(after, actor);
    for (const currency of before.currencies.keys()) {
      const observed = (closing.get(currency) ?? 0) - (opening.get(currency) ?? 0);
      const expected = expectedDeltas.get(key(actor, currency)) ?? 0;
      expect(Math.abs(observed - expected),
        "Phase-7 exact actor cash " + actorRefKey(actor) + " / " + currency)
        .toBeLessThanOrEqual(epsilon);
    }
  }
}


/**
 * Reconcile every departing cargo's FROZEN buyer-currency fee/tax snapshot to
 * its real Phase-7 payment bundle. Later arrivals must never charge that old
 * bundle again, even while new dispatches and tax policy continue to change.
 */
function assertPaidDispatchCharges(
  opening: WorldState, journal: readonly EconomicTransaction[],
  fresh: readonly TradeShipmentState[], due: readonly TradeShipmentState[],
): void {
  const kinds = ["TRANSPORT_FEE", "IMPORT_TARIFF", "CONSUMPTION_TAX"] as const;
  const epsilon = opening.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
  const bundle = (cargo: TradeShipmentState): string => {
    if (!String(cargo.id).startsWith("sh:m5fx:")) {
      throw new Error("Paid M5 cargo must have a canonical FX dispatch ID");
    }
    return "tb:" + String(cargo.id).slice(3);
  };
  let positiveCharges = 0;
  for (const cargo of fresh) {
    const link = opening.transportLinks.get(cargo.transportLinkId);
    expect(link, "dispatched cargo must reference an existing link").toBeDefined();
    expect(link!.fromRegionId).toBe(cargo.originRegionId);
    expect(link!.toRegionId).toBe(cargo.destinationRegionId);
    const destinationState = opening.regions.get(cargo.destinationRegionId)?.controllerStateId;
    for (const [type, amount] of [
      ["TRANSPORT_FEE", cargo.transportFeeAmount],
      ["IMPORT_TARIFF", cargo.tariffAmount],
      ["CONSUMPTION_TAX", cargo.consumptionTaxAmount],
    ] as const) {
      const legs = journal.filter(tx =>
        tx.phase === 7 && tx.bundleId === bundle(cargo) && tx.type === type);
      expect(legs, "dispatch " + cargo.id + " " + type)
        .toHaveLength(amount > 0 ? 1 : 0);
      if (amount <= 0) continue;
      positiveCharges++;
      const leg = legs[0]!;
      expect(leg.currencyId).toBe(cargo.buyerPaymentCurrencyId);
      expect(leg.source).toEqual(cargo.buyer);
      expect(leg.moneyAmount).toBeDefined();
      expect(Math.abs(leg.moneyAmount! - amount)).toBeLessThanOrEqual(epsilon);
      if (type === "TRANSPORT_FEE") {
        const receiver = link!.feeReceiver;
        expect(receiver, "positive transport fee requires a configured link receiver")
          .toBeDefined();
        expect(receiver).not.toBeNull();
        if (!receiver) throw new Error("Paid transport link has no fee receiver");
        expect(actorExists(opening, receiver), "fee receiver must exist in opening world")
          .toBe(true);
        expect(leg.destination).toEqual(receiver);
      } else {
        expect(destinationState).not.toBeNull();
        expect(destinationState).toBeDefined();
        expect(leg.destination).toEqual({ type: "STATE", stateId: destinationState });
      }
    }
  }
  // Reject unowned extra charges not matched to ANY fresh shipment, as well
  // as duplicate legs or silently missing charge snapshots.
  expect(journal.filter(tx => tx.phase === 7 &&
    kinds.some(kind => kind === tx.type))).toHaveLength(positiveCharges);
  for (const cargo of due) {
    expect(journal.filter(tx => tx.phase === 7 && tx.bundleId === bundle(cargo) &&
      (kinds.some(kind => kind === tx.type) ||
       tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT")))
      .toHaveLength(0);
  }
}

describe("M5 #676: 240-tick paid FX attrition and delayed-arrival replay", () => {
  it("shrinks a funded shipment before seller stock mutation when FX headroom is positive but scarce", () => {
    // This is not the zero-FX refusal case: a real paid export is permitted,
    // but the only issuer's SOURCE-currency payout liquidity is deliberately
    // smaller than that export's settled invoice.
    const { opening, options } = createM5PreviewScenario();
    const run = (start: WorldState) => {
      let pre7: WorldState | undefined;
      let post7: WorldState | undefined;
      const result = executeM5AutonomousRegionalTradeTick(
        start, M5_PREVIEW_TICK, upstream, unchanged, options,
        (phase, before, after) => {
          if (phase === 7) { pre7 = before; post7 = after; }
        },
      );
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(pre7).toBeDefined();
      expect(post7).toBeDefined();
      return { result, pre7: pre7!, post7: post7! };
    };
    const full = run(opening);
    const fullOutputs = full.result.context.transactions.filter(
      (tx): tx is FxLedgerLeg => tx.phase === 7 && tx.type === "FX_OUTPUT");
    expect(fullOutputs).toHaveLength(1);
    const output = fullOutputs[0]!;
    if (output.fromAccount.type !== "FX_POOL") {
      throw new Error("Actual baseline export must be funded by an issuer FX pool");
    }
    const { owningAuthorityId, pairId } = output.fromAccount;
    const authority = opening.monetaryAuthorities.get(owningAuthorityId)!;
    const pool = authority.fxPools.get(pairId)!;
    const currency = output.currencyId;
    const floor = currency === pool.baseCurrencyId
      ? pool.minOperationalReserveBase : pool.minOperationalReserveQuote;
    expect(pool.cash.get(currency)).toBeGreaterThan(floor + output.moneyAmount);
    const allowedOutput = output.moneyAmount / 2;
    const scarce: WorldState = {
      ...opening,
      monetaryAuthorities: new Map(opening.monetaryAuthorities).set(
        owningAuthorityId, {
          ...authority,
          fxPools: new Map(authority.fxPools).set(pairId, {
            ...pool, cash: new Map(pool.cash).set(currency, floor + allowedOutput),
          }),
        },
      ),
    };
    const partial = run(scarce);
    const shuffledPartial = run(shuffled(scarce));
    const journal = partial.result.context.transactions;
    expect(shuffledPartial.result.context.transactions).toEqual(journal);
    expect(replayHash(shuffledPartial.result.world, shuffledPartial.result.context.transactions))
      .toBe(replayHash(partial.result.world, journal));
    const paidOutputs = journal.filter(
      (tx): tx is FxLedgerLeg => tx.phase === 7 && tx.type === "FX_OUTPUT");
    expect(paidOutputs).toHaveLength(1);
    const paid = paidOutputs[0]!;
    const epsilon = scarce.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
    expect(paid.moneyAmount).toBeGreaterThan(0);
    expect(paid.moneyAmount).toBeLessThan(output.moneyAmount);
    expect(paid.moneyAmount).toBeLessThanOrEqual(allowedOutput + epsilon);
    const sales = journal.filter(tx => tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
    const fullSales = full.result.context.transactions.filter(
      tx => tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
    expect(sales).toHaveLength(1);
    expect(fullSales).toHaveLength(1);
    expect(sales[0]!.quantity).toBeGreaterThan(0);
    expect(sales[0]!.quantity).toBeLessThan(fullSales[0]!.quantity!);
    // The gross quantity, not the loss-reduced cargo, must be debited from
    // the seller's source inventory. Verify actual Phase-7 before/after states.
    const fresh = [...partial.post7.shipments?.values() ?? []];
    expect(fresh).toHaveLength(1);
    assertGrossSellerDebits(partial.pre7, partial.post7, fresh, sales);
    assertPaidDispatchCharges(scarce, journal, fresh, []);
    assertPhase7FxPoolCash(partial.pre7, partial.post7, paidOutputs);
    assertPhase7ActorCash(partial.pre7, partial.post7, journal);
    assertLossReconciliation(scarce, partial.result.world, journal);
    for (const id of scarce.currencies.keys()) {
      expect(currencyTotal(partial.result.world, id))
        .toBeCloseTo(currencyTotal(scarce, id), 5);
    }
    const localSales = (tx: EconomicTransaction) =>
      tx.phase === 4 && tx.type === "MARKET_SALE";
    expect(journal.filter(localSales)).toEqual(
      full.result.context.transactions.filter(localSales));
    expect(journal.filter(localSales).length).toBeGreaterThan(0);
  }, 60_000);

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
    let checkedZeroCapacityBlock = false;
    let checkedZeroFxBlock = false;
    let rejectedOverCapacity = false;
    let delivered = 0;
    let blockedWithLocalSale = 0;
    let sawBadLossReject = false;
    let sawWrongDeliveryReject = false;
    let sawWrongTransitReject = false;
    let sawWrongSellerDebitReject = false;
    let sawMispostedPoolCashReject = false;
    let sawPrecisionMispostReject = false;
    let sawFxActorForgeryReject = false;
    let sawMispaidActorCashReject = false;
    let sawTariffSnapshotReject = false;
    let sawWrongTariffRecipientReject = false;
    let sawWrongFeeReceiverReject = false;
    const sentIds = new Set<string>();
    const deliveredIds = new Set<string>();
    // Evidence must include actual paid, positive-loss dispatch for BOTH policy
    // values. A 240-tick loop with a single opening shipment is not a witness.
    const openingWitnesses = new Map<number, {
      rate: number; paidCargoCount: number; physicalLossQuantity: number;
    }>();

    for (let offset = 0; offset < 240; offset++) {
      const tick = M5_PREVIEW_TICK + offset;
      const legalOpen = offset % 12 === 0;
      // Keep border permission OPEN, but physically close the link on some
      // otherwise-eligible opening ticks. Previously paid cargo may still arrive.
      const noCapacity = legalOpen && offset % 48 === 0;
      const open = legalOpen && !noCapacity;
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
      const options = legalOpen
        ? noCapacity
          ? { ...fixture.options, infrastructureFactors: new Map([[linkId, 0]]) }
          : fixture.options
        : { ...fixture.options, phase1TradeLawProvider: () => undefined };
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
      assertPaidDispatchCharges(start, journal, fresh, due);
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
      if (noCapacity) {
        // Legal permission, demand and funded FX are still available. The
        // physical zero must suppress ALL Phase-7 money, goods and charge legs.
        expect(physicalCapacity).toBe(0);
        const paidTypes = new Set([
          "SHIPMENT_DISPATCH", "TRADE_GOODS_SALE", "TRANSPORT_FEE",
          "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF", "CONSUMPTION_TAX",
        ]);
        expect(journal.filter(tx => tx.phase === 7 && paidTypes.has(tx.type)))
          .toHaveLength(0);
        expect(() => assertGrossCapacity([1])).toThrow();
        if (offset === 0) {
          // Non-vacuity: the exact same opening world CAN dispatch when only
          // the physical capacity is restored, without changing trade law.
          const allowed = executeM5AutonomousRegionalTradeTick(
            start, tick, upstream, unchanged, fixture.options,
          );
          expect(allowed.phaseBoundaryError).toBeUndefined();
          expect(allowed.reconciliationErrors).toBeNull();
          expect(allowed.context.transactions.filter(tx =>
            tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH").length)
            .toBeGreaterThan(0);
          const localSales = (tx: EconomicTransaction) =>
            tx.phase === 4 && tx.type === "MARKET_SALE";
          expect(journal.filter(localSales).length).toBeGreaterThan(0);
          expect(journal.filter(localSales))
            .toEqual(allowed.context.transactions.filter(localSales));
          checkedZeroCapacityBlock = true;

          // Independent zero-USABLE-FX fork of the same legally open,
          // physically available, locally trading opening world. Deplete the
          // actual paid leg's output reserve to its operational floor, not an
          // arbitrary pool, currency or artificially closed trade permission.
          const paidOutput = allowed.context.transactions.find((tx): tx is FxLedgerLeg =>
            tx.phase === 7 && tx.type === "FX_OUTPUT");
          expect(paidOutput).toBeDefined();
          if (!paidOutput || paidOutput.fromAccount.type !== "FX_POOL") {
            throw new Error("Positive trade witness must have a real issuer FX payout");
          }
          const { owningAuthorityId, pairId } = paidOutput.fromAccount;
          const authority = start.monetaryAuthorities.get(owningAuthorityId)!;
          const pool = authority.fxPools.get(pairId)!;
          const outputCurrency = paidOutput.currencyId;
          const floor = outputCurrency === pool.baseCurrencyId
            ? pool.minOperationalReserveBase : pool.minOperationalReserveQuote;
          expect([pool.baseCurrencyId, pool.quoteCurrencyId]).toContain(outputCurrency);
          expect(pool.cash.get(outputCurrency)).toBeGreaterThan(floor);
          const drained: WorldState = {
            ...start,
            monetaryAuthorities: new Map(start.monetaryAuthorities).set(
              owningAuthorityId, {
                ...authority,
                fxPools: new Map(authority.fxPools).set(pairId, {
                  ...pool, cash: new Map(pool.cash).set(outputCurrency, floor),
                }),
              },
            ),
          };
          const dry = executeM5AutonomousRegionalTradeTick(
            drained, tick, upstream, unchanged, fixture.options,
          );
          const dryReplay = executeM5AutonomousRegionalTradeTick(
            shuffled(drained), tick, upstream, unchanged, fixture.options,
          );
          for (const result of [dry, dryReplay]) {
            expect(result.phaseTrace).toEqual([...Array(16).keys()]);
            expect(result.phaseBoundaryError).toBeUndefined();
            expect(result.reconciliationErrors).toBeNull();
            expect(result.context.transactions.filter(tx =>
              tx.phase === 7 && paidTypes.has(tx.type))).toHaveLength(0);
            expect(result.world.shipments?.size ?? 0).toBe(0);
            expect(iron(result.world)).toBeCloseTo(iron(drained), 6);
            for (const currency of drained.currencies.keys()) {
              expect(currencyTotal(result.world, currency))
                .toBeCloseTo(currencyTotal(drained, currency), 5);
            }
            // Lack of FX must not turn off the Phase-4 domestic market.
            expect(result.context.transactions.filter(localSales))
              .toEqual(allowed.context.transactions.filter(localSales));
          }
          expect(dryReplay.context.transactions).toEqual(dry.context.transactions);
          expect(replayHash(dryReplay.world, dryReplay.context.transactions))
            .toBe(replayHash(dry.world, dry.context.transactions));
          checkedZeroFxBlock = true;
        }
      }
      expect(beforePhase7).toBeDefined();
      expect(afterPhase7).toBeDefined();
      assertGrossSellerDebits(beforePhase7!, afterPhase7!, fresh, sales);
      if (!sawWrongFeeReceiverReject) {
        const feeCargo = fresh.find(cargo => cargo.transportFeeAmount > 0);
        if (feeCargo) {
          const correctReceiver = start.transportLinks.get(feeCargo.transportLinkId)?.feeReceiver;
          expect(correctReceiver).toBeDefined();
          if (!correctReceiver) throw new Error("Need a real transport fee receiver");
          const candidates: ActorRef[] = [
            ...[...start.states.keys()].map(stateId => ({ type: "STATE" as const, stateId })),
            ...[...start.productionUnits.keys()].map(productionUnitId =>
              ({ type: "PRODUCTION_UNIT" as const, productionUnitId })),
          ];
          const wrongReceiver = candidates.find(actor =>
            actorRefKey(actor) !== actorRefKey(correctReceiver));
          expect(wrongReceiver, "need a distinct existing actor for fee diversion")
            .toBeDefined();
          const feeBundle = "tb:" + String(feeCargo.id).slice(3);
          const feeLeg = journal.find(tx => tx.phase === 7 &&
            tx.type === "TRANSPORT_FEE" && tx.bundleId === feeBundle);
          expect(feeLeg).toBeDefined();
          if (!feeLeg || !wrongReceiver) throw new Error("Need a paid fee and alternate actor");
          // Same real paid bundle, currency, amount and payer; redirect ONLY
          // the named cash beneficiary. Aggregate money remains balanced.
          const misrouted = journal.map(tx => tx === feeLeg
            ? { ...tx, destination: wrongReceiver } : tx);
          expect(() => assertPaidDispatchCharges(start, misrouted, fresh, due)).toThrow();
          sawWrongFeeReceiverReject = true;
        }
      }
      if (!sawTariffSnapshotReject) {
        const tariffed = fresh.find(cargo => cargo.tariffAmount > 0);
        if (tariffed) {
          // A forged frozen tariff can preserve every cash/goods balance yet
          // misrepresent the actual amount paid at dispatch.
          const forged = fresh.map(cargo => cargo === tariffed
            ? { ...cargo, tariffAmount: cargo.tariffAmount + 0.01 } : cargo);
          expect(() => assertPaidDispatchCharges(start, journal, forged, due)).toThrow();
          sawTariffSnapshotReject = true;

          const tariffBundle = "tb:" + String(tariffed.id).slice(3);
          const tariffLeg = journal.find(tx => tx.phase === 7 &&
            tx.type === "IMPORT_TARIFF" && tx.bundleId === tariffBundle);
          expect(tariffLeg).toBeDefined();
          const expectedState = start.regions.get(tariffed.destinationRegionId)!.controllerStateId;
          const wrongState = [...start.states.keys()].find(id => id !== expectedState);
          expect(wrongState).toBeDefined();
          if (!tariffLeg || !wrongState) throw new Error("Need real tax payer/receiver");
          const misrouted = journal.map(tx => tx === tariffLeg
            ? { ...tx, destination: { type: "STATE" as const, stateId: wrongState } }
            : tx);
          expect(() => assertPaidDispatchCharges(start, misrouted, fresh, due)).toThrow();
          sawWrongTariffRecipientReject = true;
        }
      }

      if (fresh.length && !sawWrongSellerDebitReject) {
        // Forged seller/cargo split leaves global iron and all money totals
        // unchanged. Gross origin-debit validation must still reject it.
        const cargo = fresh[0]!;
        if (cargo.seller.type !== "PRODUCTION_UNIT") {
          throw new Error("Expected a physical producer seller");
        }
        const id = cargo.seller.productionUnitId;
        const unit = afterPhase7!.productionUnits.get(id)!;
        const shift = cargo.quantity / 4;
        const units = new Map(afterPhase7!.productionUnits).set(id, {
          ...unit, inputInventory: new Map(unit.inputInventory).set(
            IRON, (unit.inputInventory.get(IRON) ?? 0) + shift,
          ),
        });
        const shipments = new Map(afterPhase7!.shipments).set(cargo.id, {
          ...cargo, quantity: cargo.quantity - shift,
        });
        const forged: WorldState = {
          ...afterPhase7!, productionUnits: units, shipments,
        };
        expect(iron(forged)).toBeCloseTo(iron(afterPhase7!), 8);
        expect(() => assertGrossSellerDebits(beforePhase7!, forged, fresh, sales))
          .toThrow();
        sawWrongSellerDebitReject = true;
      }
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

      const fxLegs = journal.filter((tx): tx is FxLedgerLeg =>
        tx.phase === 7 && (tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT"));
      assertPhase7FxPoolCash(beforePhase7!, afterPhase7!, fxLegs);
      assertPhase7ActorCash(beforePhase7!, afterPhase7!, journal);
      if (outputs.length && !sawMispaidActorCashReject) {
        // A balanced seller-to-other-producer transfer keeps each currency
        // total and every FX pool unchanged, but pays the wrong actual owner.
        const payout = fxLegs.find(leg => leg.type === "FX_OUTPUT")!;
        if (payout.destination?.type !== "PRODUCTION_UNIT") {
          throw new Error("Expected a real paid exporter");
        }
        const sellerId = payout.destination.productionUnitId;
        const otherId = [...afterPhase7!.productionUnits.keys()].find(id => id !== sellerId);
        expect(otherId).toBeDefined();
        if (!otherId) throw new Error("Missing distinct actor for wrong-owner control");
        const seller = afterPhase7!.productionUnits.get(sellerId)!;
        const other = afterPhase7!.productionUnits.get(otherId)!;
        const sellerCash = seller.wallet.get(payout.currencyId) ?? 0;
        const shift = Math.min(payout.moneyAmount / 4, sellerCash / 4);
        expect(shift).toBeGreaterThan(0);
        const units = new Map(afterPhase7!.productionUnits);
        units.set(sellerId, { ...seller, wallet: new Map(seller.wallet).set(
          payout.currencyId, sellerCash - shift) });
        units.set(otherId, { ...other, wallet: new Map(other.wallet).set(
          payout.currencyId, (other.wallet.get(payout.currencyId) ?? 0) + shift) });
        const forged = { ...afterPhase7!, productionUnits: units };
        expect(currencyTotal(forged, payout.currencyId))
          .toBeCloseTo(currencyTotal(afterPhase7!, payout.currencyId), 6);
        expect(forged.monetaryAuthorities).toEqual(afterPhase7!.monetaryAuthorities);
        expect(() => assertPhase7ActorCash(beforePhase7!, forged, journal)).toThrow();
        sawMispaidActorCashReject = true;
      }
      if (inputs.length && outputs.length && !sawFxActorForgeryReject) {
        // Forging only the named account endpoint (not the journal owner or
        // money amounts) must fail for both directions, for a real wrong actor
        // and an actor that has never existed in the world registry.
        const forgeActor = (leg: FxLedgerLeg, missing: boolean): void => {
          const owner = leg.type === "FX_INPUT" ? leg.source : leg.destination;
          if (owner?.type !== "PRODUCTION_UNIT") {
            throw new Error("Expected real producer buyer/exporter on paid FX leg");
          }
          const wrongId = missing
            ? ("pu:missing-fx-actor" as typeof owner.productionUnitId)
            : [...beforePhase7!.productionUnits.keys()].find(id => id !== owner.productionUnitId);
          expect(wrongId).toBeDefined();
          if (!wrongId) throw new Error("Missing distinct producer for negative control");
          expect(beforePhase7!.productionUnits.has(wrongId)).toBe(!missing);
          const badAccount = { type: "ACTOR" as const,
            actor: { type: "PRODUCTION_UNIT" as const, productionUnitId: wrongId } };
          const forged = fxLegs.map(item => item === leg
            ? leg.type === "FX_INPUT"
              ? { ...item, fromAccount: badAccount }
              : { ...item, toAccount: badAccount }
            : item);
          expect(() => assertPhase7FxPoolCash(beforePhase7!, afterPhase7!, forged))
            .toThrow();
        };
        const input = fxLegs.find(leg => leg.type === "FX_INPUT")!;
        const output = fxLegs.find(leg => leg.type === "FX_OUTPUT")!;
        forgeActor(input, false);
        forgeActor(input, true);
        forgeActor(output, false);
        forgeActor(output, true);
        sawFxActorForgeryReject = true;
      }
      if (outputs.length && !sawMispostedPoolCashReject) {
        // Preserve every currency total while misposting part of an issuer's
        // output reserve to a seller's account. Exact pool-ledger accounting,
        // not aggregate conservation, must detect the theft.
        const output = fxLegs.find(leg => leg.type === "FX_OUTPUT")!;
        if (output.fromAccount.type !== "FX_POOL" ||
            output.destination?.type !== "PRODUCTION_UNIT") {
          throw new Error("Expected pool-funded payment to a physical exporter");
        }
        const { owningAuthorityId, pairId } = output.fromAccount;
        const authority = afterPhase7!.monetaryAuthorities.get(owningAuthorityId)!;
        const pool = authority.fxPools.get(pairId)!;
        const sellerId = output.destination.productionUnitId;
        const seller = afterPhase7!.productionUnits.get(sellerId)!;
        const sellerCash = seller.wallet.get(output.currencyId) ?? 0;
        const shift = Math.min(output.moneyAmount / 4, sellerCash / 4);
        expect(shift).toBeGreaterThan(0);
        const forgePoolMispost = (divert: number): WorldState => ({
          ...afterPhase7!,
          monetaryAuthorities: new Map(afterPhase7!.monetaryAuthorities).set(
            owningAuthorityId, {
              ...authority, fxPools: new Map(authority.fxPools).set(pairId, {
                ...pool, cash: new Map(pool.cash).set(
                  output.currencyId, (pool.cash.get(output.currencyId) ?? 0) + divert,
                ),
              }),
            },
          ),
          productionUnits: new Map(afterPhase7!.productionUnits).set(sellerId, {
            ...seller, wallet: new Map(seller.wallet).set(
              output.currencyId, sellerCash - divert,
            ),
          }),
        });
        const forged = forgePoolMispost(shift);
        expect(currencyTotal(forged, output.currencyId))
          .toBeCloseTo(currencyTotal(afterPhase7!, output.currencyId), 6);
        expect(() => assertPhase7FxPoolCash(beforePhase7!, forged, fxLegs)).toThrow();
        sawMispostedPoolCashReject = true;
        // A 1e-7 balanced micro-mispost was accepted by the old 6-decimal
        // oracle. It exceeds the settlement contract's 1e-9 precision.
        const epsilon = beforePhase7!.simulationConfig.numeric.moneyEpsilon ?? 1e-9;
        const tinyShift = 1e-7;
        expect(tinyShift).toBeGreaterThan(epsilon);
        expect(sellerCash).toBeGreaterThan(tinyShift);
        const fineForged = forgePoolMispost(tinyShift);
        const changedPool = fineForged.monetaryAuthorities.get(owningAuthorityId)!
          .fxPools.get(pairId)!;
        expect(Math.abs((changedPool.cash.get(output.currencyId) ?? 0) -
          (pool.cash.get(output.currencyId) ?? 0))).toBeGreaterThan(epsilon);
        expect(Math.abs(currencyTotal(fineForged, output.currencyId) -
          currencyTotal(afterPhase7!, output.currencyId)))
          .toBeLessThanOrEqual(epsilon);
        expect(() => assertPhase7FxPoolCash(beforePhase7!, fineForged, fxLegs))
          .toThrow();
        sawPrecisionMispostReject = true;
      }
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
    expect(sawWrongSellerDebitReject).toBe(true);
    expect(sawMispostedPoolCashReject).toBe(true);
    expect(sawPrecisionMispostReject).toBe(true);
    expect(sawFxActorForgeryReject).toBe(true);
    expect(sawMispaidActorCashReject).toBe(true);
    expect(sawTariffSnapshotReject).toBe(true);
    expect(sawWrongTariffRecipientReject).toBe(true);
    expect(sawWrongFeeReceiverReject).toBe(true);
    expect(checkedPaidCapacity).toBe(true);
    expect(rejectedOverCapacity).toBe(true);
    expect(checkedZeroCapacityBlock).toBe(true);
    expect(checkedZeroFxBlock).toBe(true);
  }, 60_000);
});
