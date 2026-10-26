import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId, TransportLinkId } from "../domain/id";
import { buildInitialWorld, type WorldState } from "./worldState";
import {
  selectPhase7TradeCandidates,
  type Phase7CandidateEvidence,
  type Phase7CandidateScorePolicy,
} from "./tradeCandidateSelection";

const config = createDefaultSimulationConfig();
const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 77);
const link = [...world.transportLinks.values()][0]!;
const other = [...world.transportLinks.values()].find((l) => l.linkId !== link.linkId)!;
if (!link || !other) throw new Error("M5 candidate test requires baseline routes");
const policy: Phase7CandidateScorePolicy = {
  tradeProfitWeight: 1,
  shortageWeight: 1,
  minimumTradeScore: 0.05,
  maximumShortagePremiumShare: 0.25,
};
const wood = "good:wood" as GoodId;
const iron = "good:iron" as GoodId;

function candidate(
  planId: string,
  overrides: Partial<Phase7CandidateEvidence> = {},
): Phase7CandidateEvidence {
  return {
    planId,
    linkId: link.linkId,
    originRegionId: link.fromRegionId,
    destinationRegionId: link.toRegionId,
    goodId: wood,
    authorizedAtPhase1: true,
    exportableQuantity: 8,
    residualImportDemandQuantity: 6,
    buyerRemainingBudgetDest: 48,
    cargoWeightPerUnit: 2,
    sourceSellerNetUnitPrice: 10,
    destinationReferenceNetUnitPrice: 20,
    destinationReferenceGrossUnitPrice: 20,
    landedGrossUnitCostDest: 12,
    estimatedTransportUnitCostDest: 2,
    estimatedTariffRate: 0,
    estimatedFxInputPerSourceCurrency: 1,
    shortageRateDestination: 0.2,
    ...overrides,
  };
}
function select(
  evidence: readonly Phase7CandidateEvidence[],
  currentWorld: Pick<WorldState, "regions" | "transportLinks"> = world,
  eligible: readonly TransportLinkId[] = [link.linkId, other.linkId],
  factors: ReadonlyMap<TransportLinkId, number> = new Map([
    [link.linkId, 1],
    [other.linkId, 1],
  ]),
  scorePolicy: Phase7CandidateScorePolicy = policy,
) {
  return selectPhase7TradeCandidates(
    currentWorld, config, evidence, factors, new Set(eligible), scorePolicy,
  );
}

