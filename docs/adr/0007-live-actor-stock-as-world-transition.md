# 0007 — Live actor stock settles as a WorldState transition, not an in-place mutation

- Status: accepted
- Date: 2026-09-14
- Issue: [#427](https://github.com/drevendev/trade_simulation/issues/427)
- Requirement: prerequisite of `REQ-MARKET-005`; unblocks `REQ-MARKET-005`'s
  canonical-stock-neutrality acceptance clause and Issue #416.

## Context

Until now `WorldState` carried no live wallet or inventory at all. `ClanState`,
`CohortState`, `ProductionUnitState` and `StateState` held identity and an immutable
`seed`; the only stock record was `worldGenesisLedger`, written once during
`buildInitialWorld()` and never rewritten. Local market settlement
(`marketSettlement.ts`) constructed `MARKET_SALE` / `CONSUMPTION_TAX` transaction records
and mutated nothing, so every accounting proof in the M3 acceptance suite had to build its
own test-local `Map` wallets and inventories.

Handoff/04 section 35 names `MarketSettlement.executeAllocation(world, ctx, allocation)` as
the boundary where mutation belongs. Issue #427 requires live, mutable wallet and inventory
stock on the actor states that canonically own it, and that `executeAllocation` write to it.

"Mutable" admits two readings, and the choice is expensive to reverse once callers depend
on it:

1. **In-place** — each actor holds a `Map` that settlement writes through. A caller holding
   a `WorldState` reference sees the balance change under it.
2. **Transition** — each actor holds a read-only map, and settlement returns a new
   `WorldState` carrying the new balances. The caller decides when the settled world
   becomes authoritative.

## Decision

Live actor stock is a **transition**. `executeAllocation(world, ctx, allocation)` returns
the resulting `WorldState`; it never writes through the world it is given.

## Consequences

Chosen because the repository already answered this question for the other half of the same
sentence in Handoff/04 section 11. Persistent truth after execution is *actor stock +
transaction ledger + LocalMarket price/expectation state*; the third of those,
`LocalMarketState.priceByGood`, is already a `ReadonlyMap` carried forward by
`applyMarketStateTransition()`, which returns a new `WorldState`. Making actor stock behave
differently would put two mutation models inside one settlement boundary.

It also preserves an invariant `tickOrchestrator.ts` currently relies on: `WorldState` is
immutable for the duration of one `executeTick()` call. In-place stock would break that
silently — a phase handler could observe a balance that a later handler in the same tick had
already changed, and replay would depend on handler order rather than on phase order.

The immediate cost is that the telemetry on/off neutrality proof Issue #416 wants becomes a
comparison of two returned worlds rather than of one world before and after, and that a
caller that forgets to keep the returned world silently drops the settlement. The second is
a real hazard; it is the same hazard `applyMarketStateTransition()` already carries, and the
negative control that PR #441 added for it (skipping the persistence call leaves state
observably stuck) is the pattern to repeat when Phase-8 is wired to call this boundary.

Handoff/04 section 10's atomicity rule — "No mutation is applied unless all debits and
inventory removals pass preflight validation" — becomes structural under this decision
rather than a matter of unwinding: every endpoint resolution and balance check runs before
the first `WorldState` is rebuilt, so a refused allocation cannot leave a partial write
behind.

## Alternatives considered

**In-place mutable maps.** Closer to a literal reading of "live, mutable" in Issue #427 and
to the spec's imperative step list in section 10 (`seller inventory[g] -= q`). Rejected: it
contradicts the immutability `executeTick()` depends on, and it would make `WorldState`
identity useless for the very neutrality comparison this work exists to enable.

**A generic wallet/inventory container on `WorldState`.** Explicitly ruled out by Issue
#427's non-goals and by the researcher's 2026-09-11 conformance note: it duplicates
canonical ownership, and one stock must have one owner (Handoff/01 sections 5.3/5.4/7).
