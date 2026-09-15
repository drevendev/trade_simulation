/**
 * REQ-VISUALIZATION-006: render smoke for the consolidated M3 LocalMarket Pages experience.
 *
 * These tests execute the real `docs/index.html` — in jsdom for DOM behaviour and in a real
 * Chromium tab for layout — rather than inspecting the JSON artifact and trusting that the
 * page would have drawn it. A broken render callback has to fail here.
 *
 * The local static server below also serves synthetic artifacts from memory so the four
 * lifecycle states the acceptance criteria name (loading, empty, unavailable, error) can
 * each be reached with the page's own code path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { JSDOM, type DOMWindow } from "jsdom";
import { chromium, type Browser } from "playwright";
import type { M3Preview } from "./m3Preview";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const docsDir = path.join(repoRoot, "docs");

/** Synthetic artifacts served alongside the real docs/ tree, for the lifecycle states. */
const SYNTHETIC: Record<string, { body: string; contentType: string }> = {
  "/m3-preview-empty.json": {
    contentType: "application/json",
    body: JSON.stringify({
      milestone: "M3",
      requirement: "REQ-VISUALIZATION-006",
      scenario: { scenarioId: "empty-run", seed: 42, configVersion: "1.0.0", ticksExecuted: 0 },
      market: { marketId: "m:2", regionName: "Nowhere", goodName: "Food", quantityUnitLabel: "units", currencyCode: "ALP" },
      ticks: [],
      totals: {},
      settlementIdentity: {},
    }),
  },
  "/m3-preview-malformed.json": { contentType: "application/json", body: "{ this is not json" },
  "/m3-preview-wrong-shape.json": {
    contentType: "application/json",
    body: JSON.stringify({ milestone: "M9", requirement: "REQ-SOMETHING-ELSE" }),
  },
};

let server: Server;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const requestPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");

      const synthetic = SYNTHETIC[requestPath];
      if (synthetic !== undefined) {
        res.writeHead(200, { "Content-Type": synthetic.contentType });
        res.end(synthetic.body);
        return;
      }

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
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 3000;
      baseUrl = `http://127.0.0.1:${port}/`;
      resolve();
    });
    server.on("error", reject);
  });

  browser = await chromium.launch({ args: ["--no-sandbox"] });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    if (server) server.close((error) => (error ? reject(error) : resolve()));
    else resolve();
  });
});

const pageHtml = (): string => readFileSync(path.join(docsDir, "index.html"), "utf8");

const artifact = (): M3Preview =>
  JSON.parse(readFileSync(path.join(docsDir, "m3-preview.json"), "utf8")) as M3Preview;

/** Repoints the M3 fetch at one of the synthetic artifacts above. */
function fetchInstead(name: string): (html: string) => string {
  return (html) => {
    const marker = 'fetch("m3-preview.json")';
    if (!html.includes(marker)) {
      throw new Error("M3 fetch marker not found; index.html render script changed shape");
    }
    return html.replace(marker, `fetch("${name}")`);
  };
}

function loadDom(options: { transformHtml?: (html: string) => string } = {}): DOMWindow {
  const html = options.transformHtml ? options.transformHtml(pageHtml()) : pageHtml();
  const dom = new JSDOM(html, {
    url: baseUrl,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = ((input: string, init?: RequestInit) =>
        fetch(new URL(input, baseUrl).toString(), init)) as typeof window.fetch;
    },
  });
  return dom.window;
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for the expected condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Loads the page and waits until the M3 panel has left its loading state. */
async function renderM3(options: { transformHtml?: (html: string) => string } = {}): Promise<DOMWindow> {
  const window = loadDom(options);
  await waitFor(
    () =>
      !(window.document.getElementById("m3-preview-body")?.textContent ?? "").includes(
        "Loading the M3 local market",
      ),
  );
  return window;
}

async function renderM3InBrowser(viewportWidth: number): Promise<import("playwright").Page> {
  const page = await browser.newPage();
  await page.setViewportSize({ width: viewportWidth, height: 900 });
  await page.goto(baseUrl);
  await page.waitForFunction(
    () =>
      !(document.getElementById("m3-preview-body")?.textContent ?? "").includes(
        "Loading the M3 local market",
      ),
  );
  return page;
}

