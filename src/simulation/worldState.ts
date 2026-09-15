/**
 * WorldState and buildInitialWorld orchestrator (REQ-CONFIG-003).
 *
 * Executes the 17-step canonical initialization order from section 19 of
 * docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md
 */

import type { DefinitionRegistry } from "../domain/definitionRegistry";
import { buildDefinitionRegistry, resolveCapitalGoodsPerCapitalUnit } from "../domain/definitionRegistry";
import { createIdAllocator, allocateInCreationKeyOrder } from "../domain/id";
import type {
  ClanId,
  CohortId,
  CurrencyId,
  GoodId,
  IdAllocator,
  MarketId,
  MonetaryAuthorityId,
  ProductionUnitId,
  RegionId,
  StateId,
  TransportLinkId,
} from "../domain/id";
import { createEmptyPendingTransitions } from "./pendingTransitions";
import { buildWorldRegistries } from "../domain/worldRegistries";
import {
  createEmptyWorldGenesisLedger,
  addGenesisRecord,
  type WorldGenesisLedger,
  type GenesisRecord,
} from "../domain/genesisLedger";
import { reconcileGenesisStocks } from "./genesisReconciliation";
import { seedLiveActorStocks } from "./liveActorStock";
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
import { validateDefinitionPack, validateLaborConfig, validateProductionConfig } from "../config/validation";
import { assertFiniteCanonicalNumber } from "../domain/numeric";
import { stableOrderBy } from "../domain/ordering";

/**
 * Canonical world state: all registries and resolved configuration.
 * Must be byte-equivalent for the same scenario/config/seed after normalized serialization.
 */
export interface PendingTransitions {
  readonly jurisdictionChanges: ReadonlyArray<{
    readonly regionId: RegionId;
    readonly nextControllerStateId: StateId | null;
    readonly activateTick: number;
  }>;
  readonly stateCreations: ReadonlyArray<{
    readonly stateId: StateId;
    readonly regionKey: string;
    readonly seed: unknown;
    readonly activateTick: number;
  }>;
  readonly policyChanges: ReadonlyArray<{
    readonly stateId: StateId;
    readonly patch: unknown;
    readonly activateTick: number;
  }>;
  readonly monetaryPolicyChanges: ReadonlyArray<{
    readonly authorityId: MonetaryAuthorityId;
    readonly patch: unknown;
    readonly activateTick: number;
  }>;
}

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
  readonly pendingTransitions: PendingTransitions;
}

export interface RegionState {
  readonly regionId: RegionId;
  readonly seed: RegionSeed;
  readonly controllerStateId: StateId | null;
  readonly settlementCurrencyId: CurrencyId;
}

/**
 * Live money balances by currency, owned by one actor.
 *
 * "Live" is the contrast with `worldGenesisLedger`, which records the *opening* stock once
 * and is never rewritten. A live stock is seeded from those opening records and then
 * carried forward by explicit transition functions (`executeAllocation`), in the same way
 * `LocalMarketState.priceByGood` is carried forward by `applyMarketStateTransition`.
 * The map is read-only because `WorldState` stays immutable for the duration of one tick
 * (see `tickOrchestrator.ts`); settlement returns a new `WorldState` rather than writing
 * through a shared reference. See docs/adr/0007-live-actor-stock-as-world-transition.md.
 */
export type LiveWallet = ReadonlyMap<CurrencyId, number>;

/** Live physical goods quantities by good, held in one authoritative inventory. */
export type LiveInventory = ReadonlyMap<GoodId, number>;

