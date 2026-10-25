/** M5 #669: directed topology is authoritative at genesis; the index is read-only derivation. */
import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ScenarioDefinition } from "../config/scenarioDefinition";
import { buildInitialWorld, type WorldState } from "./worldState";

function sparseScenario(): ScenarioDefinition {
  return {
    ...baselineScenario,
    transportLinks: [
      { ...baselineScenario.transportLinks[0]!, bidirectional: false },
      { ...baselineScenario.transportLinks[1]!, bidirectional: true },
    ],
  };
}

function genesis(scenario: ScenarioDefinition): WorldState {
  return buildInitialWorld(scenario, baselineDefinitionPack, createDefaultSimulationConfig(), 7);
}

function routesByName(world: WorldState): readonly (readonly [string, string, string])[] {
  const names = new Map([...world.regions].map(([id, region]) => [id, region.seed.key]));
  return [...world.transportLinks.values()].map(
    (link) => [link.linkId, names.get(link.fromRegionId)!, names.get(link.toRegionId)!] as const,
  );
}

describe("M5 sparse directed transport topology (#669)", () => {
  it("resolves one-way and reverse endpoints without inventing a return edge", () => {
    const world = genesis(sparseScenario());
    const routes = routesByName(world);
    expect(routes.map(([, from, to]) => [from, to])).toEqual([
      ["region:a1-capital", "region:a2-farm"],
      ["region:a2-farm", "region:a3-forest"],
      ["region:a3-forest", "region:a2-farm"],
    ]);
    expect(routes).toHaveLength(3);
    expect(routes.some(([, from, to]) =>
      from === "region:a2-farm" && to === "region:a1-capital",
    )).toBe(false);

    // Reverse is not a duplicate forward edge even though both share seed provenance.
    const [, original, reverse] = [...world.transportLinks.values()];
    expect(original?.seed.key).toBe(reverse?.seed.key);
    expect(original?.fromRegionId).toBe(reverse?.toRegionId);
    expect(original?.toRegionId).toBe(reverse?.fromRegionId);
  });

  it("indexes only configured outbound links, including no edges for isolated regions", () => {
    const world = genesis(sparseScenario());
    const names = new Map([...world.regions].map(([id, region]) => [region.seed.key, id]));
    const idx = world.outgoingTransportLinkIdsByRegion;
    expect(idx).toBeDefined();
    const routeNames = (name: string) => (idx?.get(names.get(name)!) ?? []).map((id) => {
      const link = world.transportLinks.get(id)!;
      return [...world.regions.values()].find((r) => r.regionId === link.toRegionId)?.seed.key;
    });
    expect(routeNames("region:a1-capital")).toEqual(["region:a2-farm"]);
    expect(routeNames("region:a2-farm")).toEqual(["region:a3-forest"]);
    expect(routeNames("region:a3-forest")).toEqual(["region:a2-farm"]);
    expect(routeNames("region:a4-border")).toEqual([]);
    expect([...idx!.values()].reduce((sum, links) => sum + links.length, 0))
      .toBe(world.transportLinks.size);
  });

  it("keeps directed IDs, routes and index ordering stable under seed and region insertion permutations", () => {
    const scenario = sparseScenario();
    const first = genesis(scenario);
    const second = genesis({
      ...scenario,
      transportLinks: [...scenario.transportLinks].reverse(),
      geography: [...scenario.geography].reverse(),
    });
    expect(routesByName(second)).toEqual(routesByName(first));
    expect([...second.outgoingTransportLinkIdsByRegion!]).toEqual([
      ...first.outgoingTransportLinkIdsByRegion!,
    ]);
  });
});