describe("REQ-VISUALIZATION-006: M3 Pages render smoke", () => {
  it("serves a standards-mode document with a declared language", () => {
    const html = pageHtml();
    // Without a leading doctype the browser falls back to quirks mode, where the box model
    // differs from standards mode and every layout assertion below means something else.
    expect(html.trimStart().slice(0, 15).toLowerCase()).toBe("<!doctype html>");
    expect(html).toContain('<html lang="en">');
  });

  it("makes the M3 experience the default view and demotes M0-M2 into a collapsed disclosure", async () => {
    const page = await renderM3InBrowser(1280);
    try {
      // Acceptance criterion 1: the visible default is the consolidated M3 experience, not
      // a stack of milestone status cards.
      expect(await page.locator("#m3-preview").isVisible()).toBe(true);
      expect(await page.locator("#m3-preview-body").isVisible()).toBe(true);

      const disclosure = page.locator("#earlier-milestones");
      expect(await disclosure.count()).toBe(1);
      expect(await disclosure.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
      expect(await page.locator("#m0-preview").isVisible()).toBe(false);
      expect(await page.locator("#m1-preview").isVisible()).toBe(false);
      expect(await page.locator("#m2-preview").isVisible()).toBe(false);

      // The M3 section precedes the disclosure in document order, so it is what a reader
      // meets first rather than merely being present somewhere on the page.
      const m3BeforeHistory = await page.evaluate(() => {
        const m3 = document.getElementById("m3-preview")!;
        const history = document.getElementById("earlier-milestones")!;
        return (m3.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(m3BeforeHistory).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("executes the real M3 render path and populates the DOM from the fetched artifact", async () => {
    const window = await renderM3();
    const document = window.document;
    const preview = artifact();
    const lastTick = preview.ticks[preview.ticks.length - 1]!;

    // Acceptance criterion 2: the trend and the balance visual are rendered, not stubbed.
    expect(document.querySelectorAll("#m3-charts svg").length).toBe(2);
    expect(document.querySelectorAll("#m3-charts polyline").length).toBeGreaterThanOrEqual(5);
    expect(document.querySelectorAll("#m3-balance .balance-row").length).toBeGreaterThanOrEqual(6);
    expect(document.querySelector("#m3-settlement .split")).not.toBeNull();

    const text = document.getElementById("m3-preview-body")!.textContent ?? "";
    expect(text).not.toContain("Loading the M3 local market");
    expect(text).toContain(preview.market.regionName);
    expect(text).toContain(preview.market.goodName);
    expect(text).toContain(preview.scenario.scenarioId);
    expect(document.getElementById("m3-tick-readout")!.textContent).toBe(`tick ${lastTick.tick}`);
  });

  it("shows every required headline metric with an unambiguous label and unit, matching the artifact", async () => {
    const window = await renderM3();
    const preview = artifact();
    const tick = preview.ticks[preview.ticks.length - 1]!;
    const money = preview.market.currencyCode;
    const units = preview.market.quantityUnitLabel;

    const metrics = new Map<string, string>();
    for (const metric of window.document.querySelectorAll("#m3-metrics .metric")) {
      metrics.set(
        metric.querySelector("dt")!.textContent!.trim(),
        metric.querySelector("dd")!.textContent!.trim(),
      );
    }

    const format = (value: number): string =>
      value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

    // Acceptance criterion 3, and the Handoff/11 M3 list of required headline metrics.
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["Seller-net price", `${format(tick.sellerNetPrice)}${money} per unit`],
      ["Buyer-gross price", `${format(tick.householdGrossPrice)}${money} per unit`],
      ["Cleared (traded) quantity", `${format(tick.clearedQuantity)}${units}`],
      ["Shortage rate", `${percent(tick.shortageRate)}of effective demand`],
      ["Surplus rate", `${percent(tick.surplusRate)}of offered quantity`],
      ["Seller-net receipt", `${format(tick.sellerNetReceipt)}${money}`],
      ["Buyer-gross cost", `${format(tick.buyerGrossCost)}${money}`],
      ["Consumption tax collected", `${format(tick.consumptionTaxCollected)}${money}`],
    ];
    for (const [label, value] of expected) {
      expect(metrics.get(label), label).toBe(value);
    }
    expect(metrics.size).toBe(expected.length);
  });

  it("binds every view to one selected tick and re-renders all of them when it changes", async () => {
    const window = await renderM3();
    const document = window.document;
    const preview = artifact();
    const slider = document.getElementById("m3-tick") as HTMLInputElement;

    // The selected-tick control must carry an accessible name; an unnamed range input tells
    // assistive technology nothing about what it controls.
    const label = document.querySelector('label[for="m3-tick"]');
    expect(label?.textContent).toBe("Selected tick");
    expect(slider.max).toBe(String(preview.ticks.length));

    const first = preview.ticks[0]!;
    slider.value = "1";
    slider.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(document.getElementById("m3-tick-readout")!.textContent).toBe(`tick ${first.tick}`);
    const shown = document.querySelector("#m3-metrics .metric dd")!.textContent ?? "";
    expect(shown).toContain(
      first.sellerNetPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
    // The exact-value table marks the same tick, so no panel is left describing another one.
    expect(document.querySelector('#m3-table tr[aria-current="true"] th')!.textContent).toBe(
      String(first.tick),
    );
  });

  it("exposes exact values as text for everything the charts encode visually", async () => {
    const window = await renderM3();
    const document = window.document;
    const preview = artifact();

    // Acceptance criterion 7: information encoded in chart geometry must also be reachable
    // as data, with the table describing itself.
    const table = document.querySelector("#m3-table table")!;
    expect(table.querySelector("caption")!.textContent).toContain(preview.market.currencyCode);
    expect(table.querySelector("caption")!.textContent).toContain(preview.market.quantityUnitLabel);
    expect(table.querySelectorAll("tbody tr").length).toBe(preview.ticks.length);
    // Every body row names its tick as a row header, so a screen reader crossing a row
    // knows which tick the numbers belong to.
    expect(table.querySelectorAll('tbody th[scope="row"]').length).toBe(preview.ticks.length);
    for (const header of table.querySelectorAll("thead th")) {
      expect(header.getAttribute("scope")).toBe("col");
    }
    const headers = [...table.querySelectorAll("thead th")].map((node) => node.textContent);
    expect(headers).toContain(`Seller-net price (${preview.market.currencyCode})`);
    expect(headers).toContain(`Cleared (${preview.market.quantityUnitLabel})`);

    // Each chart names itself, its series, its unit and its time basis.
    for (const svg of document.querySelectorAll("#m3-charts svg")) {
      expect(svg.getAttribute("role")).toBe("img");
      const name = svg.getAttribute("aria-label") ?? "";
      expect(name).toContain("over ticks");
      expect(name.length).toBeGreaterThan(40);
    }
    const chartNames = [...document.querySelectorAll("#m3-charts svg")].map((svg) =>
      svg.getAttribute("aria-label") ?? "",
    );
    expect(chartNames.some((name) => name.includes(preview.market.currencyCode))).toBe(true);
    expect(chartNames.some((name) => name.includes(preview.market.quantityUnitLabel))).toBe(true);
  });

  it("carries plain-English copy that names the mechanism rather than decorating it", () => {
    const html = pageHtml();
    // Acceptance criterion 4. The copy must state the two canonical phases and the
    // seller-net/buyer-gross distinction, because those are what the numbers mean.
    expect(html).toContain("Phase&nbsp;6");
    expect(html).toContain("Phase&nbsp;8");
    expect(html).toContain("seller-net");
    expect(html).toContain("buyer-gross");
    expect(html).toContain("consumption tax");
  });

  it("attributes the shortage signal to the current tick and memory only to inventory coverage", () => {
    // Acceptance criterion 4, pinned against the one causality this copy got wrong once.
    // Phase 6 aggregates D and S from *this* tick's intents
    // (phase6MarketPriceFormation.ts) and forms `excessRatio` from them
    // (marketPricing.ts); the only lagged input is `expectedUseEma`, consulted solely as
    // the denominator of inventory coverage. Presence checks cannot pin accuracy in
    // general, but they can stop this specific reversal from returning green.
    const lead = new JSDOM(pageHtml()).window.document.querySelector("main > p");
    expect(lead).not.toBeNull();
    const sentences = (lead!.textContent ?? "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => sentence.trim().length > 0);

    const namesExcessSignal = /\bdemand\b|\bsupply\b|shortage|excess/i;
    const laggedTick = /previous (tick|one)|prior tick|last tick|earlier tick|preceding tick|tick before/i;
    const memory = /remember|previous|prior|earlier|learned|history|past/i;
    const coverageSide = /coverage|expected use|inventory/i;

    const excessSentences = sentences.filter((sentence) => namesExcessSignal.test(sentence));
    expect(excessSentences.length).toBeGreaterThan(0);
    for (const sentence of excessSentences) {
      expect(sentence).not.toMatch(laggedTick);
    }

    const memorySentences = sentences.filter((sentence) => memory.test(sentence));
    expect(memorySentences.length).toBeGreaterThan(0);
    for (const sentence of memorySentences) {
      expect(sentence).toMatch(coverageSide);
    }
  });

  it("states the whole-run totals and the settlement identity the artifact measured", async () => {
    const window = await renderM3();
    const preview = artifact();
    const totals = window.document.getElementById("m3-totals")!.textContent ?? "";
    const format = (value: number): string =>
      value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    expect(totals).toContain(format(preview.totals.clearedQuantity));
    expect(totals).toContain(format(preview.totals.sellerNetReceipt));
    expect(totals).toContain(format(preview.totals.consumptionTaxCollected));
    expect(totals).toContain(format(preview.settlementIdentity.buyerGrossCost));
    expect(totals).toContain(preview.settlementIdentity.residual.toExponential(2));
  });

  it("renders the M3 experience readably at a desktop viewport (1280px)", async () => {
    const page = await renderM3InBrowser(1280);
    try {
      for (const selector of ["#m3-metrics", "#m3-charts", "#m3-balance", "#m3-settlement", "#m3-table"]) {
        expect(await page.locator(selector).isVisible(), selector).toBe(true);
        const box = await page.locator(selector).boundingBox();
        expect(box, selector).not.toBeNull();
        expect(box!.height, selector).toBeGreaterThan(0);
      }
      expect(await page.locator("#m3-charts svg").count()).toBe(2);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("renders the M3 experience readably at a narrow viewport (360px) with nothing overflowing", async () => {
    const page = await renderM3InBrowser(360);
    try {
      for (const selector of ["#m3-metrics", "#m3-charts", "#m3-balance", "#m3-settlement", "#m3-table"]) {
        expect(await page.locator(selector).isVisible(), selector).toBe(true);
        const box = await page.locator(selector).boundingBox();
        expect(box, selector).not.toBeNull();
        expect(box!.height, selector).toBeGreaterThan(0);
        // Acceptance criterion 5: no clipping or horizontal spill at a narrow layout. The
        // exact-value table is allowed to scroll inside its own container, which is why the
        // container rather than the table is measured.
        expect(box!.x + box!.width, selector).toBeLessThanOrEqual(361);
      }
      // The whole document must not scroll sideways either.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("shows an explicit empty state for a valid artifact with no ticks", async () => {
    const window = await renderM3({ transformHtml: fetchInstead("m3-preview-empty.json") });
    const text = window.document.getElementById("m3-preview-body")!.textContent ?? "";
    // Acceptance criterion 6: valid-but-empty is distinct from failed-to-load, and neither
    // is a permanent "Loading…".
    expect(text).toContain("No ticks in this M3 run");
    expect(text).toContain("empty run, not a failed load");
    expect(text).not.toContain("Loading the M3 local market");
    expect(window.document.querySelector("#m3-charts")).toBeNull();
  });

  it("shows an explicit unavailable state when the artifact is not served", async () => {
    const window = await renderM3({ transformHtml: fetchInstead("m3-preview-missing.json") });
    const text = window.document.getElementById("m3-preview-body")!.textContent ?? "";
    expect(text).toContain("M3 local market unavailable");
    expect(text).toContain("HTTP 404");
    expect(text).toContain("Nothing is shown rather than something stale");
  });

  it("shows an explicit error state when the artifact is served but unusable", async () => {
    const malformed = await renderM3({ transformHtml: fetchInstead("m3-preview-malformed.json") });
    const malformedText = malformed.document.getElementById("m3-preview-body")!.textContent ?? "";
    expect(malformedText).toContain("M3 local market could not be read");
    expect(malformedText).toContain("not valid JSON");

    // Valid JSON of the wrong shape is a distinct failure from unparseable bytes, and it
    // must not render a panel full of `undefined`.
    const wrongShape = await renderM3({ transformHtml: fetchInstead("m3-preview-wrong-shape.json") });
    const wrongShapeText = wrongShape.document.getElementById("m3-preview-body")!.textContent ?? "";
    expect(wrongShapeText).toContain("M3 local market could not be read");
    expect(wrongShapeText).toContain("not an M3 preview");
  });

  it("detects a regression when the M3 DOM-population step is bypassed while the artifact stays valid", async () => {
    // The negative control for every assertion above: if the render callback stops writing
    // to the panel, the page is stuck on its loading state and these tests must notice.
    const bypass = (html: string): string => {
      const marker = "  function render(preview) {";
      if (!html.includes(marker)) {
        throw new Error("M3 render marker not found; index.html render script changed shape");
      }
      return html.replace(marker, `${marker}\n    if (true) return;`);
    };
    const window = loadDom({ transformHtml: bypass });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(window.document.getElementById("m3-preview-body")!.textContent).toContain(
      "Loading the M3 local market",
    );
    expect(window.document.querySelector("#m3-charts")).toBeNull();
  });

  it("stays a server-independent static export: relative fetches only, no module imports", () => {
    const html = pageHtml();
    // Acceptance criterion 8. Every artifact the page reads is a relative sibling file, so
    // the page works from any static host without a server-side component.
    expect(html).toContain('fetch("m3-preview.json")');
    expect(html).not.toMatch(/fetch\(\s*["'`](https?:)?\/\//);
    expect(html).not.toMatch(/<script[^>]+type=["']module["']/);
    expect(html).not.toMatch(/<script[^>]+\ssrc=/);
  });

  it("publishes the M3 artifact as a real file in docs/", () => {
    expect(existsSync(path.join(docsDir, "m3-preview.json"))).toBe(true);
    const preview = artifact();
    expect(preview.requirement).toBe("REQ-VISUALIZATION-006");
    expect(preview.ticks.length).toBeGreaterThan(0);
  });
});

describe("REQ-VISUALIZATION-006: retained legacy run viewer", () => {
  it("names its selected-turn control and reports the real turn, not the row position", async () => {
    const window = loadDom();
    await waitFor(() => window.document.getElementById("scrub") !== null);
    const document = window.document;

    expect(document.querySelector('label[for="scrub"]')?.textContent).toBe("Selected turn");

    const scrub = document.getElementById("scrub") as HTMLInputElement;
    scrub.value = "1";
    scrub.dispatchEvent(new window.Event("input", { bubbles: true }));
    // docs/run.csv starts at turn 1, so position and turn agree here; the assertion that
    // matters is that the readout and the table caption are driven by the parsed `turn`
    // field rather than by the array index, which the caption below proves.
    expect(document.getElementById("readout")!.textContent).toContain("turn 1");
    expect(document.querySelector("#snapshot caption")!.textContent).toContain("turn 1");
  });

  it("gives the snapshot table a caption, column units and city row headers", async () => {
    const window = loadDom();
    await waitFor(() => window.document.querySelector("#snapshot table") !== null);
    const table = window.document.querySelector("#snapshot table")!;

    expect(table.querySelector("caption")).not.toBeNull();
    const headers = [...table.querySelectorAll("thead th")].map((node) => node.textContent);
    // Bare `food`/`wood`/`tools` headers never said whether the cells were prices,
    // quantities or satisfaction values, nor in what unit.
    expect(headers).toEqual([
      "City",
      "Food price (legacy money)",
      "Wood price (legacy money)",
      "Tools price (legacy money)",
      "Needs met",
    ]);
    expect(table.querySelectorAll('tbody th[scope="row"]').length).toBe(4);
  });

  it("exposes needs satisfaction as a readable number, not only as bar geometry", async () => {
    const window = loadDom();
    await waitFor(() => window.document.querySelector("#snapshot .needs") !== null);
    for (const cell of window.document.querySelectorAll("#snapshot .needs")) {
      expect(cell.textContent).toMatch(/^\d+%$/);
    }
  });
});
