/**
 * Tick-level reconciliation and invariant verification (REQ-CORE-006).
 *
 * Verifies that zero-flow ticks reconcile all tracked stock categories
 * using the resolved SimulationConfig reconciliation tolerance.
 * Exposes deterministic MONEY and GOOD signed deltas plus PHYSICAL_LOSS attribution.
 */

import type { RuntimeLedger, LedgerFlow, MoneyFlow, GoodFlow, PhysicalLoss } from "./ledgerFlow";
import type { SimulationConfig } from "../config/simulationConfig";
import type { CurrencyId, GoodId } from "../domain/id";

export interface ReconciliationResult {
  success: boolean;
  errorMessage?: string;
  unmatched?: UnmatchedDelta;
}

export interface UnmatchedDelta {
  category: "MONEY" | "GOOD";
  key: CurrencyId | GoodId;
  residual: number;
  tolerance: number;
}

/**
 * Type guard for MoneyFlow.
 */
function isMoneyFlow(flow: LedgerFlow): flow is MoneyFlow {
  return "currencyId" in flow;
}

/**
 * Type guard for GoodFlow.
 */
function isGoodFlow(flow: LedgerFlow): flow is GoodFlow {
  return "goodId" in flow && "owner" in flow && "regionId" in flow;
}

/**
 * Type guard for PhysicalLoss.
 */
function isPhysicalLoss(flow: LedgerFlow): flow is PhysicalLoss {
  return "loss" in flow && "goodId" in flow;
}

/**
 * Reconcile flows at tick level: verify conservation within configured tolerance.
 * For zero-flow scenarios (M2 no-op), all flows should sum to zero or be unmatched.
 */
export function reconcileTickFlows(
  ledger: RuntimeLedger,
  config: SimulationConfig,
): ReconciliationResult {
  const tolerance = config.numeric.reconciliationRelativeTolerance ?? 1e-9;

  // Aggregate flows by currency and good
  const moneyNetByFormula = new Map<CurrencyId, number>();
  const goodsNetByFormula = new Map<GoodId, number>();
  let physicalLossTotal = 0;

  ledger.flows.forEach((flow) => {
    if (isMoneyFlow(flow)) {
      const current = moneyNetByFormula.get(flow.currencyId) ?? 0;
      moneyNetByFormula.set(flow.currencyId, current + flow.delta);
    } else if (isGoodFlow(flow)) {
      const current = goodsNetByFormula.get(flow.goodId) ?? 0;
      goodsNetByFormula.set(flow.goodId, current + flow.delta);
    } else if (isPhysicalLoss(flow)) {
      physicalLossTotal += flow.loss;
    }
  });

  // Check each currency for conservation: net should be zero within tolerance
  for (const [currencyId, net] of moneyNetByFormula) {
    if (Math.abs(net) > tolerance) {
      return {
        success: false,
        errorMessage: `Money conservation failed for currency ${currencyId}: net ${net}`,
        unmatched: {
          category: "MONEY",
          key: currencyId,
          residual: net,
          tolerance,
        },
      };
    }
  }

  // Check each good for conservation: net should be zero within tolerance
  for (const [goodId, net] of goodsNetByFormula) {
    if (Math.abs(net) > tolerance) {
      return {
        success: false,
        errorMessage: `Good conservation failed for good ${goodId}: net ${net}`,
        unmatched: {
          category: "GOOD",
          key: goodId,
          residual: net,
          tolerance,
        },
      };
    }
  }

  // Physical loss can be negative but should be deterministic
  if (!Number.isFinite(physicalLossTotal)) {
    return {
      success: false,
      errorMessage: `Physical loss total is non-finite: ${physicalLossTotal}`,
    };
  }

  return { success: true };
}

/**
 * Diagnostic projection: extract flows for a given tick/phase for analytics.
 * Returns deterministic normalized deltas with attribution.
 */
export interface ReconciliationDiagnostics {
  readonly tick: number;
  readonly phase: number;
  readonly moneyFlowsByFormula: Map<CurrencyId, number>;
  readonly goodFlowsByFormula: Map<GoodId, number>;
  readonly physicalLossByFormula: Map<GoodId, number>;
  readonly totalFlows: number;
}

/**
 * Build diagnostic projection from runtime ledger for a specific tick/phase.
 */
export function buildDiagnosticProjection(
  ledger: RuntimeLedger,
  tick: number,
  phase: number,
): ReconciliationDiagnostics {
  const moneyFlowsByFormula = new Map<CurrencyId, number>();
  const goodFlowsByFormula = new Map<GoodId, number>();
  const physicalLossByFormula = new Map<GoodId, number>();

  ledger.flows
    .filter((flow) => flow.tick === tick && flow.phase === phase)
    .forEach((flow) => {
      if (isMoneyFlow(flow)) {
        const current = moneyFlowsByFormula.get(flow.currencyId) ?? 0;
        moneyFlowsByFormula.set(flow.currencyId, current + flow.delta);
      } else if (isGoodFlow(flow)) {
        const current = goodFlowsByFormula.get(flow.goodId) ?? 0;
        goodFlowsByFormula.set(flow.goodId, current + flow.delta);
      } else if (isPhysicalLoss(flow)) {
        const current = physicalLossByFormula.get(flow.goodId) ?? 0;
        physicalLossByFormula.set(flow.goodId, current + flow.loss);
      }
    });

  return {
    tick,
    phase,
    moneyFlowsByFormula,
    goodFlowsByFormula,
    physicalLossByFormula,
    totalFlows: ledger.flows.filter((f) => f.tick === tick && f.phase === phase).length,
  };
}
