import { isFiniteCanonicalNumber } from "../domain/numeric";
import type { ScenarioDefinition } from "../config/scenarioDefinition";
import type { LaborConfig } from "../config/simulationConfig";

/**
 * REQ-CONFIG-005 / Issue #633: validate deterministic M4 State policy fixtures at
 * world-genesis step 1 rather than waiting for whichever Phase-2 path happens to
 * read them. These fixtures are scenario inputs, so unknown references and malformed
 * numbers must never become an implicit zero/no-rule fallback.
 */
export function validateM4ProductionPolicyGenesis(
  scenario: ScenarioDefinition,
  laborConfig: LaborConfig,
): void {
  const regionKeys = new Set((scenario.geography ?? []).map((region) => region.key));
  const productionUnitKeys = new Set(
    (scenario.productionUnits ?? []).map((unit) => unit.key),
  );
  const allowedLaborCategories = new Set(laborConfig.allowedLaborCategories ?? []);

  for (const state of scenario.states ?? []) {
    const policy = state.policy?.m4ProductionPlanning;
    if (!policy) continue;

    for (const [regionKey, floorsByLaborCategory] of Object.entries(
      policy.minimumWageFloorByRegionKey ?? {},
    )) {
      if (!regionKeys.has(regionKey)) {
        throw new Error(
          `StateSeed "${state.key}": policy.m4ProductionPlanning.minimumWageFloorByRegionKey["${regionKey}"] references a non-existent Region`,
        );
      }

      for (const [laborCategory, floor] of Object.entries(floorsByLaborCategory ?? {})) {
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
      policy.mandatoryKnownCashByProductionUnitKey ?? {},
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

function describeNumber(value: unknown): string {
  if (typeof value !== "number") return JSON.stringify(value) ?? String(value);
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return String(value);
}
