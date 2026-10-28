import { describe, expect, it } from "vitest";
import { baselineDefinitionPack } from "../config/fixtures/baselineDefinitionPack";
import { baselineScenario } from "../config/fixtures/baselineScenario";
import { createDefaultSimulationConfig } from "../config/simulationConfig";
import type { ActorRef } from "../domain/genesisLedger";
import { actorRefKey } from "../domain/genesisLedger";
import { quoteFx } from "./fxWorldPoolAuthority";
import { resolveCanonicalFxPool } from "./fxWorldPoolAuthority";
import { readActorWallet } from "./marketSettlementTransition";
import { sumObservableTradeMoneyAmounts } from "./phase7TradeMoneyLegs";
import {
  sizeCrossCurrencyLotBeforeDispatch, type CrossCurrencyLotSizingRequest,
} from "./phase7CrossCurrencyLotSizing";
import { buildInitialWorld, type WorldState } from "./worldState";

const PAIR = "fxpool:currency:alpha-currency:beta";

function fixture(payerCash = 100, reservedOutput = 30): {
  world: WorldState;
  request: CrossCurrencyLotSizingRequest;
} {
  const root = buildInitialWorld(
    baselineScenario, baselineDefinitionPack, createDefaultSimulationConfig(), 47,
  );
  const { pool } = resolveCanonicalFxPool(root, PAIR);
  const origin = [...root.regions.values()].find((region) =>
    region.settlementCurrencyId === pool.baseCurrencyId)!;
  const destination = [...root.regions.values()].find((region) =>
    region.settlementCurrencyId === pool.quoteCurrencyId)!;
  if (!origin || !destination) throw new Error("fixture requires distinct currencies");
  const state = [...root.states.values()][0]!;
  const buyer: ActorRef = { type: "STATE", stateId: state.stateId };
  const world: WorldState = {
    ...root,
    states: new Map(root.states).set(state.stateId, {
      ...state,
      treasury: new Map(state.treasury).set(pool.quoteCurrencyId, payerCash),
    }),
  };
  const reservation = {
    tick: 7,
    requestId: "fx:req:lot-7",
    payerKey: actorRefKey(buyer),
    quote: quoteFx(world, PAIR, pool.quoteCurrencyId, pool.baseCurrencyId,
      reservedOutput, { maxInputAmount: payerCash }),
  };
  const request: CrossCurrencyLotSizingRequest = {
    tick: 7, originRegionId: origin.regionId, destinationRegionId: destination.regionId,
    buyer, pairId: PAIR, plannedQuantity: 2, sellerAvailableQuantity: 10,
    remainingCargoWeight: 10, cargoWeightPerUnit: 1,
    sourceSellerNetUnitPrice: 3, transportFeePerUnitDest: 0.5,
    tariffPerUnitDest: 0.25, consumptionTaxPerUnitDest: 0.25,
    reservation,
  };
  return { world, request };
}

