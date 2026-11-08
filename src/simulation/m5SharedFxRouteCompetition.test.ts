/**
 * Issue #676 / M5 golden slice: two independently affordable cross-border
 * routes must compete for ONE finite, issuer-owned FX output stock.
 *
 * The routes and actors are seeded as a deliberately small hypothetical border
 * topology; planning, prices, FX quotes, actual settlement and cargo dispatch
 * are all performed by the real stateful tick orchestration.
 */
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import type { PhaseHandler } from "./tickOrchestrator";
import { executeM5AutonomousRegionalTradeTick, type M5AutonomousRegionalTradeOptions } from "./m5AutonomousRegionalTradeTick";
import { buildInitialWorld, type WorldState, type ProductionUnitState, type RegionState } from "./worldState";

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
  const source = [...initial.regions.values()].find(r => r.seed.key === "region:a4-border")!;
  const betaOne = [...initial.regions.values()].find(r => r.seed.key === "region:b4-chokepoint")!;
  const betaTwo = [...initial.regions.values()].find(r => r.seed.key === "region:b5-pastoral")!;
  const originalLink = [...initial.transportLinks.values()].find(
    link => link.fromRegionId === source.regionId && link.toRegionId === betaOne.regionId,
  )!;
  expect(originalLink).toBeDefined();
  expect(source.settlementCurrencyId).not.toBe(betaOne.settlementCurrencyId);
  expect(betaOne.settlementCurrencyId).toBe(betaTwo.settlementCurrencyId);

  // One additional *distinct* hypothetical border corridor (not a second FX
  // pool). Both routes enter Beta and pay sellers in the same Alpha currency.
  const secondLinkId = "tl:999999" as TransportLinkId;
  const otherLink = {
    ...originalLink,
    linkId: secondLinkId,
    toRegionId: betaTwo.regionId,
    seed: { ...originalLink.seed, key: "link:test-a4-b5", toRegionKey: betaTwo.seed.key },
  };
  const templates = [...initial.productionUnits.values()].slice(0, 6);
  expect(templates).toHaveLength(6);
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
  const actors = [
    unit(templates[0]!, source, "ACTIVE", 1_000_000, 0),
    unit(templates[1]!, source, "CLOSING", 5, 1_000),
    unit(templates[2]!, betaOne, "ACTIVE", 1_000_000, 0),
    unit(templates[3]!, betaOne, "CLOSING", 5, 2),
    unit(templates[4]!, betaTwo, "ACTIVE", 1_000_000, 0),
    unit(templates[5]!, betaTwo, "CLOSING", 5, 2),
  ];
  const currencies = [source.settlementCurrencyId, betaOne.settlementCurrencyId];
  const matches = (base: string, quote: string) =>
    (base === currencies[0] && quote === currencies[1]) ||
    (base === currencies[1] && quote === currencies[0]);
  const possible = [...initial.monetaryAuthorities].flatMap(([authorityId, authority]) =>
    [...authority.fxPools].filter(([, pool]) =>
      matches(pool.baseCurrencyId, pool.quoteCurrencyId),
    ).map(([poolId, pool]) => ({ authorityId, poolId, pool })),
  );
  expect(possible.length).toBeGreaterThan(1);
  const chosen = possible[0]!;
  const reserveFloor = chosen.pool.baseCurrencyId === currencies[0]
    ? chosen.pool.minOperationalReserveBase : chosen.pool.minOperationalReserveQuote;
  const monetaryAuthorities = new Map([...initial.monetaryAuthorities].map(([id, authority]) => [
    id,
    { ...authority, fxPools: new Map([...authority.fxPools]
      .filter(([poolId, pool]) =>
        !matches(pool.baseCurrencyId, pool.quoteCurrencyId) || poolId === chosen.poolId)
      .map(([poolId, pool]) => [
        poolId, poolId === chosen.poolId ? {
          ...pool,
          cash: new Map(pool.cash)
            .set(currencies[0]!, reserveFloor + 100_000)
            .set(currencies[1]!, 100_000),
        } : pool,
      ] as const)) },
  ] as const));
  const regions = [source, betaOne, betaTwo];
  const world: WorldState = {
    ...initial,
    regions: new Map(regions.map(region => [region.regionId, region] as const)),
    markets: new Map([...initial.markets].filter(([, market]) =>
      regions.some(region => region.seed.key === market.seed.regionKey),
    ).map(([id, market]) => [id, {
      ...market,
      priceByGood: new Map(market.priceByGood).set(
        IRON, market.seed.regionKey === source.seed.key ? 1 : 100,
      ),
    }] as const)),
    productionUnits: new Map(actors.map(actor => [actor.productionUnitId, actor] as const)),
    transportLinks: new Map([
      [originalLink.linkId, originalLink],
      [otherLink.linkId, otherLink],
    ]),
    outgoingTransportLinkIdsByRegion: new Map([
      [source.regionId, [originalLink.linkId, otherLink.linkId]],
    ]),
    monetaryAuthorities,
  };
  const marketConfig = world.simulationConfig.markets;
  const links = [originalLink.linkId, otherLink.linkId];
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
        shortageSignalWeight: marketConfig.shortageSignalWeight!,
        inventorySignalWeight: marketConfig.inventorySignalWeight!,
        basePriceAdjustmentSpeed: marketConfig.basePriceAdjustmentSpeed!,
        maxAbsoluteLogPriceMovePerTick: marketConfig.maxAbsoluteLogPriceMovePerTick!,
        targetInventoryCoverageTicks: marketConfig.targetInventoryCoverageTicks!,
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
    infrastructureFactors: new Map(links.map(id => [id, 1] as const)),
    phase1TradeLawProvider: query =>
      query.goodId === IRON && links.includes(query.linkId) ? null : undefined,
    phase1TariffLawProvider: query => query.goodId === IRON ? 0.1 : 0,
  };
  return { world, options, chosen, reserveFloor, currencies, links };
}

