/** Regression for M5 #852 ephemeral shared directed-link capacity preflight. */
import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { GoodId, TransportLinkId } from "../domain/id";
import { planTransportCapacityPreflight, type TransportCapacityRequest } from "./transportCapacityPreflight";
import { buildInitialWorld, type TransportLinkState } from "./worldState";

const config = createDefaultSimulationConfig();
const seededWorld = buildInitialWorld({
  ...baselineScenario,
  transportLinks: [{ ...baselineScenario.transportLinks[0]!, bidirectional: true }],
}, baselineDefinitionPack, config, 77);
const directedLinks = [...seededWorld.transportLinks.values()];
if (directedLinks.length !== 2) throw new Error("test fixture requires two directed edges");
const forward: TransportLinkState = directedLinks[0]!;
const reverse: TransportLinkState = directedLinks[1]!;

function linkWithCapacity(link: TransportLinkState, baseCapacity = 20, condition = 0.5): TransportLinkState {
  return { ...link, seed: { ...link.seed, baseCapacity, condition } };
}

function candidate(
  planId: string,
  link: TransportLinkState,
  goodId: GoodId,
  score: number,
  requestedQuantity: number,
  cargoWeightPerUnit: number,
): TransportCapacityRequest {
  return {
    planId,
    linkId: link.linkId,
    fromRegionId: link.fromRegionId,
    toRegionId: link.toRegionId,
    goodId,
    score,
    requestedQuantity,
    cargoWeightPerUnit,
  };
}

const wood = "good:wood" as GoodId;
const iron = "good:iron" as GoodId;

function preflight(
  requests: readonly TransportCapacityRequest[],
  links: readonly TransportLinkState[] = [linkWithCapacity(forward)],
  eligible: readonly TransportLinkId[] = links.map((l) => l.linkId),
  factors: ReadonlyMap<TransportLinkId, number> = new Map(links.map((l) => [l.linkId, 1])),
) {
  return planTransportCapacityPreflight(
    { transportLinks: new Map(links.map((l) => [l.linkId, l])) },
    config,
    requests,
    factors,
    new Set(eligible),
  );
}

