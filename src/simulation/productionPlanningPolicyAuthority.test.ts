import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, ProductionUnitId } from "../domain/id";
import { createPhase3LaborAllocationHandler } from "./laborAllocation";
import { createPhase2LaborSupplyPlanningHandler } from "./laborSupplyPlanning";
import {
  createCanonicalPhase2ProductionPlanningHandler,
  createPhase2ProductionPlanningHandler,
  type ProductionPlanningEvidence,
} from "./productionPlanning";
import { composePhaseHandlers, executeTick } from "./tickOrchestrator";
import { buildInitialWorld, type WorldState } from "./worldState";

interface FixtureOptions {
  readonly minimumWageFloor?: number;
  readonly mandatoryKnownCash?: number;
  readonly openingCash?: number;
  readonly wageOffer?: number;
}

function fixture(options: FixtureOptions = {}) {
  const base = buildInitialWorld(
    baselineScenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );

  const unit = [...base.productionUnits.values()].find((candidate) => {
    if (candidate.seed.status !== "ACTIVE") return false;
    const recipe = base.definitionRegistry.recipes[candidate.seed.recipeId];
    if (recipe === undefined || recipe.laborPerBatch <= 0) return false;
    const region = [...base.regions.values()].find(
      (candidateRegion) => candidateRegion.seed.key === candidate.seed.regionKey,
    );
    if (region === undefined || region.controllerStateId === null) return false;
    if (
      recipe.infrastructureCategory !== undefined &&
      (region.seed.infrastructure[recipe.infrastructureCategory] ?? 0) <= 0
    ) {
      return false;
    }
    if (recipe.extractionResourceId !== undefined) {
      const deposit = region.seed.deposits.find(
        (candidateDeposit) => candidateDeposit.resourceId === recipe.extractionResourceId,
      );
      if (
        deposit?.initiallyKnown !== true ||
        (region.resourceDeposits.get(recipe.extractionResourceId) ?? 0) <= 0
      ) {
        return false;
      }
    }
    return [...base.cohorts.values()].some(
      (cohort) =>
        cohort.seed.regionKey === candidate.seed.regionKey &&
        cohort.seed.ageBand === "WORKING" &&
        cohort.seed.population > 0 &&
        cohort.seed.laborCategory === recipe.laborCategory,
    );
  });
  expect(unit).toBeDefined();

  const region = [...base.regions.values()].find(
    (candidate) => candidate.seed.key === unit!.seed.regionKey,
  );
  expect(region).toBeDefined();
  expect(region!.controllerStateId).not.toBeNull();

  const controller = base.states.get(region!.controllerStateId!);
  expect(controller).toBeDefined();
  const explicitPolicy = controller!.seed.policy.m4ProductionPlanning;
  expect(explicitPolicy).toBeDefined();

  const recipe = base.definitionRegistry.recipes[unit!.seed.recipeId];
  expect(recipe).toBeDefined();

  const liveWallet = new Map(unit!.wallet);
  liveWallet.set(region!.settlementCurrencyId, options.openingCash ?? 1_000);
  const liveUnit = {
    ...unit!,
    wageOffer: options.wageOffer ?? 10,
    wallet: liveWallet,
  };
  const productionUnits = new Map(base.productionUnits);
  productionUnits.set(liveUnit.productionUnitId, liveUnit);

  const minimumWageFloorByRegionKey = {
    ...explicitPolicy!.minimumWageFloorByRegionKey,
    [region!.seed.key]: {
      ...(explicitPolicy!.minimumWageFloorByRegionKey[region!.seed.key] ?? {}),
      ...(options.minimumWageFloor === undefined
        ? {}
        : { [recipe!.laborCategory]: options.minimumWageFloor }),
    },
  };
  const mandatoryKnownCashByProductionUnitKey = {
    ...explicitPolicy!.mandatoryKnownCashByProductionUnitKey,
    ...(options.mandatoryKnownCash === undefined
      ? {}
      : { [liveUnit.seed.key]: options.mandatoryKnownCash }),
  };
  const states = new Map(base.states);
  states.set(controller!.stateId, {
    ...controller!,
    seed: {
      ...controller!.seed,
      policy: {
        ...controller!.seed.policy,
        m4ProductionPlanning: {
          minimumWageFloorByRegionKey,
          mandatoryKnownCashByProductionUnitKey,
        },
      },
    },
  });

  const world: WorldState = { ...base, productionUnits, states };
  return { world, unit: liveUnit, region: region!, recipe: recipe! };
}

function runCanonical(world: WorldState, tick = 9) {
  const result = executeTick(
    world,
    tick,
    world.pendingTransitions,
    composePhaseHandlers(
      createPhase2LaborSupplyPlanningHandler(),
      createCanonicalPhase2ProductionPlanningHandler(),
      createPhase3LaborAllocationHandler(),
    ),
  );
  expect(result.phaseBoundaryError).toBeUndefined();
  return result.context;
}

function targetDemand(context: ReturnType<typeof runCanonical>, unitId: ProductionUnitId) {
  const demand = context.laborDemandPlans?.find((candidate) => candidate.unitId === unitId);
  expect(demand).toBeDefined();
  return demand!;
}

