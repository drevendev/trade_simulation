import { describe, it, expect } from "vitest";
import { buildInitialWorld, type WorldState } from "./worldState";
import { reconcileGenesisStocks } from "./genesisReconciliation";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type { SimulationConfig } from "../config/simulationConfig";
import { addGenesisRecord, createEmptyWorldGenesisLedger, type GenesisRecord } from "../domain/genesisLedger";

function createTestConfig(): SimulationConfig {
  return {
    configVersion: "1.0.0",
    numeric: {
      moneyEpsilon: 1e-9,
      quantityEpsilon: 1e-9,
      populationEpsilon: 1e-6,
      rateEpsilon: 1e-12,
      reconciliationRelativeTolerance: 1e-9,
      maxFiniteMagnitude: 1e15,
    },
    cadence: {
      productionLifecycleReviewEveryTicks: 3,
      investmentReviewEveryTicks: 3,
      clanDistributionEveryTicks: 3,
      fiscalPolicyReviewEveryTicks: 3,
      monetaryPolicyReviewEveryTicks: 1,
      expansionReviewEveryTicks: 3,
      stateFormationReviewEveryTicks: 6,
    },
    markets: {
      shortageSignalWeight: 0.5,
      inventorySignalWeight: 0.5,
      basePriceAdjustmentSpeed: 0.1,
      maxAbsoluteLogPriceMovePerTick: 0.1,
      minimumPrice: 0.01,
      maximumPrice: 1000,
      targetInventoryCoverageTicks: 1.0,
      expectationAlpha: 0.1,
    },
    trade: {},
    production: {},
    labor: {},
    population: {},
    clans: {},
    fiscal: {},
    monetary: {},
    expansion: {},
    events: {},
    performance: {},
  };
}

