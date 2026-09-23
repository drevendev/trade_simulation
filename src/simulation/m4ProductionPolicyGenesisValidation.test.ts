import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type {
  M4ProductionPlanningPolicySeed,
  ScenarioDefinition,
} from "../config/scenarioDefinition";
import { createDefaultSimulationConfig, type SimulationConfig } from "../config/simulationConfig";
import { buildInitialWorld } from "./worldState";

const targetState = baselineScenario.states[0]!;
const targetRegion =
  baselineScenario.geography.find((region) => region.controllerStateKey === targetState.key) ??
  baselineScenario.geography[0]!;
const targetUnit = baselineScenario.productionUnits[0]!;

type RuntimePolicyFixture = Record<string, unknown>;
type RequiredPolicyMapField =
  | "minimumWageFloorByRegionKey"
  | "mandatoryKnownCashByProductionUnitKey";

function withTargetPolicy(
  patch: Partial<M4ProductionPlanningPolicySeed>,
): ScenarioDefinition {
  const current = targetState.policy.m4ProductionPlanning ?? {
    minimumWageFloorByRegionKey: {},
    mandatoryKnownCashByProductionUnitKey: {},
  };

  return {
    ...baselineScenario,
    states: baselineScenario.states.map((state) =>
      state.key === targetState.key
        ? {
            ...state,
            policy: {
              ...state.policy,
              m4ProductionPlanning: {
                ...current,
                ...patch,
              },
            },
          }
        : state,
    ),
  };
}

function withRuntimeTargetPolicy(policy: RuntimePolicyFixture): ScenarioDefinition {
  return {
    ...baselineScenario,
    states: baselineScenario.states.map((state) =>
      state.key === targetState.key
        ? {
            ...state,
            policy: {
              ...state.policy,
              m4ProductionPlanning: policy as unknown as M4ProductionPlanningPolicySeed,
            },
          }
        : state,
    ),
  };
}

function emptyRuntimePolicy(): RuntimePolicyFixture {
  return {
    minimumWageFloorByRegionKey: {},
    mandatoryKnownCashByProductionUnitKey: {},
  };
}

function withRuntimeNestedWageFloorMap(value: unknown): ScenarioDefinition {
  return withRuntimeTargetPolicy({
    ...emptyRuntimePolicy(),
    minimumWageFloorByRegionKey: {
      [targetRegion.key]: value,
    },
  });
}

function build(
  scenario: ScenarioDefinition,
  config: SimulationConfig = createDefaultSimulationConfig(),
): void {
  buildInitialWorld(
    scenario,
    baselineDefinitionPack,
    config,
    42,
  );
}

function configWithoutExplicitLaborCategories(): SimulationConfig {
  return {
    ...createDefaultSimulationConfig(),
    labor: {},
  };
}

function expectPolicyMapShapeFailure(
  scenario: ScenarioDefinition,
  field: RequiredPolicyMapField,
): void {
  expect(() => build(scenario)).toThrow(
    new RegExp(
      `StateSeed "${targetState.key}".*policy\\.m4ProductionPlanning\\.${field}.*present as a non-null plain object map`,
    ),
  );
}

function expectNestedWageFloorMapShapeFailure(value: unknown): void {
  expect(() => build(withRuntimeNestedWageFloorMap(value))).toThrow(
    new RegExp(
      `^StateSeed "${targetState.key}": policy\\.m4ProductionPlanning\\.minimumWageFloorByRegionKey\\["${targetRegion.key}"\\] must be a non-null plain object map$`,
    ),
  );
}

