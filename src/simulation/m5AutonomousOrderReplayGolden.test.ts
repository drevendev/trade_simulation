/**
 * M5 / Issue #676 AC-6: replay and registry insertion-order invariance
 * across consecutive real FX-paid / cargo-arrival ticks, not just one quote.
 *
 * Bounded precursor to the separate 600-tick multi-region acceptance gate.
 */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import type { EconomicTransaction, PhaseHandler } from "./tickOrchestrator";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { WorldState } from "./worldState";

const unchanged = (_phase: number, world: WorldState) => world;
const upstream: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return {
      ...context,
      effectiveJurisdictionByRegion: new Map(
        [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
      ),
    };
  }
  return context.phase === 2 ? { ...context, householdMarketIntents: [] } : context;
};

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

function playSixTicks(opening: WorldState, options: ReturnType<typeof createM5PreviewScenario>["options"]) {
  const snapshots: {
    readonly world: WorldState;
    readonly transactions: readonly EconomicTransaction[];
    readonly phaseTrace: readonly number[];
  }[] = [];
  let paidFxDispatches = 0;
  let actualArrivals = 0;

  let world = opening;
  for (let tick = M5_PREVIEW_TICK; tick < M5_PREVIEW_TICK + 6; tick += 1) {
    const result = executeM5AutonomousRegionalTradeTick(
      world, tick, upstream, unchanged, options,
    );
    expect(result.phaseTrace, "16-phase trace at tick " + tick)
      .toEqual([...Array(16).keys()]);
    expect(result.phaseBoundaryError, "phase boundary at tick " + tick)
      .toBeUndefined();
    expect(result.reconciliationErrors, "stock ledger at tick " + tick).toBeNull();
    paidFxDispatches += result.context.transactions.filter(tx =>
      tx.phase === 7 && tx.type === "FX_OUTPUT").length;
    actualArrivals += result.context.transactions.filter(tx =>
      tx.phase === 1 && tx.type === "SHIPMENT_DELIVERY").length;
    snapshots.push({
      world: result.world,
      transactions: result.context.transactions,
      phaseTrace: result.phaseTrace,
    });
    world = result.world;
  }
  return { snapshots, paidFxDispatches, actualArrivals };
}

describe("M5 #676 multi-tick registry-order replay golden", () => {
  it("replays six actual 16-phase ticks identically when all live registry insertion orders reverse", () => {
    const scenario = createM5PreviewScenario();
    const reordered = reversedRegistries(scenario.opening);
    // Non-vacuity: merely reversing the outer WorldState maps is insufficient.
    // The real monetary pool and local price maps must also be adversarial.
    const market = [...scenario.opening.markets.values()].find(item => item.priceByGood.size > 1);
    expect(market, "fixture needs a multi-good market").toBeDefined();
    const revisedMarket = reordered.markets.get(market!.marketId)!;
    expect([...revisedMarket.priceByGood.keys()])
      .toEqual([...market!.priceByGood.keys()].reverse());
    const issuer = [...scenario.opening.monetaryAuthorities.entries()].find(
      ([, authority]) => [...authority.fxPools.values()].some(pool => pool.cash.size > 1),
    );
    expect(issuer, "fixture needs a funded multi-currency pool").toBeDefined();
    const poolEntry = [...issuer![1].fxPools.entries()].find(([, pool]) => pool.cash.size > 1)!;
    expect([...reordered.monetaryAuthorities.get(issuer![0])!.fxPools.get(poolEntry[0])!.cash.keys()])
      .toEqual([...poolEntry[1].cash.keys()].reverse());

    const original = playSixTicks(scenario.opening, scenario.options);
    const replay = playSixTicks(scenario.opening, scenario.options);
    const reversed = playSixTicks(reordered, scenario.options);

    // Prove the scenario really exercises both money settlement and a subsequent
    // physical arrival, rather than certifying a vacuous no-trade replay.
    expect(original.paidFxDispatches).toBeGreaterThan(0);
    expect(original.actualArrivals).toBeGreaterThan(0);
    expect(replay).toEqual(original);
    expect(reversed).toEqual(original);

    // A balanced, unjournaled owner-to-owner cash shift must still be detected
    // by the full-world replay comparison, not disappear in an aggregate total.
    const final = original.snapshots.at(-1)!.world;
    const owners = [...final.productionUnits.values()];
    const pair = owners.flatMap(left =>
      [...left.wallet.keys()].flatMap(currencyId => owners
        .filter(right => right.productionUnitId !== left.productionUnitId &&
          (right.wallet.get(currencyId) ?? 0) > 1)
        .map(right => ({ left, right, currencyId }))),
    )[0];
    expect(pair).toBeDefined();
    const { left, right, currencyId } = pair!;
    const shifted = new Map(final.productionUnits);
    for (const [owner, delta] of [[left, 0.25], [right, -0.25]] as const) {
      shifted.set(owner.productionUnitId, {
        ...owner,
        wallet: new Map(owner.wallet).set(
          currencyId, (owner.wallet.get(currencyId) ?? 0) + delta,
        ),
      });
    }
    const forged = { ...final, productionUnits: shifted };
    expect(() => expect(forged).toEqual(final)).toThrow();
    expect(scenario.opening.shipments?.size ?? 0).toBe(0);
  }, 30_000);
});