function run(f: ReturnType<typeof fixture>, world: WorldState, allowed = true) {
  return executeM5AutonomousRegionalTradeTick(
    world, 7, households, (_phase, current) => current,
    allowed ? f.options : { ...f.options, phase1TradeLawProvider: () => undefined },
  );
}

function withOutputStock(f: ReturnType<typeof fixture>, budget: number): WorldState {
  const { authorityId, poolId } = f.chosen;
  return {
    ...f.world,
    monetaryAuthorities: new Map([...f.world.monetaryAuthorities].map(([id, authority]) => [
      id, id === authorityId
        ? { ...authority, fxPools: new Map(authority.fxPools).set(poolId, {
          ...authority.fxPools.get(poolId)!,
          cash: new Map(authority.fxPools.get(poolId)!.cash)
            .set(f.currencies[0]!, f.reserveFloor + budget),
        }) }
        : authority,
    ] as const)),
  };
}

function totalCash(world: WorldState, currency: string): number {
  const wallets = [
    ...[...world.states.values()].map(state => state.treasury),
    ...[...world.clans.values()].map(clan => clan.treasury),
    ...[...world.cohorts.values()].map(cohort => cohort.wallet),
    ...[...world.productionUnits.values()].map(unit => unit.wallet),
    ...[...world.monetaryAuthorities.values()].flatMap(authority =>
      [...authority.fxPools.values()].map(pool => pool.cash)),
  ];
  return wallets.reduce((sum, wallet) =>
    sum + ([...wallet].find(([id]) => id === currency)?.[1] ?? 0), 0);
}

function totalIron(world: WorldState): number {
  return [...world.productionUnits.values()].reduce((sum, unit) =>
    sum + (unit.inputInventory.get(IRON) ?? 0) +
      (unit.outputInventory.get(IRON) ?? 0) +
      (unit.investmentInventory.get(IRON) ?? 0), 0,
  ) + [...(world.shipments?.values() ?? [])].reduce((sum, shipment) =>
    sum + (shipment.goodId === IRON ? shipment.quantity : 0), 0);
}


