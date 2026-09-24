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
  readonly mergeCommit: string;
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
 * Reads a CSV file into one record per row, keyed by its header. Both files read here quote free
 * text that contains commas and newlines — the ledger's EVIDENCE cell and the registry's STATEMENT
 * and ACCEPTANCE cells — so field position alone cannot be recovered by splitting on a delimiter.
 */
function readCsvRecords(path: string): readonly Readonly<Record<string, string>>[] {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text.charAt(i);
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (header === undefined) {
    throw new Error(`${path} is empty`);
  }
  return rows
    .filter((fields) => fields.some((value) => value.trim() !== ""))
    .map((fields) => Object.fromEntries(header.map((name, index) => [name, fields[index] ?? ""])));
}

/** Reads the fields of the authoritative ledger that decide whether work has actually landed. */
function readLedgerStatuses(): readonly LedgerRow[] {
  return readCsvRecords(`${repoRoot}docs/spec/implementation_status.csv`)
    .filter((record) => /^REQ-[A-Z]+-\d+$/.test(record["REQ_ID"] ?? ""))
    .map((record) => ({
      reqId: record["REQ_ID"] ?? "",
      status: (record["STATUS"] ?? "").trim(),
      mergeCommit: (record["MERGE_COMMIT"] ?? "").trim(),
    }));
}

const ledger = readLedgerStatuses();

function ledgerStatusOf(reqId: string): string | undefined {
  return ledger.find((row) => row.reqId === reqId)?.status;
}

/**
 * Milestones every one of whose requirements the ledger records IMPLEMENTED. Membership is the
 * mirrored registry's MILESTONE column; a blank MILESTONE marks a cross-cutting requirement and
 * gates nothing, and a milestone with no registry rows at all is not landed — it is unindexed,
 * and an empty membership would otherwise make every future milestone vacuously landed.
 *
 * Deliberately *not* the tagger's definition. `scripts/release_tag.py` releases a milestone only
 * once every row also carries its merge commit, and this check used to require the same. But a
 * row lands inside the pull request that earns it with `MERGE_COMMIT` blank, and the machine
 * fills that cell afterwards from a branch that may write the two ledger files and nothing else
 * (`docs/zendev/MACHINE_PULL_REQUESTS.md`). So the first revision on which a milestone counted
 * as closed was always the machine's provenance proposal — the one revision that cannot edit
 * README — and the last row of every milestone left that proposal red (#660, Issue #680).
 * STATUS is the judgement; the commit is bookkeeping that follows within minutes. Counting a
 * milestone landed on STATUS alone makes this rule fire on the author's own merge ref, where
 * README can change in the same pull request.
 */
function landedMilestonesOf(
  registry: readonly Readonly<Record<string, string>>[],
  rows: readonly LedgerRow[],
): ReadonlySet<string> {
  const members = new Map<string, string[]>();
  for (const record of registry) {
    const milestone = (record["MILESTONE"] ?? "").trim();
    if (!/^M\d+$/.test(milestone)) {
      continue;
    }
    const reqIds = members.get(milestone) ?? [];
    reqIds.push((record["REQ_ID"] ?? "").trim());
    members.set(milestone, reqIds);
  }
  const landed = new Set<string>();
  for (const [milestone, reqIds] of members) {
    const every = reqIds.every((reqId) => {
      const row = rows.find((candidate) => candidate.reqId === reqId);
      return row !== undefined && row.status === "IMPLEMENTED";
    });
    if (every) {
      landed.add(milestone);
    }
  }
  return landed;
}

function landedMilestones(): ReadonlySet<string> {
  return landedMilestonesOf(
    readCsvRecords(`${repoRoot}docs/spec/mirror/REQUIREMENTS_REGISTRY.csv`),
    ledger,
  );
}

/**
 * Splits the README into blank-line-separated blocks. A status claim and the requirement
 * identifier it is about sit in the same paragraph or the same list item continuation, so the
 * block is the unit that has to stay internally consistent.
 */
function blocksOf(text: string): readonly string[] {
  return text.split(/\n\s*\n/).filter((block) => block.trim() !== "");
}

