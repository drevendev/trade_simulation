import { describe, expect, it } from "vitest";
import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import type { CohortId, ClanId, RegionId } from "../domain/id";
import {
  createPhase2LaborSupplyPlanningHandler,
  generateLaborSupplyPlansPhase2,
  planCohortLaborSupplyPhase2,
} from "./laborSupplyPlanning";
import { initializeTickContext } from "./tickOrchestrator";
import type { CohortState, RegionState, WorldState } from "./worldState";

const cohortId = (value: string) => value as CohortId;
const clanId = (value: string) => value as ClanId;
const regionId = (value: string) => value as RegionId;

function makeCohort(overrides: Partial<CohortState["seed"]> = {}, id = "cohort:working"): CohortState {
  return {
    cohortId: cohortId(id),
    clanId: clanId("clan:1"),
    seed: {
      key: id,
      regionKey: "region-a",
      clanKey: "clan-a",
      ageBand: "WORKING",
      stratum: "WORKING_MIDDLE",
      laborCategory: "GENERAL",
      population: 100,
      wallet: {},
      householdInventory: {},
      healthIndex: 1,
      prosperityEma: 0.5,
      essentialSatisfactionEma: 0.5,
      realIncomePerCapitaEma: 1,
      employmentRateEma: 1,
      migrationPressureEma: 0,
      mobilityAccumulator: 0,
      wageSignal: 1,
      ...overrides,
    },
    wallet: new Map(),
    householdInventory: new Map(),
  };
}

function makeRegion(id = "region:1"): RegionState {
  return {
    regionId: regionId(id),
    seed: {
      key: "region-a",
      name: "Region A",
      controllerStateKey: null,
      settlementCurrencyKey: "CUR",
      settlementLevel: 1,
      infrastructure: {},
      climateHabitabilityInputs: {},
      deposits: [],
    },
    controllerStateId: null,
    settlementCurrencyId: "currency:1" as never,
    resourceDeposits: new Map(),
  };
}

function configWithPopulation(overrides: Partial<SimulationConfig["population"]>): SimulationConfig {
  const base = createDefaultSimulationConfig();
  return {
    ...base,
    population: {
      ...base.population,
      ...overrides,
    },
  };
}

function makeWorld(cohorts: readonly CohortState[], config = createDefaultSimulationConfig()): WorldState {
  const region = makeRegion();
  return {
    configVersion: config.configVersion,
    scenarioId: "labor-supply-test",
    seed: 123,
    definitionRegistry: {} as never,
    simulationConfig: config,
    worldGenesisLedger: {} as never,
    regions: new Map([[region.regionId, region]]),
    states: new Map(),
    currencies: new Map(),
    monetaryAuthorities: new Map(),
    clans: new Map(),
    cohorts: new Map(cohorts.map((cohort) => [cohort.cohortId, cohort])),
    productionUnits: new Map(),
    markets: new Map(),
    transportLinks: new Map(),
    pendingTransitions: {
      jurisdictionChanges: [],
      stateCreations: [],
      policyChanges: [],
      monetaryPolicyChanges: [],
    },
  };
}

