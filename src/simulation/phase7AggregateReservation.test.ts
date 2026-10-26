/** M5 #670: shared Phase-7 regional reservations, never canonical settlement. */
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import type { Phase7EligibleTradeCandidate } from "./tradeCandidateSelection";
import {
  phase7FxOutputKey,
  phase7RegionCashKey,
  phase7RegionGoodKey,
  reservePhase7AggregateTrades,
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

  it("rejects invisible arithmetic instead of creating a phantom cash reservation", () => {
    const link = edge(domestic, 100);
    const a = req("a", link, wood, 1);
    expect(() => reserve([a], balances([a], 1, 1, 1e24), [link]))
      .toThrow(/numeric precision/);
  });
});
