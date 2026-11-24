/**
 * #676 / REQ-ACCEPTANCE-006: active production/consumption/trade replay.
 * Unlike the passive 600-tick fixture, this short window opts in to the
 * canonical M4 labor, physical production and household realization owners.
 * No synthetic orders, stock replenishment or wage forecasts during the run.
 */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { NeedCategoryDefinition } from "../config/definitionPack";
import type { CurrencyId, GoodId, TransportLinkId } from "../domain/id";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { EconomicTransaction, PhaseHandler, TickContext } from "./tickOrchestrator";
import type { PhaseWorldTransitionObserver } from "./statefulTickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import type { WorldState } from "./worldState";

const IRON = "good:iron" as GoodId;
const WOOD = "good:wood" as GoodId;
const WINDOW = 12;
const phase1: PhaseHandler = (world, context) => context.phase === 1 ? {
  ...context,
  effectiveJurisdictionByRegion: new Map([...world.regions].map(
    ([id, region]) => [id, region.controllerStateId] as const,
  )),
} : context;

function add<K>(totals: Map<K, number>, key: K, delta: number): void {
  expect(Number.isFinite(delta)).toBe(true);
  totals.set(key, (totals.get(key) ?? 0) + delta);
}

function readStocks<K>(stocks: Iterable<ReadonlyMap<K, number>>): Map<K, number> {
  const totals = new Map<K, number>();
  for (const stock of stocks) for (const [key, quantity] of stock) {
    expect(quantity, "nonnegative stock " + String(key)).toBeGreaterThanOrEqual(0);
    add(totals, key, quantity);
  }
  return totals;
}

function goods(world: WorldState): Map<GoodId, number> {
  const totals = readStocks([
    ...[...world.productionUnits.values()].flatMap(unit =>
      [unit.inputInventory, unit.outputInventory, unit.investmentInventory]),
    ...[...world.states.values()].map(state => state.publicInventory),
    ...[...world.cohorts.values()].map(cohort => cohort.householdInventory),
  ]);
  for (const cargo of world.shipments?.values() ?? []) {
    expect(cargo.quantity).toBeGreaterThanOrEqual(0);
    add(totals, cargo.goodId, cargo.quantity);
  }
  return totals;
}

function cash(world: WorldState): Map<CurrencyId, number> {
  return readStocks([
    ...[...world.productionUnits.values()].map(unit => unit.wallet),
    ...[...world.states.values()].map(state => state.treasury),
    ...[...world.clans.values()].map(clan => clan.treasury),
    ...[...world.cohorts.values()].map(cohort => cohort.wallet),
    ...[...world.monetaryAuthorities.values()].flatMap(authority =>
      [...authority.fxPools.values()].map(pool => pool.cash)),
  ]);
}

function reconcile<K>(expected: ReadonlyMap<K, number>, actual: ReadonlyMap<K, number>,
  label: string): void {
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    expect(actual.get(key) ?? 0, label + " " + String(key))
      .toBeCloseTo(expected.get(key) ?? 0, 6);
  }
}

/** Reverse both registries and nested economic stores without changing values. */
function reversedRegistries(world: WorldState): WorldState {
  const rev = <K, V>(map: ReadonlyMap<K, V>): Map<K, V> => new Map([...map].reverse());
  return {
    ...world,
    regions: new Map([...world.regions].reverse().map(([id, region]) =>
      [id, { ...region, resourceDeposits: rev(region.resourceDeposits) }] as const)),
    states: new Map([...world.states].reverse().map(([id, state]) =>
      [id, { ...state, treasury: rev(state.treasury),
        publicInventory: rev(state.publicInventory) }] as const)),
    currencies: rev(world.currencies),
    monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(([id, authority]) =>
      [id, { ...authority, fxPools: new Map([...authority.fxPools].reverse().map(([poolId, pool]) =>
        [poolId, { ...pool, cash: rev(pool.cash) }] as const)) }] as const)),
    clans: new Map([...world.clans].reverse().map(([id, clan]) =>
      [id, { ...clan, treasury: rev(clan.treasury) }] as const)),
    cohorts: new Map([...world.cohorts].reverse().map(([id, cohort]) =>
      [id, { ...cohort, wallet: rev(cohort.wallet),
        householdInventory: rev(cohort.householdInventory) }] as const)),
    productionUnits: new Map([...world.productionUnits].reverse().map(([id, unit]) =>
      [id, { ...unit, wallet: rev(unit.wallet),
        inputInventory: rev(unit.inputInventory),
        outputInventory: rev(unit.outputInventory),
        investmentInventory: rev(unit.investmentInventory) }] as const)),
    markets: new Map([...world.markets].reverse().map(([id, market]) =>
      [id, { ...market, priceByGood: rev(market.priceByGood),
        expectationsByGood: rev(market.expectationsByGood) }] as const)),
    transportLinks: rev(world.transportLinks),
    ...(world.shipments ? { shipments: rev(world.shipments) } : {}),
    ...(world.outgoingTransportLinkIdsByRegion
      ? { outgoingTransportLinkIdsByRegion: rev(world.outgoingTransportLinkIdsByRegion) } : {}),
  };
}

