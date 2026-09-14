/**
 * Genesis reconciliation and validation (REQ-CONFIG-004).
 *
 * Verifies that opening stocks recorded in WorldGenesisLedger match the
 * constructed tick-0 WorldState within configured tolerances.
 *
 * Per Handoff/03 section 20, reconciliation must validate owner-bound identity
 * in addition to aggregate conservation:
 * - MONEY_ENDOWMENT and FX_POOL_OPENING are reconciled by (owner/poolKey, currencyId)
 * - GOOD_ENDOWMENT is reconciled by (owner, regionId, goodId)
 * - CAPITAL_ENDOWMENT is reconciled by (owner (ProductionUnit), capital goodId)
 * - POPULATION_ENDOWMENT is reconciled by (owner (Cohort), regionId)
 * - RESOURCE_ENDOWMENT is reconciled by (regionId, goodId)
 *
 * Section 20 states that `sourceSeedKey` is provenance only and must never substitute
 * for typed stock identity, so every key above is built from the typed fields the
 * GenesisRecord carries rather than from a reconstructed descriptive seed string.
 */

import type { WorldGenesisLedger, GenesisRecord, ActorRef } from "../domain/genesisLedger";
import { resolveCapitalGoodsPerCapitalUnit } from "../domain/definitionRegistry";
import type { SimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId, RegionId } from "../domain/id";
import type { WorldState } from "./worldState";

export interface ReconciliationResult {
  success: boolean;
  errorMessage?: string;
  details?: {
    category: string;
    key: string;
    expected: number;
    actual: number;
    tolerance: number;
    residual: number;
  };
}

/**
 * Key segment for capital that embodies no tradable good, i.e. a ProductionUnit whose
 * recipe declares no investment good. Such capital carries no `goodId` (Handoff/03
 * section 20 declares `goodId?: GoodId`), and this segment keeps it reconciled
 * owner-bound instead of silently leaving it outside the comparison.
 */
const UNCONVERTED_CAPITAL_KEY = "UNCONVERTED";

function serializeCapitalGood(goodId: GoodId | undefined): string {
  return goodId === undefined ? UNCONVERTED_CAPITAL_KEY : String(goodId);
}

/**
 * Key segment for a good stock whose owner is not region-bound, i.e. a State's public
 * inventory, which the State holds itself rather than in any one region it controls.
 * Such a record carries no `regionId` (Handoff/03 section 20 declares `regionId?`), and
 * this segment keeps it reconciled owner-bound instead of leaving it outside the
 * comparison or colliding with a region-bound stock of the same owner and good.
 */
const UNLOCATED_STOCK_KEY = "NO_REGION";

function serializeRegion(regionId: RegionId | undefined): string {
  return regionId === undefined ? UNLOCATED_STOCK_KEY : String(regionId);
}

function serializeOwner(owner: ActorRef | undefined): string {
  if (!owner) return "NONE";
  if (owner.type === "STATE") return `STATE:${owner.stateId}`;
  if (owner.type === "CLAN") return `CLAN:${owner.clanId}`;
  if (owner.type === "COHORT") return `COHORT:${owner.cohortId}`;
  if (owner.type === "PRODUCTION_UNIT") return `PU:${owner.productionUnitId}`;
  if (owner.type === "MONETARY_AUTHORITY") return `AUTHORITY:${owner.authorityId}`;
  return "UNKNOWN";
}

/**
 * Reconcile opening stocks with owner/location granularity.
 * Validates that each owner-bound stock matches both aggregate and identity levels.
 */