/** Require one unique, positive FX input/output pair for each physical dispatch. */
function assertPaidCargoReceipts(
  result: ReturnType<typeof run>,
  expectedLinks?: readonly TransportLinkId[],
) {
  const cargos = [...(result.world.shipments?.values() ?? [])];
  const phase7 = result.context.transactions.filter(tx => tx.phase === 7);
  const outputs = phase7.filter(tx => tx.type === "FX_OUTPUT");
  const inputs = phase7.filter(tx => tx.type === "FX_INPUT");
  const dispatches = phase7.filter(tx => tx.type === "SHIPMENT_DISPATCH");
  expect(outputs).toHaveLength(cargos.length);
  expect(inputs).toHaveLength(cargos.length);
  expect(dispatches).toHaveLength(cargos.length);
  if (expectedLinks !== undefined) {
    expect(new Set(cargos.map(cargo => cargo.transportLinkId)))
      .toEqual(new Set(expectedLinks));
  }
  const bundles = new Set<string>();
  const settlementIds = new Set<string>();
  const paidByLink = new Map<TransportLinkId, number>();
  for (const cargo of cargos) {
    expect(cargo.quantity).toBeGreaterThan(0);
    expect(cargo.fxSettlementId).toMatch(/^fxs:/);
    const matchingDispatch = dispatches.filter(tx =>
      tx.goodId === cargo.goodId &&
      tx.sourceRegionId === cargo.originRegionId &&
      tx.destinationRegionId === cargo.destinationRegionId &&
      tx.quantity === cargo.quantity &&
      tx.source?.type === "PRODUCTION_UNIT" &&
      cargo.seller.type === "PRODUCTION_UNIT" &&
      tx.source.productionUnitId === cargo.seller.productionUnitId &&
      tx.destination?.type === "PRODUCTION_UNIT" &&
      cargo.beneficialOwner.type === "PRODUCTION_UNIT" &&
      tx.destination.productionUnitId === cargo.beneficialOwner.productionUnitId);
    expect(matchingDispatch).toHaveLength(1);
    const bundleId = matchingDispatch[0]!.bundleId;
    expect(bundleId).toBeDefined();
    bundles.add(bundleId!);
    settlementIds.add(cargo.fxSettlementId!);
    const matchingInputs = inputs.filter(tx =>
      tx.fxSettlementId === cargo.fxSettlementId && tx.bundleId === bundleId);
    const matchingOutputs = outputs.filter(tx =>
      tx.fxSettlementId === cargo.fxSettlementId && tx.bundleId === bundleId);
    expect(matchingInputs).toHaveLength(1);
    expect(matchingOutputs).toHaveLength(1);
    const input = matchingInputs[0]!;
    const output = matchingOutputs[0]!;
    expect(input.currencyId).toBe(cargo.buyerPaymentCurrencyId);
    expect(output.currencyId).toBe(cargo.invoiceCurrencyId);
    expect(input.source).toEqual(cargo.beneficialOwner);
    expect(output.destination).toEqual(cargo.seller);
    for (const leg of [input, output]) {
      expect(Number.isFinite(leg.moneyAmount)).toBe(true);
      expect(leg.moneyAmount).toBeGreaterThan(0);
    }
    paidByLink.set(cargo.transportLinkId, output.moneyAmount!);
  }
  expect(bundles.size).toBe(cargos.length);
  expect(settlementIds.size).toBe(cargos.length);
  return {
    cargos, outputs, inputs, dispatches, paidByLink,
    paid: outputs.reduce((sum, tx) => sum + tx.moneyAmount!, 0),
  };
}

function runOnlyLink(
  f: ReturnType<typeof fixture>, opening: WorldState, linkId: TransportLinkId,
) {
  return executeM5AutonomousRegionalTradeTick(
    opening, 7, households, (_phase, current) => current, {
      ...f.options,
      phase1TradeLawProvider: query =>
        query.goodId === IRON && query.linkId === linkId ? null : undefined,
    },
  );
}

