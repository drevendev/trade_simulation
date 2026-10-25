/** M5 #669 fee quotes must never create/burn money or infer a recipient. */
import { describe, expect, it } from "vitest";

import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import { buildInitialWorld, type TransportLinkState } from "./worldState";
import { quoteTransportFee, type TransportFeeCostPolicy } from "./transportFeeQuote";

const config = createDefaultSimulationConfig();
const costPolicy: TransportFeeCostPolicy = {
  minimumConditionForCost: 0.1,
  maximumConditionCostMultiplier: 3,
};
const world = buildInitialWorld(baselineScenario, baselineDefinitionPack, config, 7);

function routes(): readonly TransportLinkState[] {
  return [...world.transportLinks.values()].filter((link) => link.seed.key === "link:a4-b4");
}
function linkWith(
  link: TransportLinkState,
  patch: Partial<TransportLinkState["seed"]> = {},
): TransportLinkState {
  return { ...link, seed: { ...link.seed, baseTransportCost: 2, condition: 0.5, ...patch } };
}

describe("M5 destination-currency transport fee quote (#669)", () => {
  it("invoices by cargo weight and direction's destination currency without changing the recipient", () => {
    const [forward, reverse] = routes();
    expect(forward).toBeDefined();
    expect(reverse).toBeDefined();
    const cashBefore = JSON.stringify([...world.states.values()].map((state) => state.seed.treasury));

    const first = quoteTransportFee(world, linkWith(forward!), 3, 2, config, costPolicy);
    const second = quoteTransportFee(world, linkWith(reverse!), 3, 2, config, costPolicy);

    expect(first).toMatchObject({
      cargoCapacityUsed: 6,
      conditionCostMultiplier: 2,
      amount: 24,
    });
    expect(first.amount).toBe(second.amount);
    expect(first.receiver).toEqual(second.receiver);
    expect(first.destinationCurrencyId).not.toBe(second.destinationCurrencyId);
    expect(first.destinationCurrencyId)
      .toBe(world.regions.get(forward!.toRegionId)!.settlementCurrencyId);
    expect(second.destinationCurrencyId)
      .toBe(world.regions.get(reverse!.toRegionId)!.settlementCurrencyId);
    // Quotation cannot debit a payer, credit a State, or create a shipment.
    expect(JSON.stringify([...world.states.values()].map((state) => state.seed.treasury)))
      .toBe(cashBefore);
    expect(world.transportLinks.size).toBeGreaterThan(0);
  });

  it("caps the condition multiplier rather than allowing near-zero route condition to explode fees", () => {
    const [forward] = routes();
    const quote = quoteTransportFee(
      world, linkWith(forward!, { condition: 0.05 }), 3, 2, config, costPolicy,
    );
    expect(quote.conditionCostMultiplier).toBe(3); // uncapped: 10
    expect(quote.amount).toBe(36); // 3 goods * 2 weight * 2 cost * 3 cap

    expect(() => quoteTransportFee(
      world, linkWith(forward!, { condition: 0.049 }), 3, 2, config, costPolicy,
    )).toThrow(/operational/);
    expect(() => quoteTransportFee(
      world, linkWith(forward!, { condition: 0 }), 3, 2, config, costPolicy,
    )).toThrow(/operational/);
  });

  it("rejects positive money with no configured recipient while keeping zero fees legal", () => {
    const [forward] = routes();
    const noReceiver = { ...linkWith(forward!), feeReceiver: null };
    expect(() => quoteTransportFee(world, noReceiver, 2, 1, config, costPolicy))
      .toThrow(/explicit feeReceiver/);
    expect(quoteTransportFee(world, noReceiver, 0, 1, config, costPolicy))
      .toMatchObject({ amount: 0, receiver: null });
    expect(quoteTransportFee(
      world, linkWith(noReceiver, { baseTransportCost: 0 }), 2, 1, config, costPolicy,
    )).toMatchObject({ amount: 0, receiver: null });
  });

  it("rejects invalid arithmetic, unrepresentable fees, and incomplete cost policies", () => {
    const [forward] = routes();
    const link = linkWith(forward!);
    for (const bad of [-1, NaN, Infinity, -Infinity]) {
      expect(() => quoteTransportFee(world, link, bad, 1, config, costPolicy)).toThrow();
    }
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => quoteTransportFee(world, link, 1, bad, config, costPolicy)).toThrow();
    }
    for (const bad of [-1, NaN, Infinity]) {
      expect(() => quoteTransportFee(
        world, linkWith(link, { baseTransportCost: bad }), 1, 1, config, costPolicy,
      )).toThrow();
    }
    expect(() => quoteTransportFee(
      world, link, Number.MAX_VALUE, 2, config, costPolicy,
    )).toThrow();
    expect(() => quoteTransportFee(
      world, linkWith(link, { baseTransportCost: Number.MIN_VALUE }),
      Number.MIN_VALUE, 1, config, costPolicy,
    )).toThrow(/not representable/);
    for (const invalid of [
      { minimumConditionForCost: 0, maximumConditionCostMultiplier: 3 },
      { minimumConditionForCost: 2, maximumConditionCostMultiplier: 3 },
      { minimumConditionForCost: 0.1, maximumConditionCostMultiplier: 0.5 },
      { minimumConditionForCost: NaN, maximumConditionCostMultiplier: 3 },
      { minimumConditionForCost: 0.1, maximumConditionCostMultiplier: Infinity },
    ]) {
      expect(() => quoteTransportFee(world, link, 1, 1, config, invalid)).toThrow();
    }
  });

  it("requires a real destination region and resolved operating threshold", () => {
    const [forward] = routes();
    const link = linkWith(forward!);
    const noDestination = {
      regions: new Map([...world.regions].filter(([id]) => id !== link.toRegionId)),
    };
    expect(() => quoteTransportFee(noDestination, link, 1, 1, config, costPolicy))
      .toThrow(/destination region/);
    const trade = { ...config.trade };
    delete trade.transportConditionMinimum;
    expect(() => quoteTransportFee(world, link, 1, 1, { trade }, costPolicy))
      .toThrow(/transportConditionMinimum/);
  });
});
