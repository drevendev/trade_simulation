import { describe, it, expect } from "vitest";
import { buildInitialWorld, type WorldState } from "./worldState";
import { reconcileGenesisStocks } from "./genesisReconciliation";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type { SimulationConfig } from "../config/simulationConfig";
import {
  addGenesisRecord,
  createEmptyWorldGenesisLedger,
  type GenesisRecord,
  type InventoryBucket,
} from "../domain/genesisLedger";
import type { GoodId } from "../domain/id";

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

/**
 * A ProductionUnit-owned opening goods stock. This is the only GenesisRecord member that
 * carries a required `inventoryBucket`, so extracting on that field selects it exactly.
 */
type ProductionUnitGoodEndowment = Extract<
  GenesisRecord,
  { type: "GOOD_ENDOWMENT"; inventoryBucket: InventoryBucket }
>;

function isProductionUnitGoodEndowment(record: GenesisRecord): record is ProductionUnitGoodEndowment {
  return record.type === "GOOD_ENDOWMENT" && record.owner.type === "PRODUCTION_UNIT";
}

/**
 * An opening goods stock held in an inventory that is not a ProductionUnit bucket — a
 * Cohort's household inventory or a State's public inventory. These carry no
 * `inventoryBucket`, which is what distinguishes the member.
 */
type UnbucketedGoodEndowment = Extract<
  GenesisRecord,
  { type: "GOOD_ENDOWMENT"; inventoryBucket?: undefined }
>;

/**
 * Total recorded resource quantity, used by the typed-identity negative controls to
 * show they change only which stock a record names, never how much is recorded.
 */
function totalResourceQuantity(records: readonly GenesisRecord[]): number {
  return records
    .filter((r) => r.type === "RESOURCE_ENDOWMENT")
    .reduce((sum, r) => sum + r.amount, 0);
}

/**
 * Total recorded population, used by the typed-region negative control to show it
 * changes only which Region a cohort's population is recorded in, never how many people
 * are recorded.
 */
