/**
 * RunOptions and ScenarioDefinition top-level shape validation (REQ-CONFIG-005).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 21: "Configuration validation fails fast ... do not silently coerce."
 * This module covers exactly the slice of section 21 that is realizable today —
 * `RunOptions`'s own fields, and `ScenarioDefinition`'s required top-level field
 * shapes — because every sub-`SimulationConfig` type and every scenario seed type
 * is still an empty placeholder pending later requirements (see the Non-goals of
 * the Issue that introduced this module). It is additive alongside
 * `./validation.ts`'s `assertNoBehavioralOverrides`, which proves key-membership,
 * not value shape.
 */
import { isFiniteCanonicalNumber } from "../domain/numeric";
import type { RunOptions } from "./runOptions";
import type { ScenarioDefinition } from "./scenarioDefinition";

const DIAGNOSTICS_LEVELS: ReadonlySet<string> = new Set(["OFF", "SUMMARY", "DEBUG"]);

/** Required `ScenarioDefinition` fields that must be non-empty strings. */
const SCENARIO_REQUIRED_STRING_FIELDS = [
  "id",
  "version",
  "name",
  "description",
  "definitionPackId",
] as const;

/** Required `ScenarioDefinition` fields that must be arrays (seed lists may be empty). */
const SCENARIO_REQUIRED_ARRAY_FIELDS = [
  "geography",
  "transportLinks",
  "states",
  "currencies",
  "monetaryAuthorities",
  "clans",
  "cohorts",
  "productionUnits",
] as const;

/** Optional `ScenarioDefinition` fields that, when present, must be arrays. */
const SCENARIO_OPTIONAL_ARRAY_FIELDS = ["markets", "bonds", "initialEvents"] as const;

/**
 * Throws unless `candidate` is a `RunOptions`-shaped object with a finite `seed`,
 * an absent or finite-positive-integer `maxTicks`, a `diagnosticsLevel` exactly
 * one of `'OFF' | 'SUMMARY' | 'DEBUG'`, and a non-empty string `scenarioId`. Never
 * coerces: a rejected candidate is rejected outright, not repaired.
 */
export function assertValidRunOptions(candidate: unknown): asserts candidate is RunOptions {
  const record = assertPlainObject(candidate, "RunOptions");

  if (!isFiniteCanonicalNumber(record.seed)) {
    throw new Error(`RunOptions.seed must be a finite number, got ${describeValue(record.seed)}`);
  }

  if (record.maxTicks !== undefined) {
    if (
      !isFiniteCanonicalNumber(record.maxTicks) ||
      !Number.isInteger(record.maxTicks) ||
      record.maxTicks <= 0
    ) {
      throw new Error(
        `RunOptions.maxTicks must be a finite positive integer when present, got ${describeValue(record.maxTicks)}`,
      );
    }
  }

  if (typeof record.diagnosticsLevel !== "string" || !DIAGNOSTICS_LEVELS.has(record.diagnosticsLevel)) {
    throw new Error(
      `RunOptions.diagnosticsLevel must be exactly one of 'OFF' | 'SUMMARY' | 'DEBUG', got ${describeValue(record.diagnosticsLevel)}`,
    );
  }

  if (typeof record.scenarioId !== "string" || record.scenarioId.length === 0) {
    throw new Error(
      `RunOptions.scenarioId must be a non-empty string, got ${describeValue(record.scenarioId)}`,
    );
  }
}

/**
 * Throws unless `candidate` carries every `ScenarioDefinition` required
 * top-level field with the correct primitive/array shape, and every present
 * optional field (`markets`, `bonds`, `initialEvents`, `variation`) with the
 * correct shape. Does not check key membership (see `./validation.ts`) or any
 * seed-list content — only the top-level shape this requirement scopes.
 */
export function assertValidScenarioDefinitionShape(
  candidate: unknown,
): asserts candidate is ScenarioDefinition {
  const record = assertPlainObject(candidate, "ScenarioDefinition");

  for (const field of SCENARIO_REQUIRED_STRING_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `ScenarioDefinition.${field} must be a non-empty string, got ${describeValue(value)}`,
      );
    }
  }

  for (const field of SCENARIO_REQUIRED_ARRAY_FIELDS) {
    const value = record[field];
    if (!Array.isArray(value)) {
      throw new Error(`ScenarioDefinition.${field} must be an array, got ${describeValue(value)}`);
    }
  }

  for (const field of SCENARIO_OPTIONAL_ARRAY_FIELDS) {
    const value = record[field];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(
        `ScenarioDefinition.${field} must be an array when present, got ${describeValue(value)}`,
      );
    }
  }

  if (
    record.variation !== undefined &&
    (typeof record.variation !== "object" || record.variation === null || Array.isArray(record.variation))
  ) {
    throw new Error(
      `ScenarioDefinition.variation must be a plain object when present, got ${describeValue(record.variation)}`,
    );
  }
}

function assertPlainObject(candidate: unknown, label: string): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`${label} candidate must be a plain object, got ${describeValue(candidate)}`);
  }
  return candidate as Record<string, unknown>;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (typeof value === "object") return "an object";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
