import { describe, expect, it } from "vitest";

import { createDefaultSimulationConfig } from "./simulationConfig";
import { validateLaborConfig, validateProductionConfig } from "./validation";

// This focused regression is the executable evidence for HANDOFF-REPAIR-M4-002.
describe("canonical M4 REQ-CONFIG-006 defaults", () => {
  it("pins all fourteen HANDOFF-REPAIR-M4-002 production/labor values", () => {
    const config = createDefaultSimulationConfig();

    expect(config.production).toMatchObject({
      investmentReviewCadenceTicks: 3,
      investmentUtilizationThreshold: 0.75,
      minimumInvestmentMargin: 0.05,
      investmentPropensity: 0.35,
      maxInvestmentShareOfExcessCash: 0.5,
      maxCapitalGrowthPerReview: 0.25,
      lifecycleReviewCadenceTicks: 3,
      mothballMarginThreshold: -0.1,
      mothballUtilizationThreshold: 0.25,
      reactivateMarginThreshold: 0.05,
      closingGraceReviews: 4,
    });

    expect(config.labor.maxLogWageStep).toBeCloseTo(Math.log(1.05), 15);
    expect(config.labor.unitVacancyResponse).toBe(0.02);
    expect(config.labor.maxTightnessSignal).toBe(2.0);
  });

  it("keeps the canonical defaults inside the existing validators without weakening ranges", () => {
    const config = createDefaultSimulationConfig();
    expect(() => validateProductionConfig(config.production)).not.toThrow();
    expect(() => validateLaborConfig(config.labor)).not.toThrow();
  });

  it("keeps quantityEpsilon as the sole labor quantity tolerance owner", () => {
    const config = createDefaultSimulationConfig();
    expect(config.labor).not.toHaveProperty("laborEpsilon");
    expect(config.numeric.quantityEpsilon).toBe(1e-9);
  });
});