function readmeBlocks(): readonly string[] {
  return blocksOf(readme);
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

/**
 * Expands the milestone references a README block can carry: `M3`, the `Milestone 3` long form,
 * and ranges such as `M4–M8` or `M0-M2`, which name every milestone between their endpoints.
 */
function milestoneIdsIn(text: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\bM(\d+)\s*[-–—]\s*M(\d+)\b/g)) {
    const first = Number.parseInt(group(match, 1), 10);
    const last = Number.parseInt(group(match, 2), 10);
    for (let n = first; n <= last; n += 1) {
      ids.add(`M${String(n)}`);
    }
  }
  for (const match of text.matchAll(/\bM(\d+)\b/g)) {
    ids.add(`M${String(Number.parseInt(group(match, 1), 10))}`);
  }
  for (const match of text.matchAll(/\bMilestones?\s+(\d+)\b/gi)) {
    ids.add(`M${String(Number.parseInt(group(match, 1), 10))}`);
  }
  return [...ids];
}

/**
 * Phrases that call a milestone still open. Release phrases ("not released") are not among
 * them: whether a milestone is released is decided by the tag `release-tag.yml` cuts after the
 * provenance lands, which no file this check reads records, and a landed milestone is
 * truthfully unreleased for the minutes in between.
 */
const MILESTONE_OPEN_PHRASES = [
  "not closed",
  "not yet closed",
  "has not closed",
  "have not closed",
  "remains open",
  "remain open",
  "still open",
  "not implemented",
  "not yet implemented",
];

/** Every block that names a landed milestone while calling it open. Pure. */
function milestoneContradictions(
  blocks: readonly string[],
  landed: ReadonlySet<string>,
): readonly string[] {
  const contradictions: string[] = [];
  for (const block of blocks) {
    const lowered = block.toLowerCase();
    const phrase = MILESTONE_OPEN_PHRASES.find((candidate) => lowered.includes(candidate));
    if (phrase === undefined) {
      continue;
    }
    for (const id of milestoneIdsIn(block)) {
      if (landed.has(id)) {
        contradictions.push(
          `${id} has landed in full (every registry requirement IMPLEMENTED) but README says ` +
            `"${phrase}"; the pull request that lands a milestone's last row also updates README`,
        );
      }
    }
  }
  return contradictions;
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

  it("never describes a milestone the ledger records landed as still open", () => {
    const landed = landedMilestones();
    // Non-vacuity guard: a parse failure in either CSV would otherwise make this check pass
    // while measuring nothing.
    expect([...landed].length).toBeGreaterThan(0);
    expect(milestoneContradictions(readmeBlocks(), landed)).toEqual([]);
  });

  it("counts a milestone landed on STATUS alone, so the rule fires where README can change", () => {
    // Issue #680: a milestone's last row lands with a blank merge commit, and the machine that
    // fills the commit afterwards may not touch README. The rule therefore has to fire on that
    // row's own pull request, not on the provenance proposal after it.
    const registry = [
      { REQ_ID: "REQ-TEST-001", MILESTONE: "M98" },
      { REQ_ID: "REQ-TEST-002", MILESTONE: "M98" },
      { REQ_ID: "REQ-TEST-003", MILESTONE: "M99" },
      { REQ_ID: "REQ-TEST-004", MILESTONE: "" },
    ];
    const lastRowInFlight: readonly LedgerRow[] = [
      { reqId: "REQ-TEST-001", status: "IMPLEMENTED", mergeCommit: "0123abcd" },
      { reqId: "REQ-TEST-002", status: "IMPLEMENTED", mergeCommit: "" },
      { reqId: "REQ-TEST-003", status: "PARTIAL", mergeCommit: "4567cdef" },
    ];
    const landed = landedMilestonesOf(registry, lastRowInFlight);
    expect([...landed]).toEqual(["M98"]);

    // M99 has a PARTIAL row and M100 is unindexed, so neither is a contradiction; and a landed
    // milestone may truthfully be called unreleased until the tagger has cut it.
    const stale = blocksOf(
      "**Not implemented yet (later milestones M98–M100):**\n- one\n\n**M98:** complete, not yet released.\n",
    );
    const found = milestoneContradictions(stale, landed);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("M98 has landed in full");
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