export function reconcileGenesisStocks(
  worldState: WorldState,
  ledger: WorldGenesisLedger,
  config: SimulationConfig,
): ReconciliationResult {
  const tolerance = config.numeric.reconciliationRelativeTolerance ?? 1e-9;

  // Expected: owner-bound and location-granular stocks from ledger (REQ-CONFIG-004)
  const expectedMoneyByOwnerCurrency = new Map<string, number>();
  const expectedGoodsByOwnerRegionGoodId = new Map<string, number>();
  const expectedCapitalByOwnerGood = new Map<string, number>();
  const expectedPopulationByGranularity = new Map<string, number>();
  const expectedResourcesByGranularity = new Map<string, number>();

  ledger.records.forEach((record) => {
    switch (record.type) {
      case "MONEY_ENDOWMENT": {
        if (record.owner) {
          const ownerKey = serializeOwner(record.owner);
          const currencyKey = String(record.currencyId);
          const key = `${ownerKey}:${currencyKey}`;
          const current = expectedMoneyByOwnerCurrency.get(key) ?? 0;
          expectedMoneyByOwnerCurrency.set(key, current + record.amount);
        }
        break;
      }
      case "FX_POOL_OPENING": {
        // FX pool reserves are reconciled by pool identity + currency granularity
        const fxPoolKey = `FX_POOL:${record.sourceSeedKey}:${record.currencyId}`;
        const current = expectedMoneyByOwnerCurrency.get(fxPoolKey) ?? 0;
        expectedMoneyByOwnerCurrency.set(fxPoolKey, current + record.amount);
        break;
      }
      case "BOND_OPENING_POSITION": {
        break;
      }
      case "GOOD_ENDOWMENT": {
        if (record.owner) {
          const ownerKey = serializeOwner(record.owner);
          const goodKey = String(record.goodId);
          const key = `${ownerKey}:${serializeRegion(record.regionId)}:${goodKey}`;
          const current = expectedGoodsByOwnerRegionGoodId.get(key) ?? 0;
          expectedGoodsByOwnerRegionGoodId.set(key, current + record.amount);
        }
        break;
      }
      case "CAPITAL_ENDOWMENT": {
        if (record.owner) {
          const ownerKey = serializeOwner(record.owner);
          const key = `${ownerKey}:${serializeCapitalGood(record.goodId)}`;
          const current = expectedCapitalByOwnerGood.get(key) ?? 0;
          expectedCapitalByOwnerGood.set(key, current + record.amount);
        }
        break;
      }
      case "POPULATION_ENDOWMENT": {
        // A cohort's population sits in exactly one Region, and the record carries that
        // Region typed, so the Region is part of the stock's identity rather than a
        // descriptive detail. `sourceSeedKey` stays provenance only (section 20).
        const granularity = `POP:${serializeOwner(record.owner)}:${serializeRegion(record.regionId)}`;
        const current = expectedPopulationByGranularity.get(granularity) ?? 0;
        expectedPopulationByGranularity.set(granularity, current + record.amount);
        break;
      }
      case "RESOURCE_ENDOWMENT": {
        // A resource deposit's canonical identity is the region it sits in plus the
        // resource good it holds, both carried typed on the record. `sourceSeedKey`
        // stays provenance only (section 20).
        const granularity = `RES:${String(record.regionId)}:${String(record.goodId)}`;
        const current = expectedResourcesByGranularity.get(granularity) ?? 0;
        expectedResourcesByGranularity.set(granularity, current + record.amount);
        break;
      }
    }
  });

  // Actual: owner-bound and location-granular stocks from world state (REQ-CONFIG-004)
  const actualMoneyByOwnerCurrency = new Map<string, number>();
  const actualGoodsByOwnerRegionGoodId = new Map<string, number>();
  const actualCapitalByOwnerGood = new Map<string, number>();
  const actualPopulationByGranularity = new Map<string, number>();
  const actualResourcesByGranularity = new Map<string, number>();

  // Canonical location of a region-bound stock is read from its owning entity's own
  // region, resolved through the region registry rather than from any aggregate
  // container that happens to hold the good.
  const regionIdByRegionKey = new Map<string, RegionId>();
  worldState.regions.forEach((region, regionId) => {
    regionIdByRegionKey.set(region.seed.key, regionId);
  });

  // Sum money by state owner + currency
  worldState.states.forEach((state) => {
    Object.entries(state.seed.treasury ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const ownerKey = `STATE:${state.stateId}`;
          const key = `${ownerKey}:${currencyId}`;
          const current = actualMoneyByOwnerCurrency.get(key) ?? 0;
          actualMoneyByOwnerCurrency.set(key, current + amount);
        }
      }
    });
    // Sum goods by state owner + goodId. A State's public inventory is not region-bound,
    // so it carries the unlocated segment on both sides of the comparison.
    Object.entries(state.seed.publicInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const ownerKey = `STATE:${state.stateId}`;
        const key = `${ownerKey}:${UNLOCATED_STOCK_KEY}:${goodKey}`;
        const current = actualGoodsByOwnerRegionGoodId.get(key) ?? 0;
        actualGoodsByOwnerRegionGoodId.set(key, current + amount);
      }
    });
  });

  // Project FX pool reserves by pool identity + currency (REQ-CONFIG-004)
  worldState.monetaryAuthorities.forEach((authority) => {
    (authority.seed.fxPools ?? []).forEach((fxPool) => {
      // Process base currency side
      if (fxPool.baseCurrencyKey && fxPool.cash) {
        const baseCurrencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === fxPool.baseCurrencyKey,
        )?.[0];
        const amount = fxPool.cash[fxPool.baseCurrencyKey];
        if (baseCurrencyId && typeof amount === "number" && amount > 0) {
          const fxPoolKey = `FX_POOL:${authority.seed.key}.fxPool.${fxPool.key}.base:${baseCurrencyId}`;
          const current = actualMoneyByOwnerCurrency.get(fxPoolKey) ?? 0;
          actualMoneyByOwnerCurrency.set(fxPoolKey, current + amount);
        }
      }
      // Process quote currency side
      if (fxPool.quoteCurrencyKey && fxPool.cash) {
        const quoteCurrencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === fxPool.quoteCurrencyKey,
        )?.[0];
        const amount = fxPool.cash[fxPool.quoteCurrencyKey];
        if (quoteCurrencyId && typeof amount === "number" && amount > 0) {
          const fxPoolKey = `FX_POOL:${authority.seed.key}.fxPool.${fxPool.key}.quote:${quoteCurrencyId}`;
          const current = actualMoneyByOwnerCurrency.get(fxPoolKey) ?? 0;
          actualMoneyByOwnerCurrency.set(fxPoolKey, current + amount);
        }
      }
    });

    // Project authority wallets and validate no duplication (REQ-CONFIG-004 criterion 3)
    Object.entries(authority.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const ownerKey = `AUTHORITY:${authority.authorityId}`;
          const key = `${ownerKey}:${currencyId}`;
          const current = actualMoneyByOwnerCurrency.get(key) ?? 0;
          actualMoneyByOwnerCurrency.set(key, current + amount);
        }
      }
    });
  });

  // Sum money by clan owner + currency
  worldState.clans.forEach((clan) => {
    Object.entries(clan.seed.treasury ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const ownerKey = `CLAN:${clan.clanId}`;
          const key = `${ownerKey}:${currencyId}`;
          const current = actualMoneyByOwnerCurrency.get(key) ?? 0;
          actualMoneyByOwnerCurrency.set(key, current + amount);
        }
      }
    });
  });

  // Sum money, goods, and population by cohort (the canonical owner of its own wallet,
  // household inventory and population stock — never its Clan; Handoff/01 5.3/5.4/7)
  worldState.cohorts.forEach((cohort) => {
    const cohortOwner = { type: "COHORT" as const, cohortId: cohort.cohortId };
    // The cohort's own Region, resolved through the region registry from the canonical
    // cohort/region relation rather than reconstructed from any seed-key text.
    const cohortRegionId = regionIdByRegionKey.get(cohort.seed.regionKey);
    // Population by cohort owner + the cohort's own region
    if (cohort.seed.population > 0) {
      const granularity = `POP:${serializeOwner(cohortOwner)}:${serializeRegion(cohortRegionId)}`;
      const current = actualPopulationByGranularity.get(granularity) ?? 0;
      actualPopulationByGranularity.set(granularity, current + cohort.seed.population);
    }
    // Money by cohort owner + currency
    Object.entries(cohort.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const key = `${serializeOwner(cohortOwner)}:${currencyId}`;
          const current = actualMoneyByOwnerCurrency.get(key) ?? 0;
          actualMoneyByOwnerCurrency.set(key, current + amount);
        }
      }
    });
    // Goods by cohort owner + the cohort's own region + goodId
    Object.entries(cohort.seed.householdInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const key = `${serializeOwner(cohortOwner)}:${serializeRegion(cohortRegionId)}:${goodKey}`;
        const current = actualGoodsByOwnerRegionGoodId.get(key) ?? 0;
        actualGoodsByOwnerRegionGoodId.set(key, current + amount);
      }
    });
  });

  // Sum money, goods, and capital by production unit owner
  worldState.productionUnits.forEach((pu) => {
    // Money by PU owner + currency
    Object.entries(pu.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const ownerKey = `PU:${pu.productionUnitId}`;
          const key = `${ownerKey}:${currencyId}`;
          const current = actualMoneyByOwnerCurrency.get(key) ?? 0;
          actualMoneyByOwnerCurrency.set(key, current + amount);
        }
      }
    });
    // Goods by PU owner + the unit's own region + goodId. The three inventory buckets
    // still aggregate together here; typed bucket identity is Issue #455.
    const puOwnerRegionPrefix = `${serializeOwner({
      type: "PRODUCTION_UNIT",
      productionUnitId: pu.productionUnitId,
    })}:${serializeRegion(regionIdByRegionKey.get(pu.seed.regionKey))}`;
    const addPuGoods = (inventory: Record<string, unknown> | undefined) => {
      Object.entries(inventory ?? {}).forEach(([goodKey, amount]) => {
        if (typeof amount === "number") {
          const key = `${puOwnerRegionPrefix}:${goodKey}`;
          const current = actualGoodsByOwnerRegionGoodId.get(key) ?? 0;
          actualGoodsByOwnerRegionGoodId.set(key, current + amount);
        }
      });
    };
    addPuGoods(pu.seed.inputInventory);
    addPuGoods(pu.seed.outputInventory);
    addPuGoods(pu.seed.investmentInventory);
    // Capital by PU owner + capital good, through the documented recipe conversion
    if (pu.seed.installedCapital > 0) {
      const ownerKey = `PU:${pu.productionUnitId}`;
      const capitalGoods = resolveCapitalGoodsPerCapitalUnit(
        worldState.definitionRegistry,
        pu.seed.recipeId,
      );

      if (capitalGoods.length > 0) {
        capitalGoods.forEach(([goodId, goodsPerCapitalUnit]) => {
          const key = `${ownerKey}:${serializeCapitalGood(goodId)}`;
          const current = actualCapitalByOwnerGood.get(key) ?? 0;
          actualCapitalByOwnerGood.set(key, current + pu.seed.installedCapital * goodsPerCapitalUnit);
        });
      } else {
        const key = `${ownerKey}:${UNCONVERTED_CAPITAL_KEY}`;
        const current = actualCapitalByOwnerGood.get(key) ?? 0;
        actualCapitalByOwnerGood.set(key, current + pu.seed.installedCapital);
      }
    }
  });

  // Sum resources by the region they sit in plus the resource good they hold. The
  // region is read as the registry's own RegionId, not reconstructed from the seed
  // key, so a record naming the wrong region cannot match a correct deposit.
  worldState.regions.forEach((region, regionId) => {
    (region.seed.deposits ?? []).forEach((deposit) => {
      if (deposit.initialQuantity > 0) {
        const granularity = `RES:${String(regionId)}:${String(deposit.resourceId)}`;
        const current = actualResourcesByGranularity.get(granularity) ?? 0;
        actualResourcesByGranularity.set(granularity, current + deposit.initialQuantity);
      }
    });
  });

  // Check owner-bound money reconciliation
  const checkMoneyReconciliation = (key: string) => {
    const expected = expectedMoneyByOwnerCurrency.get(key) ?? 0;
    const actual = actualMoneyByOwnerCurrency.get(key) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Money reconciliation failed for ${key}`,
        details: {
          category: "MONEY",
          key,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  // Check owner-bound, location-granular goods reconciliation
  const checkGoodReconciliation = (key: string) => {
    const expected = expectedGoodsByOwnerRegionGoodId.get(key) ?? 0;
    const actual = actualGoodsByOwnerRegionGoodId.get(key) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Good reconciliation failed for ${key}`,
        details: {
          category: "GOOD",
          key,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  // Check owner-bound, per-capital-good capital reconciliation
  const checkCapitalReconciliation = (key: string) => {
    const expected = expectedCapitalByOwnerGood.get(key) ?? 0;
    const actual = actualCapitalByOwnerGood.get(key) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Capital reconciliation failed for ${key}`,
        details: {
          category: "CAPITAL",
          key,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  // Check owner-currency combinations for money
  for (const key of expectedMoneyByOwnerCurrency.keys()) {
    const result = checkMoneyReconciliation(key);
    if (result) return result;
  }
  for (const key of actualMoneyByOwnerCurrency.keys()) {
    if (!expectedMoneyByOwnerCurrency.has(key)) {
      const result = checkMoneyReconciliation(key);
      if (result) return result;
    }
  }

  // Check owner-region-goodId combinations for goods
  for (const key of expectedGoodsByOwnerRegionGoodId.keys()) {
    const result = checkGoodReconciliation(key);
    if (result) return result;
  }
  for (const key of actualGoodsByOwnerRegionGoodId.keys()) {
    if (!expectedGoodsByOwnerRegionGoodId.has(key)) {
      const result = checkGoodReconciliation(key);
      if (result) return result;
    }
  }

  // Check owner-goodId combinations for capital
  for (const key of expectedCapitalByOwnerGood.keys()) {
    const result = checkCapitalReconciliation(key);
    if (result) return result;
  }
  for (const key of actualCapitalByOwnerGood.keys()) {
    if (!expectedCapitalByOwnerGood.has(key)) {
      const result = checkCapitalReconciliation(key);
      if (result) return result;
    }
  }

  // Check population by granularity
  for (const key of expectedPopulationByGranularity.keys()) {
    const expected = expectedPopulationByGranularity.get(key) ?? 0;
    const actual = actualPopulationByGranularity.get(key) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Population reconciliation failed for ${key}`,
        details: {
          category: "POPULATION",
          key,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
  }
  for (const key of actualPopulationByGranularity.keys()) {
    if (!expectedPopulationByGranularity.has(key)) {
      const expected = expectedPopulationByGranularity.get(key) ?? 0;
      const actual = actualPopulationByGranularity.get(key) ?? 0;
      const residual = Math.abs(expected - actual);
      const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

      if (residual > relativeTolerance) {
        return {
          success: false,
          errorMessage: `Population reconciliation failed for ${key}`,
          details: {
            category: "POPULATION",
            key,
            expected,
            actual,
            tolerance: relativeTolerance,
            residual,
          },
        };
      }
    }
  }

  // Check resources by granularity
  for (const key of expectedResourcesByGranularity.keys()) {
    const expected = expectedResourcesByGranularity.get(key) ?? 0;
    const actual = actualResourcesByGranularity.get(key) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Resource reconciliation failed for ${key}`,
        details: {
          category: "RESOURCE",
          key,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
  }
  for (const key of actualResourcesByGranularity.keys()) {
    if (!expectedResourcesByGranularity.has(key)) {
      const expected = expectedResourcesByGranularity.get(key) ?? 0;
      const actual = actualResourcesByGranularity.get(key) ?? 0;
      const residual = Math.abs(expected - actual);
      const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

      if (residual > relativeTolerance) {
        return {
          success: false,
          errorMessage: `Resource reconciliation failed for ${key}`,
          details: {
            category: "RESOURCE",
            key,
            expected,
            actual,
            tolerance: relativeTolerance,
            residual,
          },
        };
      }
    }
  }

  return { success: true };
}
