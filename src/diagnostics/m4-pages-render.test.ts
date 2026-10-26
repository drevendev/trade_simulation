import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { M4Preview } from "./m4Preview";
import type { M3Preview } from "./m3Preview";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const docsDir = path.join(repoRoot, "docs");
const artifact = (): M4Preview => JSON.parse(readFileSync(path.join(docsDir, "m4-preview.json"), "utf8"));

let server: Server;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/m4-preview-empty.json") {
        const empty = { ...artifact(), samples: [] };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(empty));
        return;
      }
      if (url.pathname === "/m4-preview-malformed.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{not-json");
        return;
      }
      if (url.pathname === "/m4-preview-wrong.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ milestone: "M4", requirement: "REQ-VISUALIZATION-009", samples: [{ tick: 0 }] }));
        return;
      }
      if (url.pathname === "/m4-preview-missing-ticks.json") {
        const preview = artifact();
        const malformed = { ...preview, scenario: { ...preview.scenario, ticksExecuted: undefined } };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(malformed));
        return;
      }
      if (url.pathname === "/m4-preview-missing-food-name.json") {
        const preview = artifact();
        const malformed = { ...preview, region: { ...preview.region, foodGoodName: undefined } };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(malformed));
        return;
      }
      const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
      const filePath = path.join(docsDir, relative);
      if (!filePath.startsWith(docsDir) || !existsSync(filePath)) {
        res.writeHead(404); res.end(); return;
      }
      const type = filePath.endsWith(".json") ? "application/json"
        : filePath.endsWith(".js") ? "text/javascript"
          : filePath.endsWith(".css") ? "text/css"
            : filePath.endsWith(".csv") ? "text/csv" : "text/html";
      res.writeHead(200, { "Content-Type": type });
      createReadStream(filePath).pipe(res);
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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
});

