/**
 * WorldGenesisLedger schema and types (REQ-CONFIG-004 Part 1/4).
 *
 * Records all opening stocks in scenario endowments separately from normal
 * EconomicTransaction history. Prepared for recording and reconciliation in
 * REQ-CONFIG-004 opening-stock reconciliation phase.
 *
 * See section 20 of docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md
 */

import type {
  ClanId,
  CohortId,
  CurrencyId,
  GoodId,
  MonetaryAuthorityId,
  ProductionUnitId,
  RegionId,
  StateId,
} from "./id";

/**
 * Actor reference: Cohort, Clan, State, ProductionUnit, or MonetaryAuthority (owner of opening
 * balances/inventories). Cohort and ProductionUnit wallets/inventories are recorded under the
 * cohort/ProductionUnit itself, never under an equity or institutional owner (Clan/State), to
 * preserve one-stock/one-owner semantics (Handoff/01 section 5.3/5.4/7).
 */
export type ActorRef =
  | { readonly type: "COHORT"; readonly cohortId: CohortId }
  | { readonly type: "CLAN"; readonly clanId: ClanId }
  | { readonly type: "STATE"; readonly stateId: StateId }
  | { readonly type: "PRODUCTION_UNIT"; readonly productionUnitId: ProductionUnitId }
  | { readonly type: "MONETARY_AUTHORITY"; readonly authorityId: MonetaryAuthorityId };

/**
 * The authoritative ProductionUnit inventory that receives an opening goods stock.
 *
 * Handoff/03 section 20 makes the bucket part of canonical stock identity: a
 * ProductionUnit's INPUT, OUTPUT and INVESTMENT inventories are three distinct
 * authoritative stocks, not three provenance labels on one aggregate.
 */
export type InventoryBucket = "INPUT" | "OUTPUT" | "INVESTMENT";

/**
 * Genesis record types explaining opening balance-sheet stocks.
 * Each record type corresponds to a specific category of opening endowment.
 */
export type GenesisRecord =
  | {
      readonly type: "MONEY_ENDOWMENT";
      readonly owner: ActorRef;
      readonly currencyId: CurrencyId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    }
  /**
   * Opening goods inventory.
   *
   * `regionId` is the canonical location of the stock and is part of its identity:
   * section 20 requires reconciliation to compare owner + region + good rather than an
   * owner-wide aggregate, so the same owner's same good in two regions is two stocks.
   * The canonical GenesisRecord declares `regionId?: RegionId`, and a stock whose owner
   * is not region-bound — a State's public inventory, held by the State itself rather
   * than by any one of the regions it controls — leaves it absent rather than naming an
   * arbitrary region.
   *
   * `inventoryBucket` is split across the two members below rather than declared once as
   * optional. Section 20 requires it for a ProductionUnit-owned stock and gives it no
   * meaning for any other owner: a Cohort holds one `householdInventory` and a State one
   * `publicInventory`, neither of which is an INPUT/OUTPUT/INVESTMENT container. Making
   * the distinction structural means a ProductionUnit record cannot omit the bucket and a
   * Cohort or State record cannot carry a fabricated one, both at compile time.
   */
  | {
      readonly type: "GOOD_ENDOWMENT";
      readonly owner: Exclude<ActorRef, { readonly type: "PRODUCTION_UNIT" }>;
      readonly regionId?: RegionId;
      readonly goodId: GoodId;
      readonly amount: number;
      readonly inventoryBucket?: undefined;
      readonly sourceSeedKey: string;
    }
  /**
   * Opening goods inventory held by a ProductionUnit.
   *
   * Section 20: "For a ProductionUnit-owned GOOD_ENDOWMENT, inventoryBucket is required
   * and must be exactly INPUT, OUTPUT, or INVESTMENT according to the authoritative
   * inventory that receives the opening stock. The bucket is part of canonical stock
   * identity: reconciliation must compare ProductionUnit + region + inventoryBucket +
   * goodId, not a ProductionUnit-wide aggregate. sourceSeedKey is provenance only and
   * must never substitute for typed stock identity."
   */
  | {
      readonly type: "GOOD_ENDOWMENT";
      readonly owner: { readonly type: "PRODUCTION_UNIT"; readonly productionUnitId: ProductionUnitId };
      readonly regionId?: RegionId;
      readonly goodId: GoodId;
      readonly amount: number;
      readonly inventoryBucket: InventoryBucket;
      readonly sourceSeedKey: string;
    }
  | {
      readonly type: "POPULATION_ENDOWMENT";
      readonly owner: ActorRef;
      readonly regionId: RegionId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    }
  /**
   * Opening installed capital, recorded per capital good.
   *
   * Section 20 requires opening inventories plus capital-converted goods to match
   * genesis goods after the documented conversion, so `goodId` names the good the
   * recorded capital embodies and `amount` is that good's converted quantity. The
   * canonical GenesisRecord declares `goodId?: GoodId`: capital whose recipe declares
   * no investment good embodies no tradable good and leaves `goodId` absent rather
   * than naming a fabricated one.
   */
  | {
      readonly type: "CAPITAL_ENDOWMENT";
      readonly owner: ActorRef;
      readonly regionId: RegionId;
      readonly goodId?: GoodId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    }
  | {
      readonly type: "RESOURCE_ENDOWMENT";
      readonly regionId: RegionId;
      readonly goodId: GoodId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    }
  | {
      readonly type: "BOND_OPENING_POSITION";
      readonly owner: ActorRef;
      readonly currencyId: CurrencyId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    }
  | {
      readonly type: "FX_POOL_OPENING";
      readonly currencyId: CurrencyId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    };

/**
 * Immutable ledger of opening stocks recorded during world genesis.
 * All records are collected during buildInitialWorld() initialization steps
 * and made available for REQ-CONFIG-004 opening-stock reconciliation.
 */
export interface WorldGenesisLedger {
  readonly records: readonly GenesisRecord[];
}

/**
 * Create an empty genesis ledger (no records).
 * Used at the start of buildInitialWorld() before recording opening stocks.
 */
export function createEmptyWorldGenesisLedger(): WorldGenesisLedger {
  return {
    records: [],
  };
}

/**
 * Add a genesis record to the ledger.
 * Returns a new ledger with the additional record (functional/immutable).
 */
export function addGenesisRecord(ledger: WorldGenesisLedger, record: GenesisRecord): WorldGenesisLedger {
  return {
    records: [...ledger.records, record],
  };
}
