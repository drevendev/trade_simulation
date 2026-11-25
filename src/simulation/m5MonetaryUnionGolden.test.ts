/** #1169 / #676: shared legal tender does not remove a State border. */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { CurrencyId, GoodId, MonetaryAuthorityId } from "../domain/id";
import { actorRefKey, type ActorRef } from "../domain/genesisLedger";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler } from "./tickOrchestrator";
import type { PhaseWorldTransitionObserver } from "./statefulTickOrchestrator";
import type { MonetaryAuthorityState, WorldState } from "./worldState";

const phase1: PhaseHandler = (world, context) => context.phase === 1 ? {
  ...context, effectiveJurisdictionByRegion: new Map([...world.regions].map(
    ([id, region]) => [id, region.controllerStateId] as const,
  )),
} : context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;

function unionFixture() {
  const { opening: base, options } = createM5PreviewScenario();
  const link = [...base.transportLinks.values()][0]!;
  const source = base.regions.get(link.fromRegionId)!;
  const target = base.regions.get(link.toRegionId)!;
  const alpha = base.states.get(source.controllerStateId!)!;
  const beta = base.states.get(target.controllerStateId!)!;
  const issuer = base.monetaryAuthorities.get(alpha.memberAuthorityId!)!;
  const currency = source.settlementCurrencyId;
  const former = target.settlementCurrencyId;
  expect(alpha.stateId).not.toBe(beta.stateId);
  expect(currency).not.toBe(former);
  // Construct a different opening scenario, not a runtime redenomination.
  // Keep the preview's unrelated currencies and pools as negative controls.
  const shared = { currencyKey: source.seed.settlementCurrencyKey,
    regimeType: "MONETARY_UNION" as const, policyAuthorityKey: issuer.seed.key };
  const wallet = (old: ReadonlyMap<CurrencyId, number>) => {
    const next = new Map(old);
    next.set(currency, (next.get(currency) ?? 0) + (next.get(former) ?? 0));
    next.delete(former);
    return next;
  };
  const opening: WorldState = {
    ...base,
    regions: new Map(base.regions).set(target.regionId, {
      ...target, settlementCurrencyId: currency,
      seed: { ...target.seed, settlementCurrencyKey: shared.currencyKey },
    }),
    states: new Map([...base.states].map(([id, state]) => [
      id, id === alpha.stateId || id === beta.stateId ? {
        ...state, effectiveCurrencyId: currency, memberAuthorityId: issuer.authorityId,
        seed: { ...state.seed, effectiveCurrencyRegime: shared },
        treasury: id === beta.stateId ? wallet(state.treasury) : state.treasury,
      } : state,
    ] as const)),
    monetaryAuthorities: new Map([...base.monetaryAuthorities].map(([id, authority]): [MonetaryAuthorityId, MonetaryAuthorityState] => {
      if (id === issuer.authorityId) return [id, {
        ...authority, memberStateIds: [alpha.stateId, beta.stateId],
        seed: { ...authority.seed, memberStateKeys: [alpha.seed.key, beta.seed.key] },
      }];
      return [id, { ...authority,
        memberStateIds: authority.memberStateIds.filter(member => member !== beta.stateId),
        seed: { ...authority.seed,
          memberStateKeys: authority.seed.memberStateKeys.filter(key => key !== beta.seed.key) },
      }];
    })),
    productionUnits: new Map([...base.productionUnits].map(([id, unit]) => [
      id, unit.seed.regionKey === target.seed.key ? { ...unit, wallet: wallet(unit.wallet) } : unit,
    ] as const)),
    cohorts: new Map([...base.cohorts].map(([id, cohort]) => [
      id, cohort.seed.regionKey === target.seed.key ? { ...cohort, wallet: wallet(cohort.wallet) } : cohort,
    ] as const)),
  };
  return { opening, options, source, target, currency, link };
}

function add(map: Map<string, number>, key: string, amount: number) {
  expect(Number.isFinite(amount)).toBe(true);
  map.set(key, (map.get(key) ?? 0) + amount);
}

