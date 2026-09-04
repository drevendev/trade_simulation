# 3. Canonical IDs are branded strings from a run-owned sequential allocator

Date: 2026-09-04
Status: Accepted

## Context

`REQ-CORE-001` requires all thirteen canonical entity ID kinds named in
`docs/spec/mirror/06 - Handoff/01 — CORE_SCHEMA_AND_LIFECYCLES.md` section 2
(`RegionId` … `GoodId`) to be opaque, kind-distinct, never derived from an array
index or map iteration order, deterministically replayable across independent runs
of the same scenario, and never reused after an entity retires (`CORE-T16`).

The spec fixes the string prefixes (`r:`, `s:`, `c:`, `pc:`, `pu:`, `m:`, `tl:`,
`cur:`, `ma:`, `sh:`, `bond:`, `ev:`, `good:`) and, for dynamic State creation,
already endorses a monotonic counter (`WorldState.nextDynamicStateSequence`) rather
than a content hash. This decision generalizes that pattern to all thirteen kinds
and fixes the caller contract the spec leaves open: what makes two independent
allocators agree, and what stops iteration-order drift from silently changing
identity assignment.

## Decision

**Kind-branding.** Each ID type is `string & { readonly [tag]: Kind }`
(`src/domain/id.ts`). At runtime it is a plain string; at the type level, `RegionId`
and `StateId` are not mutually assignable, and neither is assignable from a bare
`string` literal without an explicit cast. `id.typecheck.test.ts` pins this as a
`tsc --noEmit` regression, not just a runtime assertion, using `@ts-expect-error` on
the mismatched assignments — an unused directive is itself a type error under this
repo's strict config, so the test fails loudly if kind separation is ever weakened.

**One allocator per run, not a module singleton.** `createIdAllocator()` returns
fresh, independent closure state: a per-kind monotonic sequence counter, a
creation-key dedupe map, and allocated/retired ID sets. Nothing is module-level
mutable state, satisfying "keep allocator state owned by one run."

**IDs are `${prefix}:${sequence}`, sequence assigned by call order, not by content
hash.** This matches the spec's own dynamic-State-sequence precedent and keeps IDs
cheap and legible in debug output, at the cost of pushing the determinism guarantee
onto *call order* rather than onto the ID value itself.

**Call order is made deterministic by a creation-key contract, not by trusting
collection iteration.** Every `allocate(kind, creationKey)` call takes a caller-owned
`creationKey` string identifying the creation event (a scenario-declared name for
genesis entities, a structured cause string such as
`state-formation:tick-42:region-r:7` for dynamic entities). Two independent
allocators fed the same `(kind, creationKey)` sequence in the same order always
produce the same IDs — this is the cross-run replay guarantee the acceptance
criteria require, and `id.test.ts` proves it directly with two allocator instances.

Because JS `Map`/object iteration order depends on construction history that can
drift for reasons unrelated to simulation logic, callers must not derive the
`allocate()` call sequence directly from map/object enumeration. The documented
contract, exercised by `allocateInCreationKeyOrder`, is: collect the creation keys
for a batch, sort them ascending (plain string comparison), then allocate in that
order. `id.test.ts` proves the resulting creation-key-to-ID mapping is identical
regardless of whether the caller's input array or `Map` was built forwards,
backwards, or shuffled. This is a stopgap default ordering for this bounded unit of
work; a scenario that needs a different canonical order (e.g. declaration order from
a config file) can supply pre-sorted keys directly to `allocate()` instead of going
through the helper — the helper is a convenience, not the only legal call path.

**Duplicate creation keys fail explicitly, they do not idempotently return the
existing ID.** A repeated `creationKey` for the same kind within one run throws. A
retry-shaped idempotent allocate was considered and rejected: it would silently
mask "this code path ran twice for the same entity" bugs, which is exactly the class
of corruption `CORE-T16` and the "duplicate/invalid identity inputs fail explicitly"
acceptance criterion exist to catch.

**Retirement is a permanent, explicit, guarded state transition, not merely "stop
using this ID."** `retire(kind, id)` throws if `id` was never allocated by this
allocator, if it is already retired, or if its prefix does not match `kind`. Because
the underlying counter is monotonic and per-kind, no future `allocate()` call can
ever reproduce a previously issued ID even without `retire()` — `retire()`/
`isRetired()` exist so callers get an explicit, queryable historical-unavailable
signal (matching `CORE-T16`'s "resolve only to that original lifecycle instance or
an explicit historical-unavailable state") instead of having to track retirement
themselves.

## Scope

This unit of work is ID primitives and their allocator only: the 13 branded ID
types, `createIdAllocator`, `allocateInCreationKeyOrder`, and their tests. It does
not implement `WorldState`, entity registries, keyed RNG, config, world genesis, or
the tick orchestrator — those are separate M1/M2 requirements (`REQ-CORE-002..006`,
`REQ-CONFIG-*`) that will consume this allocator rather than re-solve identity.

## Consequences

**Callers own creation-key discipline.** The allocator cannot detect every possible
non-deterministic call order on its own — it can only guarantee that *given* a
deterministic call sequence, the IDs are deterministic, and that a duplicate key is
rejected. World genesis and tick-phase code that later calls `allocate()` must
follow the sorted-creation-key contract (or supply another documented deterministic
order); this is a review responsibility until a future unit adds an integration-level
guard.

**Sequence-based IDs reveal allocation order.** Unlike a content hash, `r:7` tells an
observer roughly when region 7 was created relative to other regions of the same
kind. The spec treats IDs as opaque (callers must not parse them), so this is an
accepted debuggability side effect, not a contract violation.

## Alternatives considered

- **Content-derived IDs (hash or slug of the creation key).** Rejected for dynamic
  entities: the spec explicitly wants a sequence-style allocator for State formation,
  and a hash scheme would need a separate collision/uniqueness story for entities
  that legitimately share a natural key (e.g. two successor cohorts from the same
  split). A sequence counter sidesteps that entirely.
- **Idempotent `allocate()` (return the existing ID for a repeated creation key).**
  Rejected: masks duplicate-creation bugs instead of surfacing them; see Decision.
- **A module-level default allocator for convenience.** Rejected: directly
  contradicts "keep allocator state owned by one run, not a shared module
  singleton," and would make two runs in the same process (e.g. two test files)
  silently share sequence counters.
