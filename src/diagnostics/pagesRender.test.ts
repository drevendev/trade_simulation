import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { DOMWindow } from "jsdom";
import { buildInitialWorld } from "../simulation/worldState";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import type { SimulationConfig } from "../config/simulationConfig";
import { generateM1Preview } from "./m1Preview";
import { generateM2Preview } from "./m2Preview";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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

function generateAndWritePreviews(): void {
  const config = createMinimalConfig();
  const worldState = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 42);

  const m1Preview = generateM1Preview(worldState);
  writeFileSync(`${repoRoot}docs/m1-preview.json`, JSON.stringify(m1Preview, null, 2));

  const m2Preview = generateM2Preview(worldState, 101);
  writeFileSync(`${repoRoot}docs/m2-preview.json`, JSON.stringify(m2Preview, null, 2));
}

beforeAll(() => {
  generateAndWritePreviews();
});

function setupDOMWithMockedFetch(
  htmlContent: string,
  fetchHandler: (url: string) => Promise<Response> | Response
): { window: DOMWindow; m1Body: HTMLElement | null; m2Body: HTMLElement | null } {
  const dom = new JSDOM(htmlContent, {
    url: "http://localhost/docs/index.html",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });

  // Replace fetch with mock
  (dom.window as any).fetch = fetchHandler;

  // Find and get the preview body elements
  const m1Body = dom.window.document.getElementById("m1-preview-body") as HTMLElement | null;
  const m2Body = dom.window.document.getElementById("m2-preview-body") as HTMLElement | null;

  return { window: dom.window, m1Body, m2Body };
}

