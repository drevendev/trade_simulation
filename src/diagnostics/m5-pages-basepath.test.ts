/** #677: exercise the checked-in M5 Pages bundle at GitHub Pages' repository subpath. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

const basePath = "/trade_simulation/";
const files = new Map([
  ["index.html", readFileSync(fileURLToPath(new URL("../../docs/index.html", import.meta.url)), "utf8")],
  ["m5.html", readFileSync(fileURLToPath(new URL("../../docs/m5.html", import.meta.url)), "utf8")],
  ["m5-preview.json", readFileSync(fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url)), "utf8")],
  ["m5-arrival.json", readFileSync(fileURLToPath(new URL("../../docs/m5-arrival.json", import.meta.url)), "utf8")],
]);
const requestedPaths: string[] = [];
let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = createServer((request, reply) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requestedPaths.push(pathname);
    // Intentionally serve NOTHING at the origin root: a root-absolute asset URL
    // may accidentally work in local tests but fail under /trade_simulation/.
    const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : "";
    const content = files.get(relative);
    if (content === undefined) {
      reply.writeHead(404);
      reply.end("Not found");
      return;
    }
    reply.writeHead(200, {
      "Content-Type": relative.endsWith(".json")
        ? "application/json; charset=utf-8"
        : "text/html; charset=utf-8",
    });
    reply.end(content);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local HTTP server port");
  origin = "http://127.0.0.1:" + address.port;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

describe("M5 GitHub Pages repository base path (#677)", () => {
  it.each([360, 1280])(
    "loads the checked-in dispatch and next-tick delivery at %ipx without a root fallback",
    async width => {
      requestedPaths.length = 0;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const response = await page.goto(origin + basePath + "m5.html");
        expect(response?.status()).toBe(200);
        await page.waitForFunction(() =>
          !(document.getElementById("status")?.textContent ?? "").includes("Loading") &&
          !(document.getElementById("arrival-status")?.textContent ?? "").includes("Loading"),
        );
        expect(await page.locator("#status").innerText()).toContain("tick 7");
        expect(await page.locator("#routes").innerText()).toContain(
          "Arrival is scheduled for tick 8",
        );
        expect(await page.locator("#arrival-status").innerText()).toContain(
          "Canonical tick 8 · 1 delivered shipment",
        );
        expect(await page.locator("#arrival-routes").innerText()).toContain(
          "Confirmed arrivals (1)",
        );
        expect(await page.locator("#fx").innerText()).toContain("BET/ALP");
        expect(await page.evaluate(() =>
          document.documentElement.scrollWidth <= window.innerWidth,
        )).toBe(true);

        expect(requestedPaths).toEqual(expect.arrayContaining([
          basePath + "m5.html",
          basePath + "m5-preview.json",
          basePath + "m5-arrival.json",
        ]));
        expect(requestedPaths).not.toContain("/m5-preview.json");
        expect(requestedPaths).not.toContain("/m5-arrival.json");

        // Deep-link and navigation must both stay inside the Pages project path.
        await page.getByRole("navigation", { name: "Milestone navigation" })
          .getByRole("link").click();
        expect(new URL(page.url()).pathname).toBe(basePath + "index.html");
        const link = page.getByRole("link", { name: /M5.*Trade.*FX preview/ });
        expect(await link.count()).toBe(1);
        await link.click();
        expect(new URL(page.url()).pathname).toBe(basePath + "m5.html");

        // Negative control: the local origin root never serves Pages artifacts.
        expect((await page.request.get(origin + "/m5-preview.json")).status()).toBe(404);
      } finally {
        await page.close();
      }
    },
  );
});
