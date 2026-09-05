import { describe, expect, it } from "vitest";

import type { ScenarioDefinition } from "../config/scenarioDefinition";
import { createIdAllocator } from "./id";
import { buildWorldRegistries } from "./worldRegistries";

/** A fixture scenario with distinct, non-zero counts per registry, plus two legitimately empty ones. */
function fixtureScenario(): ScenarioDefinition {
  return {
    id: "fixture-scenario",
    version: "1",
    name: "Fixture",
    description: "REQ-CORE-003 registry-population fixture",
    definitionPackId: "fixture-pack",
    geography: [{}, {}, {}],
    transportLinks: [],
    states: [{}, {}],
    currencies: [{}],
    monetaryAuthorities: [],
    clans: [{}, {}],
    cohorts: [{}, {}, {}, {}],
    productionUnits: [{}, {}, {}],
    // markets, bonds, initialEvents deliberately omitted: legitimately empty/non-active.
  };
}

describe("buildWorldRegistries", () => {
  it("creates exactly the scenario-defined entity counts", () => {
    const registries = buildWorldRegistries(fixtureScenario(), createIdAllocator());

    expect(registries.regions.size).toBe(3);
    expect(registries.states.size).toBe(2);
    expect(registries.currencies.size).toBe(1);
    expect(registries.clans.size).toBe(2);
    expect(registries.cohorts.size).toBe(4);
    expect(registries.productionUnits.size).toBe(3);
  });

  it("leaves a registry legitimately empty when the scenario omits or empties its seed list", () => {
    const registries = buildWorldRegistries(fixtureScenario(), createIdAllocator());

    expect(registries.transportLinks.size).toBe(0);
    expect(registries.markets.size).toBe(0);
  });

  it("keys every entry by its own allocated ID with the correct id-kind prefix, no duplicates", () => {
    const registries = buildWorldRegistries(fixtureScenario(), createIdAllocator());

    for (const [id, entry] of registries.regions) {
      expect(entry.id).toBe(id);
      expect(id).toMatch(/^r:\d+$/);
    }
    expect(new Set(registries.regions.keys()).size).toBe(registries.regions.size);

    for (const [id, entry] of registries.productionUnits) {
      expect(entry.id).toBe(id);
      expect(id).toMatch(/^pu:\d+$/);
    }
  });

  it("does not allocate the same ID to two different entities across registries", () => {
    const registries = buildWorldRegistries(fixtureScenario(), createIdAllocator());

    const allIds = [
      ...registries.regions.keys(),
      ...registries.states.keys(),
      ...registries.currencies.keys(),
      ...registries.clans.keys(),
      ...registries.cohorts.keys(),
      ...registries.productionUnits.keys(),
      ...registries.markets.keys(),
      ...registries.transportLinks.keys(),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("is field-equivalent across repeated genesis with the same scenario and a fresh allocator", () => {
    const scenario = fixtureScenario();
    const first = buildWorldRegistries(scenario, createIdAllocator());
    const second = buildWorldRegistries(scenario, createIdAllocator());

    expect([...first.regions.keys()]).toEqual([...second.regions.keys()]);
    expect([...first.cohorts.keys()]).toEqual([...second.cohorts.keys()]);
    expect([...first.productionUnits.keys()]).toEqual([...second.productionUnits.keys()]);
  });
});
