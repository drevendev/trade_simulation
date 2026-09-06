/**
 * Genesis reconciliation and validation (REQ-CONFIG-004).
 *
 * Verifies that opening stocks recorded in WorldGenesisLedger match the
 * constructed tick-0 WorldState within configured tolerances.
 */

import type { WorldGenesisLedger } from "../domain/genesisLedger";
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

/**
 * Reconcile opening stocks: compare ledger-expected totals to actual tick-0 stocks.
 * Verifies conservation within configured tolerances for every tracked category.
 */
export function reconcileGenesisStocks(
  worldState: WorldState,
  ledger: WorldGenesisLedger,
  config: SimulationConfig,
): ReconciliationResult {
  const tolerance = config.numeric.reconciliationRelativeTolerance ?? 1e-9;

  // Compute expected totals per category from ledger
  const expectedMoneyByFormula = new Map<CurrencyId, number>();
  const expectedGoodsByFormula = new Map<GoodId, number>();
  let expectedPopulation = 0;
  let expectedCapital = 0;
  let expectedResources = 0;

  ledger.records.forEach((record) => {
    switch (record.type) {
      case "MONEY_ENDOWMENT":
      case "BOND_OPENING_POSITION":
      case "FX_POOL_OPENING": {
        const current = expectedMoneyByFormula.get(record.currencyId) ?? 0;
        expectedMoneyByFormula.set(record.currencyId, current + record.amount);
        break;
      }
      case "GOOD_ENDOWMENT": {
        const current = expectedGoodsByFormula.get(record.goodId) ?? 0;
        expectedGoodsByFormula.set(record.goodId, current + record.amount);
        break;
      }
      case "POPULATION_ENDOWMENT": {
        expectedPopulation += record.amount;
        break;
      }
      case "CAPITAL_ENDOWMENT": {
        expectedCapital += record.amount;
        break;
      }
      case "RESOURCE_ENDOWMENT": {
        expectedResources += record.amount;
        break;
      }
    }
  });

  // Compute actual totals per category from worldState
  const actualMoneyByFormula = new Map<CurrencyId, number>();
  const actualGoodsByFormula = new Map<GoodId, number>();
  let actualPopulation = 0;
  let actualCapital = 0;
  let actualResources = 0;

  // Sum money from state treasuries, clan treasuries, and authority wallets
  worldState.states.forEach((state) => {
    Object.entries(state.seed.treasury ?? {}).forEach(([currencyKey, amount]) => {
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
    // Sum goods from state public inventory
    Object.entries(state.seed.publicInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);
      }
    });
  });

  worldState.monetaryAuthorities.forEach((authority) => {
    Object.entries(authority.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
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
    // Sum FX pool reserves
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
    Object.entries(clan.seed.treasury ?? {}).forEach(([currencyKey, amount]) => {
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

  worldState.cohorts.forEach((cohort) => {
    // Sum cohort population
    if (cohort.seed.population > 0) {
      actualPopulation += cohort.seed.population;
    }
    // Sum cohort wallet (money)
    Object.entries(cohort.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
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
    // Sum cohort household inventory (goods)
    Object.entries(cohort.seed.householdInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);
      }
    });
  });

  worldState.productionUnits.forEach((pu) => {
    // Sum PU wallet (money)
    Object.entries(pu.seed.wallet ?? {}).forEach(([currencyKey, amount]) => {
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
    // Sum PU inventories (goods)
    Object.entries(pu.seed.inputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);
      }
    });
    Object.entries(pu.seed.outputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);
      }
    });
    Object.entries(pu.seed.investmentInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number") {
        const current = actualGoodsByFormula.get(goodKey as any) ?? 0;
        actualGoodsByFormula.set(goodKey as any, current + amount);
      }
    });
    // Sum installed capital
    if (pu.seed.installedCapital > 0) {
      actualCapital += pu.seed.installedCapital;
    }
  });

  worldState.regions.forEach((region) => {
    // Sum resource endowments
    (region.seed.deposits ?? []).forEach((deposit) => {
      if (deposit.initialQuantity > 0) {
        const current = actualResources ?? 0;
        actualResources = current + deposit.initialQuantity;
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

  return { success: true };
}