describe("M5 #673 Phase-7 FX lot sizing before any goods movement", () => {
  it("recomputes source invoice and destination fees for a fully funded lot without posting anything", () => {
    const { world, request } = fixture();
    const beforePool = resolveCanonicalFxPool(world, PAIR).pool;
    const beforeCash = readActorWallet(world, request.buyer).get(
      world.regions.get(request.destinationRegionId)!.settlementCurrencyId,
    );
    const result = sizeCrossCurrencyLotBeforeDispatch(world, request)!;
    expect(result.quantity).toBe(2);
    expect(result.sourceInvoiceAmount).toBe(6);
    expect(result.quote.feasibleOutputAmount).toBe(6);
    expect(result.transportFeeAmountDest).toBe(1);
    expect(result.tariffAmountDest).toBe(0.5);
    expect(result.consumptionTaxAmountDest).toBe(0.5);
    expect(result.buyerGrossDebitDest).toBeCloseTo(
      result.destinationGoodsFxInputAmount + 2, 12,
    );
    expect(result.inputCurrencyId).not.toBe(result.outputCurrencyId);
    expect(readActorWallet(world, request.buyer).get(result.inputCurrencyId)).toBe(beforeCash);
    expect(resolveCanonicalFxPool(world, PAIR).pool).toBe(beforePool);
    expect(world.shipments?.size).toBe(0);
  });

  it("shrinks quantity to the reserved FX output before any goods debit", () => {
    const { world, request } = fixture(100, 3);
    const result = sizeCrossCurrencyLotBeforeDispatch(world, request)!;
    expect(result.quantity).toBeLessThan(2);
    expect(result.quantity).toBeGreaterThan(0);
    expect(result.sourceInvoiceAmount).toBeLessThanOrEqual(3);
    expect(result.quote.feasibleOutputAmount).toBe(result.sourceInvoiceAmount);
    expect(world.shipments?.size).toBe(0);
  });

  it("resizes again for fees from the buyer's actual opening wallet, not just FX principal", () => {
    const { world, request } = fixture(5, 30);
    const result = sizeCrossCurrencyLotBeforeDispatch(world, request)!;
    expect(result.quantity).toBeGreaterThan(0);
    expect(result.quantity).toBeLessThan(2);
    expect(result.buyerGrossDebitDest).toBeLessThanOrEqual(5);
    expect(result.sourceInvoiceAmount).toBe(result.quote.feasibleOutputAmount);
    expect(readActorWallet(world, request.buyer).get(result.inputCurrencyId)).toBe(5);
  });

  it("bounds physical stock and cargo without modifying either opening value", () => {
    const { world, request } = fixture();
    const bounded = {
      ...request, sellerAvailableQuantity: 1.5, remainingCargoWeight: 0.5,
    };
    const first = sizeCrossCurrencyLotBeforeDispatch(world, bounded)!;
    const second = sizeCrossCurrencyLotBeforeDispatch(world, bounded)!;
    expect(first).toEqual(second);
    expect(first.quantity).toBe(0.5);
    expect(bounded.remainingCargoWeight).toBe(0.5);
    expect(bounded.sellerAvailableQuantity).toBe(1.5);
  });

  it("returns no-fill when FX reservation cannot fund the minimum shipment", () => {
    const { world, request } = fixture(100, 1e-12);
    expect(sizeCrossCurrencyLotBeforeDispatch(world, request)).toBeNull();
    expect(world.shipments?.size).toBe(0);
  });

  it("refuses another tick or payer for the same reservation", () => {
    const { world, request } = fixture();
    expect(() => sizeCrossCurrencyLotBeforeDispatch(world, {
      ...request, tick: 8,
    })).toThrow(/stale or mismatched/);
    expect(() => sizeCrossCurrencyLotBeforeDispatch(world, {
      ...request, reservation: { ...request.reservation, payerKey: "STATE:imposter" },
    })).toThrow(/stale or mismatched/);
  });

  it("refuses stale spot quotes and cross-currency requests with a same-currency region", () => {
    const { world, request } = fixture();
    const { pool, owningAuthorityId } = resolveCanonicalFxPool(world, PAIR);
    const issuer = world.monetaryAuthorities.get(owningAuthorityId)!;
    const changed: WorldState = {
      ...world,
      monetaryAuthorities: new Map(world.monetaryAuthorities).set(owningAuthorityId, {
        ...issuer, fxPools: new Map(issuer.fxPools).set(PAIR, {
          ...pool, spotRateQuotePerBase: pool.spotRateQuotePerBase * 1.01,
        }),
      }),
    };
    expect(() => sizeCrossCurrencyLotBeforeDispatch(changed, request))
      .toThrow(/stale or mismatched/);
    expect(() => sizeCrossCurrencyLotBeforeDispatch(world, {
      ...request, destinationRegionId: request.originRegionId,
    })).toThrow(/two distinct/);
  });

  it("rejects non-finite fees, invalid FX direction and a zero seller price", () => {
    const { world, request } = fixture();
    expect(() => sizeCrossCurrencyLotBeforeDispatch(world, {
      ...request, tariffPerUnitDest: Number.NaN,
    })).toThrow(/tariffPerUnitDest/);
    expect(() => sizeCrossCurrencyLotBeforeDispatch(world, {
      ...request, sourceSellerNetUnitPrice: 0,
    })).toThrow(/sourceSellerNetUnitPrice/);
    const { pool } = resolveCanonicalFxPool(world, PAIR);
    expect(() => sizeCrossCurrencyLotBeforeDispatch(world, {
      ...request, reservation: {
        ...request.reservation,
        quote: { ...request.reservation.quote, direction: "BASE_TO_QUOTE" },
      },
    })).toThrow(/stale or mismatched/);
    expect(pool.baseCurrencyId).not.toBe(pool.quoteCurrencyId);
  });
  it("conserves the exact sum of named destination charges, including large plus small legs", () => {
    expect(sumObservableTradeMoneyAmounts([1e16, 1, 3], 1e-9)).toBe(1e16 + 4);
    expect(() => sumObservableTradeMoneyAmounts([1e16, 1], 1e-9))
      .toThrow(/cannot be represented/);
  });

});
