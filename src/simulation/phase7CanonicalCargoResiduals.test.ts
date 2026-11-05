import { describe, expect, it } from "vitest";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ShipmentId, TransportLinkId } from "../domain/id";
import { buildInitialWorld, type WorldState } from "./worldState";
import { createTransactionId, type TickContext } from "./tickOrchestrator";
import type { TradeShipmentState } from "./tradeShipmentState";
import { effectiveTransportLinkCapacity } from "./transportCapacity";
import { derivePhase7CanonicalCargoResiduals } from "./phase7CanonicalCargoResiduals";

function fixture() {
  const world = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 91,
  );
  const links = [...world.transportLinks.values()]
    .filter(link => link.seed.baseCapacity > 0 && link.seed.condition > 0)
    .sort((a, b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);
  if (links.length < 2) throw new Error("baseline needs two physical links");
  const first = links[0]!;
  const second = links[1]!;
  const factors = new Map<TransportLinkId, number>([
    [first.linkId, 1], [second.linkId, 0.5],
  ]);
  const context = {
    tick: 7, phase: 7,
    transactions: [],
  } as Pick<TickContext, "tick" | "phase" | "transactions">;
  const eligible = new Set<TransportLinkId>([second.linkId, first.linkId]);
  const derive = (
    current: Pick<WorldState, "transportLinks" | "shipments"> = world,
    ctx: Pick<TickContext, "tick" | "phase" | "transactions"> = context,
  ) => derivePhase7CanonicalCargoResiduals(current, ctx, factors, eligible);
  return { world, first, second, factors, context, eligible, derive };
}

describe("M5 #673 canonical cargo residual provenance", () => {
  it("derives only eligible physical budgets deterministically and without world mutation", () => {
    const f = fixture();
    const before = f.world.shipments;
    const output = f.derive();
    expect([...output.keys()]).toEqual(
      [f.first.linkId, f.second.linkId].sort(),
    );
    for (const link of [f.first, f.second]) {
      expect(output.get(link.linkId)).toBe(
        effectiveTransportLinkCapacity(link, f.factors.get(link.linkId)!),
      );
    }
    const reverse = derivePhase7CanonicalCargoResiduals(
      f.world, f.context, new Map([...f.factors].reverse()),
      new Set([...f.eligible].reverse()),
    );
    expect([...reverse]).toEqual([...output]);
    expect(f.world.shipments).toBe(before);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("fails closed on a prior same-tick dispatch, including a delivered zero-travel shipment", () => {
    const f = fixture();
    const dispatched = {
      tick: 7, phase: 7, type: "SHIPMENT_DISPATCH",
      transactionId: createTransactionId("tx:already-dispatched"),
      amount: 1,
    };
    expect(() => f.derive(f.world, { ...f.context, transactions: [dispatched] }))
      .toThrow("earlier same-tick dispatch capacity use");
    // Even a caller omitting that transaction cannot hide persistent earlier
    // shipments; surviving quantity does not prove original booked cargo.
    const already = {
      departureTick: 7, transportLinkId: f.first.linkId, quantity: 0.9,
    } as TradeShipmentState;
    const loaded: WorldState = {
      ...f.world,
      shipments: new Map([
        ["sh:earlier" as ShipmentId, already],
      ]),
    };
    expect(() => f.derive(loaded)).toThrow("earlier same-tick shipment capacity use");
    expect(f.world.shipments?.size).toBe(0);
  });

  it("refuses stale or future journal provenance before inferring fresh cargo", () => {
    const f = fixture();
    const prior = {
      tick: 7, phase: 5, type: "OTHER_ECONOMIC_RECEIPT",
      transactionId: createTransactionId("tx:phase7:cargo:prior"), amount: 1,
    };
    const current = { ...f.context, transactions: [prior] };
    expect([...f.derive(f.world, current)]).toEqual([...f.derive()]);
    // Previously a historical/future SHIPMENT_DISPATCH with a mismatched
    // tick bypassed the dispatch guard and falsely granted full capacity.
    const olderDispatch = { ...prior, tick: 6, phase: 7,
      type: "SHIPMENT_DISPATCH" };
    for (const wrong of [
      olderDispatch,
      { ...olderDispatch, tick: 8 },
      { ...prior, tick: 6 },
      { ...prior, phase: 8 },
      { ...prior, phase: -1 },
      { ...prior, phase: 7.5 },
    ]) {
      expect(() => f.derive(f.world, {
        ...f.context, transactions: [wrong],
      })).toThrow("current-tick chronological journal evidence");
    }
    // The canonical actual current-tick dispatch is separately refused,
    // including after legitimate earlier-phase receipts.
    expect(() => f.derive(f.world, {
      ...f.context, transactions: [prior, { ...olderDispatch, tick: 7 }],
    })).toThrow("earlier same-tick dispatch capacity use");
    expect(f.world.shipments?.size).toBe(0);
    expect(f.world.transportLinks).toBe(f.world.transportLinks);
    expect(f.context.transactions).toEqual([]);
  });

  it("rejects impossible shipment departure clocks but permits past in-transit cargo", () => {
    const f = fixture();
    for (const departureTick of [-1, 7.5, 8, Number.NaN, Number.POSITIVE_INFINITY]) {
      const shipment = {
        departureTick, transportLinkId: f.first.linkId, quantity: 0.9,
      } as TradeShipmentState;
      const invalid: WorldState = {
        ...f.world,
        shipments: new Map<ShipmentId, TradeShipmentState>([
          ["sh:invalid-departure" as ShipmentId, shipment],
        ]),
      };
      expect(() => f.derive(invalid))
        .toThrow("invalid or future shipment departure tick");
    }
    const earlier = {
      departureTick: 6, transportLinkId: f.first.linkId, quantity: 0.9,
    } as TradeShipmentState;
    const past: WorldState = {
      ...f.world,
      shipments: new Map<ShipmentId, TradeShipmentState>([
        ["sh:previous-tick" as ShipmentId, earlier],
      ]),
    };
    expect([...f.derive(past)]).toEqual([...f.derive()]);
    expect(f.world.shipments?.size).toBe(0);
  });

  it("rejects missing authority and malformed evidence rather than inventing capacity", () => {
    const f = fixture();
    const { shipments: _omitted, ...withoutShipmentRegistry } = f.world;
    expect(() => f.derive(withoutShipmentRegistry))
      .toThrow("persistent shipment registry");
    expect(() => f.derive(f.world, { ...f.context, phase: 6 }))
      .toThrow("live current-tick");
    expect(() => derivePhase7CanonicalCargoResiduals(
      f.world, f.context, new Map(), f.eligible,
    )).toThrow("missing directed link");
    expect(() => derivePhase7CanonicalCargoResiduals(
      f.world, f.context, new Map([[f.first.linkId, Number.POSITIVE_INFINITY],
        [f.second.linkId, 1]]), f.eligible,
    )).toThrow("finite");
    expect(() => derivePhase7CanonicalCargoResiduals(
      f.world, f.context, f.factors,
      new Set(["tl:does-not-exist" as TransportLinkId]),
    )).toThrow("missing directed link");
    expect(f.world.shipments?.size).toBe(0);
  });
});
