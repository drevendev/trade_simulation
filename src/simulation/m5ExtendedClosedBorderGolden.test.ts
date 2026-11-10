/**
 * Issue #676 / REQ-ACCEPTANCE-006: extended real-orchestrator regression.
 * Two independently funded international routes dispatch paid goods before a
 * persistent border closure. Compare every one of 16 consecutive ticks with
 * the same opening economy constructed in reverse keyed-registry order.
 * The full acceptance gate remains PARTIAL; this does not invent economics.
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

function run(
  f: ReturnType<typeof fixture>, world: WorldState, allowed = true, tick = 7,
  observer?: Parameters<typeof executeM5AutonomousRegionalTradeTick>[5],
) {
  return executeM5AutonomousRegionalTradeTick(
    world, tick, households, (_phase, current) => current,
    allowed ? f.options : { ...f.options, phase1TradeLawProvider: () => undefined },
    observer,
  );
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

function reordered(world: WorldState): WorldState {
  // Map insertion order is not economic priority. Ordered route arrays remain
  // untouched: changing them would change legal routing evidence.
  return {
    ...world,
    states: new Map([...world.states].reverse()),
    regions: new Map([...world.regions].reverse()),
    markets: new Map([...world.markets].reverse()),
    cohorts: new Map([...world.cohorts].reverse()),
    clans: new Map([...world.clans].reverse()),
    productionUnits: new Map([...world.productionUnits].reverse()),
    transportLinks: new Map([...world.transportLinks].reverse()),
    monetaryAuthorities: new Map([...world.monetaryAuthorities].reverse().map(
      ([id, authority]) => [id, {
        ...authority,
        fxPools: new Map([...authority.fxPools].reverse().map(
          ([poolId, pool]) => [poolId, {
            ...pool, cash: new Map([...pool.cash].reverse()),
          }] as const,
        )),
      }] as const,
    )),
  };
}

describe("M5 #676: extended multi-tick physical and financial replay", () => {
  it("preserves a two-route paid cargo lifecycle across 16 ticks of border closure", () => {
    const f = fixture();
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(
        ([id, link]) => [id, { ...link, travelTicks: 2 }] as const,
      )),
    };
    const baselineIron = totalIron(opening);
    const baselineCash = f.currencies.map(currency => totalCash(opening, currency));
    const baselineSellerCount = opening.productionUnits.size;
    let normalWorld = opening;
    let reorderedWorld = reordered(opening);
    let dispatchedIds: string[] = [];
    let frozenCargo = [...(opening.shipments?.values() ?? [])];
    let deliveredCount = 0;
    let paidOutputCount = 0;
    let observedPhase1Deliveries = 0;

    // Verify identities, payment owners and amounts against the dispatch-frozen
    // cargo, rather than only comparing aggregate counts across two replays.
    const verifyPaid = (
      transactions: ReturnType<typeof run>["context"]["transactions"],
      cargos: typeof frozenCargo,
    ) => {
      const phase7 = transactions.filter(tx => tx.phase === 7);
      const dispatches = phase7.filter(tx => tx.type === "SHIPMENT_DISPATCH");
      const inputs = phase7.filter(tx => tx.type === "FX_INPUT");
      const outputs = phase7.filter(tx => tx.type === "FX_OUTPUT");
      expect(dispatches).toHaveLength(cargos.length);
      expect(inputs).toHaveLength(cargos.length);
      expect(outputs).toHaveLength(cargos.length);
      const bundles = new Set<string>();
      const settlementIds = new Set<string>();
      for (const cargo of cargos) {
        expect(cargo.fxSettlementId).toBeDefined();
        expect(cargo.quantity).toBeGreaterThan(0);
        const dispatch = dispatches.filter(tx =>
          tx.goodId === cargo.goodId &&
          tx.quantity === cargo.quantity &&
          tx.sourceRegionId === cargo.originRegionId &&
          tx.destinationRegionId === cargo.destinationRegionId &&
          tx.source && JSON.stringify(tx.source) === JSON.stringify(cargo.seller) &&
          tx.destination && JSON.stringify(tx.destination) === JSON.stringify(cargo.beneficialOwner));
        expect(dispatch).toHaveLength(1);
        const bundle = dispatch[0]!.bundleId;
        expect(bundle).toBeDefined();
        bundles.add(bundle!);
        settlementIds.add(cargo.fxSettlementId!);
        const input = inputs.filter(tx =>
          tx.bundleId === bundle && tx.fxSettlementId === cargo.fxSettlementId);
        const output = outputs.filter(tx =>
          tx.bundleId === bundle && tx.fxSettlementId === cargo.fxSettlementId);
        expect(input).toHaveLength(1);
        expect(output).toHaveLength(1);
        expect(input[0]!.currencyId).toBe(cargo.buyerPaymentCurrencyId);
        expect(output[0]!.currencyId).toBe(cargo.invoiceCurrencyId);
        expect(input[0]!.source).toEqual(cargo.beneficialOwner);
        expect(output[0]!.destination).toEqual(cargo.seller);
        expect(input[0]!.moneyAmount).toBeGreaterThan(0);
        expect(output[0]!.moneyAmount).toBeGreaterThan(0);
      }
      expect(bundles.size).toBe(cargos.length);
      expect(settlementIds.size).toBe(cargos.length);
    };
    const verifyDue = (
      receipts: ReturnType<typeof run>["context"]["transactions"],
      cargos: typeof frozenCargo,
    ) => {
      expect(receipts).toHaveLength(cargos.length);
      expect(new Set(receipts.map(tx => tx.reason)).size).toBe(cargos.length);
      for (const cargo of cargos) {
        const matching = receipts.filter(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
        expect(matching).toHaveLength(1);
        expect(matching[0]).toMatchObject({
          tick: cargo.arrivalTick, phase: 1, goodId: cargo.goodId,
          quantity: cargo.quantity, destination: cargo.beneficialOwner,
          sourceRegionId: cargo.originRegionId,
          destinationRegionId: cargo.destinationRegionId,
        });
        expect(matching[0]!.moneyAmount).toBeUndefined();
      }
    };

    for (let tick = 7; tick < 23; tick++) {
      // No new international trade may occur once the original cargos exist;
      // delayed delivery MUST still take place under this blockade.
      const isOpen = tick === 7;
      let normal: ReturnType<typeof run>;
      let reversed: ReturnType<typeof run>;
      let phase4BudgetEvidence: { id: string; max: number; spent: number; excess: number }[] = [];
      const observe: Parameters<typeof executeM5AutonomousRegionalTradeTick>[5] =
        (phase, before, after, context) => {
          if (phase === 1 && tick === 9) {
            observedPhase1Deliveries++;
            expect(after.shipments?.size ?? 0).toBe(0);
            expect(after.monetaryAuthorities).toEqual(before.monetaryAuthorities);
            // The actual Phase-1 physical stock must go to each frozen owner,
            // not just produce correctly labeled receipts.
            for (const cargo of frozenCargo) {
              expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
              if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") continue;
              const id = cargo.beneficialOwner.productionUnitId;
              const oldStock = before.productionUnits.get(id)!.inputInventory.get(cargo.goodId) ?? 0;
              const newStock = after.productionUnits.get(id)!.inputInventory.get(cargo.goodId) ?? 0;
              expect(newStock - oldStock).toBeCloseTo(cargo.quantity, 8);
            }
          }
          if (phase !== 4) return;
          const intents = [
            ...(context.productionMarketIntents ?? []),
            ...(context.householdMarketIntents ?? []),
          ];
          phase4BudgetEvidence = intents.filter(i => i.side === "BUY").map(intent => {
            const spent = (context.phase4MarketAllocations ?? [])
              .filter(allocation => allocation.buyerIntentId === intent.id)
              .reduce((total, allocation) =>
                total + allocation.quantity * allocation.buyerGrossUnitPrice, 0);
            return {
              id: String(intent.id), max: intent.maxSpend!,
              spent, excess: spent - intent.maxSpend!,
            };
          });
        };
      try {
        normal = run(f, normalWorld, isOpen, tick, observe);
        reversed = run(f, reorderedWorld, isOpen, tick);
      } catch (error) {
        const offenders = phase4BudgetEvidence
          .filter(budget => budget.spent > 0)
          .sort((a, b) => b.excess - a.excess);
        throw new Error(
          "M5 extended golden failed on tick " + tick +
          "; Phase-4 BUY budgets=" + JSON.stringify(offenders),
          { cause: error },
        );
      }
      for (const result of [normal, reversed]) {
        expect(result.phaseTrace).toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
        expect(result.world.productionUnits.size).toBe(baselineSellerCount);
        expect(totalIron(result.world)).toBeCloseTo(baselineIron, 6);
        for (const [index, currency] of f.currencies.entries()) {
          expect(totalCash(result.world, currency))
            .toBeCloseTo(baselineCash[index]!, 5);
        }
      }
      // Compare full economic receipts and physical ownership, not only
      // a final tick hash that could hide an intermediate double payment.
      expect(reversed.context.transactions).toEqual(normal.context.transactions);
      expect(reversed.world.productionUnits).toEqual(normal.world.productionUnits);
      expect(reversed.world.shipments).toEqual(normal.world.shipments);
      expect(reversed.world.markets).toEqual(normal.world.markets);
      expect(reversed.world.monetaryAuthorities).toEqual(normal.world.monetaryAuthorities);
      expect(reversed.world.states).toEqual(normal.world.states);

      const phase7 = normal.context.transactions.filter(tx => tx.phase === 7);
      const dispatches = phase7.filter(tx => tx.type === "SHIPMENT_DISPATCH");
      const paidOutputs = phase7.filter(tx => tx.type === "FX_OUTPUT");
      const paidInputs = phase7.filter(tx => tx.type === "FX_INPUT");
      const tariffReceipts = phase7.filter(tx => tx.type === "IMPORT_TARIFF");
      const deliveries = normal.context.transactions.filter(tx =>
        tx.type === "SHIPMENT_DELIVERY");
      if (tick === 7) {
        expect(dispatches).toHaveLength(2);
        expect(paidOutputs).toHaveLength(2);
        expect(paidInputs).toHaveLength(2);
        expect(tariffReceipts).toHaveLength(2);
        const cargos = [...(normal.world.shipments?.values() ?? [])];
        expect(cargos).toHaveLength(2);
        expect(new Set(cargos.map(cargo => cargo.transportLinkId)))
          .toEqual(new Set(f.links));
        expect(cargos.every(cargo => cargo.arrivalTick === 9 &&
          cargo.departureTick === 7 && cargo.quantity > 0)).toBe(true);
        frozenCargo = cargos.map(cargo => ({ ...cargo }));
        verifyPaid(normal.context.transactions, frozenCargo);
        // This negative control exercises the SAME payment oracle against a
        // falsely linked FX leg rather than comparing unrelated arrays.
        const altered = normal.context.transactions.map(tx =>
          tx.type === "FX_INPUT" && tx.phase === 7 &&
          tx.fxSettlementId === frozenCargo[0]!.fxSettlementId
            ? { ...tx, fxSettlementId: "fxs:forged" as NonNullable<typeof tx.fxSettlementId> } : tx);
        expect(() => verifyPaid(altered, frozenCargo)).toThrow();
        dispatchedIds = cargos.map(cargo => cargo.id);
      } else {
        expect(dispatches).toHaveLength(0);
        expect(paidOutputs).toHaveLength(0);
        expect(paidInputs).toHaveLength(0);
        expect(tariffReceipts).toHaveLength(0);
      }
      paidOutputCount += paidOutputs.length;
      if (tick < 9) {
        expect(normal.world.shipments?.size).toBe(2);
        expect(deliveries).toHaveLength(0);
      } else {
        expect(normal.world.shipments?.size ?? 0).toBe(0);
        if (tick === 9) {
          expect(deliveries).toHaveLength(2);
          verifyDue(deliveries, frozenCargo);
          // Preserve aggregate quantity while falsifying an individual
          // beneficiary/quantity: the owner-bound acceptance must reject it.
          const alteredQuantity = deliveries.map((tx, index) => index === 0
            ? { ...tx, quantity: tx.quantity! + 1 } : tx);
          const alteredOwner = deliveries.map((tx, index) => index === 0
            ? { ...tx, destination: frozenCargo[1]!.beneficialOwner } : tx);
          expect(() => verifyDue(alteredQuantity, frozenCargo)).toThrow();
          expect(() => verifyDue(alteredOwner, frozenCargo)).toThrow();
        } else {
          expect(deliveries).toHaveLength(0);
        }
      }
      deliveredCount += deliveries.length;
      normalWorld = normal.world;
      reorderedWorld = reversed.world;
    }

    // Anti-vacuity: verify that trades really did happen, but ONLY once;
    // twenty-four independent funds are not available to be double-spent.
    expect(dispatchedIds).toHaveLength(2);
    expect(new Set(dispatchedIds).size).toBe(2);
    expect(observedPhase1Deliveries).toBe(1);
    expect(paidOutputCount).toBe(2);
    expect(deliveredCount).toBe(2);
    expect(normalWorld.shipments?.size ?? 0).toBe(0);
  });
  it("isolates a zero-capacity border corridor without consuming its neighbor's FX or local market", () => {
    const f = fixture();
    const full = run(f, f.world);
    const openingIron = totalIron(f.world);
    const openingCash = f.currencies.map(currency => totalCash(f.world, currency));
    const localReceipts = full.context.transactions.filter(tx => tx.phase === 4);
    const dispatched = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx =>
        tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH");
    const fxLegs = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx => tx.phase === 7 &&
        (tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT"));
    const tariffReceipts = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx =>
        tx.phase === 7 && tx.type === "IMPORT_TARIFF");
    expect(localReceipts.length).toBeGreaterThan(0);
    expect(dispatched(full)).toHaveLength(2);
    expect(new Set([...(full.world.shipments?.values() ?? [])]
      .map(cargo => cargo.transportLinkId))).toEqual(new Set(f.links));

    const withFactors = (factors: Map<TransportLinkId, number>, world = f.world) =>
      run({ ...f, options: { ...f.options, infrastructureFactors: factors } }, world);

    // Both corridors are independently legal and funded, but making either
    // one physically unusable must not eliminate the other paid shipment.
    for (const disabled of f.links) {
      const factors = new Map(f.links.map(id =>
        [id, id === disabled ? 0 : 1] as const));
      const result = withFactors(factors);
      const permuted = withFactors(factors, reordered(f.world));
      for (const actual of [result, permuted]) {
        expect(actual.phaseTrace).toEqual([...Array(16).keys()]);
        expect(actual.phaseBoundaryError).toBeUndefined();
        expect(actual.reconciliationErrors).toBeNull();
        expect(dispatched(actual)).toHaveLength(1);
        expect(fxLegs(actual)).toHaveLength(2);
        expect(tariffReceipts(actual)).toHaveLength(1);
        expect(actual.world.shipments?.size).toBe(1);
        expect([...actual.world.shipments!.values()][0]!.transportLinkId)
          .toBe(f.links.find(id => id !== disabled));
        expect(actual.context.transactions.filter(tx => tx.phase === 4))
          .toEqual(localReceipts);
        expect(totalIron(actual.world)).toBeCloseTo(openingIron, 6);
        for (const [index, currency] of f.currencies.entries()) {
          expect(totalCash(actual.world, currency)).toBeCloseTo(openingCash[index]!, 5);
        }
      }
      expect(permuted.context.transactions).toEqual(result.context.transactions);
      expect(permuted.world.shipments).toEqual(result.world.shipments);
      expect(permuted.world.monetaryAuthorities).toEqual(result.world.monetaryAuthorities);
    }

    // An entirely zero-capacity network must not produce paid foreign cargo,
    // move goods into transit or debit the shared FX pool. Local procurement
    // remains non-vacuously executable on the same opening WorldState.
    const noCapacity = withFactors(new Map(f.links.map(id => [id, 0] as const)));
    expect(noCapacity.phaseBoundaryError).toBeUndefined();
    expect(noCapacity.reconciliationErrors).toBeNull();
    expect(dispatched(noCapacity)).toHaveLength(0);
    expect(fxLegs(noCapacity)).toHaveLength(0);
    expect(tariffReceipts(noCapacity)).toHaveLength(0);
    expect(noCapacity.world.shipments?.size ?? 0).toBe(0);
    expect(noCapacity.context.transactions.filter(tx => tx.phase === 4))
      .toEqual(localReceipts);
    expect(noCapacity.world.monetaryAuthorities).toEqual(f.world.monetaryAuthorities);
    expect(totalIron(noCapacity.world)).toBeCloseTo(openingIron, 6);
    for (const [index, currency] of f.currencies.entries()) {
      expect(totalCash(noCapacity.world, currency)).toBeCloseTo(openingCash[index]!, 5);
    }
  });
});
