/**
 * Genesis reconciliation and validation (REQ-CONFIG-004).
 *
 * Verifies that opening stocks recorded in WorldGenesisLedger match the
 * constructed tick-0 WorldState within configured tolerances.
 *
 * Per Handoff/03 section 20, reconciliation must validate owner-bound identity
 * in addition to aggregate conservation:
 * - MONEY_ENDOWMENT and FX_POOL_OPENING are reconciled by (owner/poolKey, currencyId)
 * - GOOD_ENDOWMENT is reconciled by (owner, goodId)
 * - CAPITAL_ENDOWMENT is reconciled by owner (ProductionUnit)
 * - POPULATION_ENDOWMENT and RESOURCE_ENDOWMENT are reconciled at their recorded granularity
 */

import type { WorldGenesisLedger, GenesisRecord, ActorRef } from "../domain/genesisLedger";
import type { SimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId } from "../domain/id";
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

function serializeOwner(owner: ActorRef | undefined): string {
  if (!owner) return "NONE";
  if (owner.type === "STATE") return `STATE:${owner.stateId}`;
  if (owner.type === "CLAN") return `CLAN:${owner.clanId}`;
  if (owner.type === "PRODUCTION_UNIT") return `PU:${owner.productionUnitId}`;
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
  const expectedGoodsByOwnerGoodId = new Map<string, number>();
  const expectedCapitalByOwner = new Map<string, number>();
  const expectedPopulationByGranularity = new Map<string, number>();
  const expectedResourcesByGranularity = new Map<string, number>();
  const expectedFxPoolByCurrency = new Map<string, number>();

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
        const currencyKey = String(record.currencyId);
        const key = `FX_POOL:${record.sourceSeedKey}:${currencyKey}`;
        const current = expectedFxPoolByCurrency.get(key) ?? 0;
        expectedFxPoolByCurrency.set(key, current + record.amount);
        break;
      }
      case "BOND_OPENING_POSITION": {
        break;
      }
      case "GOOD_ENDOWMENT": {
        if (record.owner) {
          const ownerKey = serializeOwner(record.owner);
          const goodKey = String(record.goodId);
          const key = `${ownerKey}:${goodKey}`;
          const current = expectedGoodsByOwnerGoodId.get(key) ?? 0;
          expectedGoodsByOwnerGoodId.set(key, current + record.amount);
        }
        break;
      }
      case "CAPITAL_ENDOWMENT": {
        if (record.owner) {
          const ownerKey = serializeOwner(record.owner);
          const current = expectedCapitalByOwner.get(ownerKey) ?? 0;
          expectedCapitalByOwner.set(ownerKey, current + record.amount);
        }
        break;
      }
      case "POPULATION_ENDOWMENT": {
        const granularity = `POP:${record.sourceSeedKey}`;
        const current = expectedPopulationByGranularity.get(granularity) ?? 0;
        expectedPopulationByGranularity.set(granularity, current + record.amount);
        break;
      }
      case "RESOURCE_ENDOWMENT": {
        const granularity = `RES:${record.sourceSeedKey}`;
        const current = expectedResourcesByGranularity.get(granularity) ?? 0;
        expectedResourcesByGranularity.set(granularity, current + record.amount);
        break;
      }
    }
  });

  // Actual: owner-bound and location-granular stocks from world state (REQ-CONFIG-004)
  const actualMoneyByOwnerCurrency = new Map<string, number>();
  const actualGoodsByOwnerGoodId = new Map<string, number>();
  const actualCapitalByOwner = new Map<string, number>();
  const actualPopulationByGranularity = new Map<string, number>();
  const actualResourcesByGranularity = new Map<string, number>();
  const actualFxPoolByCurrency = new Map<string, number>();

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
    // Sum goods by state owner + goodId
    Object.entries(state.seed.publicInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const ownerKey = `STATE:${state.stateId}`;
        const key = `${ownerKey}:${goodKey}`;
        const current = actualGoodsByOwnerGoodId.get(key) ?? 0;
        actualGoodsByOwnerGoodId.set(key, current + amount);
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

  // Sum money and goods by cohort (population owner) + currency/goodId
  worldState.cohorts.forEach((cohort) => {
    // Population by cohort granularity (using cohort seed key and source key format)
    if (cohort.seed.population > 0) {
      const granularity = `POP:${cohort.seed.key}.population`;
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
          const key = `${serializeOwner({ type: "CLAN", clanId: cohort.clanId })}:${currencyId}`;
          const current = actualMoneyByOwnerCurrency.get(key) ?? 0;
          actualMoneyByOwnerCurrency.set(key, current + amount);
        }
      }
    });
    // Goods by cohort owner + goodId
    Object.entries(cohort.seed.householdInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const key = `${serializeOwner({ type: "CLAN", clanId: cohort.clanId })}:${goodKey}`;
        const current = actualGoodsByOwnerGoodId.get(key) ?? 0;
        actualGoodsByOwnerGoodId.set(key, current + amount);
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
    // Goods by PU owner + goodId
    Object.entries(pu.seed.inputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const ownerKey = `PU:${pu.productionUnitId}`;
        const key = `${ownerKey}:${goodKey}`;
        const current = actualGoodsByOwnerGoodId.get(key) ?? 0;
        actualGoodsByOwnerGoodId.set(key, current + amount);
      }
    });
    Object.entries(pu.seed.outputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const ownerKey = `PU:${pu.productionUnitId}`;
        const key = `${ownerKey}:${goodKey}`;
        const current = actualGoodsByOwnerGoodId.get(key) ?? 0;
        actualGoodsByOwnerGoodId.set(key, current + amount);
      }
    });
    Object.entries(pu.seed.investmentInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const ownerKey = `PU:${pu.productionUnitId}`;
        const key = `${ownerKey}:${goodKey}`;
        const current = actualGoodsByOwnerGoodId.get(key) ?? 0;
        actualGoodsByOwnerGoodId.set(key, current + amount);
      }
    });
    // Capital by PU owner
    if (pu.seed.installedCapital > 0) {
      const ownerKey = `PU:${pu.productionUnitId}`;
      const current = actualCapitalByOwner.get(ownerKey) ?? 0;
      actualCapitalByOwner.set(ownerKey, current + pu.seed.installedCapital);
    }
  });

  // Sum resources by region-deposit granularity (using region + resource key)
  worldState.regions.forEach((region) => {
    (region.seed.deposits ?? []).forEach((deposit) => {
      if (deposit.initialQuantity > 0) {
        const granularity = `RES:${region.seed.key}.deposit.${deposit.resourceId}`;
        const current = actualResourcesByGranularity.get(granularity) ?? 0;
        actualResourcesByGranularity.set(granularity, current + deposit.initialQuantity);
      }
    });
  });

  // Sum money by monetary authority owner + currency (REQ-CONFIG-004)
  worldState.monetaryAuthorities.forEach((authority) => {
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

  // Sum FX pool reserves by pool + currency granularity (REQ-CONFIG-004)
  worldState.monetaryAuthorities.forEach((authority) => {
    (authority.seed.fxPools ?? []).forEach((fxPool) => {
      // Base currency side
      if (fxPool.cash) {
        const baseCash = fxPool.cash[fxPool.baseCurrencyKey];
        if (typeof baseCash === "number" && baseCash > 0) {
          const currencyId = Array.from(worldState.currencies.entries()).find(
            ([_, cs]) => cs.seed.key === fxPool.baseCurrencyKey,
          )?.[0];
          if (currencyId) {
            const key = `FX_POOL:${authority.seed.key}.fxPool.${fxPool.key}.base:${currencyId}`;
            const current = actualFxPoolByCurrency.get(key) ?? 0;
            actualFxPoolByCurrency.set(key, current + baseCash);
          }
        }
      }

      // Quote currency side
      if (fxPool.cash) {
        const quoteCash = fxPool.cash[fxPool.quoteCurrencyKey];
        if (typeof quoteCash === "number" && quoteCash > 0) {
          const currencyId = Array.from(worldState.currencies.entries()).find(
            ([_, cs]) => cs.seed.key === fxPool.quoteCurrencyKey,
          )?.[0];
          if (currencyId) {
            const key = `FX_POOL:${authority.seed.key}.fxPool.${fxPool.key}.quote:${currencyId}`;
            const current = actualFxPoolByCurrency.get(key) ?? 0;
            actualFxPoolByCurrency.set(key, current + quoteCash);
          }
        }
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

  // Check owner-bound goods reconciliation
  const checkGoodReconciliation = (key: string) => {
    const expected = expectedGoodsByOwnerGoodId.get(key) ?? 0;
    const actual = actualGoodsByOwnerGoodId.get(key) ?? 0;
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

  // Check owner-bound capital reconciliation
  const checkCapitalReconciliation = (key: string) => {
    const expected = expectedCapitalByOwner.get(key) ?? 0;
    const actual = actualCapitalByOwner.get(key) ?? 0;
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

  // Check FX pool reserve reconciliation by pool + currency
  const checkFxPoolReconciliation = (key: string) => {
    const expected = expectedFxPoolByCurrency.get(key) ?? 0;
    const actual = actualFxPoolByCurrency.get(key) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `FX pool reconciliation failed for ${key}`,
        details: {
          category: "FX_POOL",
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

  // Check owner-goodId combinations for goods
  for (const key of expectedGoodsByOwnerGoodId.keys()) {
    const result = checkGoodReconciliation(key);
    if (result) return result;
  }
  for (const key of actualGoodsByOwnerGoodId.keys()) {
    if (!expectedGoodsByOwnerGoodId.has(key)) {
      const result = checkGoodReconciliation(key);
      if (result) return result;
    }
  }

  // Check owner for capital
  for (const key of expectedCapitalByOwner.keys()) {
    const result = checkCapitalReconciliation(key);
    if (result) return result;
  }
  for (const key of actualCapitalByOwner.keys()) {
    if (!expectedCapitalByOwner.has(key)) {
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

  // Check FX pool reserves by pool + currency key
  for (const key of expectedFxPoolByCurrency.keys()) {
    const result = checkFxPoolReconciliation(key);
    if (result) return result;
  }
  for (const key of actualFxPoolByCurrency.keys()) {
    if (!expectedFxPoolByCurrency.has(key)) {
      const result = checkFxPoolReconciliation(key);
      if (result) return result;
    }
  }

  return { success: true };
}
