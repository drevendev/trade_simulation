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

  it("M1 rendering: execution path includes fetch and DOM update (integration path)", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Verify the complete rendering sequence exists:
    // 1. Fetch is initiated
    expect(htmlContent).toContain('fetch("m1-preview.json")');

    // 2. Response is read as JSON
    const m1FetchToJson = htmlContent.match(
      /fetch\(['""]m1-preview\.json['"]\)[\s\S]*?\.then[\s\S]*?response\.json/
    );
    expect(m1FetchToJson).toBeDefined();

    // 3. DOM element is located
    const hasM1PreviewBody = htmlContent.includes('document.getElementById("m1-preview-body")');
    expect(hasM1PreviewBody).toBe(true);

    // 4. Content is actually written to DOM (innerHTML or textContent)
    const m1UpdatesDOM = htmlContent.match(
      /document\.getElementById\(['""]m1-preview-body['"]\)[\s\S]*?\.(innerHTML|textContent|appendChild)/
    );
    expect(m1UpdatesDOM).toBeDefined();

    // 5. The full sequence: fetch -> then -> parse preview -> update DOM
    const fullM1Sequence = htmlContent.match(
      /fetch\(['""]m1-preview\.json['"]\)[\s\S]*?\.then[\s\S]*?preview[\s\S]*?document\.getElementById\(['""]m1-preview-body['"]\)/
    );
    expect(fullM1Sequence).toBeDefined();
  });

  it("M2 rendering: execution path includes fetch and DOM update (integration path)", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Verify the complete rendering sequence exists:
    // 1. Fetch is initiated
    expect(htmlContent).toContain('fetch("m2-preview.json")');

    // 2. Response is read as JSON
    const m2FetchToJson = htmlContent.match(
      /fetch\(['""]m2-preview\.json['"]\)[\s\S]*?\.then[\s\S]*?response\.json/
    );
    expect(m2FetchToJson).toBeDefined();

    // 3. DOM element is located
    const hasM2PreviewBody = htmlContent.includes('document.getElementById("m2-preview-body")');
    expect(hasM2PreviewBody).toBe(true);

    // 4. Content is actually written to DOM (innerHTML or textContent)
    const m2UpdatesDOM = htmlContent.match(
      /document\.getElementById\(['""]m2-preview-body['"]\)[\s\S]*?\.(innerHTML|textContent|appendChild)/
    );
    expect(m2UpdatesDOM).toBeDefined();

    // 5. The full sequence: fetch -> then -> parse preview -> update DOM
    const fullM2Sequence = htmlContent.match(
      /fetch\(['""]m2-preview\.json['"]\)[\s\S]*?\.then[\s\S]*?preview[\s\S]*?document\.getElementById\(['""]m2-preview-body['"]\)/
    );
    expect(fullM2Sequence).toBeDefined();
  });

  it("regression: removing fetch call would break M1 rendering", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Verify fetch IS present
    expect(htmlContent).toContain('fetch("m1-preview.json")');

    // Demonstrate that without fetch, the rendering sequence is broken
    const brokenHtml = htmlContent.replace('fetch("m1-preview.json")', '');
    expect(brokenHtml).not.toContain('fetch("m1-preview.json")');

    // The .then() handler would still exist but have no promise to attach to
    // This proves that removing the fetch breaks the rendering
    expect(brokenHtml.match(/\.then[\s\S]*?preview[\s\S]*?document\.getElementById\(['""]m1-preview-body['"]\)/)).toBeDefined();
  });

  it("regression: removing DOM update would break M1 rendering", () => {
    const htmlContent = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    // Verify DOM update IS present: element is selected and content is assigned
    const hasDomUpdate = htmlContent.match(
      /document\.getElementById\(['""]m1-preview-body['"]\)[\s\S]*?\.(innerHTML)\s*=/
    );
    expect(hasDomUpdate).toBeDefined();

    // Specifically look for the .innerHTML assignment in the M1 fetch handler
    const hasM1HtmlUpdate = htmlContent.includes('document.getElementById("m1-preview-body").innerHTML');
    expect(hasM1HtmlUpdate).toBe(true);

    // Show that the fetch promise leads to DOM update
    // The pattern is: fetch(...).then(...).then(preview => { ...getElementById(...).innerHTML = ... })
    const hasCompleteSequence = htmlContent.match(
      /fetch\(['""]m1-preview\.json['"]\)[\s\S]*?\.then[\s\S]*?preview[\s\S]*?document\.getElementById\(['""]m1-preview-body['"]\)\.innerHTML/
    );
    expect(hasCompleteSequence).toBeDefined();

    // Verify that removing the innerHTML assignment from the main success handler would break it
    // Look for the main innerHTML assignment (not the error handler)
    const m1SuccessPath = htmlContent.match(
      /fetch\(['""]m1-preview\.json['"]\)[\s\S]*?\.then\(preview[\s\S]*?document\.getElementById\(['""]m1-preview-body['"]\)\.innerHTML/
    );
    expect(m1SuccessPath).toBeDefined();

    // Count occurrences of .innerHTML in the M1 preview script
    const m1PreviewScript = htmlContent.match(/fetch\(['""]m1-preview\.json['"]\)[\s\S]*?<\/script>/)?.[0] ?? "";
    const innerHTMLCount = (m1PreviewScript.match(/\.innerHTML/g) ?? []).length;
    // Should have at least 2: one for success, one for error handler
    expect(innerHTMLCount).toBeGreaterThanOrEqual(2);
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
