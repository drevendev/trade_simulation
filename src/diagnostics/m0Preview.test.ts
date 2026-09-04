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

/** Extracts the Seed/Turns/expected-hash values documented in LEGACY_BASELINE.md. */
function readDocumentedLegacyBaseline(): { seed: number; turns: number; hash: string } {
  const text = readFileSync(`${repoRoot}docs/spec/LEGACY_BASELINE.md`, "utf8");

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
