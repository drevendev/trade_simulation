import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { M4Preview } from "./m4Preview";

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

async function pageAt(query = "", width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${baseUrl}${query}`);
  await page.waitForFunction(() => !(document.getElementById("m4-preview-body")?.textContent ?? "").includes("Loading the M4 economy"));
  return page;
}

describe("REQ-VISUALIZATION-009: M4 Pages render", () => {
  it("makes the M4 one-region economy the first visible milestone without removing M3 history", async () => {
    const page = await pageAt();
    try {
      expect(await page.locator("#m4-preview").isVisible()).toBe(true);
      expect(await page.locator("#m4-preview-body").isVisible()).toBe(true);
      expect(await page.locator("#m3-preview").isVisible()).toBe(true);
      const m4BeforeM3 = await page.evaluate(() => {
        const m4 = document.getElementById("m4-preview")!;
        const m3 = document.getElementById("m3-preview")!;
        return (m4.compareDocumentPosition(m3) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(m4BeforeM3).toBe(true);
      expect(await page.locator("#earlier-milestones").evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
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
    expect(html).toContain("activity falls to zero");
  });
});
