import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildInitialWorld } from "../simulation/worldState";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import type { SimulationConfig } from "../config/simulationConfig";
import { generateM1Preview, type M1Preview } from "./m1Preview";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readM1Preview(): M1Preview {
  return JSON.parse(readFileSync(`${repoRoot}docs/m1-preview.json`, "utf8")) as M1Preview;
}

function createMinimalConfig(): SimulationConfig {
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
      minimumPrice: 0.01,
      maximumPrice: 1000,
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

function generateAndWriteM1Preview(): M1Preview {
  const config = createMinimalConfig();

  // Build canonical world from baseline scenario
  const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

  // Generate M1 preview snapshot
  const preview = generateM1Preview(worldState);

  // Write to docs/m1-preview.json
  writeFileSync(`${repoRoot}docs/m1-preview.json`, JSON.stringify(preview, null, 2));

  return preview;
}

// Generate the M1 preview before running any tests
beforeAll(() => {
  generateAndWriteM1Preview();
});

describe("M1 Milestone Preview diagnostic artifact (REQ-VISUALIZATION-004)", () => {
  it("declares the M1 milestone", () => {
    const preview = readM1Preview();
    expect(preview.milestone).toBe("M1");
  });

  it("declares REQ-VISUALIZATION-004 as the requirement", () => {
    const preview = readM1Preview();
    expect(preview.requirement).toBe("REQ-VISUALIZATION-004");
  });

  it("exposes scenario ID, seed and config version", () => {
    const preview = readM1Preview();
    expect(preview.scenario.scenarioId).toBeDefined();
    expect(preview.scenario.seed).toBeDefined();
    expect(preview.scenario.configVersion).toBeDefined();
  });

  it("exposes non-zero world topology counts", () => {
    const preview = readM1Preview();
    const topology = preview.worldTopology;

    expect(topology.stateCount).toBeGreaterThan(0);
    expect(topology.regionCount).toBeGreaterThan(0);
    expect(topology.currencyCount).toBeGreaterThan(0);
    expect(topology.clanCount).toBeGreaterThan(0);
    expect(topology.cohortCount).toBeGreaterThan(0);
    expect(topology.productionUnitCount).toBeGreaterThan(0);
  });

  it("exposes State details with counts and currency bindings", () => {
    const preview = readM1Preview();

    expect(preview.states.length).toBeGreaterThan(0);
    for (const state of preview.states) {
      expect(state.stateId).toBeDefined();
      expect(state.name).toBeDefined();
      expect(state.currencyId).toBeDefined();
      expect(state.regionCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("exposes Currency details with issuer authority bindings", () => {
    const preview = readM1Preview();

    expect(preview.currencies.length).toBeGreaterThan(0);
    for (const currency of preview.currencies) {
      expect(currency.currencyId).toBeDefined();
      expect(currency.code).toBeDefined();
      // issuerAuthorityId may be null
    }
  });

  it("exposes Region details with State control assignment", () => {
    const preview = readM1Preview();

    expect(preview.regions.length).toBeGreaterThan(0);
    for (const region of preview.regions) {
      expect(region.regionId).toBeDefined();
      expect(region.name).toBeDefined();
      expect(region.settlementCurrencyId).toBeDefined();
      // controllerStateId may be null
    }
  });

  it("exposes Clan details with names", () => {
    const preview = readM1Preview();

    expect(preview.clans.length).toBeGreaterThan(0);
    for (const clan of preview.clans) {
      expect(clan.clanId).toBeDefined();
      expect(clan.name).toBeDefined();
    }
  });

  it("generates deterministically from baseline scenario with seed 42", () => {
    const config = createMinimalConfig();
    const worldState1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
    const preview1 = generateM1Preview(worldState1);

    const worldState2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
    const preview2 = generateM1Preview(worldState2);

    // Both generated previews must be identical
    expect(JSON.stringify(preview1, null, 2)).toBe(JSON.stringify(preview2, null, 2));
  });

  it("produces a valid one-way read-only diagnostic artifact", () => {
    const preview = readM1Preview();

    // Must be serializable (no functions or symbols)
    const serialized = JSON.stringify(preview);
    expect(serialized).toBeDefined();

    // Must not reference or expose mutable domain objects
    expect(serialized).not.toContain("Map");
    expect(serialized).not.toContain("Set");

    // Must include the requirement ID for traceability
    expect(preview.requirement).toBe("REQ-VISUALIZATION-004");
  });
});

describe("docs/index.html M1 preview panel wiring", () => {
  it("fetches the static one-way diagnostic artifact for M1", () => {
    const html = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // M1 preview must be referenced in the HTML
    expect(html).toContain("m1-preview.json");
  });

  it("does not import or reference mutable simulation modules in preview", () => {
    const html = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Preview must not reference simulation internals that could mutate state
    const m1PreviewMatch = html.match(/<script[^>]*id="m1-preview[^"]*"[^>]*>[\s\S]*?<\/script>/);
    if (m1PreviewMatch) {
      const m1Script = m1PreviewMatch[0];
      expect(m1Script).not.toContain("src/simulation");
      expect(m1Script).not.toContain("buildInitialWorld");
    }
  });
});
