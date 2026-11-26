# M5 integrated acceptance evidence (REQ-ACCEPTANCE-006)

Implementation evidence, not specification authority. Parent #676 remains open.
Evidence cutoff: master `c8450a632bf6e1ab65b1643fad7e22bc123c9238`
(2026-11-26). The following maps the seven parent acceptance criteria to
bounded merged tests; a bounded witness is not an exhaustive gate verdict.

| Criterion in #676 | Merged evidence | Remaining scope / limitation |
| --- | --- | --- |
| 1. Closed border, zero capacity and zero usable FX halt affected trade; local markets survive | [#1168](https://github.com/drevendev/trade_simulation/pull/1168): separate closure/capacity controls with 12 ticks of local trade. [#1163](https://github.com/drevendev/trade_simulation/pull/1163): zero payout reserve isolates a corridor while another corridor and local paid trade remain active. [#1183](https://github.com/drevendev/trade_simulation/pull/1183): zero infrastructure factor suppresses paid dispatch and FX output. | Funded comparison in #1168 is a first-tick witness; #1183 covers one directed corridor. |
| 2. Insufficient FX shrinks shipment before stock mutation | [#1166](https://github.com/drevendev/trade_simulation/pull/1166): funded vs positive insufficient payout reserve; gross paid quantity, actual seller INPUT debit, surviving cargo, loss and reserve floor reconcile. | First-tick paired scenario, not an exhaustive intermediate-mutation or reverse-direction proof. |
| 3. Buyer/pool/seller cash reconciles and charges have named recipients | [#994](https://github.com/drevendev/trade_simulation/pull/994): shared finite FX competition. Current m5ActiveCycleGolden.test.ts: repeated paid bundles, per-owner/pool balances, independently derived charge recipients, misrouting controls; [#1161](https://github.com/drevendev/trade_simulation/pull/1161): concurrent independent FX pairs. [#1170](https://github.com/drevendev/trade_simulation/pull/1170): direct shared-currency payment without pool mutation. | Fixture reconciliation uses numeric tolerances; do not equate it with the separate exact-stock precision backlog. No four-currency genesis certification. |
| 4. No double-owned cargo; delivery and loss reconcile | Current m5ActiveCycleGolden.test.ts: Phase-1 arrival owner/bucket and loss controls; [#1173](https://github.com/drevendev/trade_simulation/pull/1173): gross seller INPUT debit, carried/new shipment ownership, compensated stock/cargo corruption and cross-tick ID reuse checks. | Active oracle is fixture-specific (closing workshop INPUT and delayed routes). |
| 5. Capacity and residual intent anti-double-use | [#1175](https://github.com/drevendev/trade_simulation/pull/1175): Phase 6–8 receipt-driven quantity/cash oracle; [#1177](https://github.com/drevendev/trade_simulation/pull/1177) and [#1179](https://github.com/drevendev/trade_simulation/pull/1179): actual shared seller/buyer and forged overdraw controls; [#1181](https://github.com/drevendev/trade_simulation/pull/1181): gross vs surviving load and loss-hidden overdraw; [#1183](https://github.com/drevendev/trade_simulation/pull/1183): infrastructure factors 1, 0.5 and 0, saturation and negative witness. | Phase-6 opening is post-procurement; Phase-4-to-6 projection needs explicit independent evidence or a verified existing regression. |
| 6. Same-input and reordered-registry replay | [#1162](https://github.com/drevendev/trade_simulation/pull/1162): 600 carried ticks with active production/consumption/trade, independent FX pairs and reordered replay. Current active suite retains the five variants and actual shared seller/buyer replay controls. | Late activity is production OR consumption OR paid sales, not proof of continuous per-pair trade. No claim of all topologies/seeds. |
| 7. Earlier M3/M4 gates remain green | REQ-ACCEPTANCE-004 and -005 remain IMPLEMENTED in the ledger. [#1183 CI](https://github.com/drevendev/trade_simulation/actions/runs/45797422743) succeeded; independent acceptance reports 2033 TS tests, 45 retained .NET tests and 900 policy tests. | Evidence is for the accepted candidate before merge, not a separately executed post-merge suite. Open exact-stock issues #799 and related precision backlog remain independent. |

## Next bounded development candidate

Trace the Phase-4 procurement-to-Phase-6 MAIN residual projection. If the
current tests do not independently bind actual procurement receipts to
remaining quantity and spend, add a real-orchestrator witness and negative
control. Do not reimplement an already proved invariant. Review the remaining
M5 runtime requirement rows separately; neither this map nor passing a
bounded fixture promotes them or the milestone.

This file records evidence only. It changes no economic formula, default,
phase ordering, specification mirror, or release authority.
