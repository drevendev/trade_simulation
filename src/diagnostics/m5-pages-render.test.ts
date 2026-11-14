/** #677: M5 Pages shell renders only source-backed tick facts; artifact publication follows separately. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { M5TradeTickPreview } from "./m5TradePreview";

const htmlSource = readFileSync(fileURLToPath(new URL("../../docs/m5.html", import.meta.url)), "utf8");
const dashboardSource = readFileSync(fileURLToPath(new URL("../../docs/index.html", import.meta.url)), "utf8");
const publishedM5Source = readFileSync(fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url)), "utf8");

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
    if (path === "/" || path === "/index.html") {
      reply.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      reply.end(dashboardSource);
    } else if (path === "/m5.html") {
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
  it("links the existing milestone dashboard to M5 and back, with no invented data", async () => {
    response = null;
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    try {
      await page.goto(new URL("/", url).href);
      const link = page.getByRole("link", { name: /M5.*Trade.*FX preview/ });
      expect(await link.count()).toBe(1);
      await link.click();
      expect(new URL(page.url()).pathname).toBe("/m5.html");
      await page.waitForFunction(() =>
        !(document.getElementById("status")?.textContent ?? "").includes("Loading"));
      expect(await page.locator("#status").innerText()).toContain("HTTP 404");
      await page.getByRole("navigation", { name: "Milestone navigation" })
        .getByRole("link").click();
      expect(new URL(page.url()).pathname).toBe("/index.html");
    } finally {
      await page.close();
    }
  });

  it.each([1280, 360])(
    "renders the exact checked-in canonical M5 receipt at %ipx without overflow",
    async width => {
      response = publishedM5Source;
      const committed = JSON.parse(publishedM5Source) as M5TradeTickPreview;
      const paidRoute = committed.routes.find(route => route.departures.length > 0);
      const paidCargo = paidRoute?.departures[0];
      const pool = committed.fxPools[0];
      expect(paidRoute).toBeDefined();
      expect(paidCargo?.fxSettlementId).not.toBeNull();
      expect(pool).toBeDefined();
      const page = await open(width);
      try {
        expect(await page.locator("#status").innerText()).toContain("tick " + committed.tick);
        expect(await page.locator("#routes").innerText()).toContain(
          paidRoute!.from + " → " + paidRoute!.to,
        );
        expect(await page.locator("#routes").innerText()).toContain(
          "buyer paid " + paidCargo!.buyerGoodsPaymentAmount + " " + paidCargo!.buyerCurrency,
        );
        expect(await page.locator("#routes").innerText()).toContain(
          "Arrival is scheduled for tick " + paidCargo!.arrivalTick,
        );
        expect(await page.locator("#routes").innerText()).toContain(
          "A later delivery receipt is required before arrival can be called confirmed.",
        );
        expect(await page.locator("#routes").innerText()).toContain("Capacity used");
        expect(await page.locator("#fx").innerText()).toContain(
          pool!.spotAfter + " " + pool!.quoteCurrency + "/" + pool!.baseCurrency,
        );
        expect(await page.evaluate(() =>
          document.documentElement.scrollWidth <= window.innerWidth,
        )).toBe(true);
      } finally {
        await page.close();
      }
    },
  );

  it("renders paid cargo, named-currency fees and FX reserves without horizontal overflow", async () => {
    const page = await open(1280);
    try {
      expect(await page.locator("#status").innerText()).toContain("tick 7");
      expect(await page.locator("#routes").innerText()).toContain("Border → Chokepoint");
      expect(await page.locator("#routes").innerText()).toContain("buyer paid 18 BET");
      expect(await page.locator("#routes").innerText()).toContain("tariff 1 BET");
      expect(await page.locator("#routes").innerText()).toContain("Arrivals (1)");
      expect(await page.locator("#routes").innerText()).toContain("Capacity used");
      expect(await page.locator("#routes").innerText()).toContain("20.0%");
      expect(await page.locator("#routes").innerText()).toContain(
        "The same cargo also has a confirmed delivery receipt in tick 7.",
      );
      expect(await page.locator("#routes").innerText()).toContain(
        "it is not evidence of a second sale or FX conversion.",
      );
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

  it("fails closed on impossible capacity use and zero-quantity paid cargo", async () => {
    response = JSON.stringify({ ...valid, routes: [{
      ...valid.routes[0], dispatchedWeightUnits: 11,
    }] });
    const overCapacity = await open(360);
    try {
      expect(await overCapacity.locator("#status").innerText()).toContain(
        "cargo exceeds actual physical capacity",
      );
      expect(await overCapacity.locator("#routes article").count()).toBe(0);
    } finally {
      await overCapacity.close();
    }

    response = JSON.stringify({ ...valid, routes: [{
      ...valid.routes[0], departures: [{ ...shipment, quantity: 0 }],
    }] });
    const zeroCargo = await open(1280);
    try {
      expect(await zeroCargo.locator("#status").innerText()).toContain(
        "quantity must be positive",
      );
      expect(await zeroCargo.locator("#routes article").count()).toBe(0);
    } finally {
      await zeroCargo.close();
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
