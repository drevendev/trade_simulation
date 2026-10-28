/**
 * M5 #671: sole runtime lookup for Handoff/04 §17's base-issuer-owned FX pool.
 * A pool's cash is an independent ledger endpoint, NOT authority wallet cash.
 * The snapshot is read directly from WorldState; no shadow copy or spot mutation.
 */
import type { CurrencyId, MonetaryAuthorityId } from "../domain/id";
import { quoteFxForPool, type FxQuote, type FxQuoteLimits } from "./fxQuoteReservation";
import type { FxLiquidityPoolState, WorldState } from "./worldState";

export interface CanonicalFxPoolLocation {
  readonly owningAuthorityId: MonetaryAuthorityId;
  readonly pool: FxLiquidityPoolState;
}

/** No lexical pair inference; the pool's declared pairId is its identity. */
export function resolveCanonicalFxPool(
  world: WorldState,
  pairId: string,
): CanonicalFxPoolLocation {
  if (typeof pairId !== "string" || !pairId.trim()) {
    throw new Error("FX pairId must be a nonempty string");
  }
  let found: CanonicalFxPoolLocation | undefined;
  for (const [owningAuthorityId, authority] of world.monetaryAuthorities) {
    const pool = authority.fxPools.get(pairId);
    if (!pool) continue;
    if (found) {
      throw new Error(`FX pair ${pairId} has duplicate canonical pool owners`);
    }
    if (pool.pairId !== pairId ||
        authority.authorityId !== owningAuthorityId ||
        authority.currencyId !== pool.baseCurrencyId ||
        world.currencies.get(pool.baseCurrencyId)?.issuerAuthorityId !== owningAuthorityId) {
      throw new Error(`FX pair ${pairId} is not owned by the base-currency issuer`);
    }
    found = { owningAuthorityId, pool };
  }
  if (!found) {
    throw new Error(`Unknown canonical FX pair: ${pairId}`);
  }
  return found;
}

/**
 * Pure Handoff/04 §18 world adapter: quote from the one persisted pool.
 * Optional tick-local reservation/input limits remain ephemeral.
 */
export function quoteFx(
  world: WorldState,
  pairId: string,
  fromCurrencyId: CurrencyId,
  toCurrencyId: CurrencyId,
  desiredOutputAmount: number,
  limits: FxQuoteLimits = {},
): FxQuote {
  const { pool } = resolveCanonicalFxPool(world, pairId);
  return quoteFxForPool(pool, fromCurrencyId, toCurrencyId, desiredOutputAmount, limits);
}