describe("reconcileGenesisStocks", () => {
  describe("positive tests", () => {
    it("baseline-multistate-v1 scenario reconciles successfully", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      expect(worldState).toBeDefined();
      expect(worldState.worldGenesisLedger.records.length).toBeGreaterThan(0);
    });
  });

  describe("negative tests", () => {
    it("fails when a ledger money record is removed", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find a money endowment record to remove
      const moneyRecordIndex = worldState.worldGenesisLedger.records.findIndex(
        (r) => r.type === "MONEY_ENDOWMENT",
      );
      expect(moneyRecordIndex).toBeGreaterThanOrEqual(0);

      // Create a modified ledger without the record
      const modifiedRecords = [
        ...worldState.worldGenesisLedger.records.slice(0, moneyRecordIndex),
        ...worldState.worldGenesisLedger.records.slice(moneyRecordIndex + 1),
      ];
      const modifiedLedger = { records: modifiedRecords };

      // Reconciliation should fail
      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("MONEY");
      expect(result.details?.expected).not.toEqual(result.details?.actual);
      expect(result.details?.residual).toBeGreaterThan(0);
    });

    it("fails when a ledger money record is duplicated", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find a money endowment record to duplicate
      const moneyRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "MONEY_ENDOWMENT",
      );
      expect(moneyRecord).toBeDefined();
      if (!moneyRecord) return;

      // Create a modified ledger with the record duplicated
      const modifiedRecords = [...worldState.worldGenesisLedger.records, moneyRecord];
      const modifiedLedger = { records: modifiedRecords };

      // Reconciliation should fail
      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("MONEY");
      expect(result.details?.expected).toBeDefined();
      expect(result.details?.actual).toBeDefined();
      if (result.details?.expected !== undefined && result.details?.actual !== undefined) {
        expect(result.details.expected).toBeGreaterThan(result.details.actual);
      }
      expect(result.details?.residual).toBeGreaterThan(0);
    });

    it("fails when a ledger good record is removed", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find a good endowment record to remove
      const goodRecordIndex = worldState.worldGenesisLedger.records.findIndex(
        (r) => r.type === "GOOD_ENDOWMENT",
      );
      if (goodRecordIndex < 0) {
        // Skip if no good records
        expect(goodRecordIndex).toBeGreaterThanOrEqual(0);
        return;
      }

      // Create a modified ledger without the record
      const modifiedRecords = [
        ...worldState.worldGenesisLedger.records.slice(0, goodRecordIndex),
        ...worldState.worldGenesisLedger.records.slice(goodRecordIndex + 1),
      ];
      const modifiedLedger = { records: modifiedRecords };

      // Reconciliation should fail
      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
      expect(result.details?.residual).toBeGreaterThan(0);
    });

    it("fails when state treasury is perturbed after ledger was created", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Create a modified world state with altered state treasury
      const modifiedStates = new Map(worldState.states);
      const firstState = Array.from(modifiedStates.values())[0];
      if (firstState && firstState.seed.treasury) {
        const treasuryKeys = Object.keys(firstState.seed.treasury);
        if (treasuryKeys.length > 0) {
          const firstKey = treasuryKeys[0]!;
          const treasuryVal = (firstState.seed.treasury as Record<string, number>)[firstKey];
          const modifiedState = {
            ...firstState,
            seed: {
              ...firstState.seed,
              treasury: {
                ...(firstState.seed.treasury ?? {}),
                [firstKey]: (treasuryVal ?? 0) + 100,
              },
            },
          };
          modifiedStates.set(firstState.stateId, modifiedState);
        }
      }

      const modifiedWorldState = {
        ...worldState,
        states: modifiedStates,
      };

      // Reconciliation should fail
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("MONEY");
      expect(result.details?.actual).toBeDefined();
      expect(result.details?.expected).toBeDefined();
      if (result.details?.actual !== undefined && result.details?.expected !== undefined) {
        expect(result.details.actual).toBeGreaterThan(result.details.expected);
      }
    });

    it("fails when population is removed from cohort after ledger was created", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find a cohort with population
      const cohortWithPop = Array.from(worldState.cohorts.values()).find((c) => c.seed.population > 0);
      expect(cohortWithPop).toBeDefined();
      if (!cohortWithPop) return;

      // Create a modified world state with reduced cohort population
      const modifiedCohorts = new Map(worldState.cohorts);
      const modifiedCohort = {
        ...cohortWithPop,
        seed: {
          ...cohortWithPop.seed,
          population: cohortWithPop.seed.population / 2,
        },
      };
      modifiedCohorts.set(cohortWithPop.cohortId, modifiedCohort);

      const modifiedWorldState = {
        ...worldState,
        cohorts: modifiedCohorts,
      };

      // Reconciliation should fail for population
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("POPULATION");
      expect(result.details?.actual).toBeDefined();
      expect(result.details?.expected).toBeDefined();
      if (result.details?.actual !== undefined && result.details?.expected !== undefined) {
        expect(result.details.actual).toBeLessThan(result.details.expected);
      }
    });

    it("fails when production unit inventory is reduced after ledger was created", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find a production unit with inventory
      const puWithInventory = Array.from(worldState.productionUnits.values()).find(
        (pu) => pu.seed.inputInventory && Object.keys(pu.seed.inputInventory).length > 0,
      );
      expect(puWithInventory).toBeDefined();
      if (!puWithInventory || !puWithInventory.seed.inputInventory) return;

      // Create a modified world state with reduced production unit inventory
      const modifiedPUs = new Map(worldState.productionUnits);
      const inventoryKeys = Object.keys(puWithInventory.seed.inputInventory);
      const firstKey = inventoryKeys[0];
      if (firstKey !== undefined) {
        const invVal = (puWithInventory.seed.inputInventory as Record<string, number>)[firstKey];
        const modifiedPU = {
          ...puWithInventory,
          seed: {
            ...puWithInventory.seed,
            inputInventory: {
              ...puWithInventory.seed.inputInventory,
              [firstKey]: (invVal ?? 0) / 2,
            },
          },
        };
        modifiedPUs.set(puWithInventory.productionUnitId, modifiedPU);
      }

      const modifiedWorldState = {
        ...worldState,
        productionUnits: modifiedPUs,
      };

      // Reconciliation should fail for goods
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
      expect(result.details?.actual).toBeDefined();
      expect(result.details?.expected).toBeDefined();
      if (result.details?.actual !== undefined && result.details?.expected !== undefined) {
        expect(result.details.actual).toBeLessThan(result.details.expected);
      }
    });

    it("fails when capital is removed after ledger was created", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find a production unit with capital
      const puWithCapital = Array.from(worldState.productionUnits.values()).find(
        (pu) => pu.seed.installedCapital > 0,
      );
      expect(puWithCapital).toBeDefined();
      if (!puWithCapital) return;

      // Create a modified world state with reduced capital
      const modifiedPUs = new Map(worldState.productionUnits);
      const modifiedPU = {
        ...puWithCapital,
        seed: {
          ...puWithCapital.seed,
          installedCapital: puWithCapital.seed.installedCapital / 2,
        },
      };
      modifiedPUs.set(puWithCapital.productionUnitId, modifiedPU);

      const modifiedWorldState = {
        ...worldState,
        productionUnits: modifiedPUs,
      };

      // Reconciliation should fail for capital
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("CAPITAL");
      expect(result.details?.actual).toBeDefined();
      expect(result.details?.expected).toBeDefined();
      if (result.details?.actual !== undefined && result.details?.expected !== undefined) {
        expect(result.details.actual).toBeLessThan(result.details.expected);
      }
    });

    it("fails when resources are removed after ledger was created", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find a region with deposits
      const regionWithDeposits = Array.from(worldState.regions.values()).find(
        (r) => r.seed.deposits && r.seed.deposits.length > 0,
      );
      expect(regionWithDeposits).toBeDefined();
      if (!regionWithDeposits) return;

      // Create a modified world state with reduced deposits
      const modifiedRegions = new Map(worldState.regions);
      const modifiedRegion = {
        ...regionWithDeposits,
        seed: {
          ...regionWithDeposits.seed,
          deposits: (regionWithDeposits.seed.deposits ?? []).map((d) => ({
            ...d,
            initialQuantity: d.initialQuantity / 2,
          })),
        },
      };
      modifiedRegions.set(regionWithDeposits.regionId, modifiedRegion);

      const modifiedWorldState = {
        ...worldState,
        regions: modifiedRegions,
      };

      // Reconciliation should fail for resources
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("RESOURCE");
      expect(result.details?.actual).toBeDefined();
      expect(result.details?.expected).toBeDefined();
      if (result.details?.actual !== undefined && result.details?.expected !== undefined) {
        expect(result.details.actual).toBeLessThan(result.details.expected);
      }
    });
  });

  describe("diagnostic output", () => {
    it("includes category, key, expected, actual, and residual in failure details", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Remove a money record
      const moneyRecordIndex = worldState.worldGenesisLedger.records.findIndex(
        (r) => r.type === "MONEY_ENDOWMENT",
      );
      if (moneyRecordIndex < 0) {
        expect(moneyRecordIndex).toBeGreaterThanOrEqual(0);
        return;
      }

      const modifiedRecords = [
        ...worldState.worldGenesisLedger.records.slice(0, moneyRecordIndex),
        ...worldState.worldGenesisLedger.records.slice(moneyRecordIndex + 1),
      ];
      const modifiedLedger = { records: modifiedRecords };

      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);

      expect(result.success).toBe(false);
      expect(result.details).toBeDefined();
      expect(result.details?.category).toBe("MONEY");
      expect(typeof result.details?.key).toBe("string");
      expect(typeof result.details?.expected).toBe("number");
      expect(typeof result.details?.actual).toBe("number");
      expect(typeof result.details?.tolerance).toBe("number");
      expect(typeof result.details?.residual).toBe("number");
    });
  });
});
