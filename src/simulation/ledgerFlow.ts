/**
 * Typed ledger/flow records and accounting projection (REQ-CORE-006).
 *
 * Normalized representation of committed stock mutations with tick/phase/reason attribution.
 * Tracks MONEY and GOOD signed deltas plus PHYSICAL_LOSS attribution.
 * Deterministic and independent of unrelated iteration order.
 */

import type { CurrencyId, GoodId, RegionId, StateId, ClanId, ProductionUnitId } from "../domain/id";

/**
 * Owner reference for stock mutations: State, Clan, or ProductionUnit.
 * Transfers normalize to equal-and-opposite deltas; physical loss is attributed.
 */
export type StockOwner =
  | { type: "STATE"; stateId: StateId }
  | { type: "CLAN"; clanId: ClanId }
  | { type: "PRODUCTION_UNIT"; productionUnitId: ProductionUnitId };

/**
 * Money flow record: signed currency delta with owner and reason attribution.
 * Positive = inflow to owner; negative = outflow from owner.
 */
export interface MoneyFlow {
  readonly tick: number;
  readonly phase: number;
  readonly currencyId: CurrencyId;
  readonly owner: StockOwner;
  readonly regionId: RegionId | undefined;
  readonly delta: number;
  readonly reason: string;
  readonly causalLinkage: string | undefined;
}

/**
 * Good flow record: signed quantity delta with owner, location and reason attribution.
 * Positive = inflow to owner; negative = outflow from owner.
 */
export interface GoodFlow {
  readonly tick: number;
  readonly phase: number;
  readonly goodId: GoodId;
  readonly owner: StockOwner;
  readonly regionId: RegionId;
  readonly bucket: string | undefined;
  readonly delta: number;
  readonly reason: string;
  readonly causalLinkage: string | undefined;
}

/**
 * Physical loss record: attributed consumption/spoilage/degradation.
 * Always negative; no balancing goods credit.
 */
export interface PhysicalLoss {
  readonly tick: number;
  readonly phase: number;
  readonly goodId: GoodId;
  readonly regionId: RegionId;
  readonly loss: number;
  readonly reason: string;
  readonly causalLinkage: string | undefined;
}

export type LedgerFlow = MoneyFlow | GoodFlow | PhysicalLoss;

/**
 * Runtime ledger: accumulates flows during a tick.
 * Used for deterministic reconciliation and diagnostics.
 */
export interface RuntimeLedger {
  readonly flows: readonly LedgerFlow[];
}

/**
 * Create an empty runtime ledger.
 */
export function createEmptyRuntimeLedger(): RuntimeLedger {
  return { flows: [] };
}

/**
 * Add a money flow to the ledger.
 */
export function addMoneyFlow(
  ledger: RuntimeLedger,
  flow: MoneyFlow,
): RuntimeLedger {
  return {
    flows: [...ledger.flows, flow],
  };
}

/**
 * Add a good flow to the ledger.
 */
export function addGoodFlow(
  ledger: RuntimeLedger,
  flow: GoodFlow,
): RuntimeLedger {
  return {
    flows: [...ledger.flows, flow],
  };
}

/**
 * Add a physical loss record to the ledger.
 */
export function addPhysicalLoss(
  ledger: RuntimeLedger,
  loss: PhysicalLoss,
): RuntimeLedger {
  return {
    flows: [...ledger.flows, loss],
  };
}

/**
 * Helper to create a MoneyFlow.
 */
export function createMoneyFlow(
  tick: number,
  phase: number,
  currencyId: CurrencyId,
  owner: StockOwner,
  delta: number,
  reason: string,
  regionId?: RegionId,
  causalLinkage?: string,
): MoneyFlow {
  return {
    tick,
    phase,
    currencyId,
    owner,
    regionId,
    delta,
    reason,
    causalLinkage,
  };
}

/**
 * Helper to create a GoodFlow.
 */
export function createGoodFlow(
  tick: number,
  phase: number,
  goodId: GoodId,
  owner: StockOwner,
  regionId: RegionId,
  delta: number,
  reason: string,
  bucket?: string,
  causalLinkage?: string,
): GoodFlow {
  return {
    tick,
    phase,
    goodId,
    owner,
    regionId,
    bucket,
    delta,
    reason,
    causalLinkage,
  };
}

/**
 * Helper to create a PhysicalLoss record.
 */
export function createPhysicalLoss(
  tick: number,
  phase: number,
  goodId: GoodId,
  regionId: RegionId,
  loss: number,
  reason: string,
  causalLinkage?: string,
): PhysicalLoss {
  return {
    tick,
    phase,
    goodId,
    regionId,
    loss,
    reason,
    causalLinkage,
  };
}

/**
 * Verify all flows are finite and normalized.
 */
export function validateLedgerFlow(flow: LedgerFlow): boolean {
  if ("currencyId" in flow) {
    return Number.isFinite((flow as MoneyFlow).delta);
  } else if ("delta" in flow) {
    return Number.isFinite((flow as GoodFlow).delta);
  } else if ("loss" in flow) {
    return Number.isFinite((flow as PhysicalLoss).loss);
  }
  return false;
}
