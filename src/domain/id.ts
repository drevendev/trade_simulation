/**
 * Canonical persistent typed IDs (REQ-CORE-001).
 *
 * See `docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md` section 2
 * and `docs/adr/0003-canonical-identity-and-allocation.md` for the contract this
 * implements: opaque, kind-branded, run-scoped, never an array index or map
 * iteration artifact, and never reused after retirement.
 */

declare const idKindTag: unique symbol;

/** An opaque persistent ID for one lifecycle instance of `Kind`. Not a plain string. */
export type OpaqueId<Kind extends string> = string & { readonly [idKindTag]: Kind };

export type RegionId = OpaqueId<"Region">;
export type StateId = OpaqueId<"State">;
export type ClanId = OpaqueId<"Clan">;
export type CohortId = OpaqueId<"Cohort">;
export type ProductionUnitId = OpaqueId<"ProductionUnit">;
export type MarketId = OpaqueId<"Market">;
export type TransportLinkId = OpaqueId<"TransportLink">;
export type CurrencyId = OpaqueId<"Currency">;
export type MonetaryAuthorityId = OpaqueId<"MonetaryAuthority">;
export type ShipmentId = OpaqueId<"Shipment">;
export type BondId = OpaqueId<"Bond">;
export type EventInstanceId = OpaqueId<"EventInstance">;
export type GoodId = OpaqueId<"Good">;

/** Stable string prefixes, fixed by the specification (section 2). */
export const ID_KIND_PREFIX = {
  Region: "r",
  State: "s",
  Clan: "c",
  Cohort: "pc",
  ProductionUnit: "pu",
  Market: "m",
  TransportLink: "tl",
  Currency: "cur",
  MonetaryAuthority: "ma",
  Shipment: "sh",
  Bond: "bond",
  EventInstance: "ev",
  Good: "good",
} as const satisfies Record<string, string>;

export type IdKind = keyof typeof ID_KIND_PREFIX;

interface IdTypeByKind {
  Region: RegionId;
  State: StateId;
  Clan: ClanId;
  Cohort: CohortId;
  ProductionUnit: ProductionUnitId;
  Market: MarketId;
  TransportLink: TransportLinkId;
  Currency: CurrencyId;
  MonetaryAuthority: MonetaryAuthorityId;
  Shipment: ShipmentId;
  Bond: BondId;
  EventInstance: EventInstanceId;
  Good: GoodId;
}

/**
 * A run-scoped identity allocator. Owned by one run; never a module singleton
 * (`createIdAllocator()` must be called once per run and threaded explicitly).
 */
export interface IdAllocator {
  /**
   * Allocate the next identity for `kind`, keyed by a caller-supplied
   * `creationKey` that identifies this creation event within the run (for
   * example a scenario-declared name, or a dynamic-entity cause such as
   * `"state-formation:tick-42:region-r:7"`).
   *
   * Two independent allocators fed the same (kind, creationKey) call sequence
   * in the same order always produce the same IDs — that is the replay
   * guarantee. Calling with a `creationKey` already used for this kind in
   * this run throws rather than silently returning the earlier ID: a
   * repeated creation key means a caller bug, not an idempotent retry.
   */
  allocate<K extends IdKind>(kind: K, creationKey: string): IdTypeByKind[K];

  /**
   * Permanently retire `id`. The allocator's underlying sequence never
   * reuses a number, so retirement does not change future allocation
   * behavior — it exists so callers can assert and query retirement instead
   * of tracking it themselves, and so misuse (retiring an unknown ID,
   * retiring twice, retiring under the wrong kind) fails loudly.
   */
  retire<K extends IdKind>(kind: K, id: IdTypeByKind[K]): void;

  /** True once `id` has been retired. False for unknown or live IDs. */
  isRetired(id: string): boolean;

  /** True once `id` has been allocated (retired or not) by this allocator. */
  isAllocated(id: string): boolean;

  /**
   * True once `creationKey` has already been used to allocate an identity for
   * `kind` by this allocator (retired or not). A pure query — never mutates
   * allocator state — so callers can preflight a batch for conflicts with
   * prior allocations before reserving anything.
   */
  hasCreationKey<K extends IdKind>(kind: K, creationKey: string): boolean;
}

/**
 * Validates a value is one of the 13 declared id kinds. Rejects non-string
 * values and inherited (e.g. `Object.prototype`) properties: TypeScript
 * brands are erased at runtime, so `kind` may arrive from an untyped or
 * deserialized caller.
 */
function assertValidKind(kind: unknown): asserts kind is IdKind {
  if (
    typeof kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(ID_KIND_PREFIX, kind)
  ) {
    throw new Error(`unknown id kind: ${JSON.stringify(kind)}`);
  }
}

/** Validates a value is a non-empty string, regardless of what TypeScript's erased brand claims. */
function assertValidCreationKey(creationKey: unknown): asserts creationKey is string {
  if (typeof creationKey !== "string" || creationKey.length === 0) {
    throw new Error(`creationKey must be a non-empty string, got ${JSON.stringify(creationKey)}`);
  }
}

/** Creates a fresh, independent identity allocator for exactly one run. */
export function createIdAllocator(): IdAllocator {
  const nextSequenceByKind = new Map<IdKind, number>();
  const usedCreationKeysByKind = new Map<IdKind, Set<string>>();
  const allocatedIds = new Set<string>();
  const retiredIds = new Set<string>();

  return {
    allocate<K extends IdKind>(kind: K, creationKey: string): IdTypeByKind[K] {
      assertValidKind(kind);
      assertValidCreationKey(creationKey);

      let usedCreationKeys = usedCreationKeysByKind.get(kind);
      if (usedCreationKeys === undefined) {
        usedCreationKeys = new Set<string>();
        usedCreationKeysByKind.set(kind, usedCreationKeys);
      }
      if (usedCreationKeys.has(creationKey)) {
        throw new Error(
          `duplicate creation key ${JSON.stringify(creationKey)} for id kind "${kind}": ` +
            "each creation key may allocate at most one identity per run",
        );
      }

      const sequence = (nextSequenceByKind.get(kind) ?? 0) + 1;
      const id = `${ID_KIND_PREFIX[kind]}:${sequence}`;
      if (allocatedIds.has(id) || retiredIds.has(id)) {
        throw new Error(`internal allocator error: id "${id}" is already in use`);
      }

      nextSequenceByKind.set(kind, sequence);
      allocatedIds.add(id);
      usedCreationKeys.add(creationKey);
      return id as IdTypeByKind[K];
    },

    retire<K extends IdKind>(kind: K, id: IdTypeByKind[K]): void {
      const expectedPrefix = `${ID_KIND_PREFIX[kind]}:`;
      if (!id.startsWith(expectedPrefix)) {
        throw new Error(`id "${id}" does not belong to id kind "${kind}"`);
      }
      if (!allocatedIds.has(id)) {
        throw new Error(`cannot retire id "${id}": it was never allocated by this allocator`);
      }
      if (retiredIds.has(id)) {
        throw new Error(`cannot retire id "${id}": it is already retired`);
      }
      retiredIds.add(id);
    },

    isRetired(id: string): boolean {
      return retiredIds.has(id);
    },

    isAllocated(id: string): boolean {
      return allocatedIds.has(id);
    },

    hasCreationKey<K extends IdKind>(kind: K, creationKey: string): boolean {
      assertValidKind(kind);
      assertValidCreationKey(creationKey);
      return usedCreationKeysByKind.get(kind)?.has(creationKey) ?? false;
    },
  };
}

/**
 * Allocates one identity per `creationKey` for `kind`, in ascending
 * lexicographic order of `creationKey` rather than the iteration order of
 * whatever collection the caller built `creationKeys` from.
 *
 * This is the documented stable-order contract for pre-allocation ordering
 * (section 2's "sort by persistent ID... before processing" rule cannot
 * apply before an ID exists, so callers sort by creation key instead). Feed
 * this the same `creationKeys` set from a shuffled array or an object built
 * in a different insertion order and the resulting key-to-ID mapping is
 * unchanged.
 *
 * Failure-atomic: the whole batch is validated — kind, each creation key's
 * shape, in-batch duplicates, and overlap with creation keys this allocator
 * already used (including for retired IDs) — before a single identity is
 * reserved. A rejected batch leaves the allocator's reservations and future
 * numbering exactly as they were.
 */
export function allocateInCreationKeyOrder<K extends IdKind>(
  allocator: IdAllocator,
  kind: K,
  creationKeys: Iterable<string>,
): ReadonlyMap<string, IdTypeByKind[K]> {
  assertValidKind(kind);

  const keys = [...creationKeys];
  const seenInBatch = new Set<string>();
  for (const creationKey of keys) {
    assertValidCreationKey(creationKey);
    if (seenInBatch.has(creationKey)) {
      throw new Error(
        `duplicate creation key ${JSON.stringify(creationKey)} for id kind "${kind}" ` +
          "within the same batch: each creation key may allocate at most one identity per run",
      );
    }
    seenInBatch.add(creationKey);
    if (allocator.hasCreationKey(kind, creationKey)) {
      throw new Error(
        `creation key ${JSON.stringify(creationKey)} for id kind "${kind}" was already used ` +
          "by this allocator: each creation key may allocate at most one identity per run",
      );
    }
  }

  const sortedKeys = keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = new Map<string, IdTypeByKind[K]>();
  for (const creationKey of sortedKeys) {
    result.set(creationKey, allocator.allocate(kind, creationKey));
  }
  return result;
}
