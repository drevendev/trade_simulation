/**
 * Domain module area (REQ-MIGRATION-003 scaffolding).
 *
 * Owns canonical entities and value types — identifiers, quantities, money,
 * inventories, registries and the World/Market/Production/Population/Clans/
 * Fiscal/Monetary/Expansion/Events domains — from Milestone 1 onward.
 * REQ-CORE-001 (see ./id.ts) is the first canonical behavior to land here.
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