describe("M5 #676: competing autonomous routes share ONE finite FX reserve", () => {
  it("caps aggregate paid dispatch at the common pool floor, not per-route stale quotes", () => {
    const f = fixture();
    const full = run(f, f.world);
    expect(full.phaseBoundaryError).toBeUndefined();
    expect(full.reconciliationErrors).toBeNull();
    const fullReceipts = assertPaidCargoReceipts(full, f.links);
    expect(fullReceipts.cargos).toHaveLength(2);
    const normalTotal = fullReceipts.paid;
    expect(normalTotal).toBeGreaterThan(0);

    // Each route could be settled with full output stock, but together they
    // must share a much smaller finite stock when both are proposed at once.
    const cap = normalTotal * 0.60;
    const opening = withOutputStock(f, cap);
    const startingPool = opening.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;

    // Phase-1 legally permits exactly one link in each counterfactual.
    // Each route must move a paid cargo on its own against this SAME pool and
    // opening stock; summed standalone demand must exceed that common budget.
    const standalonePaid = f.links.map(linkId => {
      const alone = runOnlyLink(f, opening, linkId);
      expect(alone.phaseBoundaryError).toBeUndefined();
      expect(alone.reconciliationErrors).toBeNull();
      const receipts = assertPaidCargoReceipts(alone, [linkId]);
      expect(receipts.cargos).toHaveLength(1);
      expect(receipts.paid).toBeGreaterThan(0);
      const soloPool = alone.world.monetaryAuthorities.get(f.chosen.authorityId)!
        .fxPools.get(f.chosen.poolId)!;
      expect(soloPool.cash.get(f.currencies[0]!)! - startingPool.cash.get(f.currencies[0]!)!)
        .toBeCloseTo(-receipts.paid, 7);
      expect(soloPool.cash.get(f.currencies[1]!)! - startingPool.cash.get(f.currencies[1]!)!)
        .toBeCloseTo(receipts.inputs[0]!.moneyAmount!, 7);
      return receipts.paid;
    });
    const standaloneTotal = standalonePaid.reduce((sum, value) => sum + value, 0);
    expect(standaloneTotal).toBeGreaterThan(cap + 1e-8);

    const constrained = run(f, opening);
    expect(constrained.phaseBoundaryError).toBeUndefined();
    expect(constrained.reconciliationErrors).toBeNull();
    const { cargos, outputs, inputs, dispatches, paidByLink, paid } =
      assertPaidCargoReceipts(constrained);
    expect(cargos.length).toBeGreaterThan(0);
    expect(paid).toBeGreaterThan(0);
    expect(paid).toBeLessThanOrEqual(cap + 1e-8);
    expect(paid).toBeLessThan(normalTotal);
    expect(paid).toBeLessThan(standaloneTotal);
    expect(f.links.some((linkId, index) =>
      (paidByLink.get(linkId) ?? 0) < standalonePaid[index]! - 1e-8,
    )).toBe(true);
    for (const cargo of cargos) {
      expect(f.links).toContain(cargo.transportLinkId);
      expect(cargo.invoiceCurrencyId).toBe(f.currencies[0]);
      expect(cargo.buyerPaymentCurrencyId).toBe(f.currencies[1]);
    }
    expect(dispatches).toHaveLength(cargos.length);
    expect(outputs).toHaveLength(cargos.length);
    const finalPool = constrained.world.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;
    expect(finalPool.cash.get(f.currencies[0]!)! - startingPool.cash.get(f.currencies[0]!)!)
      .toBeCloseTo(-paid, 7);
    expect(finalPool.cash.get(f.currencies[0]!)!).toBeGreaterThanOrEqual(f.reserveFloor);
    expect(finalPool.cash.get(f.currencies[1]!)! - startingPool.cash.get(f.currencies[1]!)!)
      .toBeCloseTo(inputs.reduce((sum, tx) => sum + tx.moneyAmount!, 0), 7);
    for (const currency of f.currencies) {
      expect(totalCash(constrained.world, currency)).toBeCloseTo(totalCash(opening, currency), 6);
    }
    expect(totalIron(constrained.world)).toBeCloseTo(totalIron(opening), 7);
    expect(run(f, opening).context.transactions).toEqual(constrained.context.transactions);

    const exhaustedOpening = withOutputStock(f, 0);
    const exhausted = run(f, exhaustedOpening);
    const closed = run(f, exhaustedOpening, false);
    expect(exhausted.phaseBoundaryError).toBeUndefined();
    expect(exhausted.reconciliationErrors).toBeNull();
    expect(exhausted.world.shipments?.size ?? 0).toBe(0);
    expect(exhausted.context.transactions.filter(tx => tx.phase === 7 && [
      "FX_INPUT", "FX_OUTPUT", "SHIPMENT_DISPATCH", "IMPORT_TARIFF",
      "TRADE_GOODS_SALE", "TRANSPORT_FEE", "CONSUMPTION_TAX",
    ].includes(tx.type))).toHaveLength(0);
    // This must not pass when both local-sale arrays are empty.
    const paidLocalSales = exhausted.context.transactions.filter(tx =>
      tx.phase === 4 && tx.type === "MARKET_SALE");
    expect(paidLocalSales).toHaveLength(3);
    for (const sale of paidLocalSales) {
      expect(Number.isFinite(sale.moneyAmount)).toBe(true);
      expect(sale.moneyAmount).toBeGreaterThan(0);
      expect(sale.quantity).toBeGreaterThan(0);
    }
    expect(paidLocalSales).toEqual(
      closed.context.transactions.filter(tx => tx.phase === 4 && tx.type === "MARKET_SALE"),
    );
    expect(exhausted.world.productionUnits).toEqual(closed.world.productionUnits);
    expect(exhausted.world.monetaryAuthorities).toEqual(exhaustedOpening.monetaryAuthorities);
    expect(exhaustedOpening.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!.cash.get(f.currencies[0]!)).toBe(f.reserveFloor);
  });
  it("normalizes unordered registry insertion order before shared FX allocation", () => {
    const f = fixture();
    const unconstrained = run(f, f.world);
    expect(unconstrained.phaseBoundaryError).toBeUndefined();
    const fullPaid = assertPaidCargoReceipts(unconstrained, f.links).paid;
    expect(fullPaid).toBeGreaterThan(0);
    const opening = withOutputStock(f, fullPaid * 0.60);

    // Do not reorder the route arrays: they are ordered evidence, unlike the
    // keyed registries below. The same opening stocks/policies must produce
    // identical realized receipts even when their Map insertion order differs.
    const shuffled: WorldState = {
      ...opening,
      states: new Map([...opening.states].reverse()),
      regions: new Map([...opening.regions].reverse()),
      markets: new Map([...opening.markets].reverse()),
      cohorts: new Map([...opening.cohorts].reverse()),
      clans: new Map([...opening.clans].reverse()),
      productionUnits: new Map([...opening.productionUnits].reverse()),
      transportLinks: new Map([...opening.transportLinks].reverse()),
      monetaryAuthorities: new Map(
        [...opening.monetaryAuthorities].reverse().map(([id, authority]) => [
          id,
          {
            ...authority,
            fxPools: new Map([...authority.fxPools].reverse().map(([poolId, pool]) => [
              poolId, { ...pool, cash: new Map([...pool.cash].reverse()) },
            ] as const)),
          },
        ] as const),
      ),
    };
    expect([...shuffled.regions.keys()]).not.toEqual([...opening.regions.keys()]);
    expect([...shuffled.transportLinks.keys()])
      .not.toEqual([...opening.transportLinks.keys()]);

    const normal = run(f, opening);
    const reversed = run(f, shuffled);
    for (const result of [normal, reversed]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(assertPaidCargoReceipts(result).paid).toBeGreaterThan(0);
      expect(result.world.monetaryAuthorities.get(f.chosen.authorityId)!
        .fxPools.get(f.chosen.poolId)!.cash.get(f.currencies[0])!)
        .toBeGreaterThanOrEqual(f.reserveFloor);
      expect(totalIron(result.world)).toBeCloseTo(totalIron(opening), 7);
      for (const currency of f.currencies) {
        expect(totalCash(result.world, currency)).toBeCloseTo(totalCash(opening, currency), 6);
      }
    }

    // These comparisons retain the actual transaction sequence/IDs, actor
    // balances, FX reserve balances, in-transit owners and market prices.
    // Aggregate totals alone could miss a recipient swap or second payout.
    expect(reversed.context.transactions).toEqual(normal.context.transactions);
    expect(reversed.world.shipments).toEqual(normal.world.shipments);
    expect(reversed.world.productionUnits).toEqual(normal.world.productionUnits);
    expect(reversed.world.monetaryAuthorities).toEqual(normal.world.monetaryAuthorities);
    expect(reversed.world.markets).toEqual(normal.world.markets);

    // Sensitivity control: a one-unit forged FX payout must be visible to the
    // exact receipt comparison, even though shipment counts are unchanged.
    const forged = [...reversed.context.transactions];
    const index = forged.findIndex(tx => tx.type === "FX_OUTPUT");
    expect(index).toBeGreaterThanOrEqual(0);
    forged[index] = { ...forged[index]!, moneyAmount: forged[index]!.moneyAmount! + 1 };
    expect(forged).not.toEqual(normal.context.transactions);
    expect(opening.monetaryAuthorities).toEqual(shuffled.monetaryAuthorities);
  });

});
