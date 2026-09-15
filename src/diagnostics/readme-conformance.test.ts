import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const PAGES_URL = "https://drevendev.github.io/trade_simulation/";

/**
 * REQ-VISUALIZATION-007 closes on the README and its directly linked public documentation
 * describing the *current* evidence-backed state. Prose accuracy is not mechanically decidable,
 * but the defect class that has actually recurred here is: the README keeps a factual claim that
 * some other artifact in this repository has already contradicted.
 *
 * Issue #445 and Issue #496 were both instances of it — the README described milestone
 * ownership, Pages content and requirement status that the ledger and `docs/index.html` no longer
 * matched. Each check below pins one README claim to the artifact that decides it, so the next
 * such drift fails the build instead of standing on `master` until QA reads it.
 */
const readme = readFileSync(`${repoRoot}README.md`, "utf8").replace(/\r\n/g, "\n");
const pagesDocument = readFileSync(`${repoRoot}docs/index.html`, "utf8").replace(/\r\n/g, "\n");

interface LedgerRow {
  readonly reqId: string;
  readonly status: string;
}

/**
 * Reads a capture group that the enclosing pattern always produces. `noUncheckedIndexedAccess`
 * types every group as possibly undefined, and silently skipping a group would turn a regression
 * in one of these patterns into a vacuously passing check.
 */
function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`pattern matched without group ${index}: ${match[0]}`);
  }
  return value;
}

/**
 * Reads REQ_ID and STATUS out of the authoritative ledger. The EVIDENCE cell is quoted free text
 * containing commas and newlines, but REQ_ID and STATUS are the first two fields of every row and
 * neither is ever quoted, so a leading-field match is enough and avoids a CSV dependency.
 */
function readLedgerStatuses(): readonly LedgerRow[] {
  const csv = readFileSync(`${repoRoot}docs/spec/implementation_status.csv`, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const rows: LedgerRow[] = [];
  for (const line of csv.split("\n")) {
    const match = /^(REQ-[A-Z]+-\d+),([A-Z_]+),/.exec(line);
    if (match !== null) {
      rows.push({ reqId: group(match, 1), status: group(match, 2) });
    }
  }
  return rows;
}

const ledger = readLedgerStatuses();

function ledgerStatusOf(reqId: string): string | undefined {
  return ledger.find((row) => row.reqId === reqId)?.status;
}

/**
 * Splits the README into blank-line-separated blocks. A status claim and the requirement
 * identifier it is about sit in the same paragraph or the same list item continuation, so the
 * block is the unit that has to stay internally consistent.
 */
function readmeBlocks(): readonly string[] {
  return readme.split(/\n\s*\n/).filter((block) => block.trim() !== "");
}

/** Expands `REQ-MARKET-001..005` shorthand into the identifiers it names. */
function requirementIdsIn(text: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(REQ-[A-Z]+)-(\d+)(?:\.\.(\d+))?/g)) {
    const area = group(match, 1);
    const firstText = group(match, 2);
    const width = firstText.length;
    const first = Number.parseInt(firstText, 10);
    const lastText = match[3];
    const last = lastText === undefined ? first : Number.parseInt(lastText, 10);
    for (let n = first; n <= last; n += 1) {
      ids.add(`${area}-${String(n).padStart(width, "0")}`);
    }
  }
  return [...ids];
}

describe("README conformance (REQ-VISUALIZATION-007)", () => {
  it("resolves every relative link it offers the reader", () => {
    const broken: string[] = [];
    for (const match of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = group(match, 1);
      if (/^(https?:|mailto:|#)/.test(target)) {
        continue;
      }
      const path = decodeURIComponent(target.replace(/#.*$/, ""));
      if (path !== "" && !existsSync(`${repoRoot}${path}`)) {
        broken.push(target);
      }
    }
    expect(broken).toEqual([]);
  });

  it("names every requirement identifier that the ledger knows", () => {
    const unknown = requirementIdsIn(readme).filter((id) => ledgerStatusOf(id) === undefined);
    expect(unknown).toEqual([]);
  });

  it("never describes a requirement the ledger records IMPLEMENTED as outstanding", () => {
    const outstandingPhrases = [
      "not yet started",
      "not started",
      "is still open",
      "are still open",
      "not implemented",
      "in progress",
    ];
    const contradictions: string[] = [];
    for (const block of readmeBlocks()) {
      const lowered = block.toLowerCase();
      const phrase = outstandingPhrases.find((candidate) => lowered.includes(candidate));
      if (phrase === undefined) {
        continue;
      }
      for (const id of requirementIdsIn(block)) {
        if (ledgerStatusOf(id) === "IMPLEMENTED") {
          contradictions.push(`${id} is IMPLEMENTED but README says "${phrase}"`);
        }
      }
    }
    expect(contradictions).toEqual([]);
  });

  it("treats the CSV ledger as authoritative and the generated table as presentation", () => {
    const generatedCalledAuthoritative = readmeBlocks().filter(
      (block) =>
        block.includes("IMPLEMENTATION_STATUS.md") && block.toLowerCase().includes("authoritative"),
    );
    // Naming the generated Markdown authoritative is the defect; naming it in the same block as
    // the CSV is fine only when the CSV is the one carrying the word.
    for (const block of generatedCalledAuthoritative) {
      expect(block).toMatch(/implementation_status\.csv[^.]*authoritative/i);
    }
    expect(readme).toMatch(/implementation_status\.csv[^.]*authoritative/i);
  });

  it("describes the Pages deployment by the milestone that actually leads it", () => {
    // Blocks, not lines: the README is hard-wrapped, so the link and the claim it carries are
    // routinely on different lines of the same paragraph.
    const pagesBlocks = readmeBlocks().filter((block) => block.includes(PAGES_URL));
    expect(pagesBlocks.length).toBeGreaterThan(0);
    for (const block of pagesBlocks) {
      expect(block).toContain("M3");
    }
  });

  it("matches the default-versus-history split that docs/index.html actually renders", () => {
    const disclosure = /<details\b[\s\S]*?<\/details>/.exec(pagesDocument);
    if (disclosure === null) {
      throw new Error("docs/index.html has no <details> history disclosure");
    }
    const collapsed = group(disclosure, 0);
    const defaultView = pagesDocument.replace(collapsed, "");

    // README claims the M3 experience leads and M0-M2 plus the legacy viewer are collapsed.
    expect(defaultView).toContain('id="m3-preview-body"');
    expect(collapsed).toContain('id="m0-preview-body"');
    expect(collapsed).toContain('id="m1-preview-body"');
    expect(collapsed).toContain('id="m2-preview-body"');
    // The legacy C# run viewer mounts into #app; it is history, not the default view.
    expect(collapsed).toContain('id="app"');
    expect(defaultView).not.toContain('id="m0-preview-body"');
    expect(collapsed).not.toContain('id="m3-preview-body"');
  });

  it("documents only npm scripts this repository actually defines", () => {
    const packageJson = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const missing: string[] = [];
    for (const match of readme.matchAll(/npm run ([a-z:-]+)/g)) {
      const script = group(match, 1);
      if (!(script in scripts)) {
        missing.push(script);
      }
    }
    expect(missing).toEqual([]);
  });
});
