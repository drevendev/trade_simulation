/**
 * M5 #669 — pure transport-fee quotation under Handoff/04 §14.
 *
 * Fee currency belongs to the DESTINATION region of the directed link, even
 * when the explicitly configured payee has a different home currency.
 * No ledger posting, shipment creation, FX conversion or receiver inference.
 */
import type { SimulationConfig } from "../config/simulationConfig";
import type { CurrencyId } from "../domain/id";
import { cargoCapacityUse } from "./transportCapacity";
import type { ActorRef, TransportLinkState, WorldState } from "./worldState";

/**
 * Handoff/04 requires an explicit minimum denominator and multiplier cap, but
 * Handoff/03 does not yet assign their baseline config values. Require both
 * from the future fee-policy owner: never silently invent defaults here.
 */
export interface TransportFeeCostPolicy {
  readonly minimumConditionForCost: number;
  readonly maximumConditionCostMultiplier: number;
}

export interface TransportFeeQuote {
  readonly destinationCurrencyId: CurrencyId;
  readonly receiver: ActorRef | null;
  readonly cargoCapacityUsed: number;
  readonly conditionCostMultiplier: number;
  readonly amount: number;
}

function finiteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be non-negative and finite`);
  }
}

/**
 * Return a fee quote, NOT a posted payment. A future atomic Phase-7 bundle
 * must debit the buyer and credit this receiver in this same currency.
 *
 * Requires separate legal/enablement and physical-capacity checks from the
 * shipment planner; this only applies the already configured condition gate.
 */
export function quoteTransportFee(
  world: Pick<WorldState, "regions">,
  link: TransportLinkState,
  quantity: number,
  cargoWeightPerUnit: number,
  config: Pick<SimulationConfig, "trade">,
  costPolicy: TransportFeeCostPolicy,
): TransportFeeQuote {
  const minimumOperatingCondition = config.trade.transportConditionMinimum;
  if (minimumOperatingCondition === undefined ||
      !Number.isFinite(minimumOperatingCondition) ||
      minimumOperatingCondition < 0 || minimumOperatingCondition > 1) {
    throw new Error("TradeConfig.transportConditionMinimum must be resolved in [0,1]");
  }
  const { minimumConditionForCost, maximumConditionCostMultiplier } = costPolicy;
  if (!Number.isFinite(minimumConditionForCost) ||
      minimumConditionForCost <= 0 || minimumConditionForCost > 1) {
    throw new Error("minimumConditionForCost must be finite in (0,1]");
  }
  if (!Number.isFinite(maximumConditionCostMultiplier) ||
      maximumConditionCostMultiplier < 1) {
    throw new Error("maximumConditionCostMultiplier must be finite and >= 1");
  }

  const { condition, baseTransportCost } = link.seed;
  if (!Number.isFinite(condition) || condition < 0 || condition > 1) {
    throw new Error("TransportLink.condition must be finite in [0,1]");
  }
  if (condition < minimumOperatingCondition) {
    throw new Error("transport link is below the operational condition threshold");
  }
  finiteNonnegative(baseTransportCost, "TransportLink.baseTransportCost");

  const destination = world.regions.get(link.toRegionId);
  if (!destination) {
    throw new Error("transport link destination region is missing");
  }
  const cargoCapacityUsed = cargoCapacityUse(quantity, cargoWeightPerUnit);
  const conditionCostMultiplier = Math.min(
    1 / Math.max(condition, minimumConditionForCost),
    maximumConditionCostMultiplier,
  );
  const unadjustedFee = cargoCapacityUsed * baseTransportCost;
  const amount = unadjustedFee * conditionCostMultiplier;
  finiteNonnegative(amount, "transport fee");
  if (cargoCapacityUsed > 0 && baseTransportCost > 0 && amount === 0) {
    throw new Error("positive transport fee is not representable");
  }

  // A positive transport fee is a transfer, never an unowned sink. A zero
  // quote is legal even on the pre-existing scenarios with no fee recipient.
  const receiver = link.feeReceiver ?? null;
  if (amount > 0 && receiver === null) {
    throw new Error("positive transport fee requires an explicit feeReceiver");
  }

  return {
    destinationCurrencyId: destination.settlementCurrencyId,
    receiver,
    cargoCapacityUsed,
    conditionCostMultiplier,
    amount,
  };
}
