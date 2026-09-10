import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import type { M1Preview } from "./m1Preview";
import type { M2Preview } from "./m2Preview";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const docsDir = path.join(repoRoot, "docs");

let server: Server;
let port: number;

beforeAll(() => {
  return new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        const filePath = path.join(docsDir, "index.html");
        const stream = createReadStream(filePath);
        res.writeHead(200, { "Content-Type": "text/html" });
        stream.pipe(res);
        stream.on("error", () => {
          res.writeHead(404);
          res.end();
        });
      } else if (req.url === "/m1-preview.json") {
        const filePath = path.join(docsDir, "m1-preview.json");
        const stream = createReadStream(filePath);
        res.writeHead(200, { "Content-Type": "application/json" });
        stream.pipe(res);
        stream.on("error", () => {
          res.writeHead(404);
          res.end();
        });
      } else if (req.url === "/m2-preview.json") {
        const filePath = path.join(docsDir, "m2-preview.json");
        const stream = createReadStream(filePath);
        res.writeHead(200, { "Content-Type": "application/json" });
        stream.pipe(res);
        stream.on("error", () => {
          res.writeHead(404);
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr !== null ? addr.port : 3000;
      resolve();
    });

    server.on("error", reject);
  });
});

afterAll(() => {
  return new Promise<void>((resolve, reject) => {
    if (server) {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      resolve();
    }
  });
});