function cash(world: WorldState) {
  const result = new Map<string, number>();
  const record = (owner: string, stock: ReadonlyMap<CurrencyId, number>) => {
    for (const [currency, amount] of stock) {
      expect(amount).toBeGreaterThanOrEqual(0);
      add(result, JSON.stringify([owner, currency]), amount);
    }
  };
  for (const [id, unit] of world.productionUnits) record("PU:" + id, unit.wallet);
  for (const [id, cohort] of world.cohorts) record("COHORT:" + id, cohort.wallet);
  for (const [id, state] of world.states) record("STATE:" + id, state.treasury);
  for (const [id, clan] of world.clans) record("CLAN:" + id, clan.treasury);
  for (const [id, authority] of world.monetaryAuthorities) {
    for (const [pair, pool] of authority.fxPools) record("POOL:" + id + ":" + pair, pool.cash);
  }
  return result;
}

function goods(world: WorldState) {
  const result = new Map<string, number>();
  const record = (owner: ActorRef, bucket: string, stock: ReadonlyMap<GoodId, number>) => {
    for (const [good, amount] of stock) {
      expect(amount).toBeGreaterThanOrEqual(0);
      add(result, JSON.stringify([actorRefKey(owner), bucket, good]), amount);
    }
  };
  for (const [id, unit] of world.productionUnits) {
    const owner: ActorRef = { type: "PRODUCTION_UNIT", productionUnitId: id };
    record(owner, "INPUT", unit.inputInventory);
    record(owner, "OUTPUT", unit.outputInventory);
    record(owner, "INVESTMENT", unit.investmentInventory);
  }
  for (const [id, cohort] of world.cohorts) {
    record({ type: "COHORT", cohortId: id }, "GENERAL", cohort.householdInventory);
  }
  for (const [id, state] of world.states) {
    record({ type: "STATE", stateId: id }, "GENERAL", state.publicInventory);
  }
  return result;
}

function reconcile(expected: ReadonlyMap<string, number>, actual: ReadonlyMap<string, number>) {
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    expect(actual.get(key) ?? 0, key).toBeCloseTo(expected.get(key) ?? 0, 6);
  }
}