export interface StateState {
  readonly stateId: StateId;
  readonly seed: StateSeed;
  readonly effectiveCurrencyId: CurrencyId;
  readonly memberAuthorityId: MonetaryAuthorityId | null;
  /** Live treasury. Receives collected consumption tax at settlement (Handoff/04 §10). */
  readonly treasury: LiveWallet;
  /** Live public inventory: the State's own goods, held by the State rather than a region. */
  readonly publicInventory: LiveInventory;
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

/**
 * A Clan owns a treasury and deliberately owns **no** physical inventory: Handoff/01
 * sections 5.3/5.4/7 forbid a Clan duplicating the household consumption inventory its
 * cohorts hold. Settlement therefore refuses a Clan goods endpoint rather than inventing
 * one (see `resolveGoodsEndpoint` in marketSettlementTransition.ts).
 */
export interface ClanState {
  readonly clanId: ClanId;
  readonly seed: ClanSeed;
  readonly treasury: LiveWallet;
}

export interface CohortState {
  readonly cohortId: CohortId;
  readonly clanId: ClanId;
  readonly seed: CohortSeed;
  readonly wallet: LiveWallet;
  /** The authoritative household goods stock. A cohort holds exactly one, not buckets. */
  readonly householdInventory: LiveInventory;
}

/**
 * A ProductionUnit's INPUT, OUTPUT and INVESTMENT inventories are three distinct
 * authoritative stocks, not three labels on one aggregate (Handoff/03 §20, Handoff/04
 * §11 and MTFX-I25). Settlement must be told which one an allocation means and must
 * never guess from actor type alone.
 */
export interface ProductionUnitState {
  readonly productionUnitId: ProductionUnitId;
  readonly seed: ProductionUnitSeed;
  readonly wallet: LiveWallet;
  readonly inputInventory: LiveInventory;
  readonly outputInventory: LiveInventory;
  readonly investmentInventory: LiveInventory;
}

export interface MarketExpectationState {
  readonly observationCount: number;
  readonly expectedUseEma: number;
  readonly shortageEma: number;
  readonly surplusEma: number;
  readonly lastEffectiveDemand: number;
  readonly lastOfferedQuantity: number;
  readonly lastClearedQuantity: number;
}

export interface LocalMarketState {
  readonly marketId: MarketId;
  readonly seed: MarketSeed;
  readonly priceByGood: ReadonlyMap<string, number>;
  readonly expectationsByGood: ReadonlyMap<string, MarketExpectationState>;
}

export interface TransportLinkState {
  readonly linkId: TransportLinkId;
  readonly seed: TransportLinkSeed;
}

/**
 * Builds canonical WorldState by executing the 17-step initialization order.
 * Same scenario/config/seed => byte-equivalent output after normalized serialization.
 * REQ-CONFIG-004 Part 2/4: Tracks opening stocks through buildInitialWorld() steps.
 */
export function buildInitialWorld(
  scenarioDefinition: ScenarioDefinition,
  definitionPack: DefinitionPack,
  resolvedConfig: SimulationConfig,
  seed: number,
): WorldState {
  // Step 1: Validate schema versions, uniqueness, references, finite values and config bounds
  validateWorldGenesis(scenarioDefinition, definitionPack, resolvedConfig);
  validateDefinitionPack(definitionPack);

  // Step 2: Resolve stable runtime IDs from sorted human keys
  const allocator = createIdAllocator();
  const idMap = resolveStableIds(scenarioDefinition, allocator);

  // Initialize WorldGenesisLedger for tracking opening stocks (REQ-CONFIG-004)
  let worldGenesisLedger = createEmptyWorldGenesisLedger();

  // Step 3: Instantiate Currency and MonetaryAuthority registries
  const currencyRegistry = new Map(
    (scenarioDefinition.currencies ?? []).map((currencySeed) => [
      idMap.currencyIds.get(currencySeed.key)!,
      buildCurrencyState(currencySeed, idMap),
    ]),
  );

  const authorityRegistry = new Map();
  (scenarioDefinition.monetaryAuthorities ?? []).forEach((authoritySeed) => {
    const authorityId = idMap.authorityIds.get(authoritySeed.key)!;
    const authorityState = buildMonetaryAuthorityState(authoritySeed, idMap);
    authorityRegistry.set(authorityId, authorityState);

    // Track authority wallet money separately from FX pool reserves (REQ-CONFIG-004)

    // Track FX pool opening balances
    (authoritySeed.fxPools ?? []).forEach((fxPoolSeed) => {
      const baseCurrencyId = idMap.currencyIds.get(fxPoolSeed.baseCurrencyKey);
      const quoteCurrencyId = idMap.currencyIds.get(fxPoolSeed.quoteCurrencyKey);

      if (baseCurrencyId && fxPoolSeed.cash) {
        const amount = fxPoolSeed.cash[fxPoolSeed.baseCurrencyKey];
        if (typeof amount === "number" && amount > 0) {
          const record: GenesisRecord = {
            type: "FX_POOL_OPENING",
            currencyId: baseCurrencyId,
            amount,
            sourceSeedKey: `${authoritySeed.key}.fxPool.${fxPoolSeed.key}.base`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      }

      if (quoteCurrencyId && fxPoolSeed.cash) {
        const amount = fxPoolSeed.cash[fxPoolSeed.quoteCurrencyKey];
        if (typeof amount === "number" && amount > 0) {
          const record: GenesisRecord = {
            type: "FX_POOL_OPENING",
            currencyId: quoteCurrencyId,
            amount,
            sourceSeedKey: `${authoritySeed.key}.fxPool.${fxPoolSeed.key}.quote`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      }
    });

    // Track authority wallet opening amounts as money endowments
    Object.entries(authoritySeed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const currencyId = idMap.currencyIds.get(currencyKey);
        if (currencyId) {
          const record: GenesisRecord = {
            type: "MONEY_ENDOWMENT",
            owner: { type: "MONETARY_AUTHORITY", authorityId },
            currencyId,
            amount,
            sourceSeedKey: `${authoritySeed.key}.wallet.${currencyKey}`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      }
    });
  });

  // Step 4: Instantiate Regions with deposits/infrastructure/settlement state
  const regionRegistry = new Map(
    (scenarioDefinition.geography ?? []).map((regionSeed) => {
      const regionId = idMap.regionIds.get(regionSeed.key)!;
      const regionState = buildRegionState(regionSeed, idMap);

      // Track resource endowments (REQ-CONFIG-004)
      (regionSeed.deposits ?? []).forEach((deposit) => {
        if (deposit.initialQuantity > 0) {
          // Goods carry no allocated id: a good is identified by its definition key
          // everywhere in genesis accounting, as GOOD_ENDOWMENT does, so the deposit's
          // resource key is the typed good identity reconciliation compares.
          const goodId = deposit.resourceId as unknown as GoodId;
          const record: GenesisRecord = {
            type: "RESOURCE_ENDOWMENT",
            regionId,
            goodId,
            amount: deposit.initialQuantity,
            sourceSeedKey: `${regionSeed.key}.deposit.${deposit.resourceId}`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      });

      return [regionId, regionState];
    }),
  );

  // Step 5: Instantiate TransportLinks with deterministic directed expansion
  const transportLinkRegistry = new Map(
    (scenarioDefinition.transportLinks ?? []).flatMap((linkSeed) => {
      const links = expandTransportLink(linkSeed, idMap);
      return links.map((link) => [link.linkId, link]);
    }),
  );

  // Step 6: Instantiate States and apply jurisdiction
  const stateRegistry = new Map<StateId, StateState>();
  (scenarioDefinition.states ?? []).forEach((stateSeed) => {
    const stateId = idMap.stateIds.get(stateSeed.key)!;
    const stateState = buildStateState(stateSeed, idMap);
    stateRegistry.set(stateId, stateState);

    // Track state treasury (money endowment)
    Object.entries(stateSeed.treasury ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const currencyId = idMap.currencyIds.get(currencyKey);
        if (currencyId) {
          const record: GenesisRecord = {
            type: "MONEY_ENDOWMENT",
            owner: { type: "STATE", stateId },
            currencyId,
            amount,
            sourceSeedKey: `${stateSeed.key}.treasury.${currencyKey}`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      }
    });

    // Track state public inventory (good endowment)
    Object.entries(stateSeed.publicInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const goodId = goodKey as any; // Simplified; would need GoodId lookup
        // A State's public inventory is held by the State itself, not by any one of the
        // regions it controls, so it carries no canonical location and `regionId` stays
        // absent (Handoff/03 section 20 declares it optional).
        const record: GenesisRecord = {
          type: "GOOD_ENDOWMENT",
          owner: { type: "STATE", stateId },
          goodId,
          amount,
          sourceSeedKey: `${stateSeed.key}.publicInventory.${goodKey}`,
        };
        worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
      }
    });
  });

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
  const clanRegistry = new Map<ClanId, ClanState>();
  (scenarioDefinition.clans ?? []).forEach((clanSeed) => {
    const clanId = idMap.clanIds.get(clanSeed.key ?? "")!;
    // Live stock starts empty here and is seeded from the completed genesis ledger below,
    // so there is exactly one place that turns an opening record into a live balance.
    clanRegistry.set(clanId, { clanId, seed: clanSeed, treasury: new Map() });

    // Track clan treasury (money endowment)
    Object.entries(clanSeed.treasury ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const currencyId = idMap.currencyIds.get(currencyKey);
        if (currencyId) {
          const record: GenesisRecord = {
            type: "MONEY_ENDOWMENT",
            owner: { type: "CLAN", clanId },
            currencyId,
            amount,
            sourceSeedKey: `${clanSeed.key}.treasury.${currencyKey}`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      }
    });
  });

  // Step 8: Instantiate Cohorts with bounded keyed variation
  const cohortRegistry = new Map<CohortId, CohortState>();
  (scenarioDefinition.cohorts ?? []).forEach((cohortSeed) => {
    const cohortId = idMap.cohortIds.get(cohortSeed.key ?? "")!;
    const regionId = idMap.regionIds.get(cohortSeed.regionKey)!;
    const clanId = idMap.clanIds.get(cohortSeed.clanKey ?? "")!;

    cohortRegistry.set(cohortId, {
      cohortId,
      clanId,
      seed: cohortSeed,
      wallet: new Map(),
      householdInventory: new Map(),
    });

    // Cohort is its own owner for opening-stock records (Handoff/01 5.3/5.4/7): Clan derives
    // population from cohorts and owns a treasury only, never a duplicate population, wallet
    // or household inventory stock.
    const cohortOwner = { type: "COHORT" as const, cohortId };

    // Track cohort population endowment
    if (cohortSeed.population > 0) {
      const record: GenesisRecord = {
        type: "POPULATION_ENDOWMENT",
        owner: cohortOwner,
        regionId,
        amount: cohortSeed.population,
        sourceSeedKey: `${cohortSeed.key}.population`,
      };
      worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
    }

    // Track cohort wallet (money endowment, owned by the cohort itself)
    Object.entries(cohortSeed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const currencyId = idMap.currencyIds.get(currencyKey);
        if (currencyId) {
          const record: GenesisRecord = {
            type: "MONEY_ENDOWMENT",
            owner: cohortOwner,
            currencyId,
            amount,
            sourceSeedKey: `${cohortSeed.key}.wallet.${currencyKey}`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      }
    });

    // Track cohort household inventory (good endowment, owned by the cohort itself)
    Object.entries(cohortSeed.householdInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const goodId = goodKey as any; // Simplified; would need GoodId lookup
        const record: GenesisRecord = {
          type: "GOOD_ENDOWMENT",
          owner: cohortOwner,
          regionId,
          goodId,
          amount,
          sourceSeedKey: `${cohortSeed.key}.householdInventory.${goodKey}`,
        };
        worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
      }
    });
  });

  // Step 9: Instantiate LocalMarkets (one per Region)
  const marketRegistry = new Map(
    (scenarioDefinition.markets ?? []).map((marketSeed) => {
      const marketId = idMap.marketIds.get(marketSeed.regionKey ?? "")!;
      return [
        marketId,
        buildLocalMarketState(marketSeed, marketId, definitionPack),
      ];
    }),
  );

  // Step 10: Instantiate ProductionUnits with capacity derivation
  const productionUnitRegistry = new Map<ProductionUnitId, ProductionUnitState>();
  (scenarioDefinition.productionUnits ?? []).forEach((puSeed) => {
    const productionUnitId = idMap.productionUnitIds.get(puSeed.key ?? "")!;
    const regionId = idMap.regionIds.get(puSeed.regionKey)!;
    productionUnitRegistry.set(productionUnitId, {
      productionUnitId,
      seed: puSeed,
      wallet: new Map(),
      inputInventory: new Map(),
      outputInventory: new Map(),
      investmentInventory: new Map(),
    });

    // ProductionUnit is its own owner for opening-stock records (REQ-CONFIG-004 Part 2)
    const puOwner = { type: "PRODUCTION_UNIT" as const, productionUnitId };

    // Track PU wallet (money endowment, owned by PU itself)
    Object.entries(puSeed.wallet ?? {}).forEach(([currencyKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const currencyId = idMap.currencyIds.get(currencyKey);
        if (currencyId) {
          const record: GenesisRecord = {
            type: "MONEY_ENDOWMENT",
            owner: puOwner,
            currencyId,
            amount,
            sourceSeedKey: `${puSeed.key}.wallet.${currencyKey}`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        }
      }
    });

    // Track PU input inventory (good endowment, owned by PU itself)
    Object.entries(puSeed.inputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const goodId = goodKey as any; // Simplified; would need GoodId lookup
        const record: GenesisRecord = {
          type: "GOOD_ENDOWMENT",
          owner: puOwner,
          regionId,
          goodId,
          amount,
          inventoryBucket: "INPUT",
          sourceSeedKey: `${puSeed.key}.inputInventory.${goodKey}`,
        };
        worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
      }
    });

    // Track PU output inventory (good endowment, owned by PU itself)
    Object.entries(puSeed.outputInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const goodId = goodKey as any; // Simplified; would need GoodId lookup
        const record: GenesisRecord = {
          type: "GOOD_ENDOWMENT",
          owner: puOwner,
          regionId,
          goodId,
          amount,
          inventoryBucket: "OUTPUT",
          sourceSeedKey: `${puSeed.key}.outputInventory.${goodKey}`,
        };
        worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
      }
    });

    // Track PU investment inventory (good endowment, owned by PU itself)
    Object.entries(puSeed.investmentInventory ?? {}).forEach(([goodKey, amount]) => {
      if (typeof amount === "number" && amount > 0) {
        const goodId = goodKey as any; // Simplified; would need GoodId lookup
        const record: GenesisRecord = {
          type: "GOOD_ENDOWMENT",
          owner: puOwner,
          regionId,
          goodId,
          amount,
          inventoryBucket: "INVESTMENT",
          sourceSeedKey: `${puSeed.key}.investmentInventory.${goodKey}`,
        };
        worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
      }
    });

    // Track PU installed capital (capital endowment, owned by PU itself).
    // Section 20 requires capital-converted goods to match genesis goods after the
    // documented conversion; that conversion is the unit's recipe
    // investmentGoodsPerCapitalUnit, so capital is recorded per capital good.
    if (puSeed.installedCapital > 0) {
      const capitalGoods = resolveCapitalGoodsPerCapitalUnit(definitionPack, puSeed.recipeId);

      if (capitalGoods.length > 0) {
        capitalGoods.forEach(([goodId, goodsPerCapitalUnit]) => {
          const record: GenesisRecord = {
            type: "CAPITAL_ENDOWMENT",
            owner: puOwner,
            regionId,
            goodId,
            amount: puSeed.installedCapital * goodsPerCapitalUnit,
            sourceSeedKey: `${puSeed.key}.installedCapital.${goodId}`,
          };
          worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
        });
      } else {
        // The recipe declares no investment good, so this capital embodies no
        // tradable good: record it without a goodId rather than fabricating one.
        const record: GenesisRecord = {
          type: "CAPITAL_ENDOWMENT",
          owner: puOwner,
          regionId,
          amount: puSeed.installedCapital,
          sourceSeedKey: `${puSeed.key}.installedCapital`,
        };
        worldGenesisLedger = addGenesisRecord(worldGenesisLedger, record);
      }
    }
  });

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

