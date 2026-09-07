import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildInitialWorld } from "../simulation/worldState";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import type { SimulationConfig } from "../config/simulationConfig";
import { generateM2Preview, type M2Preview } from "./m2Preview";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readM2Preview(): M2Preview {
  return JSON.parse(readFileSync(`${repoRoot}docs/m2-preview.json`, "utf8")) as M2Preview;
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

function generateAndWriteM2Preview(): M2Preview {
  const config = createMinimalConfig();

  // Build canonical world from baseline scenario
  const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

  // Generate M2 preview snapshot with 100+ ticks
  const preview = generateM2Preview(worldState, 101);

  // Write to docs/m2-preview.json
  writeFileSync(`${repoRoot}docs/m2-preview.json`, JSON.stringify(preview, null, 2));

  return preview;
}

// Generate the M2 preview before running any tests
beforeAll(() => {
  generateAndWriteM2Preview();
});

describe("M2 Milestone Preview diagnostic artifact (REQ-VISUALIZATION-005)", () => {
  it("declares the M2 milestone", () => {
    const preview = readM2Preview();
    expect(preview.milestone).toBe("M2");
  });

  it("declares REQ-VISUALIZATION-005 as the requirement", () => {
    const preview = readM2Preview();
    expect(preview.requirement).toBe("REQ-VISUALIZATION-005");
  });

  it("exposes scenario ID, seed and config version", () => {
    const preview = readM2Preview();
    expect(preview.scenario.scenarioId).toBeDefined();
    expect(preview.scenario.seed).toBe(42);
    expect(preview.scenario.configVersion).toBeDefined();
  });

  it("executes exactly 101 ticks", () => {
    const preview = readM2Preview();
    expect(preview.tickExecution.ticksExecuted).toBe(101);
  });

  it("proves phase trace 0–15 exactly with no phase 16", () => {
    const preview = readM2Preview();
    const trace = preview.phaseTrace;

    expect(trace.phasesPerTick).toBe(16);
    expect(trace.phaseSequence).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(trace.totalPhasesExecuted).toBe(16 * 101);
  });

  it("preserves tick counter across the run", () => {
    const preview = readM2Preview();
    const tickExecution = preview.tickExecution;

    expect(tickExecution.tickRange.firstTick).toBe(1);
    expect(tickExecution.tickRange.lastTick).toBe(101);
    expect(tickExecution.ticksExecuted).toBe(101);
  });

  it("passes zero-flow reconciliation for all ticks in the no-op scenario", () => {
    const preview = readM2Preview();
    const reconciliation = preview.reconciliationHealth;

    // All 101 ticks should pass reconciliation in no-op scenario
    expect(reconciliation.passedTicks).toBe(101);
    expect(reconciliation.failedTicks).toBe(0);
    expect(reconciliation.failureDetails).toHaveLength(0);
  });

  it("uses the configured reconciliation tolerance", () => {
    const preview = readM2Preview();
    expect(preview.reconciliationHealth.tolerance).toBe(1e-9);
  });

  it("exposes non-zero world topology counts", () => {
    const preview = readM2Preview();
    const topology = preview.worldTopology;

    expect(topology.stateCount).toBeGreaterThan(0);
    expect(topology.regionCount).toBeGreaterThan(0);
    expect(topology.currencyCount).toBeGreaterThan(0);
    expect(topology.clanCount).toBeGreaterThan(0);
    expect(topology.cohortCount).toBeGreaterThan(0);
    expect(topology.productionUnitCount).toBeGreaterThan(0);
  });

  it("generates deterministically from baseline scenario with seed 42", () => {
    const config = createMinimalConfig();
    const worldState1 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
    const preview1 = generateM2Preview(worldState1, 101);

    const worldState2 = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);
    const preview2 = generateM2Preview(worldState2, 101);

    // Both generated previews must be identical
    expect(JSON.stringify(preview1, null, 2)).toBe(JSON.stringify(preview2, null, 2));
  });

  it("produces a valid one-way read-only diagnostic artifact", () => {
    const preview = readM2Preview();

    // Must be serializable (no functions or symbols)
    const serialized = JSON.stringify(preview);
    expect(serialized).toBeDefined();

    // Must not reference or expose mutable domain objects
    expect(serialized).not.toContain("Map");
    expect(serialized).not.toContain("Set");

    // Must include the requirement ID for traceability
    expect(preview.requirement).toBe("REQ-VISUALIZATION-005");
  });
});

describe("docs/index.html M2 preview panel wiring", () => {
  it("fetches the static one-way diagnostic artifact for M2", () => {
    const html = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // M2 preview must be referenced in the HTML
    expect(html).toContain("m2-preview.json");
  });

  it("does not import or reference mutable simulation modules in preview", () => {
    const html = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Preview must not reference simulation internals that could mutate state
    const m2PreviewMatch = html.match(/<script[^>]*id="m2-preview[^"]*"[^>]*>[\s\S]*?<\/script>/);
    if (m2PreviewMatch) {
      const m2Script = m2PreviewMatch[0];
      expect(m2Script).not.toContain("src/simulation");
      expect(m2Script).not.toContain("executeTick");
    }
  });
});