describe("M5 monetary-union acceptance", () => {
  it("pays across a State border without FX and delivers once", () => {
    const { opening, options, source, target, currency, link } = unionFixture();
    const run = (world: WorldState, tick: number, closed = false,
      observer?: PhaseWorldTransitionObserver) => executeM5AutonomousRegionalTradeTick(
      world, tick, phase1, (_phase, current) => current,
      closed ? { ...options, phase1TradeLawProvider: () => undefined } : options, observer,
    );
    let observed = false;
    const result = run(opening, M5_PREVIEW_TICK, false, (phase, before, after, context) => {
      if (phase !== 7) return;
      observed = true;
      const cargos = context.phase7DispatchedShipments!;
      expect(cargos.length).toBeGreaterThan(0);
      const journal = context.transactions.filter(tx => tx.phase === 7);
      expect(journal.some(tx => tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT")).toBe(false);
      expect(after.monetaryAuthorities).toEqual(before.monetaryAuthorities);
      const balances = cash(before);
      const physical = goods(before);
      let tariff = 0;
      let fees = 0;
      for (const cargo of cargos) {
        expect(cargo.originRegionId).toBe(source.regionId);
        expect(cargo.destinationRegionId).toBe(target.regionId);
        expect(cargo.invoiceCurrencyId).toBe(currency);
        expect(cargo.buyerPaymentCurrencyId).toBe(currency);
        expect(cargo.fxSettlementId).toBeUndefined();
        expect(cargo.beneficialOwner).toEqual(cargo.buyer);
        expect(after.shipments?.get(cargo.id)).toEqual(cargo);
        const bundle = journal.filter(tx => tx.bundleId === "tb:" + cargo.id.slice(3));
        const one = (kind: string) => {
          const matches = bundle.filter(tx => tx.type === kind);
          expect(matches).toHaveLength(1);
          return matches[0]!;
        };
        const sale = one("TRADE_GOODS_SALE");
        expect(sale.source).toEqual(cargo.buyer);
        expect(sale.destination).toEqual(cargo.seller);
        expect(sale.moneyAmount).toBeGreaterThan(0);
        expect(sale.moneyAmount).toBeCloseTo(cargo.buyerGoodsPaymentAmount, 8);
        expect(sale.moneyAmount).toBeCloseTo(cargo.sellerNetUnitPrice * sale.quantity!, 8);
        const dispatch = one("SHIPMENT_DISPATCH");
        expect(dispatch.quantity).toBe(cargo.quantity);
        expect(sale.quantity).toBeGreaterThan(0);
        const key = JSON.stringify([actorRefKey(cargo.seller), "INPUT", cargo.goodId]);
        expect(physical.get(key) ?? 0).toBeGreaterThanOrEqual(sale.quantity!);
        add(physical, key, -sale.quantity!);
        expect(cargo.quantity).toBeCloseTo(sale.quantity!, 8);
        for (const [kind, amount, recipient] of [
          ["TRADE_GOODS_SALE", cargo.buyerGoodsPaymentAmount, cargo.seller],
          ["IMPORT_TARIFF", cargo.tariffAmount,
            { type: "STATE", stateId: target.controllerStateId! } as ActorRef],
          ["TRANSPORT_FEE", cargo.transportFeeAmount, link.feeReceiver],
          ["CONSUMPTION_TAX", cargo.consumptionTaxAmount,
            { type: "STATE", stateId: target.controllerStateId! } as ActorRef],
        ] as const) {
          if (amount === 0) {
            expect(bundle.filter(tx => tx.type === kind)).toHaveLength(0);
            continue;
          }
          const receipt = one(kind);
          expect(recipient).toBeTruthy();
          expect(receipt.source).toEqual(cargo.buyer);
          expect(receipt.destination).toEqual(recipient);
          expect(receipt.currencyId).toBe(currency);
          expect(receipt.moneyAmount).toBeCloseTo(amount, 8);
          expect(receipt.fxSettlementId).toBeUndefined();
          add(balances, JSON.stringify([actorRefKey(cargo.buyer), currency]), -amount);
          add(balances, JSON.stringify([actorRefKey(recipient!), currency]), amount);
        }
        tariff += cargo.tariffAmount;
        fees += cargo.transportFeeAmount;
      }
      expect(tariff).toBeGreaterThan(0);
      expect(fees).toBeGreaterThan(0);
      reconcile(balances, cash(after));
      reconcile(physical, goods(after));
    });
    const verify = (value: typeof result) => {
      expect(value.phaseTrace).toEqual([...Array(16).keys()]);
      expect(value.phaseBoundaryError).toBeUndefined();
      expect(value.reconciliationErrors).toBeNull();
    };
    verify(result);
    expect(observed).toBe(true);
    const rev = <K, V>(map: ReadonlyMap<K, V>) => new Map([...map].reverse());
    const replay = run({ ...opening, regions: rev(opening.regions),
      states: rev(opening.states), currencies: rev(opening.currencies),
      monetaryAuthorities: rev(opening.monetaryAuthorities), cohorts: rev(opening.cohorts),
      productionUnits: rev(opening.productionUnits), markets: rev(opening.markets),
      clans: rev(opening.clans), transportLinks: rev(opening.transportLinks) }, M5_PREVIEW_TICK);
    verify(replay);
    expect(replay.context.transactions).toEqual(result.context.transactions);
    expect(replay.world).toEqual(result.world);
    const blocked = run(opening, M5_PREVIEW_TICK, true);
    verify(blocked);
    expect(blocked.context.phase7DispatchedShipments).toEqual([]);
    expect(blocked.context.transactions.filter(tx => tx.phase === 7)).toEqual([]);
    let delivered = 0;
    const arrival = run(result.world, M5_PREVIEW_TICK + 1, true, (phase, before, after, context) => {
      if (phase !== 1) return;
      const expected = goods(before);
      const due = [...(before.shipments?.values() ?? [])]
        .filter(cargo => cargo.arrivalTick === context.tick);
      const receipts = context.transactions.filter(tx => tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY");
      expect(receipts).toHaveLength(due.length);
      for (const cargo of due) {
        const match = receipts.filter(tx => tx.bundleId === "tb:delivery:" + cargo.id);
        expect(match).toHaveLength(1);
        expect(match[0]!.destination).toEqual(cargo.beneficialOwner);
        expect(match[0]!.quantity).toBe(cargo.quantity);
        expect(match[0]!.moneyAmount).toBeUndefined();
        expect(after.shipments?.has(cargo.id)).toBe(false);
        add(expected, JSON.stringify([actorRefKey(cargo.beneficialOwner),
          cargo.destinationInventoryBucket, cargo.goodId]), cargo.quantity);
        delivered++;
      }
      reconcile(expected, goods(after));
      reconcile(cash(before), cash(after));
    });
    verify(arrival);
    expect(delivered).toBeGreaterThan(0);
  }, 120_000);
});
