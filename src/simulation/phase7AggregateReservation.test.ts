/** M5 #670: shared Phase-7 regional reservations, never canonical settlement. */
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import type { Phase7EligibleTradeCandidate, Phase7CandidateEvidence } from "./tradeCandidateSelection";
import {
  phase7FxOutputKey,
  phase7RegionCashKey,
  phase7RegionGoodKey,
  reservePhase7AggregateTrades,
  previewPhase7PreFxRegionalDemand,
  type Phase7AggregateBudgets,
  type Phase7AggregateReservationRequest,
} from "./phase7AggregateReservation";
import { buildInitialWorld, type TransportLinkState, type WorldState } from "./worldState";

const config = createDefaultSimulationConfig();
const baseline = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 77);
const allLinks = [...baseline.transportLinks.values()];
const domestic = allLinks.find((l) => baseline.regions.get(l.fromRegionId)!.settlementCurrencyId ===
  baseline.regions.get(l.toRegionId)!.settlementCurrencyId)!;
const foreign = allLinks.find((l) => baseline.regions.get(l.fromRegionId)!.settlementCurrencyId !==
  baseline.regions.get(l.toRegionId)!.settlementCurrencyId)!;
if (!domestic || !foreign) throw new Error("Phase-7 fixture requires domestic and foreign routes");
const wood = "good:wood" as GoodId;
const iron = "good:iron" as GoodId;
const pair = "fx:test-alpha-beta";

function edge(link: TransportLinkState, baseCapacity = 100): TransportLinkState {
  return { ...link, seed: { ...link.seed, condition: 1, baseCapacity } };
}
function worldWith(...links: TransportLinkState[]): Pick<WorldState, "regions" | "transportLinks"> {
  return {
    regions: baseline.regions,
    transportLinks: new Map(links.map((l) => [l.linkId, l])),
  };
}
function candidate(
  plan: string, link: TransportLinkState, goodId: GoodId, score: number,
  overrides: Partial<Phase7EligibleTradeCandidate> = {},
): Phase7EligibleTradeCandidate {
  return {
    tradePlanId: plan,
    linkId: link.linkId,
    originRegionId: link.fromRegionId,
    destinationRegionId: link.toRegionId,
    goodId,
    sourceCurrencyId: baseline.regions.get(link.fromRegionId)!.settlementCurrencyId,
    destinationCurrencyId: baseline.regions.get(link.toRegionId)!.settlementCurrencyId,
    sourceSellerNetUnitPrice: 2,
    destinationReferenceNetUnitPrice: 10,
    estimatedTransportUnitCostDest: 1,
    estimatedTariffRate: 0,
    estimatedFxInputPerSourceCurrency: 1,
    shortageRateDestination: 0.2,
    score,
    maximumOwnQuantity: 8,
    ...overrides,
  };
}
function req(
  plan: string, link: TransportLinkState, goodId: GoodId, score: number,
  extra: Partial<Phase7AggregateReservationRequest> = {},
): Phase7AggregateReservationRequest {
  return {
    candidate: candidate(plan, link, goodId, score),
    cargoWeightPerUnit: 1,
    landedGrossUnitCostDest: 2,
    ...extra,
  };
}
function balances(requests: readonly Phase7AggregateReservationRequest[],
  stock = 20, demand = 20, cash = 100, fxOutput = 100): Phase7AggregateBudgets {
  const supply = new Map<string, number>();
  const needs = new Map<string, number>();
  const wallets = new Map<string, number>();
  const fx = new Map<string, number>();
  for (const { candidate: c, fxPoolPairId } of requests) {
    supply.set(phase7RegionGoodKey(c.originRegionId, c.goodId), stock);
    needs.set(phase7RegionGoodKey(c.destinationRegionId, c.goodId), demand);
    wallets.set(phase7RegionCashKey(c.destinationRegionId, c.destinationCurrencyId), cash);
    if (fxPoolPairId) fx.set(phase7FxOutputKey(fxPoolPairId, c.sourceCurrencyId), fxOutput);
  }
  return {
    exportableByOriginGood: supply,
    importDemandByDestinationGood: needs,
    buyerCashByDestinationCurrency: wallets,
    fxOutputByPairCurrency: fx,
  };
}
function reserve(
  requests: readonly Phase7AggregateReservationRequest[],
  budgets: Phase7AggregateBudgets = balances(requests),
  links: readonly TransportLinkState[] = [edge(domestic)],
  eligible: readonly TransportLinkId[] = links.map((link) => link.linkId),
) {
  return reservePhase7AggregateTrades(
    worldWith(...links), config, requests, budgets,
    new Map(links.map((link) => [link.linkId, 1])),
    new Set(eligible),
  );
}

