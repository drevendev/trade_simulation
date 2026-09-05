/**
 * WorldGenesisLedger: opening-stock accounting and reconciliation (REQ-CONFIG-004).
 *
 * Records all initial capital endowments, money stocks, goods and population
 * during world construction so that opening balances can be reconciled against
 * the constructed WorldState.
 */

import type { ClanId, CohortId, CurrencyId, GoodId, MonetaryAuthorityId, StateId } from "./id";

/**
 * Discriminated union identifying an actor holding opening stocks.
 * State, Clan, Cohort or MonetaryAuthority are the only stock owners at genesis.
 */
export type ActorRef =
  | { type: "State"; stateId: StateId }
  | { type: "Clan"; clanId: ClanId }
  | { type: "Cohort"; cohortId: CohortId }
  | { type: "MonetaryAuthority"; authorityId: MonetaryAuthorityId };

/**
 * Genesis record type: one opening-stock entry tagged by what was endowed.
 * Records are immutable and append-only; reconciliation consumes the complete log.
 */
export type GenesisRecord =
  | {
      type: "MONEY_ENDOWMENT";
      owner: ActorRef;
      currencyId: CurrencyId;
      amount: number;
      sourceSeedKey: string;
    }
  | {
      type: "GOOD_ENDOWMENT";
      owner: ActorRef;
      goodId: GoodId;
      amount: number;
      sourceSeedKey: string;
    }
  | {
      type: "POPULATION_ENDOWMENT";
      owner: ActorRef;
      amount: number;
      sourceSeedKey: string;
    }
  | {
      type: "CAPITAL_ENDOWMENT";
      owner: ActorRef;
      goodId: GoodId;
      amount: number;
      sourceSeedKey: string;
    }
  | {
      type: "RESOURCE_ENDOWMENT";
      resourceId: string;
      amount: number;
      sourceSeedKey: string;
    }
  | {
      type: "BOND_OPENING_POSITION";
      owner: ActorRef;
      currencyId: CurrencyId;
      amount: number;
      sourceSeedKey: string;
    }
  | {
      type: "FX_POOL_OPENING";
      currencyId: CurrencyId;
      amount: number;
      sourceSeedKey: string;
    };

/**
 * Immutable opening-stock ledger: complete recording of genesis endowments.
 * Reconciliation consumes this log to verify conservation within canonical tolerance.
 */
export interface WorldGenesisLedger {
  readonly records: readonly GenesisRecord[];
}

/**
 * Create an empty ledger at the start of buildInitialWorld.
 */
export function createEmptyWorldGenesisLedger(): WorldGenesisLedger {
  return { records: [] };
}

/**
 * Append one genesis record to the ledger (immutable; returns new ledger).
 */
export function addGenesisRecord(
  ledger: WorldGenesisLedger,
  record: GenesisRecord,
): WorldGenesisLedger {
  return {
    records: [...ledger.records, record],
  };
}
