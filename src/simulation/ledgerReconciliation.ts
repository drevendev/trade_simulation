/**
 * M2 typed ledger/flow records and phase-level reconciliation (REQ-CORE-006).
 *
 * Implements the normalized accounting projection: MONEY and GOOD signed deltas
 * plus PHYSICAL_LOSS attribution, with deterministic reconciliation and
 * test-only unmatched-delta detection.
 */

import type { CurrencyId, GoodId, RegionId, StateId, ClanId, ProductionUnitId } from "../domain/id";
import type { SimulationConfig } from "../config/simulationConfig";
import { assertFiniteCanonicalNumber } from "../domain/numeric";

/**
 * Authoritative owner/location for a ledger entry.
 * Must uniquely identify where a stock mutation occurs.
 */
export interface StockLocation {
  readonly ownerType: "STATE" | "CLAN" | "PRODUCTION_UNIT" | "MONETARY_AUTHORITY" | "REGION";
  readonly stateId?: StateId;
  readonly clanId?: ClanId;
  readonly productionUnitId?: ProductionUnitId;
  readonly regionId?: RegionId;
  readonly bucket?: string; // inventory bucket name when relevant
}

/**
 * MONEY delta: signed change in authoritative owner's balance in a specific currency.
 */
export interface MoneyFlowRecord {
  readonly type: "MONEY";
  readonly tick: number;
  readonly phase: number;
  readonly currencyId: CurrencyId;
  readonly owner: StockLocation;
  readonly delta: number; // finite signed amount
  readonly reason: string; // stable causal type: "WAGE_PAYMENT", "TAX_COLLECTION", etc
  readonly causalIds?: readonly string[]; // optional trace back to causing events
}

/**
 * GOOD delta: signed change in authoritative owner's inventory of a specific good.
 */
export interface GoodFlowRecord {
  readonly type: "GOOD";
  readonly tick: number;
  readonly phase: number;
  readonly goodId: GoodId;
  readonly owner: StockLocation;
  readonly delta: number; // finite signed quantity
  readonly reason: string; // stable causal type: "PRODUCTION_OUTPUT", "CONSUMPTION", etc
  readonly causalIds?: readonly string[];
}

/**
 * PHYSICAL_LOSS: attributed negative physical delta with no balancing goods credit.
 */
export interface PhysicalLossRecord {
  readonly type: "PHYSICAL_LOSS";
  readonly tick: number;
  readonly phase: number;
  readonly goodId: GoodId;
  readonly owner: StockLocation;
  readonly delta: number; // always non-positive
  readonly reason: string; // loss type: "SPOILAGE", "EVENT_DESTRUCTION", etc
  readonly causalIds?: readonly string[];
}

export type LedgerRecord = MoneyFlowRecord | GoodFlowRecord | PhysicalLossRecord;

export interface ReconciliationFailure {
  readonly category: "MONEY" | "GOOD" | "POPULATION" | "CAPITAL" | "RESOURCE";
  readonly key: string;
  readonly residual: number;
  readonly tolerance: number;
  readonly reason: string;
}

/**
 * Reconcile a tick's ledger entries: verify transfers balance and detect unmatched deltas.
 *
 * Returns null if reconciliation passes; otherwise reports the first failure found.
 * The test-only unmatched-delta injection should create a deliberate imbalance.
 *
 * In zero-flow ticks, equal-and-opposite transfers should reconcile globally
 * per currency/good, regardless of owner/location.
 */
export function reconcileTickLedger(
  records: readonly LedgerRecord[],
  config: SimulationConfig,
): ReconciliationFailure | null {
  const tolerance = config.numeric.reconciliationRelativeTolerance ?? 1e-9;

  // Accumulate deltas and track max magnitudes by currency/good
  const moneyByKey = new Map<CurrencyId, number>();
  const moneyMaxByKey = new Map<CurrencyId, number>();
  const goodsByKey = new Map<GoodId, number>();
  const goodsMaxByKey = new Map<GoodId, number>();

  for (const record of records) {
    assertFiniteCanonicalNumber(record.delta, `LedgerRecord.delta tick=${record.tick} phase=${record.phase}`);

    switch (record.type) {
      case "MONEY": {
        const current = moneyByKey.get(record.currencyId) ?? 0;
        moneyByKey.set(record.currencyId, current + record.delta);
        const max = moneyMaxByKey.get(record.currencyId) ?? 0;
        moneyMaxByKey.set(record.currencyId, Math.max(max, Math.abs(record.delta)));
        break;
      }

      case "GOOD": {
        const current = goodsByKey.get(record.goodId) ?? 0;
        goodsByKey.set(record.goodId, current + record.delta);
        const max = goodsMaxByKey.get(record.goodId) ?? 0;
        goodsMaxByKey.set(record.goodId, Math.max(max, Math.abs(record.delta)));
        break;
      }

      case "PHYSICAL_LOSS": {
        // Physical loss is a single-sided negative delta; no balancing positive
        const current = goodsByKey.get(record.goodId) ?? 0;
        goodsByKey.set(record.goodId, current + record.delta);
        const max = goodsMaxByKey.get(record.goodId) ?? 0;
        goodsMaxByKey.set(record.goodId, Math.max(max, Math.abs(record.delta)));
        break;
      }
    }
  }

  // Check for unmatched deltas: tolerance is relative to the max delta magnitude for that key
  for (const [currencyId, total] of moneyByKey) {
    const maxDelta = moneyMaxByKey.get(currencyId) ?? 0;
    const absTol = Math.max(tolerance * maxDelta, 1e-12);
    if (Math.abs(total) > absTol) {
      return {
        category: "MONEY",
        key: String(currencyId),
        residual: total,
        tolerance: absTol,
        reason: `Unmatched MONEY delta for currency ${currencyId}: ${total}`,
      };
    }
  }

  for (const [goodId, total] of goodsByKey) {
    const maxDelta = goodsMaxByKey.get(goodId) ?? 0;
    const absTol = Math.max(tolerance * maxDelta, 1e-12);
    if (Math.abs(total) > absTol) {
      return {
        category: "GOOD",
        key: String(goodId),
        residual: total,
        tolerance: absTol,
        reason: `Unmatched GOOD delta for good ${goodId}: ${total}`,
      };
    }
  }

  return null; // reconciliation passed
}

/**
 * Construct a deterministic key from a StockLocation for grouping.
 */
function locationKey(loc: StockLocation): string {
  const parts: string[] = [loc.ownerType];
  if (loc.stateId) parts.push(`state:${loc.stateId}`);
  if (loc.clanId) parts.push(`clan:${loc.clanId}`);
  if (loc.productionUnitId) parts.push(`unit:${loc.productionUnitId}`);
  if (loc.regionId) parts.push(`region:${loc.regionId}`);
  if (loc.bucket) parts.push(`bucket:${loc.bucket}`);
  return parts.join("|");
}
