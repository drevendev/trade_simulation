/**
 * ScenarioDefinition layer (REQ-CONFIG-001).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "ScenarioDefinition owns starting world stocks/topology/institutions."
 * The seed types below (section 16) are named placeholders — their concrete
 * fields land with the world-genesis requirement that consumes them
 * (`REQ-CONFIG-003`/`REQ-CORE-003`), not with this scaffolding requirement.
 */

/** Concrete fields land with world genesis (section 16). */
export interface RegionSeed {}

/** Concrete fields land with world genesis (section 16). */
export interface TransportLinkSeed {}

export interface CurrencyRegimeSeed {
  readonly currencyKey: string;
  readonly regimeType: 'INDEPENDENT_FLOAT' | 'MONETARY_UNION' | 'FOREIGN_LEGAL_TENDER';
  readonly policyAuthorityKey: string | null;
}

/** Concrete fields are owned by the fiscal/monetary policy domain documents; not redefined here (REQ-CONFIG-003). */
export interface StatePolicySeed {}

/** Concrete fields are owned by the monetary domain document; not redefined here (REQ-CONFIG-003). */
export interface FxPoolSeed {}

/** Concrete fields are owned by the clan domain document; not redefined here (REQ-CONFIG-003). */
export interface ClanPreferenceState {}

/** Concrete fields are owned by the clan domain document; not redefined here (REQ-CONFIG-003). */
export interface ClanStateRelationSeed {}

export interface StateSeed {
  readonly key: string;
  readonly name: string;
  readonly treasury: Record<string, number>;
  readonly publicInventory: Record<string, number>;
  readonly policy: StatePolicySeed;
  readonly effectiveCurrencyRegime: CurrencyRegimeSeed;
}

/** Concrete fields land with world genesis (section 16). */
export interface CurrencySeed {}

export interface MonetaryAuthoritySeed {
  readonly key: string;
  readonly currencyKey: string;
  readonly memberStateKeys: readonly string[];
  readonly wallet: Record<string, number>;
  readonly policyRateAnnual?: number;
  readonly fxPools: readonly FxPoolSeed[];
}

export interface ClanSeed {
  readonly key: string;
  readonly name: string;
  readonly treasury: Record<string, number>;
  readonly preferences: ClanPreferenceState;
  readonly initialRelations?: Record<string, ClanStateRelationSeed>;
}

/** Concrete fields land with world genesis (section 16). */
export interface CohortSeed {}

/** Concrete fields land with world genesis (section 16). */
export interface ProductionUnitSeed {}

/** Concrete fields land with world genesis (section 16). */
export interface MarketSeed {}

/** Concrete fields land with world genesis (section 16, bond opening positions). */
export interface BondSeed {}

/** Concrete fields land with world genesis (section 16, initial scheduled events). */
export interface InitialEventSeed {}

/** Concrete fields land with deterministic bounded scenario variation (section 18). */
export interface ScenarioVariationConfig {}

export interface ScenarioDefinition {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly definitionPackId: string;
  readonly geography: readonly RegionSeed[];
  readonly transportLinks: readonly TransportLinkSeed[];
  readonly states: readonly StateSeed[];
  readonly currencies: readonly CurrencySeed[];
  readonly monetaryAuthorities: readonly MonetaryAuthoritySeed[];
  readonly clans: readonly ClanSeed[];
  readonly cohorts: readonly CohortSeed[];
  readonly productionUnits: readonly ProductionUnitSeed[];
  readonly markets?: readonly MarketSeed[];
  readonly bonds?: readonly BondSeed[];
  readonly initialEvents?: readonly InitialEventSeed[];
  readonly variation?: ScenarioVariationConfig;
}

/**
 * Every key section 2's `ScenarioDefinition` interface declares. `markets` and
 * `clans` also happen to be `SimulationConfig` behavioral-key names (section 2's
 * two hierarchies were not designed to avoid key-name collisions) — an array
 * value there is the legitimate seed-list field; a plain-object value is a
 * smuggled `MarketConfig`/`ClanConfig` behavioral patch. See
 * `./validation.ts`'s `assertNoBehavioralOverrides`, which is the actual
 * mechanical proof that scenario-specific behavioral overrides are rejected.
 */
export const SCENARIO_DEFINITION_KEYS = [
  "id",
  "version",
  "name",
  "description",
  "definitionPackId",
  "geography",
  "transportLinks",
  "states",
  "currencies",
  "monetaryAuthorities",
  "clans",
  "cohorts",
  "productionUnits",
  "markets",
  "bonds",
  "initialEvents",
  "variation",
] as const satisfies readonly (keyof ScenarioDefinition)[];
