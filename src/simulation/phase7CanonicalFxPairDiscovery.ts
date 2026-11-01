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
import { phase7FxOutputKey } from "./phase7AggregateReservation";
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

/**
 * Optional Phase-7 auto-reservation mode: read the CURRENT live pool's
 * available source-currency output instead of accepting a caller-authored FX
 * budget. Every quoted route has already passed frozen Phase-1 eligibility.
 *
 * This is a shared ceiling per pool/direction, not a separate budget per
 * opportunity: the downstream aggregate allocator and strict actual-lot FX
 * reservations must still enforce the finite shared liquidity exactly once.
 * Prior realized settlements are already reflected in WorldState pool cash.
 * This read-only function creates no FX promise, exchange rate, or money.
 */
export function derivePhase7CanonicalFxOutputBudgets(
  world: WorldState,
  routes: readonly Phase7FxPairRoute[],
  pairsByPlan: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  if (!Array.isArray(routes) || !(pairsByPlan instanceof Map)) {
    throw new Error("Phase-7 canonical FX output requires discovered routes and pair identities");
  }
  const budgets = new Map<string, number>();
  const seen = new Set<string>();
  let crossCurrencyCount = 0;
  for (const route of [...routes].sort((a, b) => cmp(a.planId, b.planId))) {
    if (!route || typeof route.planId !== "string" || !route.planId ||
        seen.has(route.planId)) {
      throw new Error("Phase-7 canonical FX output duplicate or missing plan ID");
    }
    seen.add(route.planId);
    const origin = world.regions.get(route.originRegionId);
    const destination = world.regions.get(route.destinationRegionId);
    if (!origin || !destination) {
      throw new Error("Phase-7 canonical FX output references an unknown Region");
    }
    const sourceCurrency = origin.settlementCurrencyId;
    const destinationCurrency = destination.settlementCurrencyId;
    const pairId = pairsByPlan.get(route.planId);
    if (sourceCurrency === destinationCurrency) {
      if (pairId !== undefined) {
        throw new Error("Phase-7 canonical same-currency route must not reserve FX");
      }
      continue;
    }
    crossCurrencyCount++;
    if (typeof pairId !== "string" || !pairId.trim()) {
      throw new Error("Phase-7 canonical FX output requires a resolved live pool");
    }
    // quoteFx validates issuer ownership, direction, spot/spread, reserve
    // floors and current balances; no synthetic money or default is used.
    const available = quoteFx(
      world, pairId, destinationCurrency, sourceCurrency, 0,
    ).maxOutputByPoolReserve;
    if (!Number.isFinite(available) || available < 0) {
      throw new Error("Phase-7 canonical FX output pool ceiling is invalid");
    }
    const key = phase7FxOutputKey(pairId, sourceCurrency);
    if (budgets.has(key) && budgets.get(key) !== available) {
      throw new Error("Phase-7 canonical FX output inconsistent shared pool ceiling");
    }
    budgets.set(key, available);
  }
  if (pairsByPlan.size !== crossCurrencyCount) {
    throw new Error("Phase-7 canonical FX output contains surplus pair identities");
  }
  return budgets;
}
