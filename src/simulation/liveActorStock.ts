/**
 * Seeds the live actor wallet/inventory endpoints from the opening genesis ledger
 * (Issue #427, prerequisite of REQ-MARKET-005).
 *
 * `WorldGenesisLedger` records the opening stock once and is never rewritten. The live
 * endpoints on `ClanState`, `CohortState`, `ProductionUnitState` and `StateState` start
 * as exactly those opening amounts and are carried forward from there by explicit
 * settlement transitions.
 *
 * The seeding is driven *from* the genesis records rather than re-read from the scenario
 * seeds on purpose. Both halves then address an owner through one mapping — the shared
 * `actorRefKey` in `src/domain/genesisLedger.ts` — so "this cohort's opening stock" and
 * "this cohort's live stock" cannot drift into two conventions that merely agree today
 * (Issue #427 acceptance criterion 5, relocated from Issue #448).
 */

import type { ClanId, CohortId, CurrencyId, GoodId, ProductionUnitId, StateId } from "../domain/id";
import type { GenesisRecord, WorldGenesisLedger } from "../domain/genesisLedger";
import { actorRefKey } from "../domain/genesisLedger";
import type { ClanState, CohortState, ProductionUnitState, StateState } from "./worldState";

/**
 * The mutable registries `buildInitialWorld()` holds while constructing a world. Seeding
 * replaces each entry with a copy carrying its live stock; nothing outside construction
 * mutates these maps.
 */
export interface ActorRegistries {
  readonly clans: Map<ClanId, ClanState>;
  readonly cohorts: Map<CohortId, CohortState>;
  readonly productionUnits: Map<ProductionUnitId, ProductionUnitState>;
  readonly states: Map<StateId, StateState>;
}

/** One live stock bucket being accumulated, keyed by currency or good. */
type Accumulator = Map<string, number>;

function credit(accumulator: Accumulator, key: string, amount: number): void {
  accumulator.set(key, (accumulator.get(key) ?? 0) + amount);
}

/**
 * Which authoritative inventory a GOOD_ENDOWMENT names.
 *
 * A ProductionUnit record always carries its `inventoryBucket`; a Cohort or State record
 * structurally cannot (see the two GOOD_ENDOWMENT members in `genesisLedger.ts`), because
 * each of those owners holds exactly one authoritative goods stock.
 */
function inventorySlotOf(record: Extract<GenesisRecord, { type: "GOOD_ENDOWMENT" }>): string {
  return record.inventoryBucket ?? "SOLE";
}

/**
 * Accumulate the opening money and goods each owner holds, keyed by the canonical owner
 * key. Record types that are not an actor wallet or an actor goods inventory are skipped:
 * CAPITAL_ENDOWMENT is installed capital rather than inventory, POPULATION_ENDOWMENT is
 * people, RESOURCE_ENDOWMENT is an in-ground regional stock with no owner,
 * BOND_OPENING_POSITION is a financial position, and FX_POOL_OPENING is pool reserve cash
 * that Handoff/03 section 20 keeps distinct from every actor wallet.
 */
function accumulateOpeningStocks(ledger: WorldGenesisLedger): {
  money: Map<string, Accumulator>;
  goods: Map<string, Map<string, Accumulator>>;
} {
  const money = new Map<string, Accumulator>();
  const goods = new Map<string, Map<string, Accumulator>>();

  for (const record of ledger.records) {
    if (record.type === "MONEY_ENDOWMENT") {
      const ownerKey = actorRefKey(record.owner);
      let byCurrency = money.get(ownerKey);
      if (!byCurrency) {
        byCurrency = new Map();
        money.set(ownerKey, byCurrency);
      }
      credit(byCurrency, record.currencyId, record.amount);
      continue;
    }

    if (record.type === "GOOD_ENDOWMENT") {
      const ownerKey = actorRefKey(record.owner);
      let bySlot = goods.get(ownerKey);
      if (!bySlot) {
        bySlot = new Map();
        goods.set(ownerKey, bySlot);
      }
      const slot = inventorySlotOf(record);
      let byGood = bySlot.get(slot);
      if (!byGood) {
        byGood = new Map();
        bySlot.set(slot, byGood);
      }
      credit(byGood, record.goodId, record.amount);
    }
  }

  return { money, goods };
}

function walletFor(money: Map<string, Accumulator>, ownerKey: string): ReadonlyMap<CurrencyId, number> {
  return (money.get(ownerKey) ?? new Map()) as ReadonlyMap<CurrencyId, number>;
}

function inventoryFor(
  goods: Map<string, Map<string, Accumulator>>,
  ownerKey: string,
  slot: string,
): ReadonlyMap<GoodId, number> {
  return (goods.get(ownerKey)?.get(slot) ?? new Map()) as ReadonlyMap<GoodId, number>;
}

/**
 * Replace every actor entry with one carrying its live opening stock.
 *
 * `MONETARY_AUTHORITY` money endowments are deliberately left unseeded: no live authority
 * wallet exists in this slice, and HANDOFF-REPAIR-016 scopes the authority owner to
 * genesis accounting only — an authority is never a MarketIntent, MarketAllocation or
 * EconomicTransaction actor, so settlement has no reason to reach one. Settlement refuses
 * an authority endpoint explicitly rather than treating it as an empty wallet.
 */
export function seedLiveActorStocks(ledger: WorldGenesisLedger, registries: ActorRegistries): void {
  const { money, goods } = accumulateOpeningStocks(ledger);

  for (const [clanId, clan] of registries.clans) {
    const ownerKey = actorRefKey({ type: "CLAN", clanId });
    // A Clan owns a treasury and no physical inventory (Handoff/01 5.3/5.4/7).
    registries.clans.set(clanId, { ...clan, treasury: walletFor(money, ownerKey) });
  }

  for (const [cohortId, cohort] of registries.cohorts) {
    const ownerKey = actorRefKey({ type: "COHORT", cohortId });
    registries.cohorts.set(cohortId, {
      ...cohort,
      wallet: walletFor(money, ownerKey),
      householdInventory: inventoryFor(goods, ownerKey, "SOLE"),
    });
  }

  for (const [productionUnitId, unit] of registries.productionUnits) {
    const ownerKey = actorRefKey({ type: "PRODUCTION_UNIT", productionUnitId });
    registries.productionUnits.set(productionUnitId, {
      ...unit,
      wallet: walletFor(money, ownerKey),
      inputInventory: inventoryFor(goods, ownerKey, "INPUT"),
      outputInventory: inventoryFor(goods, ownerKey, "OUTPUT"),
      investmentInventory: inventoryFor(goods, ownerKey, "INVESTMENT"),
    });
  }

  for (const [stateId, state] of registries.states) {
    const ownerKey = actorRefKey({ type: "STATE", stateId });
    registries.states.set(stateId, {
      ...state,
      treasury: walletFor(money, ownerKey),
      publicInventory: inventoryFor(goods, ownerKey, "SOLE"),
    });
  }
}
