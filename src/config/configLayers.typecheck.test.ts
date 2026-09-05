import { describe, expect, it } from "vitest";

import type { DefinitionPack } from "./definitionPack";
import type { RunOptions } from "./runOptions";
import type { ScenarioDefinition } from "./scenarioDefinition";
import type { SimulationConfig } from "./simulationConfig";

// These assertions are the actual regression: `npm run typecheck` must fail if any
// `@ts-expect-error` below stops being an error (TypeScript reports an unused
// directive as an error under this repo's strict config), proving the four
// configuration layers are structurally distinct, non-interchangeable types —
// section 2's "RunOptions chooses a run... SimulationConfig owns reusable
// behavioral tuning... ScenarioDefinition owns starting world stocks... /
// DefinitionPack owns immutable type definitions" ownership boundary is a
// compile-time guarantee, not just a naming convention.
describe("configuration layer separation (compile-time)", () => {
  it("rejects assigning a ScenarioDefinition where RunOptions is required, and vice versa", () => {
    const runOptions: RunOptions = { scenarioId: "baseline-multistate-v1", seed: 7, diagnosticsLevel: "OFF" };
    const scenario: ScenarioDefinition = {
      id: "baseline-multistate-v1",
      version: "1.0.0",
      name: "Baseline multistate",
      description: "Canonical baseline scenario",
      definitionPackId: "baseline-pack-v1",
      geography: [],
      transportLinks: [],
      states: [],
      currencies: [],
      monetaryAuthorities: [],
      clans: [],
      cohorts: [],
      productionUnits: [],
    };

    // @ts-expect-error a ScenarioDefinition is not assignable to RunOptions.
    const mismatchedRunOptions: RunOptions = scenario;
    // @ts-expect-error a RunOptions is not assignable to ScenarioDefinition.
    const mismatchedScenario: ScenarioDefinition = runOptions;

    expect(runOptions.scenarioId).toBe(scenario.id);
    void mismatchedRunOptions;
    void mismatchedScenario;
  });

  it("rejects assigning a SimulationConfig where a DefinitionPack is required, and vice versa", () => {
    const simulationConfig: SimulationConfig = {
      configVersion: "1.0.0",
      numeric: {},
      cadence: {},
      markets: {},
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
    const definitionPack: DefinitionPack = {
      id: "baseline-pack-v1",
      version: "1.0.0",
      goods: {},
      recipes: {},
      eventDefinitions: {},
      metricDefinitions: {},
    };

    // @ts-expect-error a DefinitionPack is not assignable to SimulationConfig.
    const mismatchedConfig: SimulationConfig = definitionPack;
    // @ts-expect-error a SimulationConfig is not assignable to DefinitionPack.
    const mismatchedPack: DefinitionPack = simulationConfig;

    expect(simulationConfig.configVersion).not.toBe(definitionPack.id);
    void mismatchedConfig;
    void mismatchedPack;
  });
});
