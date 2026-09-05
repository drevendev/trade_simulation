/**
 * Stable canonical entity registries (REQ-CORE-003).
 *
 * See `docs/spec/mirror/06 - Handoff/11 — REPOSITORY_MIGRATION_AND_MILESTONE_GATES.md`
 * Milestone 1 ("Implement stable registries for Region, State, Currency, Clan,
 * PopulationCohort, ProductionUnit, LocalMarket, TransportLink and definitions,
 * allowing initially empty/non-active subsystems where specified") and
 * `docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md` section 3
 * (`WorldState`'s `Record<Id, State>` registries) and section 5 (per-entity
 * identity/registry ownership rules).
 *
 * This module owns only the registry substrate — ID-keyed, create-once,
 * retrieve-by-ID storage built from a scenario's seed lists — not economic
 * behavior, opening-stock reconciliation (`REQ-CONFIG-004`) or the concrete
 * baseline definition pack / scenario construction (`REQ-CONFIG-003`). Each
 * entry currently carries only its allocated ID plus whatever fields the
 * corresponding `*Seed` type already declares; `ScenarioDefinition`'s seed
 * types are still empty placeholders pending `REQ-CONFIG-003`, so registries
 * built today are legitimately ID-only until that requirement lands.
 */
import type {
  ClanId,
  CohortId,
  CurrencyId,
  IdAllocator,
  MarketId,
  ProductionUnitId,
  RegionId,
  StateId,
  TransportLinkId,
} from "./id";
import type {
  ClanSeed,
  CohortSeed,
  CurrencySeed,
  MarketSeed,
  ProductionUnitSeed,
  RegionSeed,
  ScenarioDefinition,
  StateSeed,
  TransportLinkSeed,
} from "../config/scenarioDefinition";

/** One registry entry: the entity's allocated ID plus its declared seed fields. */
export type RegistryEntry<Id extends string, Seed extends object> = Seed & { readonly id: Id };

/**
 * Builds one ID-keyed registry from a scenario's seed list, in the list's own
 * order. A registry built from an omitted or empty seed list is legitimately
 * empty, not an error — the milestone bullet explicitly allows initially
 * empty/non-active subsystems (for example no `TransportLink` before
 * Milestone 5's transport work).
 *
 * Determinism: this walks `seeds` strictly in array order and allocates
 * exactly one ID per element via `allocate`, so the same scenario fed to a
 * fresh allocator always reproduces the same ID-to-seed mapping — the
 * "repeated genesis with same seed is byte/field-equivalent" Gate M1
 * requirement. `entityKind` only distinguishes creation keys across
 * registries; it does not by itself guarantee cross-registry uniqueness
 * (the `IdAllocator` already scopes creation keys per ID kind).
 */
function buildRegistry<Id extends string, Seed extends object>(
  entityKind: string,
  seeds: readonly Seed[] | undefined,
  allocate: (creationKey: string) => Id,
): ReadonlyMap<Id, RegistryEntry<Id, Seed>> {
  const entries = new Map<Id, RegistryEntry<Id, Seed>>();
  (seeds ?? []).forEach((seed, index) => {
    const id = allocate(`${entityKind}:${index}`);
    entries.set(id, { ...seed, id });
  });
  return entries;
}

/**
 * Stable, ID-keyed canonical world entity registries for exactly the
 * Milestone 1 registries bullet's list: Region, State, Currency, Clan,
 * PopulationCohort, ProductionUnit, LocalMarket, TransportLink.
 */
export interface WorldRegistries {
  readonly regions: ReadonlyMap<RegionId, RegistryEntry<RegionId, RegionSeed>>;
  readonly states: ReadonlyMap<StateId, RegistryEntry<StateId, StateSeed>>;
  readonly currencies: ReadonlyMap<CurrencyId, RegistryEntry<CurrencyId, CurrencySeed>>;
  readonly clans: ReadonlyMap<ClanId, RegistryEntry<ClanId, ClanSeed>>;
  readonly cohorts: ReadonlyMap<CohortId, RegistryEntry<CohortId, CohortSeed>>;
  readonly productionUnits: ReadonlyMap<
    ProductionUnitId,
    RegistryEntry<ProductionUnitId, ProductionUnitSeed>
  >;
  readonly markets: ReadonlyMap<MarketId, RegistryEntry<MarketId, MarketSeed>>;
  readonly transportLinks: ReadonlyMap<
    TransportLinkId,
    RegistryEntry<TransportLinkId, TransportLinkSeed>
  >;
}

/**
 * Builds every Milestone 1 world entity registry from `scenario`'s seed
 * lists, allocating each entity's ID through `allocator`. Contains no
 * economic behavior, opening-stock reconciliation or RNG-driven variation —
 * only identity allocation and ID-keyed storage.
 */
export function buildWorldRegistries(
  scenario: ScenarioDefinition,
  allocator: IdAllocator,
): WorldRegistries {
  return {
    regions: buildRegistry("region", scenario.geography, (key) =>
      allocator.allocate("Region", key),
    ),
    states: buildRegistry("state", scenario.states, (key) => allocator.allocate("State", key)),
    currencies: buildRegistry("currency", scenario.currencies, (key) =>
      allocator.allocate("Currency", key),
    ),
    clans: buildRegistry("clan", scenario.clans, (key) => allocator.allocate("Clan", key)),
    cohorts: buildRegistry("cohort", scenario.cohorts, (key) => allocator.allocate("Cohort", key)),
    productionUnits: buildRegistry("productionUnit", scenario.productionUnits, (key) =>
      allocator.allocate("ProductionUnit", key),
    ),
    markets: buildRegistry("market", scenario.markets, (key) => allocator.allocate("Market", key)),
    transportLinks: buildRegistry("transportLink", scenario.transportLinks, (key) =>
      allocator.allocate("TransportLink", key),
    ),
  };
}
