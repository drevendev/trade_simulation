/**
 * M5 FX genesis preflight (#669).
 *
 * Handoff/04 §§17–18: every directed FX pool explicitly names its base and
 * quote currencies; the base issuer owns the pool. No lexical-ID inference and
 * no free-standing authority wallet may silently replace pool cash.
 *
 * This is seed validation ONLY: it does not create an FX runtime, settle
 * balances, quote rates, or choose a trade candidate.
 */
import type { ScenarioDefinition } from "./scenarioDefinition";

export function validateFxPoolGenesis(scenario: ScenarioDefinition): void {
  const currencies = new Map(scenario.currencies.map((currency) => [currency.key, currency]));
  const pairOwners = new Map<string, string>();
  const poolKeys = new Set<string>();

  for (const authority of scenario.monetaryAuthorities) {
    for (const pool of authority.fxPools ?? []) {
      const owner = `FxPool "${pool.key}" of MonetaryAuthority "${authority.key}"`;

      if (typeof pool.key !== "string" || pool.key.trim().length === 0) {
        throw new Error(`MonetaryAuthority "${authority.key}" has an FX pool without a nonempty key`);
      }
      if (poolKeys.has(pool.key)) {
        throw new Error(`FX pool key "${pool.key}" is declared more than once`);
      }
      poolKeys.add(pool.key);

      if (!currencies.has(pool.baseCurrencyKey)) {
        throw new Error(`${owner}: baseCurrencyKey "${pool.baseCurrencyKey}" references an unknown Currency`);
      }
      if (!currencies.has(pool.quoteCurrencyKey)) {
        throw new Error(`${owner}: quoteCurrencyKey "${pool.quoteCurrencyKey}" references an unknown Currency`);
      }
      if (pool.baseCurrencyKey === pool.quoteCurrencyKey) {
        throw new Error(`${owner}: baseCurrencyKey and quoteCurrencyKey must be distinct`);
      }
      if (authority.currencyKey !== pool.baseCurrencyKey ||
          currencies.get(pool.baseCurrencyKey)?.issuerAuthorityKey !== authority.key) {
        throw new Error(`${owner}: the FX pool must belong to the issuing authority of its baseCurrencyKey`);
      }

      // A pool's explicit oriented pair is its identity. Do not infer direction
      // from its key or silently merge two pools with the same oriented pair.
      // Reciprocal pairs in the canonical baseline are intentionally separate
      // seeds; consolidating them requires a specification/fixture migration.
      const pair = JSON.stringify([pool.baseCurrencyKey, pool.quoteCurrencyKey]);
      const previousOwner = pairOwners.get(pair);
      if (previousOwner !== undefined) {
        throw new Error(`${owner}: duplicate oriented FX pair already declared by ${previousOwner}`);
      }
      pairOwners.set(pair, owner);

      if (typeof pool.cash !== "object" || pool.cash === null || Array.isArray(pool.cash)) {
        throw new Error(`${owner}: cash must be a wallet keyed by base and quote currencies`);
      }
      const cashKeys = Object.keys(pool.cash);
      if (cashKeys.length !== 2 ||
          !cashKeys.includes(pool.baseCurrencyKey) ||
          !cashKeys.includes(pool.quoteCurrencyKey)) {
        throw new Error(`${owner}: cash must have exactly baseCurrencyKey and quoteCurrencyKey entries`);
      }
      for (const currencyKey of cashKeys) {
        const amount = pool.cash[currencyKey];
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
          throw new Error(`${owner}: cash["${currencyKey}"] must be non-negative and finite`);
        }
      }

      if (!Number.isFinite(pool.spotRateQuotePerBase) || pool.spotRateQuotePerBase <= 0) {
        throw new Error(`${owner}: spotRateQuotePerBase must be positive and finite`);
      }
      if (!Number.isFinite(pool.transactionSpread) ||
          pool.transactionSpread < 0 || pool.transactionSpread >= 1) {
        throw new Error(`${owner}: transactionSpread must be in [0,1) and finite`);
      }
      if (!Number.isFinite(pool.targetBaseReserveShare) ||
          pool.targetBaseReserveShare < 0 || pool.targetBaseReserveShare > 1) {
        throw new Error(`${owner}: targetBaseReserveShare must be in [0,1] and finite`);
      }
      if (!Number.isFinite(pool.flowPressureEma)) {
        throw new Error(`${owner}: flowPressureEma must be finite`);
      }
      for (const field of ["minOperationalReserveBase", "minOperationalReserveQuote", "maxRateMovePerTick"] as const) {
        const value = pool[field];
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`${owner}: ${field} must be non-negative and finite`);
        }
      }
    }
  }
}
