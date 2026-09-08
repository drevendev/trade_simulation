/**
 * Genesis reconciliation and validation (REQ-CONFIG-004).
 *
 * Verifies that opening stocks recorded in WorldGenesisLedger match the
 * constructed tick-0 WorldState within configured tolerances.
 */

import type { WorldGenesisLedger, ActorRef } from "../domain/genesisLedger";
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

function actorRefKey(owner: ActorRef): string {
  if (owner.type === "CLAN") return `CLAN:${owner.clanId}`;
  if (owner.type === "STATE") return `STATE:${owner.stateId}`;
  return `PU:${owner.productionUnitId}`;
}

/**
 * Reconcile opening stocks: compare ledger-expected totals to actual tick-0 stocks.
 * Verifies conservation within configured tolerances for every tracked category,
 * including owner/location-bound validation to catch equal-and-opposite relocations.
 */
export function reconcileGenesisStocks(
  worldState: WorldState,
  ledger: WorldGenesisLedger,
  config: SimulationConfig,
): ReconciliationResult {
  const tolerance = config.numeric.reconciliationRelativeTolerance ?? 1e-9;

  // Build maps for lookups
  const clanKeyToClanId = new Map<string, string>();
  worldState.clans.forEach((clan) => {
    clanKeyToClanId.set(clan.seed.key, String(clan.clanId));
  });

  const regionKeyToRegionId = new Map<string, string>();
  worldState.regions.forEach((region) => {
    regionKeyToRegionId.set(region.seed.key, String(region.regionId));
  });

  // For goods, we'll look them up by key in the ledger records directly
  // since goods are referenced by key in deposits and by id in the ledger

  // Compute expected totals per category from ledger
  // Aggregate totals (for category-level conservation)
  const expectedMoneyByFormula = new Map<CurrencyId, number>();
  const expectedGoodsByFormula = new Map<GoodId, number>();
  let expectedPopulation = 0;
  let expectedCapital = 0;
  let expectedResources = 0;

  // Owner/location-bound totals (to catch equal-and-opposite relocations)
  const expectedMoneyByOwnerCurrency = new Map<string, number>();
  const expectedGoodsByOwnerGood = new Map<string, number>();
  const expectedCapitalByOwner = new Map<string, number>();
  const expectedPopulationByOwnerRegion = new Map<string, number>();
  const expectedResourcesByRegionGood = new Map<string, number>();

  ledger.records.forEach((record) => {
    switch (record.type) {
      case "MONEY_ENDOWMENT": {
        const current = expectedMoneyByFormula.get(record.currencyId) ?? 0;
        expectedMoneyByFormula.set(record.currencyId, current + record.amount);

        // Owner/currency-bound check
        const ownerKey = actorRefKey(record.owner);
        const boundKey = `${ownerKey}:${record.currencyId}`;
        const boundCurrent = expectedMoneyByOwnerCurrency.get(boundKey) ?? 0;
        expectedMoneyByOwnerCurrency.set(boundKey, boundCurrent + record.amount);
        break;
      }
      case "FX_POOL_OPENING": {
        const current = expectedMoneyByFormula.get(record.currencyId) ?? 0;
        expectedMoneyByFormula.set(record.currencyId, current + record.amount);
        break;
      }
      case "BOND_OPENING_POSITION": {
        // Bonds are debt claims/securities, not additional currency stocks.
        // Bond holdings have their own invariant (sum holdings == principal).
        break;
      }
      case "GOOD_ENDOWMENT": {
        const current = expectedGoodsByFormula.get(record.goodId) ?? 0;
        expectedGoodsByFormula.set(record.goodId, current + record.amount);

        // Owner/good-bound check (preserving ProductionUnit ownership)
        const ownerKey = actorRefKey(record.owner);
        const boundKey = `${ownerKey}:${record.goodId}`;
        const boundCurrent = expectedGoodsByOwnerGood.get(boundKey) ?? 0;
        expectedGoodsByOwnerGood.set(boundKey, boundCurrent + record.amount);
        break;
      }
      case "POPULATION_ENDOWMENT": {
        expectedPopulation += record.amount;

        // Owner/region-bound check
        const ownerKey = actorRefKey(record.owner);
        const boundKey = `${ownerKey}:${record.regionId}`;
        const boundCurrent = expectedPopulationByOwnerRegion.get(boundKey) ?? 0;
        expectedPopulationByOwnerRegion.set(boundKey, boundCurrent + record.amount);
        break;
      }
      case "CAPITAL_ENDOWMENT": {
        expectedCapital += record.amount;

        // Owner-bound check
        const ownerKey = actorRefKey(record.owner);
        const boundCurrent = expectedCapitalByOwner.get(ownerKey) ?? 0;
        expectedCapitalByOwner.set(ownerKey, boundCurrent + record.amount);
        break;
      }
      case "RESOURCE_ENDOWMENT": {
        expectedResources += record.amount;

        // Region/good-bound check (resources are region-specific)
        const boundKey = `${record.regionId}:${record.goodId}`;
        const boundCurrent = expectedResourcesByRegionGood.get(boundKey) ?? 0;
        expectedResourcesByRegionGood.set(boundKey, boundCurrent + record.amount);
        break;
      }
    }
  });

  // Compute actual totals per category from worldState
  // Aggregate totals
  const actualMoneyByFormula = new Map<CurrencyId, number>();
  const actualGoodsByFormula = new Map<GoodId, number>();
  let actualPopulation = 0;
  let actualCapital = 0;
  let actualResources = 0;

  // Owner/location-bound actuals
  const actualMoneyByOwnerCurrency = new Map<string, number>();
  const actualGoodsByOwnerGood = new Map<string, number>();
  const actualCapitalByOwner = new Map<string, number>();
  const actualPopulationByOwnerRegion = new Map<string, number>();
  const actualResourcesByRegionGood = new Map<string, number>();

  // Sum money from state treasuries, clan treasuries, and authority wallets
  worldState.states.forEach((state) => {
    const stateKey = `STATE:${state.stateId}`;
    Object.entries(state.seed.treasury ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const current = actualMoneyByFormula.get(currencyId) ?? 0;
          actualMoneyByFormula.set(currencyId, current + amount);

          const boundKey = `${stateKey}:${currencyId}`;
          const boundCurrent = actualMoneyByOwnerCurrency.get(boundKey) ?? 0;
          actualMoneyByOwnerCurrency.set(boundKey, boundCurrent + amount);
        }
      }
    });
    // Sum goods from state public inventory
    Object.entries(state.seed.publicInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);

        const boundKey = `${stateKey}:${goodKey}`;
        const boundCurrent = actualGoodsByOwnerGood.get(boundKey) ?? 0;
        actualGoodsByOwnerGood.set(boundKey, boundCurrent + amount);
      }
    });
  });

  worldState.monetaryAuthorities.forEach((authority) => {
    // The ledger records authority wallet as STATE owner with authority.key as the stateId
    const authorityOwnerKey = `STATE:${authority.seed.key}`;

    Object.entries(authority.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const current = actualMoneyByFormula.get(currencyId) ?? 0;
          actualMoneyByFormula.set(currencyId, current + amount);

          // Track owner-bound: ledger records as STATE owner
          const boundKey = `${authorityOwnerKey}:${currencyId}`;
          const boundCurrent = actualMoneyByOwnerCurrency.get(boundKey) ?? 0;
          actualMoneyByOwnerCurrency.set(boundKey, boundCurrent + amount);
        }
      }
    });
    // Sum FX pool reserves (not owner-bound in ledger, just aggregate)
    (authority.seed.fxPools ?? []).forEach((fxPoolSeed) => {
      Object.entries(fxPoolSeed.cash ?? {}).forEach(([currencyKey, amount]) => {
        if (typeof amount === "number") {
          const currencyId = Array.from(worldState.currencies.entries()).find(
            ([_, cs]) => cs.seed.key === currencyKey,
          )?.[0];
          if (currencyId) {
            const current = actualMoneyByFormula.get(currencyId) ?? 0;
            actualMoneyByFormula.set(currencyId, current + amount);
          }
        }
      });
    });
  });

  worldState.clans.forEach((clan) => {
    const clanKey = `CLAN:${clan.clanId}`;
    Object.entries(clan.seed.treasury ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const current = actualMoneyByFormula.get(currencyId) ?? 0;
          actualMoneyByFormula.set(currencyId, current + amount);

          const boundKey = `${clanKey}:${currencyId}`;
          const boundCurrent = actualMoneyByOwnerCurrency.get(boundKey) ?? 0;
          actualMoneyByOwnerCurrency.set(boundKey, boundCurrent + amount);
        }
      }
    });
  });

  worldState.cohorts.forEach((cohort) => {
    // Determine owner: cohorts are always owned by clans
    const clanId = clanKeyToClanId.get(cohort.seed.clanKey);
    const ownerKey = clanId ? `CLAN:${clanId}` : undefined;

    // Sum cohort population - attribute to its owner (clan)
    if (cohort.seed.population > 0) {
      actualPopulation += cohort.seed.population;
      if (ownerKey) {
        const regionId = regionKeyToRegionId.get(cohort.seed.regionKey);
        if (regionId) {
          const boundKey = `${ownerKey}:${regionId}`;
          const boundCurrent = actualPopulationByOwnerRegion.get(boundKey) ?? 0;
          actualPopulationByOwnerRegion.set(boundKey, boundCurrent + cohort.seed.population);
        }
      }
    }
    // Sum cohort wallet (money) - ledger attributes to the owner (clan)
    Object.entries(cohort.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const current = actualMoneyByFormula.get(currencyId) ?? 0;
          actualMoneyByFormula.set(currencyId, current + amount);

          if (ownerKey) {
            const boundKey = `${ownerKey}:${currencyId}`;
            const boundCurrent = actualMoneyByOwnerCurrency.get(boundKey) ?? 0;
            actualMoneyByOwnerCurrency.set(boundKey, boundCurrent + amount);
          }
        }
      }
    });
    // Sum cohort household inventory (goods) - ledger attributes to the owner (clan)
    Object.entries(cohort.seed.householdInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);

        if (ownerKey) {
          const boundKey = `${ownerKey}:${goodKey}`;
          const boundCurrent = actualGoodsByOwnerGood.get(boundKey) ?? 0;
          actualGoodsByOwnerGood.set(boundKey, boundCurrent + amount);
        }
      }
    });
  });

  worldState.productionUnits.forEach((pu) => {
    const puKey = `PU:${pu.productionUnitId}`;
    // Sum PU wallet (money)
    Object.entries(pu.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number") {
        const currencyId = Array.from(worldState.currencies.entries()).find(
          ([_, cs]) => cs.seed.key === currencyKey,
        )?.[0];
        if (currencyId) {
          const current = actualMoneyByFormula.get(currencyId) ?? 0;
          actualMoneyByFormula.set(currencyId, current + amount);

          const boundKey = `${puKey}:${currencyId}`;
          const boundCurrent = actualMoneyByOwnerCurrency.get(boundKey) ?? 0;
          actualMoneyByOwnerCurrency.set(boundKey, boundCurrent + amount);
        }
      }
    });
    // Sum PU inventories (goods)
    Object.entries(pu.seed.inputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);

        const boundKey = `${puKey}:${goodKey}`;
        const boundCurrent = actualGoodsByOwnerGood.get(boundKey) ?? 0;
        actualGoodsByOwnerGood.set(boundKey, boundCurrent + amount);
      }
    });
    Object.entries(pu.seed.outputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);

        const boundKey = `${puKey}:${goodKey}`;
        const boundCurrent = actualGoodsByOwnerGood.get(boundKey) ?? 0;
        actualGoodsByOwnerGood.set(boundKey, boundCurrent + amount);
      }
    });
    Object.entries(pu.seed.investmentInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);

        const boundKey = `${puKey}:${goodKey}`;
        const boundCurrent = actualGoodsByOwnerGood.get(boundKey) ?? 0;
        actualGoodsByOwnerGood.set(boundKey, boundCurrent + amount);
      }
    });
    // Sum installed capital
    if (pu.seed.installedCapital > 0) {
      actualCapital += pu.seed.installedCapital;

      const boundCurrent = actualCapitalByOwner.get(puKey) ?? 0;
      actualCapitalByOwner.set(puKey, boundCurrent + pu.seed.installedCapital);
    }
  });

  worldState.regions.forEach((region) => {
    // Sum resource endowments
    (region.seed.deposits ?? []).forEach((deposit) => {
      if (deposit.initialQuantity > 0) {
        const current = actualResources ?? 0;
        actualResources = current + deposit.initialQuantity;

        // Use resourceId (same as goodId in ledger) for the bound key
        const boundKey = `${region.regionId}:${deposit.resourceId}`;
        const boundCurrent = actualResourcesByRegionGood.get(boundKey) ?? 0;
        actualResourcesByRegionGood.set(boundKey, boundCurrent + deposit.initialQuantity);
      }
    });
  });

  // Check each category for reconciliation within tolerance
  const checkMoneyReconciliation = (currencyId: CurrencyId) => {
    const expected = expectedMoneyByFormula.get(currencyId) ?? 0;
    const actual = actualMoneyByFormula.get(currencyId) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Money reconciliation failed for currency ${currencyId}`,
        details: {
          category: "MONEY",
          key: String(currencyId),
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  const checkGoodReconciliation = (goodId: GoodId) => {
    const expected = expectedGoodsByFormula.get(goodId) ?? 0;
    const actual = actualGoodsByFormula.get(goodId) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Good reconciliation failed for ${goodId}`,
        details: {
          category: "GOOD",
          key: String(goodId),
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  // Check money reconciliation for all currencies
  for (const currencyId of expectedMoneyByFormula.keys()) {
    const result = checkMoneyReconciliation(currencyId);
    if (result) return result;
  }
  for (const currencyId of actualMoneyByFormula.keys()) {
    if (!expectedMoneyByFormula.has(currencyId)) {
      const result = checkMoneyReconciliation(currencyId);
      if (result) return result;
    }
  }

  // Check goods reconciliation for all goods
  for (const goodId of expectedGoodsByFormula.keys()) {
    const result = checkGoodReconciliation(goodId);
    if (result) return result;
  }
  for (const goodId of actualGoodsByFormula.keys()) {
    if (!expectedGoodsByFormula.has(goodId)) {
      const result = checkGoodReconciliation(goodId);
      if (result) return result;
    }
  }

  // Check population reconciliation
  const popResidual = Math.abs(expectedPopulation - actualPopulation);
  const popTolerance = tolerance * Math.max(Math.abs(expectedPopulation), Math.abs(actualPopulation), 1);
  if (popResidual > popTolerance) {
    return {
      success: false,
      errorMessage: `Population reconciliation failed`,
      details: {
        category: "POPULATION",
        key: "total",
        expected: expectedPopulation,
        actual: actualPopulation,
        tolerance: popTolerance,
        residual: popResidual,
      },
    };
  }

  // Check capital reconciliation
  const capResidual = Math.abs(expectedCapital - actualCapital);
  const capTolerance = tolerance * Math.max(Math.abs(expectedCapital), Math.abs(actualCapital), 1);
  if (capResidual > capTolerance) {
    return {
      success: false,
      errorMessage: `Capital reconciliation failed`,
      details: {
        category: "CAPITAL",
        key: "total",
        expected: expectedCapital,
        actual: actualCapital,
        tolerance: capTolerance,
        residual: capResidual,
      },
    };
  }

  // Check resources reconciliation
  const resResidual = Math.abs(expectedResources - actualResources);
  const resTolerance = tolerance * Math.max(Math.abs(expectedResources), Math.abs(actualResources), 1);
  if (resResidual > resTolerance) {
    return {
      success: false,
      errorMessage: `Resource reconciliation failed`,
      details: {
        category: "RESOURCE",
        key: "total",
        expected: expectedResources,
        actual: actualResources,
        tolerance: resTolerance,
        residual: resResidual,
      },
    };
  }

  // Owner/location-bound reconciliation checks to catch equal-and-opposite relocations
  const checkMoneyByOwnerCurrency = (ownerCurrencyKey: string) => {
    const expected = expectedMoneyByOwnerCurrency.get(ownerCurrencyKey) ?? 0;
    const actual = actualMoneyByOwnerCurrency.get(ownerCurrencyKey) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Money reconciliation failed for owner/currency ${ownerCurrencyKey}`,
        details: {
          category: "MONEY_OWNER_BOUND",
          key: ownerCurrencyKey,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  const checkGoodByOwnerGood = (ownerGoodKey: string) => {
    const expected = expectedGoodsByOwnerGood.get(ownerGoodKey) ?? 0;
    const actual = actualGoodsByOwnerGood.get(ownerGoodKey) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Good reconciliation failed for owner/good ${ownerGoodKey}`,
        details: {
          category: "GOOD_OWNER_BOUND",
          key: ownerGoodKey,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  const checkCapitalByOwner = (ownerKey: string) => {
    const expected = expectedCapitalByOwner.get(ownerKey) ?? 0;
    const actual = actualCapitalByOwner.get(ownerKey) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Capital reconciliation failed for owner ${ownerKey}`,
        details: {
          category: "CAPITAL_OWNER_BOUND",
          key: ownerKey,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  const checkPopulationByOwnerRegion = (ownerRegionKey: string) => {
    const expected = expectedPopulationByOwnerRegion.get(ownerRegionKey) ?? 0;
    const actual = actualPopulationByOwnerRegion.get(ownerRegionKey) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Population reconciliation failed for owner/region ${ownerRegionKey}`,
        details: {
          category: "POPULATION_OWNER_BOUND",
          key: ownerRegionKey,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  const checkResourceByRegionGood = (regionGoodKey: string) => {
    const expected = expectedResourcesByRegionGood.get(regionGoodKey) ?? 0;
    const actual = actualResourcesByRegionGood.get(regionGoodKey) ?? 0;
    const residual = Math.abs(expected - actual);
    const relativeTolerance = tolerance * Math.max(Math.abs(expected), Math.abs(actual), 1);

    if (residual > relativeTolerance) {
      return {
        success: false,
        errorMessage: `Resource reconciliation failed for region/good ${regionGoodKey}`,
        details: {
          category: "RESOURCE_LOCATION_BOUND",
          key: regionGoodKey,
          expected,
          actual,
          tolerance: relativeTolerance,
          residual,
        },
      };
    }
    return null;
  };

  // Check all owner/currency money combinations
  const allOwnerCurrencyKeys = new Set([
    ...expectedMoneyByOwnerCurrency.keys(),
    ...actualMoneyByOwnerCurrency.keys(),
  ]);
  for (const key of allOwnerCurrencyKeys) {
    const result = checkMoneyByOwnerCurrency(key);
    if (result) return result;
  }

  // Check all owner/good combinations
  const allOwnerGoodKeys = new Set([...expectedGoodsByOwnerGood.keys(), ...actualGoodsByOwnerGood.keys()]);
  for (const key of allOwnerGoodKeys) {
    const result = checkGoodByOwnerGood(key);
    if (result) return result;
  }

  // Check all owner capital combinations
  const allOwnerKeys = new Set([...expectedCapitalByOwner.keys(), ...actualCapitalByOwner.keys()]);
  for (const key of allOwnerKeys) {
    const result = checkCapitalByOwner(key);
    if (result) return result;
  }

  // Check all owner/region population combinations
  const allOwnerRegionKeys = new Set([
    ...expectedPopulationByOwnerRegion.keys(),
    ...actualPopulationByOwnerRegion.keys(),
  ]);
  for (const key of allOwnerRegionKeys) {
    const result = checkPopulationByOwnerRegion(key);
    if (result) return result;
  }

  // Check all region/good resource combinations
  const allRegionGoodKeys = new Set([
    ...expectedResourcesByRegionGood.keys(),
    ...actualResourcesByRegionGood.keys(),
  ]);
  for (const key of allRegionGoodKeys) {
    const result = checkResourceByRegionGood(key);
    if (result) return result;
  }

  return { success: true };
}
