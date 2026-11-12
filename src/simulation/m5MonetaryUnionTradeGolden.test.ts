/**
 * M5/#676 acceptance: two different States sharing one settlement currency
 * must trade through real Phase-1/2/4/6/7 authorities without an FX pool.
 * The monetary union is a deliberate test fixture, not a monetary-policy rule.
 */
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId } from "../domain/id";
import type { PhaseHandler } from "./tickOrchestrator";
import {
  executeM5AutonomousRegionalTradeTick, type M5AutonomousRegionalTradeOptions,
} from "./m5AutonomousRegionalTradeTick";
import {
  buildInitialWorld, type WorldState, type ProductionUnitState, type RegionState,
} from "./worldState";

const IRON = "good:iron" as GoodId;
const households: PhaseHandler = (world, context) => {
  if (context.phase === 1) return {
    ...context,
    effectiveJurisdictionByRegion: new Map([...world.regions].map(
      ([id, region]) => [id, region.controllerStateId] as const,
    )),
  };
  return context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
};

function fixture() {
  const initial = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
  );
  const origin = [...initial.regions.values()].find(
    region => region.seed.key === "region:a4-border",
  )!;
  const foreign = [...initial.regions.values()].find(
    region => region.seed.key === "region:b4-chokepoint",
  )!;
  expect(origin.settlementCurrencyId).not.toBe(foreign.settlementCurrencyId);
  expect(origin.controllerStateId).not.toBeNull();
  expect(foreign.controllerStateId).not.toBeNull();
  expect(origin.controllerStateId).not.toBe(foreign.controllerStateId);
  // Two political jurisdictions, one actual settlement currency. No pretend
  // FX conversion, pegged rate or cross-currency payment is introduced.
  const destination: RegionState = {
    ...foreign, settlementCurrencyId: origin.settlementCurrencyId,
  };
  const link = [...initial.transportLinks.values()].find(
    item => item.fromRegionId === origin.regionId &&
      item.toRegionId === destination.regionId,
  )!;
  expect(link).toBeDefined();
  const templates = [...initial.productionUnits.values()].slice(0, 4);
  expect(templates).toHaveLength(4);
  const unit = (
    template: ProductionUnitState, region: RegionState,
    status: "ACTIVE" | "CLOSING", cash: number, iron: number,
  ): ProductionUnitState => ({
    ...template,
    seed: { ...template.seed, regionKey: region.seed.key, recipeId: "recipe:tools-craft" },
    status,
    installedCapital: status === "ACTIVE" ? 5 : 0,
    wallet: new Map([[region.settlementCurrencyId, cash]]),
    inputInventory: iron === 0 ? new Map() : new Map([[IRON, iron]]),
    outputInventory: new Map(),
    investmentInventory: new Map(),
  });
  const buyerOrigin = unit(templates[0]!, origin, "ACTIVE", 1_000_000, 0);
  const sellerOrigin = unit(templates[1]!, origin, "CLOSING", 5, 500);
  const buyerDestination = unit(templates[2]!, destination, "ACTIVE", 1_000_000, 0);
  const sellerDestination = unit(templates[3]!, destination, "CLOSING", 5, 2);
  const world: WorldState = {
    ...initial,
    regions: new Map([
      [origin.regionId, origin], [destination.regionId, destination],
    ]),
    markets: new Map([...initial.markets]
      .filter(([, market]) =>
        market.seed.regionKey === origin.seed.key ||
        market.seed.regionKey === destination.seed.key)
      .map(([id, market]) => [id, {
        ...market,
        priceByGood: new Map(market.priceByGood).set(
          IRON, market.seed.regionKey === origin.seed.key ? 1 : 100,
        ),
      }] as const)),
    productionUnits: new Map([
      [buyerOrigin.productionUnitId, buyerOrigin],
      [sellerOrigin.productionUnitId, sellerOrigin],
      [buyerDestination.productionUnitId, buyerDestination],
      [sellerDestination.productionUnitId, sellerDestination],
    ]),
    transportLinks: new Map([[link.linkId, { ...link, travelTicks: 2 }]]),
    // Strong negative control: no issuer pool exists to perform ANY FX.
    // Same-currency customs must still settle cross-border.
    monetaryAuthorities: new Map([...initial.monetaryAuthorities].map(
      ([id, authority]) => [id, { ...authority, fxPools: new Map() }] as const,
    )),
  };
  const market = world.simulationConfig.markets;
  const options: M5AutonomousRegionalTradeOptions = {
    procurement: {
      taxPolicy: {
        getConsumptionTaxRate: () => 0.05,
        getCollectionEfficiency: () => 1,
      },
      wageTaxPolicy: {
        assessWageIncomeTax: () => 0,
        getCollectionEfficiency: () => 1,
      },
      priceConfig: {
        shortageSignalWeight: market.shortageSignalWeight!,
        inventorySignalWeight: market.inventorySignalWeight!,
        basePriceAdjustmentSpeed: market.basePriceAdjustmentSpeed!,
        maxAbsoluteLogPriceMovePerTick: market.maxAbsoluteLogPriceMovePerTick!,
        targetInventoryCoverageTicks: market.targetInventoryCoverageTicks!,
        minimumPrice: 0.001,
        maximumPrice: 1_000_000,
      },
    },
    scorePolicy: {
      tradeProfitWeight: 1, shortageWeight: 1,
      minimumTradeScore: -100, maximumShortagePremiumShare: 1,
    },
    transportFeeCostPolicy: {
      minimumConditionForCost: 0.01, maximumConditionCostMultiplier: 10,
    },
    infrastructureFactors: new Map([[link.linkId, 1]]),
    phase1TradeLawProvider: query =>
      query.linkId === link.linkId && query.goodId === IRON ? null : undefined,
    phase1TariffLawProvider: query => query.goodId === IRON ? 0.1 : 0,
  };
  return {
    world, options, origin, destination, link,
    sellerOrigin, buyerDestination,
  };
}