function totalPopulation(records: readonly GenesisRecord[]): number {
  return records
    .filter((r) => r.type === "POPULATION_ENDOWMENT")
    .reduce((sum, r) => sum + r.amount, 0);
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

    it("attributes cohort opening money/goods/population to the cohort itself, not its Clan", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const cohortSeedKeys = new Set(Array.from(worldState.cohorts.values(), (c) => c.seed.key));

      let sawCohortOwnedMoney = false;
      let sawCohortOwnedGoods = false;
      let sawCohortOwnedPopulation = false;
      worldState.worldGenesisLedger.records.forEach((r) => {
        const belongsToACohort = Array.from(cohortSeedKeys).some((key) => r.sourceSeedKey.startsWith(`${key}.`));
        if (!belongsToACohort) return;

        if (r.type === "MONEY_ENDOWMENT" && r.sourceSeedKey.includes(".wallet.")) {
          expect(r.owner.type).toBe("COHORT");
          sawCohortOwnedMoney = true;
        }
        if (r.type === "GOOD_ENDOWMENT" && r.sourceSeedKey.includes(".householdInventory.")) {
          expect(r.owner.type).toBe("COHORT");
          sawCohortOwnedGoods = true;
        }
        if (r.type === "POPULATION_ENDOWMENT" && r.sourceSeedKey.includes(".population")) {
          expect(r.owner.type).toBe("COHORT");
          sawCohortOwnedPopulation = true;
        }
      });
      expect(sawCohortOwnedMoney).toBe(true);
      expect(sawCohortOwnedGoods).toBe(true);
      expect(sawCohortOwnedPopulation).toBe(true);
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

      // Find a production unit with live authoritative capital.
      const puWithCapital = Array.from(worldState.productionUnits.values()).find(
        (pu) => pu.installedCapital > 0,
      );
      expect(puWithCapital).toBeDefined();
      if (!puWithCapital) return;

      // Create a modified world state with reduced live capital. The scenario seed is
      // immutable genesis provenance and must not remain the reconciliation authority.
      const modifiedPUs = new Map(worldState.productionUnits);
      const modifiedPU = {
        ...puWithCapital,
        installedCapital: puWithCapital.installedCapital / 2,
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

    it("fails when money is moved from one owner to another while keeping currency total unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two state money records for the same currency
      const moneyRecords = worldState.worldGenesisLedger.records.filter(
        (r) => r.type === "MONEY_ENDOWMENT"
      );
      const moneyByOwnerCurrency = new Map<string, GenesisRecord[]>();
      moneyRecords.forEach((r) => {
        if (r.type === "MONEY_ENDOWMENT" && r.owner && r.currencyId) {
          const key = `${JSON.stringify(r.owner)}-${r.currencyId}`;
          if (!moneyByOwnerCurrency.has(key)) {
            moneyByOwnerCurrency.set(key, []);
          }
          moneyByOwnerCurrency.get(key)!.push(r);
        }
      });

      // Find two different owners for the same currency to swap money between them
      const currencyKeys = new Map<string, GenesisRecord[]>();
      moneyRecords.forEach((r) => {
        if (r.type === "MONEY_ENDOWMENT" && r.currencyId) {
          const key = String(r.currencyId);
          if (!currencyKeys.has(key)) {
            currencyKeys.set(key, []);
          }
          currencyKeys.get(key)!.push(r);
        }
      });

      // Find a currency with at least 2 different owners
      let record1: GenesisRecord | undefined;
      let record2: GenesisRecord | undefined;
      for (const records of currencyKeys.values()) {
        if (records.length >= 2) {
          record1 = records[0];
          record2 = records[1];
          break;
        }
      }

      if (!record1 || !record2 || record1.type !== "MONEY_ENDOWMENT" || record2.type !== "MONEY_ENDOWMENT") {
        // Skip if scenario doesn't have multiple owners of same currency
        expect(record1).toBeDefined();
        return;
      }

      // Swap amounts between the two owners: subtract from record1, add to record2
      const swapAmount = Math.min(record1.amount, record2.amount) * 0.5;

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) => {
        if (r === record1) {
          return { ...r, amount: r.amount - swapAmount };
        }
        if (r === record2) {
          return { ...r, amount: r.amount + swapAmount };
        }
        return r;
      });

      const modifiedLedger = { records: modifiedRecords };

      // Reconciliation should fail because we've moved money from one owner to another
      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("MONEY");
    });

    it("fails when goods are moved from one owner to another while keeping good total unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two good records for the same good with different owners
      const goodRecords = worldState.worldGenesisLedger.records.filter(
        (r) => r.type === "GOOD_ENDOWMENT"
      );
      const goodByOwnerGoodId = new Map<string, GenesisRecord[]>();
      goodRecords.forEach((r) => {
        if (r.type === "GOOD_ENDOWMENT" && r.owner && r.goodId) {
          const key = `${JSON.stringify(r.owner)}-${r.goodId}`;
          if (!goodByOwnerGoodId.has(key)) {
            goodByOwnerGoodId.set(key, []);
          }
          goodByOwnerGoodId.get(key)!.push(r);
        }
      });

      // Find good IDs that have multiple owners
      const goodIds = new Map<string, GenesisRecord[]>();
      goodRecords.forEach((r) => {
        if (r.type === "GOOD_ENDOWMENT" && r.goodId) {
          const key = String(r.goodId);
          if (!goodIds.has(key)) {
            goodIds.set(key, []);
          }
          goodIds.get(key)!.push(r);
        }
      });

      // Find a good with at least 2 different owners
      let record1: GenesisRecord | undefined;
      let record2: GenesisRecord | undefined;
      for (const records of goodIds.values()) {
        if (records.length >= 2) {
          record1 = records[0];
          record2 = records[1];
          break;
        }
      }

      if (!record1 || !record2 || record1.type !== "GOOD_ENDOWMENT" || record2.type !== "GOOD_ENDOWMENT") {
        // Skip if scenario doesn't have multiple owners of same good
        expect(record1).toBeDefined();
        return;
      }

      // Swap amounts between the two owners: subtract from record1, add to record2
      const swapAmount = Math.min(record1.amount, record2.amount) * 0.5;

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) => {
        if (r === record1) {
          return { ...r, amount: r.amount - swapAmount };
        }
        if (r === record2) {
          return { ...r, amount: r.amount + swapAmount };
        }
        return r;
      });

      const modifiedLedger = { records: modifiedRecords };

      // Reconciliation should fail because we've moved goods from one owner to another
      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
    });

    it("fails when a cohort's wallet balance is relabeled as owned by its Clan while the amount is unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const cohortMoneyRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "MONEY_ENDOWMENT" && r.owner.type === "COHORT",
      );
      expect(cohortMoneyRecord).toBeDefined();
      if (!cohortMoneyRecord || cohortMoneyRecord.type !== "MONEY_ENDOWMENT" || cohortMoneyRecord.owner.type !== "COHORT") {
        return;
      }
      const cohort = worldState.cohorts.get(cohortMoneyRecord.owner.cohortId);
      expect(cohort).toBeDefined();
      if (!cohort) return;

      // Relabel the ledger's owner from the cohort to its Clan without changing the amount:
      // aggregate money for the currency is preserved, but owner-bound identity is not.
      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) =>
        r === cohortMoneyRecord ? { ...r, owner: { type: "CLAN" as const, clanId: cohort.clanId } } : r,
      );
      const modifiedLedger = { records: modifiedRecords };

      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("MONEY");
    });

    it("fails when a cohort's household inventory is relabeled as owned by its Clan while the amount is unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const cohortGoodRecord = worldState.worldGenesisLedger.records.find(
        (r): r is UnbucketedGoodEndowment => r.type === "GOOD_ENDOWMENT" && r.owner.type === "COHORT",
      );
      expect(cohortGoodRecord).toBeDefined();
      if (!cohortGoodRecord || cohortGoodRecord.owner.type !== "COHORT") {
        return;
      }
      const cohort = worldState.cohorts.get(cohortGoodRecord.owner.cohortId);
      expect(cohort).toBeDefined();
      if (!cohort) return;

      // Spread the narrowed cohort-owned record rather than the un-narrowed union element:
      // a ProductionUnit-owned GOOD_ENDOWMENT must carry an inventoryBucket that a
      // Clan-owned one may not, so only the narrowed value has the right shape.
      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) =>
        r === cohortGoodRecord
          ? { ...cohortGoodRecord, owner: { type: "CLAN" as const, clanId: cohort.clanId } }
          : r,
      );
      const modifiedLedger = { records: modifiedRecords };

      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
    });

    it("records cohort and ProductionUnit good endowments at the owning entity's own region", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);
      const regionIdByKey = new Map(
        Array.from(worldState.regions.entries(), ([regionId, region]) => [region.seed.key, regionId]),
      );

      let sawCohortGood = false;
      let sawProductionUnitGood = false;
      worldState.worldGenesisLedger.records.forEach((r) => {
        if (r.type !== "GOOD_ENDOWMENT") return;
        if (r.owner.type === "COHORT") {
          const cohort = worldState.cohorts.get(r.owner.cohortId);
          expect(cohort).toBeDefined();
          expect(r.regionId).toBe(regionIdByKey.get(cohort!.seed.regionKey));
          sawCohortGood = true;
        }
        if (r.owner.type === "PRODUCTION_UNIT") {
          const pu = worldState.productionUnits.get(r.owner.productionUnitId);
          expect(pu).toBeDefined();
          expect(r.regionId).toBe(regionIdByKey.get(pu!.seed.regionKey));
          sawProductionUnitGood = true;
        }
      });

      expect(sawCohortGood).toBe(true);
      expect(sawProductionUnitGood).toBe(true);
    });

    it("fails when a cohort's household inventory is relocated to another region while the owner+good total is unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const cohortGoodRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "GOOD_ENDOWMENT" && r.owner.type === "COHORT" && r.amount > 0,
      );
      expect(cohortGoodRecord).toBeDefined();
      if (!cohortGoodRecord || cohortGoodRecord.type !== "GOOD_ENDOWMENT") return;

      const otherRegionId = Array.from(worldState.regions.keys()).find((id) => id !== cohortGoodRecord.regionId);
      expect(otherRegionId).toBeDefined();
      if (!otherRegionId) return;

      // Move half of this cohort's opening stock of this good into a region the cohort
      // does not live in, leaving the owner+good aggregate exactly as it was.
      const movedAmount = cohortGoodRecord.amount / 2;
      const modifiedRecords = worldState.worldGenesisLedger.records.flatMap((r) =>
        r === cohortGoodRecord
          ? [
              { ...cohortGoodRecord, amount: cohortGoodRecord.amount - movedAmount },
              { ...cohortGoodRecord, regionId: otherRegionId, amount: movedAmount },
            ]
          : [r],
      );
      const modifiedLedger = { records: modifiedRecords };

      const aggregateOf = (records: readonly GenesisRecord[]) =>
        records
          .filter(
            (r) =>
              r.type === "GOOD_ENDOWMENT" &&
              JSON.stringify(r.owner) === JSON.stringify(cohortGoodRecord.owner) &&
              r.goodId === cohortGoodRecord.goodId,
          )
          .reduce((sum, r) => sum + r.amount, 0);
      expect(aggregateOf(modifiedLedger.records)).toBeCloseTo(
        aggregateOf(worldState.worldGenesisLedger.records),
        12,
      );

      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
    });

    it("fails when a ProductionUnit's inventory is relocated to another region while the owner+good total is unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const puGoodRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "GOOD_ENDOWMENT" && r.owner.type === "PRODUCTION_UNIT" && r.amount > 0,
      );
      expect(puGoodRecord).toBeDefined();
      if (!puGoodRecord || puGoodRecord.type !== "GOOD_ENDOWMENT") return;

      const otherRegionId = Array.from(worldState.regions.keys()).find((id) => id !== puGoodRecord.regionId);
      expect(otherRegionId).toBeDefined();
      if (!otherRegionId) return;

      const movedAmount = puGoodRecord.amount / 2;
      const modifiedRecords = worldState.worldGenesisLedger.records.flatMap((r) =>
        r === puGoodRecord
          ? [
              { ...puGoodRecord, amount: puGoodRecord.amount - movedAmount },
              { ...puGoodRecord, regionId: otherRegionId, amount: movedAmount },
            ]
          : [r],
      );

      const result = reconcileGenesisStocks(worldState, { records: modifiedRecords }, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
    });

    it("records each ProductionUnit opening inventory under its own typed bucket", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const bucketBySeedSegment: ReadonlyArray<[string, InventoryBucket]> = [
        [".inputInventory.", "INPUT"],
        [".outputInventory.", "OUTPUT"],
        [".investmentInventory.", "INVESTMENT"],
      ];
      const seenBuckets = new Set<InventoryBucket>();

      worldState.worldGenesisLedger.records.forEach((r) => {
        if (!isProductionUnitGoodEndowment(r)) return;
        const expectedBucket = bucketBySeedSegment.find(([segment]) =>
          r.sourceSeedKey.includes(segment),
        )?.[1];
        expect(expectedBucket).toBeDefined();
        expect(r.inventoryBucket).toBe(expectedBucket);
        seenBuckets.add(r.inventoryBucket);
      });

      // All three buckets are exercised by the baseline scenario, so the assertion above
      // is not vacuously satisfied by a single bucket.
      expect(Array.from(seenBuckets).sort()).toEqual(["INPUT", "INVESTMENT", "OUTPUT"]);
    });

    it("fails when a ProductionUnit's goods move between two inventory buckets while the owner+region+good total is unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Section 20 requires reconciliation to compare ProductionUnit + region +
      // inventoryBucket + goodId. This control moves opening stock out of one bucket into
      // another for the same unit, region and good, so every coarser aggregate — the
      // unit's total for that good, the region's total, the world total — is untouched.
      const sourceRecord = worldState.worldGenesisLedger.records.find(
        (r): r is ProductionUnitGoodEndowment => isProductionUnitGoodEndowment(r) && r.amount > 0,
      );
      expect(sourceRecord).toBeDefined();
      if (!sourceRecord) return;

      const otherBucket: InventoryBucket = sourceRecord.inventoryBucket === "INPUT" ? "OUTPUT" : "INPUT";
      const movedAmount = sourceRecord.amount / 2;
      const modifiedRecords = worldState.worldGenesisLedger.records.flatMap((r) =>
        r === sourceRecord
          ? [
              { ...sourceRecord, amount: sourceRecord.amount - movedAmount },
              { ...sourceRecord, inventoryBucket: otherBucket, amount: movedAmount },
            ]
          : [r],
      );

      // Prove the relocation really is aggregate-preserving: without typed bucket
      // identity there is nothing here for reconciliation to catch.
      const aggregateOf = (records: readonly GenesisRecord[]) =>
        records
          .filter(
            (r) =>
              r.type === "GOOD_ENDOWMENT" &&
              JSON.stringify(r.owner) === JSON.stringify(sourceRecord.owner) &&
              r.regionId === sourceRecord.regionId &&
              r.goodId === sourceRecord.goodId,
          )
          .reduce((sum, r) => sum + r.amount, 0);
      expect(aggregateOf(modifiedRecords)).toBeCloseTo(
        aggregateOf(worldState.worldGenesisLedger.records),
        12,
      );

      const result = reconcileGenesisStocks(worldState, { records: modifiedRecords }, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
      // The diagnostic must distinguish which bucket diverged, not merely which unit.
      expect(result.details?.key).toContain(sourceRecord.inventoryBucket);
    });

    it("fails when a ProductionUnit good endowment is relabelled into another bucket without splitting it", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // The baseline iron mine holds `good:iron` as both INPUT (80) and OUTPUT (300).
      // Swapping the bucket label on one of those records leaves the unit's total for
      // that good exactly unchanged, so only typed bucket identity can reject it.
      const inputRecord = worldState.worldGenesisLedger.records.find(
        (r): r is ProductionUnitGoodEndowment =>
          isProductionUnitGoodEndowment(r) &&
          r.inventoryBucket === "INPUT" &&
          r.amount > 0 &&
          worldState.worldGenesisLedger.records.some(
            (other) =>
              isProductionUnitGoodEndowment(other) &&
              other.owner.productionUnitId === r.owner.productionUnitId &&
              other.goodId === r.goodId &&
              other.inventoryBucket === "OUTPUT",
          ),
      );
      expect(inputRecord).toBeDefined();
      if (!inputRecord) return;

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) =>
        r === inputRecord ? { ...inputRecord, inventoryBucket: "OUTPUT" as const } : r,
      );

      const result = reconcileGenesisStocks(worldState, { records: modifiedRecords }, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("GOOD");
    });

    it("fails when a resource deposit is relabeled into another region while its source key and amount are unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const resourceRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "RESOURCE_ENDOWMENT" && r.amount > 0,
      );
      expect(resourceRecord).toBeDefined();
      if (!resourceRecord || resourceRecord.type !== "RESOURCE_ENDOWMENT") return;

      const otherRegionId = Array.from(worldState.regions.keys()).find((id) => id !== resourceRecord.regionId);
      expect(otherRegionId).toBeDefined();
      if (!otherRegionId) return;

      // Only the typed regionId changes: the deposit's provenance string and its
      // quantity are byte-identical, so nothing but canonical location identity can
      // catch this.
      const relabelled = { ...resourceRecord, regionId: otherRegionId };
      expect(relabelled.sourceSeedKey).toBe(resourceRecord.sourceSeedKey);
      expect(relabelled.amount).toBe(resourceRecord.amount);

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) =>
        r === resourceRecord ? relabelled : r,
      );
      expect(totalResourceQuantity(modifiedRecords)).toBeCloseTo(
        totalResourceQuantity(worldState.worldGenesisLedger.records),
        12,
      );

      const result = reconcileGenesisStocks(worldState, { records: modifiedRecords }, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("RESOURCE");
    });

    it("fails when a resource deposit is relabeled as another good while its source key and amount are unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const resourceRecords = worldState.worldGenesisLedger.records.filter(
        (r): r is Extract<GenesisRecord, { type: "RESOURCE_ENDOWMENT" }> =>
          r.type === "RESOURCE_ENDOWMENT" && r.amount > 0,
      );
      const resourceRecord = resourceRecords[0];
      const otherGoodId = resourceRecords.find((r) => r.goodId !== resourceRecord?.goodId)?.goodId;
      expect(resourceRecord).toBeDefined();
      expect(otherGoodId).toBeDefined();
      if (!resourceRecord || !otherGoodId) return;

      // Only the typed goodId changes; the deposit stays in its own region, keeps its
      // provenance string and keeps its quantity.
      const relabelled = { ...resourceRecord, goodId: otherGoodId };
      expect(relabelled.sourceSeedKey).toBe(resourceRecord.sourceSeedKey);
      expect(relabelled.amount).toBe(resourceRecord.amount);
      expect(relabelled.regionId).toBe(resourceRecord.regionId);

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) =>
        r === resourceRecord ? relabelled : r,
      );
      expect(totalResourceQuantity(modifiedRecords)).toBeCloseTo(
        totalResourceQuantity(worldState.worldGenesisLedger.records),
        12,
      );

      const result = reconcileGenesisStocks(worldState, { records: modifiedRecords }, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("RESOURCE");
    });

    it("fails when a cohort's population is relabeled as owned by its Clan while the amount is unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      const cohortPopulationRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "POPULATION_ENDOWMENT" && r.owner.type === "COHORT",
      );
      expect(cohortPopulationRecord).toBeDefined();
      if (
        !cohortPopulationRecord ||
        cohortPopulationRecord.type !== "POPULATION_ENDOWMENT" ||
        cohortPopulationRecord.owner.type !== "COHORT"
      ) {
        return;
      }
      const cohort = worldState.cohorts.get(cohortPopulationRecord.owner.cohortId);
      expect(cohort).toBeDefined();
      if (!cohort) return;

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) =>
        r === cohortPopulationRecord ? { ...r, owner: { type: "CLAN" as const, clanId: cohort.clanId } } : r,
      );
      const modifiedLedger = { records: modifiedRecords };

      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("POPULATION");
    });

    it("fails when a cohort's population record names another region while owner, source key and total are unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // The unmodified genesis reconciles, so the failure below is caused by the single
      // typed-region edit rather than by a pre-existing mismatch.
      expect(reconcileGenesisStocks(worldState, worldState.worldGenesisLedger, config).success).toBe(
        true,
      );

      const populationRecord = worldState.worldGenesisLedger.records.find(
        (r): r is Extract<GenesisRecord, { type: "POPULATION_ENDOWMENT" }> =>
          r.type === "POPULATION_ENDOWMENT" && r.amount > 0,
      );
      expect(populationRecord).toBeDefined();
      if (!populationRecord) return;

      const otherRegionId = Array.from(worldState.regions.keys()).find(
        (regionId) => regionId !== populationRecord.regionId,
      );
      expect(otherRegionId).toBeDefined();
      if (!otherRegionId) return;

      // Only the typed regionId changes: the same cohort still owns the stock, the
      // provenance string is untouched, and the amount is untouched.
      const relocated = { ...populationRecord, regionId: otherRegionId };
      expect(relocated.owner).toEqual(populationRecord.owner);
      expect(relocated.sourceSeedKey).toBe(populationRecord.sourceSeedKey);
      expect(relocated.amount).toBe(populationRecord.amount);

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) =>
        r === populationRecord ? relocated : r,
      );
      expect(totalPopulation(modifiedRecords)).toBeCloseTo(
        totalPopulation(worldState.worldGenesisLedger.records),
        12,
      );

      const result = reconcileGenesisStocks(worldState, { records: modifiedRecords }, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("POPULATION");
    });

    it("fails when capital is relocated between ProductionUnits while keeping total unchanged", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two CAPITAL_ENDOWMENT records with different owners
      const capitalRecords = worldState.worldGenesisLedger.records.filter(
        (r) => r.type === "CAPITAL_ENDOWMENT" && r.owner && r.owner.type === "PRODUCTION_UNIT"
      );

      if (capitalRecords.length < 2) {
        // Skip if scenario doesn't have multiple production units with capital
        expect(capitalRecords.length).toBeGreaterThanOrEqual(2);
        return;
      }

      const record1 = capitalRecords[0]!;
      const record2 = capitalRecords[1]!;

      // Swap capital amounts between the two production units
      const swapAmount = Math.min(record1.amount, record2.amount) * 0.5;

      const modifiedRecords = worldState.worldGenesisLedger.records.map((r) => {
        if (r === record1) {
          return { ...r, amount: r.amount - swapAmount };
        }
        if (r === record2) {
          return { ...r, amount: r.amount + swapAmount };
        }
        return r;
      });

      const modifiedLedger = { records: modifiedRecords };

      // Reconciliation should fail because we've relocated capital between different owners
      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("CAPITAL");
    });

    it("records capital per capital good through the documented recipe conversion", () => {
      const config = createTestConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      const capitalRecords = worldState.worldGenesisLedger.records.filter(
        (r) => r.type === "CAPITAL_ENDOWMENT",
      );
      expect(capitalRecords.length).toBeGreaterThan(0);

      // `recipe:tools-craft` declares 100 good:tools per capital unit, so every
      // capital record for one of its units names that good and carries the
      // converted quantity rather than a fabricated good and a raw capital total.
      const craftUnit = Array.from(worldState.productionUnits.values()).find(
        (pu) => pu.seed.recipeId === "recipe:tools-craft" && pu.seed.installedCapital > 0,
      );
      expect(craftUnit).toBeDefined();

      const craftRecords = capitalRecords.filter(
        (r) =>
          r.type === "CAPITAL_ENDOWMENT" &&
          r.owner?.type === "PRODUCTION_UNIT" &&
          r.owner.productionUnitId === craftUnit!.productionUnitId,
      );
      expect(craftRecords).toHaveLength(1);
      expect(craftRecords[0]).toMatchObject({
        goodId: "good:tools",
        amount: craftUnit!.seed.installedCapital * 100,
      });

      // `recipe:food-harvest` declares no investment good, so its capital embodies
      // no tradable good and is recorded without a goodId instead of a placeholder.
      const harvestUnit = Array.from(worldState.productionUnits.values()).find(
        (pu) => pu.seed.recipeId === "recipe:food-harvest" && pu.seed.installedCapital > 0,
      );
      expect(harvestUnit).toBeDefined();

      const harvestRecords = capitalRecords.filter(
        (r) =>
          r.type === "CAPITAL_ENDOWMENT" &&
          r.owner?.type === "PRODUCTION_UNIT" &&
          r.owner.productionUnitId === harvestUnit!.productionUnitId,
      );
      expect(harvestRecords).toHaveLength(1);
      expect(harvestRecords[0]).toMatchObject({ amount: harvestUnit!.seed.installedCapital });
      expect(
        harvestRecords[0]!.type === "CAPITAL_ENDOWMENT" && harvestRecords[0]!.goodId,
      ).toBeUndefined();

      // No record names the pre-repair placeholder good.
      expect(
        capitalRecords.some((r) => r.type === "CAPITAL_ENDOWMENT" && r.goodId === ("capital" as never)),
      ).toBe(false);
    });

    it("fails when capital is relocated between capital goods of one ProductionUnit while the unit's total is unchanged", () => {
      const config = createTestConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      // One ProductionUnit's capital record, for a recipe with a declared capital good.
      const capitalRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "CAPITAL_ENDOWMENT" && r.owner?.type === "PRODUCTION_UNIT" && r.goodId,
      );
      expect(capitalRecord).toBeDefined();
      if (capitalRecord?.type !== "CAPITAL_ENDOWMENT") return;

      // Move half of it onto a different capital good of the *same* owner.
      const movedAmount = capitalRecord.amount * 0.5;
      const relocated: GenesisRecord = {
        ...capitalRecord,
        goodId: "good:iron" as GoodId,
        amount: movedAmount,
        sourceSeedKey: `${capitalRecord.sourceSeedKey}.relocated`,
      };
      const modifiedRecords = worldState.worldGenesisLedger.records
        .map((r) => (r === capitalRecord ? { ...r, amount: r.amount - movedAmount } : r))
        .concat(relocated);
      const modifiedLedger = { records: modifiedRecords };

      // The owner's total capital across goods is unchanged, so an owner-only
      // reconciliation could not see this relocation.
      const totalFor = (records: readonly GenesisRecord[]) =>
        records
          .filter(
            (r) =>
              r.type === "CAPITAL_ENDOWMENT" &&
              r.owner?.type === "PRODUCTION_UNIT" &&
              capitalRecord.owner.type === "PRODUCTION_UNIT" &&
              r.owner.productionUnitId === capitalRecord.owner.productionUnitId,
          )
          .reduce((sum, r) => sum + r.amount, 0);
      expect(totalFor(modifiedRecords)).toBeCloseTo(totalFor(worldState.worldGenesisLedger.records), 9);

      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("CAPITAL");
    });

    it("fails when good-less ProductionUnit capital is perturbed", () => {
      const config = createTestConfig();
      const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

      // A recipe with no declared capital good still reconciles owner-bound, so the
      // repair does not drop that capital out of the comparison.
      const unconvertedRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "CAPITAL_ENDOWMENT" && r.owner?.type === "PRODUCTION_UNIT" && !r.goodId,
      );
      expect(unconvertedRecord).toBeDefined();

      const modifiedLedger = {
        records: worldState.worldGenesisLedger.records.map((r) =>
          r === unconvertedRecord ? { ...r, amount: r.amount + 25 } : r,
        ),
      };

      const result = reconcileGenesisStocks(worldState, modifiedLedger, config);
      expect(result.success).toBe(false);
      expect(result.details?.category).toBe("CAPITAL");
    });

    it("fails when FX pool base currency is perturbed after ledger was created", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find an FX pool opening record
      const fxPoolRecord = worldState.worldGenesisLedger.records.find(
        (r) => r.type === "FX_POOL_OPENING" && r.sourceSeedKey?.includes(".base"),
      );
      expect(fxPoolRecord).toBeDefined();

      // Find the corresponding monetary authority and reduce its pool cash
      const authorityEntry = Array.from(worldState.monetaryAuthorities.entries()).find(
        ([_, auth]) =>
          fxPoolRecord && auth.seed.fxPools?.some((pool) =>
            fxPoolRecord.sourceSeedKey?.includes(`${auth.seed.key}.fxPool.${pool.key}.base`),
          ),
      );
      expect(authorityEntry).toBeDefined();

      // Create modified world state with reduced pool cash
      if (authorityEntry && fxPoolRecord) {
        const [authorityId, authority] = authorityEntry;
        const modifiedFxPools = authority.seed.fxPools?.map((pool) => {
          if (fxPoolRecord.sourceSeedKey?.includes(`${pool.key}.base`) && pool.cash) {
            return {
              ...pool,
              cash: {
                ...pool.cash,
                [pool.baseCurrencyKey]: ((pool.cash[pool.baseCurrencyKey] as number) ?? 0) - 1000,
              },
            };
          }
          return pool;
        });

        const modifiedAuthority = { ...authority, seed: { ...authority.seed, fxPools: modifiedFxPools } };
        const modifiedAuthorities = new Map(worldState.monetaryAuthorities);
        modifiedAuthorities.set(authorityId, modifiedAuthority);

        const modifiedWorldState = { ...worldState, monetaryAuthorities: modifiedAuthorities };

        // Reconciliation should fail
        const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
        expect(result.success).toBe(false);
        expect(result.details?.category).toBe("MONEY");
        expect(result.details?.key).toContain("FX_POOL");
      }
    });

    it("fails when FX pool reserves are moved between distinct pools at same currency (pool identity validation)", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find two FX pools with the same currency
      const fxPoolRecords = worldState.worldGenesisLedger.records.filter(
        (r) => r.type === "FX_POOL_OPENING",
      );
      expect(fxPoolRecords.length).toBeGreaterThanOrEqual(2);

      // Find two pools with matching base currency
      const currenciesInPools = new Map<string, GenesisRecord[]>();
      fxPoolRecords.forEach((r) => {
        const currencyId = String(r.currencyId);
        const list = currenciesInPools.get(currencyId) ?? [];
        list.push(r);
        currenciesInPools.set(currencyId, list);
      });

      let foundPair = false;
      for (const [currencyId, records] of currenciesInPools.entries()) {
        if (records.length >= 2) {
          // Found two pools sharing the same currency, modify amounts to create equal-and-opposite
          const record1 = records[0]!;
          const record2 = records[1]!;
          const transferAmount = record1.amount * 0.5;

          // Find corresponding authorities and pools to modify
          const auth1Entry = Array.from(worldState.monetaryAuthorities.entries()).find(
            ([_, auth]) => record1.sourceSeedKey?.includes(auth.seed.key),
          );
          const auth2Entry = Array.from(worldState.monetaryAuthorities.entries()).find(
            ([_, auth]) => record2.sourceSeedKey?.includes(auth.seed.key),
          );

          if (auth1Entry && auth2Entry) {
            const modifiedAuthorities = new Map(worldState.monetaryAuthorities);

            // Reduce pool 1 and increase pool 2 by equal amounts
            const [auth1Id, auth1] = auth1Entry;
            const [auth2Id, auth2] = auth2Entry;

            const currencyKey = Array.from(worldState.currencies.entries()).find(
              ([id]) => String(id) === currencyId,
            )?.[1]?.seed.key;

            if (currencyKey) {
              const modifiedFxPools1 = auth1.seed.fxPools?.map((pool) => {
                if (record1.sourceSeedKey?.includes(`${pool.key}`)) {
                  return {
                    ...pool,
                    cash: { ...pool.cash, [currencyKey]: ((pool.cash?.[currencyKey] as number) ?? 0) - transferAmount },
                  };
                }
                return pool;
              });

              const modifiedFxPools2 = auth2.seed.fxPools?.map((pool) => {
                if (record2.sourceSeedKey?.includes(`${pool.key}`)) {
                  return {
                    ...pool,
                    cash: { ...pool.cash, [currencyKey]: ((pool.cash?.[currencyKey] as number) ?? 0) + transferAmount },
                  };
                }
                return pool;
              });

              const modifiedAuth1 = { ...auth1, seed: { ...auth1.seed, fxPools: modifiedFxPools1 } };
              const modifiedAuth2 = { ...auth2, seed: { ...auth2.seed, fxPools: modifiedFxPools2 } };

              modifiedAuthorities.set(auth1Id, modifiedAuth1);
              modifiedAuthorities.set(auth2Id, modifiedAuth2);

              const modifiedWorldState = { ...worldState, monetaryAuthorities: modifiedAuthorities };

              // Reconciliation should fail because pool identity was violated
              const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
              expect(result.success).toBe(false);
              expect(result.details?.category).toBe("MONEY");
              expect(result.details?.key).toContain("FX_POOL");
              foundPair = true;
              break;
            }
          }
        }
      }
      expect(foundPair).toBe(true);
    });

    it("fails when authority wallet contains unexpected money", () => {
      const scenario = baselineScenario;
      const config = createTestConfig();

      const worldState = buildInitialWorld(scenario, baselineDefinitionPack, config, 42);

      // Find an authority and add money to its wallet
      const authorityEntry = Array.from(worldState.monetaryAuthorities.entries())[0];
      expect(authorityEntry).toBeDefined();

      if (authorityEntry) {
        const [authorityId, authority] = authorityEntry;
        const currencyEntry = Array.from(worldState.currencies.entries())[0];

        if (currencyEntry) {
          const [_, currency] = currencyEntry;

          // Add unexpected money to the authority wallet
          const modifiedAuthority = {
            ...authority,
            seed: {
              ...authority.seed,
              wallet: { [currency.seed.key]: 10000 },
            },
          };

          const modifiedAuthorities = new Map(worldState.monetaryAuthorities);
          modifiedAuthorities.set(authorityId, modifiedAuthority);

          const modifiedWorldState = { ...worldState, monetaryAuthorities: modifiedAuthorities };

          // Reconciliation should fail because authority wallet has unexpected money
          const result = reconcileGenesisStocks(modifiedWorldState, worldState.worldGenesisLedger, config);
          expect(result.success).toBe(false);
          expect(result.details?.category).toBe("MONEY");
          expect(result.details?.key).toContain("AUTHORITY");
        }
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