describe("M5 #670 shared Phase-7 aggregate resource preflight", () => {
  it("competes across goods for ONE directed link and buyer cash; leaves Phase-8 residuals", () => {
    const link = edge(domestic, 10);
    const a = req("iron", link, iron, 3);
    const b = req("wood", link, wood, 2);
    const budgets = balances([a, b], 20, 20, 100);
    const original = [...budgets.buyerCashByDestinationCurrency];
    const result = reserve([b, a], budgets, [link]);
    expect(result.reservations.map((r) => [r.tradePlanId, r.allocatedQuantity]))
      .toEqual([["iron", 8], ["wood", 2]]);
    expect(result.remainingCargoWeightByLink.get(link.linkId)).toBe(0);
    expect(result.remainingImportDemandByDestinationGood.get(
      phase7RegionGoodKey(link.toRegionId, wood))).toBe(18);
    expect(result.remainingExportableByOriginGood.get(
      phase7RegionGoodKey(link.fromRegionId, iron))).toBe(12);
    const currency = baseline.regions.get(link.toRegionId)!.settlementCurrencyId;
    expect(result.remainingBuyerCashByDestinationCurrency.get(
      phase7RegionCashKey(link.toRegionId, currency))).toBe(80);
    expect([...budgets.buyerCashByDestinationCurrency]).toEqual(original);
    expect(link.seed.baseCapacity).toBe(10); // never mutates WorldState
  });

  it("reserves one regional stock and demand pool across multiple links to the same destination", () => {
    const first = edge(domestic);
    const second = {
      ...first, linkId: "link:m5-secondary" as TransportLinkId,
    };
    const a = req("a", first, wood, 3);
    const b = req("b", second, wood, 2);
    const budget = balances([a, b], 9, 9, 100);
    const result = reserve([b, a], budget, [second, first]);
    expect(result.reservations.map((r) => r.allocatedQuantity)).toEqual([8, 1]);
    expect(result.remainingExportableByOriginGood.get(
      phase7RegionGoodKey(first.fromRegionId, wood))).toBe(0);
    expect(result.remainingImportDemandByDestinationGood.get(
      phase7RegionGoodKey(first.toRegionId, wood))).toBe(0);
    expect(result.reservations.reduce((acc, r) => acc + r.buyerCashReservedDest, 0)).toBe(18);
  });

  it("tracks actual shared destination cash, not a candidate's independent buyer budget", () => {
    const link = edge(domestic);
    const a = req("a", link, iron, 3);
    const b = req("b", link, wood, 2);
    const result = reserve([b, a], balances([a, b], 100, 100, 10), [link]);
    expect(result.reservations.map((r) => r.allocatedQuantity)).toEqual([5, 0]);
    expect(result.reservations[1]?.refusal).toBe("INSUFFICIENT_SHARED_RESIDUAL");
  });

  it("shares the FX pool output after its floor; cross-currency flow never mints source cash", () => {
    const first = edge(foreign);
    const second = { ...first, linkId: "link:m5-second-border" as TransportLinkId };
    const a = req("a", first, iron, 3, { fxPoolPairId: pair });
    const b = req("b", second, wood, 2, { fxPoolPairId: pair });
    const budget = balances([a, b], 100, 100, 100, 10);
    const result = reserve([b, a], budget, [second, first]);
    expect(result.reservations.map((r) => r.allocatedQuantity)).toEqual([5, 0]);
    expect(result.reservations[0]?.fxPoolOutputReservedSource).toBe(10);
    expect(result.remainingFxOutputByPairCurrency.get(
      phase7FxOutputKey(pair, a.candidate.sourceCurrencyId))).toBe(0);
    expect([...budget.fxOutputByPairCurrency.values()]).toEqual([10]);
    // FX input is already part of destination buyer landed-cost cash reservation.
    expect(result.reservations[0]?.buyerCashReservedDest).toBe(10);
  });

  it("reorders input and registry maps without changing epsilon-banded allocations", () => {
    const link = edge(domestic);
    const near = config.numeric.rateEpsilon! / 2;
    const a = req("wood", link, wood, 1);
    const b = req("iron", link, iron, 1 - near);
    const list = [a, b];
    const budget = balances(list, 100, 100, 100);
    const flipped: Phase7AggregateBudgets = {
      exportableByOriginGood: new Map([...budget.exportableByOriginGood].reverse()),
      importDemandByDestinationGood: new Map([...budget.importDemandByDestinationGood].reverse()),
      buyerCashByDestinationCurrency: new Map([...budget.buyerCashByDestinationCurrency].reverse()),
      fxOutputByPairCurrency: new Map([...budget.fxOutputByPairCurrency].reverse()),
    };
    const first = reserve(list, budget, [edge(link, 10)]);
    const second = reserve([b, a], flipped, [edge(link, 10)]);
    expect(first).toEqual(second);
    expect(first.reservations.map((r) => r.tradePlanId)).toEqual(["iron", "wood"]);
    expect(first.reservations.map((r) => r.allocatedQuantity)).toEqual([8, 2]);
  });

  it("refuses sub-minimum quantity without decrementing any shared resource", () => {
    const link = edge(domestic);
    const a = req("a", link, wood, 1);
    const budget = balances([a], 1e-7, 100, 100);
    const result = reserve([a], budget, [link]);
    expect(result.reservations[0]).toMatchObject({
      allocatedQuantity: 0,
      cargoWeightReserved: 0,
      buyerCashReservedDest: 0,
      refusal: "INSUFFICIENT_SHARED_RESIDUAL",
    });
    expect(result.remainingExportableByOriginGood.get(
      phase7RegionGoodKey(link.fromRegionId, wood))).toBe(1e-7);
    expect(result.remainingCargoWeightByLink.get(link.linkId)).toBe(100);
  });

  it("rejects duplicate directed-link/good requests with distinct plan IDs before allocating", () => {
    const link = edge(domestic, 100);
    // The selector allows only one aggregate plan per directed link and good.
    // Replaying its cap with a new planId must never create a second allocation.
    const first = req("policy-cap-a", link, wood, 2, {
      candidate: candidate("policy-cap-a", link, wood, 2, { maximumOwnQuantity: 3 }),
    });
    const second = req("policy-cap-b", link, wood, 1, {
      candidate: candidate("policy-cap-b", link, wood, 1, { maximumOwnQuantity: 3 }),
    });
    const budget = balances([first, second], 20, 20, 100);
    const original = [...budget.exportableByOriginGood];
    for (const order of [[first, second], [second, first]]) {
      expect(() => reserve(order, budget, [link]))
        .toThrow(/duplicate aggregate Phase-7 candidate for directed link and good/);
    }
    expect([...budget.exportableByOriginGood]).toEqual(original);
    // The existing multi-good/same-link and same-good/multi-link tests remain
    // positive controls; uniqueness is only for the same directed link + good.
  });

  it("fails closed on missing budgets, duplicate plans, stale currency, invalid price and FX pair", () => {
    const link = edge(domestic);
    const a = req("a", link, wood, 1);
    const all = balances([a]);
    expect(() => reserve([a, a], all, [link])).toThrow(/planId/);
    expect(() => reserve([a], { ...all, exportableByOriginGood: new Map() }, [link]))
      .toThrow(/missing explicit/);
    expect(() => reserve([{ ...a, landedGrossUnitCostDest: Number.NaN }], all, [link]))
      .toThrow(/landedGross/);
    expect(() => reserve([{ ...a, candidate: { ...a.candidate, destinationCurrencyId:
      "cur:stale" as typeof a.candidate.destinationCurrencyId } }], all, [link]))
      .toThrow(/stale/);
    expect(() => reserve([{ ...a, fxPoolPairId: pair }], all, [link])).toThrow(/same-currency/);
    const cross = req("fx", edge(foreign), wood, 1);
    expect(() => reserve([cross], balances([cross]), [edge(foreign)]))
      .toThrow(/explicit FX pair/);
    const stopped = reserve([a], all, [link], []);
    expect(stopped.reservations[0]?.refusal).toBe("LINK_NOT_ELIGIBLE");
    expect(stopped.reservations[0]?.allocatedQuantity).toBe(0);
  });

  it("fails closed when positive cross-currency shipment would reserve zero cargo and FX output", () => {
    const link = edge(foreign, 100);
    const ordinary = req("tiny-cross", link, wood, 1, { fxPoolPairId: pair });
    const tiny = {
      ...ordinary,
      cargoWeightPerUnit: Number.MIN_VALUE,
      candidate: {
        ...ordinary.candidate,
        maximumOwnQuantity: 0.1,
        sourceSellerNetUnitPrice: Number.MIN_VALUE,
      },
    };
    const budget = balances([tiny], 10, 10, 100, 10);
    expect(0.1 * Number.MIN_VALUE).toBe(0);
    expect(() => reserve([tiny], budget, [link])).toThrow(/numeric precision/);
    expect(budget.exportableByOriginGood.get(
      phase7RegionGoodKey(link.fromRegionId, wood))).toBe(10);
    expect(budget.fxOutputByPairCurrency.get(
      phase7FxOutputKey(pair, tiny.candidate.sourceCurrencyId))).toBe(10);
  });

  it("rejects rounded-zero cargo or payable buyer cash on domestic positive shipments", () => {
    const link = edge(domestic, 100);
    const ordinary = req("tiny-domestic", link, wood, 1);
    const budget = balances([ordinary], 10, 10, 100);
    const quantity = { ...ordinary.candidate, maximumOwnQuantity: 0.1 };
    expect(() => reserve([{
      ...ordinary, candidate: quantity, cargoWeightPerUnit: Number.MIN_VALUE,
    }], budget, [link])).toThrow(/numeric precision/);
    expect(() => reserve([{
      ...ordinary, candidate: quantity, landedGrossUnitCostDest: Number.MIN_VALUE,
    }], budget, [link])).toThrow(/numeric precision/);
    expect(budget.buyerCashByDestinationCurrency.get(
      phase7RegionCashKey(link.toRegionId, ordinary.candidate.destinationCurrencyId))).toBe(100);
  });

  it("rejects invisible arithmetic instead of creating a phantom cash reservation", () => {
    const link = edge(domestic, 100);
    const a = req("a", link, wood, 1);
    expect(() => reserve([a], balances([a], 1, 1, 1e24), [link]))
      .toThrow(/numeric precision/);
  });

  it("rejects observable-but-inaccurate goods and demand reservation decrements", () => {
    const link = edge(domestic, 100);
    const base = req("precision-goods", link, wood, 1);
    const request = { ...base, candidate: { ...base.candidate, maximumOwnQuantity: 3 },
      landedGrossUnitCostDest: 1 };
    const huge = 1e16;
    expect(huge - 3).toBe(huge - 4); // binary64 stores a debit of FOUR

    const highStock = balances([request], huge, 10, 100);
    expect(() => reserve([request], highStock, [link]))
      .toThrow(/export stock reservation lost numeric precision/);
    expect(highStock.exportableByOriginGood.get(
      phase7RegionGoodKey(link.fromRegionId, wood))).toBe(huge);

    const highDemand = balances([request], 10, huge, 100);
    expect(() => reserve([request], highDemand, [link]))
      .toThrow(/import demand reservation lost numeric precision/);
    expect(highDemand.importDemandByDestinationGood.get(
      phase7RegionGoodKey(link.toRegionId, wood))).toBe(huge);
  });

  it("rejects observable-but-inaccurate buyer cash, cargo and FX output decrements", () => {
    const huge = 1e16;
    const link = edge(domestic, 100);
    const base = req("precision-cash", link, wood, 1);
    const request = { ...base, candidate: { ...base.candidate, maximumOwnQuantity: 3 },
      landedGrossUnitCostDest: 1 };
    const highCash = balances([request], 10, 10, huge);
    expect(() => reserve([request], highCash, [link]))
      .toThrow(/buyer cash reservation lost numeric precision/);

    const enormousLink = edge(domestic, huge);
    const highCargoBase = req("precision-cargo", enormousLink, wood, 1);
    const highCargo = { ...highCargoBase,
      candidate: { ...highCargoBase.candidate, maximumOwnQuantity: 3 },
      landedGrossUnitCostDest: 1 };
    expect(() => reserve([highCargo], balances([highCargo], 10, 10, 100), [enormousLink]))
      .toThrow(/cargo weight reservation lost numeric precision/);

    const cross = edge(foreign, 100);
    const foreignBase = req("precision-fx", cross, wood, 1, { fxPoolPairId: pair });
    const foreignRequest = { ...foreignBase,
      candidate: { ...foreignBase.candidate, maximumOwnQuantity: 3,
        sourceSellerNetUnitPrice: 1 },
      landedGrossUnitCostDest: 1 };
    const highFx = balances([foreignRequest], 10, 10, 100, huge);
    expect(() => reserve([foreignRequest], highFx, [cross]))
      .toThrow(/FX pool output reservation lost numeric precision/);
    expect(highFx.fxOutputByPairCurrency.get(
      phase7FxOutputKey(pair, foreignRequest.candidate.sourceCurrencyId))).toBe(huge);
  });

  it("accepts exact large debits and harmless decimal representation noise", () => {
    const huge = 1e16;
    const giantLink = edge(domestic, huge);
    const base = req("precision-exact", giantLink, wood, 1);
    const exact = { ...base, candidate: { ...base.candidate, maximumOwnQuantity: 4 },
      landedGrossUnitCostDest: 1 };
    const result = reserve([exact], balances([exact], huge, huge, huge), [giantLink]);
    expect(result.reservations[0]).toMatchObject({
      allocatedQuantity: 4, cargoWeightReserved: 4, buyerCashReservedDest: 4, refusal: null,
    });
    expect(result.remainingExportableByOriginGood.get(
      phase7RegionGoodKey(giantLink.fromRegionId, wood))).toBe(huge - 4);
    expect(result.remainingImportDemandByDestinationGood.get(
      phase7RegionGoodKey(giantLink.toRegionId, wood))).toBe(huge - 4);
    expect(result.remainingBuyerCashByDestinationCurrency.get(
      phase7RegionCashKey(giantLink.toRegionId, exact.candidate.destinationCurrencyId)))
      .toBe(huge - 4);
    expect(result.remainingCargoWeightByLink.get(giantLink.linkId)).toBe(huge - 4);

    const normalLink = edge(domestic, 100);
    const decimalBase = req("precision-decimal", normalLink, wood, 1);
    const decimal = { ...decimalBase,
      candidate: { ...decimalBase.candidate, maximumOwnQuantity: 0.1 },
      landedGrossUnitCostDest: 1 };
    const decimalResult = reserve([decimal], balances([decimal], 0.3, 0.3, 0.3), [normalLink]);
    expect(decimalResult.reservations[0]?.allocatedQuantity).toBe(0.1);
    expect(decimalResult.reservations[0]?.refusal).toBeNull();
  });

  it("rejects cumulative multi-link seller-stock and buyer-demand drift even when each 0.3 debit fits epsilon", () => {
    const huge = 10_000_000;
    const first = edge(domestic, 100);
    const second = { ...first, linkId: "link:precision-cumulative-two" as TransportLinkId };
    const tiny = (plan: string, link: TransportLinkState, score: number) => {
      const base = req(plan, link, wood, score);
      return { ...base, candidate: { ...base.candidate, maximumOwnQuantity: 0.3 },
        landedGrossUnitCostDest: 1 };
    };
    const a = tiny("cumulative-a", first, 3);
    const b = tiny("cumulative-b", second, 2);
    const observedSingle = huge - (huge - 0.3);
    const observedTotal = huge - ((huge - 0.3) - 0.3);
    expect(Math.abs(observedSingle - 0.3)).toBeLessThan(config.numeric.quantityEpsilon!);
    expect(Math.abs(observedTotal - 0.6)).toBeGreaterThan(config.numeric.quantityEpsilon!);

    const stock = balances([a, b], huge, 10, 10);
    const originalStock = [...stock.exportableByOriginGood];
    expect(() => reserve([b, a], stock, [second, first]))
      .toThrow(/export stock cumulative reservation lost numeric precision/);
    expect([...stock.exportableByOriginGood]).toEqual(originalStock);

    const demand = balances([a, b], 10, huge, 10);
    const originalDemand = [...demand.importDemandByDestinationGood];
    expect(() => reserve([a, b], demand, [first, second]))
      .toThrow(/import demand cumulative reservation lost numeric precision/);
    expect([...demand.importDemandByDestinationGood]).toEqual(originalDemand);
  });

  it("rejects accumulated precision loss in a shared destination-currency buyer wallet", () => {
    const first = edge(domestic, 100);
    const second = { ...first, linkId: "link:precision-cash-two" as TransportLinkId };
    const baseA = req("cash-a", first, wood, 3);
    const baseB = req("cash-b", second, wood, 2);
    const a = { ...baseA, candidate: { ...baseA.candidate, maximumOwnQuantity: 0.3 },
      landedGrossUnitCostDest: 1 };
    const b = { ...baseB, candidate: { ...baseB.candidate, maximumOwnQuantity: 0.3 },
      landedGrossUnitCostDest: 1 };
    const budget = balances([a, b], 10, 10, 10_000_000);
    const originalCash = [...budget.buyerCashByDestinationCurrency];
    expect(() => reserve([a, b], budget, [first, second]))
      .toThrow(/buyer cash cumulative reservation lost numeric precision/);
    expect([...budget.buyerCashByDestinationCurrency]).toEqual(originalCash);
  });

  it("rejects accumulated cargo-weight loss on one directed link across distinct goods", () => {
    const link = edge(domestic, 10_000_000);
    const baseA = req("cargo-wood", link, wood, 3);
    const baseB = req("cargo-iron", link, iron, 2);
    const a = { ...baseA, candidate: { ...baseA.candidate, maximumOwnQuantity: 0.3 },
      landedGrossUnitCostDest: 1 };
    const b = { ...baseB, candidate: { ...baseB.candidate, maximumOwnQuantity: 0.3 },
      landedGrossUnitCostDest: 1 };
    expect(() => reserve([b, a], balances([a, b], 10, 10, 10), [link]))
      .toThrow(/cargo weight cumulative reservation lost numeric precision/);
    expect(link.seed.baseCapacity).toBe(10_000_000);
  });

  it("rejects accumulated FX liquidity error across distinct cross-currency links", () => {
    const first = edge(foreign, 100);
    const second = { ...first, linkId: "link:precision-fx-two" as TransportLinkId };
    const baseA = req("fx-a", first, wood, 3, { fxPoolPairId: pair });
    const baseB = req("fx-b", second, wood, 2, { fxPoolPairId: pair });
    const a = { ...baseA, candidate: { ...baseA.candidate, maximumOwnQuantity: 0.3,
      sourceSellerNetUnitPrice: 1 }, landedGrossUnitCostDest: 1 };
    const b = { ...baseB, candidate: { ...baseB.candidate, maximumOwnQuantity: 0.3,
      sourceSellerNetUnitPrice: 1 }, landedGrossUnitCostDest: 1 };
    const budget = balances([a, b], 10, 10, 10, 10_000_000);
    const originalFx = [...budget.fxOutputByPairCurrency];
    expect(() => reserve([b, a], budget, [second, first]))
      .toThrow(/FX pool output cumulative reservation lost numeric precision/);
    expect([...budget.fxOutputByPairCurrency]).toEqual(originalFx);
  });

  it("retains valid small fractional reservations, stable order and immutable source budgets", () => {
    const first = edge(domestic, 100);
    const second = { ...first, linkId: "link:precision-small-two" as TransportLinkId };
    const baseA = req("fraction-a", first, wood, 3);
    const baseB = req("fraction-b", second, wood, 2);
    const a = { ...baseA, candidate: { ...baseA.candidate, maximumOwnQuantity: 0.3 },
      landedGrossUnitCostDest: 1 };
    const b = { ...baseB, candidate: { ...baseB.candidate, maximumOwnQuantity: 0.3 },
      landedGrossUnitCostDest: 1 };
    const budget = balances([a, b], 10, 10, 10);
    const before = [...budget.exportableByOriginGood];
    const one = reserve([a, b], budget, [first, second]);
    const other = reserve([b, a], budget, [second, first]);
    expect(one).toEqual(other);
    expect(one.reservations.map((r) => [r.tradePlanId, r.allocatedQuantity, r.refusal]))
      .toEqual([["fraction-a", 0.3, null], ["fraction-b", 0.3, null]]);
    expect(one.remainingExportableByOriginGood.get(
      phase7RegionGoodKey(first.fromRegionId, wood))).toBeCloseTo(9.4, 9);
    expect([...budget.exportableByOriginGood]).toEqual(before);
  });
});

