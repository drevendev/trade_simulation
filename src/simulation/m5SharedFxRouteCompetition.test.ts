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

function run(f: ReturnType<typeof fixture>, world: WorldState, allowed = true, tick = 7) {
  return executeM5AutonomousRegionalTradeTick(
    world, tick, households, (_phase, current) => current,
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
        .fxPools.get(f.chosen.poolId)!.cash.get(f.currencies[0]!)!)
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


  it("allows trade on the next tick only after a cash-conserving FX refill", () => {
    const f = fixture();
    const depletedOpening = withOutputStock(f, 0);
    const noFx = run(f, depletedOpening, true, 7);
    expect(noFx.phaseTrace).toEqual([...Array(16).keys()]);
    expect(noFx.phaseBoundaryError).toBeUndefined();
    expect(noFx.reconciliationErrors).toBeNull();
    expect(noFx.context.transactions.filter(tx => tx.phase === 7 &&
      ["FX_INPUT", "FX_OUTPUT", "SHIPMENT_DISPATCH", "TRADE_GOODS_SALE",
        "TRANSPORT_FEE", "IMPORT_TARIFF"].includes(tx.type))).toHaveLength(0);
    expect(noFx.world.shipments?.size ?? 0).toBe(0);
    // No-FX must not suppress genuinely paid domestic procurement.
    expect(noFx.context.transactions.filter(tx =>
      tx.phase === 4 && tx.type === "MARKET_SALE" &&
      (tx.moneyAmount ?? 0) > 0 && (tx.quantity ?? 0) > 0).length)
      .toBeGreaterThan(0);

    // Counterfactual at the SAME tick as the funded positive control:
    // an elapsed tick alone must never make a floor-only FX pool payable.
    // Both branches begin with the identical post-tick-7 canonical world.
    const stillUnfunded = run(f, noFx.world, true, 8);
    expect(stillUnfunded.phaseTrace).toEqual([...Array(16).keys()]);
    expect(stillUnfunded.phaseBoundaryError).toBeUndefined();
    expect(stillUnfunded.reconciliationErrors).toBeNull();
    expect(stillUnfunded.context.transactions.filter(tx => tx.phase === 7 &&
      ["FX_INPUT", "FX_OUTPUT", "SHIPMENT_DISPATCH", "TRADE_GOODS_SALE",
        "TRANSPORT_FEE", "IMPORT_TARIFF", "CONSUMPTION_TAX"].includes(tx.type)))
      .toHaveLength(0);
    expect(stillUnfunded.world.shipments?.size ?? 0).toBe(0);
    const unfundedPool = stillUnfunded.world.monetaryAuthorities
      .get(f.chosen.authorityId)!.fxPools.get(f.chosen.poolId)!;
    expect(unfundedPool.cash.get(f.currencies[0]!)).toBe(f.reserveFloor);
    expect(unfundedPool.cash).toEqual(noFx.world.monetaryAuthorities
      .get(f.chosen.authorityId)!.fxPools.get(f.chosen.poolId)!.cash);
    for (const id of f.currencies) {
      expect(totalCash(stillUnfunded.world, id))
        .toBeCloseTo(totalCash(noFx.world, id), 6);
    }
    expect(totalIron(stillUnfunded.world)).toBeCloseTo(totalIron(noFx.world), 7);

    const currency = f.currencies[0]!;
    const refill = 20_000;
    const authority = noFx.world.monetaryAuthorities.get(f.chosen.authorityId)!;
    const pool = authority.fxPools.get(f.chosen.poolId)!;
    expect(pool.cash.get(currency)).toBe(f.reserveFloor);
    const funder = [...noFx.world.productionUnits.values()].find(unit =>
      (unit.wallet.get(currency) ?? 0) > refill * 2);
    expect(funder).toBeDefined();
    const initialFunderCash = funder!.wallet.get(currency)!;
    // Explicit test-only funding transfer: no newly minted money. This is NOT
    // claimed to be an autonomous monetary-policy/FX-replenishment mechanic.
    const refilled: WorldState = {
      ...noFx.world,
      productionUnits: new Map(noFx.world.productionUnits).set(
        funder!.productionUnitId, {
          ...funder!,
          wallet: new Map(funder!.wallet).set(currency, initialFunderCash - refill),
        },
      ),
      monetaryAuthorities: new Map(noFx.world.monetaryAuthorities).set(
        f.chosen.authorityId, {
          ...authority,
          fxPools: new Map(authority.fxPools).set(f.chosen.poolId, {
            ...pool,
            cash: new Map(pool.cash).set(currency, f.reserveFloor + refill),
          }),
        },
      ),
    };
    expect(totalCash(refilled, currency)).toBeCloseTo(totalCash(noFx.world, currency), 6);
    expect(totalIron(refilled)).toBeCloseTo(totalIron(noFx.world), 7);
    expect(refilled.productionUnits.get(funder!.productionUnitId)!.wallet.get(currency))
      .toBeCloseTo(initialFunderCash - refill, 7);
    expect(noFx.world.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!.cash.get(currency)).toBe(f.reserveFloor);

    // The next *full* canonical tick must re-evaluate Phase-1 law, Phase-2/4
    // procurement, Phase-6 prices and Phase-7 finite-pool FX against live stocks.
    const resumed = run(f, refilled, true, 8);
    expect(resumed.phaseTrace).toEqual([...Array(16).keys()]);
    expect(resumed.phaseBoundaryError).toBeUndefined();
    expect(resumed.reconciliationErrors).toBeNull();
    const receipts = assertPaidCargoReceipts(resumed);
    expect(receipts.cargos.length).toBeGreaterThan(0);
    expect(receipts.paid).toBeGreaterThan(0);
    expect(receipts.paid).toBeLessThanOrEqual(refill + 1e-8);
    for (const cargo of receipts.cargos) {
      expect(f.links).toContain(cargo.transportLinkId);
      expect(cargo.departureTick).toBe(8);
      expect(cargo.buyerPaymentCurrencyId).toBe(f.currencies[1]);
      expect(cargo.invoiceCurrencyId).toBe(currency);
    }
    const finalPool = resumed.world.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;
    expect(finalPool.cash.get(currency)! - (f.reserveFloor + refill))
      .toBeCloseTo(-receipts.paid, 7);
    expect(finalPool.cash.get(currency)!).toBeGreaterThanOrEqual(f.reserveFloor);
    expect(finalPool.cash.get(f.currencies[1]!)! - pool.cash.get(f.currencies[1]!)!)
      .toBeCloseTo(receipts.inputs.reduce((sum, leg) => sum + leg.moneyAmount!, 0), 7);
    for (const id of f.currencies) {
      expect(totalCash(resumed.world, id)).toBeCloseTo(totalCash(refilled, id), 6);
    }
    expect(totalIron(resumed.world)).toBeCloseTo(totalIron(refilled), 7);

    const replay = run(f, refilled, true, 8);
    expect(replay.phaseBoundaryError).toBeUndefined();
    expect(replay.reconciliationErrors).toBeNull();
    expect(replay.context.transactions).toEqual(resumed.context.transactions);
    expect(replay.world.shipments).toEqual(resumed.world.shipments);
    expect(replay.world.productionUnits).toEqual(resumed.world.productionUnits);
    expect(replay.world.monetaryAuthorities).toEqual(resumed.world.monetaryAuthorities);
    expect(replay.world.markets).toEqual(resumed.world.markets);
  });

  it("credits paid two-route cargo on its scheduled later tick exactly once", () => {
    const f = fixture();
    // This exercises real Phase-7 quote/FX/dispatch followed by Phase-1
    // delivery, rather than injecting an already-paid synthetic shipment.
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) =>
        [id, { ...link, travelTicks: 2 }] as const)),
    };
    const dispatched = run(f, opening, true, 7);
    expect(dispatched.phaseTrace).toEqual([...Array(16).keys()]);
    expect(dispatched.phaseBoundaryError).toBeUndefined();
    expect(dispatched.reconciliationErrors).toBeNull();
    const paid = assertPaidCargoReceipts(dispatched, f.links);
    expect(paid.cargos).toHaveLength(2);
    for (const cargo of paid.cargos) {
      expect(cargo.departureTick).toBe(7);
      expect(cargo.arrivalTick).toBe(9);
      expect(cargo.travelTicksAtDispatch).toBe(2);
      expect(cargo.status).toBe("IN_TRANSIT");
      expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
      expect(cargo.destinationInventoryBucket).toBe("INPUT");
    }
    const inTransitIron = paid.cargos.reduce((sum, cargo) => sum + cargo.quantity, 0);
    expect(inTransitIron).toBeGreaterThan(0);
    const openingIron = totalIron(dispatched.world);
    const cashAfterPayment = f.currencies.map(currency =>
      totalCash(dispatched.world, currency));

    // Close future cross-border trading only; due physical deliveries must
    // remain independent of fresh trade permissions and FX availability.
    const waiting = run(f, dispatched.world, false, 8);
    expect(waiting.phaseTrace).toEqual([...Array(16).keys()]);
    expect(waiting.phaseBoundaryError).toBeUndefined();
    expect(waiting.reconciliationErrors).toBeNull();
    expect(waiting.world.shipments).toEqual(dispatched.world.shipments);
    expect(waiting.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY")).toHaveLength(0);
    expect(waiting.context.transactions.filter(tx => tx.phase === 7 &&
      ["FX_INPUT", "FX_OUTPUT", "TRADE_GOODS_SALE", "SHIPMENT_DISPATCH",
        "IMPORT_TARIFF", "TRANSPORT_FEE"].includes(tx.type))).toHaveLength(0);
    expect(totalIron(waiting.world)).toBeCloseTo(openingIron, 7);
    for (const [index, currency] of f.currencies.entries()) {
      expect(totalCash(waiting.world, currency)).toBeCloseTo(cashAfterPayment[index]!, 6);
    }

    let observedPhase1 = 0;
    const arrived = executeM5AutonomousRegionalTradeTick(
      waiting.world, 9, households, (_phase, current) => current,
      { ...f.options, phase1TradeLawProvider: () => undefined },
      (phase, beforeWorld, afterWorld, context) => {
        if (phase !== 1) return;
        observedPhase1++;
        expect(beforeWorld.shipments).toEqual(waiting.world.shipments);
        expect(afterWorld.shipments?.size).toBe(0);
        const receipts = context.transactions.filter(tx =>
          tx.type === "SHIPMENT_DELIVERY");
        expect(receipts).toHaveLength(paid.cargos.length);
        expect(new Set(receipts.map(tx => tx.transactionId)).size).toBe(paid.cargos.length);
        for (const cargo of paid.cargos) {
          const receipt = receipts.find(tx =>
            tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
          expect(receipt).toMatchObject({
            tick: 9, phase: 1, quantity: cargo.quantity,
            goodId: cargo.goodId, destination: cargo.beneficialOwner,
            sourceRegionId: cargo.originRegionId,
            destinationRegionId: cargo.destinationRegionId,
          });
          expect(receipt?.moneyAmount).toBeUndefined();
        }
        // Phase 1 moves in-transit goods to the dispatch-frozen beneficial
        // owner, without paying seller/tax/FX a second time.
        for (const [id, unit] of beforeWorld.productionUnits) {
          const due = paid.cargos.filter(cargo =>
            cargo.beneficialOwner.type === "PRODUCTION_UNIT" &&
            cargo.beneficialOwner.productionUnitId === id)
            .reduce((sum, cargo) => sum + cargo.quantity, 0);
          const afterUnit = afterWorld.productionUnits.get(id)!;
          expect(afterUnit.inputInventory.get(IRON) ?? 0)
            .toBeCloseTo((unit.inputInventory.get(IRON) ?? 0) + due, 7);
          expect(afterUnit.outputInventory).toEqual(unit.outputInventory);
          expect(afterUnit.wallet).toEqual(unit.wallet);
        }
        expect(afterWorld.monetaryAuthorities).toEqual(beforeWorld.monetaryAuthorities);
        expect(afterWorld.states).toEqual(beforeWorld.states);
        expect(afterWorld.clans).toEqual(beforeWorld.clans);
      },
    );
    expect(observedPhase1).toBe(1);
    expect(arrived.phaseTrace).toEqual([...Array(16).keys()]);
    expect(arrived.phaseBoundaryError).toBeUndefined();
    expect(arrived.reconciliationErrors).toBeNull();
    expect(arrived.world.shipments?.size).toBe(0);
    const actualReceipts = arrived.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY");
    expect(actualReceipts).toHaveLength(2);
    expect(actualReceipts.reduce((sum, tx) => sum + (tx.quantity ?? 0), 0))
      .toBeCloseTo(inTransitIron, 7);
    expect(arrived.context.transactions.filter(tx =>
      ["FX_INPUT", "FX_OUTPUT", "TRADE_GOODS_SALE", "SHIPMENT_DISPATCH",
        "IMPORT_TARIFF", "TRANSPORT_FEE"].includes(tx.type))).toHaveLength(0);
    expect(totalIron(arrived.world)).toBeCloseTo(openingIron, 7);
    for (const [index, currency] of f.currencies.entries()) {
      expect(totalCash(arrived.world, currency)).toBeCloseTo(cashAfterPayment[index]!, 6);
    }

    const replay = run(f, waiting.world, false, 9);
    expect(replay.phaseBoundaryError).toBeUndefined();
    expect(replay.reconciliationErrors).toBeNull();
    expect(replay.context.transactions).toEqual(arrived.context.transactions);
    expect(replay.world.shipments).toEqual(arrived.world.shipments);
    expect(replay.world.productionUnits).toEqual(arrived.world.productionUnits);
    expect(replay.world.monetaryAuthorities).toEqual(arrived.world.monetaryAuthorities);

    // After the authoritative due-date credit, there is no second arrival
    // and no duplicated goods (or repeat payment) in the subsequent tick.
    const following = run(f, arrived.world, false, 10);
    expect(following.phaseBoundaryError).toBeUndefined();
    expect(following.reconciliationErrors).toBeNull();
    expect(following.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY")).toHaveLength(0);
    expect(following.world.shipments?.size).toBe(0);
    expect(totalIron(following.world)).toBeCloseTo(openingIron, 7);
  });


  it("accounts for two different real-route transit loss rates exactly once", () => {
    const f = fixture();
    const rates = new Map<TransportLinkId, number>([
      [f.links[0]!, 0.125], [f.links[1]!, 0.25],
    ]);
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) => [
        id, {
          ...link,
          travelTicks: 2,
          seed: { ...link.seed, routinePhysicalLossRate: rates.get(id) ?? 0 },
        },
      ] as const)),
    };
    const initialGoods = totalIron(opening);
    const dispatched = run(f, opening, true, 7);
    expect(dispatched.phaseTrace).toEqual([...Array(16).keys()]);
    expect(dispatched.phaseBoundaryError).toBeUndefined();
    expect(dispatched.reconciliationErrors).toBeNull();
    const { cargos, dispatches } = assertPaidCargoReceipts(dispatched, f.links);
    expect(cargos).toHaveLength(2);
    const sales = dispatched.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
    const losses = dispatched.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "GOODS_TRANSPORT_LOSS");
    expect(sales).toHaveLength(2);
    expect(losses).toHaveLength(2);
    expect(new Set(losses.map(tx => tx.transactionId)).size).toBe(2);
    let totalDestroyed = 0;
    for (const cargo of cargos) {
      const dispatch = dispatches.find(tx =>
        tx.destinationRegionId === cargo.destinationRegionId);
      expect(dispatch).toBeDefined();
      const invoice = sales.find(tx => tx.bundleId === dispatch!.bundleId);
      const loss = losses.find(tx => tx.bundleId === dispatch!.bundleId);
      expect(invoice).toBeDefined();
      expect(loss).toBeDefined();
      expect(dispatch!.quantity).toBe(cargo.quantity);
      expect(invoice!.quantity).toBeGreaterThan(cargo.quantity);
      expect(loss!.quantity).toBeGreaterThan(0);
      expect(invoice!.quantity!).toBeCloseTo(cargo.quantity + loss!.quantity!, 8);
      expect(loss!.quantity!).toBeCloseTo(
        invoice!.quantity! * rates.get(cargo.transportLinkId)!, 8,
      );
      expect(loss).toMatchObject({
        tick: 7, phase: 7, goodId: IRON,
        source: cargo.beneficialOwner,
        sourceRegionId: cargo.originRegionId,
        destinationRegionId: cargo.destinationRegionId,
        reason: "DISPATCH_ROUTINE_PHYSICAL_LOSS:" + cargo.id,
      });
      expect(loss!.moneyAmount).toBeUndefined();
      expect(cargo.arrivalTick).toBe(9);
      totalDestroyed += loss!.quantity!;
    }
    expect(totalDestroyed).toBeGreaterThan(0);
    // Seller loses invoiced gross goods; only the surviving paid quantity is
    // owned in transit. The missing stock must be an attributed physical loss.
    expect(totalIron(dispatched.world))
      .toBeCloseTo(initialGoods - totalDestroyed, 7);
    const paidCash = f.currencies.map(currency => totalCash(dispatched.world, currency));
    for (const currency of f.currencies) {
      expect(totalCash(dispatched.world, currency))
        .toBeCloseTo(totalCash(opening, currency), 6);
    }

    const waiting = run(f, dispatched.world, false, 8);
    expect(waiting.phaseBoundaryError).toBeUndefined();
    expect(waiting.reconciliationErrors).toBeNull();
    expect(waiting.world.shipments).toEqual(dispatched.world.shipments);
    expect(waiting.context.transactions.filter(tx =>
      tx.type === "GOODS_TRANSPORT_LOSS" || tx.type === "SHIPMENT_DELIVERY"))
      .toHaveLength(0);
    expect(totalIron(waiting.world)).toBeCloseTo(initialGoods - totalDestroyed, 7);

    let phase1Visits = 0;
    const arrived = executeM5AutonomousRegionalTradeTick(
      waiting.world, 9, households, (_phase, current) => current,
      { ...f.options, phase1TradeLawProvider: () => undefined },
      (phase, before, after, context) => {
        if (phase !== 1) return;
        phase1Visits++;
        expect(after.shipments?.size).toBe(0);
        const receipts = context.transactions.filter(tx =>
          tx.type === "SHIPMENT_DELIVERY");
        expect(receipts).toHaveLength(2);
        for (const cargo of cargos) {
          expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
          if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
            throw new Error("golden fixture requires real production-unit buyers");
          }
          const id = cargo.beneficialOwner.productionUnitId;
          expect(after.productionUnits.get(id)!.inputInventory.get(IRON) ?? 0)
            .toBeCloseTo(
              (before.productionUnits.get(id)!.inputInventory.get(IRON) ?? 0) +
                cargo.quantity, 7,
            );
          expect(receipts.filter(tx =>
            tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id))
            .toHaveLength(1);
        }
        expect(after.monetaryAuthorities).toEqual(before.monetaryAuthorities);
      },
    );
    expect(phase1Visits).toBe(1);
    expect(arrived.phaseBoundaryError).toBeUndefined();
    expect(arrived.reconciliationErrors).toBeNull();
    expect(arrived.world.shipments?.size).toBe(0);
    expect(arrived.context.transactions.filter(tx =>
      tx.type === "GOODS_TRANSPORT_LOSS" || tx.type === "FX_INPUT" ||
      tx.type === "FX_OUTPUT" || tx.type === "TRANSPORT_FEE" ||
      tx.type === "IMPORT_TARIFF")).toHaveLength(0);
    expect(totalIron(arrived.world)).toBeCloseTo(initialGoods - totalDestroyed, 7);
    for (const [index, currency] of f.currencies.entries()) {
      expect(totalCash(arrived.world, currency)).toBeCloseTo(paidCash[index]!, 6);
    }
    const replay = run(f, waiting.world, false, 9);
    expect(replay.context.transactions).toEqual(arrived.context.transactions);
    expect(replay.world.productionUnits).toEqual(arrived.world.productionUnits);
    expect(replay.world.shipments).toEqual(arrived.world.shipments);
    const next = run(f, arrived.world, false, 10);
    expect(next.phaseBoundaryError).toBeUndefined();
    expect(next.reconciliationErrors).toBeNull();
    expect(next.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY" || tx.type === "GOODS_TRANSPORT_LOSS"))
      .toHaveLength(0);
    expect(totalIron(next.world)).toBeCloseTo(initialGoods - totalDestroyed, 7);

    // Non-vacuity control: an otherwise identical zero-attrition run must
    // dispatch without any loss receipt or real-goods destruction.
    const zeroLoss: WorldState = {
      ...opening,
      transportLinks: new Map([...opening.transportLinks].map(([id, link]) => [
        id, { ...link, seed: { ...link.seed, routinePhysicalLossRate: 0 } },
      ] as const)),
    };
    const intact = run(f, zeroLoss, true, 7);
    expect(intact.phaseBoundaryError).toBeUndefined();
    expect(intact.reconciliationErrors).toBeNull();
    expect(assertPaidCargoReceipts(intact, f.links).cargos).toHaveLength(2);
    expect(intact.context.transactions.filter(tx =>
      tx.type === "GOODS_TRANSPORT_LOSS")).toHaveLength(0);
    expect(totalIron(intact.world)).toBeCloseTo(initialGoods, 7);
  });


  it("enforces live per-link cargo weight capacity without suppressing another paid route", () => {
    const f = fixture();
    const opening = f.world;
    const baseline = run(f, opening);
    expect(baseline.phaseBoundaryError).toBeUndefined();
    expect(baseline.reconciliationErrors).toBeNull();
    const normal = assertPaidCargoReceipts(baseline, f.links);
    const chosenId = f.links[0]!;
    const otherId = f.links[1]!;
    const normalCargo = normal.cargos.find(cargo => cargo.transportLinkId === chosenId)!;
    expect(normalCargo).toBeDefined();
    const weight = baselineDefinitionPack.goods[IRON]!.cargoWeightPerUnit;
    expect(weight).toBeGreaterThan(0);
    const link = opening.transportLinks.get(chosenId)!;
    expect(link.seed.condition).toBeGreaterThan(0);

    // The physical budget is weight, NOT item count. Keep condition unchanged
    // so tariffs and transport-cost policy are the same as the full-capacity run.
    const limitedCapacity = normalCargo.quantity * weight * 0.5;
    const limitedWorld: WorldState = {
      ...opening,
      transportLinks: new Map(opening.transportLinks).set(chosenId, {
        ...link,
        seed: { ...link.seed, baseCapacity: limitedCapacity / link.seed.condition },
      }),
    };
    const constrained = run(f, limitedWorld);
    expect(constrained.phaseTrace).toEqual([...Array(16).keys()]);
    expect(constrained.phaseBoundaryError).toBeUndefined();
    expect(constrained.reconciliationErrors).toBeNull();
    const paid = assertPaidCargoReceipts(constrained);
    const used = paid.cargos.filter(cargo => cargo.transportLinkId === chosenId)
      .reduce((sum, cargo) => sum + cargo.quantity * weight, 0);
    expect(used).toBeGreaterThan(0); // A zero-dispatch test is not a bottleneck proof.
    expect(used).toBeLessThanOrEqual(limitedCapacity + 1e-8);
    expect(used).toBeLessThan(normalCargo.quantity * weight);
    expect(paid.cargos.some(cargo => cargo.transportLinkId === otherId)).toBe(true);
    for (const currency of f.currencies) {
      expect(totalCash(constrained.world, currency)).toBeCloseTo(totalCash(opening, currency), 6);
    }
    expect(totalIron(constrained.world)).toBeCloseTo(totalIron(opening), 7);

    // Physically unavailable route: no FX debit or goods mutation may be
    // attributed to this link. Domestic purchases still settle identically.
    const noCapacity: WorldState = {
      ...opening,
      transportLinks: new Map(opening.transportLinks).set(chosenId, {
        ...link, seed: { ...link.seed, baseCapacity: 0 },
      }),
    };
    const blocked = run(f, noCapacity);
    expect(blocked.phaseBoundaryError).toBeUndefined();
    expect(blocked.reconciliationErrors).toBeNull();
    expect(blocked.world.shipments?.size).toBeGreaterThan(0);
    expect([...(blocked.world.shipments?.values() ?? [])].every(
      cargo => cargo.transportLinkId === otherId,
    )).toBe(true);
    const locals = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx => tx.phase === 4 && tx.type === "MARKET_SALE");
    expect(locals(blocked)).toEqual(locals(baseline));
    expect(totalIron(blocked.world)).toBeCloseTo(totalIron(opening), 7);
    for (const currency of f.currencies) {
      expect(totalCash(blocked.world, currency)).toBeCloseTo(totalCash(opening, currency), 6);
    }
    const replay = run(f, limitedWorld);
    expect(replay.context.transactions).toEqual(constrained.context.transactions);
    expect(replay.world.shipments).toEqual(constrained.world.shipments);
    expect(replay.world.productionUnits).toEqual(constrained.world.productionUnits);
  });

  it("reserves shared origin seller stock once across both paid border routes", () => {
    const f = fixture();
    const baseline = run(f, f.world);
    expect(baseline.phaseBoundaryError).toBeUndefined();
    expect(baseline.reconciliationErrors).toBeNull();
    const normal = assertPaidCargoReceipts(baseline, f.links);
    const totalNormal = normal.cargos.reduce((sum, cargo) => sum + cargo.quantity, 0);
    const largestNormal = Math.max(...normal.cargos.map(cargo => cargo.quantity));
    expect(totalNormal).toBeGreaterThan(largestNormal);
    const firstLinkId = f.links[0]!;
    const firstNormal = normal.cargos.find(cargo => cargo.transportLinkId === firstLinkId)!;
    const secondNormal = normal.cargos.find(cargo => cargo.transportLinkId === f.links[1])!;
    const firstLimitQuantity = firstNormal.quantity * 0.5;
    const firstLink = f.world.transportLinks.get(firstLinkId)!;
    const cargoWeight = baselineDefinitionPack.goods[IRON]!.cargoWeightPerUnit;
    expect(firstLimitQuantity).toBeGreaterThan(0);
    expect(cargoWeight).toBeGreaterThan(0);
    expect(firstLink.seed.condition).toBeGreaterThan(0);
    const sourceSellerId = normal.cargos[0]!.seller.type === "PRODUCTION_UNIT"
      ? normal.cargos[0]!.seller.productionUnitId : null;
    expect(sourceSellerId).not.toBeNull();
    // The baseline must actually have one shared seller behind both routes.
    expect(normal.cargos).toHaveLength(f.links.length);
    for (const cargo of normal.cargos) {
      expect(cargo.seller.type).toBe("PRODUCTION_UNIT");
      if (cargo.seller.type === "PRODUCTION_UNIT") {
        expect(cargo.seller.productionUnitId).toBe(sourceSellerId);
      }
    }
    const seller = f.world.productionUnits.get(sourceSellerId!)!;
    const localSaleQuantity = baseline.context.transactions.filter(tx =>
      tx.phase === 4 && tx.type === "MARKET_SALE" &&
      tx.source?.type === "PRODUCTION_UNIT" &&
      tx.source.productionUnitId === sourceSellerId)
      .reduce((sum, tx) => sum + (tx.quantity ?? 0), 0);
    // This seller may have no domestic Phase-4 buyers in this seeded fixture;
    // paid Phase-7 export stock, rather than local sale, proves non-vacuity.
    expect(localSaleQuantity).toBeGreaterThanOrEqual(0);

    // Cap the first contender physically in this scoped fixture so a scarcity-
    // driven Phase-6 price response cannot consume the entire seller stock on
    // that one route. Each link can still ship alone, but the two *capped*
    // offers together exceed the ONE available post-Phase-4 stock budget.
    const cappedPotential = firstLimitQuantity + secondNormal.quantity;
    const largestCappedOffer = Math.max(firstLimitQuantity, secondNormal.quantity);
    const sharedExportBudget = (largestCappedOffer + cappedPotential) / 2;
    expect(sharedExportBudget).toBeGreaterThan(largestCappedOffer);
    expect(sharedExportBudget).toBeLessThan(cappedPotential);
    const reducedSellerStock = localSaleQuantity + sharedExportBudget;
    expect(reducedSellerStock).toBeLessThan(seller.inputInventory.get(IRON)!);
    const scarceWorld: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(firstLinkId, {
        ...firstLink,
        seed: { ...firstLink.seed,
          baseCapacity: firstLimitQuantity * cargoWeight / firstLink.seed.condition,
        },
      }),
      productionUnits: new Map(f.world.productionUnits).set(sourceSellerId!, {
        ...seller,
        inputInventory: new Map(seller.inputInventory).set(IRON, reducedSellerStock),
      }),
    };
    const scarce = run(f, scarceWorld);
    const aloneSecond = runOnlyLink(f, scarceWorld, f.links[1]!);
    const diagCargo = (x: ReturnType<typeof run>) => [...(x.world.shipments?.values() ?? [])].map(c => ({
      link: c.transportLinkId, quantity: c.quantity, seller: c.seller,
    }));
    throw new Error("SCARCE_DIAG " + JSON.stringify({
      baseline: diagCargo(baseline),
      constrained: diagCargo(scarce), secondAlone: diagCargo(aloneSecond),
      budget: sharedExportBudget, firstLimitQuantity, secondNormal: secondNormal.quantity,
      sourceSellerId, initialSellerStock: seller.inputInventory.get(IRON),
      remainingSellerStock: scarce.world.productionUnits.get(sourceSellerId!)?.inputInventory.get(IRON),
      phase7: scarce.context.transactions.filter(tx => tx.phase === 7).map(tx => ({
        type: tx.type, quantity: tx.quantity, moneyAmount: tx.moneyAmount,
      })).slice(0, 15),
    }));
    expect(scarce.phaseTrace).toEqual([...Array(16).keys()]);
    expect(scarce.phaseBoundaryError).toBeUndefined();
    expect(scarce.reconciliationErrors).toBeNull();
    const scarceCargos = assertPaidCargoReceipts(scarce, f.links).cargos;
    // Scarcity must not hide a lost contender: BOTH paid links still dispatch
    // from the SAME source seller, not merely any positive aggregate export.
    expect(scarceCargos).toHaveLength(f.links.length);
    for (const cargo of scarceCargos) {
      expect(cargo.seller.type).toBe("PRODUCTION_UNIT");
      if (cargo.seller.type === "PRODUCTION_UNIT") {
        expect(cargo.seller.productionUnitId).toBe(sourceSellerId);
      }
    }
    const totalScarce = scarceCargos.reduce((sum, cargo) => sum + cargo.quantity, 0);
    expect(totalScarce).toBeGreaterThan(0);
    expect(totalScarce).toBeLessThan(totalNormal);
    expect(totalScarce).toBeLessThanOrEqual(sharedExportBudget + 1e-8);
    const localScarce = scarce.context.transactions.filter(tx =>
      tx.phase === 4 && tx.type === "MARKET_SALE" &&
      tx.source?.type === "PRODUCTION_UNIT" &&
      tx.source.productionUnitId === sourceSellerId)
      .reduce((sum, tx) => sum + (tx.quantity ?? 0), 0);
    expect(localScarce).toBeCloseTo(localSaleQuantity, 7);
    expect(localScarce + totalScarce).toBeLessThanOrEqual(reducedSellerStock + 1e-8);

    // Sensitive negative control: a legal one-link-only counterfactual is an
    // otherwise valid paid export, but MUST fail the two-link acceptance gate.
    const oneLinkOnly = runOnlyLink(f, scarceWorld, f.links[0]!);
    expect(oneLinkOnly.phaseBoundaryError).toBeUndefined();
    expect(oneLinkOnly.reconciliationErrors).toBeNull();
    expect(assertPaidCargoReceipts(oneLinkOnly, [f.links[0]!]).cargos).toHaveLength(1);
    expect(() => assertPaidCargoReceipts(oneLinkOnly, f.links)).toThrow();

    expect(totalIron(scarce.world)).toBeCloseTo(totalIron(scarceWorld), 7);
    for (const currency of f.currencies) {
      expect(totalCash(scarce.world, currency)).toBeCloseTo(totalCash(scarceWorld, currency), 6);
    }
    const replay = run(f, scarceWorld);
    expect(replay.context.transactions).toEqual(scarce.context.transactions);
    expect(replay.world.shipments).toEqual(scarce.world.shipments);
    expect(replay.world.productionUnits).toEqual(scarce.world.productionUnits);
  });

});