describe("M4 State policy fail-fast genesis validation (#633, #642, #646)", () => {
  it("keeps the unmodified baseline valid", () => {
    expect(() => build(baselineScenario)).not.toThrow();
  });

  it("rejects an unknown minimum-wage Region before world construction", () => {
    const scenario = withTargetPolicy({
      minimumWageFloorByRegionKey: {
        "region:not-defined": { GENERAL: 20 },
      },
    });

    expect(() => build(scenario)).toThrow(
      new RegExp(
        `StateSeed "${targetState.key}".*minimumWageFloorByRegionKey\\["region:not-defined"\\].*non-existent Region`,
      ),
    );
  });

  it("rejects an unknown mandatory-cash ProductionUnit before world construction", () => {
    const scenario = withTargetPolicy({
      mandatoryKnownCashByProductionUnitKey: {
        "production-unit:not-defined": 99,
      },
    });

    expect(() => build(scenario)).toThrow(
      new RegExp(
        `StateSeed "${targetState.key}".*mandatoryKnownCashByProductionUnitKey\\["production-unit:not-defined"\\].*non-existent ProductionUnit`,
      ),
    );
  });

  it("resolves an omitted allowedLaborCategories control to the canonical GENERAL default", () => {
    const scenario = withTargetPolicy({
      minimumWageFloorByRegionKey: {
        [targetRegion.key]: { GENERAL: 20 },
      },
    });

    expect(() => build(scenario, configWithoutExplicitLaborCategories())).not.toThrow();
  });

  it("rejects a genuinely unknown labor category after resolving omitted config defaults", () => {
    const scenario = withTargetPolicy({
      minimumWageFloorByRegionKey: {
        [targetRegion.key]: { NOT_A_LABOR_CATEGORY: 20 },
      },
    });

    expect(() => build(scenario, configWithoutExplicitLaborCategories())).toThrow(
      /NOT_A_LABOR_CATEGORY.*not allowed by LaborConfig\.allowedLaborCategories/,
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["negative", -0.01],
  ])("rejects a %s minimum-wage fixture at genesis", (_label, value) => {
    const scenario = withTargetPolicy({
      minimumWageFloorByRegionKey: {
        [targetRegion.key]: { GENERAL: value },
      },
    });

    expect(() => build(scenario)).toThrow(/minimumWageFloorByRegionKey.*non-negative finite number/);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["negative", -0.01],
  ])("rejects a %s mandatory-cash fixture at genesis", (_label, value) => {
    const scenario = withTargetPolicy({
      mandatoryKnownCashByProductionUnitKey: {
        [targetUnit.key]: value,
      },
    });

    expect(() => build(scenario)).toThrow(/mandatoryKnownCashByProductionUnitKey.*non-negative finite number/);
  });

  it.each<RequiredPolicyMapField>([
    "minimumWageFloorByRegionKey",
    "mandatoryKnownCashByProductionUnitKey",
  ])("rejects a missing required %s map at genesis", (field) => {
    const policy = emptyRuntimePolicy();
    delete policy[field];

    expectPolicyMapShapeFailure(withRuntimeTargetPolicy(policy), field);
  });

  it.each([
    ["minimumWageFloorByRegionKey", null],
    ["minimumWageFloorByRegionKey", 42],
    ["minimumWageFloorByRegionKey", []],
    ["mandatoryKnownCashByProductionUnitKey", null],
    ["mandatoryKnownCashByProductionUnitKey", 42],
    ["mandatoryKnownCashByProductionUnitKey", []],
  ] as const)("rejects a malformed required %s map value at genesis", (field, value) => {
    const policy = emptyRuntimePolicy();
    policy[field] = value;

    expectPolicyMapShapeFailure(withRuntimeTargetPolicy(policy), field);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["primitive", 42],
  ] as const)("rejects a malformed %s nested wage-floor map at genesis", (_label, value) => {
    expectNestedWageFloorMapShapeFailure(value);
  });

  it("reports the malformed policy field at genesis instead of reaching a later undefined-property path", () => {
    const policy = emptyRuntimePolicy();
    delete policy.minimumWageFloorByRegionKey;

    expect(() => build(withRuntimeTargetPolicy(policy))).toThrow(
      new RegExp(
        `^StateSeed "${targetState.key}": policy\\.m4ProductionPlanning\\.minimumWageFloorByRegionKey must be present as a non-null plain object map$`,
      ),
    );
  });

  it("preserves explicit empty required maps as no applicable M4 rule", () => {
    const scenario = withTargetPolicy({
      minimumWageFloorByRegionKey: {},
      mandatoryKnownCashByProductionUnitKey: {},
    });

    expect(() => build(scenario)).not.toThrow();
  });

  it("preserves an explicit empty nested wage-floor map for a real Region", () => {
    expect(() => build(withRuntimeNestedWageFloorMap({}))).not.toThrow();
  });
});