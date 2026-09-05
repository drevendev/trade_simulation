import { describe, expect, it } from "vitest";

import { assertValidRunOptions, assertValidScenarioDefinitionShape } from "./shapeValidation";

function minimalRunOptions(): Record<string, unknown> {
  return {
    scenarioId: "baseline-multistate-v1",
    seed: 7,
    diagnosticsLevel: "OFF",
  };
}

function minimalScenario(): Record<string, unknown> {
  return {
    id: "baseline-multistate-v1",
    version: "1.0.0",
    name: "Baseline multistate",
    description: "Canonical baseline scenario",
    definitionPackId: "baseline-pack-v1",
    geography: [],
    transportLinks: [],
    states: [],
    currencies: [],
    monetaryAuthorities: [],
    clans: [],
    cohorts: [],
    productionUnits: [],
  };
}

describe("assertValidRunOptions", () => {
  it("accepts a minimal well-formed RunOptions unchanged", () => {
    const options = minimalRunOptions();
    expect(() => assertValidRunOptions(options)).not.toThrow();
    expect(options).toEqual(minimalRunOptions());
  });

  it("accepts a well-formed RunOptions with maxTicks present", () => {
    expect(() =>
      assertValidRunOptions({ ...minimalRunOptions(), maxTicks: 100 }),
    ).not.toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "7", null, undefined])(
    "rejects a seed of %p",
    (seed) => {
      expect(() => assertValidRunOptions({ ...minimalRunOptions(), seed })).toThrow(
        /RunOptions\.seed must be a finite number/,
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1, "10"])(
    "rejects a maxTicks of %p when present",
    (maxTicks) => {
      expect(() => assertValidRunOptions({ ...minimalRunOptions(), maxTicks })).toThrow(
        /RunOptions\.maxTicks must be a finite positive integer/,
      );
    },
  );

  it.each(["off", "Summary", "", 1, null, undefined])(
    "rejects a diagnosticsLevel of %p",
    (diagnosticsLevel) => {
      expect(() =>
        assertValidRunOptions({ ...minimalRunOptions(), diagnosticsLevel }),
      ).toThrow(/RunOptions\.diagnosticsLevel must be exactly one of/);
    },
  );

  it.each(["SUMMARY", "DEBUG"])("accepts diagnosticsLevel %p", (diagnosticsLevel) => {
    expect(() =>
      assertValidRunOptions({ ...minimalRunOptions(), diagnosticsLevel }),
    ).not.toThrow();
  });

  it.each(["", 1, null, undefined])("rejects a scenarioId of %p", (scenarioId) => {
    expect(() => assertValidRunOptions({ ...minimalRunOptions(), scenarioId })).toThrow(
      /RunOptions\.scenarioId must be a non-empty string/,
    );
  });

  it("rejects a non-object candidate", () => {
    expect(() => assertValidRunOptions(null)).toThrow(/must be a plain object/);
    expect(() => assertValidRunOptions([])).toThrow(/must be a plain object/);
    expect(() => assertValidRunOptions("options")).toThrow(/must be a plain object/);
  });
});

describe("assertValidScenarioDefinitionShape", () => {
  it("accepts a minimal well-formed ScenarioDefinition unchanged", () => {
    const scenario = minimalScenario();
    expect(() => assertValidScenarioDefinitionShape(scenario)).not.toThrow();
    expect(scenario).toEqual(minimalScenario());
  });

  it("accepts present optional array fields and a present object variation", () => {
    const scenario = {
      ...minimalScenario(),
      markets: [],
      bonds: [],
      initialEvents: [],
      variation: {},
    };
    expect(() => assertValidScenarioDefinitionShape(scenario)).not.toThrow();
  });

  it.each(["id", "version", "name", "description", "definitionPackId"] as const)(
    "rejects a missing required string field %s",
    (field) => {
      const scenario = minimalScenario();
      delete scenario[field];
      expect(() => assertValidScenarioDefinitionShape(scenario)).toThrow(
        new RegExp(`ScenarioDefinition\\.${field} must be a non-empty string`),
      );
    },
  );

  it.each(["id", "version", "name", "description", "definitionPackId"] as const)(
    "rejects a non-string value for required field %s",
    (field) => {
      const scenario = { ...minimalScenario(), [field]: 42 };
      expect(() => assertValidScenarioDefinitionShape(scenario)).toThrow(
        new RegExp(`ScenarioDefinition\\.${field} must be a non-empty string`),
      );
    },
  );

  it.each(["id", "version", "name", "description", "definitionPackId"] as const)(
    "rejects an empty string value for required field %s",
    (field) => {
      const scenario = { ...minimalScenario(), [field]: "" };
      expect(() => assertValidScenarioDefinitionShape(scenario)).toThrow(
        new RegExp(`ScenarioDefinition\\.${field} must be a non-empty string`),
      );
    },
  );

  it.each([
    "geography",
    "transportLinks",
    "states",
    "currencies",
    "monetaryAuthorities",
    "clans",
    "cohorts",
    "productionUnits",
  ] as const)("rejects a missing required array field %s", (field) => {
    const scenario = minimalScenario();
    delete scenario[field];
    expect(() => assertValidScenarioDefinitionShape(scenario)).toThrow(
      new RegExp(`ScenarioDefinition\\.${field} must be an array`),
    );
  });

  it("rejects geography given as a plain object instead of an array", () => {
    const scenario = { ...minimalScenario(), geography: {} };
    expect(() => assertValidScenarioDefinitionShape(scenario)).toThrow(
      /ScenarioDefinition\.geography must be an array/,
    );
  });

  it.each(["markets", "bonds", "initialEvents"] as const)(
    "rejects a present optional array field %s given as a non-array",
    (field) => {
      const scenario = { ...minimalScenario(), [field]: {} };
      expect(() => assertValidScenarioDefinitionShape(scenario)).toThrow(
        new RegExp(`ScenarioDefinition\\.${field} must be an array when present`),
      );
    },
  );

  it("rejects a present variation given as an array or non-object", () => {
    expect(() =>
      assertValidScenarioDefinitionShape({ ...minimalScenario(), variation: [] }),
    ).toThrow(/ScenarioDefinition\.variation must be a plain object when present/);
    expect(() =>
      assertValidScenarioDefinitionShape({ ...minimalScenario(), variation: "x" }),
    ).toThrow(/ScenarioDefinition\.variation must be a plain object when present/);
  });

  it("rejects a non-object candidate", () => {
    expect(() => assertValidScenarioDefinitionShape(null)).toThrow(/must be a plain object/);
    expect(() => assertValidScenarioDefinitionShape([])).toThrow(/must be a plain object/);
    expect(() => assertValidScenarioDefinitionShape("scenario")).toThrow(/must be a plain object/);
  });
});