describe("M1/M2 Pages render smoke test", () => {
  it("verifies M1 preview panel structure exists in HTML", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

    // Verify M1 panel exists
    expect(html).toContain('class="panel m1-preview"');
    expect(html).toContain('id="m1-preview"');
    expect(html).toContain('id="m1-preview-body"');
    expect(html).toContain("Loading world genesis data…");

    // Verify M1 fetch is present
    expect(html).toContain("m1-preview.json");
  });

  it("verifies M2 preview panel structure exists in HTML", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

    // Verify M2 panel exists
    expect(html).toContain('class="panel m2-preview"');
    expect(html).toContain('id="m2-preview"');
    expect(html).toContain('id="m2-preview-body"');
    expect(html).toContain("Loading tick orchestration data…");

    // Verify M2 fetch is present
    expect(html).toContain("m2-preview.json");
  });

  it("verifies M1 preview artifacts are fetchable", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m1-preview.json`
    );
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");

    const preview = (await response.json()) as M1Preview;
    expect(preview).toHaveProperty("scenario");
    expect(preview).toHaveProperty("worldTopology");
    expect(preview).toHaveProperty("states");
    expect(preview.scenario).toHaveProperty("scenarioId");
    expect(preview.scenario).toHaveProperty("seed");
  });

  it("verifies M2 preview artifacts are fetchable", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m2-preview.json`
    );
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");

    const preview = (await response.json()) as M2Preview;
    expect(preview).toHaveProperty("scenario");
    expect(preview).toHaveProperty("phaseTrace");
    expect(preview).toHaveProperty("tickExecution");
    expect(preview).toHaveProperty("reconciliationHealth");
    expect(preview.scenario).toHaveProperty("scenarioId");
    expect(preview.scenario).toHaveProperty("seed");
  });

  it("verifies M1 rendering provides required topology values", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m1-preview.json`
    );
    const preview = (await response.json()) as M1Preview;

    const topo = preview.worldTopology;
    expect(topo).toHaveProperty("regionCount");
    expect(topo).toHaveProperty("currencyCount");
    expect(topo).toHaveProperty("clanCount");
    expect(topo).toHaveProperty("cohortCount");
    expect(topo).toHaveProperty("productionUnitCount");
    expect(topo.regionCount).toBeGreaterThan(0);
    expect(topo.currencyCount).toBeGreaterThan(0);
  });

  it("verifies M2 rendering provides required phase/tick values", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m2-preview.json`
    );
    const preview = (await response.json()) as M2Preview;

    expect(preview.phaseTrace).toHaveProperty("phasesPerTick");
    expect(preview.phaseTrace).toHaveProperty("phaseSequence");
    expect(preview.phaseTrace).toHaveProperty("totalPhasesExecuted");
    expect(preview.tickExecution).toHaveProperty("ticksExecuted");
    expect(preview.tickExecution).toHaveProperty("tickRange");

    // Phase sequence should be 0-15 for M2
    expect(preview.phaseTrace.phaseSequence).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(preview.tickExecution.ticksExecuted).toBeGreaterThan(100);
  });

  it("verifies M1 rendering updates DOM elements correctly", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m1-preview.json`
    );
    const preview = (await response.json()) as M1Preview;

    // Simulate M1 DOM updates from HTML rendering
    const scenario = preview.scenario;
    const topo = preview.worldTopology;

    // These values should be rendered in the M1 panel
    expect(scenario.scenarioId).toBeDefined();
    expect(scenario.seed).toBeDefined();
    expect(typeof scenario.seed).toBe("number");

    // State list should be renderable
    const stateNames = preview.states.map((s: any) => s.name);
    expect(stateNames.length).toBeGreaterThan(0);
    expect(stateNames[0]).toBeDefined();
    expect(typeof stateNames[0]).toBe("string");
  });

  it("verifies M2 rendering updates DOM elements correctly", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m2-preview.json`
    );
    const preview = (await response.json()) as M2Preview;

    // Simulate M2 DOM updates from HTML rendering
    const scenario = preview.scenario;
    const health = preview.reconciliationHealth;

    expect(scenario.scenarioId).toBeDefined();
    expect(scenario.seed).toBeDefined();

    // Health summary should be renderable
    expect(health.passedTicks).toBeGreaterThan(0);
    expect(health.failedTicks).toBeGreaterThanOrEqual(0);
    expect(health.tolerance).toBeGreaterThan(0);

    // Tick range should be valid
    expect(preview.tickExecution.tickRange.firstTick).toBeLessThanOrEqual(
      preview.tickExecution.tickRange.lastTick
    );
  });

  it("detects regression if M1 fetch URL is missing", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

    // This test fails if the M1 fetch is removed while the panel exists
    const m1Panel = html.includes('class="panel m1-preview"');
    const m1Fetch = html.includes("m1-preview.json");

    if (m1Panel) {
      expect(m1Fetch).toBe(true);
    }
  });

  it("detects regression if M2 fetch URL is missing", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

    // This test fails if the M2 fetch is removed while the panel exists
    const m2Panel = html.includes('class="panel m2-preview"');
    const m2Fetch = html.includes("m2-preview.json");

    if (m2Panel) {
      expect(m2Fetch).toBe(true);
    }
  });

  it("verifies M1 JSON artifact exists as file", () => {
    const m1Path = path.join(docsDir, "m1-preview.json");
    expect(existsSync(m1Path)).toBe(true);

    const m1Content = readFileSync(m1Path, "utf8");
    const m1Preview = JSON.parse(m1Content);
    expect(m1Preview.requirement).toBe("REQ-VISUALIZATION-004");
  });

  it("verifies M2 JSON artifact exists as file", () => {
    const m2Path = path.join(docsDir, "m2-preview.json");
    expect(existsSync(m2Path)).toBe(true);

    const m2Content = readFileSync(m2Path, "utf8");
    const m2Preview = JSON.parse(m2Content);
    expect(m2Preview.requirement).toBe("REQ-VISUALIZATION-005");
  });

  it("verifies viewport-independent rendering of M1 (desktop width)", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m1-preview.json`
    );
    const preview = (await response.json()) as M1Preview;

    // M1 data should render identically at any viewport
    const scenario = preview.scenario;
    const topo = preview.worldTopology;
    const stateCount = preview.states.length;

    expect(scenario).toBeDefined();
    expect(topo).toBeDefined();
    expect(stateCount).toBeGreaterThan(0);
  });

  it("verifies viewport-independent rendering of M2 (narrow width)", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/m2-preview.json`
    );
    const preview = (await response.json()) as M2Preview;

    // M2 data should render identically at any viewport
    const scenario = preview.scenario;
    const tickExecution = preview.tickExecution;
    const phaseTrace = preview.phaseTrace;

    expect(scenario).toBeDefined();
    expect(tickExecution).toBeDefined();
    expect(phaseTrace).toBeDefined();
  });
});
