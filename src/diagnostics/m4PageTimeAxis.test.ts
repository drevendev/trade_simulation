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
  samples: Array<{ tick: number }>;
}

async function pageFor(artifact: unknown): Promise<JSDOM> {
  const page = new JSDOM('<div id="m4-preview-body">Loading M4...</div>', {
    url: "https://pages.example.test/index.html",
    runScripts: "outside-only",
  });
  Object.defineProperty(page.window, "fetch", {
    value: () => Promise.resolve({ ok: true, text: async () => JSON.stringify(artifact) }),
  });
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
