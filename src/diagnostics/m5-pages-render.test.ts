/** #677: M5 Pages shell renders only source-backed tick facts; artifact publication follows separately. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { M5TradeTickPreview } from "./m5TradePreview";

const document = readFileSync(fileURLToPath(new URL("../../docs/m5.html", import.meta.url)), "utf8");

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
      reply.end(document);
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
  browser = await chromium.launch({ headless: true });
});
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
  await expect.poll(async () => page.locator("#status").innerText())
    .not.toContain("Loading");
  return page;
}

describe("M5 Pages source-backed shell", () => {
  it("renders paid cargo, named-currency fees and FX reserves without horizontal overflow", async () => {
    const page = await open(1280);
    try {
      await expect(page.locator("#status")).toContainText("tick 7");
      await expect(page.locator("#routes")).toContainText("Border → Chokepoint");
      await expect(page.locator("#routes")).toContainText("buyer paid 18 BET");
      await expect(page.locator("#routes")).toContainText("tariff 1 BET");
      await expect(page.locator("#routes")).toContainText("Arrivals (1)");
      await expect(page.locator("#fx")).toContainText("2.2 BET/ALP");
      await expect(page.locator("#fx")).toContainText("50 ALP");
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
      await expect(page.locator("#routes")).toContainText("Physical capacity is zero");
      await expect(page.locator("#routes")).toContainText("cannot determine whether");
      await expect(page.locator("#fx")).toContainText("operational floor");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("shows explicit no-data and empty states rather than fabricating cargo", async () => {
    response = null;
    const missing = await open(360);
    try {
      await expect(missing.locator("#status")).toContainText("HTTP 404");
      await expect(missing.locator("#routes article")).toHaveCount(0);
    } finally {
      await missing.close();
    }
    response = JSON.stringify({ ...valid, routes: [], fxPools: [] });
    const empty = await open(1280);
    try {
      await expect(empty.locator("#routes")).toContainText("No directed routes");
      await expect(empty.locator("#fx")).toContainText("No FX liquidity pools");
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
      await expect(invalid.locator("#status")).toContainText("must be finite");
      await expect(invalid.locator("#routes article")).toHaveCount(0);
    } finally {
      await invalid.close();
    }
    response = JSON.stringify({
      ...valid, routes: [{ ...valid.routes[0], from: '<img src=x onerror="alert(1)">' }],
    });
    const xss = await open(1280);
    try {
      await expect(xss.locator("#routes")).toContainText('<img src=x onerror="alert(1)">');
      await expect(xss.locator("#routes img")).toHaveCount(0);
    } finally {
      await xss.close();
    }
  });
});
