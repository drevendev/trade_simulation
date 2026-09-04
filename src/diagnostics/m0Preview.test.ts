import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolchainStatus } from "../index";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

interface M0Preview {
  readonly milestone: string;
  readonly legacyBaseline: {
    readonly seed: number;
    readonly turns: number;
    readonly hash: string;
  };
  readonly canonicalScaffolding: {
    readonly present: boolean;
    readonly hasEconomics: boolean;
  };
}

function readM0Preview(): M0Preview {
  return JSON.parse(readFileSync(`${repoRoot}docs/m0-preview.json`, "utf8")) as M0Preview;
}

/**
 * Parses the Seed/Turns/expected-hash values out of LEGACY_BASELINE.md's markdown.
 * Normalizes CRLF to LF first: a Windows checkout of this repo checks the file out
 * with CRLF line endings, which an LF-only fence regex would silently fail to match.
 */
function parseDocumentedLegacyBaseline(rawText: string): { seed: number; turns: number; hash: string } {
  const text = rawText.replace(/\r\n/g, "\n");

  const seedMatch = /\| Seed \| `(\d+)` \|/.exec(text);
  const turnsMatch = /\| Turns \| `(\d+)` \|/.exec(text);
  const hashMatch = /```\n([0-9A-F]+)\n```/.exec(text);

  const seed = seedMatch?.[1];
  const turns = turnsMatch?.[1];
  const hash = hashMatch?.[1];
  if (seed === undefined || turns === undefined || hash === undefined) {
    throw new Error("Could not locate Seed/Turns/expected-hash in docs/spec/LEGACY_BASELINE.md");
  }

  return { seed: Number(seed), turns: Number(turns), hash };
}

function readDocumentedLegacyBaseline(): { seed: number; turns: number; hash: string } {
  return parseDocumentedLegacyBaseline(readFileSync(`${repoRoot}docs/spec/LEGACY_BASELINE.md`, "utf8"));
}

describe("M0 Milestone Preview diagnostic artifact (REQ-VISUALIZATION-003)", () => {
  it("declares the M0 milestone", () => {
    expect(readM0Preview().milestone).toBe("M0");
  });

  it("matches the documented, frozen legacy baseline seed/turns/hash exactly", () => {
    const preview = readM0Preview();
    const documented = readDocumentedLegacyBaseline();

    expect(preview.legacyBaseline.seed).toBe(documented.seed);
    expect(preview.legacyBaseline.turns).toBe(documented.turns);
    expect(preview.legacyBaseline.hash).toBe(documented.hash);
  });

  it("matches the real canonical scaffolding status rather than an asserted claim", () => {
    const preview = readM0Preview();
    const status = toolchainStatus();

    expect(preview.canonicalScaffolding.present).toBe(status.canonicalScaffolding);
    // M0 must not claim canonical economics exist; that arrives from M1 onward.
    expect(preview.canonicalScaffolding.hasEconomics).toBe(false);
  });

  it("parses identically regardless of the checkout's line endings (LF vs CRLF)", () => {
    const lfFixture = ["| Seed | `7` |", "| Turns | `30` |", "", "```", "ABCDEF0123456789", "```", ""].join("\n");
    const crlfFixture = lfFixture.replace(/\n/g, "\r\n");

    const expected = { seed: 7, turns: 30, hash: "ABCDEF0123456789" };
    expect(parseDocumentedLegacyBaseline(lfFixture)).toEqual(expected);
    expect(parseDocumentedLegacyBaseline(crlfFixture)).toEqual(expected);
  });
});

describe("docs/index.html M0 preview panel wiring", () => {
  it("fetches the static one-way diagnostic artifact and never fetches simulation RNG/state", () => {
    const html = readFileSync(`${repoRoot}docs/index.html`, "utf8");

    expect(html).toContain("m0-preview.json");
    // The preview must stay a read-only consumer: it must not import or reference a
    // canonical runtime module path that could let it mutate state. (The page's
    // pre-existing <title> legitimately names the legacy project in prose, so this
    // checks for a path-shaped reference rather than the bare project name — which
    // would also trip the unrelated REQ-MIGRATION-004 isolation-boundary guard.)
    expect(html).not.toContain("src/simulation");
  });
});
