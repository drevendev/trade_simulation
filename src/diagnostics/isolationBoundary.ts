/**
 * REQ-MIGRATION-004 isolation-boundary guard (M0 scope).
 *
 * Non-negotiable migration rule 1 (`docs/spec/mirror/06 - Handoff/
 * 11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`, "Non-negotiable migration
 * rules"): legacy and canonical stocks are separate worlds during dual-running; no
 * bidirectional mutation mirroring.
 *
 * This module statically scans the two runtime trees for textual evidence that one
 * side names the other's implementation (an import path, a file read, a namespace
 * reference). It is a source-level guard, not a runtime one: it cannot prove the
 * absence of a bridge assembled outside version control (a CI step, a generated
 * file), only that no `.ts` file under `src/` and no `.cs` file under
 * `TradeCraftSimulation/` currently references the other tree. Extending coverage
 * to generated artifacts or CI wiring is future work, not claimed here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export interface CrossRuntimeViolation {
  readonly file: string;
  readonly line: number;
  readonly marker: string;
  readonly excerpt: string;
}

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "bin", "obj", ".git"]);

/** Recursively reads every file under `extension` beneath `rootDir`. */
export function collectSourceFiles(rootDir: string, extension: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      const entryPath = join(dir, entry);
      const info = statSync(entryPath);
      if (info.isDirectory()) {
        walk(entryPath);
      } else if (entry.endsWith(extension)) {
        files.push({
          path: relative(rootDir, entryPath),
          content: readFileSync(entryPath, "utf8"),
        });
      }
    }
  };

  walk(rootDir);
  return files;
}

/** Pure scan: flags every line in `files` that contains a forbidden marker. */
export function findCrossRuntimeReferences(
  files: readonly SourceFile[],
  forbiddenMarkers: readonly string[],
): CrossRuntimeViolation[] {
  const violations: CrossRuntimeViolation[] = [];

  for (const file of files) {
    file.content.split("\n").forEach((lineText, index) => {
      for (const marker of forbiddenMarkers) {
        if (lineText.includes(marker)) {
          violations.push({
            file: file.path,
            line: index + 1,
            marker,
            excerpt: lineText.trim().slice(0, 200),
          });
        }
      }
    });
  }

  return violations;
}

/** A canonical (`src/**\/*.ts`) source file must never contain these. */
export const CANONICAL_INTO_LEGACY_MARKERS = ["TradeCraftSimulation"] as const;

/** A legacy (`TradeCraftSimulation/**\/*.cs`) source file must never contain these. */
export const LEGACY_INTO_CANONICAL_MARKERS = [
  "src/config",
  "src/domain",
  "src/simulation",
  "src/diagnostics",
  "dist/canonical",
] as const;

/**
 * This guard's own module and test necessarily name the forbidden markers as data
 * (the constants above, the negative-control fixtures) rather than as a live
 * reference. Excluding them from the real-tree audit is what keeps the guard from
 * flagging itself; the fixture-based negative-control tests prove the underlying
 * scan still rejects a genuine violation.
 */
const GUARD_MODULE_BASENAME = "isolationBoundary";

function excludingGuardModule(files: SourceFile[]): SourceFile[] {
  return files.filter((file) => !file.path.includes(GUARD_MODULE_BASENAME));
}

export interface IsolationBoundaryReport {
  readonly canonicalViolations: CrossRuntimeViolation[];
  readonly legacyViolations: CrossRuntimeViolation[];
}

/** Audits the real `src/` and `TradeCraftSimulation/` trees under `repoRoot`. */
export function auditRepositoryIsolationBoundary(repoRoot: string): IsolationBoundaryReport {
  const canonicalFiles = excludingGuardModule(collectSourceFiles(join(repoRoot, "src"), ".ts"));
  const legacyFiles = collectSourceFiles(join(repoRoot, "TradeCraftSimulation"), ".cs");

  return {
    canonicalViolations: findCrossRuntimeReferences(canonicalFiles, CANONICAL_INTO_LEGACY_MARKERS),
    legacyViolations: findCrossRuntimeReferences(legacyFiles, LEGACY_INTO_CANONICAL_MARKERS),
  };
}
