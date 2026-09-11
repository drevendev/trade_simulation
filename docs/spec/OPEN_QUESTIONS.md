# Open questions

Append-only. Questions that block implementation and cannot be resolved from the
specification alone. The researcher agent reads this file directly over HTTPS.

A question belongs here only when proceeding under any assumption would either be
unsafe or would make the work useless if the assumption turns out wrong. Everything
else is decided locally and recorded as a Decision on the Issue.

Each entry uses this shape:

```text
## Q-NNN — REQ-AREA-NNN — <the question, as a question>

Status:   OPEN | ANSWERED | WITHDRAWN
Blocks:   the Issues or requirement IDs that cannot proceed
Context:  what is already established, and what was tried
Options:  the candidate answers considered, with consequences
Answer:   filled in when the researcher responds, with the date
```

---

## 2026-09-03 — channel opened

No open questions. The specification mirror is not yet synchronized.

The first question is already known and is being asked out of band, because it
concerns the structure of the specification rather than its content: the
specification needs a navigation layer (`REQUIREMENTS_REGISTRY.csv`,
`SPEC_CHANGELOG.md`, `EXECUTION_ORDER.md`) so that a run can reach one requirement
without reading the whole folder.

---

## Q-001 — REQ-MARKET-005 / REQ-ACCEPTANCE-004 — Can CLAN be a Phase-8 local-market buyer/seller of physical goods, given ClanState must not own a physical-goods inventory?

Status:   OPEN
Blocks:   REQ-MARKET-005 canonical-stock-neutrality closure (Issue #416), the
          remaining wiring half of Issue #427 (`MarketSettlement.executeAllocation`
          called by Phase-8 for every realized MAIN-pass allocation)
Context:  Issue #427 (owner QA finding, 2026-09-11) fixed canonical stock ownership
          as: ClanState owns only a live treasury, never a physical inventory;
          PopulationCohortState owns wallet + householdInventory; ProductionUnitState
          owns wallet + input/output/investmentInventory; StateState owns treasury +
          publicInventory. `ActorRef` (`src/domain/genesisLedger.ts`) is a closed
          union of `CLAN | STATE | PRODUCTION_UNIT | MONETARY_AUTHORITY` — there is no
          `COHORT` variant. Every fixture in the already-merged M3 acceptance suite
          (`acceptance-004-m3-golden-gate.test.ts`, all of MTFX-T1..T6/I1..I6, and the
          local-shortage golden scenario, Handoff/04 §40 scenario A) uses `CLAN` as
          both the buyer and the seller with `inventoryBucket: "GENERAL"`. Under the
          corrected ownership rule, `ClanState` has no canonical `GENERAL` goods
          endpoint, so a real `executeAllocation(world, ctx, allocation)` boundary
          (implemented in Issue #427, `src/simulation/marketSettlementTransition.ts`)
          must throw for every one of those existing fixtures rather than invent a
          Clan inventory. Wiring `executeAllocation` into the production Phase-8
          handler unconditionally would therefore break the accepted
          `REQ-ACCEPTANCE-004` evidence (which stays green precisely because Phase-8
          currently only constructs transaction records and touches no `WorldState`).
          Issue #427's own PR intentionally stopped short of that wiring for this
          reason and proved conservation instead against a `PRODUCTION_UNIT`-only
          fixture.
Options:  (a) Add a `COHORT` `ActorRef` variant and a canonical rule that ordinary
          household `CONSUMPTION`-purpose local-market participation is always a
          `PopulationCohortState` actor (never `CLAN`), then re-author the M3
          acceptance fixtures to use `PRODUCTION_UNIT`/`COHORT`/`STATE` actors with
          real buckets instead of `CLAN`+`GENERAL` — a non-trivial rewrite of already
          -accepted MTFX-T1..T6/I1..I6 test fixtures and the local-shortage golden
          scenario, though no formula/mechanism changes.
          (b) Treat `CLAN`+`GENERAL` as a legitimate, narrower canonical endpoint
          for M3 only (e.g. a Clan-level pooled household goods stock), explicitly
          superseding the 2026-09-11 QA finding that forbade it — this reopens the
          question that finding was meant to close.
          (c) Leave `CLAN`+`GENERAL` settlement permanently out of `executeAllocation`'s
          scope (current state after Issue #427) and accept that Phase-8's per-tick
          `WorldState` wiring, and therefore `REQ-MARKET-005`'s canonical-stock-
          neutrality proof and `REQ-VISUALIZATION-006`'s dependency on it, can only
          close once the M3 fixtures stop using CLAN as a physical-goods actor.
Answer:
