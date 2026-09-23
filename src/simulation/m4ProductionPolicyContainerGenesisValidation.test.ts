import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import type {
  M4ProductionPlanningPolicySeed,
  ScenarioDefinition,
} from "../config/scenarioDefinition";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { buildInitialWorld } from "./worldState";

const targetState = baselineScenario.states[0]!;

function withRuntimeTargetPolicy(value: unknown): ScenarioDefinition {
  return {
    ...baselineScenario,
    states: baselineScenario.states.map((state) =>
      state.key === targetState.key
        ? {
            ...state,
            policy: {
              ...state.policy,
              m4ProductionPlanning: value as M4ProductionPlanningPolicySeed,
            },
          }
        : state,
    ),
  };
}

function withOmittedTargetPolicy(): ScenarioDefinition {
  return {
    ...baselineScenario,
    states: baselineScenario.states.map((state) =>
      state.key === targetState.key
        ? {
            ...state,
            policy: {},
          }
        : state,
    ),
  };
}

function build(scenario: ScenarioDefinition): void {
  buildInitialWorld(
    scenario,
    baselineDefinitionPack,
    createDefaultSimulationConfig(),
    42,
  );
}

describe("M4 State policy outer-container fail-fast genesis validation (#649)", () => {
  it.each([
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["empty string", ""],
    ["array", []],
    ["truthy primitive", 42],
  ] as const)("rejects a present malformed %s policy container", (_label, value) => {
    expect(() => build(withRuntimeTargetPolicy(value))).toThrow(
      new RegExp(
        `^StateSeed "${targetState.key}": policy\\.m4ProductionPlanning must be a non-null plain object$`,
      ),
    );
  });

  it("preserves omitted m4ProductionPlanning as legitimate optional absence", () => {
    expect(() => build(withOmittedTargetPolicy())).not.toThrow();
  });

  it("preserves a present policy with both required maps explicitly empty", () => {
    expect(() =>
      build(
        withRuntimeTargetPolicy({
          minimumWageFloorByRegionKey: {},
          mandatoryKnownCashByProductionUnitKey: {},
        }),
      ),
    ).not.toThrow();
  });
});
