/** #1182: non-unit infrastructure must limit real paid gross route weight. */
import { describe, expect, it } from "vitest";
import { createM5PreviewScenario, M5_PREVIEW_TICK } from "../diagnostics/m5PreviewScenario";
import { executeM5AutonomousRegionalTradeTick } from "./m5AutonomousRegionalTradeTick";
import type { PhaseHandler, TickContext } from "./tickOrchestrator";
import type { WorldState } from "./worldState";

const phase1: PhaseHandler = (world, context) => {
  if (context.phase === 1) {
    return { ...context, effectiveJurisdictionByRegion: new Map(
      [...world.regions].map(([id, region]) => [id, region.controllerStateId] as const),
    ) };
  }
  return context.phase === 2
    ? { ...context, householdMarketIntents: [] }
    : context;
};

function paidGrossWeight(opening: WorldState, context: TickContext): number {
  const cargos = context.phase7DispatchedShipments ?? [];
  const sales = context.transactions.filter(tx => tx.phase === 7 && tx.type === "TRADE_GOODS_SALE");
  expect(sales).toHaveLength(cargos.length);
  const ids = new Set<string>();
  let gross = 0;
  for (const cargo of cargos) {
    expect(ids.has(cargo.id)).toBe(false);
    ids.add(cargo.id);
    expect(opening.transportLinks.has(cargo.transportLinkId)).toBe(true);
    expect(cargo.fxSettlementId).not.toBeNull();
    expect(cargo.invoiceCurrencyId).not.toBe(cargo.buyerPaymentCurrencyId);
    const matched = sales.filter(tx => tx.bundleId === "tb:" + cargo.id.slice(3));
    expect(matched).toHaveLength(1);
    const quantity = matched[0]!.quantity!;
    const weight = opening.definitionRegistry.goods[cargo.goodId]!.cargoWeightPerUnit;
    expect(Number.isFinite(quantity) && quantity > 0).toBe(true);
    expect(Number.isFinite(weight) && weight > 0).toBe(true);
    gross += quantity * weight;
  }
  expect(Number.isFinite(gross)).toBe(true);
  return gross;
}

describe("M5 #676 explicit infrastructure capacity", () => {
  it("scales paid gross weight, rejects unscaled evidence, and halts at zero factor", () => {
    const { opening: base, options } = createM5PreviewScenario();
    expect(base.transportLinks.size).toBe(1);
    const [id, link] = [...base.transportLinks][0]!;
    const narrowed = { ...link, seed: { ...link.seed, baseCapacity: 1 } };
    const opening: WorldState = { ...base,
      transportLinks: new Map([[id, narrowed]]) };
    const epsilon = opening.simulationConfig.numeric.quantityEpsilon!;
    const unscaled = narrowed.seed.baseCapacity * narrowed.seed.condition;
    expect(unscaled).toBeGreaterThan(4 * epsilon);

    const run = (factor: number) => executeM5AutonomousRegionalTradeTick(
      opening, M5_PREVIEW_TICK, phase1, (_phase, current) => current,
      { ...options, infrastructureFactors: new Map([[id, factor]]) },
    );
    const assertBound = (context: TickContext, factor: number) => {
      const gross = paidGrossWeight(opening, context);
      expect(gross, "explicit infrastructure capacity").toBeLessThanOrEqual(unscaled * factor + epsilon);
      return gross;
    };

    const full = run(1);
    const half = run(0.5);
    const zero = run(0);
    for (const [factor, result] of [[1, full], [0.5, half], [0, zero]] as const) {
      expect(result.phaseTrace).toEqual([...Array(16).keys()]);
      expect(result.phaseBoundaryError).toBeUndefined();
      expect(result.reconciliationErrors).toBeNull();
      const replay = run(factor);
      expect(replay.world).toEqual(result.world);
      expect(replay.context.transactions).toEqual(result.context.transactions);
    }
    const fullWeight = assertBound(full.context, 1);
    const halfWeight = assertBound(half.context, 0.5);
    expect(halfWeight).toBeGreaterThan(epsilon);
    expect(Math.abs(halfWeight - unscaled * 0.5)).toBeLessThanOrEqual(epsilon);
    expect(fullWeight).toBeGreaterThan(halfWeight + epsilon);
    // Same actual paid evidence: a check omitting the multiplier accepts it,
    // but the independent explicit half-factor bound must reject it.
    expect(fullWeight).toBeLessThanOrEqual(unscaled + epsilon);
    expect(() => assertBound(full.context, 0.5)).toThrow("explicit infrastructure capacity");
    expect(assertBound(zero.context, 0)).toBe(0);
    expect(zero.context.phase7DispatchedShipments ?? []).toHaveLength(0);
    expect(zero.context.transactions.filter(tx => tx.phase === 7 && tx.type === "FX_OUTPUT")).toHaveLength(0);
  });
});