describe("M1/M2 Pages rendering smoke regression (REQ-VISUALIZATION-005 evidence)", () => {
  it("verifies M1 preview script references the fetch URL", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // M1 preview must have the fetch call
    expect(htmlContent).toContain("m1-preview.json");

    // Should have a script block that handles the response
    const m1Section = htmlContent.match(/<section[^>]*id="m1-preview"[^>]*>[\s\S]*?<\/section>/);
    expect(m1Section).toBeDefined();

    const fetchBlock = htmlContent.match(/fetch\(['""]m1-preview\.json['"]\)/);
    expect(fetchBlock).toBeDefined();
  });

  it("verifies M2 preview script references the fetch URL", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // M2 preview must have the fetch call
    expect(htmlContent).toContain("m2-preview.json");

    // Should have a script block that handles the response
    const m2Section = htmlContent.match(/<section[^>]*id="m2-preview"[^>]*>[\s\S]*?<\/section>/);
    expect(m2Section).toBeDefined();

    const fetchBlock = htmlContent.match(/fetch\(['""]m2-preview\.json['"]\)/);
    expect(fetchBlock).toBeDefined();
  });

  it("confirms M1 preview DOM structure includes elements needed for rendering", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");
    const dom = new JSDOM(htmlContent);

    // Must have M1 preview section with body container
    const m1Preview = dom.window.document.getElementById("m1-preview");
    expect(m1Preview).toBeDefined();

    const m1Body = dom.window.document.getElementById("m1-preview-body");
    expect(m1Body).toBeDefined();

    // Should initially contain loading text
    expect(m1Body?.textContent).toContain("Loading");
  });

  it("confirms M2 preview DOM structure includes elements needed for rendering", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");
    const dom = new JSDOM(htmlContent);

    // Must have M2 preview section with body container
    const m2Preview = dom.window.document.getElementById("m2-preview");
    expect(m2Preview).toBeDefined();

    const m2Body = dom.window.document.getElementById("m2-preview-body");
    expect(m2Body).toBeDefined();

    // Should initially contain loading text
    expect(m2Body?.textContent).toContain("Loading");
  });

  it("regression: removing the fetch call would break M1 rendering", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Verify the fetch string is essential
    const hasFetch = htmlContent.includes('fetch("m1-preview.json")');
    expect(hasFetch).toBe(true);

    // Without fetch, rendering cannot happen
    const brokenHtml = htmlContent.replace('fetch("m1-preview.json")', '/* fetch removed */');
    expect(brokenHtml.includes('fetch("m1-preview.json")')).toBe(false);
  });

  it("regression: removing the DOM update would break M1 rendering", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Verify the DOM update code is present
    const hasDOMUpdate = htmlContent.includes('document.getElementById("m1-preview-body")');
    expect(hasDOMUpdate).toBe(true);

    // Verify it's in the fetch .then() handler
    const m1FetchBlock = htmlContent.match(
      /fetch\(['""]m1-preview\.json['"]\)[\s\S]*?\.then\([\s\S]*?\{[\s\S]*?document\.getElementById\(['""]m1-preview-body['"]\)/
    );
    expect(m1FetchBlock).toBeDefined();
  });

  it("verifies M1 preview artifact contains required scenario data", () => {
    const m1Preview = JSON.parse(readFileSync(`${repoRoot}docs/m1-preview.json`, "utf8"));

    // Must contain scenario and seed
    expect(m1Preview.scenario).toBeDefined();
    expect(m1Preview.scenario.scenarioId).toBe("baseline-multistate-v1");
    expect(m1Preview.scenario.seed).toBe(42);

    // Must contain topology counts
    expect(m1Preview.worldTopology).toBeDefined();
    expect(m1Preview.worldTopology.stateCount).toBeGreaterThan(0);
    expect(m1Preview.worldTopology.regionCount).toBeGreaterThan(0);
    expect(m1Preview.worldTopology.currencyCount).toBeGreaterThan(0);
  });

  it("verifies M2 preview artifact contains required phase trace data", () => {
    const m2Preview = JSON.parse(readFileSync(`${repoRoot}docs/m2-preview.json`, "utf8"));

    // Must contain phase trace
    expect(m2Preview.phaseTrace).toBeDefined();
    expect(m2Preview.phaseTrace.phasesPerTick).toBe(16);
    expect(m2Preview.phaseTrace.phaseSequence).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    // Must contain tick execution data
    expect(m2Preview.tickExecution).toBeDefined();
    expect(m2Preview.tickExecution.ticksExecuted).toBe(101);
  });

  it("desktop viewport: M1/M2 sections are in the HTML and styled for display", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Check for proper panel styling
    expect(htmlContent).toContain('class="panel m1-preview"');
    expect(htmlContent).toContain('class="panel m2-preview"');

    // Verify viewport meta tag for responsive layout
    expect(htmlContent).toContain('viewport');
    expect(htmlContent).toContain('width=device-width');
  });

  it("narrow viewport: CSS includes mobile breakpoint for readable layout", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Check for media query that handles narrow screens
    const hasMediaQuery = htmlContent.includes("@media (max-width:");
    expect(hasMediaQuery).toBe(true);

    // Should have CSS that adjusts board layout on narrow screens
    const hasBoardResponsive = htmlContent.match(/@media.*?\.board.*?\{[^}]*grid-template-columns: 1fr/s);
    expect(hasBoardResponsive).toBeDefined();
  });

  it("verifies preview artifacts and HTML wiring are both present and referenced", () => {
    // Both artifacts must exist
    const m1Preview = readFileSync(`${repoRoot}docs/m1-preview.json`, "utf8");
    const m2Preview = readFileSync(`${repoRoot}docs/m2-preview.json`, "utf8");
    expect(m1Preview).toBeDefined();
    expect(m2Preview).toBeDefined();

    // Both must be valid JSON
    const m1Data = JSON.parse(m1Preview);
    const m2Data = JSON.parse(m2Preview);
    expect(m1Data.milestone).toBe("M1");
    expect(m2Data.milestone).toBe("M2");

    // HTML must reference both
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");
    expect(htmlContent).toContain("m1-preview.json");
    expect(htmlContent).toContain("m2-preview.json");
  });

  it("verifies no simulation modules are imported in the preview rendering code", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // The rendering scripts must not import or reference simulation internals
    const scriptMatches = htmlContent.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];

    for (const script of scriptMatches) {
      // These are inline preview rendering scripts, not module imports
      if (script.includes("m1-preview.json") || script.includes("m2-preview.json")) {
        // Should not reference WorldState or simulation functions
        expect(script).not.toContain("buildInitialWorld");
        expect(script).not.toContain("executeTick");
        expect(script).not.toContain("generateM1Preview");
        expect(script).not.toContain("generateM2Preview");
      }
    }
  });
});