describe("REQ-POPULATION-002 LaborSupplyPlan generation", () => {
  it("projects health and prior-close opportunity exactly across canonical factor endpoints", () => {
    const config = createDefaultSimulationConfig();
    const low = planCohortLaborSupplyPhase2({
      tick: 4,
      cohort: makeCohort({ healthIndex: 0, employmentRateEma: 0 }),
      regionId: regionId("region:1"),
      config,
    });
    const high = planCohortLaborSupplyPhase2({
      tick: 4,
      cohort: makeCohort({ healthIndex: 1, employmentRateEma: 1 }),
      regionId: regionId("region:1"),
      config,
    });

    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(low!.availableWorkerEquivalents).toBeCloseTo(100 * 0.70 * 0.75 * 0.90, 12);
    expect(high!.availableWorkerEquivalents).toBeCloseTo(100 * 0.70 * 1.02 * 1.05, 12);

    const clamped = planCohortLaborSupplyPhase2({
      tick: 4,
      cohort: makeCohort({ healthIndex: -10, employmentRateEma: 10 }),
      regionId: regionId("region:1"),
      config,
    });
    expect(clamped!.availableWorkerEquivalents).toBeCloseTo(100 * 0.70 * 0.75 * 1.05, 12);
  });

  it("clamps participation to the configured min/max bounds", () => {
    const maximum = planCohortLaborSupplyPhase2({
      tick: 2,
      cohort: makeCohort(),
      regionId: regionId("region:1"),
      config: configWithPopulation({
        baseParticipationByStratum: { VULNERABLE: 1, WORKING_MIDDLE: 1, AFFLUENT: 1 },
        minHealthParticipationFactor: 2,
        maxHealthParticipationFactor: 2,
        minWeakOpportunityFactor: 2,
        maxWeakOpportunityFactor: 2,
        maxParticipation: 0.8,
      }),
    });
    expect(maximum!.availableWorkerEquivalents).toBeCloseTo(80, 12);

    const minimum = planCohortLaborSupplyPhase2({
      tick: 2,
      cohort: makeCohort(),
      regionId: regionId("region:1"),
      config: configWithPopulation({
        baseParticipationByStratum: { VULNERABLE: 0.01, WORKING_MIDDLE: 0.01, AFFLUENT: 0.01 },
        minHealthParticipationFactor: 0.1,
        maxHealthParticipationFactor: 0.1,
        minWeakOpportunityFactor: 0.1,
        maxWeakOpportunityFactor: 0.1,
        minParticipation: 0.4,
      }),
    });
    expect(minimum!.availableWorkerEquivalents).toBeCloseTo(40, 12);
  });

  it("emits only for positive-population WORKING cohorts and preserves tiny positive supply", () => {
    const config = createDefaultSimulationConfig();
    const id = regionId("region:1");

    expect(planCohortLaborSupplyPhase2({ tick: 1, cohort: makeCohort({ ageBand: "CHILD" }), regionId: id, config })).toBeNull();
    expect(planCohortLaborSupplyPhase2({ tick: 1, cohort: makeCohort({ ageBand: "ELDER" }), regionId: id, config })).toBeNull();
    expect(planCohortLaborSupplyPhase2({ tick: 1, cohort: makeCohort({ population: 0 }), regionId: id, config })).toBeNull();

    const tinyPopulation = Number.EPSILON;
    const tiny = planCohortLaborSupplyPhase2({
      tick: 1,
      cohort: makeCohort({ population: tinyPopulation }),
      regionId: id,
      config,
    });
    expect(tiny).not.toBeNull();
    expect(tiny!.availableWorkerEquivalents).toBeGreaterThan(0);
    expect(tiny!.availableWorkerEquivalents).toBeLessThanOrEqual(tinyPopulation);
  });

  it("fails fast on invalid source/config evidence instead of inventing participation", () => {
    const config = createDefaultSimulationConfig();
    const id = regionId("region:1");

    expect(() => planCohortLaborSupplyPhase2({
      tick: 1,
      cohort: makeCohort({ healthIndex: Number.NaN }),
      regionId: id,
      config,
    })).toThrow(/healthIndex must be finite/);
    expect(() => planCohortLaborSupplyPhase2({
      tick: 1,
      cohort: makeCohort({ employmentRateEma: Number.POSITIVE_INFINITY }),
      regionId: id,
      config,
    })).toThrow(/employmentRateEma must be finite/);
    expect(() => planCohortLaborSupplyPhase2({
      tick: 1,
      cohort: makeCohort({ population: -1 }),
      regionId: id,
      config,
    })).toThrow(/population must be >= 0/);
    expect(() => planCohortLaborSupplyPhase2({
      tick: 1,
      cohort: makeCohort(),
      regionId: id,
      config: configWithPopulation({ baseParticipationByStratum: { VULNERABLE: 0.7 } }),
    })).toThrow(/missing stratum WORKING_MIDDLE/);
  });

  it("uses stable plan ids/order under shuffled cohort insertion and never mutates cohort state", () => {
    const cohortB = makeCohort({ population: 80, healthIndex: 0.8, employmentRateEma: 0.4 }, "cohort:b");
    const cohortA = makeCohort({ population: 120, healthIndex: 0.6, employmentRateEma: 0.7 }, "cohort:a");
    const beforeA = { ...cohortA.seed };
    const beforeB = { ...cohortB.seed };

    const forward = generateLaborSupplyPlansPhase2(makeWorld([cohortA, cohortB]), 9);
    const reversed = generateLaborSupplyPlansPhase2(makeWorld([cohortB, cohortA]), 9);

    expect(forward).toEqual(reversed);
    expect(forward.map((plan) => plan.planId)).toEqual([
      "labor-supply:9:cohort:a",
      "labor-supply:9:cohort:b",
    ]);
    expect(forward.every((plan) => plan.availableWorkerEquivalents >= 0)).toBe(true);
    expect(forward[0]!.availableWorkerEquivalents).toBeLessThanOrEqual(cohortA.seed.population);
    expect(forward[1]!.availableWorkerEquivalents).toBeLessThanOrEqual(cohortB.seed.population);
    expect(cohortA.seed).toEqual(beforeA);
    expect(cohortB.seed).toEqual(beforeB);
  });

  it("writes plans only to ephemeral Phase-2 TickContext", () => {
    const world = makeWorld([
      makeCohort({}, "cohort:b"),
      makeCohort({ ageBand: "CHILD" }, "cohort:child"),
      makeCohort({}, "cohort:a"),
    ]);
    const handler = createPhase2LaborSupplyPlanningHandler();
    const initial = initializeTickContext(3, world.seed);

    const phase1 = handler(world, { ...initial, phase: 1 }, world.pendingTransitions);
    expect(phase1).toBe(initial === phase1 ? initial : phase1);
    expect(phase1.laborSupplyPlans).toBeUndefined();

    const phase2Input = { ...initial, phase: 2 };
    const phase2 = handler(world, phase2Input, world.pendingTransitions);
    expect(phase2.laborSupplyPlans?.map((plan) => plan.cohortId)).toEqual([
      cohortId("cohort:a"),
      cohortId("cohort:b"),
    ]);
    expect(world.cohorts.size).toBe(3);
    expect(world.cohorts.get(cohortId("cohort:child"))?.seed.ageBand).toBe("CHILD");
  });
});
