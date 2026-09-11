import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { JSDOM, type DOMWindow } from "jsdom";
import { chromium, type Browser } from "playwright";
import type { M1Preview } from "./m1Preview";
import type { M2Preview } from "./m2Preview";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const docsDir = path.join(repoRoot, "docs");

let server: Server;
let port: number;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const requestPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
      const filePath = path.join(docsDir, requestPath);

      if (!filePath.startsWith(docsDir) || !existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }

      const contentType = filePath.endsWith(".json")
        ? "application/json"
        : filePath.endsWith(".csv")
          ? "text/csv"
          : "text/html";
      res.writeHead(200, { "Content-Type": contentType });
      const stream = createReadStream(filePath);
      stream.pipe(res);
      stream.on("error", () => {
        res.writeHead(404);
        res.end();
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr !== null ? addr.port : 3000;
      baseUrl = `http://127.0.0.1:${port}/`;
      resolve();
    });

    server.on("error", reject);
  });

  browser = await chromium.launch({ args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    if (server) {
      server.close((err) => (err ? reject(err) : resolve()));
    } else {
      resolve();
    }
  });
});

/**
 * Loads the real docs/index.html into a jsdom document and lets its inline scripts run,
 * so tests observe actual DOM mutation from the page's own render path rather than
 * re-implementing it against fetched JSON. `fetch` is bound to the local static server
 * started above; jsdom itself does not implement `window.fetch`.
 */
function loadDom(
  options: { transformHtml?: (html: string) => string; innerWidth?: number } = {}
): DOMWindow {
  const html = readFileSync(path.join(docsDir, "index.html"), "utf8");
  const finalHtml = options.transformHtml ? options.transformHtml(html) : html;

  const dom = new JSDOM(finalHtml, {
    url: baseUrl,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (options.innerWidth !== undefined) {
        Object.defineProperty(window, "innerWidth", {
          value: options.innerWidth,
          configurable: true,
        });
      }
      window.fetch = ((input: string, init?: RequestInit) =>
        fetch(new URL(input, baseUrl).toString(), init)) as typeof window.fetch;
    },
  });

  return dom.window;
}