function arbitraryEvidence(world: WorldState): ReadonlyMap<ProductionUnitId, ProductionPlanningEvidence> {
  const result = new Map<ProductionUnitId, ProductionPlanningEvidence>();
  for (const unit of world.productionUnits.values()) {
    if (unit.seed.status !== "ACTIVE") continue;
    const recipe = world.definitionRegistry.recipes[unit.seed.recipeId];
    if (recipe === undefined) throw new Error(`Missing recipe ${unit.seed.recipeId}`);
    const region = [...world.regions.values()].find(
      (candidate) => candidate.seed.key === unit.seed.regionKey,
    );
    if (region === undefined) throw new Error(`Missing Region for ${String(unit.productionUnitId)}`);
    const market = [...world.markets.values()].find(
      (candidate) => candidate.seed.regionKey === region.seed.key,
    );
    if (market === undefined) throw new Error(`Missing local Market for ${String(region.regionId)}`);

    const prices = (goodIds: readonly GoodId[]) => {
      const record: Record<string, number> = {};
      for (const goodId of goodIds) {
        const price = market.priceByGood.get(String(goodId));
        if (price === undefined) throw new Error(`Missing price for ${String(goodId)}`);
        record[goodId] = price;
      }
      return record as Record<GoodId, number>;
    };

    result.set(unit.productionUnitId, {
      mandatoryKnownCash: 999,
      legalMinimumWageFloor: 999,
      priorCloseGrossInputPriceByGood: prices(Object.keys(recipe.inputsPerBatch) as GoodId[]),
      priorCloseGrossInvestmentPriceByGood: prices(
        Object.keys(recipe.investmentGoodsPerCapitalUnit) as GoodId[],
      ),
      infrastructureFactor: 1,
      resourceAccessFactor: 1,
      healthLaborProductivityFactor: 1,
    });
  }
  return result;
}

describe("Issue #630 explicit M4 production-policy authority", () => {
  it("uses an explicit positive minimum-wage fixture in authoritative Phase 2 and Phase 3 accepts it", () => {
    const base = fixture({ minimumWageFloor: 20, wageOffer: 10, openingCash: 1_000 });
    const context = runCanonical(base.world);
    const demand = targetDemand(context, base.unit.productionUnitId);

    expect(demand.grossWageOffer).toBe(20);
    expect(demand.requestedWorkerEquivalents).toBeGreaterThan(0);
    expect(demand.grossPayrollCap).toBeCloseTo(demand.requestedWorkerEquivalents * 20, 12);
    expect(context.laborAllocations).toBeDefined();
  });

  it("reserves explicit mandatory known cash before authoritative payroll affordability", () => {
    const noCharge = fixture({ mandatoryKnownCash: 0, openingCash: 100, wageOffer: 10 });
    const charged = fixture({ mandatoryKnownCash: 99, openingCash: 100, wageOffer: 10 });

    const noChargeDemand = targetDemand(
      runCanonical(noCharge.world),
      noCharge.unit.productionUnitId,
    );
    const chargedDemand = targetDemand(
      runCanonical(charged.world),
      charged.unit.productionUnitId,
    );

    expect(noChargeDemand.requestedWorkerEquivalents).toBeGreaterThan(
      chargedDemand.requestedWorkerEquivalents,
    );
    expect(noChargeDemand.grossPayrollCap).toBeGreaterThan(chargedDemand.grossPayrollCap);
    expect(chargedDemand.grossPayrollCap).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("treats explicit empty fixture maps as no applicable rule and replays deterministically", () => {
    const base = fixture({ wageOffer: 10, openingCash: 1_000 });
    const first = runCanonical(base.world);
    const second = runCanonical(base.world);
    const firstDemand = targetDemand(first, base.unit.productionUnitId);
    const secondDemand = targetDemand(second, base.unit.productionUnitId);

    expect(firstDemand.grossWageOffer).toBe(10);
    expect(second.laborDemandPlans).toBe(first.laborDemandPlans);
    expect(secondDemand).toEqual(firstDemand);
  });

  it("does not let caller-selected alternate policy evidence win authority by arriving first", () => {
    const base = fixture({ minimumWageFloor: 20, mandatoryKnownCash: 0, wageOffer: 10, openingCash: 1_000 });
    const callerFirst = executeTick(
      base.world,
      9,
      base.world.pendingTransitions,
      createPhase2ProductionPlanningHandler({ evidenceByUnit: arbitraryEvidence(base.world) }),
    );
    expect(callerFirst.phaseBoundaryError).toBeUndefined();
    const callerDemand = callerFirst.context.laborDemandPlans?.find(
      (candidate) => candidate.unitId === base.unit.productionUnitId,
    );
    expect(callerDemand?.grossWageOffer).toBe(999);

    const canonical = runCanonical(base.world);
    const canonicalDemand = targetDemand(canonical, base.unit.productionUnitId);
    expect(canonicalDemand.grossWageOffer).toBe(20);
    expect(canonical.laborAllocations).toBeDefined();
  });

  it("fails closed for a controlled Region whose scenario omitted the explicit M4 policy fixture", () => {
    const base = fixture();
    const states = new Map(base.world.states);
    for (const [stateId, state] of states) {
      states.set(stateId, {
        ...state,
        seed: { ...state.seed, policy: {} },
      });
    }
    const missingFixtureWorld: WorldState = { ...base.world, states };

    expect(() =>
      executeTick(
        missingFixtureWorld,
        9,
        missingFixtureWorld.pendingTransitions,
        createCanonicalPhase2ProductionPlanningHandler(),
      ),
    ).toThrow(/explicit M4 production-planning policy fixture/);
  });
});