function run(
  f: ReturnType<typeof fixture>, world = f.world,
  allowed = true, tick = 7,
) {
  return executeM5AutonomousRegionalTradeTick(
    world, tick, households, (_phase, current) => current,
    allowed ? f.options : {
      ...f.options, phase1TradeLawProvider: () => undefined,
    },
  );
}

function totalCash(world: WorldState, currency: string) {
  const wallets = [
    ...[...world.states.values()].map(state => state.treasury),
    ...[...world.clans.values()].map(clan => clan.treasury),
    ...[...world.cohorts.values()].map(cohort => cohort.wallet),
    ...[...world.productionUnits.values()].map(unit => unit.wallet),
    ...[...world.monetaryAuthorities.values()].flatMap(authority =>
      [...authority.fxPools.values()].map(pool => pool.cash)),
  ];
  return wallets.reduce((sum, wallet) =>
    sum + [...wallet].reduce((cash, [id, value]) =>
      cash + (id === currency ? value : 0), 0), 0);
}
function totalIron(world: WorldState) {
  return [...world.productionUnits.values()].reduce((sum, unit) =>
    sum + (unit.inputInventory.get(IRON) ?? 0) +
      (unit.outputInventory.get(IRON) ?? 0) +
      (unit.investmentInventory.get(IRON) ?? 0), 0) +
    [...(world.shipments?.values() ?? [])].reduce((sum, cargo) =>
      sum + (cargo.goodId === IRON ? cargo.quantity : 0), 0);
}

