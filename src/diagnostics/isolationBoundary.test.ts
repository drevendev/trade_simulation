import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditRepositoryIsolationBoundary,
  CANONICAL_INTO_LEGACY_MARKERS,
  findCrossRuntimeReferences,
  LEGACY_INTO_CANONICAL_MARKERS,
  type SourceFile,
} from "./isolationBoundary";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("REQ-MIGRATION-004 isolation boundary", () => {
  it("finds zero cross-runtime references in the current M0 source trees", () => {
    const report = auditRepositoryIsolationBoundary(repoRoot);

    expect(report.canonicalViolations).toEqual([]);
    expect(report.legacyViolations).toEqual([]);
  });

  it("negative control: auditRepositoryIsolationBoundary rejects a similarly-named-but-distinct file that the guard-module exclusion must not swallow", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "isolation-boundary-audit-"));

    try {
      mkdirSync(join(tempRoot, "src", "domain"), { recursive: true });
      mkdirSync(join(tempRoot, "TradeCraftSimulation"), { recursive: true });

      // Distinct from, but naming-adjacent to, the guard's own
      // `diagnostics/isolationBoundary.ts`: a substring match on "isolationBoundary"
      // would wrongly exclude this file too. It carries a genuine prohibited
      // reference and must still be reported by the full traversal path.
      writeFileSync(
        join(tempRoot, "src", "domain", "isolationBoundaryBridge.ts"),
        'import { readLegacyStorage } from "../../TradeCraftSimulation/Storage";',
      );

      const report = auditRepositoryIsolationBoundary(tempRoot);

      expect(report.canonicalViolations).toEqual([
        {
          file: join("domain", "isolationBoundaryBridge.ts"),
          line: 1,
          marker: "TradeCraftSimulation",
          excerpt: 'import { readLegacyStorage } from "../../TradeCraftSimulation/Storage";',
        },
      ]);
      expect(report.legacyViolations).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("negative control: rejects a canonical file that imports the legacy tree", () => {
    const fixture: SourceFile[] = [
      {
        path: "domain/badBridge.ts",
        content: 'import { readLegacyStorage } from "../../TradeCraftSimulation/Storage";',
      },
    ];

    const violations = findCrossRuntimeReferences(fixture, CANONICAL_INTO_LEGACY_MARKERS);

    expect(violations).toEqual([
      {
        file: "domain/badBridge.ts",
        line: 1,
        marker: "TradeCraftSimulation",
        excerpt: 'import { readLegacyStorage } from "../../TradeCraftSimulation/Storage";',
      },
    ]);
  });

  it("negative control: rejects a legacy file that reads canonical module output", () => {
    const fixture: SourceFile[] = [
      {
        path: "BadBridge.cs",
        content: 'var mirror = File.ReadAllText("../src/domain/index.ts");',
      },
    ];

    const violations = findCrossRuntimeReferences(fixture, LEGACY_INTO_CANONICAL_MARKERS);

    expect(violations).toEqual([
      {
        file: "BadBridge.cs",
        line: 1,
        marker: "src/domain",
        excerpt: 'var mirror = File.ReadAllText("../src/domain/index.ts");',
      },
    ]);
  });

  it("does not flag an unrelated marker absent from the fixture", () => {
    const fixture: SourceFile[] = [{ path: "domain/fine.ts", content: "export const ok = 1;" }];

    expect(findCrossRuntimeReferences(fixture, CANONICAL_INTO_LEGACY_MARKERS)).toEqual([]);
  });
});
