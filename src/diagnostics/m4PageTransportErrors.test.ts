/** Classify real M4 Pages transport failures separately from malformed fetched artifacts (#818). */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../../docs/m4.js", import.meta.url), "utf8");
const published = readFileSync(new URL("../../docs/m4-preview.json", import.meta.url), "utf8");

interface ResponseStub {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

async function pageFor(fetchStub: () => Promise<ResponseStub>): Promise<JSDOM> {
  const page = new JSDOM(
    '<p id="m4-run-summary" role="status">Reading the selected deterministic artifact…</p>' +
    '<div id="m4-preview-body">Loading M4...</div>', {
    url: "https://pages.example.test/index.html",
    runScripts: "outside-only",
  });
  Object.defineProperty(page.window, "fetch", { value: fetchStub });
  page.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 0));
  return page;
}

function assertFailedWithoutPartialRender(page: JSDOM, title: string, detail: string): void {
  const doc = page.window.document;
  expect(doc.querySelector(".m4-state h3")?.textContent).toBe(title);
  const summary = doc.getElementById("m4-run-summary")?.textContent ?? "";
  expect(summary).toContain(title === "M4 preview unavailable"
    ? "Selected run unavailable." : "Selected run could not be displayed.");
  expect(summary).toContain("No validated observations");
  expect(summary).not.toContain("Reading");
  expect(summary).not.toContain("Selected scenario:");
  expect(doc.querySelector(".m4-state p")?.textContent).toContain(detail);
  expect(doc.querySelectorAll(".m4-chart")).toHaveLength(0);
  expect(doc.querySelector("table")).toBeNull();
}

describe("M4 Pages: transport failures are not malformed preview artifacts (#818)", () => {
  it("reports a rejected fetch as unavailable instead of claiming the artifact was fetched", async () => {
    const page = await pageFor(() => Promise.reject(new TypeError("Failed to fetch")));
    try {
      assertFailedWithoutPartialRender(page, "M4 preview unavailable", "Failed to fetch");
      expect(page.window.document.body.textContent).not.toContain("The artifact was fetched");
    } finally {
      page.window.close();
    }
  });

  it("reports a rejected response body as unavailable without inventing a preview", async () => {
    const page = await pageFor(async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("body stream interrupted")),
    }));
    try {
      assertFailedWithoutPartialRender(page, "M4 preview unavailable", "body stream interrupted");
    } finally {
      page.window.close();
    }
  });

  it("keeps HTTP 404 in the unavailable state", async () => {
    const page = await pageFor(async () => ({
      ok: false,
      status: 404,
      text: async () => "",
    }));
    try {
      assertFailedWithoutPartialRender(page, "M4 preview unavailable", "HTTP 404");
    } finally {
      page.window.close();
    }
  });

  it("keeps successfully fetched invalid JSON in the separate artifact error state", async () => {
    const page = await pageFor(async () => ({
      ok: true,
      status: 200,
      text: async () => "{not-json",
    }));
    try {
      assertFailedWithoutPartialRender(page, "M4 preview error", "not valid JSON");
    } finally {
      page.window.close();
    }
  });

  it("still renders the checked-in M4 artifact after successful retrieval", async () => {
    const page = await pageFor(async () => ({
      ok: true,
      status: 200,
      text: async () => published,
    }));
    try {
      expect(page.window.document.querySelector(".m4-state")).toBeNull();
      expect(page.window.document.getElementById("m4-run-summary")?.textContent).toContain(
        "Selected scenario: baseline-multistate-v1.",
      );
      expect(page.window.document.querySelectorAll(".m4-chart")).toHaveLength(5);
      expect(page.window.document.querySelector("#m4-table table")).not.toBeNull();
    } finally {
      page.window.close();
    }
  });
});
