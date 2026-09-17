import fs from "node:fs";

const path = "src/config/validation.test.ts";
const source = fs.readFileSync(path, "utf8");
const startMarker = 'describe("canonical population defaults (REQ-CONFIG-007)", () => {';
const endMarker = 'describe("validatePopulationConfig", () => {';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0 || end <= start) {
  throw new Error("REQ-CONFIG-007 population-default block markers not found");
}
const replacement = `describe("canonical population defaults (REQ-CONFIG-007)", () => {
  it("materializes all twenty canonical M4 population controls", () => {
    const population = createDefaultSimulationConfig().population;
    expect(Object.keys(population).sort()).toEqual([...M4_POPULATION_CONTROLS].sort());
    expect(M4_POPULATION_CONTROLS).toHaveLength(20);
  });

  it("keeps deferred M8 demography/migration/mobility controls out of PopulationConfig", () => {
    const population = createDefaultSimulationConfig().population as unknown as Record<string, unknown>;
    for (const deferred of [
      "fertilityRate",
      "mortalityRate",
      "agingRate",
      "migrationRate",
      "mobilityRate",
      "cohortMergeTolerance",
    ]) {
      expect(population).not.toHaveProperty(deferred);
    }
  });

  it("does not revive superseded population aliases", () => {
    const population = createDefaultSimulationConfig().population as unknown as Record<string, unknown>;
    for (const alias of [
      "needSubstitutionElasticity",
      "consumptionBudgetShareLower",
      "consumptionBudgetShareMiddle",
      "consumptionBudgetShareUpper",
      "precautionaryCashFloorMonths",
      "healthEmaAlpha",
      "wageSignalAlpha",
      "prosperityEmaAlpha",
    ]) {
      expect(population).not.toHaveProperty(alias);
    }
  });
});

`;
fs.writeFileSync(path, source.slice(0, start) + replacement + source.slice(end));
