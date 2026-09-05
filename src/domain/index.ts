/**
 * Domain module area (REQ-MIGRATION-003 scaffolding).
 *
 * Owns canonical entities and value types — identifiers, quantities, money,
 * inventories, registries and the World/Market/Production/Population/Clans/
 * Fiscal/Monetary/Expansion/Events domains — from Milestone 1 onward.
 * REQ-CORE-001 (see ./id.ts) is the first canonical behavior to land here.
 * REQ-CORE-002 (see ./numeric.ts, ./ordering.ts) adds the finite-number and
 * deterministic-ordering primitives every later canonical subsystem builds on.
 * REQ-CORE-003 (see ./worldRegistries.ts, ./definitionRegistry.ts) adds the
 * stable, ID-keyed world entity and definitions registries.
 */
export const DOMAIN_MODULE_AREA = "domain" as const;

export {
  ID_KIND_PREFIX,
  allocateInCreationKeyOrder,
  createIdAllocator,
  type BondId,
  type ClanId,
  type CohortId,
  type CurrencyId,
  type EventInstanceId,
  type GoodId,
  type IdAllocator,
  type IdKind,
  type MarketId,
  type MonetaryAuthorityId,
  type OpaqueId,
  type ProductionUnitId,
  type RegionId,
  type ShipmentId,
  type StateId,
  type TransportLinkId,
} from "./id";

export { assertFiniteCanonicalNumber, isFiniteCanonicalNumber } from "./numeric";

export { sortByPersistentId, stableOrderBy } from "./ordering";

export { buildWorldRegistries, type RegistryEntry, type WorldRegistries } from "./worldRegistries";

export { buildDefinitionRegistry, type DefinitionRegistry } from "./definitionRegistry";

export {
  addGenesisRecord,
  createEmptyWorldGenesisLedger,
  type ActorRef,
  type GenesisRecord,
  type WorldGenesisLedger,
} from "./genesisLedger";
