/** #677: M5 Pages shell renders only source-backed tick facts; artifact publication follows separately. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { M5TradeTickPreview } from "./m5TradePreview";

const htmlSource = readFileSync(fileURLToPath(new URL("../../docs/m5.html", import.meta.url)), "utf8");

const shipment = {
  id: "sh:m5fx:example", good: "Iron", unit: "tonnes", quantity: 2,
  arrivalTick: 7, invoiceCurrency: "ALP", buyerCurrency: "BET",
  buyerGoodsPaymentAmount: 18, transportFeeAmount: 2,
  tariffAmount: 1, consumptionTaxAmount: 0.5, fxSettlementId: "fx:example",
};
const valid: M5TradeTickPreview = {
  milestone: "M5", tick: 7,
  routes: [{
    linkId: "tl:example", from: "Border", to: "Chokepoint",
    capacityWeightUnits: 10, status: "PAID_DISPATCH",
    departures: [shipment], arrivals: [shipment],
    inTransitCount: 0, dispatchedWeightUnits: 2,
  }],
  fxPools: [{
    authorityId: "ma:alpha", poolId: "pool:test", baseCurrency: "ALP",
    quoteCurrency: "BET", baseReserve: 60, quoteReserve: 40,
    baseSpendable: 50, quoteSpendable: 30,
    spotBefore: 2, spotAfter: 2.2, reserveFloorReached: false,
  }],
};

let response: string | null;
let server: Server;
let browser: Browser;
let url: string;

beforeAll(async () => {
  server = createServer((request, reply) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/" || path === "/m5.html") {
      reply.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      reply.end(htmlSource);
    } else if (path === "/m5-preview.json" && response !== null) {
      reply.writeHead(200, { "Content-Type": "application/json" });
      reply.end(response);
    } else {
      reply.writeHead(404);
      reply.end("Not found");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  url = "http://127.0.0.1:" + address.port + "/m5.html";
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});
beforeEach(() => {
  response = JSON.stringify(valid);
});

async function open(width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(url);
  await page.waitForFunction(() =>
    !(document.getElementById("status")?.textContent ?? "").includes("Loading"));
  return page;
}

describe("M5 Pages source-backed shell", () => {
  it("renders paid cargo, named-currency fees and FX reserves without horizontal overflow", async () => {
    const page = await open(1280);
    try {
      expect(await page.locator("#status").innerText()).toContain("tick 7");
      expect(await page.locator("#routes").innerText()).toContain("Border → Chokepoint");
      expect(await page.locator("#routes").innerText()).toContain("buyer paid 18 BET");
      expect(await page.locator("#routes").innerText()).toContain("tariff 1 BET");
      expect(await page.locator("#routes").innerText()).toContain("Arrivals (1)");
      expect(await page.locator("#fx").innerText()).toContain("2.2 BET/ALP");
      expect(await page.locator("#fx").innerText()).toContain("50 ALP");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("stacks cleanly on a narrow viewport and distinguishes blocked from unknown cause", async () => {
    const sample: M5TradeTickPreview = {
      ...valid,
      routes: [{
        ...valid.routes[0]!, capacityWeightUnits: 0,
        status: "NO_PHYSICAL_CAPACITY", departures: [], arrivals: [],
        dispatchedWeightUnits: 0,
      }, {
        ...valid.routes[0]!, linkId: "tl:unknown", from: "Other", to: "Another",
        status: "NO_PAID_DISPATCH", departures: [], arrivals: [],
        dispatchedWeightUnits: 0,
      }],
      fxPools: [{ ...valid.fxPools[0]!, reserveFloorReached: true }],
    };
    response = JSON.stringify(sample);
    const page = await open(360);
    try {
      expect(await page.locator("#routes").innerText()).toContain("Physical capacity is zero");
      expect(await page.locator("#routes").innerText()).toContain("cannot determine whether");
      expect(await page.locator("#fx").innerText()).toContain("operational floor");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("shows explicit no-data and empty states rather than fabricating cargo", async () => {
    response = null;
    const missing = await open(360);
    try {
      expect(await missing.locator("#status").innerText()).toContain("HTTP 404");
      expect(await missing.locator("#routes article").count()).toBe(0);
    } finally {
      await missing.close();
    }
    response = JSON.stringify({ ...valid, routes: [], fxPools: [] });
    const empty = await open(1280);
    try {
      expect(await empty.locator("#routes").innerText()).toContain("No directed routes");
      expect(await empty.locator("#fx").innerText()).toContain("No FX liquidity pools");
    } finally {
      await empty.close();
    }
  });

  it("rejects malformed economics and treats external labels as text", async () => {
    response = JSON.stringify({
      ...valid, routes: [{ ...valid.routes[0], dispatchedWeightUnits: -1 }],
    });
    const invalid = await open(1280);
    try {
      expect(await invalid.locator("#status").innerText()).toContain("must be finite");
      expect(await invalid.locator("#routes article").count()).toBe(0);
    } finally {
      await invalid.close();
    }
    response = JSON.stringify({
      ...valid, routes: [{ ...valid.routes[0], from: '<img src=x onerror="alert(1)">' }],
    });
    const xss = await open(1280);
    try {
      expect(await xss.locator("#routes").innerText()).toContain('<img src=x onerror="alert(1)">');
      expect(await xss.locator("#routes img").count()).toBe(0);
    } finally {
      await xss.close();
    }
  });
});
