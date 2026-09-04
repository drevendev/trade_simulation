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
