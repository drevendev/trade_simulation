/** Real-browser-script regression for the published M4 elapsed-tick chart axis (#816). */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../../docs/m4.js", import.meta.url), "utf8");
const published = JSON.parse(
  readFileSync(new URL("../../docs/m4-preview.json", import.meta.url), "utf8"),
) as PreviewFixture;

interface PreviewFixture {
  readonly scenario: { ticksExecuted: number };
  samples: Array<{
    tick: number;
    outputProduced: number;
    grossWagesPaid: number;
    employedWorkers: number;
    essentialCoverage: number;
    foodInventory: number;
    installedCapital: number;
  }>;
  totals: {
    outputProduced: number;
    grossWagesPaid: number;
  };
}

async function pageFor(artifact: unknown, beforeEval?: (page: JSDOM) => void): Promise<JSDOM> {
  const page = new JSDOM('<div id="m4-preview-body">Loading M4...</div>', {
    url: "https://pages.example.test/index.html",
    runScripts: "outside-only",
  });
  Object.defineProperty(page.window, "fetch", {
    value: () => Promise.resolve({ ok: true, text: async () => JSON.stringify(artifact) }),
  });
  beforeEval?.(page);
  page.window.eval(script);
  // Flush the fetch -> response.text -> parse/render microtask chain.
  await new Promise(resolve => setTimeout(resolve, 0));
  return page;
}

function cloneFixture(): PreviewFixture {
  return JSON.parse(JSON.stringify(published)) as PreviewFixture;
}