async function pageAt(query = "", width = 1280, openChapter = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${baseUrl}${query}`);
  await page.waitForFunction(() => !(document.getElementById("m4-preview-body")?.textContent ?? "").includes("Loading the M4 economy"));
  if (openChapter) await page.locator("#chapter-m4 > summary").click();
  return page;
}

describe("REQ-VISUALIZATION-009: M4 Pages render", () => {
  it("starts with the real M4 sample timeline while M0–M4 and legacy stay folded", async () => {
    const page = await pageAt("", 1280, false);
    try {
      expect(await page.locator("#showcase-player").isVisible()).toBe(true);
      expect(await page.locator("#spotlight-tick").isEnabled()).toBe(true);
      expect(await page.locator("#m4-preview").isVisible()).toBe(false);
      expect(await page.locator("#m3-preview").isVisible()).toBe(false);
      for (const id of ["chapter-m0", "chapter-m1", "chapter-m2", "chapter-m3", "chapter-m4", "chapter-legacy"]) {
        expect(await page.locator(`#${id}`).evaluate(node => (node as HTMLDetailsElement).open), id).toBe(false);
      }
      await page.locator('[data-open-chapter="chapter-m4"]').click();
      expect(await page.locator("#m4-preview").isVisible()).toBe(true);
      expect(await page.locator("#m4-preview-body").isVisible()).toBe(true);
    } finally { await page.close(); }
  }, 60_000);

  it("scrubs real M4 samples and binds every metric and unit to the selected sample", async () => {
    const page = await pageAt("", 1280, false);
    try {
      const preview = artifact();
      const samples = preview.samples;
      const last = samples[samples.length - 1]!;
      const first = samples[0]!;
      expect(samples.length).toBeGreaterThan(1);

      const formatted = (value: number) => value.toLocaleString("en-US", {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
      const assertCards = async (sample: typeof first) => {
        const expected = [
          ["outputProduced", "Realized output", formatted(sample.outputProduced), `${preview.region.goodsUnitLabel} / tick`],
          ["employedWorkers", "Employment", formatted(sample.employedWorkers), preview.region.workerUnitLabel],
          ["essentialCoverage", "Essential-need coverage", `${(sample.essentialCoverage * 100).toFixed(1)}%`, "of target"],
          ["grossWagesPaid", "Gross wages paid", formatted(sample.grossWagesPaid), `${preview.region.currencyCode} / tick`],
          ["installedCapital", "Installed capital", formatted(sample.installedCapital), preview.region.capitalUnitLabel],
        ] as const;
        expect(await page.locator("#spotlight-metrics [data-spotlight]").count()).toBe(expected.length);
        for (const [field, label, value, unit] of expected) {
          const card = page.locator(`#spotlight-metrics [data-spotlight="${field}"]`);
          expect(await card.locator("dt").innerText(), field).toBe(label);
          expect(await card.locator("dd").innerText(), field).toContain(value);
          expect(await card.locator("dd small").innerText(), field).toBe(unit);
        }
      };

      expect(await page.locator("#spotlight-readout").innerText()).toContain(`tick ${last.tick}`);
      await assertCards(last);
      await page.locator("#spotlight-tick").evaluate(node => {
        const slider = node as HTMLInputElement;
        slider.value = "0";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(await page.locator("#spotlight-readout").innerText()).toContain(`tick ${first.tick}`);
      await assertCards(first);
      expect(await page.locator("#spotlight-tick").getAttribute("max")).toBe(String(samples.length - 1));
    } finally { await page.close(); }
  }, 60_000);

  it("switches all spotlight numbers and units between the validated M4 and M3 runs", async () => {
    const page = await pageAt("", 1280, false);
    try {
      const m3 = JSON.parse(readFileSync(path.join(docsDir, "m3-preview.json"), "utf8")) as M3Preview;
      await page.waitForFunction(() => !(document.getElementById("m3-preview-body")?.textContent ?? "").includes("Loading the M3 local market"));
      expect(await page.locator("#showcase-milestone").inputValue()).toBe("m4");
      await page.locator("#showcase-milestone").selectOption("m3");
      expect(await page.locator("#showcase-mode-tag").innerText()).toBe("M3 MARKET RUN");
      expect(await page.locator("#m4-run-summary").innerText()).toContain(m3.market.regionName);
      expect(await page.locator("#m4-run-summary").innerText()).toContain(m3.market.currencyCode);
      expect(await page.locator("#spotlight-tick").isEnabled()).toBe(true);
      expect(await page.locator("#spotlight-metrics [data-spotlight]").count()).toBe(6);
      expect(await page.locator('[data-spotlight="installedCapital"]').count()).toBe(0);

      const assertM3 = async (index: number) => {
        const tick = m3.ticks[index]!;
        expect(await page.locator("#spotlight-readout").innerText()).toContain(`tick ${tick.tick}`);
        const price = page.locator('[data-spotlight="sellerNetPrice"]');
        expect(await price.locator("dd").innerText()).toContain(tick.sellerNetPrice.toLocaleString("en-US", {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }));
        expect(await price.locator("dd small").innerText()).toBe(`${m3.market.currencyCode} / ${m3.market.quantityUnitLabel}`);
        const cleared = page.locator('[data-spotlight="clearedQuantity"]');
        expect(await cleared.locator("dd").innerText()).toContain(tick.clearedQuantity.toLocaleString("en-US", {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }));
        expect(await cleared.locator("dd small").innerText()).toBe(`${m3.market.quantityUnitLabel} / tick`);
      };
      await assertM3(m3.ticks.length - 1);
      await page.locator("#spotlight-tick").evaluate(node => {
        const input = node as HTMLInputElement;
        input.value = "0";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await assertM3(0);
      expect(await page.locator("#spotlight-tick").getAttribute("max")).toBe(String(m3.ticks.length - 1));

      await page.locator("#showcase-milestone").selectOption("m4");
      expect(await page.locator("#showcase-mode-tag").innerText()).toBe("M4 SAVED RUN");
      expect(await page.locator("#m4-run-summary").innerText()).toContain("Selected scenario:");
      expect(await page.locator("#spotlight-metrics [data-spotlight]").count()).toBe(5);
      expect(await page.locator('[data-spotlight="sellerNetPrice"]').count()).toBe(0);
      expect(await page.locator("#chapter-m3").evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
    } finally { await page.close(); }
  }, 60_000);

  it("does not leak M4 metrics into a malformed M3 selection and recovers independently", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/m3-preview.json", route => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ milestone: "M3", requirement: "REQ-VISUALIZATION-006", ticks: [{ tick: 1 }], market: {} }),
      }));
      await page.goto(baseUrl);
      await page.waitForFunction(() => !(document.getElementById("m4-preview-body")?.textContent ?? "").includes("Loading the M4 economy"));
      await page.locator("#showcase-milestone").selectOption("m3");
      await page.waitForFunction(() => !(document.getElementById("m3-preview-body")?.textContent ?? "").includes("Loading the M3 local market"));
      expect(await page.locator("#spotlight-tick").isDisabled()).toBe(true);
      expect(await page.locator("#spotlight-metrics").innerText()).toContain("No verified sampled values");
      expect(await page.locator('[data-spotlight="outputProduced"]').count()).toBe(0);
      await page.locator("#showcase-milestone").selectOption("m4");
      expect(await page.locator("#spotlight-tick").isEnabled()).toBe(true);
      expect(await page.locator('[data-spotlight="outputProduced"]').count()).toBe(1);
    } finally { await page.close(); }
  }, 60_000);

  it("fails closed in the showcase when the selected saved run is invalid", async () => {
    const page = await pageAt("?m4=m4-preview-wrong.json", 1280, false);
    try {
      expect(await page.locator("#spotlight-tick").isDisabled()).toBe(true);
      expect(await page.locator("#spotlight-readout").innerText()).toContain("could not be displayed");
      expect(await page.locator("#spotlight-metrics").innerText()).toContain("No verified sampled values");
      expect(await page.locator('[data-spotlight="outputProduced"]').count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);

  it("opens chapters from deep links without forcing all other chapters open", async () => {
    const page = await pageAt("#m1-preview", 1280, false);
    try {
      expect(await page.locator("#chapter-m1").evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
      expect(await page.locator("#chapter-m4").evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
      expect(await page.locator("#m1-preview").isVisible()).toBe(true);
    } finally { await page.close(); }
  }, 60_000);

  it("renders three explanatory groups covering output, employment/needs, and inventory/capital with unlike units split", async () => {
    const page = await pageAt();
    try {
      expect(await page.locator(".m4-visual-group").count()).toBe(3);
      expect(await page.locator(".m4-chart").count()).toBe(5);
      const text = await page.locator("#m4-preview-body").innerText();
      for (const token of ["Output produced", "Gross wages paid", "Household purchases", "Production", "Work and needs", "Stocks and capital"]) {
        expect(text).toContain(token);
      }
      const preview = artifact();
      expect(text).toContain(preview.region.currencyCode);
      expect(text).toContain(preview.region.workerUnitLabel);
      expect(text).toContain(preview.region.capitalUnitLabel);
      expect(await page.locator("#m4-table tbody tr").count()).toBe(preview.samples.length);
      for (const svg of await page.locator(".m4-chart").all()) {
        expect((await svg.getAttribute("aria-label"))?.length ?? 0).toBeGreaterThan(35);
      }
    } finally { await page.close(); }
  }, 60_000);

  it("keeps every sampled artifact value available verbatim alongside the readable rounded display", async () => {
    const page = await pageAt();
    try {
      const preview = artifact();
      const fields = ["outputProduced", "employedWorkers", "grossWagesPaid", "essentialCoverage", "foodInventory", "installedCapital"] as const;
      for (const field of fields) {
        const exactValues = page.locator(`.m4-exact[data-field="${field}"]`);
        expect(await exactValues.count()).toBe(preview.samples.length);
        for (const [index, sample] of preview.samples.entries()) {
          const prefix = field === "essentialCoverage" ? "exact ratio " : "exact ";
          expect(await exactValues.nth(index).innerText()).toBe(`${prefix}${String(sample[field])}`);
        }
      }

      const tickFive = preview.samples.find(sample => sample.tick === 5);
      expect(tickFive).toBeDefined();
      const highPrecisionOutput = String(tickFive!.outputProduced);
      expect(highPrecisionOutput.split(".")[1]?.length ?? 0).toBeGreaterThan(4);
      expect(await page.locator("#m4-table").innerText()).toContain(highPrecisionOutput);
    } finally { await page.close(); }
  }, 60_000);

  it.each([1280, 360])("is readable without whole-page horizontal overflow at %ipx", async width => {
    const page = await pageAt("", width);
    try {
      expect(await page.locator("#m4-preview").isVisible()).toBe(true);
      expect(await page.locator(".m4-visual-group").first().isVisible()).toBe(true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const heading = await page.locator("#m4-heading").boundingBox();
      expect(heading).not.toBeNull();
      expect(heading!.x + heading!.width).toBeLessThanOrEqual(width + 1);
    } finally { await page.close(); }
  }, 60_000);

  it("shows an explicit empty state rather than an empty chart shell", async () => {
    const page = await pageAt("?m4=m4-preview-empty.json");
    try {
      const text = await page.locator("#m4-preview-body").innerText();
      expect(text).toContain("M4 preview empty");
      expect(text).toContain("No values are invented");
      expect(await page.locator(".m4-chart").count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);

  it("distinguishes unavailable, malformed JSON, malformed shape, and partial-malformation states", async () => {
    for (const [query, expected] of [
      ["?m4=missing-preview.json", "M4 preview unavailable"],
      ["?m4=m4-preview-malformed.json", "M4 preview error"],
      ["?m4=m4-preview-wrong.json", "M4 preview error"],
      ["?m4=m4-preview-missing-ticks.json", "M4 preview error"],
      ["?m4=m4-preview-missing-food-name.json", "M4 preview error"],
    ] as const) {
      const page = await pageAt(query);
      try {
        const text = await page.locator("#m4-preview-body").innerText();
        expect(text).toContain(expected);
        expect(text).not.toContain("undefined");
        expect(await page.locator(".m4-chart").count()).toBe(0);
      } finally { await page.close(); }
    }
  }, 60_000);

  it("keeps plain-English causal and one-way-observation copy in the published page", () => {
    const html = readFileSync(path.join(docsDir, "index.html"), "utf8");
    for (const phrase of ["Phase&nbsp;2", "Phase&nbsp;3", "Phase&nbsp;5", "Phase&nbsp;8", "Phase&nbsp;9", "Phase&nbsp;12", "Phase&nbsp;15", "one-way observation", "does not control the simulation"]) {
      expect(html).toContain(phrase);
    }
    expect(html).not.toContain("activity falls to zero");
    expect(html).toContain("The run length and observed outcomes below come from the selected validated artifact");
    expect(html).toContain('id="m4-run-summary"');
  });
});
