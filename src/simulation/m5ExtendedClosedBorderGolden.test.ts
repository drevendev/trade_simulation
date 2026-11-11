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
import { effectiveTransportLinkCapacity } from "./transportCapacity";
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
      const factors = new Map<TransportLinkId, number>(f.links.map(id =>
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
    const noCapacity = withFactors(new Map<TransportLinkId, number>(
      f.links.map(id => [id, 0] as const),
    ));
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

  it("halts both foreign routes at a finite FX pool's operational floor while keeping local trade", () => {
    const f = fixture();
    const funded = run(f, f.world);
    const phase4 = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx => tx.phase === 4);
    const phase7 = (result: ReturnType<typeof run>) =>
      result.context.transactions.filter(tx => tx.phase === 7);
    const dispatched = (result: ReturnType<typeof run>) =>
      phase7(result).filter(tx => tx.type === "SHIPMENT_DISPATCH");
    const fxLegs = (result: ReturnType<typeof run>) =>
      phase7(result).filter(tx => tx.type === "FX_INPUT" || tx.type === "FX_OUTPUT");
    const tariffs = (result: ReturnType<typeof run>) =>
      phase7(result).filter(tx => tx.type === "IMPORT_TARIFF");

    // Positive controls: both routes are legal, profitable and independently
    // funded, and local-market settlement actually occurs before Phase 7.
    expect(dispatched(funded)).toHaveLength(2);
    expect(fxLegs(funded)).toHaveLength(4);
    expect(tariffs(funded)).toHaveLength(2);
    expect(phase4(funded).length).toBeGreaterThan(0);

    // Keep all other world data and the currency pair unchanged. Both FX
    // reserves now equal their contractual floors, so neither seller-currency
    // payout can be authorized; no replacement/phantom FX pool is available.
    const monetaryAuthorities = new Map([...f.world.monetaryAuthorities].map(
      ([id, authority]) => [id, {
        ...authority,
        fxPools: new Map([...authority.fxPools].map(([poolId, pool]) => [
          poolId, poolId === f.chosen.poolId ? {
            ...pool,
            cash: new Map(pool.cash)
              .set(pool.baseCurrencyId, pool.minOperationalReserveBase)
              .set(pool.quoteCurrencyId, pool.minOperationalReserveQuote),
          } : pool,
        ] as const)),
      }] as const,
    ));
    const dryWorld: WorldState = { ...f.world, monetaryAuthorities };
    const openingIron = totalIron(dryWorld);
    const openingCash = f.currencies.map(currency => totalCash(dryWorld, currency));
    const blocked = run(f, dryWorld);
    const permuted = run(f, reordered(dryWorld));

    for (const result of [blocked, permuted]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(dispatched(result)).toHaveLength(0);
      expect(fxLegs(result)).toHaveLength(0);
      expect(tariffs(result)).toHaveLength(0);
      expect(result.world.shipments?.size ?? 0).toBe(0);
      expect(phase4(result)).toEqual(phase4(funded));
      expect(result.world.monetaryAuthorities).toEqual(dryWorld.monetaryAuthorities);
      expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
      for (const [index, currency] of f.currencies.entries()) {
        expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[index]!, 5);
      }
    }

    // Reverse-keyed registries must not change any payment, owned stock,
    // tariff outcome or next-tick state under the same exhausted FX pool.
    expect(permuted.context.transactions).toEqual(blocked.context.transactions);
    expect(permuted.world.productionUnits).toEqual(blocked.world.productionUnits);
    expect(permuted.world.monetaryAuthorities).toEqual(blocked.world.monetaryAuthorities);
    expect(permuted.world.shipments).toEqual(blocked.world.shipments);
    expect(permuted.world.markets).toEqual(blocked.world.markets);
  });


  it("sizes paid cargo across competing routes to one scarce FX payout budget before seller stock moves", () => {
    const f = fixture();
    const full = run(f, f.world);
    const originalCargo = [...(full.world.shipments?.values() ?? [])];
    const originalOutputs = full.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT");
    expect(originalCargo).toHaveLength(2);
    expect(originalOutputs).toHaveLength(2);
    expect(new Set(originalCargo.map(cargo => cargo.transportLinkId)))
      .toEqual(new Set(f.links));
    const sourceCurrency = originalCargo[0]!.invoiceCurrencyId;
    expect(originalCargo.every(cargo => cargo.invoiceCurrencyId === sourceCurrency)).toBe(true);
    expect(originalOutputs.every(tx => tx.currencyId === sourceCurrency &&
      tx.moneyAmount! > 0)).toBe(true);

    // This capacity is smaller than EITHER full invoice. Both paths remain
    // legal and physical; only a single issuer's actual payout stock changes.
    const available = Math.min(...originalOutputs.map(tx => tx.moneyAmount!)) / 4;
    expect(available).toBeGreaterThan(0);
    const authority = f.world.monetaryAuthorities.get(f.chosen.authorityId)!;
    const pool = authority.fxPools.get(f.chosen.poolId)!;
    const floor = sourceCurrency === pool.baseCurrencyId
      ? pool.minOperationalReserveBase : pool.minOperationalReserveQuote;
    const withAvailableOutput = (budget: number): WorldState => ({
      ...f.world,
      monetaryAuthorities: new Map(f.world.monetaryAuthorities).set(
        f.chosen.authorityId, {
          ...authority,
          fxPools: new Map(authority.fxPools).set(f.chosen.poolId, {
            ...pool,
            cash: new Map(pool.cash).set(sourceCurrency, floor + budget),
          }),
        },
      ),
    });
    const scarceOpening = withAvailableOutput(available);
    const scarce = run(f, scarceOpening);
    const shuffled = run(f, reordered(scarceOpening));
    const atFloor = run(f, withAvailableOutput(0));
    const openingCash = f.currencies.map(currency => totalCash(scarceOpening, currency));
    const openingIron = totalIron(scarceOpening);

    const phase7 = (result: ReturnType<typeof run>, type: string) =>
      result.context.transactions.filter(tx => tx.phase === 7 && tx.type === type);
    const cargos = [...(scarce.world.shipments?.values() ?? [])];
    const outputs = phase7(scarce, "FX_OUTPUT");
    const inputs = phase7(scarce, "FX_INPUT");
    const dispatches = phase7(scarce, "SHIPMENT_DISPATCH");
    const tariffs = phase7(scarce, "IMPORT_TARIFF");
    const originalByLink = new Map(originalCargo.map(cargo =>
      [cargo.transportLinkId, cargo] as const));
    expect(cargos.length).toBeGreaterThan(0); // scarcity must not be an all-blocked test
    expect(cargos.length).toBeLessThanOrEqual(2);
    expect(dispatches).toHaveLength(cargos.length);
    expect(outputs).toHaveLength(cargos.length);
    expect(inputs).toHaveLength(cargos.length);
    expect(tariffs).toHaveLength(cargos.length);
    expect(phase7(atFloor, "SHIPMENT_DISPATCH")).toHaveLength(0);

    for (const cargo of cargos) {
      expect(cargo.quantity).toBeGreaterThan(0);
      expect(cargo.quantity).toBeLessThan(originalByLink.get(cargo.transportLinkId)!.quantity);
      const paidDispatch = dispatches.filter(tx =>
        tx.quantity === cargo.quantity &&
        tx.sourceRegionId === cargo.originRegionId &&
        tx.destinationRegionId === cargo.destinationRegionId &&
        tx.source && JSON.stringify(tx.source) === JSON.stringify(cargo.seller) &&
        tx.destination && JSON.stringify(tx.destination) === JSON.stringify(cargo.beneficialOwner));
      expect(paidDispatch).toHaveLength(1);
      const bundleId = paidDispatch[0]!.bundleId;
      expect(outputs.filter(tx =>
        tx.bundleId === bundleId && tx.fxSettlementId === cargo.fxSettlementId))
        .toHaveLength(1);
      expect(inputs.filter(tx =>
        tx.bundleId === bundleId && tx.fxSettlementId === cargo.fxSettlementId))
        .toHaveLength(1);
    }

    const sourcePaid = outputs.reduce((sum, tx) => sum + tx.moneyAmount!, 0);
    const buyerPaid = inputs.reduce((sum, tx) => sum + tx.moneyAmount!, 0);
    expect(sourcePaid).toBeGreaterThan(0);
    expect(sourcePaid).toBeLessThanOrEqual(available + 1e-6);
    const beforePool = scarceOpening.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;
    const afterPool = scarce.world.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;
    const buyerCurrency = f.currencies.find(id => id !== sourceCurrency)!;
    const verifyPayout = (amount: number) =>
      expect(afterPool.cash.get(sourceCurrency)! - beforePool.cash.get(sourceCurrency)!)
        .toBeCloseTo(-amount, 6);
    verifyPayout(sourcePaid);
    expect(() => verifyPayout(sourcePaid + 1)).toThrow();
    expect(afterPool.cash.get(sourceCurrency)!).toBeGreaterThanOrEqual(floor);
    expect(afterPool.cash.get(buyerCurrency)! - beforePool.cash.get(buyerCurrency)!)
      .toBeCloseTo(buyerPaid, 6);

    // Isolate the seller's foreign debit by subtracting an otherwise identical
    // local-only tick at the reserve floor. No unpaid foreign stock may vanish.
    const seller = originalCargo[0]!.seller;
    expect(seller.type).toBe("PRODUCTION_UNIT");
    expect(new Set(originalCargo.map(cargo => JSON.stringify(cargo.seller))).size).toBe(1);
    if (seller.type !== "PRODUCTION_UNIT") throw new Error("Expected production seller");
    const atFloorStock = atFloor.world.productionUnits.get(seller.productionUnitId)!
      .inputInventory.get(IRON) ?? 0;
    const scarceStock = scarce.world.productionUnits.get(seller.productionUnitId)!
      .inputInventory.get(IRON) ?? 0;
    expect(atFloorStock - scarceStock)
      .toBeCloseTo(cargos.reduce((sum, cargo) => sum + cargo.quantity, 0), 6);
    expect(scarce.context.transactions.filter(tx => tx.phase === 4))
      .toEqual(atFloor.context.transactions.filter(tx => tx.phase === 4));

    for (const result of [scarce, shuffled]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
      for (const [index, currency] of f.currencies.entries()) {
        expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[index]!, 5);
      }
    }
    expect(shuffled.context.transactions).toEqual(scarce.context.transactions);
    expect(shuffled.world.productionUnits).toEqual(scarce.world.productionUnits);
    expect(shuffled.world.monetaryAuthorities).toEqual(scarce.world.monetaryAuthorities);
    expect(shuffled.world.shipments).toEqual(scarce.world.shipments);
  });

  it("delivers staggered paid corridors independently after closure, without a second FX debit", () => {
    const f = fixture();
    const fastLink = f.links[0]!;
    const slowLink = f.links[1]!;
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) => [
        id, { ...link, travelTicks: id === fastLink ? 1 : 4 },
      ] as const)),
    };
    const openingIron = totalIron(opening);
    const openingCash = f.currencies.map(currency => totalCash(opening, currency));
    let world = opening;
    let reverseWorld = reordered(opening);
    let frozenCargo = [...(opening.shipments?.values() ?? [])];
    const deliveredIds = new Set<string>();
    let verifiedOwnerCredits = 0;

    const assertDue = (
      deliveries: ReturnType<typeof run>["context"]["transactions"],
      due: typeof frozenCargo,
    ) => {
      expect(deliveries).toHaveLength(due.length);
      for (const cargo of due) {
        const matching = deliveries.filter(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
        expect(matching).toHaveLength(1);
        expect(matching[0]).toMatchObject({
          tick: cargo.arrivalTick,
          phase: 1,
          goodId: cargo.goodId,
          quantity: cargo.quantity,
          sourceRegionId: cargo.originRegionId,
          destinationRegionId: cargo.destinationRegionId,
          destination: cargo.beneficialOwner,
        });
        expect(matching[0]!.moneyAmount).toBeUndefined();
      }
    };

    for (let tick = 7; tick <= 13; tick++) {
      const observer: Parameters<typeof executeM5AutonomousRegionalTradeTick>[5] =
        (phase, before, after) => {
          if (phase !== 1 || tick === 7) return;
          for (const cargo of frozenCargo.filter(c => c.arrivalTick === tick)) {
            expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
            if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
              throw new Error("Expected ProductionUnit cargo beneficiary");
            }
            const id = cargo.beneficialOwner.productionUnitId;
            const stockBefore = before.productionUnits.get(id)!.inputInventory.get(cargo.goodId) ?? 0;
            const stockAfter = after.productionUnits.get(id)!.inputInventory.get(cargo.goodId) ?? 0;
            expect(stockAfter - stockBefore).toBeCloseTo(cargo.quantity, 8);
            verifiedOwnerCredits++;
          }
        };
      const normal = run(f, world, tick === 7, tick, observer);
      const reversed = run(f, reverseWorld, tick === 7, tick);
      for (const result of [normal, reversed]) {
        expect(result.phaseTrace).toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
        expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
        for (const [index, currency] of f.currencies.entries()) {
          expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[index]!, 5);
        }
      }
      expect(reversed.context.transactions).toEqual(normal.context.transactions);
      expect(reversed.world.productionUnits).toEqual(normal.world.productionUnits);
      expect(reversed.world.shipments).toEqual(normal.world.shipments);
      expect(reversed.world.monetaryAuthorities).toEqual(normal.world.monetaryAuthorities);
      expect(reversed.world.markets).toEqual(normal.world.markets);
      expect(reversed.world.states).toEqual(normal.world.states);

      const phase7 = normal.context.transactions.filter(tx => tx.phase === 7);
      if (tick === 7) {
        frozenCargo = [...(normal.world.shipments?.values() ?? [])].map(c => ({ ...c }));
        expect(frozenCargo).toHaveLength(2);
        expect(new Map(frozenCargo.map(c => [c.transportLinkId, c.arrivalTick])))
          .toEqual(new Map([[fastLink, 8], [slowLink, 11]]));
        for (const type of ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"]) {
          expect(phase7.filter(tx => tx.type === type)).toHaveLength(2);
        }
      } else {
        for (const type of ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"]) {
          expect(phase7.filter(tx => tx.type === type)).toHaveLength(0);
        }
      }

      const due = frozenCargo.filter(cargo => cargo.arrivalTick === tick);
      const deliveries = normal.context.transactions.filter(tx =>
        tx.type === "SHIPMENT_DELIVERY");
      assertDue(deliveries, due);
      if (due.length > 0) {
        const altered = deliveries.map((tx, index) => index === 0
          ? { ...tx, quantity: tx.quantity! + 1 } : tx);
        expect(() => assertDue(altered, due)).toThrow();
      }
      for (const cargo of due) {
        expect(deliveredIds.has(cargo.id)).toBe(false);
        deliveredIds.add(cargo.id);
      }
      expect(normal.world.shipments?.size ?? 0)
        .toBe(frozenCargo.filter(cargo => cargo.arrivalTick > tick).length);
      world = normal.world;
      reverseWorld = reversed.world;
    }

    expect(verifiedOwnerCredits).toBe(2);
    expect(deliveredIds).toEqual(new Set(frozenCargo.map(c => c.id)));
    expect(world.shipments?.size ?? 0).toBe(0);
  });

  it("shrinks only the physically constrained foreign corridor before paid dispatch", () => {
    const f = fixture();
    const unrestricted = run(f, f.world);
    const initialCargo = [...(unrestricted.world.shipments?.values() ?? [])];
    expect(initialCargo).toHaveLength(2);
    const restrictedLink = f.links[0]!;
    const unrestrictedLink = f.links[1]!;
    const initialRestricted = initialCargo.find(c => c.transportLinkId === restrictedLink)!;
    const initialOther = initialCargo.find(c => c.transportLinkId === unrestrictedLink)!;
    expect(initialRestricted).toBeDefined();
    expect(initialOther).toBeDefined();
    const originalLink = f.world.transportLinks.get(restrictedLink)!;
    expect(originalLink.seed.condition).toBeGreaterThan(0);
    const ironWeight = baselineDefinitionPack.goods[IRON]!.cargoWeightPerUnit;
    const physicalLimit = initialRestricted.quantity * ironWeight / 4;
    expect(physicalLimit).toBeGreaterThan(0);

    // Reduce only one link's physical cargo-weight budget, not its legality,
    // FX reserves, seller stock, destination cash or the competing corridor.
    const restrictedWorld: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) => [
        id, id === restrictedLink ? {
          ...link,
          seed: { ...link.seed, baseCapacity: physicalLimit / link.seed.condition },
        } : link,
      ] as const)),
    };
    const measuredCapacity = effectiveTransportLinkCapacity(
      restrictedWorld.transportLinks.get(restrictedLink)!, 1,
    );
    expect(measuredCapacity).toBeCloseTo(physicalLimit, 10);
    const normal = run(f, restrictedWorld);
    const shuffled = run(f, reordered(restrictedWorld));
    const cargo = [...(normal.world.shipments?.values() ?? [])];
    expect(cargo).toHaveLength(2); // neither route is spuriously disabled
    expect(new Set(cargo.map(c => c.transportLinkId))).toEqual(new Set(f.links));
    const restrictedCargo = cargo.find(c => c.transportLinkId === restrictedLink)!;
    const otherCargo = cargo.find(c => c.transportLinkId === unrestrictedLink)!;
    const assertPhysicalBudget = (quantity: number) =>
      expect(quantity * ironWeight).toBeLessThanOrEqual(measuredCapacity + 1e-8);
    assertPhysicalBudget(restrictedCargo.quantity);
    expect(restrictedCargo.quantity).toBeGreaterThan(0);
    expect(restrictedCargo.quantity).toBeLessThan(initialRestricted.quantity);
    expect(otherCargo.quantity).toBeCloseTo(initialOther.quantity, 8);
    expect(() => assertPhysicalBudget(initialRestricted.quantity)).toThrow();

    for (const result of [normal, shuffled]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      const phase7 = result.context.transactions.filter(tx => tx.phase === 7);
      for (const type of ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"]) {
        expect(phase7.filter(tx => tx.type === type)).toHaveLength(2);
      }
      expect(result.context.transactions.filter(tx => tx.phase === 4))
        .toEqual(unrestricted.context.transactions.filter(tx => tx.phase === 4));
      expect(totalIron(result.world)).toBeCloseTo(totalIron(restrictedWorld), 6);
      for (const currency of f.currencies) {
        expect(totalCash(result.world, currency))
          .toBeCloseTo(totalCash(restrictedWorld, currency), 5);
      }
    }
    expect(shuffled.context.transactions).toEqual(normal.context.transactions);
    expect(shuffled.world.shipments).toEqual(normal.world.shipments);
    expect(shuffled.world.productionUnits).toEqual(normal.world.productionUnits);
    expect(shuffled.world.monetaryAuthorities).toEqual(normal.world.monetaryAuthorities);
  });


  it("reconciles paid FX principals and corridor charges to live wallets before staggered delivery", () => {
    const f = fixture();
    const [fast, slow] = f.links;
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) =>
        [id, { ...link, travelTicks: id === fast ? 1 : 3 }] as const)),
    };
    const openingIron = totalIron(opening);
    const openingCash = f.currencies.map(currency => totalCash(opening, currency));
    let normalWorld = opening;
    let shuffledWorld = reordered(opening);
    let frozenCargo = [...(opening.shipments?.values() ?? [])];

    for (let tick = 7; tick <= 12; tick++) {
      const phase7Snapshots: { before: WorldState; after: WorldState }[] = [];
      const observe: Parameters<typeof executeM5AutonomousRegionalTradeTick>[5] =
        (phase, before, after) => {
          if (phase === 7) phase7Snapshots.push({ before, after });
        };
      const result = run(f, normalWorld, tick === 7, tick, observe);
      const shuffled = run(f, shuffledWorld, tick === 7, tick);
      expect(phase7Snapshots).toHaveLength(1);
      for (const actual of [result, shuffled]) {
        expect(actual.phaseTrace).toEqual([...Array(16).keys()]);
        expect(actual.phaseBoundaryError).toBeUndefined();
        expect(actual.reconciliationErrors).toBeNull();
        expect(totalIron(actual.world)).toBeCloseTo(openingIron, 6);
        for (const [index, currency] of f.currencies.entries()) {
          expect(totalCash(actual.world, currency)).toBeCloseTo(openingCash[index]!, 5);
        }
      }
      expect(shuffled.context.transactions).toEqual(result.context.transactions);
      expect(shuffled.world.shipments).toEqual(result.world.shipments);
      expect(shuffled.world.productionUnits).toEqual(result.world.productionUnits);
      expect(shuffled.world.monetaryAuthorities).toEqual(result.world.monetaryAuthorities);
      expect(shuffled.world.states).toEqual(result.world.states);

      const { before, after } = phase7Snapshots[0]!;
      const phase7 = result.context.transactions.filter(tx => tx.phase === 7);
      const paymentTypes = ["FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF",
        "CONSUMPTION_TAX", "TRANSPORT_FEE"];
      if (tick === 7) {
        frozenCargo = [...(result.world.shipments?.values() ?? [])];
        expect(frozenCargo).toHaveLength(2);
        expect(new Set(frozenCargo.map(cargo => cargo.transportLinkId)))
          .toEqual(new Set([fast, slow]));
        expect(new Set(frozenCargo.map(cargo => cargo.fxSettlementId)).size).toBe(2);
        const bundleIds = new Set<string>();

        // Each physical corridor must carry one and only one invoice, FX pair
        // and destination charge set. The invoice is NONPOSTING: only FX legs
        // and actual destination charges may change wallets.
        const verifyCorridor = (
          journal: typeof phase7, cargo: (typeof frozenCargo)[number],
        ) => {
          const matching = journal.filter(tx =>
            tx.type === "SHIPMENT_DISPATCH" &&
            tx.sourceRegionId === cargo.originRegionId &&
            tx.destinationRegionId === cargo.destinationRegionId &&
            tx.goodId === cargo.goodId &&
            tx.quantity === cargo.quantity);
          expect(matching).toHaveLength(1);
          const bundleId = matching[0]!.bundleId!;
          expect(bundleId).toBeDefined();
          const one = (type: string) => {
            const entries = journal.filter(tx =>
              tx.bundleId === bundleId && tx.type === type);
            expect(entries).toHaveLength(1);
            return entries[0]!;
          };
          // A frozen Phase-1 destination controller, not a journal entry or
          // a cargo-reported tax recipient, owns these public receipts.
          const importingRegion = opening.regions.get(cargo.destinationRegionId);
          expect(importingRegion).toBeDefined();
          const importerStateId = importingRegion!.controllerStateId;
          expect(importerStateId).not.toBeNull();
          const legalTreasury = { type: "STATE" as const, stateId: importerStateId! };
          const linkFeeRecipient = opening.transportLinks.get(cargo.transportLinkId)?.feeReceiver;
          const charge = (type: string, amount: number) => {
            const entries = journal.filter(tx =>
              tx.bundleId === bundleId && tx.type === type);
            expect(entries).toHaveLength(amount > 0 ? 1 : 0);
            expect(entries.reduce((sum, tx) => sum + tx.moneyAmount!, 0))
              .toBeCloseTo(amount, 6);
            if (entries.length > 0) {
              expect(entries[0]!.currencyId).toBe(cargo.buyerPaymentCurrencyId);
              expect(entries[0]!.source).toEqual(cargo.beneficialOwner);
              expect(entries[0]!.destination).toEqual(
                type === "TRANSPORT_FEE" ? linkFeeRecipient : legalTreasury,
              );
            }
          };
          const invoice = one("TRADE_GOODS_SALE");
          const input = one("FX_INPUT");
          const output = one("FX_OUTPUT");
          expect(invoice.reason).toBe("PHASE7_FX_INVOICE_REFERENCE_NONPOSTING");
          expect(invoice.fxSettlementId).toBe(cargo.fxSettlementId);
          expect(input.fxSettlementId).toBe(cargo.fxSettlementId);
          expect(output.fxSettlementId).toBe(cargo.fxSettlementId);
          expect(invoice.moneyAmount).toBeCloseTo(output.moneyAmount!, 6);
          expect(invoice.moneyAmount).toBeCloseTo(
            cargo.sellerNetUnitPrice * cargo.quantity, 6);
          expect(input.moneyAmount).toBeCloseTo(cargo.buyerGoodsPaymentAmount, 6);
          expect(input.currencyId).toBe(cargo.buyerPaymentCurrencyId);
          expect(output.currencyId).toBe(cargo.invoiceCurrencyId);
          expect(input.source).toEqual(cargo.beneficialOwner);
          expect(output.destination).toEqual(cargo.seller);
          charge("TRANSPORT_FEE", cargo.transportFeeAmount);
          charge("IMPORT_TARIFF", cargo.tariffAmount);
          charge("CONSUMPTION_TAX", cargo.consumptionTaxAmount);
          return bundleId;
        };
        for (const cargo of frozenCargo) {
          const bundleId = verifyCorridor(phase7, cargo);
          expect(bundleIds.has(bundleId)).toBe(false);
          bundleIds.add(bundleId);
        }

        // Sensitive negative controls: moving a tariff to the wrong route or
        // inflating one FX leg must fail the same corridor-level oracle.
        const first = frozenCargo[0]!;
        const otherBundle = [...bundleIds].find(id =>
          id !== phase7.find(tx => tx.type === "SHIPMENT_DISPATCH" &&
            tx.destinationRegionId === first.destinationRegionId)!.bundleId)!;
        const wrongTariff = phase7.map(tx =>
          tx.type === "IMPORT_TARIFF" && tx.destinationRegionId === first.destinationRegionId
            ? { ...tx, bundleId: otherBundle as NonNullable<typeof tx.bundleId> } : tx);
        expect(() => verifyCorridor(wrongTariff, first)).toThrow();
        const inflatedFx = phase7.map(tx =>
          tx.type === "FX_INPUT" && tx.fxSettlementId === first.fxSettlementId
            ? { ...tx, moneyAmount: tx.moneyAmount! + 1 } : tx);
        expect(() => verifyCorridor(inflatedFx, first)).toThrow();
        const originState = opening.regions.get(first.originRegionId)!.controllerStateId;
        const destinationState = opening.regions.get(first.destinationRegionId)!.controllerStateId;
        expect(originState).not.toBeNull();
        expect(originState).not.toBe(destinationState);
        const firstBundleId = phase7.find(tx =>
          tx.type === "SHIPMENT_DISPATCH" &&
          tx.destinationRegionId === first.destinationRegionId)!.bundleId;
        for (const type of ["IMPORT_TARIFF", "CONSUMPTION_TAX"] as const) {
          // A journal can still balance if a public charge is diverted to the
          // wrong State. Both independently authorized recipients must be checked.
          const diverted = phase7.map(tx =>
            tx.bundleId === firstBundleId && tx.type === type
              ? { ...tx, destination: { type: "STATE" as const, stateId: originState! } }
              : tx);
          expect(diverted).not.toEqual(phase7);
          expect(() => verifyCorridor(diverted, first)).toThrow();
        }

        const inputs = phase7.filter(tx => tx.type === "FX_INPUT");
        const outputs = phase7.filter(tx => tx.type === "FX_OUTPUT");
        expect(inputs).toHaveLength(2);
        expect(outputs).toHaveLength(2);
        const beforePool = before.monetaryAuthorities.get(f.chosen.authorityId)!
          .fxPools.get(f.chosen.poolId)!;
        const afterPool = after.monetaryAuthorities.get(f.chosen.authorityId)!
          .fxPools.get(f.chosen.poolId)!;
        for (const currency of f.currencies) {
          const expectedDelta = inputs.filter(tx => tx.currencyId === currency)
            .reduce((sum, tx) => sum + tx.moneyAmount!, 0) -
            outputs.filter(tx => tx.currencyId === currency)
              .reduce((sum, tx) => sum + tx.moneyAmount!, 0);
          expect((afterPool.cash.get(currency) ?? 0) - (beforePool.cash.get(currency) ?? 0))
            .toBeCloseTo(expectedDelta, 6);
        }

        // Compare the actual Phase-7 snapshots, excluding Phase-4 local
        // trading and Phase-5 payroll, so only these two settled corridors
        // explain the observed buyer debits, seller credit and State receipts.
        const seller = frozenCargo[0]!.seller;
        expect(seller.type).toBe("PRODUCTION_UNIT");
        expect(frozenCargo.every(cargo =>
          JSON.stringify(cargo.seller) === JSON.stringify(seller))).toBe(true);
        if (seller.type !== "PRODUCTION_UNIT") throw new Error("Expected production seller");
        const invoiceCurrency = frozenCargo[0]!.invoiceCurrencyId;
        const sellerBefore = before.productionUnits.get(seller.productionUnitId)!
          .wallet.get(invoiceCurrency) ?? 0;
        const sellerAfter = after.productionUnits.get(seller.productionUnitId)!
          .wallet.get(invoiceCurrency) ?? 0;
        expect(sellerAfter - sellerBefore).toBeCloseTo(
          outputs.reduce((sum, tx) => sum + tx.moneyAmount!, 0), 6);
        const buyerIds = new Set<string>();
        for (const cargo of frozenCargo) {
          expect(cargo.beneficialOwner.type).toBe("PRODUCTION_UNIT");
          if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
            throw new Error("Expected production buyer");
          }
          const buyerId = cargo.beneficialOwner.productionUnitId;
          expect(buyerIds.has(buyerId)).toBe(false);
          buyerIds.add(buyerId);
          const from = before.productionUnits.get(buyerId)!
            .wallet.get(cargo.buyerPaymentCurrencyId) ?? 0;
          const to = after.productionUnits.get(buyerId)!
            .wallet.get(cargo.buyerPaymentCurrencyId) ?? 0;
          const expectedDebit = cargo.buyerGoodsPaymentAmount +
            cargo.transportFeeAmount + cargo.tariffAmount + cargo.consumptionTaxAmount;
          expect(from - to).toBeCloseTo(expectedDebit, 6);
        }
        for (const [stateId, state] of before.states) {
          for (const currency of f.currencies) {
            // This oracle is independent from the journal's destination
            // claims: even a consistently misrouted but balanced tax posting
            // must fail against the frozen legal importer and link fee owner.
            const expectedReceipts = frozenCargo.reduce((sum, cargo) => {
              if (cargo.buyerPaymentCurrencyId !== currency) return sum;
              const controller = opening.regions.get(cargo.destinationRegionId)!.controllerStateId;
              const feeOwner = opening.transportLinks.get(cargo.transportLinkId)!.feeReceiver;
              return sum +
                (controller === stateId
                  ? cargo.tariffAmount + cargo.consumptionTaxAmount : 0) +
                (feeOwner?.type === "STATE" && feeOwner.stateId === stateId
                  ? cargo.transportFeeAmount : 0);
            }, 0);
            const beforeCash = state.treasury.get(currency) ?? 0;
            const afterCash = after.states.get(stateId)!.treasury.get(currency) ?? 0;
            expect(afterCash - beforeCash).toBeCloseTo(expectedReceipts, 6);
          }
        }
      } else {
        // Delivery and closed borders must not replay dispatch FX or tariffs.
        expect(phase7.filter(tx => paymentTypes.includes(tx.type) ||
          tx.type === "TRADE_GOODS_SALE" || tx.type === "SHIPMENT_DISPATCH"))
          .toHaveLength(0);
        expect(after.monetaryAuthorities).toEqual(before.monetaryAuthorities);
      }
      const due = frozenCargo.filter(cargo => cargo.arrivalTick === tick);
      const deliveries = result.context.transactions.filter(tx =>
        tx.type === "SHIPMENT_DELIVERY");
      expect(deliveries).toHaveLength(due.length);
      for (const cargo of due) {
        const receipt = deliveries.find(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
        expect(receipt).toMatchObject({
          tick, phase: 1, goodId: cargo.goodId, quantity: cargo.quantity,
          destination: cargo.beneficialOwner,
        });
        expect(receipt?.moneyAmount).toBeUndefined();
      }
      expect(result.world.shipments?.size ?? 0)
        .toBe(frozenCargo.filter(cargo => cargo.arrivalTick > tick).length);
      normalWorld = result.world;
      shuffledWorld = shuffled.world;
    }
    expect(normalWorld.shipments?.size ?? 0).toBe(0);
  });


});
