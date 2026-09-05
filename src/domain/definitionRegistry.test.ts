import { describe, expect, it } from "vitest";

import type { DefinitionPack } from "../config/definitionPack";
import { buildDefinitionRegistry } from "./definitionRegistry";

describe("buildDefinitionRegistry", () => {
  it("carries every DefinitionPack definitions field through unchanged", () => {
    const definitionPack: DefinitionPack = {
      id: "fixture-pack",
      version: "1",
      goods: { "good:1": {} } as DefinitionPack["goods"],
      recipes: { "recipe-a": {} },
      eventDefinitions: { "event-a": {} },
      metricDefinitions: { "metric-a": {} },
    };

    const registry = buildDefinitionRegistry(definitionPack);

    expect(registry.goods).toBe(definitionPack.goods);
    expect(registry.recipes).toBe(definitionPack.recipes);
    expect(registry.eventDefinitions).toBe(definitionPack.eventDefinitions);
    expect(registry.metricDefinitions).toBe(definitionPack.metricDefinitions);
  });

  it("leaves an empty definition pack as an empty registry, not an error", () => {
    const definitionPack: DefinitionPack = {
      id: "empty-pack",
      version: "1",
      goods: {},
      recipes: {},
      eventDefinitions: {},
      metricDefinitions: {},
    };

    const registry = buildDefinitionRegistry(definitionPack);

    expect(Object.keys(registry.goods)).toHaveLength(0);
    expect(Object.keys(registry.recipes)).toHaveLength(0);
  });
});
