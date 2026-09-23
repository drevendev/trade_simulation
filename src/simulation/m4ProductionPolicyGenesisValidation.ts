import { isFiniteCanonicalNumber } from "../domain/numeric";
import type {
  M4ProductionPlanningPolicySeed,
  ScenarioDefinition,
} from "../config/scenarioDefinition";
import { createDefaultSimulationConfig, type LaborConfig } from "../config/simulationConfig";

/**
 * REQ-CONFIG-005 / Issues #633, #642 and #646: validate deterministic M4 State policy
 * fixtures at world-genesis step 1 rather than waiting for whichever Phase-2 path
 * happens to read them. These fixtures are scenario inputs, so missing required maps,
 * unknown references and malformed numbers must never become an implicit zero/no-rule
 * fallback.
 */
export function validateM4ProductionPolicyGenesis(
  scenario: ScenarioDefinition,
  laborConfig: LaborConfig,
): void {
  const regionKeys = new Set((scenario.geography ?? []).map((region) => region.key));
  const productionUnitKeys = new Set(
    (scenario.productionUnits ?? []).map((unit) => unit.key),
  );
  const defaultLaborConfig = createDefaultSimulationConfig().labor;
  const allowedLaborCategories = new Set(
    laborConfig.allowedLaborCategories ?? defaultLaborConfig.allowedLaborCategories ?? [],
  );

  for (const state of scenario.states ?? []) {
    const policy = state.policy?.m4ProductionPlanning;
    if (!policy) continue;

    const minimumWageFloorByRegionKey = requirePolicyMap<
      M4ProductionPlanningPolicySeed["minimumWageFloorByRegionKey"]
    >(
      state.key,
      "minimumWageFloorByRegionKey",
      policy.minimumWageFloorByRegionKey,
    );
    const mandatoryKnownCashByProductionUnitKey = requirePolicyMap<
      M4ProductionPlanningPolicySeed["mandatoryKnownCashByProductionUnitKey"]
    >(
      state.key,
      "mandatoryKnownCashByProductionUnitKey",
      policy.mandatoryKnownCashByProductionUnitKey,
    );

    for (const [regionKey, floorsByLaborCategory] of Object.entries(
      minimumWageFloorByRegionKey,
    )) {
      if (!regionKeys.has(regionKey)) {
        throw new Error(
          `StateSeed "${state.key}": policy.m4ProductionPlanning.minimumWageFloorByRegionKey["${regionKey}"] references a non-existent Region`,
        );
      }

      const wageFloors = requireNestedWageFloorMap(
        state.key,
        regionKey,
        floorsByLaborCategory,
      );

      for (const [laborCategory, floor] of Object.entries(wageFloors)) {
        if (!allowedLaborCategories.has(laborCategory)) {
          throw new Error(
            `StateSeed "${state.key}": policy.m4ProductionPlanning.minimumWageFloorByRegionKey["${regionKey}"]["${laborCategory}"] references a labor category not allowed by LaborConfig.allowedLaborCategories`,
          );
        }

        if (!isFiniteCanonicalNumber(floor) || floor < 0) {
          throw new Error(
            `StateSeed "${state.key}": policy.m4ProductionPlanning.minimumWageFloorByRegionKey["${regionKey}"]["${laborCategory}"] must be a non-negative finite number, got ${describeNumber(floor)}`,
          );
        }
      }
    }

    for (const [productionUnitKey, requiredCash] of Object.entries(
      mandatoryKnownCashByProductionUnitKey,
    )) {
      if (!productionUnitKeys.has(productionUnitKey)) {
        throw new Error(
          `StateSeed "${state.key}": policy.m4ProductionPlanning.mandatoryKnownCashByProductionUnitKey["${productionUnitKey}"] references a non-existent ProductionUnit`,
        );
      }

      if (!isFiniteCanonicalNumber(requiredCash) || requiredCash < 0) {
        throw new Error(
          `StateSeed "${state.key}": policy.m4ProductionPlanning.mandatoryKnownCashByProductionUnitKey["${productionUnitKey}"] must be a non-negative finite number, got ${describeNumber(requiredCash)}`,
        );
      }
    }
  }
}

function requirePolicyMap<T extends object>(
  stateKey: string,
  fieldName:
    | "minimumWageFloorByRegionKey"
    | "mandatoryKnownCashByProductionUnitKey",
  value: unknown,
): T {
  if (!isPlainObject(value)) {
    throw new Error(
      `StateSeed "${stateKey}": policy.m4ProductionPlanning.${fieldName} must be present as a non-null plain object map`,
    );
  }

  return value as T;
}

function requireNestedWageFloorMap(
  stateKey: string,
  regionKey: string,
  value: unknown,
): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new Error(
      `StateSeed "${stateKey}": policy.m4ProductionPlanning.minimumWageFloorByRegionKey["${regionKey}"] must be a non-null plain object map`,
    );
  }

  return value as Record<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeNumber(value: unknown): string {
  if (typeof value !== "number") return JSON.stringify(value) ?? String(value);
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return String(value);
}