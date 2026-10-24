/** M4 Pages must describe the selected artifact, not assume the default fixture (#820). */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../../docs/m4.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../docs/index.html", import.meta.url), "utf8");
const published = JSON.parse(
  readFileSync(new URL("../../docs/m4-preview.json", import.meta.url), "utf8"),
) as PreviewFixture;

interface PreviewFixture {
  scenario: { scenarioId: string; ticksExecuted: number };
  region: { goodsUnitLabel: string };
  samples: Array<{ tick: number; outputProduced: number }>;
}

function fixture(): PreviewFixture {
  return JSON.parse(JSON.stringify(published)) as PreviewFixture;
}

async function pageFor(artifact: unknown, url = "https://pages.example.test/index.html") {
  const page = new JSDOM(
    '<p id="m4-run-summary" role="status">Reading the selected deterministic artifact…</p>' +
    '<div id="m4-preview-body">Loading M4...</div>',
    { url, runScripts: "outside-only" },
  );
  const fetched: string[] = [];
  Object.defineProperty(page.window, "fetch", {
    value: (path: string) => {
      fetched.push(path);
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(artifact) });
    },
  });
  page.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { page, fetched };
}

describe("M4 Pages selected-run provenance (#820)", () => {
  it("replaces the unconditional fixed-fixture claim with a live text-only run summary", () => {
    expect(html).toContain('id="m4-run-summary"');
    expect(html).not.toMatch(/In this fixed\s+60-tick fixture/);
    expect(html).not.toContain("<strong>activity falls to zero</strong>");
  });

  it("truthfully describes the default published run without changing its charts", async () => {
    const { page, fetched } = await pageFor(published);
    try {
      expect(fetched).toEqual(["m4-preview.json"]);
      const summary = page.window.document.getElementById("m4-run-summary")?.textContent ?? "";
      expect(summary).toContain("Selected scenario: baseline-multistate-v1.");
      expect(summary).toContain("Run length: 60 ticks.");
      expect(summary).toContain("Samples span ticks 0–59;");
      expect(summary).toContain("last sampled output: 0 units/tick.");
      expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(5);
      expect(page.window.document.querySelector("#m4-table table")).not.toBeNull();
    } finally {
      page.window.close();
    }
  });

  it("uses the selected alternate run, not 60 ticks or assumed collapse; scenario markup stays inert", async () => {
    const alternate = fixture();
    alternate.scenario.scenarioId = '<img id="injected" src=x onerror="alert(1)">';
    alternate.scenario.ticksExecuted = 7;
    alternate.samples = alternate.samples.slice(0, 2);
    alternate.samples[1]!.tick = 6;
    alternate.samples[1]!.outputProduced = 23.5;

    const { page, fetched } = await pageFor(
      alternate, "https://pages.example.test/index.html?m4=alternate-run.json",
    );
    try {
      expect(fetched).toEqual(["alternate-run.json"]);
      const summary = page.window.document.getElementById("m4-run-summary")?.textContent ?? "";
      expect(summary).toContain(alternate.scenario.scenarioId);
      expect(summary).toContain("Run length: 7 ticks.");
      expect(summary).toContain("Samples span ticks 0–6;");
      expect(summary).toContain("last sampled output: 23.5 units/tick.");
      expect(summary).not.toContain("Run length: 60");
      expect(page.window.document.getElementById("injected")).toBeNull();
      expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(5);
    } finally {
      page.window.close();
    }
  });

  it("describes empty runs without fabricating an observed final output", async () => {
    const empty = fixture();
    empty.scenario.ticksExecuted = 0;
    empty.samples = [];
    const { page } = await pageFor(empty);
    try {
      const summary = page.window.document.getElementById("m4-run-summary")?.textContent ?? "";
      expect(summary).toContain("Run length: 0 ticks.");
      expect(summary).toContain("No sampled ticks or observed output values.");
      expect(summary).not.toContain("last sampled output:");
      expect(page.window.document.querySelector(".m4-state h3")?.textContent).toBe("M4 preview empty");
      expect(page.window.document.querySelector(".m4-chart")).toBeNull();
    } finally {
      page.window.close();
    }
  });

  it("does not announce a validated successful run for a rejected artifact", async () => {
    const broken = fixture();
    broken.region.goodsUnitLabel = "";
    const { page } = await pageFor(broken);
    try {
      const summary = page.window.document.getElementById("m4-run-summary")?.textContent ?? "";
      expect(summary).toContain("Selected run could not be displayed.");
      expect(summary).toContain("No validated observations are available.");
      expect(summary).not.toContain("Reading");
      expect(summary).not.toContain("Selected scenario:");
      expect(page.window.document.querySelector(".m4-state h3")?.textContent).toBe("M4 preview error");
      expect(page.window.document.querySelector(".m4-chart")).toBeNull();
    } finally {
      page.window.close();
    }
  });
  it.each([
    ["empty selection", "?m4="],
    ["path traversal", "?m4=..%2Fother.json"],
    ["unsupported filename", "?m4=other_run.json"],
    ["ambiguous repeated selection", "?m4=m4-preview.json&m4=alternate-run.json"],
    ["markup in selection", "?m4=%3Cimg%20id%3Dinjected%3E.json"],
  ])("fails closed for %s rather than silently rendering the default run", async (_case, query) => {
    const { page, fetched } = await pageFor(
      published, `https://pages.example.test/index.html${query}`,
    );
    try {
      // An invalid selector must not be silently rewritten to m4-preview.json.
      expect(fetched).toEqual([]);
      const document = page.window.document;
      const summary = document.getElementById("m4-run-summary")?.textContent ?? "";
      expect(summary).toContain("Selected run could not be displayed.");
      expect(summary).toContain("No validated observations are available.");
      expect(summary).not.toContain("Reading");
      expect(summary).not.toContain("Selected scenario:");
      expect(document.querySelector(".m4-state h3")?.textContent).toBe("M4 preview error");
      const visibleError = document.querySelector(".m4-state p")?.textContent ?? "";
      expect(visibleError).toContain("invalid M4 preview selection");
      expect(visibleError).toContain("no artifact was fetched");
      expect(visibleError).not.toContain("The artifact was fetched");
      expect(document.querySelectorAll(".m4-chart")).toHaveLength(0);
      expect(document.querySelector("#m4-table table")).toBeNull();
      expect(document.getElementById("injected")).toBeNull();
    } finally {
      page.window.close();
    }
  });

});
