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

    it("bond opening records do not affect money reconciliation", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Get a currency and a clan from the world state
      const currencyId = Array.from(worldState.currencies.keys())[0];
      const clanId = Array.from(worldState.clans.keys())[0];
      expect(currencyId).toBeDefined();
      expect(clanId).toBeDefined();
      if (!currencyId || !clanId) return;

      // Create a modified ledger with an additional bond opening record
      const bondRecord: GenesisRecord = {
        type: "BOND_OPENING_POSITION",
        owner: { type: "CLAN", clanId },
        currencyId,
        amount: 1000,
        sourceSeedKey: "test-bond",
      };
      const modifiedRecords = [...worldState.worldGenesisLedger.records, bondRecord];
      const modifiedLedger = { records: modifiedRecords };

      // Reconciliation should succeed because bond opening is separate from money reconciliation
      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(true);
    });

    it("fails when money is moved from one owner to another (owner-bound check)", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two states with treasuries
      const statesWithTreasury = Array.from(worldState.states.values()).filter(
        (s) => s.seed.treasury && Object.keys(s.seed.treasury).length > 0,
      );
      expect(statesWithTreasury.length).toBeGreaterThanOrEqual(2);
      if (statesWithTreasury.length < 2) return;

      const state1 = statesWithTreasury[0]!;
      const state2 = statesWithTreasury[1]!;
      const currencyKey = Object.keys(state1.seed.treasury ?? {})[0];
      expect(currencyKey).toBeDefined();
      if (!currencyKey) return;

      const amount = (state1.seed.treasury as Record<string, number>)[currencyKey] ?? 100;

      // Modify world state: move money from state1 to state2
      const modifiedStates = new Map(worldState.states);
      const modifiedState1 = {
        ...state1,
        seed: {
          ...state1.seed,
          treasury: {
            ...(state1.seed.treasury ?? {}),
            [currencyKey]: 0, // Remove from state1
          },
        },
      };
      const modifiedState2 = {
        ...state2,
        seed: {
          ...state2.seed,
          treasury: {
            ...(state2.seed.treasury ?? {}),
            [currencyKey]: ((state2.seed.treasury as Record<string, number>)?.[currencyKey] ?? 0) + amount,
          },
        },
      };
      modifiedStates.set(state1.stateId, modifiedState1);
      modifiedStates.set(state2.stateId, modifiedState2);

      const modifiedWorldState = {
        ...worldState,
        states: modifiedStates,
      };

      // Reconciliation should fail due to owner-bound check (even though aggregate is correct)
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toMatch(/MONEY|OWNER/);
    });

    it("fails when a good is moved from one owner to another (owner-bound check)", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find states and clans with inventory
      const statesWithGoods = Array.from(worldState.states.values()).filter(
        (s) => s.seed.publicInventory && Object.keys(s.seed.publicInventory).length > 0,
      );
      const clansWithGoods = Array.from(worldState.clans.values()).filter(
        (c) => c.seed.treasury && Object.keys(c.seed.treasury).length > 0,
      );

      if (statesWithGoods.length === 0) {
        expect(statesWithGoods.length).toBeGreaterThan(0);
        return;
      }

      const state = statesWithGoods[0]!;
      const goodKey = Object.keys(state.seed.publicInventory ?? {})[0];
      expect(goodKey).toBeDefined();
      if (!goodKey) return;

      const goodAmount = (state.seed.publicInventory as Record<string, number>)[goodKey] ?? 100;

      // Move good from state to a clan
      const clan = clansWithGoods[0] ?? Array.from(worldState.clans.values())[0];
      expect(clan).toBeDefined();
      if (!clan) return;

      const modifiedStates = new Map(worldState.states);
      const modifiedState = {
        ...state,
        seed: {
          ...state.seed,
          publicInventory: {
            ...(state.seed.publicInventory ?? {}),
            [goodKey]: 0,
          },
        },
      };
      modifiedStates.set(state.stateId, modifiedState);

      const modifiedClans = new Map(worldState.clans);
      const modifiedClan = {
        ...clan,
        seed: {
          ...clan.seed,
          treasury: {
            ...(clan.seed.treasury ?? {}),
            [goodKey]: ((clan.seed.treasury as Record<string, number>)?.[goodKey] ?? 0) + goodAmount,
          },
        },
      };
      modifiedClans.set(clan.clanId, modifiedClan);

      const modifiedWorldState = {
        ...worldState,
        states: modifiedStates,
        clans: modifiedClans,
      };

      // Reconciliation should fail due to owner-bound check
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toMatch(/GOOD|OWNER/);
    });

    it("fails when capital is moved from one production unit to another (owner-bound check)", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two production units with capital
      const pusWithCapital = Array.from(worldState.productionUnits.values()).filter((pu) => pu.seed.installedCapital > 0);
      expect(pusWithCapital.length).toBeGreaterThanOrEqual(2);
      if (pusWithCapital.length < 2) return;

      const pu1 = pusWithCapital[0]!;
      const pu2 = pusWithCapital[1]!;
      const transferAmount = Math.min(pu1.seed.installedCapital / 2, 10);

      // Move capital from pu1 to pu2
      const modifiedPUs = new Map(worldState.productionUnits);
      const modifiedPU1 = {
        ...pu1,
        seed: {
          ...pu1.seed,
          installedCapital: pu1.seed.installedCapital - transferAmount,
        },
      };
      const modifiedPU2 = {
        ...pu2,
        seed: {
          ...pu2.seed,
          installedCapital: pu2.seed.installedCapital + transferAmount,
        },
      };
      modifiedPUs.set(pu1.productionUnitId, modifiedPU1);
      modifiedPUs.set(pu2.productionUnitId, modifiedPU2);

      const modifiedWorldState = {
        ...worldState,
        productionUnits: modifiedPUs,
      };

      // Reconciliation should fail due to owner-bound check
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toMatch(/CAPITAL|OWNER/);
    });

    it("fails when population is moved between different owner/region combinations (owner-bound check)", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two cohorts with population
      const cohortsWithPop = Array.from(worldState.cohorts.values()).filter((c) => c.seed.population > 0);
      expect(cohortsWithPop.length).toBeGreaterThanOrEqual(2);
      if (cohortsWithPop.length < 2) return;

      const cohortA = cohortsWithPop[0]!;
      const cohortB = cohortsWithPop[1]!;
      const transferPop = Math.min(cohortA.seed.population / 2, 5);

      // Move population from cohortA to cohortB (they may be in same/different regions but different cohorts)
      const modifiedCohorts = new Map(worldState.cohorts);
      const modifiedCohortA = {
        ...cohortA,
        seed: {
          ...cohortA.seed,
          population: cohortA.seed.population - transferPop,
        },
      };
      const modifiedCohortB = {
        ...cohortB,
        seed: {
          ...cohortB.seed,
          population: cohortB.seed.population + transferPop,
        },
      };
      modifiedCohorts.set(cohortA.cohortId, modifiedCohortA);
      modifiedCohorts.set(cohortB.cohortId, modifiedCohortB);

      const modifiedWorldState = {
        ...worldState,
        cohorts: modifiedCohorts,
      };

      // Reconciliation should fail due to owner-bound check (population recorded per cohort)
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toMatch(/POPULATION|OWNER/);
    });

    it("fails when resources are moved between regions (location-bound check)", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two regions with deposits
      const regionsWithDeposits = Array.from(worldState.regions.values()).filter(
        (r) => r.seed.deposits && r.seed.deposits.length > 0,
      );
      expect(regionsWithDeposits.length).toBeGreaterThanOrEqual(2);
      if (regionsWithDeposits.length < 2) return;

      const region1 = regionsWithDeposits[0]!;
      const region2 = regionsWithDeposits[1]!;
      const deposit1 = region1.seed.deposits![0];
      const deposit2 = region2.seed.deposits![0];
      expect(deposit1).toBeDefined();
      expect(deposit2).toBeDefined();
      if (!deposit1 || !deposit2) return;

      // Move a deposit from region1 to region2
      const transferAmount = Math.min(deposit1.initialQuantity / 2, 5);
      const modifiedRegions = new Map(worldState.regions);
      const modifiedRegion1 = {
        ...region1,
        seed: {
          ...region1.seed,
          deposits: (region1.seed.deposits ?? []).map((d) =>
            d === deposit1
              ? { ...d, initialQuantity: d.initialQuantity - transferAmount }
              : d,
          ),
        },
      };
      const modifiedRegion2 = {
        ...region2,
        seed: {
          ...region2.seed,
          deposits: (region2.seed.deposits ?? []).map((d) =>
            d === deposit2
              ? { ...d, initialQuantity: d.initialQuantity + transferAmount }
              : d,
          ),
        },
      };
      modifiedRegions.set(region1.regionId, modifiedRegion1);
      modifiedRegions.set(region2.regionId, modifiedRegion2);

      const modifiedWorldState = {
        ...worldState,
        regions: modifiedRegions,
      };

      // Reconciliation should fail due to location-bound check
      const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toMatch(/RESOURCE|LOCATION/);
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
