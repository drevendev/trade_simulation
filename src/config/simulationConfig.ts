/**
 * SimulationConfig layer (REQ-CONFIG-001).
 *
 * See `docs/spec/mirror/06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md`
 * section 2: "SimulationConfig owns reusable behavioral tuning" shared across
 * scenarios. Each of the thirteen sub-config types below is a named placeholder —
 * its concrete field-level defaults (sections 3-14 of that document) land with the
 * requirement that owns the corresponding subsystem (M3-M10), not with this
 * scaffolding requirement. Declaring them now, rather than inlining `unknown`,
 * is what makes `SimulationConfig` a real distinct type today and lets later
 * requirements add fields without touching this file's shape.
 */

/** Concrete fields land with the numeric-tolerance requirement that owns them (section 3). */
export interface NumericConfig {}

/** Concrete fields land with the cadence-scheduling requirement that owns them (section 3). */
export interface CadenceConfig {}

/** Concrete fields land with the markets requirement that owns them (section 4). */
export interface MarketConfig {}

/** Concrete fields land with the trade/FX requirement that owns them (section 5). */
export interface TradeConfig {}

/** Concrete fields land with the production requirement that owns them (section 6). */
export interface ProductionConfig {}

/** Concrete fields land with the labor requirement that owns them (section 7). */
export interface LaborConfig {}

/** Concrete fields land with the population requirement that owns them (section 8). */
export interface PopulationConfig {}

/** Concrete fields land with the clans requirement that owns them (section 9). */
export interface ClanConfig {}

/** Concrete fields land with the fiscal requirement that owns them (section 10). */
export interface FiscalConfig {}

/** Concrete fields land with the monetary requirement that owns them (section 11). */
export interface MonetaryConfig {}

/** Concrete fields land with the expansion requirement that owns them (section 12). */
export interface ExpansionConfig {}

/** Concrete fields land with the events requirement that owns them (section 13). */
export interface EventConfig {}

/** Concrete fields land with the performance requirement that owns them (section 14). */
export interface PerformanceConfig {}

/**
 * The thirteen behavioral-tuning keys `SimulationConfig` owns, exactly as named
 * in section 2. Scenario data may never carry one of these keys directly — see
 * `./validation.ts`'s `assertNoBehavioralOverrides`.
 */
export const SIMULATION_CONFIG_BEHAVIORAL_KEYS = [
  "numeric",
  "cadence",
  "markets",
  "trade",
  "production",
  "labor",
  "population",
  "clans",
  "fiscal",
  "monetary",
  "expansion",
  "events",
  "performance",
] as const satisfies readonly (keyof Omit<SimulationConfig, "configVersion">)[];

export interface SimulationConfig {
  readonly configVersion: string;
  readonly numeric: NumericConfig;
  readonly cadence: CadenceConfig;
  readonly markets: MarketConfig;
  readonly trade: TradeConfig;
  readonly production: ProductionConfig;
  readonly labor: LaborConfig;
  readonly population: PopulationConfig;
  readonly clans: ClanConfig;
  readonly fiscal: FiscalConfig;
  readonly monetary: MonetaryConfig;
  readonly expansion: ExpansionConfig;
  readonly events: EventConfig;
  readonly performance: PerformanceConfig;
}