async function waitForText(
  window: DOMWindow,
  elementId: string,
  predicate: (text: string) => boolean,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const text = window.document.getElementById(elementId)?.textContent ?? "";
    if (predicate(text)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for #${elementId} to satisfy the expected condition.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Loads the page and waits until both the M1 and M2 panels have finished rendering. */
async function renderPage(options: { innerWidth?: number } = {}): Promise<DOMWindow> {
  const window = loadDom(options);
  await waitForText(window, "m1-preview-body", (text) => !text.includes("Loading world genesis data"));
  await waitForText(
    window,
    "m2-preview-body",
    (text) => !text.includes("Loading tick orchestration data")
  );
  return window;
}

/**
 * Loads the real Pages site in a real Chromium tab at the given viewport, optionally
 * injecting a CSS rule after navigation. Unlike jsdom, Playwright performs actual layout,
 * so `locator.isVisible()` reflects a non-empty bounding box and non-`visibility:hidden`
 * computed style — it catches both hidden and clipped content, not just `display: none`.
 */
async function renderPageInBrowser(options: {
  viewportWidth: number;
  injectCss?: string;
}): Promise<import("playwright").Page> {
  const page = await browser.newPage();
  await page.setViewportSize({ width: options.viewportWidth, height: 900 });
  await page.goto(baseUrl);
  if (options.injectCss) {
    await page.addStyleTag({ content: options.injectCss });
  }
  await page.waitForFunction(
    () => !(document.getElementById("m1-preview-body")?.textContent ?? "").includes(
      "Loading world genesis data"
    )
  );
  await page.waitForFunction(
    () => !(document.getElementById("m2-preview-body")?.textContent ?? "").includes(
      "Loading tick orchestration data"
    )
  );
  return page;
}

/**
 * Playwright's `isVisible()` reflects a non-empty bounding box and non-`visibility:hidden`
 * computed style, but it does not check opacity: an `opacity: 0` element is "visible" by
 * that definition while being fully transparent and unreadable. This combines `isVisible()`
 * with an explicit computed-opacity check so "readable" also rules out that gap.
 */
async function isReadable(locator: import("playwright").Locator): Promise<boolean> {
  if (!(await locator.isVisible())) return false;
  const opacity = await locator.evaluate((el) => window.getComputedStyle(el).opacity);
  return opacity !== "0";
}

/** Bypasses the M1 DOM-population write while leaving the milestone-tag update and the JSON fetch intact. */
function bypassM1Population(html: string): string {
  const marker = 'document.getElementById("m1-preview-body").innerHTML = `';
  if (!html.includes(marker)) {
    throw new Error("m1-preview-body population marker not found; index.html render script changed shape");
  }
  return html.replace(marker, `return; ${marker}`);
}

/** Bypasses the M2 DOM-population write while leaving the milestone-tag update and the JSON fetch intact. */
function bypassM2Population(html: string): string {
  const marker = 'document.getElementById("m2-preview-body").innerHTML = `';
  if (!html.includes(marker)) {
    throw new Error("m2-preview-body population marker not found; index.html render script changed shape");
  }
  return html.replace(marker, `return; ${marker}`);
}

describe("M1/M2 Pages render smoke test", () => {
  it("verifies M1 preview panel structure exists in HTML", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

    expect(html).toContain('class="panel m1-preview"');
    expect(html).toContain('id="m1-preview"');
    expect(html).toContain('id="m1-preview-body"');
    expect(html).toContain("Loading world genesis data…");
    expect(html).toContain("m1-preview.json");
  });

  it("verifies M2 preview panel structure exists in HTML", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

    expect(html).toContain('class="panel m2-preview"');
    expect(html).toContain('id="m2-preview"');
    expect(html).toContain('id="m2-preview-body"');
    expect(html).toContain("Loading tick orchestration data…");
    expect(html).toContain("m2-preview.json");
  });

  it("verifies M1 preview artifacts are fetchable", async () => {
    const response = await fetch(`${baseUrl}m1-preview.json`);
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
    const response = await fetch(`${baseUrl}m2-preview.json`);
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
    const response = await fetch(`${baseUrl}m1-preview.json`);
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
    const response = await fetch(`${baseUrl}m2-preview.json`);
    const preview = (await response.json()) as M2Preview;

    expect(preview.phaseTrace).toHaveProperty("phasesPerTick");
    expect(preview.phaseTrace).toHaveProperty("phaseSequence");
    expect(preview.phaseTrace).toHaveProperty("totalPhasesExecuted");
    expect(preview.tickExecution).toHaveProperty("ticksExecuted");
    expect(preview.tickExecution).toHaveProperty("tickRange");

    expect(preview.phaseTrace.phaseSequence).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(preview.tickExecution.ticksExecuted).toBeGreaterThan(100);
  });

  it("executes the real M1 render path and populates the DOM after the preview fetch resolves", async () => {
    const window = await renderPage();
    const document = window.document;
    const m1Json = (await (await fetch(`${baseUrl}m1-preview.json`)).json()) as M1Preview;

    expect(document.getElementById("m1-milestone")?.textContent).toBe(m1Json.milestone);

    const bodyText = document.getElementById("m1-preview-body")?.textContent ?? "";
    expect(bodyText).not.toContain("Loading world genesis data");
    expect(bodyText).toContain(m1Json.scenario.scenarioId);
    expect(bodyText).toContain(String(m1Json.scenario.seed));
    expect(bodyText).toContain(String(m1Json.worldTopology.regionCount));
    expect(bodyText).toContain(String(m1Json.worldTopology.currencyCount));
    for (const state of m1Json.states) {
      expect(bodyText).toContain(state.name);
    }
  });

  it("executes the real M2 render path and populates the DOM after the preview fetch resolves", async () => {
    const window = await renderPage();
    const document = window.document;
    const m2Json = (await (await fetch(`${baseUrl}m2-preview.json`)).json()) as M2Preview;

    expect(document.getElementById("m2-milestone")?.textContent).toBe(m2Json.milestone);

    const bodyText = document.getElementById("m2-preview-body")?.textContent ?? "";
    expect(bodyText).not.toContain("Loading tick orchestration data");
    expect(bodyText).toContain(m2Json.scenario.scenarioId);
    expect(bodyText).toContain(String(m2Json.tickExecution.ticksExecuted));
    expect(bodyText).toContain(
      `${m2Json.tickExecution.tickRange.firstTick} – ${m2Json.tickExecution.tickRange.lastTick}`
    );
    expect(bodyText).toContain(m2Json.phaseTrace.phaseSequence.join(", "));
  });

  it(
    "renders the required M1/M2 content visibly at a desktop viewport (1280px)",
    async () => {
      const page = await renderPageInBrowser({ viewportWidth: 1280 });
      try {
        expect(await page.locator("#m1-preview").isVisible()).toBe(true);
        expect(await page.locator("#m2-preview").isVisible()).toBe(true);
        expect(await isReadable(page.locator("#m1-preview-body"))).toBe(true);
        expect(await isReadable(page.locator("#m2-preview-body"))).toBe(true);

        expect(await page.locator("#m1-preview-body").textContent()).not.toContain(
          "Loading world genesis data"
        );
        expect(await page.locator("#m2-preview-body").textContent()).not.toContain(
          "Loading tick orchestration data"
        );
      } finally {
        await page.close();
      }
    },
    30_000
  );

  it(
    "renders the required M1/M2 content visibly at a narrow viewport (360px)",
    async () => {
      const page = await renderPageInBrowser({ viewportWidth: 360 });
      try {
        expect(await page.locator("#m1-preview").isVisible()).toBe(true);
        expect(await page.locator("#m2-preview").isVisible()).toBe(true);
        expect(await isReadable(page.locator("#m1-preview-body"))).toBe(true);
        expect(await isReadable(page.locator("#m2-preview-body"))).toBe(true);

        expect(await page.locator("#m1-preview-body").textContent()).not.toContain(
          "Loading world genesis data"
        );
        expect(await page.locator("#m2-preview-body").textContent()).not.toContain(
          "Loading tick orchestration data"
        );
      } finally {
        await page.close();
      }
    },
    30_000
  );

  it(
    "detects a visibility:hidden regression on the populated M1 preview body",
    async () => {
      const page = await renderPageInBrowser({
        viewportWidth: 1280,
        injectCss: "#m1-preview-body { visibility: hidden; }",
      });
      try {
        // DOM population and the JSON fetch still succeeded...
        expect(await page.locator("#m1-preview-body").textContent()).not.toContain(
          "Loading world genesis data"
        );
        // ...but the content a viewport smoke asserts on is genuinely not visible/readable,
        // which the `display !== "none"` check this replaces could never detect.
        expect(await page.locator("#m1-preview-body").isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    },
    30_000
  );

  it(
    "detects a zero-height clipping regression on the populated M2 preview body",
    async () => {
      const page = await renderPageInBrowser({
        viewportWidth: 1280,
        injectCss: "#m2-preview-body { overflow: hidden; max-height: 0px; display: block; }",
      });
      try {
        expect(await page.locator("#m2-preview-body").textContent()).not.toContain(
          "Loading tick orchestration data"
        );
        // A real layout engine reports a zero-area clipped element as not visible; the
        // jsdom-based check this replaces has no box geometry and cannot see this at all.
        expect(await page.locator("#m2-preview-body").isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    },
    30_000
  );

  it(
    "detects an opacity:0 regression on the populated M1 preview body",
    async () => {
      const page = await renderPageInBrowser({
        viewportWidth: 1280,
        injectCss: "#m1-preview-body { opacity: 0; }",
      });
      try {
        // DOM population and the JSON fetch still succeeded...
        expect(await page.locator("#m1-preview-body").textContent()).not.toContain(
          "Loading world genesis data"
        );
        // ...and Playwright's own `isVisible()` does not check opacity, so it stays true
        // even though the content is fully transparent and unreadable...
        expect(await page.locator("#m1-preview-body").isVisible()).toBe(true);
        // ...which is exactly the gap `isReadable` closes.
        expect(await isReadable(page.locator("#m1-preview-body"))).toBe(false);
      } finally {
        await page.close();
      }
    },
    30_000
  );

  it("detects a regression when the M1 DOM-population step is bypassed while the JSON artifact stays valid", async () => {
    const window = loadDom({ transformHtml: bypassM1Population });
    // The milestone tag write runs before the bypassed population write, so waiting on it
    // proves the fetch/.then() handler executed rather than merely timing out.
    await waitForText(window, "m1-milestone", (text) => text === "M1");

    const m1Json = (await (await fetch(`${baseUrl}m1-preview.json`)).json()) as M1Preview;
    expect(m1Json.requirement).toBe("REQ-VISUALIZATION-004");
    expect(readFileSync(path.join(docsDir, "index.html"), "utf8")).toContain("m1-preview.json");

    const bodyText = window.document.getElementById("m1-preview-body")?.textContent ?? "";
    expect(bodyText).toContain("Loading world genesis data");
    expect(bodyText).not.toContain(m1Json.scenario.scenarioId);
  });

  it("detects a regression when the M2 DOM-population step is bypassed while the JSON artifact stays valid", async () => {
    const window = loadDom({ transformHtml: bypassM2Population });
    await waitForText(window, "m2-milestone", (text) => text === "M2");

    const m2Json = (await (await fetch(`${baseUrl}m2-preview.json`)).json()) as M2Preview;
    expect(m2Json.requirement).toBe("REQ-VISUALIZATION-005");
    expect(readFileSync(path.join(docsDir, "index.html"), "utf8")).toContain("m2-preview.json");

    const bodyText = window.document.getElementById("m2-preview-body")?.textContent ?? "";
    expect(bodyText).toContain("Loading tick orchestration data");
    expect(bodyText).not.toContain(m2Json.scenario.scenarioId);
  });

  it("detects regression if M1 fetch URL is missing", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

    const m1Panel = html.includes('class="panel m1-preview"');
    const m1Fetch = html.includes("m1-preview.json");

    if (m1Panel) {
      expect(m1Fetch).toBe(true);
    }
  });

  it("detects regression if M2 fetch URL is missing", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");

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
});