describe("M5 shared directed-link cargo reservation (#852)", () => {
  it("reserves ONE weight-unit budget across different goods in stable score order", () => {
    const first = candidate("high", forward, iron, 5, 3, 2);
    const second = candidate("low", forward, wood, 2, 8, 1);
    const result = preflight([second, first]);
    expect(result.reservations.map((r) => [r.planId, r.reservedQuantity, r.capacityUsed, r.refusal]))
      .toEqual([["high", 3, 6, null], ["low", 4, 4, null]]);
    expect(result.usedByLink.get(forward.linkId)).toBe(10);
    expect(result.remainingByLink.get(forward.linkId)).toBe(0);
    expect([...seededWorld.transportLinks.values()][0]?.seed.baseCapacity)
      .toBe(baselineScenario.transportLinks[0]?.baseCapacity);
  });

  it("does not award additional capacity to a third good after the same edge is exhausted", () => {
    const result = preflight([
      candidate("a", forward, iron, 3, 5, 2),
      candidate("b", forward, wood, 2, 1, 1),
      candidate("c", forward, iron, 1, 1, 1),
    ]);
    expect(result.reservations.map((r) => r.reservedQuantity)).toEqual([5, 0, 0]);
    expect(result.reservations.slice(1).map((r) => r.refusal))
      .toEqual(["CAPACITY_EXHAUSTED", "CAPACITY_EXHAUSTED"]);
  });

  it("keeps independently directed reverse edge budgets separate", () => {
    const a = linkWithCapacity(forward);
    const b = linkWithCapacity(reverse);
    expect(a.fromRegionId).toBe(b.toRegionId);
    expect(a.toRegionId).toBe(b.fromRegionId);
    const result = preflight([
      candidate("a", a, wood, 2, 5, 2),
      candidate("b", b, iron, 2, 5, 2),
    ], [a, b]);
    expect(result.reservations.map((r) => r.reservedQuantity)).toEqual([5, 5]);
    expect(result.usedByLink.get(a.linkId)).toBe(10);
    expect(result.usedByLink.get(b.linkId)).toBe(10);
  });

  it("ignores request order and Map insertion order, ties resolve by good then plan ID", () => {
    const requests = [
      candidate("z", forward, wood, 1, 7, 1),
      candidate("b", forward, iron, 1, 3, 2),
      candidate("a", forward, iron, 1, 3, 2),
    ];
    const x = preflight(requests, [linkWithCapacity(reverse), linkWithCapacity(forward)]);
    const y = preflight([...requests].reverse(), [linkWithCapacity(forward), linkWithCapacity(reverse)]);
    expect(y.reservations).toEqual(x.reservations);
    expect(x.reservations.map((r) => r.planId)).toEqual(["a", "b", "z"]);
    expect(x.reservations.map((r) => r.reservedQuantity)).toEqual([3, 2, 0]);
  });

  it("fails closed when eligibility excludes a link or physical condition/capacity is insufficient", () => {
    const request = candidate("a", forward, wood, 1, 2, 1);
    const disabled = preflight([request], [linkWithCapacity(forward)], []);
    expect(disabled.reservations[0]).toMatchObject({
      reservedQuantity: 0,
      capacityUsed: 0,
      refusal: "LINK_NOT_ELIGIBLE",
    });
    expect(preflight([request], [linkWithCapacity(forward, 20, 0.049)]).reservations[0]?.refusal)
      .toBe("NO_PHYSICAL_CAPACITY");
    expect(preflight([request], [linkWithCapacity(forward, 0, 1)]).reservations[0]?.refusal)
      .toBe("NO_PHYSICAL_CAPACITY");
    expect(() => preflight([request], [linkWithCapacity(forward)], [forward.linkId], new Map()))
      .toThrow(/factor/);
  });

  it("never overbooks floating-point capacity and refuses invisible tiny reservations", () => {
    const edge = linkWithCapacity(forward, 0.3, 1);
    const requests = ["a", "b", "c"].map((id) =>
      candidate(id, edge, wood, 1, 1, 0.1));
    const result = preflight(requests, [edge]);
    expect(result.usedByLink.get(edge.linkId)!).toBeLessThanOrEqual(0.3);
    expect(result.remainingByLink.get(edge.linkId)!).toBeGreaterThanOrEqual(0);
    for (const r of result.reservations) {
      expect(r.capacityUsed).toBeLessThanOrEqual(r.requestedQuantity * 0.1);
    }
    const huge = linkWithCapacity(forward, 1e24, 1);
    expect(() => preflight([candidate("tiny", huge, wood, 1, 1, 1)], [huge]))
      .toThrow(/precision/);
  });

  it("refuses phantom cargo debit from mixed-magnitude lots in BOTH score orders (#871)", () => {
    const edge = linkWithCapacity(forward, 10_000_000_000_001_000, 1);
    const huge = candidate("huge", edge, wood, 2, 10_000_000_000_000_000, 1);
    const small = candidate("small", edge, iron, 1, 3, 1);
    // BigInt witnesses the exact SUM OF INDIVIDUAL INTEGER LOTS. A Number
    // reduce would round 1e16 + 3 to 1e16 + 4 and hide the regression.
    const trueTotal = BigInt(huge.requestedQuantity) + BigInt(small.requestedQuantity);
    expect(trueTotal).toBe(10_000_000_000_000_003n);
    expect(BigInt(10_000_000_000_000_004)).not.toBe(trueTotal);

    for (const lots of [
      [huge, small], [small, huge], [{ ...small, score: 3 }, huge],
    ]) {
      expect(() => preflight(lots, [edge])).toThrow(/precision/);
    }
    // Even one 3-unit debit cannot round its residual to a 4-unit debit.
    expect(() => preflight([small], [edge])).toThrow(/precision/);

    function expectExactAcceptedIntegers(
      lots: readonly TransportCapacityRequest[], link: TransportLinkState,
    ): void {
      const result = preflight(lots, [link]);
      expect(result.reservations.every((r) => r.refusal === null)).toBe(true);
      const exactAccepted = result.reservations.reduce(
        (total, r) => total + BigInt(r.capacityUsed), 0n,
      );
      expect(BigInt(result.usedByLink.get(link.linkId)!)).toBe(exactAccepted);
      expect(BigInt(result.remainingByLink.get(link.linkId)!))
        .toBe(BigInt(link.seed.baseCapacity) - exactAccepted);
    }

    // Positive control: 1e16 + 4 IS binary64-representable at this scale.
    const representable = { ...small, requestedQuantity: 4 };
    expectExactAcceptedIntegers([huge, representable], edge);
    expectExactAcceptedIntegers([{ ...representable, score: 3 }, huge], edge);

    // Positive control: both 1e12 and the additional 3 fit precisely.
    const smaller = linkWithCapacity(forward, 1_000_000_001_000, 1);
    expectExactAcceptedIntegers([
      candidate("large", smaller, wood, 2, 1_000_000_000_000, 1),
      candidate("small", smaller, iron, 1, 3, 1),
    ], smaller);
  });

  it("reconciles fractional cargo lots against one high-capacity link without lost debits (#866)", () => {
    const link = linkWithCapacity(forward, 100_000_000, 1);
    const requests = Array.from({ length: 200 }, (_, i) =>
      candidate(`fraction-${i.toString().padStart(3, "0")}`, link, wood, 200 - i, 1, 0.1));
    const result = preflight(requests, [link]);
    expect(result.reservations).toHaveLength(200);
    expect(result.reservations.every((r) => r.refusal === null && r.reservedQuantity === 1))
      .toBe(true);

    const acceptedLots = result.reservations.reduce((sum, r) => sum + r.capacityUsed, 0);
    const booked = result.usedByLink.get(link.linkId)!;
    // The old repeatedly-decremented-budget implementation reports
    // 19.999998807907104 rather than 20 here, exceeding the existing epsilon.
    expect(Math.abs(acceptedLots - booked)).toBeLessThanOrEqual(config.numeric.quantityEpsilon!);
    expect(booked).toBe(20);
    expect(result.remainingByLink.get(link.linkId)).toBe(link.seed.baseCapacity - booked);
    expect(booked + result.remainingByLink.get(link.linkId)!).toBe(link.seed.baseCapacity);
    expect(preflight([...requests].reverse(), [link])).toEqual(result);

    // Integral usage is the positive control: it should not be rejected merely
    // because the starting budget is large.
    const integral = preflight(requests.map((r) => ({ ...r, cargoWeightPerUnit: 1 })), [link]);
    expect(integral.reservations.every((r) => r.refusal === null)).toBe(true);
    expect(integral.usedByLink.get(link.linkId)).toBe(200);
    expect(integral.remainingByLink.get(link.linkId)).toBe(99_999_800);
  });

  it("rejects invalid ID/score/quantity/cargo arithmetic and cannot expose a partial plan", () => {
    const good = candidate("ok", forward, wood, 1, 2, 1);
    const bad: TransportCapacityRequest[] = [
      { ...good, planId: " " },
      { ...good, score: Number.NaN },
      { ...good, score: Infinity },
      { ...good, requestedQuantity: 0 },
      { ...good, requestedQuantity: -2 },
      { ...good, requestedQuantity: Number.MAX_VALUE, cargoWeightPerUnit: 2 },
      { ...good, cargoWeightPerUnit: 0 },
      { ...good, cargoWeightPerUnit: Infinity },
      { ...good, requestedQuantity: Number.MIN_VALUE, cargoWeightPerUnit: Number.MIN_VALUE },
      { ...good, fromRegionId: reverse.fromRegionId },
      { ...good, linkId: "link:does-not-exist" as TransportLinkId },
    ];
    for (const [index, value] of bad.entries()) {
      // A duplicate planId would also throw, masking the intended negative
      // controls. Give each malformed candidate a distinct ID except blank ID.
      const invalid = value.planId.trim().length === 0
        ? value
        : { ...value, planId: `invalid-${index}` };
      expect(() => preflight([good, invalid])).toThrow();
    }
    expect(() => preflight([good, { ...good, planId: good.planId }])).toThrow(/planId/);
    expect(() => preflight([good], [linkWithCapacity(forward)], [forward.linkId], new Map()))
      .toThrow(/factor/);
    expect(() => preflight([good], [linkWithCapacity(forward, Number.MAX_VALUE, 1)],
      [forward.linkId], new Map([[forward.linkId, 2]]))).toThrow();
  });
});
