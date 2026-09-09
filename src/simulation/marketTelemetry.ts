/**
 * M3 local-market telemetry (REQ-MARKET-005).
 *
 * Emits deterministic market state diagnostics needed for Phase 15 and UI
 * without making telemetry authoritative economic truth.
 *
 * See section 33 of docs/spec/mirror/06 - Handoff/04 — MARKETS_TRADE_FX_CONTRACTS.md
 */

import type { GoodId, MarketId, RegionId } from "../domain/id";
import { assertFiniteCanonicalNumber } from "../domain/numeric";

/**
 * Telemetry for one local market / good / pass combination.
 *
 * Per section 33, the required fields are:
 * - desiredDemandQuantity
 * - effectiveDemandQuantity
 * - offeredQuantity
 * - clearedQuantity
 * - sellerNetPrice
 * - householdGrossPrice reference
 * - unmetDemandQuantity
 * - unsoldOfferQuantity
 * - shortageRate
 * - surplusRate
 * - importDispatchedQuantity (M4+, omit for M3)
 * - importArrivedQuantity (M4+, omit for M3)
 * - exportDispatchedQuantity (M4+, omit for M3)
 * - averageLandedImportCost (M4+, omit for M3)
 * - consumptionTaxCollected
 */
export interface LocalMarketTelemetry {
  readonly marketId: MarketId;
  readonly regionId: RegionId;
  readonly goodId: GoodId;
  readonly pass: "PRE_PRODUCTION" | "MAIN";

  // Demand and supply quantities
  readonly desiredDemandQuantity: number;
  readonly effectiveDemandQuantity: number;
  readonly offeredQuantity: number;
  readonly clearedQuantity: number;

  // Price references
  readonly sellerNetPrice: number;
  readonly householdGrossPrice: number;

  // Unmet/unsold quantities
  readonly unmetDemandQuantity: number;
  readonly unsoldOfferQuantity: number;

  // Shortage/surplus ratios
  readonly shortageRate: number;
  readonly surplusRate: number;

  // Tax collected (M3 scope)
  readonly consumptionTaxCollected: number;

  // M4+ fields (omitted for M3)
  // readonly importDispatchedQuantity: number;
  // readonly importArrivedQuantity: number;
  // readonly exportDispatchedQuantity: number;
  // readonly averageLandedImportCost: number;
}

/**
 * Compute shortage and surplus rates per section 9 formula.
 *
 * shortageRate = effectiveDemandQuantity > quantityEpsilon ? unmetDemandQuantity / effectiveDemandQuantity : 0
 * surplusRate = offeredQuantity > quantityEpsilon ? unsoldOfferQuantity / offeredQuantity : 0
 */
export function computeShortageRate(
  unmetDemandQuantity: number,
  effectiveDemandQuantity: number,
  quantityEpsilon: number = 1e-8,
): number {
  if (effectiveDemandQuantity <= quantityEpsilon) {
    return 0;
  }
  return unmetDemandQuantity / effectiveDemandQuantity;
}

export function computeSurplusRate(
  unsoldOfferQuantity: number,
  offeredQuantity: number,
  quantityEpsilon: number = 1e-8,
): number {
  if (offeredQuantity <= quantityEpsilon) {
    return 0;
  }
  return unsoldOfferQuantity / offeredQuantity;
}

/**
 * Builder for LocalMarketTelemetry, accumulating clearing and settlement data.
 */
export class LocalMarketTelemetryBuilder {
  readonly marketId: MarketId;
  readonly regionId: RegionId;
  readonly goodId: GoodId;
  readonly pass: "PRE_PRODUCTION" | "MAIN";
  readonly quantityEpsilon: number;

  desiredDemandQuantity: number = 0;
  effectiveDemandQuantity: number = 0;
  offeredQuantity: number = 0;
  clearedQuantity: number = 0;
  sellerNetPrice: number = 0;
  householdGrossPrice: number = 0;
  unmetDemandQuantity: number = 0;
  unsoldOfferQuantity: number = 0;
  consumptionTaxCollected: number = 0;

  constructor(
    marketId: MarketId,
    regionId: RegionId,
    goodId: GoodId,
    pass: "PRE_PRODUCTION" | "MAIN",
    quantityEpsilon: number = 1e-9,
  ) {
    this.marketId = marketId;
    this.regionId = regionId;
    this.goodId = goodId;
    this.pass = pass;
    this.quantityEpsilon = quantityEpsilon;
  }

  /**
   * Set quantities from the clearing computation.
   */
  setClearingQuantities(
    desiredDemandQuantity: number,
    effectiveDemandQuantity: number,
    offeredQuantity: number,
    clearedQuantity: number,
  ): void {
    assertFiniteCanonicalNumber(desiredDemandQuantity, "desiredDemandQuantity");
    assertFiniteCanonicalNumber(effectiveDemandQuantity, "effectiveDemandQuantity");
    assertFiniteCanonicalNumber(offeredQuantity, "offeredQuantity");
    assertFiniteCanonicalNumber(clearedQuantity, "clearedQuantity");

    this.desiredDemandQuantity = desiredDemandQuantity;
    this.effectiveDemandQuantity = effectiveDemandQuantity;
    this.offeredQuantity = offeredQuantity;
    this.clearedQuantity = clearedQuantity;

    // Compute unmet/unsold quantities
    this.unmetDemandQuantity = Math.max(0, this.effectiveDemandQuantity - this.clearedQuantity);
    this.unsoldOfferQuantity = Math.max(0, this.offeredQuantity - this.clearedQuantity);
  }

  /**
   * Set price references from market pricing.
   */
  setPrices(sellerNetPrice: number, householdGrossPrice: number): void {
    assertFiniteCanonicalNumber(sellerNetPrice, "sellerNetPrice");
    assertFiniteCanonicalNumber(householdGrossPrice, "householdGrossPrice");

    this.sellerNetPrice = sellerNetPrice;
    this.householdGrossPrice = householdGrossPrice;
  }

  /**
   * Accumulate consumption tax collected (called per settlement transaction).
   */
  addConsumptionTax(taxAmount: number): void {
    assertFiniteCanonicalNumber(taxAmount, "taxAmount");
    this.consumptionTaxCollected += taxAmount;
  }

  /**
   * Build the final LocalMarketTelemetry object.
   */
  build(): LocalMarketTelemetry {
    const shortageRate = computeShortageRate(
      this.unmetDemandQuantity,
      this.effectiveDemandQuantity,
      this.quantityEpsilon,
    );
    const surplusRate = computeSurplusRate(
      this.unsoldOfferQuantity,
      this.offeredQuantity,
      this.quantityEpsilon,
    );

    return {
      marketId: this.marketId,
      regionId: this.regionId,
      goodId: this.goodId,
      pass: this.pass,
      desiredDemandQuantity: this.desiredDemandQuantity,
      effectiveDemandQuantity: this.effectiveDemandQuantity,
      offeredQuantity: this.offeredQuantity,
      clearedQuantity: this.clearedQuantity,
      sellerNetPrice: this.sellerNetPrice,
      householdGrossPrice: this.householdGrossPrice,
      unmetDemandQuantity: this.unmetDemandQuantity,
      unsoldOfferQuantity: this.unsoldOfferQuantity,
      shortageRate,
      surplusRate,
      consumptionTaxCollected: this.consumptionTaxCollected,
    };
  }
}