describe("M4 Pages: elapsed tick axis and malformed artifact rejection (#816)", () => {
  it("plots the actual irregular 55-to-59 tail proportionally on every small multiple", async () => {
    const ticks = published.samples.map(sample => sample.tick);
    expect(ticks.at(-2)).toBe(55);
    expect(ticks.at(-1)).toBe(59);
    expect(new Set(ticks.slice(1).map((tick, index) => tick - ticks[index]!)).size).toBe(2);

    const page = await pageFor(published);
    try {
      const charts = [...page.window.document.querySelectorAll(".m4-chart polyline")];
      expect(charts.length).toBeGreaterThan(0);
      for (const line of charts) {
        const x = (line.getAttribute("points") ?? "").trim().split(/\s+/)
          .map(point => Number(point.split(",")[0]));
        expect(x).toHaveLength(ticks.length);
        // SVG width 320, left pad 48, right pad 10, elapsed-tick span 59.
        expect(x[0]).toBe(48);
        expect(x[1]).toBeCloseTo(48 + 262 * 5 / 59, 1);
        expect(x[11]).toBeCloseTo(48 + 262 * 55 / 59, 1);
        expect(x[12]).toBe(310);
        expect(x[12]! - x[11]!).toBeCloseTo(262 * 4 / 59, 1);
      }
      expect(page.window.document.querySelector(".m4-state")).toBeNull();
    } finally {
      page.window.close();
    }
  });

  it("retains a centered dot for a valid one-sample artifact", async () => {
    const fixture = cloneFixture();
    fixture.samples = fixture.samples.slice(0, 1);
    const page = await pageFor(fixture);
    try {
      const dots = page.window.document.querySelectorAll(".m4-chart circle");
      expect(dots.length).toBeGreaterThan(0);
      for (const dot of dots) expect(Number(dot.getAttribute("cx"))).toBe(179);
    } finally {
      page.window.close();
    }
  });

  it("rejects a run length above MAX_SAFE_INTEGER while keeping the exact boundary valid (#836)", async () => {
    const largestExact = cloneFixture();
    largestExact.scenario.ticksExecuted = Number.MAX_SAFE_INTEGER;
    const validPage = await pageFor(largestExact);
    try {
      expect(validPage.window.document.querySelectorAll(".m4-chart")).toHaveLength(5);
      expect(validPage.window.document.querySelector("#m4-table table")).not.toBeNull();
      expect(validPage.window.document.querySelector(".m4-state")).toBeNull();
    } finally {
      validPage.window.close();
    }

    // Number.isInteger(2 ** 53) is true, but adjacent run lengths are no longer
    // distinguishable. A provenance display must not claim that count as exact.
    const unsafe = cloneFixture();
    unsafe.scenario.ticksExecuted = Number.MAX_SAFE_INTEGER + 1;
    const rejectedPage = await pageFor(unsafe);
    try {
      const error = rejectedPage.window.document.querySelector(".m4-state")?.textContent ?? "";
      expect(error).toContain("M4 preview error");
      expect(error).toContain("scenario.ticksExecuted");
      expect(error).toContain("safe integer");
      expect(rejectedPage.window.document.querySelectorAll(".m4-chart")).toHaveLength(0);
      expect(rejectedPage.window.document.querySelector("table")).toBeNull();
    } finally {
      rejectedPage.window.close();
    }
  });

  it("renders finite SVG grid ticks for an accepted maximum-magnitude output (#838)", async () => {
    const fixture = cloneFixture();
    fixture.samples[0]!.outputProduced = Number.MAX_VALUE;
    // This chart stress fixture must also satisfy the whole-run flow bound:
    // a single observed tick cannot exceed the run's cumulative output.
    fixture.totals.outputProduced = Number.MAX_VALUE;
    const page = await pageFor(fixture);
    try {
      expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(5);
      expect(page.window.document.querySelector("#m4-table table")).not.toBeNull();
      expect(page.window.document.querySelector(".m4-state")).toBeNull();

      // The old "span * step / 3" overflows at steps 2 and 3, producing
      // y="-Infinity" despite valid finite artifact input. Exercise the
      // published script and real SVG, not a copied chart helper.
      const grid = [...page.window.document.querySelectorAll(".m4-chart line.grid")];
      expect(grid).toHaveLength(20);
      for (const line of grid) {
        for (const attribute of ["x1", "x2", "y1", "y2"]) {
          expect(Number.isFinite(Number(line.getAttribute(attribute))), attribute).toBe(true);
        }
        for (const attribute of ["y1", "y2"]) {
          const y = Number(line.getAttribute(attribute));
          expect(y).toBeGreaterThanOrEqual(10);
          expect(y).toBeLessThanOrEqual(136);
        }
      }
    } finally {
      page.window.close();
    }
  });

  it("bounds chart extrema work without passing a sample-sized argument list (#840)", async () => {
    const page = await pageFor(cloneFixture(), browser => {
      // Intercept Math in this isolated browser realm, not the test runner.
      // A function-argument-limit failure happens before chart creation when
      // Math.min/max receives the entire samples array through spread.
      browser.window.eval(`
        for (const method of ["min", "max"]) {
          const original = Math[method];
          Math[method] = (...args) => {
            if (args.length > 2) throw new RangeError("bulk extrema forbidden");
            return Reflect.apply(original, Math, args);
          };
        }
      `);
    });
    try {
      expect(page.window.document.querySelector(".m4-state")).toBeNull();
      expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(5);
      expect(page.window.document.querySelector("#m4-table table")).not.toBeNull();
      // A complete observed render is the sensitive assertion: the previous
      // Math.max(0, ...values) crashes under the instrumented argument cap.
    } finally {
      page.window.close();
    }
  });

  it("preserves a zero baseline and finite SVG coordinates for all-zero samples (#840)", async () => {
    const fixture = cloneFixture();
    for (const sample of fixture.samples) {
      sample.outputProduced = 0;
      sample.employedWorkers = 0;
      sample.essentialCoverage = 0;
      sample.foodInventory = 0;
      sample.installedCapital = 0;
    }
    const page = await pageFor(fixture);
    try {
      expect(page.window.document.querySelector(".m4-state")).toBeNull();
      const traces = [...page.window.document.querySelectorAll(".m4-chart polyline")];
      expect(traces).toHaveLength(5);
      for (const trace of traces) {
        const points = (trace.getAttribute("points") ?? "").trim().split(/\s+/);
        expect(points).toHaveLength(fixture.samples.length);
        for (const point of points) {
          const [x, y] = point.split(",").map(Number);
          expect(Number.isFinite(x)).toBe(true);
          expect(y).toBe(136);
        }
      }
      for (const line of page.window.document.querySelectorAll(".m4-chart line.grid")) {
        expect(Number.isFinite(Number(line.getAttribute("y1")))).toBe(true);
      }
    } finally {
      page.window.close();
    }
  });

  it("rejects impossible sampled output and payroll above whole-run totals (#842)", async () => {
    for (const field of ["outputProduced", "grossWagesPaid"] as const) {
      const fixture = cloneFixture();
      const observed = fixture.samples[0]![field];
      expect(observed, field).toBeGreaterThan(0);
      fixture.totals[field] = observed / 2;

      const page = await pageFor(fixture);
      try {
        const error = page.window.document.querySelector(".m4-state")?.textContent ?? "";
        expect(error, field).toContain("M4 preview error");
        expect(error, field).toContain(`sample 0.${field} exceeds totals.${field}`);
        expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(0);
        expect(page.window.document.querySelector("table")).toBeNull();
      } finally {
        page.window.close();
      }
    }
  });

  it("accepts positive sampled flows equal to their whole-run totals (#842)", async () => {
    const fixture = cloneFixture();
    fixture.samples = fixture.samples.slice(0, 1);
    fixture.totals.outputProduced = fixture.samples[0]!.outputProduced;
    fixture.totals.grossWagesPaid = fixture.samples[0]!.grossWagesPaid;
    expect(fixture.totals.outputProduced).toBeGreaterThan(0);
    expect(fixture.totals.grossWagesPaid).toBeGreaterThan(0);

    const page = await pageFor(fixture);
    try {
      expect(page.window.document.querySelector(".m4-state")).toBeNull();
      expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(5);
      expect(page.window.document.querySelector("#m4-table table")).not.toBeNull();
    } finally {
      page.window.close();
    }
  });

  it("fails closed on duplicate, reversed, fractional, negative or out-of-run ticks", async () => {
    const cases: Array<[string, (fixture: PreviewFixture) => void]> = [
      ["duplicate", fixture => { fixture.samples[4]!.tick = fixture.samples[3]!.tick; }],
      ["reversed", fixture => { fixture.samples[4]!.tick = fixture.samples[3]!.tick - 1; }],
      ["fractional", fixture => { fixture.samples[4]!.tick = 17.5; }],
      ["negative", fixture => { fixture.samples[0]!.tick = -1; }],
      ["after run", fixture => { fixture.samples[fixture.samples.length - 1]!.tick = fixture.scenario.ticksExecuted; }],
      ["unsafe integer", fixture => { fixture.samples[4]!.tick = Number.MAX_SAFE_INTEGER + 1; }],
    ];
    for (const [name, corrupt] of cases) {
      const fixture = cloneFixture();
      corrupt(fixture);
      const page = await pageFor(fixture);
      try {
        const text = page.window.document.querySelector(".m4-state")?.textContent ?? "";
        expect(text, name).toContain("M4 preview error");
        expect(text, name).toContain("tick");
        expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(0);
        expect(page.window.document.querySelector("table")).toBeNull();
      } finally {
        page.window.close();
      }
    }
  });
});
