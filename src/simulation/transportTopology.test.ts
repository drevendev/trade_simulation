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

  it("normalizes explicit and inherited transit durations on every directed edge", () => {
    const scenario = sparseScenario();
    const configured = createDefaultSimulationConfig();
    // exactOptionalPropertyTypes requires a truly absent seed override, not an
    // explicitly undefined property. This is the fallback we want to verify.
    const fallbackLink = { ...scenario.transportLinks[1]! };
    delete fallbackLink.transitTicks;
    const withTravelTicks = {
      ...scenario,
      transportLinks: [
        { ...scenario.transportLinks[0]!, transitTicks: 3 },
        fallbackLink,
      ],
    };
    const config = {
      ...configured,
      trade: { ...configured.trade, defaultTransitTicksPerLink: 4 },
    };
    const world = buildInitialWorld(withTravelTicks, baselineDefinitionPack, config, 7);
    expect([...world.transportLinks.values()].map((link) => link.travelTicks)).toEqual([3, 4, 4]);
    expect([...world.transportLinks.values()].map((link) => link.seed.transitTicks))
      .toEqual([3, undefined, undefined]);

    const reordered = buildInitialWorld({
      ...withTravelTicks,
      transportLinks: [...withTravelTicks.transportLinks].reverse(),
      geography: [...withTravelTicks.geography].reverse(),
    }, baselineDefinitionPack, config, 7);
    expect([...reordered.transportLinks.values()].map((link) => [link.linkId, link.travelTicks]))
      .toEqual([...world.transportLinks.values()].map((link) => [link.linkId, link.travelTicks]));
  });

  it("keeps zero travel ticks but rejects fractional, negative and non-finite durations at genesis", () => {
    const scenario = sparseScenario();
    const withDuration = (duration: number): ScenarioDefinition => ({
      ...scenario,
      transportLinks: [
        { ...scenario.transportLinks[0]!, transitTicks: duration },
        scenario.transportLinks[1]!,
      ],
    });
    const zeroDurationWorld = genesis(withDuration(0));
    expect([...zeroDurationWorld.transportLinks.values()][0]?.travelTicks).toBe(0);
    for (const invalid of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => genesis(withDuration(invalid)), `transitTicks=${invalid}`)
        .toThrow('TransportLinkSeed');
    }
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
  it("resolves a declared State fee receiver on both directions without assuming destination ownership", () => {
    const interstate = baselineScenario.transportLinks.find((link) => link.key === "link:a4-b4")!;
    const world = genesis({ ...baselineScenario, transportLinks: [interstate] });
    const receiverId = [...world.states.values()].find((state) => state.seed.key === "state:beta")!.stateId;
    const alphaRegion = [...world.regions.values()].find((region) => region.seed.key === "region:a4-border")!;
    const [forward, reverse] = [...world.transportLinks.values()];

    expect(forward!.feeReceiver).toEqual({ type: "STATE", stateId: receiverId });
    expect(reverse!.feeReceiver).toEqual(forward!.feeReceiver);
    expect(forward!.seed.feeReceiverStateKey).toBe("state:beta");
    expect(reverse!.seed.feeReceiverStateKey).toBe("state:beta");
    // Reverse direction is invoiced in Alpha currency even though its configured
    // payee is Beta: settlement must not silently convert the receiver's cash.
    expect(reverse!.toRegionId).toBe(alphaRegion.regionId);
    expect(world.states.get(receiverId)!.effectiveCurrencyId).not.toBe(alphaRegion.settlementCurrencyId);
  });

  it("preserves null and absent receiver declarations without inventing a fee beneficiary", () => {
    const link = baselineScenario.transportLinks[0]!;
    const withoutReceiver = { ...link };
    delete withoutReceiver.feeReceiverStateKey;
    for (const candidate of [{ ...link, feeReceiverStateKey: null }, withoutReceiver]) {
      const world = genesis({ ...baselineScenario, transportLinks: [candidate] });
      expect([...world.transportLinks.values()].map((route) => route.feeReceiver))
        .toEqual([null, null]);
      expect([...world.transportLinks.values()].map((route) => route.seed.feeReceiverStateKey))
        .toEqual([candidate.feeReceiverStateKey, candidate.feeReceiverStateKey]);
    }
  });

  it("fails genesis for unknown, blank or non-State fee receivers", () => {
    const original = baselineScenario.transportLinks[0]!;
    for (const key of ["state:does-not-exist", "clan:alpha", "", "  "]) {
      const scenario = {
        ...baselineScenario,
        transportLinks: [{ ...original, feeReceiverStateKey: key }],
      };
      expect(() => genesis(scenario), `feeReceiverStateKey=${JSON.stringify(key)}`)
        .toThrow("feeReceiverStateKey");
    }
  });

  it("keeps fee receiver IDs and link ordering stable under State/Region/seed reorder", () => {
    const chosen = baselineScenario.transportLinks.filter((link) => link.feeReceiverStateKey !== null);
    const first = genesis({ ...baselineScenario, transportLinks: chosen });
    const permuted = genesis({
      ...baselineScenario,
      states: [...baselineScenario.states].reverse(),
      geography: [...baselineScenario.geography].reverse(),
      transportLinks: [...chosen].reverse(),
    });
    const signature = (world: WorldState) => [...world.transportLinks.values()]
      .map((link) => [link.linkId, link.fromRegionId, link.toRegionId, link.feeReceiver]);
    expect(signature(permuted)).toEqual(signature(first));
  });

});