  // Issue #427: seed every actor's live wallet/inventory from the now-complete opening
  // ledger, so live stock and genesis accounting start equal and share one owner key.
  seedLiveActorStocks(worldGenesisLedger, {
    clans: clanRegistry,
    cohorts: cohortRegistry,
    productionUnits: productionUnitRegistry,
    states: stateRegistry,
  });

  // REQ-CONFIG-004: Reconcile opening stocks before returning WorldState
  // Build a temporary WorldState for reconciliation (without freeze)
  const tempWorldState: WorldState = {
    configVersion: resolvedConfig.configVersion,
    scenarioId: scenarioDefinition.id,
    seed,
    definitionRegistry,
    simulationConfig: frozenConfig,
    // Empty, like the WorldState this reconciliation precedes: genesis queues no
    // transition, and reconciliation reads stocks, never the queue.
    pendingTransitions: createEmptyPendingTransitions(),
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

  const reconciliationResult = reconcileGenesisStocks(tempWorldState, worldGenesisLedger, frozenConfig);
  if (!reconciliationResult.success) {
    throw new Error(
      `Genesis reconciliation failed: ${reconciliationResult.errorMessage}\n` +
      `Category: ${reconciliationResult.details?.category}, Key: ${reconciliationResult.details?.key}, ` +
      `Expected: ${reconciliationResult.details?.expected}, Actual: ${reconciliationResult.details?.actual}, ` +
      `Residual: ${reconciliationResult.details?.residual}`,
    );
  }

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
    pendingTransitions: createEmptyPendingTransitions(),
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
    treasury: new Map(),
    publicInventory: new Map(),
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

function buildLocalMarketState(seed: MarketSeed, marketId: MarketId, definitionPack: DefinitionPack): LocalMarketState {
  const priceByGood = new Map<string, number>();
  const expectationsByGood = new Map<string, MarketExpectationState>();

  (seed.initialPriceByGood ?? {});
  Object.entries(seed.initialPriceByGood ?? {}).forEach(([goodKey, price]) => {
    priceByGood.set(goodKey, price);
    expectationsByGood.set(goodKey, {
      observationCount: 0,
      expectedUseEma: 0,
      shortageEma: 0,
      surplusEma: 0,
      lastEffectiveDemand: 0,
      lastOfferedQuantity: 0,
      lastClearedQuantity: 0,
    });
  });

  return {
    marketId,
    seed,
    priceByGood,
    expectationsByGood,
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

  // Step 1 promises "config bounds". REQ-CONFIG-006 makes that true for the M4
  // production and labor surface: a non-finite or out-of-range control fails here,
  // at genesis, rather than at the first tick that reads it.
  validateProductionConfig(config.production);
  validateLaborConfig(config.labor);

  validateExtractionResourcesPresent(scenario, definitionPack);
}

/**
 * Section 21: "recipe extraction referring to a resource absent from all eligible
 * regions when the baseline expects that recipe to operate".
 *
 * This check needs both halves of world genesis — the recipe lives in the
 * DefinitionPack, the deposits live in the ScenarioDefinition — so it cannot sit in
 * validateDefinitionPack(), which never sees the scenario.
 *
 * "Eligible regions" is not defined anywhere in the governing document, so the rule
 * is applied in its weakest form: reject only when the resource is absent from *every*
 * Region in the scenario. The eligible set is a subset of all Regions under any reading
 * of the term, so absence from every Region entails absence from all eligible ones, and
 * this can never reject a world that some reading of "eligible" would permit. In the
 * baseline, recipe:iron-mine runs in region:b6-mineral and region:d3-mountain, neither
 * of which holds resource:iron-ore, so a per-Region reading would reject the shipped
 * baseline. The undefined term is reported in docs/spec/FEEDBACK_TO_RESEARCHER.md.
 *
 * "Expects that recipe to operate" is read as: some ProductionUnit seed on that recipe
 * starts ACTIVE. PLANNED and MOTHBALLED units are not operating at tick 0.
 */
function validateExtractionResourcesPresent(
  scenario: ScenarioDefinition,
  definitionPack: DefinitionPack,
): void {
  const depositedResourceIds = new Set<string>();
  (scenario.geography ?? []).forEach((region) => {
    (region.deposits ?? []).forEach((deposit) => {
      depositedResourceIds.add(deposit.resourceId);
    });
  });

  const activeRecipeIds = new Set<string>();
  (scenario.productionUnits ?? []).forEach((unit) => {
    if (unit.status === "ACTIVE") {
      activeRecipeIds.add(unit.recipeId);
    }
  });

  for (const recipeId of Array.from(activeRecipeIds).sort()) {
    const resourceId = definitionPack.recipes?.[recipeId]?.extractionResourceId;
    if (resourceId === undefined) continue;
    if (depositedResourceIds.has(resourceId)) continue;

    throw new Error(
      `RecipeDefinition "${recipeId}": extractionResourceId "${resourceId}" is absent from every Region deposit in scenario "${scenario.id}", but the scenario starts at least one ACTIVE ProductionUnit on that recipe`,
    );
  }
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
  // Validate that every market's marketId matches its registry key
  markets.forEach((market, marketKey) => {
    if (market.marketId !== marketKey) {
      throw new Error(
        `Market invariant violation: registry key ${marketKey} does not match market.marketId ${market.marketId}`,
      );
    }
  });

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
