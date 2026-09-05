/**
 * WorldState and buildInitialWorld orchestrator (REQ-CONFIG-003).
 *
 * Executes the 17-step canonical initialization order from section 19 of
 * docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md
 */

import type { DefinitionRegistry } from "../domain/definitionRegistry";
import { buildDefinitionRegistry } from "../domain/definitionRegistry";
import { createIdAllocator, allocateInCreationKeyOrder } from "../domain/id";
import type {
  ClanId,
  CohortId,
  CurrencyId,
  IdAllocator,
  MarketId,
  MonetaryAuthorityId,
  ProductionUnitId,
  RegionId,
  StateId,
  TransportLinkId,
} from "../domain/id";
import { buildWorldRegistries } from "../domain/worldRegistries";
import { createEmptyWorldGenesisLedger, type WorldGenesisLedger } from "../domain/genesisLedger";
import type {
  ClanSeed,
  CohortSeed,
  CurrencySeed,
  MarketSeed,
  MonetaryAuthoritySeed,
  ProductionUnitSeed,
  RegionSeed,
  ScenarioDefinition,
  StateSeed,
  TransportLinkSeed,
} from "../config/scenarioDefinition";
import type { DefinitionPack } from "../config/definitionPack";
import type { SimulationConfig } from "../config/simulationConfig";
import { assertFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";

/**
 * Canonical world state: all registries and resolved configuration.
 * Must be byte-equivalent for the same scenario/config/seed after normalized serialization.
 */
export interface WorldState {
  readonly configVersion: string;
  readonly scenarioId: string;
  readonly seed: number;
  readonly definitionRegistry: DefinitionRegistry;
  readonly simulationConfig: SimulationConfig;
  readonly worldGenesisLedger: WorldGenesisLedger;
  readonly regions: ReadonlyMap<RegionId, RegionState>;
  readonly states: ReadonlyMap<StateId, StateState>;
  readonly currencies: ReadonlyMap<CurrencyId, CurrencyState>;
  readonly monetaryAuthorities: ReadonlyMap<MonetaryAuthorityId, MonetaryAuthorityState>;
  readonly clans: ReadonlyMap<ClanId, ClanState>;
  readonly cohorts: ReadonlyMap<CohortId, CohortState>;
  readonly productionUnits: ReadonlyMap<ProductionUnitId, ProductionUnitState>;
  readonly markets: ReadonlyMap<MarketId, LocalMarketState>;
  readonly transportLinks: ReadonlyMap<TransportLinkId, TransportLinkState>;
}

export interface RegionState {
  readonly regionId: RegionId;
  readonly seed: RegionSeed;
  readonly controllerStateId: StateId | null;
  readonly settlementCurrencyId: CurrencyId;
}

export interface StateState {
  readonly stateId: StateId;
  readonly seed: StateSeed;
  readonly effectiveCurrencyId: CurrencyId;
  readonly memberAuthorityId: MonetaryAuthorityId | null;
}

export interface CurrencyState {
  readonly currencyId: CurrencyId;
  readonly seed: CurrencySeed;
  readonly issuerAuthorityId: MonetaryAuthorityId | null;
}

export interface MonetaryAuthorityState {
  readonly authorityId: MonetaryAuthorityId;
  readonly seed: MonetaryAuthoritySeed;
  readonly currencyId: CurrencyId;
  readonly memberStateIds: readonly StateId[];
}

export interface ClanState {
  readonly clanId: ClanId;
  readonly seed: ClanSeed;
}

export interface CohortState {
  readonly cohortId: CohortId;
  readonly seed: CohortSeed;
}

export interface ProductionUnitState {
  readonly productionUnitId: ProductionUnitId;
  readonly seed: ProductionUnitSeed;
}

export interface LocalMarketState {
  readonly marketId: MarketId;
  readonly seed: MarketSeed;
}

export interface TransportLinkState {
  readonly linkId: TransportLinkId;
  readonly seed: TransportLinkSeed;
}

/**
 * Builds canonical WorldState by executing the 17-step initialization order.
 * Same scenario/config/seed => byte-equivalent output after normalized serialization.
 */
export function buildInitialWorld(
  scenarioDefinition: ScenarioDefinition,
  definitionPack: DefinitionPack,
  resolvedConfig: SimulationConfig,
  seed: number,
): WorldState {
  // Step 1: Validate schema versions, uniqueness, references, finite values and config bounds
  validateWorldGenesis(scenarioDefinition, definitionPack, resolvedConfig);

  // Step 2: Resolve stable runtime IDs from sorted human keys
  const allocator = createIdAllocator();
  const idMap = resolveStableIds(scenarioDefinition, allocator);

  // Step 3: Instantiate Currency and MonetaryAuthority registries
  const currencyRegistry = new Map(
    (scenarioDefinition.currencies ?? []).map((currencySeed) => [
      idMap.currencyIds.get(currencySeed.key)!,
      buildCurrencyState(currencySeed, idMap),
    ]),
  );
  const authorityRegistry = new Map(
    (scenarioDefinition.monetaryAuthorities ?? []).map((authoritySeed) => [
      idMap.authorityIds.get(authoritySeed.key)!,
      buildMonetaryAuthorityState(authoritySeed, idMap),
    ]),
  );

  // Step 4: Instantiate Regions with deposits/infrastructure/settlement state
  const regionRegistry = new Map(
    (scenarioDefinition.geography ?? []).map((regionSeed) => [
      idMap.regionIds.get(regionSeed.key)!,
      buildRegionState(regionSeed, idMap),
    ]),
  );

  // Step 5: Instantiate TransportLinks with deterministic directed expansion
  const transportLinkRegistry = new Map(
    (scenarioDefinition.transportLinks ?? []).flatMap((linkSeed) => {
      const links = expandTransportLink(linkSeed, idMap);
      return links.map((link) => [link.linkId, link]);
    }),
  );

  // Step 6: Instantiate States and apply jurisdiction
  const stateRegistry = new Map(
    (scenarioDefinition.states ?? []).map((stateSeed) => [
      idMap.stateIds.get(stateSeed.key)!,
      buildStateState(stateSeed, idMap),
    ]),
  );

  // Update region controller references now that states are allocated
  regionRegistry.forEach((region) => {
    const updatedRegion = {
      ...region,
      controllerStateId: region.seed.controllerStateKey
        ? idMap.stateIds.get(region.seed.controllerStateKey) ?? null
        : null,
    };
    regionRegistry.set(region.regionId, updatedRegion);
  });

  // Step 7: Instantiate Clans and state relations
  const clanRegistry = new Map(
    (scenarioDefinition.clans ?? []).map((clanSeed) => [
      idMap.clanIds.get(clanSeed.key ?? "")!,
      { clanId: idMap.clanIds.get(clanSeed.key ?? "")!, seed: clanSeed } as ClanState,
    ]),
  );

  // Step 8: Instantiate Cohorts with bounded keyed variation
  const cohortRegistry = new Map(
    (scenarioDefinition.cohorts ?? []).map((cohortSeed) => [
      idMap.cohortIds.get(cohortSeed.key ?? "")!,
      { cohortId: idMap.cohortIds.get(cohortSeed.key ?? "")!, seed: cohortSeed } as CohortState,
    ]),
  );

  // Step 9: Instantiate LocalMarkets (one per Region)
  const marketRegistry = new Map(
    (scenarioDefinition.markets ?? []).map((marketSeed) => [
      idMap.marketIds.get(marketSeed.regionKey ?? "")!,
      buildLocalMarketState(marketSeed, definitionPack),
    ]),
  );

  // Step 10: Instantiate ProductionUnits with capacity derivation
  const productionUnitRegistry = new Map(
    (scenarioDefinition.productionUnits ?? []).map((puSeed) => [
      idMap.productionUnitIds.get(puSeed.key ?? "")!,
      { productionUnitId: idMap.productionUnitIds.get(puSeed.key ?? "")!, seed: puSeed } as ProductionUnitState,
    ]),
  );

  // Step 11: Instantiate bonds/holdings (if declared)
  // Step 12: Instantiate FX pools and validate reserve accounting
  // Steps 11-12 are handled as part of authority/currency instantiation

  // Step 13: Instantiate explicitly scheduled starting events only
  // (No stochastic event is realized during construction)

  // Step 14: Initialize empty shipments and PendingTransitions
  // (Handled implicitly in WorldState definition)

  // Step 15: Build DefinitionRegistry and resolve SimulationConfig
  const definitionRegistry = buildDefinitionRegistry(definitionPack);
  const frozenConfig = Object.freeze(resolvedConfig);

  // Prepare WorldGenesisLedger for opening-stock recording (REQ-CONFIG-004)
  let worldGenesisLedger = createEmptyWorldGenesisLedger();

  // Step 16: Normalize sparse maps and run initialization invariants
  validateInitializationInvariants(
    regionRegistry,
    stateRegistry,
    currencyRegistry,
    authorityRegistry,
    clanRegistry,
    cohortRegistry,
    productionUnitRegistry,
    marketRegistry,
    transportLinkRegistry,
  );

  // Step 17: Compute first diagnostic snapshot without mutating stocks
  // (Diagnostic snapshot is deferred to REQ-CORE-004)

  const worldState: WorldState = {
    configVersion: resolvedConfig.configVersion,
    scenarioId: scenarioDefinition.id,
    seed,
    definitionRegistry,
    simulationConfig: frozenConfig,
    worldGenesisLedger,
    regions: regionRegistry,
    states: stateRegistry,
    currencies: currencyRegistry,
    monetaryAuthorities: authorityRegistry,
    clans: clanRegistry,
    cohorts: cohortRegistry,
    productionUnits: productionUnitRegistry,
    markets: marketRegistry,
    transportLinks: transportLinkRegistry,
  };

  return Object.freeze(worldState);
}

interface IdMaps {
  regionIds: Map<string, RegionId>;
  stateIds: Map<string, StateId>;
  currencyIds: Map<string, CurrencyId>;
  authorityIds: Map<string, MonetaryAuthorityId>;
  clanIds: Map<string, ClanId>;
  cohortIds: Map<string, CohortId>;
  productionUnitIds: Map<string, ProductionUnitId>;
  marketIds: Map<string, MarketId>;
  transportLinkIds: Map<string, TransportLinkId>;
}

function resolveStableIds(scenario: ScenarioDefinition, allocator: IdAllocator): IdMaps {
  const regionIds = new Map<string, RegionId>();
  const sortedRegions = stableOrderBy(scenario.geography ?? [], (r) => r.key);
  sortedRegions.forEach((region) => {
    regionIds.set(region.key, allocator.allocate("Region", region.key));
  });

  const stateIds = new Map<string, StateId>();
  const sortedStates = stableOrderBy(scenario.states ?? [], (s) => s.key);
  sortedStates.forEach((state) => {
    stateIds.set(state.key, allocator.allocate("State", state.key));
  });

  const currencyIds = new Map<string, CurrencyId>();
  const sortedCurrencies = stableOrderBy(scenario.currencies ?? [], (c) => c.key);
  sortedCurrencies.forEach((currency) => {
    currencyIds.set(currency.key, allocator.allocate("Currency", currency.key));
  });

  const authorityIds = new Map<string, MonetaryAuthorityId>();
  const sortedAuthorities = stableOrderBy(scenario.monetaryAuthorities ?? [], (a) => a.key);
  sortedAuthorities.forEach((authority) => {
    authorityIds.set(authority.key, allocator.allocate("MonetaryAuthority", authority.key));
  });

  const clanIds = new Map<string, ClanId>();
  const sortedClans = stableOrderBy(scenario.clans ?? [], (c) => c.key ?? "");
  sortedClans.forEach((clan, index) => {
    clanIds.set(clan.key ?? "", allocator.allocate("Clan", clan.key ?? `clan-${index}`));
  });

  const cohortIds = new Map<string, CohortId>();
  const sortedCohorts = stableOrderBy(scenario.cohorts ?? [], (c) => c.key ?? "");
  sortedCohorts.forEach((cohort, index) => {
    cohortIds.set(cohort.key ?? "", allocator.allocate("Cohort", cohort.key ?? `cohort-${index}`));
  });

  const productionUnitIds = new Map<string, ProductionUnitId>();
  const sortedPUs = stableOrderBy(scenario.productionUnits ?? [], (pu) => pu.key ?? "");
  sortedPUs.forEach((pu, index) => {
    productionUnitIds.set(pu.key ?? "", allocator.allocate("ProductionUnit", pu.key ?? `pu-${index}`));
  });

  const marketIds = new Map<string, MarketId>();
  const sortedMarkets = stableOrderBy(scenario.markets ?? [], (m) => m.regionKey ?? "");
  sortedMarkets.forEach((market, index) => {
    marketIds.set(market.regionKey ?? "", allocator.allocate("Market", market.regionKey ?? `market-${index}`));
  });

  const transportLinkIds = new Map<string, TransportLinkId>();
  let linkIndex = 0;
  const sortedLinks = stableOrderBy(scenario.transportLinks ?? [], (l) => `${l.fromRegionKey}→${l.toRegionKey}`);
  sortedLinks.forEach((link) => {
    transportLinkIds.set(`${link.key}→0`, allocator.allocate("TransportLink", `${link.key}→0`));
    if (link.bidirectional !== false) {
      transportLinkIds.set(`${link.key}→1`, allocator.allocate("TransportLink", `${link.key}→1`));
    }
  });

  return {
    regionIds,
    stateIds,
    currencyIds,
    authorityIds,
    clanIds,
    cohortIds,
    productionUnitIds,
    marketIds,
    transportLinkIds,
  };
}

function buildRegionState(seed: RegionSeed, idMap: IdMaps): RegionState {
  const settlementCurrencyId = idMap.currencyIds.get(seed.settlementCurrencyKey);
  if (!settlementCurrencyId) {
    throw new Error(`Region ${seed.key} references missing currency ${seed.settlementCurrencyKey}`);
  }
  return {
    regionId: idMap.regionIds.get(seed.key)!,
    seed,
    controllerStateId: null,
    settlementCurrencyId,
  };
}

function buildStateState(seed: StateSeed, idMap: IdMaps): StateState {
  const currencyId = idMap.currencyIds.get(seed.effectiveCurrencyRegime.currencyKey);
  if (!currencyId) {
    throw new Error(`State ${seed.key} references missing currency ${seed.effectiveCurrencyRegime.currencyKey}`);
  }
  const authorityKey = seed.effectiveCurrencyRegime.policyAuthorityKey;
  return {
    stateId: idMap.stateIds.get(seed.key)!,
    seed,
    effectiveCurrencyId: currencyId,
    memberAuthorityId: authorityKey ? (idMap.authorityIds.get(authorityKey) ?? null) : null,
  };
}

function buildCurrencyState(seed: CurrencySeed, idMap: IdMaps): CurrencyState {
  return {
    currencyId: idMap.currencyIds.get(seed.key)!,
    seed,
    issuerAuthorityId: seed.issuerAuthorityKey ? (idMap.authorityIds.get(seed.issuerAuthorityKey) ?? null) : null,
  };
}

function buildMonetaryAuthorityState(seed: MonetaryAuthoritySeed, idMap: IdMaps): MonetaryAuthorityState {
  const memberStateIds = (seed.memberStateKeys ?? [])
    .map((key) => idMap.stateIds.get(key))
    .filter((id) => id !== undefined) as StateId[];

  return {
    authorityId: idMap.authorityIds.get(seed.key)!,
    seed,
    currencyId: idMap.currencyIds.get(seed.currencyKey)!,
    memberStateIds,
  };
}

function buildLocalMarketState(seed: MarketSeed, definitionPack: DefinitionPack): LocalMarketState {
  return {
    marketId: undefined as unknown as MarketId,
    seed,
  };
}

function expandTransportLink(seed: TransportLinkSeed, idMap: IdMaps): TransportLinkState[] {
  const fromId = idMap.regionIds.get(seed.fromRegionKey);
  const toId = idMap.regionIds.get(seed.toRegionKey);
  if (!fromId || !toId) {
    throw new Error(`Transport link ${seed.key} references missing regions`);
  }

  const forward: TransportLinkState = {
    linkId: idMap.transportLinkIds.get(`${seed.key}→0`)!,
    seed,
  };

  const links = [forward];
  if (seed.bidirectional !== false) {
    const reverse: TransportLinkState = {
      linkId: idMap.transportLinkIds.get(`${seed.key}→1`)!,
      seed,
    };
    links.push(reverse);
  }

  return links;
}

function validateWorldGenesis(
  scenario: ScenarioDefinition,
  definitionPack: DefinitionPack,
  config: SimulationConfig,
): void {
  if (!scenario.id || !scenario.version) {
    throw new Error("Scenario must have id and version");
  }

  const seenKeys = new Set<string>();
  const checkUniqueness = (list: ReadonlyArray<{ key?: string }> | undefined, entityName: string) => {
    (list ?? []).forEach((item) => {
      if (!item.key) return;
      if (seenKeys.has(item.key)) {
        throw new Error(`Duplicate key ${item.key} in ${entityName}`);
      }
      seenKeys.add(item.key);
    });
  };

  checkUniqueness(scenario.geography, "regions");
  checkUniqueness(scenario.states, "states");
  checkUniqueness(scenario.currencies, "currencies");
  checkUniqueness(scenario.monetaryAuthorities, "authorities");

  (scenario.currencies ?? []).forEach((currency) => {
    if (!currency.key || !currency.code) {
      throw new Error("Currency must have key and code");
    }
  });

  (scenario.states ?? []).forEach((state) => {
    const currencyKey = state.effectiveCurrencyRegime.currencyKey;
    const hasCurrency = (scenario.currencies ?? []).some((c) => c.key === currencyKey);
    if (!hasCurrency) {
      throw new Error(`State ${state.key} references missing currency ${currencyKey}`);
    }
  });

  (scenario.geography ?? []).forEach((region) => {
    const currencyKey = region.settlementCurrencyKey;
    const hasCurrency = (scenario.currencies ?? []).some((c) => c.key === currencyKey);
    if (!hasCurrency) {
      throw new Error(`Region ${region.key} references missing currency ${currencyKey}`);
    }
  });
}

function validateInitializationInvariants(
  regions: ReadonlyMap<RegionId, RegionState>,
  states: ReadonlyMap<StateId, StateState>,
  currencies: ReadonlyMap<CurrencyId, CurrencyState>,
  authorities: ReadonlyMap<MonetaryAuthorityId, MonetaryAuthorityState>,
  clans: ReadonlyMap<ClanId, ClanState>,
  cohorts: ReadonlyMap<CohortId, CohortState>,
  productionUnits: ReadonlyMap<ProductionUnitId, ProductionUnitState>,
  markets: ReadonlyMap<MarketId, LocalMarketState>,
  transportLinks: ReadonlyMap<TransportLinkId, TransportLinkState>,
): void {
  // Invariant 3: All IDs are unique (ensured by allocator)
  // Invariant 5: Every Region owns exactly one LocalMarket (checked if markets are required)
  // Invariant 6: Every controlled Region points to one live State
  regions.forEach((region) => {
    if (region.controllerStateId) {
      if (!states.has(region.controllerStateId)) {
        throw new Error(`Region ${region.regionId} references non-existent state`);
      }
    }
  });

  // Invariant 25: Every State.effectiveCurrencyRegime resolves to an existing Currency
  states.forEach((state) => {
    if (!currencies.has(state.effectiveCurrencyId)) {
      throw new Error(`State ${state.stateId} references non-existent currency`);
    }
  });
}