/** Individual Phase-7 cash accounts, not just total currency stock. */
function cashByOwner(world: WorldState): Map<string, number> {
  const balances = new Map<string, number>();
  const record = (owner: string, wallet: ReadonlyMap<CurrencyId, number>) => {
    for (const [currency, amount] of wallet) {
      add(balances, JSON.stringify([owner, currency]), amount);
    }
  };
  for (const [id, unit] of world.productionUnits) record("PU:" + id, unit.wallet);
  for (const [id, cohort] of world.cohorts) record("COHORT:" + id, cohort.wallet);
  for (const [id, state] of world.states) record("STATE:" + id, state.treasury);
  for (const [id, clan] of world.clans) record("CLAN:" + id, clan.treasury);
  for (const [id, authority] of world.monetaryAuthorities) {
    for (const [pair, pool] of authority.fxPools) record("POOL:" + id + ":" + pair, pool.cash);
  }
  return balances;
}

/** Match every paid cargo to its own receipts and independently post the
 * monetary legs against actual Phase-7 opening/closing owner balances.
 * The FX sale is a nonposting invoice; counting it again is incorrect. */
function reconcilePaidBundles(
  before: WorldState, after: WorldState, cargos: readonly TradeShipmentState[],
  journal: readonly EconomicTransaction[], lossRate: number,
  jurisdiction: TickContext["effectiveJurisdictionByRegion"],
): void {
  const phase7 = journal.filter(tx => tx.phase === 7);
  const expected = cashByOwner(before);
  const move = (source: string, destination: string, currency: CurrencyId, amount: number) => {
    expect(amount).toBeGreaterThan(0);
    add(expected, JSON.stringify([source, currency]), -amount);
    add(expected, JSON.stringify([destination, currency]), amount);
  };
  const used = new Set<string>();
  const settlementIds = new Set<string>();
  const actor = (value: ActorRef | undefined) => {
    expect(value).toBeDefined();
    return actorRefKey(value!);
  };
  const count = (kind: string) => phase7.filter(tx => tx.type === kind).length;
  for (const kind of ["SHIPMENT_DISPATCH", "TRADE_GOODS_SALE", "FX_INPUT", "FX_OUTPUT"]) {
    expect(count(kind), kind).toBe(cargos.length);
  }
  for (const cargo of cargos) {
    const bundle = "tb:" + cargo.id.slice(3);
    expect(used.has(bundle)).toBe(false);
    used.add(bundle);
    expect(cargo.fxSettlementId).toBeDefined();
    expect(settlementIds.has(cargo.fxSettlementId!)).toBe(false);
    settlementIds.add(cargo.fxSettlementId!);
    const receipts = phase7.filter(tx => tx.bundleId === bundle);
    const one = (kind: string) => {
      const matches = receipts.filter(tx => tx.type === kind);
      expect(matches, bundle + " " + kind).toHaveLength(1);
      return matches[0]!;
    };
    const sale = one("TRADE_GOODS_SALE");
    const dispatch = one("SHIPMENT_DISPATCH");
    const input = one("FX_INPUT");
    const output = one("FX_OUTPUT");
    expect(cargo.beneficialOwner).toEqual(cargo.buyer);
    expect(sale.source).toEqual(cargo.buyer);
    expect(sale.destination).toEqual(cargo.seller);
    expect(dispatch.source).toEqual(cargo.seller);
    expect(dispatch.destination).toEqual(cargo.beneficialOwner);
    for (const receipt of [sale, dispatch]) {
      expect(receipt.goodId).toBe(cargo.goodId);
      expect(receipt.sourceRegionId).toBe(cargo.originRegionId);
      expect(receipt.destinationRegionId).toBe(cargo.destinationRegionId);
    }
    expect(sale.quantity).toBeGreaterThan(0);
    expect(dispatch.quantity).toBe(cargo.quantity);
    expect(cargo.quantity).toBeCloseTo(sale.quantity! * (1 - lossRate), 8);
    if (lossRate > 0) {
      const loss = one("GOODS_TRANSPORT_LOSS");
      expect(loss.source).toEqual(cargo.beneficialOwner);
      expect(loss.goodId).toBe(cargo.goodId);
      expect(loss.quantity).toBeCloseTo(sale.quantity! * lossRate, 8);
    } else {
      expect(receipts.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS")).toHaveLength(0);
    }
    for (const leg of [sale, input, output]) {
      expect(leg.fxSettlementId).toBe(cargo.fxSettlementId);
    }
    expect(input.source).toEqual(cargo.buyer);
    expect(output.destination).toEqual(cargo.seller);
    expect(input.currencyId).toBe(cargo.buyerPaymentCurrencyId);
    expect(output.currencyId).toBe(cargo.invoiceCurrencyId);
    expect(sale.currencyId).toBe(cargo.invoiceCurrencyId);
    expect(input.moneyAmount).toBeCloseTo(cargo.buyerGoodsPaymentAmount, 8);
    expect(output.moneyAmount).toBeCloseTo(sale.moneyAmount!, 8);
    expect(sale.moneyAmount).toBeCloseTo(cargo.sellerNetUnitPrice * sale.quantity!, 8);

    const pools = [...before.monetaryAuthorities].flatMap(([id, authority]) =>
      [...authority.fxPools].filter(([, pool]) =>
        (pool.baseCurrencyId === cargo.invoiceCurrencyId &&
          pool.quoteCurrencyId === cargo.buyerPaymentCurrencyId) ||
        (pool.quoteCurrencyId === cargo.invoiceCurrencyId &&
          pool.baseCurrencyId === cargo.buyerPaymentCurrencyId),
      ).map(([pair]) => "POOL:" + id + ":" + pair));
    expect(pools).toHaveLength(1);
    move(actor(cargo.buyer), pools[0]!, cargo.buyerPaymentCurrencyId, input.moneyAmount!);
    move(pools[0]!, actor(cargo.seller), cargo.invoiceCurrencyId, output.moneyAmount!);
    for (const [kind, amount] of [
      ["TRANSPORT_FEE", cargo.transportFeeAmount],
      ["IMPORT_TARIFF", cargo.tariffAmount],
      ["CONSUMPTION_TAX", cargo.consumptionTaxAmount],
    ] as const) {
      if (amount === 0) {
        expect(receipts.filter(tx => tx.type === kind)).toHaveLength(0);
      } else {
        const fee = one(kind);
        expect(fee.source).toEqual(cargo.buyer);
        expect(fee.currencyId).toBe(cargo.buyerPaymentCurrencyId);
        expect(fee.moneyAmount).toBeCloseTo(amount, 8);
        // Entitlement comes from the directed link or the activated jurisdiction,
        // never from the receipt whose correctness is being tested.
        const link = before.transportLinks.get(cargo.transportLinkId);
        expect(link).toBeDefined();
        const destination = before.regions.get(cargo.destinationRegionId);
        expect(destination).toBeDefined();
        const controller = jurisdiction?.get(cargo.destinationRegionId);
        expect(controller).toBe(destination!.controllerStateId);
        const recipient: ActorRef | null | undefined = kind === "TRANSPORT_FEE"
          ? link!.feeReceiver
          : controller == null ? null : { type: "STATE", stateId: controller };
        expect(recipient, kind + " policy recipient").toBeTruthy();
        expect(fee.destination, kind + " policy recipient").toEqual(recipient);
        move(actor(cargo.buyer), actor(recipient!), cargo.buyerPaymentCurrencyId, amount);
      }
    }
  }
  // No orphan monetary or physical-loss receipts may hide outside paid bundles.
  for (const tx of phase7) {
    if (tx.moneyAmount !== undefined || tx.type === "GOODS_TRANSPORT_LOSS") {
      expect(used.has(tx.bundleId ?? ""), tx.type).toBe(true);
    }
  }
  expect(count("GOODS_TRANSPORT_LOSS")).toBe(lossRate > 0 ? cargos.length : 0);
  reconcile(expected, cashByOwner(after), "phase-7 owner cash");
}

function activeFixture(lossRate: number, competingRoutes = false) {
  const { opening: base, options } = createM5PreviewScenario();
  const recipe = base.definitionRegistry.recipes["recipe:tools-craft"]!;
  const workers = [...base.regions.values()].map(region => {
    const worker = [...base.cohorts.values()].find(cohort =>
      cohort.seed.regionKey === region.seed.key && cohort.seed.ageBand === "WORKING")!;
    expect(worker).toBeDefined();
    return {
      ...worker,
      seed: { ...worker.seed, laborCategory: recipe.laborCategory,
        population: 1000, healthIndex: 1, employmentRateEma: 1 },
      wallet: new Map([[region.settlementCurrencyId, 0]]),
      householdInventory: new Map<GoodId, number>(),
    };
  });
  const need = (id: string, goodId: GoodId, priority: number, target: number):
    NeedCategoryDefinition => ({
      id, perCapitaTarget: target, priority,
      substitutionGoods: [{ goodId, basePreference: 1, qualityFactor: 1 }],
      priceSensitivity: 1, inventoryCarryoverTicks: 0,
    });
  let opening: WorldState = {
    ...base,
    transportLinks: new Map([...base.transportLinks].map(([id, link]) => [
      id, {
        ...link,
        seed: { ...link.seed, routinePhysicalLossRate: lossRate },
        // Use a distinct configured transport owner so a destination-treasury
        // fallback cannot accidentally pass the transport entitlement check.
        feeReceiver: { type: "STATE" as const,
          stateId: base.regions.get(link.fromRegionId)!.controllerStateId! },
      },
    ] as const)),
    productionUnits: new Map([...base.productionUnits].map(([id, unit]) => [
      id, unit.status === "ACTIVE" ? {
        ...unit, inputInventory: new Map(unit.inputInventory).set(WOOD, 1000),
      } : unit,
    ] as const)),
    cohorts: new Map(workers.map(worker => [worker.cohortId, worker] as const)),
    simulationConfig: { ...base.simulationConfig,
      population: { ...base.simulationConfig.population,
        minHouseholdCashPerCapita: 0, liquidityFloorShare: 0 } },
    definitionRegistry: { ...base.definitionRegistry, needCategories: {
      ESSENTIAL_FOOD: need("ESSENTIAL_FOOD", "good:grain" as GoodId, 4, 0),
      BASIC_GOODS: need("BASIC_GOODS", IRON, 3, 0.01),
      SERVICES: need("SERVICES", "good:tools" as GoodId, 2, 0),
      COMFORT: need("COMFORT", "good:cloth" as GoodId, 1, 0),
    } },
  };
  let tradeOptions = options;
  if (competingRoutes) {
    // Two explicitly configured parallel direct links share the same residual
    // sellers, buyers and FX pool. The cheap link alone cannot fill demand.
    const primary = [...opening.transportLinks.values()][0]!;
    const alternateId = "tl:999" as TransportLinkId; // isolated fixture identity
    expect(opening.transportLinks.has(alternateId)).toBe(false);
    const alternate = {
      ...primary, linkId: alternateId,
      seed: { ...primary.seed, key: primary.seed.key + ":alternate",
        baseTransportCost: primary.seed.baseTransportCost * 1.05 },
    };
    const links = new Map([
      [primary.linkId, { ...primary, seed: { ...primary.seed, baseCapacity: 1 } }],
      [alternateId, alternate],
    ]);
    opening = {
      ...opening, transportLinks: links,
      outgoingTransportLinkIdsByRegion: new Map([
        [primary.fromRegionId, [...links.keys()].sort()],
      ]),
    };
    tradeOptions = {
      ...options,
      infrastructureFactors: new Map([...links.keys()].map(id => [id, 1] as const)),
      phase1TradeLawProvider: query =>
        links.has(query.linkId) && query.goodId === IRON ? null : undefined,
    };
  }
  const tick = (world: WorldState, number: number, observer?: PhaseWorldTransitionObserver) =>
    executeM5AutonomousRegionalTradeTick(world, number, phase1, (_phase, current) => current, {
      ...tradeOptions,
      planHouseholdNeedsInPhase2: true,
      settleLaborAndProductionInPhase5: true,
      settleMainMarketInPhase8: true,
      realizeHouseholdConsumptionInPhase9: true,
    }, observer);
  return { opening, tick };
}

describe("M5 #676 active-cycle physical golden", () => {
  it.each([
    { lossRate: 0, competingRoutes: false },
    { lossRate: 0.25, competingRoutes: false },
    { lossRate: 0.25, competingRoutes: true },
  ])("reconciles active replay (loss=$lossRate, competing=$competingRoutes)", ({ lossRate, competingRoutes }) => {
    const { opening, tick } = activeFixture(lossRate, competingRoutes);
    let world = opening;
    let replay = opening;
    let reordered = reversedRegistries(opening);
    expect(opening.cohorts.size).toBeGreaterThan(1);
    expect([...reordered.cohorts.keys()]).toEqual([...opening.cohorts.keys()].reverse());
    expect([...reordered.cohorts.keys()]).not.toEqual([...opening.cohorts.keys()]);
    const market = [...opening.markets.values()].find(item => item.priceByGood.size > 1)!;
    expect(market).toBeDefined();
    expect([...reordered.markets.get(market.marketId)!.priceByGood.keys()])
      .toEqual([...market.priceByGood.keys()].reverse());
    const issuer = [...opening.monetaryAuthorities.entries()].find(([, authority]) =>
      [...authority.fxPools.values()].some(pool => pool.cash.size > 1))!;
    expect(issuer).toBeDefined();
    const [poolId, pool] = [...issuer[1].fxPools.entries()].find(([, p]) => p.cash.size > 1)!;
    expect([...reordered.monetaryAuthorities.get(issuer[0])!.fxPools.get(poolId)!.cash.keys()])
      .toEqual([...pool.cash.keys()].reverse());
    const expectedCash = cash(opening);
    const expectedGoods = goods(opening);
    let productiveTicks = 0;
    let consumptionTicks = 0;
    let dispatchTicks = 0;
    let deliveryTicks = 0;
    let omittedOutputRejected = false;
    let omittedConsumptionRejected = false;
    let lossTicks = 0;
    let omittedLossRejected = false;
    let wrongPayeeRejected = false;
    let paidBundleTicks = 0;
    let simultaneousRouteTicks = 0;
    let narrowRouteSaturated = false;
    const chargeKinds = ["TRANSPORT_FEE", "IMPORT_TARIFF", "CONSUMPTION_TAX"] as const;
    const misroutingRejected = new Set<string>();

    for (let offset = 0; offset < WINDOW; offset += 1) {
      const number = M5_PREVIEW_TICK + offset;
      const a = tick(world, number, (phase, before, after, context) => {
        if (phase !== 7) return;
        const cargos = context.phase7DispatchedShipments;
        expect(Array.isArray(cargos)).toBe(true);
        const jurisdiction = context.effectiveJurisdictionByRegion;
        reconcilePaidBundles(before, after, cargos!, context.transactions, lossRate, jurisdiction);
        // Charge the gross paid quantity against each route independently,
        // not the surviving cargo after physical loss and not a global cap.
        const usedCapacity = new Map<TransportLinkId, number>();
        for (const cargo of cargos!) {
          const sale = context.transactions.find(tx => tx.phase === 7 &&
            tx.type === "TRADE_GOODS_SALE" && tx.bundleId === "tb:" + cargo.id.slice(3));
          expect(sale?.quantity).toBeGreaterThan(0);
          const weight = before.definitionRegistry.goods[cargo.goodId]!.cargoWeightPerUnit;
          add(usedCapacity, cargo.transportLinkId, sale!.quantity! * weight);
        }
        for (const [id, use] of usedCapacity) {
          const link = before.transportLinks.get(id)!;
          expect(link).toBeDefined();
          const cap = link.seed.baseCapacity * link.seed.condition; // fixture factor = 1
          expect(use, "gross route capacity " + id)
            .toBeLessThanOrEqual(cap + before.simulationConfig.numeric.quantityEpsilon!);
          if (competingRoutes && link.seed.baseCapacity === 1 &&
              Math.abs(use - cap) <= before.simulationConfig.numeric.quantityEpsilon!) {
            narrowRouteSaturated = true;
          }
        }
        if (usedCapacity.size > 1) simultaneousRouteTicks++;
        // Corrupt both the journal and the closing wallets consistently. A
        // receipt-driven owner-balance oracle alone would accept this transfer.
        for (const kind of chargeKinds) {
          if (misroutingRejected.has(kind)) continue;
          const fee = context.transactions.find(tx => tx.phase === 7 && tx.type === kind);
          if (!fee) continue;
          expect(fee.destination?.type).toBe("STATE");
          if (fee.destination?.type !== "STATE") throw new Error("expected State charge");
          const actualId = fee.destination.stateId;
          const otherId = [...before.regions.values()].map(region => region.controllerStateId)
            .find(id => id !== null && id !== actualId);
          expect(otherId).toBeDefined();
          if (otherId == null) throw new Error("missing alternate State");
          const currency = fee.currencyId!;
          const amount = fee.moneyAmount!;
          expect(amount).toBeGreaterThan(0);
          const states = new Map(after.states);
          for (const [id, delta] of [[actualId, -amount], [otherId, amount]] as const) {
            const state = states.get(id)!;
            const treasury = new Map(state.treasury);
            treasury.set(currency, (treasury.get(currency) ?? 0) + delta);
            states.set(id, { ...state, treasury });
          }
          const forgedWorld = { ...after, states };
          const forgedJournal = context.transactions.map(tx => tx === fee
            ? { ...tx, destination: { type: "STATE" as const, stateId: otherId } } : tx);
          reconcile(cash(after), cash(forgedWorld), "misrouting preserves currency totals");
          expect(() => reconcilePaidBundles(
            before, forgedWorld, cargos!, forgedJournal, lossRate, jurisdiction,
          )).toThrow(kind + " policy recipient");
          misroutingRejected.add(kind);
        }
        if (cargos!.length > 0) {
          paidBundleTicks++;
          if (!wrongPayeeRejected) {
            const cargo = cargos![0]!;
            const forged = context.transactions.map(tx =>
              tx.type === "FX_OUTPUT" && tx.fxSettlementId === cargo.fxSettlementId
                ? { ...tx, destination: cargo.buyer } : tx);
            // Same amount, same currency and same bundle, but the wrong recipient.
            expect(() => reconcilePaidBundles(before, after, cargos!, forged, lossRate, jurisdiction)).toThrow();
            wrongPayeeRejected = true;
          }
        }
      });
      const b = tick(replay, number);
      // Reorder the carried state too, including shipments created after genesis.
      const c = tick(reordered, number);
      for (const result of [a, b, c]) {
        expect(result.phaseTrace).toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
      }
      expect(b.context.transactions).toEqual(a.context.transactions);
      expect(b.world).toEqual(a.world);
      expect(c.context.transactions, "reordered journal at tick " + number)
        .toEqual(a.context.transactions);
      expect(c.world, "reordered world at tick " + number).toEqual(a.world);

      // Use realized physical flows, not stock differences or the engine's
      // own reconciliation result, to carry the expected per-good balance.
      const production = a.context.productionExecutions!;
      const consumption = a.context.householdConsumptionExecutions!;
      expect(Array.isArray(production)).toBe(true);
      expect(Array.isArray(consumption)).toBe(true);
      for (const item of production) {
        for (const [goodId, quantity] of Object.entries(item.inputConsumedByGood)) {
          add(expectedGoods, goodId as GoodId, -quantity);
        }
        add(expectedGoods, item.outputGoodId, item.outputProducedQuantity);
      }
      for (const item of consumption) {
        for (const flows of [item.consumedByGood, item.spoiledByGood]) {
          for (const [goodId, quantity] of Object.entries(flows)) {
            add(expectedGoods, goodId as GoodId, -quantity);
          }
        }
      }
      // This fixture trades only iron over one or two direct links. The gross
      // paid invoice is independent of the physical loss receipt.
      const invoices = a.context.transactions.filter(tx =>
        tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
      const losses = a.context.transactions.filter(tx => tx.type === "GOODS_TRANSPORT_LOSS");
      let gross = 0;
      for (const invoice of invoices) {
        expect(invoice.goodId).toBe(IRON);
        expect(invoice.quantity).toBeGreaterThan(0);
        gross += invoice.quantity!;
      }
      let destroyed = 0;
      for (const tx of losses) {
        expect(tx.phase).toBe(7);
        expect(tx.goodId).toBe(IRON);
        expect(tx.quantity).toBeGreaterThan(0);
        expect(tx.moneyAmount).toBeUndefined();
        expect(tx.currencyId).toBeUndefined();
        destroyed += tx.quantity!;
        add(expectedGoods, tx.goodId!, -tx.quantity!);
      }
      const departing = [...(a.world.shipments?.values() ?? [])].filter(
        cargo => cargo.departureTick === number);
      const surviving = departing.reduce((sum, cargo) => sum + cargo.quantity, 0);
      expect(destroyed).toBeCloseTo(gross * lossRate, 8);
      expect(surviving).toBeCloseTo(gross * (1 - lossRate), 8);
      const actual = goods(a.world);
      if (destroyed > 0) {
        lossTicks++;
        if (!omittedLossRejected) {
          const forged = new Map(expectedGoods);
          add(forged, IRON, destroyed);
          expect(() => reconcile(forged, actual, "omitted real transport loss")).toThrow();
          omittedLossRejected = true;
        }
      }
      reconcile(expectedGoods, actual, "physical tick " + number);
      reconcile(expectedGoods, goods(b.world), "replay physical tick " + number);
      reconcile(expectedCash, cash(a.world), "currency tick " + number);
      reconcile(expectedCash, cash(b.world), "replay currency tick " + number);
      reconcile(expectedGoods, goods(c.world), "reordered physical tick " + number);
      reconcile(expectedCash, cash(c.world), "reordered currency tick " + number);

      const output = production.find(item => item.outputProducedQuantity > 0);
      if (output) {
        productiveTicks++;
        if (!omittedOutputRejected) {
          const forged = new Map(expectedGoods);
          add(forged, output.outputGoodId, -output.outputProducedQuantity);
          expect(() => reconcile(forged, actual, "omitted real output")).toThrow();
          omittedOutputRejected = true;
        }
      }
      const consumed = consumption.reduce((sum, item) =>
        sum + (item.consumedByGood[IRON] ?? 0), 0);
      if (consumed > 0) {
        consumptionTicks++;
        if (!omittedConsumptionRejected) {
          const forged = new Map(expectedGoods);
          add(forged, IRON, consumed);
          expect(() => reconcile(forged, actual, "omitted real consumption")).toThrow();
          omittedConsumptionRejected = true;
        }
      }
      const journal = a.context.transactions;
      if (journal.some(tx => tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH")) {
        expect(journal.some(tx => tx.phase === 7 && tx.type === "FX_OUTPUT")).toBe(true);
        dispatchTicks++;
      }
      if (journal.some(tx => tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY")) {
        deliveryTicks++;
      }
      world = a.world;
      replay = b.world;
      reordered = reversedRegistries(c.world);
    }
    // A dormant fixture cannot pass simply by replaying a static balance.
    expect(productiveTicks).toBeGreaterThanOrEqual(3);
    expect(consumptionTicks).toBeGreaterThanOrEqual(3);
    expect(dispatchTicks).toBeGreaterThanOrEqual(2);
    expect(paidBundleTicks).toBe(dispatchTicks);
    if (competingRoutes) {
      expect(simultaneousRouteTicks, "both routes must actually dispatch in the same tick")
        .toBeGreaterThan(0);
      expect(narrowRouteSaturated, "cheap route must exercise its physical bottleneck").toBe(true);
    } else {
      expect(simultaneousRouteTicks).toBe(0);
    }
    expect(wrongPayeeRejected).toBe(true);
    expect([...misroutingRejected].sort()).toEqual([...chargeKinds].sort());
    expect(deliveryTicks).toBeGreaterThan(0);
    expect(omittedOutputRejected).toBe(true);
    expect(omittedConsumptionRejected).toBe(true);
    if (lossRate > 0) {
      expect(lossTicks).toBeGreaterThanOrEqual(2);
      expect(omittedLossRejected).toBe(true);
    } else {
      expect(lossTicks).toBe(0);
    }
  }, 120_000);
});
