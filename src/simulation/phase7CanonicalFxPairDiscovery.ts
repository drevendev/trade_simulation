/**
 * M5 / #673: opt-in FX pair lookup from ACTUAL live WorldState pools.
 *
 * The caller may name route/good opportunities, but cannot name FX rates,
 * pairs or liquidity in this mode. This resolver only selects an already
 * registered, issuer-owned pool when there is EXACTLY ONE for the currency
 * combination. It does not infer a preferred base currency, manufacture a
 * bridge through third currencies, or rank competing pools by liquidity.
 *
 * A separate current-tick owner must still supply remaining FX budgets; the
 * live Phase-7 quote/reservation path verifies them against pool reserves.
 */
import type { CurrencyId, RegionId } from "../domain/id";
import { quoteFx, resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import type { WorldState } from "./worldState";

export interface Phase7FxPairRoute {
  readonly planId: string;
  readonly originRegionId: RegionId;
  readonly destinationRegionId: RegionId;
}

function unorderedPair(a: CurrencyId, b: CurrencyId): string {
  return JSON.stringify([a, b].sort());
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Only already-discovered legal routes are eligible for this read-only lookup.
 * Missing/ambiguous cross-currency pools fail closed; same-currency routes
 * deliberately have no FX pair and do not require a pool.
 */
export function derivePhase7UnambiguousCanonicalFxPairs(
  world: WorldState,
  routes: readonly Phase7FxPairRoute[],
): ReadonlyMap<string, string> {
  if (!Array.isArray(routes)) {
    throw new Error("Phase-7 canonical FX pair lookup needs discovered routes");
  }

  const pairsByCurrencies = new Map<string, string[]>();
  for (const [authorityId, authority] of [...world.monetaryAuthorities]
    .sort(([a], [b]) => cmp(a, b))) {
    for (const [pairId, pool] of [...authority.fxPools]
      .sort(([a], [b]) => cmp(a, b))) {
      // Do not silently accept a forged or mis-owned pool when it is a
      // candidate for a live trade; resolveCanonicalFxPool checks sole owner.
      const currencies = unorderedPair(pool.baseCurrencyId, pool.quoteCurrencyId);
      const entries = pairsByCurrencies.get(currencies) ?? [];
      entries.push(pairId);
      pairsByCurrencies.set(currencies, entries);
      if (pool.baseCurrencyId === pool.quoteCurrencyId ||
          !world.currencies.has(pool.baseCurrencyId) ||
          !world.currencies.has(pool.quoteCurrencyId) ||
          !authorityId || !authority.authorityId) {
        throw new Error("Phase-7 canonical FX pair registry has invalid currencies or owner");
      }
    }
  }

  const result = new Map<string, string>();
  const seen = new Set<string>();
  for (const route of [...routes].sort((a, b) => cmp(a.planId, b.planId))) {
    if (!route || typeof route.planId !== "string" || !route.planId ||
        seen.has(route.planId)) {
      throw new Error("Phase-7 canonical FX pair lookup duplicate or missing plan ID");
    }
    seen.add(route.planId);
    const origin = world.regions.get(route.originRegionId);
    const destination = world.regions.get(route.destinationRegionId);
    if (!origin || !destination) {
      throw new Error("Phase-7 canonical FX pair lookup references an unknown Region");
    }
    const sourceCurrency = origin.settlementCurrencyId;
    const destCurrency = destination.settlementCurrencyId;
    if (sourceCurrency === destCurrency) continue;

    const matches = pairsByCurrencies.get(unorderedPair(sourceCurrency, destCurrency)) ?? [];
    if (matches.length !== 1) {
      throw new Error("Phase-7 canonical FX pair lookup requires exactly one live pool per currency pair");
    }
    const pairId = matches[0]!;
    // Revalidate the actual base-issuer-owned pool and live quote economics.
    // A readable pool ID alone is not valid FX price/reserve authority.
    resolveCanonicalFxPool(world, pairId);
    quoteFx(world, pairId, destCurrency, sourceCurrency, 0);
    result.set(route.planId, pairId);
  }
  return result;
}