describe("M5 #670 Phase-7 aggregate opportunity selection, not reservation", () => {
  it("scores the canonical margin plus shortage and bounds by post-Phase-4 buyer budget", () => {
    const result = select([candidate("plan:wood")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tradePlanId: "plan:wood",
      goodId: wood,
      maximumOwnQuantity: 4,
      sourceSellerNetUnitPrice: 10,
      destinationReferenceNetUnitPrice: 20,
    });
    expect(result[0]!.score).toBeCloseTo(0.6);
    expect(result[0]!.sourceCurrencyId).toBe(world.regions.get(link.fromRegionId)!.settlementCurrencyId);
    expect(result[0]!.destinationCurrencyId).toBe(world.regions.get(link.toRegionId)!.settlementCurrencyId);
  });

  it("takes the minimum independent stock, demand, cargo-weight and legal bounds", () => {
    const available = select([candidate("plan:weight", {
      exportableQuantity: 10, residualImportDemandQuantity: 9,
      cargoWeightPerUnit: 1e10, buyerRemainingBudgetDest: 1e6,
      legalQuantityCap: 3,
    })]);
    expect(available).toHaveLength(0); // route weight makes a sub-minimum lot
    const legal = select([candidate("plan:legal", {
      buyerRemainingBudgetDest: 1e6, legalQuantityCap: 2,
    })]);
    expect(legal[0]?.maximumOwnQuantity).toBe(2);
    const supply = select([candidate("plan:supply", {
      exportableQuantity: 1, buyerRemainingBudgetDest: 1e6,
    })]);
    expect(supply[0]?.maximumOwnQuantity).toBe(1);
    expect(select([candidate("plan:demand", {
      residualImportDemandQuantity: 0, buyerRemainingBudgetDest: 1e6,
    })])).toEqual([]);
  });

  it("rejects closed, ineligible or legal-denied directed links without proposing shipment", () => {
    const plan = candidate("plan:closed");
    expect(select([plan], world, [])).toEqual([]);
    expect(select([{ ...plan, authorizedAtPhase1: false }])).toEqual([]);
    expect(select([plan], world, [link.linkId], new Map([[link.linkId, 0]]))).toEqual([]);
    const disabled = {
      ...link,
      seed: { ...link.seed, condition: 0 },
    };
    const noCapacityWorld = {
      regions: world.regions,
      transportLinks: new Map([[disabled.linkId, disabled]]),
    };
    expect(select([plan], noCapacityWorld, [link.linkId])).toEqual([]);
    expect(select([candidate("plan:zero", { buyerRemainingBudgetDest: 0 })])).toEqual([]);
  });

  it("shortage premiums remain capped even when shortage scoring would otherwise win", () => {
    const highShortage = candidate("plan:premium", {
      destinationReferenceGrossUnitPrice: 20,
      landedGrossUnitCostDest: 26,
      shortageRateDestination: 1,
    });
    expect(select([highShortage])).toEqual([]);
    const allowed = { ...highShortage, landedGrossUnitCostDest: 24 };
    expect(select([allowed])).toHaveLength(1);
    expect(select([allowed], world, [link.linkId, other.linkId],
      new Map([[link.linkId, 1], [other.linkId, 1]]),
      { ...policy, minimumTradeScore: 2 })).toEqual([]);
  });

  it("is stable under shuffled evidence, regions and transport-link insertion order", () => {
    const two = candidate("plan:iron", { goodId: iron });
    const one = candidate("plan:wood");
    const shuffled = {
      regions: new Map([...world.regions].reverse()),
      transportLinks: new Map([...world.transportLinks].reverse()),
    };
    const a = select([two, one]);
    const b = select([one, two], shuffled);
    expect(b).toEqual(a);
    expect(a.map((item) => item.tradePlanId)).toEqual(["plan:iron", "plan:wood"]);
    // Independent candidate bounds MUST NOT be interpreted as combined reservation.
    expect(a.every((item) => item.maximumOwnQuantity === 4)).toBe(true);
  });

  it("orders epsilon-near scores by canonical IDs regardless of evidence/registry insertion", () => {
    const ironNearTie = candidate("plan:iron", {
      goodId: iron, landedGrossUnitCostDest: 12.000000000002,
    });
    const woodSlightlyStronger = candidate("plan:wood");
    const reversedWorld = {
      regions: new Map([...world.regions].reverse()),
      transportLinks: new Map([...world.transportLinks].reverse()),
    };
    const forward = select([woodSlightlyStronger, ironNearTie]);
    const reversed = select(
      [ironNearTie, woodSlightlyStronger], reversedWorld,
      [other.linkId, link.linkId],
      new Map([[other.linkId, 1], [link.linkId, 1]]),
    );

    // The iron score is slightly lower but within the configured rate/score
    // epsilon. Exact floating-point sort would incorrectly put wood first.
    expect(forward.map((item) => item.tradePlanId)).toEqual(["plan:iron", "plan:wood"]);
    expect(reversed).toEqual(forward);
    expect(forward[1]!.score - forward[0]!.score).toBeGreaterThan(0);
    expect(forward[1]!.score - forward[0]!.score).toBeLessThan(config.numeric.rateEpsilon!);

    // A materially different score must still outrank canonical ID order.
    const lowerIron = { ...ironNearTie, landedGrossUnitCostDest: 12.0000000002 };
    expect(select([lowerIron, woodSlightlyStronger]).map((item) => item.tradePlanId))
      .toEqual(["plan:wood", "plan:iron"]);
  });

  it("groups a chain of epsilon-near scores deterministically, not with a non-transitive comparator", () => {
    const copper = "good:copper" as GoodId;
    // Adjacent scores are epsilon ties, but highest to lowest is > epsilon.
    // Their connected group must be ordered solely by canonical GoodId.
    const trio = [
      candidate("plan:wood", { goodId: wood, landedGrossUnitCostDest: 12 }),
      candidate("plan:iron", { goodId: iron, landedGrossUnitCostDest: 12.000000000012 }),
      candidate("plan:copper", { goodId: copper, landedGrossUnitCostDest: 12.000000000024 }),
    ];
    // Difference in score for adjacent entries is 6e-13 < rateEpsilon.
    const expected = ["plan:copper", "plan:iron", "plan:wood"];
    expect(select(trio).map((item) => item.tradePlanId)).toEqual(expected);
    expect(select([...trio].reverse()).map((item) => item.tradePlanId)).toEqual(expected);
  });

  it("takes legal eligibility from the frozen Phase-1 decision, not later controller state", () => {
    const planned = candidate("plan:jurisdiction");
    const original = select([planned]);
    const changed = new Map(world.regions);
    const destination = changed.get(link.toRegionId)!;
    changed.set(link.toRegionId, { ...destination, controllerStateId: null });
    expect(select([planned], { regions: changed, transportLinks: world.transportLinks }))
      .toEqual(original);
    expect(select([{ ...planned, authorizedAtPhase1: false }],
      { regions: changed, transportLinks: world.transportLinks })).toEqual([]);
  });

  it("requires explicit same-tick finite FX feasibility for a mixed-currency opportunity", () => {
    const changed = new Map(world.regions);
    const destination = changed.get(link.toRegionId)!;
    const foreign = "currency:foreign-test" as CurrencyId;
    changed.set(link.toRegionId, { ...destination, settlementCurrencyId: foreign });
    const foreignWorld = { regions: changed, transportLinks: world.transportLinks };
    expect(() => select([candidate("plan:fx")], foreignWorld)).toThrow(/FX feasible quantity/);
    expect(select([candidate("plan:fx", {
      estimatedFxInputPerSourceCurrency: 1.3, fxFeasibleQuantity: 0,
    })], foreignWorld)).toEqual([]);
    const approved = select([candidate("plan:fx", {
      estimatedFxInputPerSourceCurrency: 1.3, fxFeasibleQuantity: 2,
    })], foreignWorld);
    expect(approved[0]).toMatchObject({
      destinationCurrencyId: foreign,
      estimatedFxInputPerSourceCurrency: 1.3,
      maximumOwnQuantity: 2,
    });
    expect(() => select([candidate("plan:same", { fxFeasibleQuantity: 1 })])).toThrow(/same-currency/);
  });

  it("fails closed on duplicate aggregate groups, broken references or malformed numerics", () => {
    const good = candidate("plan:valid");
    expect(() => select([good, candidate("plan:duplicate")])).toThrow(/duplicate aggregate/);
    expect(() => select([good, { ...good, goodId: iron }])).toThrow(/planId/);
    expect(() => select([{ ...good, linkId: "link:absent" as TransportLinkId }]))
      .toThrow(/unknown\/mismatched/);
    expect(() => select([{ ...good, destinationRegionId: other.toRegionId }]))
      .toThrow(/unknown\/mismatched/);
    const invalid: Phase7CandidateEvidence[] = [
      { ...good, planId: " " },
      { ...good, exportableQuantity: Infinity },
      { ...good, buyerRemainingBudgetDest: -1 },
      { ...good, cargoWeightPerUnit: 0 },
      { ...good, shortageRateDestination: 1.5 },
      { ...good, estimatedTariffRate: NaN },
      { ...good, estimatedFxInputPerSourceCurrency: -1 },
      { ...good, landedGrossUnitCostDest: NaN },
      { ...good, legalQuantityCap: -1 },
      { ...good, fxFeasibleQuantity: Infinity },
    ];
    for (const item of invalid) {
      expect(() => select([good, item])).toThrow();
    }
    expect(() => select([good], world, [link.linkId],
      new Map(), policy)).toThrow(/factor/);
    expect(() => select([good], world, [link.linkId],
      new Map([[link.linkId, 1]]),
      { ...policy, shortageWeight: NaN })).toThrow(/shortageWeight/);
  });
});
