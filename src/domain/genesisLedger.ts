/**
 * WorldGenesisLedger schema and types (REQ-CONFIG-004 Part 1/4).
 *
 * Records all opening stocks in scenario endowments separately from normal
 * EconomicTransaction history. Prepared for recording and reconciliation in
 * REQ-CONFIG-004 opening-stock reconciliation phase.
 *
 * See section 20 of docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md
 */

import type { ClanId, CurrencyId, GoodId, RegionId, StateId } from "./id";

/**
 * Actor reference: either a Clan or a State (owner of opening balances/inventories).
 */
export type ActorRef = { readonly type: "CLAN"; readonly clanId: ClanId } | { readonly type: "STATE"; readonly stateId: StateId };

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
  | {
      readonly type: "GOOD_ENDOWMENT";
      readonly owner: ActorRef;
      readonly regionId: RegionId;
      readonly goodId: GoodId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    }
  | {
      readonly type: "POPULATION_ENDOWMENT";
      readonly owner: ActorRef;
      readonly regionId: RegionId;
      readonly amount: number;
      readonly sourceSeedKey: string;
    }
  | {
      readonly type: "CAPITAL_ENDOWMENT";
      readonly owner: ActorRef;
      readonly regionId: RegionId;
      readonly goodId: GoodId;
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
