/**
 * Issue #676 / REQ-ACCEPTANCE-006: extended real-orchestrator regression.
 * Two independently funded international routes dispatch paid goods before a
 * persistent border closure. Compare every one of 16 consecutive ticks with
 * the same opening economy constructed in reverse keyed-registry order.
 * The full acceptance gate remains PARTIAL; this does not invent economics.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import type { PhaseHandler } from "./tickOrchestrator";
import { effectiveTransportLinkCapacity } from "./transportCapacity";
import { phase7ImportTariffKey } from "./phase7LiveWorldPlan";
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

/**
 * Test-only content-sensitive economic replay fingerprint, NOT the canonical
 * run identity. Sort unordered keyed registries recursively, while preserving
 * transaction sequence and genuinely ordered route collections.
 *
 * Hashing the actual stock and receipt contents catches a drift that comparing
 * only tick numbers or transaction counts would silently miss.
 */
function economicReplayFingerprint(
  tick: number,
  world: WorldState,
  transactions: ReturnType<typeof run>["context"]["transactions"],
): string {
  const normalize = (value: unknown): unknown => {
    if (value instanceof Map) {
      return [...value].sort(([a], [b]) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      ).map(([key, entry]) => [key, normalize(entry)]);
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return value;
  };
  const economic = {
    tick,
    transactions,
    regions: world.regions,
    states: world.states,
    clans: world.clans,
    cohorts: world.cohorts,
    productionUnits: world.productionUnits,
    markets: world.markets,
    monetaryAuthorities: world.monetaryAuthorities,
    transportLinks: world.transportLinks,
    shipments: world.shipments,
    pendingTransitions: world.pendingTransitions,
  };
  return createHash("sha256").update(JSON.stringify(normalize(economic))).digest("hex");
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
      const fingerprint = economicReplayFingerprint(tick, normal.world, normal.context.transactions);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(economicReplayFingerprint(tick, reversed.world, reversed.context.transactions))
        .toBe(fingerprint);

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
        // Both controls preserve tick and transaction count. A timestamp-
        // or count-only hash would miss a forged payment or shifted live cash.
        const forgedPayment = normal.context.transactions.map(tx =>
          tx === paidOutputs[0]
            ? { ...tx, moneyAmount: tx.moneyAmount! + 1 } : tx);
        expect(forgedPayment).not.toEqual(normal.context.transactions);
        expect(economicReplayFingerprint(tick, normal.world, forgedPayment))
          .not.toBe(fingerprint);
        const firstUnit = [...normal.world.productionUnits.values()][0]!;
        const walletCurrency = [...firstUnit.wallet.keys()][0]!;
        const changedWorld: WorldState = {
          ...normal.world,
          productionUnits: new Map(normal.world.productionUnits).set(
            firstUnit.productionUnitId, {
              ...firstUnit,
              wallet: new Map(firstUnit.wallet)
                .set(walletCurrency, firstUnit.wallet.get(walletCurrency)! + 1),
            },
          ),
        };
        expect(economicReplayFingerprint(tick, changedWorld, normal.context.transactions))
          .not.toBe(fingerprint);
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


  it("settles a cross-currency route's transport fee to its private Cohort owner, not a treasury", () => {
    const f = fixture();
    const privateLinkId = f.links[0]!;
    const privateLink = f.world.transportLinks.get(privateLinkId)!;
    const sourceRegion = f.world.regions.get(privateLink.fromRegionId)!;
    const feeCohort = [...f.world.cohorts.values()].find(cohort =>
      cohort.seed.regionKey === sourceRegion.seed.key);
    expect(feeCohort).toBeDefined();
    const privateReceiver = { type: "COHORT" as const, cohortId: feeCohort!.cohortId };
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) =>
        [id, id === privateLinkId ? { ...link, feeReceiver: privateReceiver } : link] as const)),
    };
    const remainingLink = opening.transportLinks.get(f.links[1]!)!;
    expect(remainingLink.feeReceiver?.type).toBe("STATE");

    const snapshots: { before: WorldState; after: WorldState }[] = [];
    const normal = run(f, opening, true, 7, (phase, before, after) => {
      if (phase === 7) snapshots.push({ before, after });
    });
    const shuffled = run(f, reordered(opening));
    expect(snapshots).toHaveLength(1);
    for (const result of [normal, shuffled]) {
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(totalIron(result.world)).toBeCloseTo(totalIron(opening), 6);
      for (const currency of f.currencies) {
        expect(totalCash(result.world, currency)).toBeCloseTo(totalCash(opening, currency), 5);
      }
    }
    expect(shuffled.context.transactions).toEqual(normal.context.transactions);
    expect(shuffled.world.cohorts).toEqual(normal.world.cohorts);
    expect(shuffled.world.states).toEqual(normal.world.states);
    expect(shuffled.world.shipments).toEqual(normal.world.shipments);
    expect(shuffled.world.monetaryAuthorities).toEqual(normal.world.monetaryAuthorities);

    const cargos = [...(normal.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(2);
    expect(new Set(cargos.map(cargo => cargo.transportLinkId))).toEqual(new Set(f.links));
    const privateCargo = cargos.find(cargo => cargo.transportLinkId === privateLinkId)!;
    expect(privateCargo.transportFeeAmount).toBeGreaterThan(0);
    expect(cargos.find(cargo => cargo.transportLinkId !== privateLinkId)!.transportFeeAmount)
      .toBeGreaterThan(0);
    const phase7 = normal.context.transactions.filter(tx => tx.phase === 7);
    const dispatch = phase7.filter(tx =>
      tx.type === "SHIPMENT_DISPATCH" &&
      tx.destinationRegionId === privateCargo.destinationRegionId &&
      tx.sourceRegionId === privateCargo.originRegionId);
    expect(dispatch).toHaveLength(1);
    const privateBundleId = dispatch[0]!.bundleId;
    expect(privateBundleId).toBeDefined();
    const verifyPrivateFee = (journal: typeof phase7) => {
      const entries = journal.filter(tx => tx.type === "TRANSPORT_FEE" &&
        tx.bundleId === privateBundleId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.destination).toEqual(privateReceiver);
      expect(entries[0]!.source).toEqual(privateCargo.beneficialOwner);
      expect(entries[0]!.currencyId).toBe(privateCargo.buyerPaymentCurrencyId);
      expect(entries[0]!.moneyAmount).toBeCloseTo(privateCargo.transportFeeAmount, 6);
    };
    verifyPrivateFee(phase7);

    // A financially balanced journal can send the correct amount to the wrong
    // recipient. The independent link owner must reject that misdirection.
    const importerStateId = opening.regions.get(privateCargo.destinationRegionId)!
      .controllerStateId!;
    const diverted = phase7.map(tx =>
      tx.type === "TRANSPORT_FEE" && tx.bundleId === privateBundleId
        ? { ...tx, destination: { type: "STATE" as const, stateId: importerStateId } }
        : tx);
    expect(diverted).not.toEqual(phase7);
    expect(() => verifyPrivateFee(diverted)).toThrow();

    const { before, after } = snapshots[0]!;
    const buyerCurrency = privateCargo.buyerPaymentCurrencyId;
    const beforePrivate = before.cohorts.get(privateReceiver.cohortId)!.wallet.get(buyerCurrency) ?? 0;
    const afterPrivate = after.cohorts.get(privateReceiver.cohortId)!.wallet.get(buyerCurrency) ?? 0;
    const verifyPrivateWallet = (expected: number) =>
      expect(afterPrivate - beforePrivate).toBeCloseTo(expected, 6);
    verifyPrivateWallet(privateCargo.transportFeeAmount);
    expect(() => verifyPrivateWallet(privateCargo.transportFeeAmount + 1)).toThrow();

    // Derive legal public receipts from opening jurisdictions and links, never
    // from journal destinations. Only the other route's fee belongs to a State.
    for (const [stateId, state] of before.states) {
      for (const currency of f.currencies) {
        const expected = cargos.reduce((sum, cargo) => {
          if (cargo.buyerPaymentCurrencyId !== currency) return sum;
          const importer = opening.regions.get(cargo.destinationRegionId)!.controllerStateId;
          const receiver = opening.transportLinks.get(cargo.transportLinkId)!.feeReceiver;
          return sum + (importer === stateId
            ? cargo.tariffAmount + cargo.consumptionTaxAmount : 0) +
            (receiver?.type === "STATE" && receiver.stateId === stateId
              ? cargo.transportFeeAmount : 0);
        }, 0);
        const actual = (after.states.get(stateId)!.treasury.get(currency) ?? 0) -
          (state.treasury.get(currency) ?? 0);
        expect(actual).toBeCloseTo(expected, 6);
      }
    }
  });

  it("credits a Clan-owned cross-currency corridor fee without diverting public tax receipts", () => {
    const f = fixture();
    const linkId = f.links[0]!;
    const link = f.world.transportLinks.get(linkId)!;
    const clan = [...f.world.clans.values()][0]!;
    expect(clan).toBeDefined();
    const feeOwner = { type: "CLAN" as const, clanId: clan.clanId };
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map(f.world.transportLinks).set(linkId, {
        ...link, feeReceiver: feeOwner,
      }),
    };
    const snapshots: { before: WorldState; after: WorldState }[] = [];
    const settled = run(f, opening, true, 7, (phase, before, after) => {
      if (phase === 7) snapshots.push({ before, after });
    });
    const reversed = run(f, reordered(opening));
    expect(snapshots).toHaveLength(1);
    for (const result of [settled, reversed]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(totalIron(result.world)).toBeCloseTo(totalIron(opening), 6);
      for (const currency of f.currencies) {
        expect(totalCash(result.world, currency))
          .toBeCloseTo(totalCash(opening, currency), 5);
      }
    }
    expect(reversed.context.transactions).toEqual(settled.context.transactions);
    expect(reversed.world.clans).toEqual(settled.world.clans);
    expect(reversed.world.states).toEqual(settled.world.states);
    expect(reversed.world.shipments).toEqual(settled.world.shipments);

    const cargos = [...(settled.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(2);
    const privateCargo = cargos.find(cargo => cargo.transportLinkId === linkId)!;
    expect(privateCargo).toBeDefined();
    expect(privateCargo.transportFeeAmount).toBeGreaterThan(0);
    const dispatch = settled.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH" &&
      tx.sourceRegionId === privateCargo.originRegionId &&
      tx.destinationRegionId === privateCargo.destinationRegionId);
    expect(dispatch).toHaveLength(1);
    const bundle = dispatch[0]!.bundleId;
    expect(bundle).toBeDefined();

    const { before, after } = snapshots[0]!;
    const audit = (
      finalWorld: WorldState,
      journal: typeof settled.context.transactions,
    ) => {
      const fees = journal.filter(tx =>
        tx.phase === 7 && tx.type === "TRANSPORT_FEE" && tx.bundleId === bundle);
      expect(fees).toHaveLength(1);
      expect(fees[0]).toMatchObject({
        source: privateCargo.beneficialOwner, destination: feeOwner,
        currencyId: privateCargo.buyerPaymentCurrencyId,
      });
      expect(fees[0]!.moneyAmount).toBeCloseTo(privateCargo.transportFeeAmount, 6);
      for (const currency of f.currencies) {
        const clanBefore = before.clans.get(clan.clanId)!.treasury.get(currency) ?? 0;
        const clanAfter = finalWorld.clans.get(clan.clanId)!.treasury.get(currency) ?? 0;
        const expected = currency === privateCargo.buyerPaymentCurrencyId
          ? privateCargo.transportFeeAmount : 0;
        expect(clanAfter - clanBefore).toBeCloseTo(expected, 6);
      }
      // Taxes follow the importer, but transport fees follow the configured
      // live owner, even when that owner is not a State or local to the route.
      for (const [stateId, state] of before.states) {
        for (const currency of f.currencies) {
          const expected = cargos.reduce((sum, cargo) => {
            if (cargo.buyerPaymentCurrencyId !== currency) return sum;
            const importer = opening.regions.get(cargo.destinationRegionId)!.controllerStateId;
            const receiver = opening.transportLinks.get(cargo.transportLinkId)!.feeReceiver;
            return sum + (importer === stateId
              ? cargo.tariffAmount + cargo.consumptionTaxAmount : 0) +
              (receiver?.type === "STATE" && receiver.stateId === stateId
                ? cargo.transportFeeAmount : 0);
          }, 0);
          const actual = (finalWorld.states.get(stateId)!.treasury.get(currency) ?? 0) -
            (state.treasury.get(currency) ?? 0);
          expect(actual).toBeCloseTo(expected, 6);
        }
      }
    };
    audit(after, settled.context.transactions);

    // A balanced but misdirected fee receipt and a money-conserving wallet
    // diversion must BOTH fail this owner-based oracle.
    const importerStateId = opening.regions.get(privateCargo.destinationRegionId)!
      .controllerStateId!;
    const forgedJournal = settled.context.transactions.map(tx =>
      tx.phase === 7 && tx.type === "TRANSPORT_FEE" && tx.bundleId === bundle
        ? { ...tx, destination: { type: "STATE" as const, stateId: importerStateId } }
        : tx);
    expect(() => audit(after, forgedJournal)).toThrow();

    const currency = privateCargo.buyerPaymentCurrencyId;
    const afterClan = after.clans.get(clan.clanId)!;
    const afterImporter = after.states.get(importerStateId)!;
    const forgedWorld: WorldState = {
      ...after,
      clans: new Map(after.clans).set(clan.clanId, {
        ...afterClan, treasury: new Map(afterClan.treasury).set(
          currency, (afterClan.treasury.get(currency) ?? 0) - 1,
        ),
      }),
      states: new Map(after.states).set(importerStateId, {
        ...afterImporter, treasury: new Map(afterImporter.treasury).set(
          currency, (afterImporter.treasury.get(currency) ?? 0) + 1,
        ),
      }),
    };
    expect(totalCash(forgedWorld, currency)).toBeCloseTo(totalCash(after, currency), 6);
    expect(() => audit(forgedWorld, settled.context.transactions)).toThrow();

    const blocked = run(f, settled.world, false, 8);
    expect(blocked.phaseBoundaryError).toBeUndefined();
    expect(blocked.reconciliationErrors).toBeNull();
    expect(blocked.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "TRANSPORT_FEE")).toHaveLength(0);
    expect(blocked.world.clans.get(clan.clanId)!.treasury)
      .toEqual(settled.world.clans.get(clan.clanId)!.treasury);
  });

  it("reconciles divergent Phase-1 tariff regimes across two real FX corridors", () => {
    const f = fixture();
    const taxRate = 0.25;
    const withRate = (rate: number, world: WorldState) => run({
      ...f,
      options: {
        ...f.options,
        phase1TariffLawProvider: query => query.goodId === IRON ? rate : 0,
      },
    }, world);
    const free = withRate(0, f.world);
    const taxed = withRate(taxRate, f.world);
    const shuffled = withRate(taxRate, reordered(f.world));
    const openingIron = totalIron(f.world);
    const openingCash = f.currencies.map(currency => totalCash(f.world, currency));
    const pool = f.world.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;

    // Derive the legal tax base from frozen opening FX rate and live cargo
    // quantity, not from an already-booked tariff journal or tax amount.
    const verify = (
      result: ReturnType<typeof run>, rate: number,
      journal = result.context.transactions,
    ) => {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
      for (const [index, currency] of f.currencies.entries()) {
        expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[index]!, 5);
      }
      const cargos = [...(result.world.shipments?.values() ?? [])];
      expect(cargos).toHaveLength(2);
      expect(new Set(cargos.map(cargo => cargo.transportLinkId)))
        .toEqual(new Set(f.links));
      const tariffs = journal.filter(tx =>
        tx.phase === 7 && tx.type === "IMPORT_TARIFF");
      expect(tariffs).toHaveLength(rate === 0 ? 0 : cargos.length);
      for (const cargo of cargos) {
        const destinationStateId = f.world.regions
          .get(cargo.destinationRegionId)!.controllerStateId!;
        expect(result.context.phase1ImportTariffs?.ratesByDestinationStateGood
          .get(phase7ImportTariffKey(destinationStateId, IRON))).toBe(rate);
        const sourceInvoice = cargo.sellerNetUnitPrice * cargo.quantity;
        const invoiceMidDest = cargo.invoiceCurrencyId === pool.baseCurrencyId
          ? sourceInvoice * pool.spotRateQuotePerBase
          : sourceInvoice / pool.spotRateQuotePerBase;
        const expectedTariff = (invoiceMidDest + cargo.transportFeeAmount) * rate;
        expect(cargo.tariffAmount).toBeCloseTo(expectedTariff, 6);
        const dispatches = journal.filter(tx =>
          tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH" &&
          tx.sourceRegionId === cargo.originRegionId &&
          tx.destinationRegionId === cargo.destinationRegionId);
        expect(dispatches).toHaveLength(1);
        const booked = tariffs.filter(tx =>
          tx.bundleId === dispatches[0]!.bundleId);
        expect(booked).toHaveLength(rate === 0 ? 0 : 1);
        if (rate !== 0) {
          expect(booked[0]!.moneyAmount).toBeCloseTo(expectedTariff, 6);
          expect(booked[0]!.currencyId).toBe(cargo.buyerPaymentCurrencyId);
          expect(booked[0]!.source).toEqual(cargo.beneficialOwner);
          expect(booked[0]!.destination).toEqual({
            type: "STATE", stateId: destinationStateId,
          });
        }
      }
    };

    verify(free, 0);
    verify(taxed, taxRate);
    verify(shuffled, taxRate);
    // Tariff changes cannot retroactively change Phase-4 local procurement.
    expect(taxed.context.transactions.filter(tx => tx.phase === 4))
      .toEqual(free.context.transactions.filter(tx => tx.phase === 4));
    expect(shuffled.context.transactions).toEqual(taxed.context.transactions);
    expect(shuffled.world.shipments).toEqual(taxed.world.shipments);
    expect(shuffled.world.productionUnits).toEqual(taxed.world.productionUnits);
    expect(shuffled.world.monetaryAuthorities).toEqual(taxed.world.monetaryAuthorities);

    // A bogus but still positive import-tariff payment must fail the exact
    // independent Phase-1-rate / opening-FX-base settlement oracle.
    let alteredOne = false;
    const inflated = taxed.context.transactions.map(tx => {
      if (alteredOne || tx.phase !== 7 || tx.type !== "IMPORT_TARIFF") return tx;
      alteredOne = true;
      return { ...tx, moneyAmount: tx.moneyAmount! + 1 };
    });
    expect(alteredOne).toBe(true);
    expect(() => verify(taxed, taxRate, inflated)).toThrow();
  });


  it("settles Phase-1 import tariffs once and never re-taxes cargo after a policy change", () => {
    const f = fixture();
    const rateAtDispatch = 0.25;
    const withTariff = (rate: number): ReturnType<typeof fixture> => ({
      ...f,
      options: {
        ...f.options,
        phase1TariffLawProvider: query => query.goodId === IRON ? rate : 0,
      },
    });
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) =>
        [id, { ...link, travelTicks: 3 }] as const)),
    };
    const openingIron = totalIron(opening);
    const openingCash = f.currencies.map(currency => totalCash(opening, currency));

    // The import policy is frozen at dispatch. Customs payments occur before
    // goods enter transit, not when the cargo reaches the destination.
    const dispatched = run(withTariff(rateAtDispatch), opening, true, 7);
    const dispatchedShuffled = run(withTariff(rateAtDispatch), reordered(opening), true, 7);
    for (const result of [dispatched, dispatchedShuffled]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
    }
    const cargos = [...(dispatched.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(2);
    expect(new Set(cargos.map(c => c.transportLinkId))).toEqual(new Set(f.links));
    expect(cargos.map(cargo => cargo.arrivalTick)).toEqual([10, 10]);
    const paidTariffs = dispatched.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "IMPORT_TARIFF");
    expect(paidTariffs).toHaveLength(2);
    for (const cargo of cargos) {
      const importerStateId = opening.regions.get(cargo.destinationRegionId)!.controllerStateId!;
      expect(dispatched.context.phase1ImportTariffs?.ratesByDestinationStateGood
        .get(phase7ImportTariffKey(importerStateId, IRON))).toBe(rateAtDispatch);
      expect(cargo.tariffAmount).toBeGreaterThan(0);
    }
    expect(dispatchedShuffled.context.transactions).toEqual(dispatched.context.transactions);
    expect(dispatchedShuffled.world.shipments).toEqual(dispatched.world.shipments);

    const assertNoNewTradeCharges = (
      journal: typeof dispatched.context.transactions,
    ) => expect(journal.filter(tx =>
      tx.phase === 7 && [
        "SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT",
        "IMPORT_TARIFF", "CONSUMPTION_TAX", "TRANSPORT_FEE",
      ].includes(tx.type))).toHaveLength(0);

    let normalWorld = dispatched.world;
    let shuffledWorld = dispatchedShuffled.world;
    let deliveryCount = 0;
    for (let tick = 8; tick <= 12; tick++) {
      // The border closes and the import tariff is abolished. Previously
      // settled shipments must still deliver without rebooking or refunding.
      const normal = run(withTariff(0), normalWorld, false, tick);
      const shuffled = run(withTariff(0), shuffledWorld, false, tick);
      for (const result of [normal, shuffled]) {
        expect(result.phaseTrace).toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
        assertNoNewTradeCharges(result.context.transactions);
        expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
        for (const [i, currency] of f.currencies.entries()) {
          expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[i]!, 5);
        }
        for (const cargo of cargos) {
          const importerStateId = opening.regions
            .get(cargo.destinationRegionId)!.controllerStateId!;
          expect(result.context.phase1ImportTariffs?.ratesByDestinationStateGood
            .get(phase7ImportTariffKey(importerStateId, IRON))).toBe(0);
        }
      }

      const deliveries = normal.context.transactions.filter(tx =>
        tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY");
      expect(deliveries).toHaveLength(tick === 10 ? cargos.length : 0);
      for (const cargo of cargos) {
        const matching = deliveries.filter(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
        expect(matching).toHaveLength(tick === cargo.arrivalTick ? 1 : 0);
        if (matching.length) {
          expect(matching[0]).toMatchObject({
            quantity: cargo.quantity,
            destination: cargo.beneficialOwner,
            sourceRegionId: cargo.originRegionId,
            destinationRegionId: cargo.destinationRegionId,
          });
          expect(matching[0]!.moneyAmount).toBeUndefined();
          deliveryCount++;
        }
      }
      expect(normal.world.shipments?.size ?? 0).toBe(tick < 10 ? 2 : 0);
      expect(shuffled.context.transactions).toEqual(normal.context.transactions);
      expect(economicReplayFingerprint(tick, shuffled.world, shuffled.context.transactions))
        .toBe(economicReplayFingerprint(tick, normal.world, normal.context.transactions));

      // Negative control: a late positive tariff silently inserted in a
      // balanced-looking journal must still fail the no-retroactive-charge oracle.
      if (tick === 8) {
        const forgedLateCharge = [
          ...normal.context.transactions,
          { ...paidTariffs[0]!, tick },
        ];
        expect(() => assertNoNewTradeCharges(forgedLateCharge)).toThrow();
      }
      normalWorld = normal.world;
      shuffledWorld = shuffled.world;
    }
    expect(deliveryCount).toBe(cargos.length);
  });


  it("applies concurrent destination-State tariff rates to distinct border corridors", () => {
    const f = fixture();
    const firstLink = f.world.transportLinks.get(f.links[0]!)!;
    const secondLink = f.world.transportLinks.get(f.links[1]!)!;
    const origin = f.world.regions.get(firstLink.fromRegionId)!;
    const firstDestination = f.world.regions.get(firstLink.toRegionId)!;
    const secondDestination = f.world.regions.get(secondLink.toRegionId)!;
    const firstImporter = firstDestination.controllerStateId!;
    // A border change without currency redenomination: one Beta-currency
    // destination is now governed by a third State. Both FX corridors remain
    // funded by the same pool, but the two import governments have different laws.
    const secondImporter = [...f.world.states.keys()].find(id =>
      id !== origin.controllerStateId && id !== firstImporter)!;
    expect(secondImporter).toBeDefined();
    const opening: WorldState = {
      ...f.world,
      regions: new Map([...f.world.regions].map(([id, region]) =>
        [id, id === secondDestination.regionId
          ? { ...region, controllerStateId: secondImporter }
          : region] as const)),
    };
    expect(opening.regions.get(secondDestination.regionId)!.settlementCurrencyId)
      .toBe(firstDestination.settlementCurrencyId);
    const rates = new Map([[firstImporter, 0.25], [secondImporter, 0.10]]);
    const scenario: ReturnType<typeof fixture> = {
      ...f,
      world: opening,
      options: {
        ...f.options,
        phase1TariffLawProvider: query =>
          query.goodId === IRON ? rates.get(query.destinationStateId) ?? 0 : 0,
      },
    };
    const openingIron = totalIron(opening);
    const openingCash = f.currencies.map(currency => totalCash(opening, currency));
    const phase7Snapshots: { before: WorldState; after: WorldState }[] = [];
    const normal = run(scenario, opening, true, 7, (phase, before, after) => {
      if (phase === 7) phase7Snapshots.push({ before, after });
    });
    const shuffled = run(scenario, reordered(opening));
    expect(phase7Snapshots).toHaveLength(1);
    for (const result of [normal, shuffled]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
      for (const [index, currency] of f.currencies.entries()) {
        expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[index]!, 5);
      }
      for (const [stateId, rate] of rates) {
        expect(result.context.phase1ImportTariffs?.ratesByDestinationStateGood
          .get(phase7ImportTariffKey(stateId, IRON))).toBe(rate);
      }
    }
    const cargos = [...(normal.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(2);
    expect(new Set(cargos.map(c => c.transportLinkId))).toEqual(new Set(f.links));
    expect(new Set(cargos.map(c =>
      opening.regions.get(c.destinationRegionId)!.controllerStateId)))
      .toEqual(new Set([firstImporter, secondImporter]));
    const pool = opening.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;

    // Recompute each duty from the independently configured law, opening FX
    // spot rate, actual paid cargo and transport fee; never trust journal totals.
    const verify = (journal: typeof normal.context.transactions) => {
      const entries = journal.filter(tx => tx.phase === 7 && tx.type === "IMPORT_TARIFF");
      expect(entries).toHaveLength(cargos.length);
      for (const cargo of cargos) {
        const importer = opening.regions.get(cargo.destinationRegionId)!.controllerStateId!;
        const sourceInvoice = cargo.sellerNetUnitPrice * cargo.quantity;
        const converted = cargo.invoiceCurrencyId === pool.baseCurrencyId
          ? sourceInvoice * pool.spotRateQuotePerBase
          : sourceInvoice / pool.spotRateQuotePerBase;
        const due = (converted + cargo.transportFeeAmount) * rates.get(importer)!;
        expect(cargo.tariffAmount).toBeCloseTo(due, 6);
        const dispatches = journal.filter(tx =>
          tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH" &&
          tx.sourceRegionId === cargo.originRegionId &&
          tx.destinationRegionId === cargo.destinationRegionId);
        expect(dispatches).toHaveLength(1);
        const booked = entries.filter(tx => tx.bundleId === dispatches[0]!.bundleId);
        expect(booked).toHaveLength(1);
        expect(booked[0]!.moneyAmount).toBeCloseTo(due, 6);
        expect(booked[0]!.currencyId).toBe(cargo.buyerPaymentCurrencyId);
        expect(booked[0]!.source).toEqual(cargo.beneficialOwner);
        expect(booked[0]!.destination).toEqual({ type: "STATE", stateId: importer });
      }
    };
    verify(normal.context.transactions);
    verify(shuffled.context.transactions);
    expect(shuffled.context.transactions).toEqual(normal.context.transactions);
    expect(shuffled.world.shipments).toEqual(normal.world.shipments);
    expect(shuffled.world.states).toEqual(normal.world.states);
    expect(shuffled.world.productionUnits).toEqual(normal.world.productionUnits);
    expect(shuffled.world.monetaryAuthorities).toEqual(normal.world.monetaryAuthorities);

    // Actual treasury increments across Phase 7 must go to the two separate
    // jurisdictions, even though both routes pay in the same buyer currency.
    const { before, after } = phase7Snapshots[0]!;
    for (const [stateId] of rates) {
      const currency = firstDestination.settlementCurrencyId;
      const expected = cargos.reduce((sum, cargo) => {
        const importer = opening.regions.get(cargo.destinationRegionId)!.controllerStateId;
        const feeReceiver = opening.transportLinks.get(cargo.transportLinkId)!.feeReceiver;
        return sum + (importer === stateId
          ? cargo.tariffAmount + cargo.consumptionTaxAmount : 0) +
          (feeReceiver?.type === "STATE" && feeReceiver.stateId === stateId
            ? cargo.transportFeeAmount : 0);
      }, 0);
      const actual = (after.states.get(stateId)!.treasury.get(currency) ?? 0) -
        (before.states.get(stateId)!.treasury.get(currency) ?? 0);
      expect(actual).toBeCloseTo(expected, 6);
    }

    // Negative control: redirect one correctly sized duty to the other
    // government; conservation still looks fine, but legality must fail.
    let corrupted = false;
    const diverted = normal.context.transactions.map(tx => {
      if (corrupted || tx.phase !== 7 || tx.type !== "IMPORT_TARIFF" ||
          tx.destination?.type !== "STATE" || tx.destination.stateId !== firstImporter) return tx;
      corrupted = true;
      return { ...tx, destination: { type: "STATE" as const, stateId: secondImporter } };
    });
    expect(corrupted).toBe(true);
    expect(() => verify(diverted)).toThrow();
  });


  it("resumes paid international trade after a prior FX-floor denial without retroactive settlement", () => {
    const f = fixture();
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) =>
        [id, { ...link, travelTicks: 2 }] as const)),
    };
    const authority = opening.monetaryAuthorities.get(f.chosen.authorityId)!;
    const pool = authority.fxPools.get(f.chosen.poolId)!;
    const dryWorld: WorldState = {
      ...opening,
      monetaryAuthorities: new Map(opening.monetaryAuthorities).set(
        f.chosen.authorityId, {
          ...authority,
          fxPools: new Map(authority.fxPools).set(f.chosen.poolId, {
            ...pool,
            cash: new Map(pool.cash)
              .set(pool.baseCurrencyId, pool.minOperationalReserveBase)
              .set(pool.quoteCurrencyId, pool.minOperationalReserveQuote),
          }),
        },
      ),
    };
    const phase7 = (result: ReturnType<typeof run>, type: string) =>
      result.context.transactions.filter(tx => tx.phase === 7 && tx.type === type);

    // Both routes are legal and physically usable. At the FX operational
    // floor neither may reserve a payout, pay customs, or create in-transit stock.
    const dry = run(f, dryWorld, true, 7);
    const dryShuffled = run(f, reordered(dryWorld), true, 7);
    for (const result of [dry, dryShuffled]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      for (const type of ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"]) {
        expect(phase7(result, type)).toHaveLength(0);
      }
      expect(result.world.shipments?.size ?? 0).toBe(0);
      expect(result.context.transactions.filter(tx => tx.phase === 4).length)
        .toBeGreaterThan(0);
      expect(result.world.monetaryAuthorities).toEqual(dryWorld.monetaryAuthorities);
    }
    expect(dryShuffled.context.transactions).toEqual(dry.context.transactions);
    expect(dryShuffled.world.productionUnits).toEqual(dry.world.productionUnits);
    expect(dryShuffled.world.markets).toEqual(dry.world.markets);

    // The independent opening-of-tick fixture change is a test-input
    // replenishment, NOT simulated money creation. Measure conservation only
    // against that new funded opening and never attribute it to a trade tick.
    const sellerCurrency = f.currencies[0]!;
    const buyerCurrency = f.currencies[1]!;
    const replenish = (world: WorldState): WorldState => {
      const owner = world.monetaryAuthorities.get(f.chosen.authorityId)!;
      const existing = owner.fxPools.get(f.chosen.poolId)!;
      return {
        ...world,
        monetaryAuthorities: new Map(world.monetaryAuthorities).set(
          f.chosen.authorityId, {
            ...owner,
            fxPools: new Map(owner.fxPools).set(f.chosen.poolId, {
              ...existing,
              cash: new Map(existing.cash).set(
                sellerCurrency, existing.cash.get(sellerCurrency)! + 100_000,
              ),
            }),
          },
        ),
      };
    };
    const fundedOpening = replenish(dry.world);
    const shuffledOpening = replenish(dryShuffled.world);
    const openingIron = totalIron(fundedOpening);
    const openingCash = f.currencies.map(currency => totalCash(fundedOpening, currency));
    const resumed = run(f, fundedOpening, true, 8);
    const resumedShuffled = run(f, shuffledOpening, true, 8);
    const cargos = [...(resumed.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(2);
    expect(new Set(cargos.map(cargo => cargo.transportLinkId))).toEqual(new Set(f.links));
    expect(cargos.every(cargo => cargo.departureTick === 8 && cargo.arrivalTick === 10))
      .toBe(true);

    const verifyPayment = (journal: typeof resumed.context.transactions) => {
      const dispatches = journal.filter(tx =>
        tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH");
      const inputs = journal.filter(tx => tx.phase === 7 && tx.type === "FX_INPUT");
      const outputs = journal.filter(tx => tx.phase === 7 && tx.type === "FX_OUTPUT");
      const duties = journal.filter(tx => tx.phase === 7 && tx.type === "IMPORT_TARIFF");
      for (const entries of [dispatches, inputs, outputs, duties]) {
        expect(entries).toHaveLength(cargos.length);
      }
      for (const cargo of cargos) {
        const dispatch = dispatches.filter(tx =>
          tx.sourceRegionId === cargo.originRegionId &&
          tx.destinationRegionId === cargo.destinationRegionId &&
          tx.quantity === cargo.quantity);
        expect(dispatch).toHaveLength(1);
        expect(inputs.filter(tx =>
          tx.bundleId === dispatch[0]!.bundleId &&
          tx.fxSettlementId === cargo.fxSettlementId)).toHaveLength(1);
        expect(outputs.filter(tx =>
          tx.bundleId === dispatch[0]!.bundleId &&
          tx.fxSettlementId === cargo.fxSettlementId)).toHaveLength(1);
        expect(duties.filter(tx => tx.bundleId === dispatch[0]!.bundleId))
          .toHaveLength(1);
      }
    };
    verifyPayment(resumed.context.transactions);
    verifyPayment(resumedShuffled.context.transactions);
    const paidOutputs = phase7(resumed, "FX_OUTPUT");
    const paidInputs = phase7(resumed, "FX_INPUT");
    const startingPool = fundedOpening.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;
    const finalPool = resumed.world.monetaryAuthorities.get(f.chosen.authorityId)!
      .fxPools.get(f.chosen.poolId)!;
    expect(finalPool.cash.get(sellerCurrency)! - startingPool.cash.get(sellerCurrency)!)
      .toBeCloseTo(-paidOutputs.reduce((sum, tx) => sum + tx.moneyAmount!, 0), 6);
    expect(finalPool.cash.get(buyerCurrency)! - startingPool.cash.get(buyerCurrency)!)
      .toBeCloseTo(paidInputs.reduce((sum, tx) => sum + tx.moneyAmount!, 0), 6);
    // Deleting one payment leg must fail the same bundle-aware settlement oracle.
    const omitted = resumed.context.transactions.filter(tx =>
      !(tx.type === "FX_OUTPUT" && tx.fxSettlementId === cargos[0]!.fxSettlementId));
    expect(() => verifyPayment(omitted)).toThrow();

    expect(resumedShuffled.context.transactions).toEqual(resumed.context.transactions);
    let normalWorld = resumed.world;
    let shuffledWorld = resumedShuffled.world;
    let delivered = 0;
    for (let tick = 9; tick <= 12; tick++) {
      const normal = run(f, normalWorld, false, tick);
      const shuffled = run(f, shuffledWorld, false, tick);
      for (const result of [normal, shuffled]) {
        expect(result.phaseTrace).toEqual([...Array(16).keys()]);
        expect(result.phaseBoundaryError).toBeUndefined();
        expect(result.reconciliationErrors).toBeNull();
        for (const type of ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"]) {
          expect(phase7(result, type)).toHaveLength(0);
        }
        expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
        for (const [i, currency] of f.currencies.entries()) {
          expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[i]!, 5);
        }
      }
      const deliveries = normal.context.transactions.filter(tx =>
        tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY");
      expect(deliveries).toHaveLength(tick === 10 ? cargos.length : 0);
      for (const cargo of cargos) {
        expect(deliveries.filter(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id &&
          tx.quantity === cargo.quantity &&
          JSON.stringify(tx.destination) === JSON.stringify(cargo.beneficialOwner)))
          .toHaveLength(tick === cargo.arrivalTick ? 1 : 0);
      }
      delivered += deliveries.length;
      expect(shuffled.context.transactions).toEqual(normal.context.transactions);
      expect(economicReplayFingerprint(tick, shuffled.world, shuffled.context.transactions))
        .toBe(economicReplayFingerprint(tick, normal.world, normal.context.transactions));
      normalWorld = normal.world;
      shuffledWorld = shuffled.world;
    }
    expect(delivered).toBe(2);
    expect(normalWorld.shipments?.size ?? 0).toBe(0);
  });



  it("settles opposite FX directions in the same tick and delivers both paid cargos once", () => {
    const f = fixture();
    const baseline = buildInitialWorld(
      baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 42,
    );
    const alphaSource = [...f.world.regions.values()].find(r => r.seed.key === "region:a4-border")!;
    const betaDestination = [...f.world.regions.values()].find(r => r.seed.key === "region:b4-chokepoint")!;
    const betaSource = [...f.world.regions.values()].find(r => r.seed.key === "region:b5-pastoral")!;
    const alphaDestination = [...baseline.regions.values()].find(
      r => r.seed.key === "region:a5-copper-mine",
    )!;
    const alphaMarket = [...baseline.markets.values()].find(
      m => m.seed.regionKey === alphaDestination.seed.key,
    )!;
    expect(alphaMarket).toBeDefined();
    expect(betaSource.settlementCurrencyId).toBe(betaDestination.settlementCurrencyId);
    expect(alphaDestination.settlementCurrencyId).toBe(alphaSource.settlementCurrencyId);

    // Keep the original profitable Alpha -> Beta route. Redirect the second
    // independent link into a profitable Beta -> Alpha route, using another
    // seller and buyer in distinct markets (not impossible two-way arbitrage).
    const originalLink = f.world.transportLinks.get(f.links[0]!)!;
    const reverseTemplate = f.world.transportLinks.get(f.links[1]!)!;
    const forward = { ...originalLink, travelTicks: 2 };
    const backward = {
      ...reverseTemplate,
      fromRegionId: betaSource.regionId,
      toRegionId: alphaDestination.regionId,
      travelTicks: 2,
      seed: {
        ...reverseTemplate.seed,
        key: "link:test-b5-a5-opposite",
        fromRegionKey: betaSource.seed.key,
        toRegionKey: alphaDestination.seed.key,
      },
    };
    const units = [...f.world.productionUnits.values()];
    expect(units).toHaveLength(6);
    const betaSeller = {
      ...units[4]!,
      status: "CLOSING" as const,
      installedCapital: 0,
      wallet: new Map([[betaSource.settlementCurrencyId, 5]]),
      inputInventory: new Map([[IRON, 1000]]),
      outputInventory: new Map(),
      investmentInventory: new Map(),
    };
    const alphaBuyer = {
      ...units[5]!,
      status: "ACTIVE" as const,
      installedCapital: 5,
      seed: { ...units[5]!.seed, regionKey: alphaDestination.seed.key },
      wallet: new Map([[alphaDestination.settlementCurrencyId, 1_000_000]]),
      inputInventory: new Map(),
      outputInventory: new Map(),
      investmentInventory: new Map(),
    };
    const markets = new Map([...f.world.markets].map(([id, market]) => [
      id, {
        ...market,
        priceByGood: new Map(market.priceByGood).set(
          IRON, market.seed.regionKey === betaSource.seed.key ? 1 :
            market.seed.regionKey === alphaSource.seed.key ? 1 : 100,
        ),
      },
    ] as const));
    markets.set(alphaMarket.marketId, {
      ...alphaMarket, priceByGood: new Map(alphaMarket.priceByGood).set(IRON, 100),
    });
    const opening: WorldState = {
      ...f.world,
      regions: new Map([...f.world.regions, [alphaDestination.regionId, alphaDestination]]),
      markets,
      productionUnits: new Map([
        ...units.slice(0, 4).map(unit => [unit.productionUnitId, unit] as const),
        [betaSeller.productionUnitId, betaSeller],
        [alphaBuyer.productionUnitId, alphaBuyer],
      ]),
      transportLinks: new Map([
        [forward.linkId, forward], [backward.linkId, backward],
      ]),
      outgoingTransportLinkIdsByRegion: new Map([
        [alphaSource.regionId, [forward.linkId]],
        [betaSource.regionId, [backward.linkId]],
      ]),
    };
    const ironBefore = totalIron(opening);
    const cashBefore = f.currencies.map(currency => totalCash(opening, currency));

    const phase7Snapshots: { before: WorldState; after: WorldState }[] = [];
    const first = run(f, opening, true, 7, (phase, before, after) => {
      if (phase === 7) phase7Snapshots.push({ before, after });
    });
    const reorderedFirst = run(f, reordered(opening), true, 7);
    expect(first.reconciliationErrors).toBeNull();
    expect(first.context.transactions).toEqual(reorderedFirst.context.transactions);
    expect(economicReplayFingerprint(7, first.world, first.context.transactions))
      .toBe(economicReplayFingerprint(
        7, reorderedFirst.world, reorderedFirst.context.transactions,
      ));
    const cargos = [...(first.world.shipments?.values() ?? [])];
    expect(cargos).toHaveLength(2);
    expect(cargos.map(c => [c.originRegionId, c.destinationRegionId])).toEqual([
      [alphaSource.regionId, betaDestination.regionId],
      [betaSource.regionId, alphaDestination.regionId],
    ]);
    const verifyBundles = (receipts: typeof first.context.transactions) => {
      const phase7 = receipts.filter(tx => tx.phase === 7);
      const dispatches = phase7.filter(tx => tx.type === "SHIPMENT_DISPATCH");
      const inputs = phase7.filter(tx => tx.type === "FX_INPUT");
      const outputs = phase7.filter(tx => tx.type === "FX_OUTPUT");
      const tariffs = phase7.filter(tx => tx.type === "IMPORT_TARIFF");
      expect(dispatches).toHaveLength(2);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
      expect(tariffs).toHaveLength(2);
      expect(new Set(inputs.map(tx => tx.currencyId))).toEqual(new Set(f.currencies));
      expect(new Set(outputs.map(tx => tx.currencyId))).toEqual(new Set(f.currencies));
      for (const cargo of cargos) {
        const dispatch = dispatches.filter(tx =>
          tx.sourceRegionId === cargo.originRegionId &&
          tx.destinationRegionId === cargo.destinationRegionId &&
          tx.goodId === cargo.goodId && tx.quantity === cargo.quantity);
        expect(dispatch).toHaveLength(1);
        const bundle = dispatch[0]!.bundleId;
        expect(bundle).toBeDefined();
        expect(inputs.filter(tx =>
          tx.bundleId === bundle &&
          tx.fxSettlementId === cargo.fxSettlementId &&
          tx.currencyId === cargo.buyerPaymentCurrencyId &&
          JSON.stringify(tx.source) === JSON.stringify(cargo.beneficialOwner)))
          .toHaveLength(1);
        expect(outputs.filter(tx =>
          tx.bundleId === bundle &&
          tx.fxSettlementId === cargo.fxSettlementId &&
          tx.currencyId === cargo.invoiceCurrencyId &&
          JSON.stringify(tx.destination) === JSON.stringify(cargo.seller)))
          .toHaveLength(1);
        expect(tariffs.filter(tx => tx.bundleId === bundle)).toHaveLength(1);
      }
    };
    verifyBundles(first.context.transactions);

    // Reconcile physical Phase-7 money postings against frozen cargo claims,
    // not against a journal that might itself contain balanced false payees.
    // Both FX directions execute in one tick through the SAME finite pool.
    expect(phase7Snapshots).toHaveLength(1);
    const { before, after } = phase7Snapshots[0]!;
    const assertExactSettlement = (openingPhase: WorldState, settledPhase: WorldState) => {
      for (const [unitId, unit] of openingPhase.productionUnits) {
        for (const currency of f.currencies) {
          const expected = cargos.reduce((sum, cargo) => {
            const sellerCredit = cargo.seller.type === "PRODUCTION_UNIT" &&
              cargo.seller.productionUnitId === unitId &&
              cargo.invoiceCurrencyId === currency
                ? cargo.sellerNetUnitPrice * cargo.quantity : 0;
            const buyerDebit = cargo.beneficialOwner.type === "PRODUCTION_UNIT" &&
              cargo.beneficialOwner.productionUnitId === unitId &&
              cargo.buyerPaymentCurrencyId === currency
                ? cargo.buyerGoodsPaymentAmount + cargo.transportFeeAmount +
                  cargo.tariffAmount + cargo.consumptionTaxAmount : 0;
            return sum + sellerCredit - buyerDebit;
          }, 0);
          const actual = (settledPhase.productionUnits.get(unitId)!.wallet.get(currency) ?? 0) -
            (unit.wallet.get(currency) ?? 0);
          expect(actual).toBeCloseTo(expected, 6);
        }
      }

      for (const [stateId, state] of openingPhase.states) {
        for (const currency of f.currencies) {
          // Legal jurisdictions and fee recipients come from the opening world,
          // independently of the tariff/fee journal's claimed destinations.
          const expected = cargos.reduce((sum, cargo) => {
            if (cargo.buyerPaymentCurrencyId !== currency) return sum;
            const importer = opening.regions.get(cargo.destinationRegionId)!.controllerStateId;
            const feeOwner = opening.transportLinks.get(cargo.transportLinkId)!.feeReceiver;
            return sum + (importer === stateId
              ? cargo.tariffAmount + cargo.consumptionTaxAmount : 0) +
              (feeOwner?.type === "STATE" && feeOwner.stateId === stateId
                ? cargo.transportFeeAmount : 0);
          }, 0);
          const actual = (settledPhase.states.get(stateId)!.treasury.get(currency) ?? 0) -
            (state.treasury.get(currency) ?? 0);
          expect(actual).toBeCloseTo(expected, 6);
        }
      }

      const priorPool = openingPhase.monetaryAuthorities.get(f.chosen.authorityId)!
        .fxPools.get(f.chosen.poolId)!;
      const settledPool = settledPhase.monetaryAuthorities.get(f.chosen.authorityId)!
        .fxPools.get(f.chosen.poolId)!;
      for (const currency of f.currencies) {
        // A bidirectional pool has BOTH an input and output in each currency:
        // checking only one leg or aggregate global money misses netting errors.
        const expected = cargos.reduce((sum, cargo) =>
          sum + (cargo.buyerPaymentCurrencyId === currency
            ? cargo.buyerGoodsPaymentAmount : 0) -
            (cargo.invoiceCurrencyId === currency
              ? cargo.sellerNetUnitPrice * cargo.quantity : 0), 0);
        const actual = (settledPool.cash.get(currency) ?? 0) -
          (priorPool.cash.get(currency) ?? 0);
        expect(actual).toBeCloseTo(expected, 6);
      }
    };
    assertExactSettlement(before, after);
    expect(cargos[0]!.buyerPaymentCurrencyId).toBe(cargos[1]!.invoiceCurrencyId);

    // Mutate two different live actor wallets with equal and opposite entries
    // in the SAME currency. Total currency conservation still passes, but a
    // per-payer/per-seller oracle must reject the misallocated payment.
    const buyer = cargos[0]!.beneficialOwner;
    const reverseSeller = cargos[1]!.seller;
    if (buyer.type !== "PRODUCTION_UNIT" || reverseSeller.type !== "PRODUCTION_UNIT") {
      throw new Error("Expected two production-unit payment owners");
    }
    expect(buyer.productionUnitId).not.toBe(reverseSeller.productionUnitId);
    const shiftedCurrency = cargos[0]!.buyerPaymentCurrencyId;
    const forgedUnits = new Map(after.productionUnits);
    for (const change of [
      { id: buyer.productionUnitId, amount: 1 },
      { id: reverseSeller.productionUnitId, amount: -1 },
    ]) {
      const unit = forgedUnits.get(change.id)!;
      forgedUnits.set(change.id, {
        ...unit,
        wallet: new Map(unit.wallet).set(
          shiftedCurrency, (unit.wallet.get(shiftedCurrency) ?? 0) + change.amount,
        ),
      });
    }
    const falselyBalanced: WorldState = { ...after, productionUnits: forgedUnits };
    expect(totalCash(falselyBalanced, shiftedCurrency))
      .toBeCloseTo(totalCash(after, shiftedCurrency), 6);
    expect(() => assertExactSettlement(before, falselyBalanced)).toThrow();
    // The oracle must reject a missing FX leg, not just count shipments.
    expect(() => verifyBundles(first.context.transactions.filter(
      tx => tx.type !== "FX_OUTPUT" || tx.currencyId !== f.currencies[1],
    ))).toThrow();
    expect(totalIron(first.world)).toBeCloseTo(ironBefore, 6);
    f.currencies.forEach((currency, i) =>
      expect(totalCash(first.world, currency)).toBeCloseTo(cashBefore[i]!, 5));

    let normalWorld = first.world;
    let reversedWorld = reorderedFirst.world;
    for (let tick = 8; tick <= 10; tick++) {
      // A newly closed border must not cancel or re-pay already-settled cargo.
      const normal = run(f, normalWorld, false, tick);
      const reversed = run(f, reversedWorld, false, tick);
      expect(normal.reconciliationErrors).toBeNull();
      expect(normal.context.transactions).toEqual(reversed.context.transactions);
      expect(economicReplayFingerprint(tick, normal.world, normal.context.transactions))
        .toBe(economicReplayFingerprint(
          tick, reversed.world, reversed.context.transactions,
        ));
      expect(normal.context.transactions.filter(tx =>
        tx.phase === 7 && ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"]
          .includes(tx.type))).toHaveLength(0);
      const delivered = normal.context.transactions.filter(tx =>
        tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY");
      expect(delivered).toHaveLength(tick === 9 ? 2 : 0);
      for (const cargo of cargos) {
        expect(delivered.filter(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id &&
          tx.quantity === cargo.quantity &&
          JSON.stringify(tx.destination) === JSON.stringify(cargo.beneficialOwner)))
          .toHaveLength(tick === cargo.arrivalTick ? 1 : 0);
      }
      expect(totalIron(normal.world)).toBeCloseTo(ironBefore, 6);
      f.currencies.forEach((currency, i) =>
        expect(totalCash(normal.world, currency)).toBeCloseTo(cashBefore[i]!, 5));
      normalWorld = normal.world;
      reversedWorld = reversed.world;
    }
    expect(normalWorld.shipments?.size ?? 0).toBe(0);
  });


  it("delivers paid in-transit cargo when every corridor loses physical capacity after dispatch", () => {
    const f = fixture();
    const opening: WorldState = {
      ...f.world,
      transportLinks: new Map([...f.world.transportLinks].map(([id, link]) =>
        [id, { ...link, travelTicks: 2 }] as const)),
    };
    const ironBefore = totalIron(opening);
    const cashBefore = f.currencies.map(currency => totalCash(opening, currency));
    const first = run(f, opening, true, 7);
    expect(first.phaseBoundaryError).toBeUndefined();
    expect(first.reconciliationErrors).toBeNull();
    const frozen = [...(first.world.shipments?.values() ?? [])];
    expect(frozen).toHaveLength(2); // Two real, funded corridor shipments.
    expect(new Set(frozen.map(cargo => cargo.transportLinkId))).toEqual(new Set(f.links));
    expect(frozen.every(cargo => cargo.arrivalTick === 9 && cargo.quantity > 0)).toBe(true);
    expect(first.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "SHIPMENT_DISPATCH")).toHaveLength(2);
    expect(first.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT")).toHaveLength(2);

    // Collapse BOTH physical capacities after the real FX/customs settlement.
    // Unlike a border closure, the law still authorizes these corridors:
    // capacity alone must refuse new dispatch, without cancelling old cargo.
    const collapsed = {
      ...f,
      options: {
        ...f.options,
        infrastructureFactors: new Map(f.links.map(id => [id, 0] as const)),
      },
    };
    const second = run(collapsed, first.world, true, 8);
    expect(second.world.shipments).toEqual(first.world.shipments);
    expect(second.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY")).toHaveLength(0);

    const phase1Snapshots: { before: WorldState; after: WorldState }[] = [];
    const third = run(collapsed, second.world, true, 9, (phase, before, after) => {
      if (phase === 1) phase1Snapshots.push({ before, after });
    });
    expect(phase1Snapshots).toHaveLength(1);
    expect(third.world.shipments?.size ?? 0).toBe(0);
    const deliveryReceipts = third.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY");
    const verifyDelivery = (journal: typeof deliveryReceipts) => {
      expect(journal).toHaveLength(frozen.length);
      for (const cargo of frozen) {
        const match = journal.filter(tx =>
          tx.reason === "IN_TRANSIT_TO_INPUT_STOCK:" + cargo.id);
        expect(match).toHaveLength(1);
        expect(match[0]).toMatchObject({
          phase: 1, tick: 9, goodId: cargo.goodId,
          quantity: cargo.quantity, destination: cargo.beneficialOwner,
          sourceRegionId: cargo.originRegionId,
          destinationRegionId: cargo.destinationRegionId,
        });
        expect(match[0]!.moneyAmount).toBeUndefined();
        if (cargo.beneficialOwner.type !== "PRODUCTION_UNIT") {
          throw new Error("Expected paid production-unit cargo owner");
        }
        const id = cargo.beneficialOwner.productionUnitId;
        const before = phase1Snapshots[0]!.before.productionUnits.get(id)!
          .inputInventory.get(cargo.goodId) ?? 0;
        const after = phase1Snapshots[0]!.after.productionUnits.get(id)!
          .inputInventory.get(cargo.goodId) ?? 0;
        expect(after - before).toBeCloseTo(cargo.quantity, 8);
      }
    };
    verifyDelivery(deliveryReceipts);
    // An equal number of receipts is not enough if one delivery duplicates goods.
    const forged = deliveryReceipts.map((tx, index) =>
      index === 0 ? { ...tx, quantity: tx.quantity! + 1 } : tx);
    expect(() => verifyDelivery(forged)).toThrow();

    const fourth = run(collapsed, third.world, true, 10);
    expect(fourth.context.transactions.filter(tx =>
      tx.type === "SHIPMENT_DELIVERY")).toHaveLength(0);
    for (const result of [second, third, fourth]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      expect(result.context.transactions.filter(tx => tx.phase === 7 &&
        ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF",
          "TRANSPORT_FEE", "TRADE_GOODS_SALE"].includes(tx.type))).toHaveLength(0);
    }
    for (const result of [first, second, third, fourth]) {
      expect(totalIron(result.world)).toBeCloseTo(ironBefore, 6);
      for (const [index, currency] of f.currencies.entries()) {
        expect(totalCash(result.world, currency)).toBeCloseTo(cashBefore[index]!, 5);
      }
    }

    // Keyed insertion order must not determine whether a paid cargo survives
    // a capacity shock or who receives its physical contents.
    let reversedWorld = reordered(opening);
    for (const [tick, actual] of [[7, first], [8, second], [9, third], [10, fourth]] as const) {
      const mirror = run(tick === 7 ? f : collapsed, reversedWorld, true, tick);
      expect(mirror.phaseBoundaryError).toBeUndefined();
      expect(mirror.reconciliationErrors).toBeNull();
      expect(mirror.context.transactions).toEqual(actual.context.transactions);
      expect(mirror.world.shipments).toEqual(actual.world.shipments);
      expect(economicReplayFingerprint(tick, mirror.world, mirror.context.transactions))
        .toBe(economicReplayFingerprint(tick, actual.world, actual.context.transactions));
      reversedWorld = reordered(mirror.world);
    }
  });

  it("shares one directed physical corridor across two independently paid destination buyers", () => {
    const f = fixture();
    const linkId = f.links[0]!;
    const originalLink = f.world.transportLinks.get(linkId)!;
    const destination = f.world.regions.get(originalLink.toRegionId)!;
    const otherDestination = f.world.regions.get(f.world.transportLinks.get(f.links[1]!)!.toRegionId)!;
    expect(destination.settlementCurrencyId).toBe(otherDestination.settlementCurrencyId);

    // Move the second ACTIVE importer into the first destination region.
    // Both production buyers now compete for the very same directed link,
    // good and origin seller; neither gets an independent cargo-weight budget.
    const movedBuyer = [...f.world.productionUnits.values()].find(unit =>
      unit.status === "ACTIVE" && unit.seed.regionKey === otherDestination.seed.key)!;
    expect(movedBuyer).toBeDefined();
    const relocated = {
      ...movedBuyer,
      seed: { ...movedBuyer.seed, regionKey: destination.seed.key },
    };
    const opening: WorldState = {
      ...f.world,
      productionUnits: new Map(f.world.productionUnits).set(relocated.productionUnitId, relocated),
      transportLinks: new Map([[linkId, originalLink]]),
      outgoingTransportLinkIdsByRegion: new Map([[originalLink.fromRegionId, [linkId]]]),
    };
    const singleCorridor = {
      ...f,
      world: opening,
      links: [linkId],
      options: {
        ...f.options,
        infrastructureFactors: new Map([[linkId, 1]]),
        phase1TradeLawProvider: (query: Parameters<typeof f.options.phase1TradeLawProvider>[0]) =>
          query.goodId === IRON && query.linkId === linkId ? null : undefined,
      },
    };
    const baseline = run(singleCorridor, opening);
    expect(baseline.phaseBoundaryError).toBeUndefined();
    expect(baseline.reconciliationErrors).toBeNull();
    const unrestricted = [...(baseline.world.shipments?.values() ?? [])];
    expect(unrestricted).toHaveLength(2);
    expect(new Set(unrestricted.map(cargo => cargo.transportLinkId))).toEqual(new Set([linkId]));
    expect(new Set(unrestricted.map(cargo => JSON.stringify(cargo.beneficialOwner))).size).toBe(2);
    expect(unrestricted.every(cargo => cargo.fxSettlementId !== undefined)).toBe(true);

    const weight = baselineDefinitionPack.goods[IRON]!.cargoWeightPerUnit;
    const baselineUse = unrestricted.reduce((sum, cargo) => sum + cargo.quantity * weight, 0);
    expect(baselineUse).toBeGreaterThan(0);
    const constrained: WorldState = {
      ...opening,
      transportLinks: new Map([[linkId, {
        ...originalLink,
        seed: {
          ...originalLink.seed,
          baseCapacity: baselineUse * 0.7 / originalLink.seed.condition,
        },
      }]]),
    };
    const physicalCapacity = effectiveTransportLinkCapacity(
      constrained.transportLinks.get(linkId)!, 1,
    );
    expect(physicalCapacity).toBeCloseTo(baselineUse * 0.7, 8);
    const openingIron = totalIron(constrained);
    const openingCash = f.currencies.map(currency => totalCash(constrained, currency));
    const limited = run(singleCorridor, constrained);
    const reversed = run(singleCorridor, reordered(constrained));
    const cargo = [...(limited.world.shipments?.values() ?? [])];
    expect(cargo).toHaveLength(2);
    expect(new Set(cargo.map(c => JSON.stringify(c.beneficialOwner))).size).toBe(2);

    function assertSinglePhysicalBudget(shipments: typeof cargo): void {
      expect(shipments).toHaveLength(2);
      expect(shipments.every(c => c.transportLinkId === linkId && c.quantity > 0)).toBe(true);
      const spent = shipments.reduce((sum, c) => sum + c.quantity * weight, 0);
      expect(spent).toBeLessThanOrEqual(physicalCapacity + 1e-8);
    }
    assertSinglePhysicalBudget(cargo);
    const constrainedUse = cargo.reduce((sum, c) => sum + c.quantity * weight, 0);
    expect(constrainedUse).toBeLessThan(baselineUse);
    expect(constrainedUse).toBeGreaterThan(0);
    // Negative control: a second physical budget for either buyer cannot be
    // hidden by individually valid shipments and a correct dispatch count.
    const overbooked = [
      { ...cargo[0]!, quantity: physicalCapacity / weight + 1 },
      cargo[1]!,
    ];
    expect(() => assertSinglePhysicalBudget(overbooked)).toThrow();

    for (const result of [limited, reversed]) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      const transactions = result.context.transactions.filter(tx => tx.phase === 7);
      for (const type of ["SHIPMENT_DISPATCH", "FX_INPUT", "FX_OUTPUT", "IMPORT_TARIFF"]) {
        expect(transactions.filter(tx => tx.type === type)).toHaveLength(cargo.length);
      }
      expect(totalIron(result.world)).toBeCloseTo(openingIron, 6);
      for (const [index, currency] of f.currencies.entries()) {
        expect(totalCash(result.world, currency)).toBeCloseTo(openingCash[index]!, 5);
      }
    }
    expect(reversed.context.transactions).toEqual(limited.context.transactions);
    expect(reversed.world.shipments).toEqual(limited.world.shipments);
    expect(reversed.world.productionUnits).toEqual(limited.world.productionUnits);
    expect(economicReplayFingerprint(7, reversed.world, reversed.context.transactions))
      .toBe(economicReplayFingerprint(7, limited.world, limited.context.transactions));
  });


});