describe("M5 #1204 pre-FX regional demand is not independent route demand", () => {
  const policy = { tradeProfitWeight: 1, shortageWeight: 0, minimumTradeScore: 0,
    maximumShortagePremiumShare: 0 };
  function evidence(request: Phase7AggregateReservationRequest, cap: number,
    reference: number): Phase7CandidateEvidence {
    const c = request.candidate;
    return {
      planId: c.tradePlanId, linkId: c.linkId, originRegionId: c.originRegionId,
      destinationRegionId: c.destinationRegionId, goodId: c.goodId,
      authorizedAtPhase1: true, exportableQuantity: 8, residualImportDemandQuantity: 8,
      buyerRemainingBudgetDest: 100, cargoWeightPerUnit: request.cargoWeightPerUnit,
      destinationReferenceGrossUnitPrice: reference,
      landedGrossUnitCostDest: request.landedGrossUnitCostDest,
      sourceSellerNetUnitPrice: c.sourceSellerNetUnitPrice,
      destinationReferenceNetUnitPrice: reference,
      estimatedTransportUnitCostDest: c.estimatedTransportUnitCostDest,
      estimatedTariffRate: c.estimatedTariffRate,
      estimatedFxInputPerSourceCurrency: c.estimatedFxInputPerSourceCurrency,
      shortageRateDestination: c.shortageRateDestination,
      ...(c.sourceCurrencyId !== c.destinationCurrencyId ? { fxFeasibleQuantity: cap } : {}),
    };
  }
  function preview(requests: readonly Phase7AggregateReservationRequest[],
    quotes: readonly Phase7CandidateEvidence[], budgets: Phase7AggregateBudgets,
    links: readonly TransportLinkState[], eligible = links.map(link => link.linkId),
    actorCeilings?: ReadonlyMap<string, number>) {
    return previewPhase7PreFxRegionalDemand(worldWith(...links), config, quotes, budgets,
      new Map(links.map(link => [link.linkId, 1])), new Set(eligible), policy,
      new Map(requests.flatMap(r => r.fxPoolPairId === undefined ? [] :
        [[r.candidate.tradePlanId, r.fxPoolPairId] as const])), actorCeilings);
  }

  it.each([
    { stock: 9, demand: 9 },
    { stock: 100, demand: 9 },
    { stock: 9, demand: 100 },
  ])("shares export and import residuals across alternate routes (stock=$stock, demand=$demand)", ({ stock, demand }) => {
    const first = edge(foreign);
    const second = { ...first, linkId: "link:pre-fx-alternate" as TransportLinkId };
    const a = req("a", first, wood, 3, { fxPoolPairId: pair });
    const b = req("b", second, wood, 2, { fxPoolPairId: pair });
    for (const fx of [0, 4, 100]) {
      const budgets = balances([a, b], stock, demand, 100, fx);
      const before = JSON.stringify(Object.values(budgets).map(map => [...map]));
      const quotes = Object.freeze([Object.freeze(evidence(a, fx / 2, 10)),
        Object.freeze(evidence(b, fx / 2, 5))]);
      const result = preview([a, b], quotes, budgets, [first, second]);
      expect(result.map(r => [r.tradePlanId, r.desiredRegionalQuantity]))
        .toEqual([["a", 8], ["b", 1]]);
      expect(preview([b, a], [...quotes].reverse(), budgets, [second, first])).toEqual(result);
      expect(result[0]).not.toHaveProperty("allocatedQuantity");
      expect(result[0]).not.toHaveProperty("maximumOwnQuantity");
      expect(result[0]).not.toHaveProperty("fxPoolOutputReservedSource");
      expect(Object.isFrozen(result[0])).toBe(true);
      expect(JSON.stringify(Object.values(budgets).map(map => [...map]))).toBe(before);
      expect(reserve([a, b], budgets, [first, second]).reservations.map(r => r.allocatedQuantity))
        .toEqual(fx === 0 ? [0, 0] : fx === 4 ? [2, 0] : [8, 1]);
    }
  });

  it("shares cargo and cash across different goods and rejects missing FX budgets", () => {
    const link = edge(foreign, 10);
    const a = req("a", link, iron, 3, { fxPoolPairId: pair });
    const b = req("b", link, wood, 2, { fxPoolPairId: pair });
    const quotes = [evidence(a, 0, 10), evidence(b, 0, 5)];
    for (const [cash, expected] of [[100, [8, 2]], [18, [8, 1]]] as const) {
      const budgets = balances([a, b], 100, 100, cash, 0);
      expect(preview([a, b], quotes, budgets, [link]).map(r => r.desiredRegionalQuantity))
        .toEqual(expected);
      expect(() => preview([a, b], quotes,
        { ...budgets, fxOutputByPairCurrency: new Map() }, [link])).toThrow(/FX pool output/);
      expect(preview([a, b], quotes, budgets, [link], [])).toEqual([]);
    }
  });


  it.each([
    { ceiling: 2, expected: [["a", 2], ["b", 6]] },
    { ceiling: 0, expected: [["b", 8]] },
    { ceiling: config.trade.shipmentMinimumQuantity! / 2, expected: [["b", 8]] },
  ])("reclaims shared stock and demand under actor ceiling $ceiling", ({ ceiling, expected }) => {
    const first = edge(foreign);
    const second = { ...first, linkId: "link:actor-ceiling-alternate" as TransportLinkId };
    const a = req("a", first, wood, 3, { fxPoolPairId: pair });
    const b = req("b", second, wood, 2, { fxPoolPairId: pair });
    const quotes = [evidence(a, 0, 10), evidence(b, 0, 5)];
    const budgets = balances([a, b], 8, 8, 100, 0);
    const before = JSON.stringify(Object.values(budgets).map(map => [...map]));
    const limits = new Map([["a", ceiling], ["b", 8]]);
    const links = [first, second];
    const eligible = links.map(link => link.linkId);
    const result = preview([a, b], quotes, budgets, links, eligible, limits);
    expect(result.map(r => [r.tradePlanId, r.desiredRegionalQuantity])).toEqual(expected);
    expect(preview([b, a], [...quotes].reverse(), budgets, [...links].reverse(),
      [...eligible].reverse(), new Map([...limits].reverse()))).toEqual(result);
    expect(preview([a, b], quotes, budgets, links)
      .map(r => [r.tradePlanId, r.desiredRegionalQuantity])).toEqual([["a", 8]]);
    expect(reserve([a, b], budgets, links).reservations.map(r => r.allocatedQuantity)).toEqual([0, 0]);
    expect(JSON.stringify(Object.values(budgets).map(map => [...map]))).toBe(before);
    expect([...limits]).toEqual([["a", ceiling], ["b", 8]]);
  });

  it.each([
    { capacity: 8, cash: 100 },
    { capacity: 100, cash: 16 },
  ])("reclaims shared cargo or cash (capacity=$capacity, cash=$cash)", ({ capacity, cash }) => {
    const link = edge(foreign, capacity);
    const a = req("a", link, iron, 3, { fxPoolPairId: pair });
    const b = req("b", link, wood, 2, { fxPoolPairId: pair });
    const budgets = balances([a, b], 100, 100, cash, 0);
    const quotes = [evidence(a, 0, 10), evidence(b, 0, 5)];
    expect(preview([a, b], quotes, budgets, [link], [link.linkId],
      new Map([["a", 3], ["b", 100]])).map(r => [r.tradePlanId, r.desiredRegionalQuantity]))
      .toEqual([["a", 3], ["b", 5]]);
    expect(preview([a, b], quotes, budgets, [link], [link.linkId],
      new Map([["a", 0], ["b", 100]])).map(r => [r.tradePlanId, r.desiredRegionalQuantity]))
      .toEqual([["b", 8]]);
  });

  it("requires exact ranked-plan coverage and finite nonnegative ceilings", () => {
    const link = edge(foreign);
    const a = req("a", link, wood, 3, { fxPoolPairId: pair });
    const quotes = [evidence(a, 0, 10)];
    const budgets = balances([a], 100, 100, 100, 0);
    const run = (limits: ReadonlyMap<string, number>) =>
      preview([a], quotes, budgets, [link], [link.linkId], limits);
    expect(() => run(new Map())).toThrow(/missing explicit Phase-7 actor ceiling/);
    expect(() => run(new Map([["a", 2], ["unknown", 0]]))).toThrow(/unranked plan/);
    for (const invalid of [-1, NaN, Infinity, -Infinity]) {
      expect(() => run(new Map([["a", invalid]]))).toThrow(/actor quantity ceiling/);
    }
    expect(run(new Map([["a", 100]])).map(r => r.desiredRegionalQuantity)).toEqual([8]);
  });

  it("includes domestic competitors in ranked stock competition but not FX evidence", () => {
    const cross = edge(foreign);
    const source = baseline.regions.get(cross.fromRegionId)!;
    const target = [...baseline.regions.values()].find(region =>
      region.regionId !== source.regionId &&
      region.settlementCurrencyId === source.settlementCurrencyId)!;
    const local = { ...cross, linkId: "link:pre-fx-domestic" as TransportLinkId,
      toRegionId: target.regionId };
    const a = req("domestic", local, wood, 3);
    const b = req("foreign", cross, wood, 2, { fxPoolPairId: pair });
    const budgets = balances([a, b], 9, 100, 100, 0);
    expect(preview([a, b], [evidence(a, 0, 10), evidence(b, 0, 5)], budgets,
      [local, cross]).map(r => [r.tradePlanId, r.desiredRegionalQuantity]))
      .toEqual([["foreign", 1]]);
    expect(preview([b], [evidence(b, 0, 5)], budgets, [cross])
      .map(r => r.desiredRegionalQuantity)).toEqual([8]);
    const quotes = [evidence(a, 0, 10), evidence(b, 0, 5)];
    const eligible = [local.linkId, cross.linkId];
    expect(preview([a, b], quotes, budgets, [local, cross], eligible,
      new Map([["domestic", 2], ["foreign", 8]]))
      .map(r => [r.tradePlanId, r.desiredRegionalQuantity])).toEqual([["foreign", 7]]);
    expect(() => preview([a, b], quotes, budgets, [local, cross], eligible,
      new Map([["foreign", 8]]))).toThrow(/missing explicit Phase-7 actor ceiling/);
  });
});