describe("M5/#676 monetary-union cross-State golden", () => {
  it("pays one real cross-border shipment and destination tariff with no FX authority", () => {
    const f = fixture();
    const currency = f.origin.settlementCurrencyId;
    expect(f.destination.settlementCurrencyId).toBe(currency);
    const openingCash = totalCash(f.world, currency);
    const openingIron = totalIron(f.world);
    const open = run(f);
    const closed = run(f, f.world, false);
    for (const result of [open, closed]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(totalCash(result.world, currency)).toBeCloseTo(openingCash, 6);
      expect(totalIron(result.world)).toBeCloseTo(openingIron, 7);
      expect(result.context.transactions.filter(tx =>
        tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT")).toHaveLength(0);
      expect(result.world.monetaryAuthorities).toEqual(f.world.monetaryAuthorities);
    }
    const phase7 = open.context.transactions.filter(tx => tx.phase === 7);
    const shipments = [...(open.world.shipments?.values() ?? [])];
    expect(shipments).toHaveLength(1); // Non-vacuity: actual paid foreign cargo.
    const cargo = shipments[0]!;
    expect(cargo.transportLinkId).toBe(f.link.linkId);
    expect(cargo.quantity).toBeGreaterThan(0);
    expect(cargo.invoiceCurrencyId).toBe(currency);
    expect(cargo.buyerPaymentCurrencyId).toBe(currency);
    expect(cargo.fxSettlementId).toBeUndefined();
    expect(cargo.arrivalTick).toBe(9);
    expect(cargo.beneficialOwner).toEqual({
      type: "PRODUCTION_UNIT", productionUnitId: f.buyerDestination.productionUnitId,
    });
    const goodsSale = phase7.filter(tx => tx.type === "TRADE_GOODS_SALE");
    const dispatch = phase7.filter(tx => tx.type === "SHIPMENT_DISPATCH");
    const tariff = phase7.filter(tx => tx.type === "IMPORT_TARIFF");
    expect(goodsSale).toHaveLength(1);
    expect(dispatch).toHaveLength(1);
    expect(tariff).toHaveLength(1);
    expect(goodsSale[0]!.moneyAmount).toBeGreaterThan(0);
    expect(tariff[0]!.moneyAmount).toBeGreaterThan(0);
    expect(tariff[0]!.currencyId).toBe(currency);
    expect(tariff[0]!.destination).toEqual({
      type: "STATE", stateId: f.destination.controllerStateId,
    });
    expect(dispatch[0]!.quantity).toBeCloseTo(cargo.quantity, 8);
    expect(goodsSale[0]!.bundleId).toBe(dispatch[0]!.bundleId);
    expect(tariff[0]!.bundleId).toBe(dispatch[0]!.bundleId);

    // Closing only this cross-State permission cannot erase local procurement.
    expect(closed.world.shipments?.size ?? 0).toBe(0);
    expect(closed.context.transactions.filter(tx => tx.phase === 7 &&
      ["TRADE_GOODS_SALE", "SHIPMENT_DISPATCH", "IMPORT_TARIFF"].includes(tx.type)))
      .toHaveLength(0);
    const locals = (result: typeof open) => result.context.transactions.filter(tx =>
      tx.phase === 4 && tx.type === "MARKET_SALE");
    expect(locals(open)).toEqual(locals(closed));
    expect(locals(open).length).toBeGreaterThan(0);

    // Compare the same post-local-sale cash, so the international transaction
    // is the only additional payment under examination.
    const seller = f.sellerOrigin.productionUnitId;
    const buyer = f.buyerDestination.productionUnitId;
    const sellerDelta =
      (open.world.productionUnits.get(seller)!.wallet.get(currency) ?? 0) -
      (closed.world.productionUnits.get(seller)!.wallet.get(currency) ?? 0);
    expect(sellerDelta).toBeCloseTo(goodsSale[0]!.moneyAmount!, 7);
    const buyerDebit = phase7.filter(tx =>
      tx.source?.type === "PRODUCTION_UNIT" &&
      tx.source.productionUnitId === buyer &&
      tx.moneyAmount !== undefined)
      .reduce((sum, tx) => sum + tx.moneyAmount!, 0);
    expect(buyerDebit).toBeGreaterThan(goodsSale[0]!.moneyAmount!);
    expect(
      (closed.world.productionUnits.get(buyer)!.wallet.get(currency) ?? 0) -
      (open.world.productionUnits.get(buyer)!.wallet.get(currency) ?? 0),
    ).toBeCloseTo(buyerDebit, 7);

    const destinationState = f.destination.controllerStateId!;
    const stateCredit = phase7.filter(tx =>
      tx.destination?.type === "STATE" &&
      tx.destination.stateId === destinationState &&
      tx.moneyAmount !== undefined)
      .reduce((sum, tx) => sum + tx.moneyAmount!, 0);
    expect(stateCredit).toBeGreaterThanOrEqual(tariff[0]!.moneyAmount!);
    expect(
      (open.world.states.get(destinationState)!.treasury.get(currency) ?? 0) -
      (closed.world.states.get(destinationState)!.treasury.get(currency) ?? 0),
    ).toBeCloseTo(stateCredit, 7);

    const waiting = run(f, open.world, false, 8);
    expect(waiting.phaseBoundaryError).toBeUndefined();
    expect(waiting.reconciliationErrors).toBeNull();
    expect(waiting.world.shipments).toEqual(open.world.shipments);
    expect(waiting.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY" || tx.type === "FX_INPUT" ||
      tx.type === "FX_OUTPUT")).toHaveLength(0);
    const arrived = run(f, waiting.world, false, 9);
    expect(arrived.phaseBoundaryError).toBeUndefined();
    expect(arrived.reconciliationErrors).toBeNull();
    expect(arrived.world.shipments?.size ?? 0).toBe(0);
    expect(arrived.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY")).toHaveLength(1);
    expect(arrived.context.transactions.filter(tx =>
      tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT" ||
      tx.type === "IMPORT_TARIFF")).toHaveLength(0);
    expect(totalIron(arrived.world)).toBeCloseTo(openingIron, 7);
    expect(totalCash(arrived.world, currency)).toBeCloseTo(openingCash, 6);
    expect(run(f, f.world).context.transactions).toEqual(open.context.transactions);
    expect(run(f, waiting.world, false, 9).context.transactions)
      .toEqual(arrived.context.transactions);
  });

  it("retains exactly one paid shared-currency cargo over 12 blocked ticks and shuffled registries", () => {
    const f = fixture();
    const currency = f.origin.settlementCurrencyId;
    const openingCash = totalCash(f.world, currency);
    const openingIron = totalIron(f.world);
    const reorder = (world: WorldState): WorldState => ({
      ...world,
      states: new Map([...world.states].reverse()),
      regions: new Map([...world.regions].reverse()),
      markets: new Map([...world.markets].reverse()),
      cohorts: new Map([...world.cohorts].reverse()),
      clans: new Map([...world.clans].reverse()),
      productionUnits: new Map([...world.productionUnits].reverse()),
      transportLinks: new Map([...world.transportLinks].reverse()),
      monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse()),
    });
    let regular = f.world;
    let shuffled = reorder(f.world);
    let dispatchedCargoId: string | undefined;
    let actualDeliveries = 0;
    for (let tick = 7; tick < 19; tick++) {
      const permitted = tick === 7;
      const normal = run(f, regular, permitted, tick);
      const reversed = run(f, shuffled, permitted, tick);
      for (const result of [normal, reversed]) {
        expect(result.phaseTrace).toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
        expect(totalCash(result.world, currency)).toBeCloseTo(openingCash, 6);
        expect(totalIron(result.world)).toBeCloseTo(openingIron, 7);
        expect(result.world.monetaryAuthorities).toEqual(f.world.monetaryAuthorities);
        const transactions = result.context.transactions;
        expect(transactions.filter(tx =>
          tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT")).toHaveLength(0);
        const paid = transactions.filter(tx => tx.phase === 7 &&
          ["TRADE_GOODS_SALE", "SHIPMENT_DISPATCH", "IMPORT_TARIFF",
            "TRANSPORT_FEE", "CONSUMPTION_TAX"].includes(tx.type));
        const deliveries = transactions.filter(tx => tx.type === "SHIPMENT_DELIVERY");
        expect(deliveries).toHaveLength(tick === 9 ? 1 : 0);
        if (tick === 7) {
          const cargos = [...(result.world.shipments?.values() ?? [])];
          expect(cargos).toHaveLength(1);
          expect(paid.some(tx => tx.type === "TRADE_GOODS_SALE")).toBe(true);
          expect(paid.some(tx => tx.type === "IMPORT_TARIFF")).toBe(true);
          expect(cargos[0]!.fxSettlementId).toBeUndefined();
          expect(cargos[0]!.buyerPaymentCurrencyId).toBe(currency);
          expect(cargos[0]!.invoiceCurrencyId).toBe(currency);
          expect(cargos[0]!.arrivalTick).toBe(9);
        } else {
          expect(paid).toHaveLength(0);
          expect(result.world.shipments?.size ?? 0).toBe(tick < 9 ? 1 : 0);
        }
        if (tick === 9) {
          expect(deliveries[0]!.reason).toBe(
            "IN_TRANSIT_TO_INPUT_STOCK:" + dispatchedCargoId,
          );
          expect(deliveries[0]!.moneyAmount).toBeUndefined();
        }
      }
      if (tick === 7) {
        dispatchedCargoId = [...(normal.world.shipments?.values() ?? [])][0]?.id;
        expect(dispatchedCargoId).toBeDefined();
      }
      if (tick === 9) actualDeliveries++;
      expect(reversed.context.transactions).toEqual(normal.context.transactions);
      expect(reversed.world.productionUnits).toEqual(normal.world.productionUnits);
      expect(reversed.world.states).toEqual(normal.world.states);
      expect(reversed.world.shipments).toEqual(normal.world.shipments);
      expect(reversed.world.markets).toEqual(normal.world.markets);
      regular = normal.world;
      shuffled = reversed.world;
    }
    expect(actualDeliveries).toBe(1);
    expect(regular.shipments?.size ?? 0).toBe(0);
  });


  it("credits a private Clan corridor owner without leaking union-currency fees into State taxes or FX", () => {
    const f = fixture();
    const currency = f.origin.settlementCurrencyId;
    const clan = [...f.world.clans.values()].find(
      candidate => (candidate.treasury.get(currency) ?? 0) > 0,
    )!;
    expect(clan).toBeDefined();
    const destinationStateId = f.destination.controllerStateId!;
    const privateLink = {
      ...f.world.transportLinks.get(f.link.linkId)!,
      feeReceiver: { type: "CLAN" as const, clanId: clan.clanId },
    };
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([[f.link.linkId, privateLink]]),
    };
    const beforeCash = totalCash(opening, currency);
    const beforeIron = totalIron(opening);
    // Closed-border control includes all earlier local Phase-4 cash/tax flows.
    const closed = run(f, opening, false, 7);
    const paid = run(f, opening, true, 7);
    for (const result of [paid, closed]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(totalCash(result.world, currency)).toBeCloseTo(beforeCash, 6);
      expect(totalIron(result.world)).toBeCloseTo(beforeIron, 7);
      expect(result.world.monetaryAuthorities).toEqual(opening.monetaryAuthorities);
      expect(result.context.transactions.filter(tx =>
        tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT")).toHaveLength(0);
    }
    const cargo = [...(paid.world.shipments?.values() ?? [])];
    expect(cargo).toHaveLength(1);
    expect(cargo[0]!.buyerPaymentCurrencyId).toBe(currency);
    expect(cargo[0]!.invoiceCurrencyId).toBe(currency);
    expect(cargo[0]!.fxSettlementId).toBeUndefined();
    expect(cargo[0]!.transportFeeAmount).toBeGreaterThan(0);
    expect(cargo[0]!.tariffAmount).toBeGreaterThan(0);
    expect(closed.world.shipments?.size ?? 0).toBe(0);
    const journal = paid.context.transactions.filter(tx => tx.phase === 7);
    const actualClan = paid.world.clans.get(clan.clanId)!;
    const actualState = paid.world.states.get(destinationStateId)!;

    // Oracle uses the configured opening route fee owner, NOT a journal payee
    // or aggregate money conservation to decide who is entitled to the fee.
    const assertOwnerPayments = (
      settled: WorldState, receipts: typeof journal,
    ): void => {
      const fees = receipts.filter(tx => tx.type === "TRANSPORT_FEE");
      const tariffs = receipts.filter(tx => tx.type === "IMPORT_TARIFF");
      const taxes = receipts.filter(tx => tx.type === "CONSUMPTION_TAX");
      expect(fees).toHaveLength(1);
      expect(tariffs).toHaveLength(1);
      expect(taxes).toHaveLength(1);
      expect(fees[0]).toMatchObject({
        currencyId: currency, destination: privateLink.feeReceiver,
        moneyAmount: cargo[0]!.transportFeeAmount,
      });
      expect(tariffs[0]).toMatchObject({
        currencyId: currency,
        destination: { type: "STATE", stateId: destinationStateId },
        moneyAmount: cargo[0]!.tariffAmount,
      });
      expect(taxes[0]).toMatchObject({
        currencyId: currency,
        destination: { type: "STATE", stateId: destinationStateId },
        moneyAmount: cargo[0]!.consumptionTaxAmount,
      });
      const clanPaid = (settled.clans.get(clan.clanId)!.treasury.get(currency) ?? 0) -
        (closed.world.clans.get(clan.clanId)!.treasury.get(currency) ?? 0);
      expect(clanPaid).toBeCloseTo(cargo[0]!.transportFeeAmount, 6);
      const statePaid = (settled.states.get(destinationStateId)!.treasury.get(currency) ?? 0) -
        (closed.world.states.get(destinationStateId)!.treasury.get(currency) ?? 0);
      expect(statePaid).toBeCloseTo(
        cargo[0]!.tariffAmount + cargo[0]!.consumptionTaxAmount, 6,
      );
    };
    assertOwnerPayments(paid.world, journal);
    expect((actualClan.treasury.get(currency) ?? 0) -
      (clan.treasury.get(currency) ?? 0)).toBeCloseTo(cargo[0]!.transportFeeAmount, 6);

    // Two conserved-money falsifications that must not pass an owner-level audit.
    const divertedReceipt = journal.map(tx => tx.type === "TRANSPORT_FEE"
      ? { ...tx, destination: { type: "STATE" as const, stateId: destinationStateId } }
      : tx);
    expect(() => assertOwnerPayments(paid.world, divertedReceipt)).toThrow();
    const divertedWorld: WorldState = {
      ...paid.world,
      clans: new Map(paid.world.clans).set(clan.clanId, {
        ...actualClan,
        treasury: new Map(actualClan.treasury).set(
          currency, (actualClan.treasury.get(currency) ?? 0) - 1,
        ),
      }),
      states: new Map(paid.world.states).set(destinationStateId, {
        ...actualState,
        treasury: new Map(actualState.treasury).set(
          currency, (actualState.treasury.get(currency) ?? 0) + 1,
        ),
      }),
    };
    expect(totalCash(divertedWorld, currency))
      .toBeCloseTo(totalCash(paid.world, currency), 6);
    expect(() => assertOwnerPayments(divertedWorld, journal)).toThrow();

    // Border closure after payment cannot cancel or re-charge in-transit stock.
    const waiting = run(f, paid.world, false, 8);
    const delivered = run(f, waiting.world, false, 9);
    for (const result of [waiting, delivered]) {
      expect(result.reconciliationErrors).toBeNull();
      expect(result.context.transactions.filter(tx =>
        tx.type === "TRANSPORT_FEE" || tx.type === "IMPORT_TARIFF" ||
        tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT")).toHaveLength(0);
      expect(result.world.clans.get(clan.clanId)!.treasury).toEqual(actualClan.treasury);
      expect(totalCash(result.world, currency)).toBeCloseTo(beforeCash, 6);
      expect(totalIron(result.world)).toBeCloseTo(beforeIron, 7);
    }
    expect(waiting.world.shipments?.size).toBe(1);
    expect(delivered.world.shipments?.size).toBe(0);
    expect(delivered.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY")).toHaveLength(1);
  });


});
