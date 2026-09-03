MONETARY \+ CURRENCY IMPLEMENTATION CONTRACTS — Economic Simulation

Status: implementation-ready v1 contract.  
Authority on conflicts: IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01 \> this document \> mature MONETARY\_AND\_CURRENCY design. Compatible with CORE\_SCHEMA\_AND\_LIFECYCLES, MARKETS\_TRADE\_FX\_CONTRACTS, STATE\_FISCAL\_LAWS\_CONTRACTS and the canonical 16-phase tick.

1\. Boundary and design intent

This subsystem owns currency metadata, MonetaryAuthority state, transaction-money reconciliation, CPI/inflation measurement, bounded policy-rate setting, explicit central-bank sovereign-bond operations, monetary-union membership, foreign-legal-tender behavior, monetary statistics and Phase-11 FX/monetary reconciliation.

It does not own local market clearing, trade route selection, fiscal budget decisions, sovereign debt creation, Clan portfolios, ProductionUnit investment, population demand, jurisdiction changes or event effects. Those domains provide realized transactions and lagged statistics; Monetary consumes them and emits policy state, planned financial operations and diagnostics.

Core v1 deliberately excludes commercial banks, private credit, deposits created by lending, reserve requirements, household/firm loans, interbank markets, yield curves, foreign-currency sovereign debt, discretionary exchange-rate pegs and direct policy-rate multipliers on consumption/production. The Bank of England’s money-creation explanation supports the accounting distinction between money creation and wealth creation, while ECB transmission material makes clear that policy-rate effects normally run through represented financial channels rather than magic direct demand modifiers. BIS balance-sheet framing supports explicit matched financial assets/liabilities. 

2\. Canonical persistent schema

Currency:  
\- id: CurrencyId  
\- code: string  
\- displayName: string  
\- issuerAuthorityId: MonetaryAuthorityId | null  
\- decimals: integer  
\- inflationTargetAnnualized: number  
\- minPolicyRateAnnualized: number  
\- maxPolicyRateAnnualized: number  
\- neutralNominalRateAnnualized: number  
\- monetaryOperationShareCap: number  
\- monetaryOperationAbsoluteCap: Money  
\- nextPolicyReviewTick: Tick

Currency does not own a State-wide regime or a duplicate membership list. FOREIGN\_LEGAL\_TENDER is a State-to-Currency relationship represented by State.effectiveCurrencyRegime; MonetaryAuthority.memberStateIds is the sole policy-membership list. A Currency keeps the same issuerAuthorityId even when a non-member State uses it as foreign legal tender.

MonetaryAuthority:  
\- id: MonetaryAuthorityId  
\- currencyId: CurrencyId  
\- memberStateIds  
\- policyRateAnnualized  
\- inflationEmaAnnualized  
\- activityStressEma  
\- depreciationStressEma  
\- nominalTransactionValueEma  
\- stateBondHoldingIds: BondHoldingId\[\]  
\- foreignReserveWallet: Wallet  
\- cumulativeIssued: Money  
\- cumulativeDestroyed: Money  
\- retainedCouponEarnings: Money  
\- nextPolicyReviewTick  
\- configId

State keeps its effective currency relationship in canonical State.effectiveCurrencyRegime; its currency is State.effectiveCurrencyRegime.currencyId. State fiscal/debt logic owns StateBond creation; Monetary only reads eligible StateBond/BondHolding records and may change holdings through explicit operations.

3\. Transaction money supply

For currency c:  
M\_tx\[c\] \= sum of Wallet\[c\] held by all non-issuer actors and explicit settlement/liquidity pools.

Included: PopulationCohort wallets, Clan treasury wallets, ProductionUnit wallets, State treasuries, FX liquidity pools and foreign MonetaryAuthority reserve holdings when represented.

Excluded: StateBond principal, inventories, installed capital, pending commitments, nominal asset valuations, issuer bookkeeping equity and the issuing MonetaryAuthority’s own currency as a spendable asset.

Identity per currency/tick:  
M\_tx\_close \= M\_tx\_open \+ explicitIssuance \- explicitDestruction.

Ordinary wages, purchases, taxes, transfers, dividends, debt issuance between non-authority actors, private debt service and FX swaps conserve each currency globally except where an issuer operation explicitly creates or extinguishes its own currency.

4\. Currency-regime rules

INDEPENDENT\_FLOAT: one MonetaryAuthority governs the currency. Domestic prices/taxes/wages/transfers/new sovereign bonds default to home currency. Cross-currency settlement uses canonical settleFx.

MONETARY\_UNION: multiple States share exactly one Currency and MonetaryAuthority. Fiscal treasuries/debts remain separate. There is no FX conversion among union members. Policy signals aggregate over the whole currency area. No State-level policy rate exists.

FOREIGN\_LEGAL\_TENDER: State.effectiveCurrencyRegime references a Currency issued by another MonetaryAuthority, sets policyAuthorityId \= null, and the State is absent from that authority's memberStateIds. The State may tax/spend/borrow in that currency but has no monetary operation rights and cannot change policy. The Currency's issuerAuthorityId is unchanged.

Successor/new States created by expansion default to FOREIGN\_LEGAL\_TENDER in the previous effective currency unless scenario configuration says otherwise before run start. No endogenous monetary-union accession exists in core v1.

5\. CPI and inflation measurement

Inflation is derived from actual LocalMarket consumer prices; money growth never directly sets prices.

For State s and tick t:  
logCpiChange\[s,t\] \= sum\_g weight\[s,g,t-1\] \* ln(P\[s,g,t\] / P\[s,g,t-1\]).  
CPI\[s,t\] \= CPI\[s,t-1\] \* exp(logCpiChange\[s,t\]).

Weights are lagged realized household expenditure shares using tax-inclusive household prices, normalized to 1\. Essential categories receive a small configured minimum weight before renormalization so famine/unavailability cannot mechanically erase essentials from the index.

If a good has zero realized household trades this tick, use the valid posted LocalMarket buyer-gross price; if unavailable, carry the last valid price and separately report unavailability/shortage. Never impute zero or a synthetic cheap price.

Currency-area inflation for a monetary union aggregates State log price changes using lagged final-consumption/population weights.

Monthly/tick inflation \= CPI\_t / CPI\_t-1 \- 1\. Annualization uses calendar ticksPerYear. Policy uses EMA/trailing annualized inflation, not one-tick noise.

6\. Activity and depreciation stress

activityStressRaw \= weighted bounded combination of:  
\- unemployment rate above configured comfortable rate;  
\- essential-demand shortage/affordability stress;  
\- negative real transaction-volume growth.

activityStressEma \= EMA(activityStressRaw), clamped \[0,1\].

For floating currencies with active FX pairs:  
depreciationStressRaw \= weighted mean of positive annualized depreciation versus material trading currencies, weighted by lagged trade value and capped.  
depreciationStressEma \= EMA(depreciationStressRaw), clamped \[0,1\].

These are policy inputs and diagnostics only. They never directly modify productivity, consumption, migration or prices.

7\. Policy-rate rule

At policy review, using only completed prior-close statistics:  
inflationGap \= inflationEmaAnnualized \- inflationTargetAnnualized  
rawTargetRate \= neutralNominalRateAnnualized  
              \+ inflationResponse \* inflationGap  
              \- activityResponse \* activityStressEma  
              \+ fxDefenseResponse \* depreciationStressEma

nextRate \= clamp(  
  currentRate \+ adjustmentSpeed \* (rawTargetRate \- currentRate),  
  minPolicyRateAnnualized,  
  maxPolicyRateAnnualized)

The review result becomes effective only through PendingTransitions.monetaryPolicyChanges with activateTick \>= currentTick+1. A current-tick price shock cannot retroactively change current-tick settlement.

Represented transmission channels only:  
\- coupon anchor for newly planned StateBond issuance;  
\- Clan bond-demand comparison versus opportunity-return EMA;  
\- FX attractiveness/pressure term where permitted;  
\- size/direction of bounded monetary operations.

No direct rate multiplier on production, household shopping, births, wages or capital.

8\. Monetary operation plan

MonetaryOperationPlan:  
\- operationId  
\- authorityId  
\- currencyId  
\- createdAtTick  
\- executeTick  
\- direction: EXPANSION | CONTRACTION  
\- maxCashAmount  
\- eligibleBondIds  
\- orderedCandidateHoldingIds  
\- reasonFacts\[\]  
\- status: PLANNED | EXECUTED | PARTIAL | UNFILLED | CANCELLED

Planning happens during the Phase-15 close/review using prior-close data. Execution happens in Phase 1 before current-tick planning and markets.

easingPressure \= clamp(  
  \-inflationWeight \* inflationGap  
  \+ activityWeight \* activityStressEma  
  \- depreciationDefenseWeight \* depreciationStressEma,  
  \-1, 1\)

operationBudget \= min(  
  abs(easingPressure) \* monetaryOperationShareCap \* nominalTransactionValueEma,  
  monetaryOperationAbsoluteCap)

No minimum fill is guaranteed. Zero eligible supply/demand is valid.

9\. Expansion operation: MonetaryAuthority buys an existing bond holding

Eligibility: active home-currency StateBond, eligible Clan holder, not already due this tick, legal capital access, principalShare \> 0, seller liquidity-preference rule permits sale.

For transferred principal x and purchase price x at par in core v1:  
\- Clan BondHolding principalShare \-= x  
\- create/increase MonetaryAuthority BondHolding by x  
\- Clan wallet\[currency\] \+= x  
\- cumulativeIssued \+= x  
\- M\_tx\[currency\] \+= x

StateBond.principalOutstanding is unchanged. State receives no cash. This is not debt issuance and not fiscal revenue.

10\. Contraction operation: MonetaryAuthority sells its bond holding

Eligibility: Authority owns principal, Clan has spendable home-currency cash above protected liquidity reserve, Clan bond-demand rule is positive, law permits holding.

For transferred principal x at par:  
\- Clan wallet\[currency\] \-= x  
\- MonetaryAuthority BondHolding principalShare \-= x  
\- create/increase Clan BondHolding by x  
\- cumulativeDestroyed \+= x  
\- M\_tx\[currency\] \-= x because currency returning to its issuer is extinguished

Never allow x above Authority-held principal or Clan spendable cash. Partial deterministic fill is normal.

11\. Deterministic allocation for monetary operations

Compute all eligible candidate capacities before mutating state. If aggregate eligible capacity exceeds operationBudget, allocate proportionally by eligible capacity times bounded willingness weight. Apply caps, redistribute residual iteratively, then assign floating-point residue by stable BondHoldingId/ActorRef order.

No RNG is needed. A candidate cannot reuse cash/principal already reserved by another Phase-1 financial operation. Use the shared financialCommitmentLedger from core/fiscal contracts.

Complexity per operation review/execution is O(H\_eligible log H\_eligible) only if stable sorting is required; with pre-sorted IDs it is O(H\_eligible).

12\. Central-bank-held debt service

Phase-10 fiscal debt service remains authoritative.

If a MonetaryAuthority holds a share of a home-currency StateBond:  
\- principal repayment debits State treasury and extinguishes received issuer currency; reduce StateBond principalOutstanding and Authority BondHolding principalShare equally; cumulativeDestroyed increases by principal paid.  
\- coupon payment debits State treasury; the issuer-side receipt is not spendable own-currency cash. Record it in retainedCouponEarnings and cumulativeDestroyed increases by the coupon amount.

No automatic remittance back to the State in core v1. This deliberate simplification may create slow contraction when Authority holdings are large, but it avoids a second fiscal transfer loop. Benchmark this; add annual remittance only if persistent distortion is material.

13\. FX contract ownership

MARKETS\_TRADE\_FX\_CONTRACTS remains authoritative for FXLiquidityPool, quoteFx, reserve/commit semantics and settleFx. Monetary must not implement a second converter or separate pool.

One pairwise finite pool is shared continuously across every phase and payment type in the tick: trade, tariffs where needed, Clan cross-border funding, foreign bond purchases, migration wallet conversions and other explicitly permitted cross-currency flows.

Monetary owns only Phase-11 FX reconciliation and next-rate update inputs, not Phase-7 settlement.

14\. Phase-11 FX rate update

For each active unordered currency pair A/B, after all same-tick FX settlements:  
\- compute signed netFlowPressure from realized pool exchanges;  
\- compute reserveImbalance from deviation of post-settlement reserve shares from targetReserveShare;  
\- compute bounded policyDifferentialPressure from lagged/effective policy rates;  
\- optionally compute bounded tradeBalancePressure from lagged realized goods flows.

rawLogMove \= flowCoeff \* flowPressureEma  
           \+ reserveCoeff \* reserveImbalance  
           \+ rateCoeff \* policyDifferentialPressure  
           \+ tradeCoeff \* tradeBalancePressure

logMove \= clamp(rawLogMove, \-maxLogRateMovePerTick, \+maxLogRateMovePerTick)  
spotRateNext \= spotRateCurrent \* exp(logMove)

The new spot rate becomes the opening quote for next tick. Current-tick transactions already settled at quotes derived from the current opening rate and within-tick pool state. No retroactive repricing.

FX pool cash is never manufactured by the rate update. A price change changes only the relative quote, not either reserve inventory.

15\. FX pool capitalization and reserves

Initial pool inventories are scenario stocks and therefore part of initial M\_tx for each currency.

Any later pool recapitalization must be an explicit transfer:  
\- from an existing actor wallet: currency ownership moves, M\_tx unchanged;  
\- from the issuing MonetaryAuthority: explicit issuance in its own currency matched to a documented reserve/liquidity operation, cumulativeIssued and M\_tx increase exactly.

Core v1 does not let a pool borrow, go negative or synthesize missing quote currency. If minOperationalReserve would be breached, settleFx returns a partial fill or zero.

16\. Foreign reserves

MonetaryAuthority.foreignReserveWallet may hold only currencies issued by other authorities. Such balances are ordinary outstanding foreign currency and are included in the foreign currency’s M\_tx.

Core v1 uses reserves only for explicit scenario initialization and optional FX-pool capitalization operations. There is no discretionary FX intervention/peg defense. This keeps floating FX and monetary operations understandable.

17\. Money issuance/destruction records

MonetarySupplyChangeRecord:  
\- id  
\- tick  
\- phase  
\- authorityId  
\- currencyId  
\- type: OMO\_PURCHASE\_ISSUANCE | OMO\_SALE\_DESTRUCTION | AUTHORITY\_DEBT\_PRINCIPAL\_DESTRUCTION | AUTHORITY\_DEBT\_COUPON\_DESTRUCTION | FX\_POOL\_CAPITALIZATION\_ISSUANCE | OTHER\_FORBIDDEN\_IN\_CORE  
\- amount  
\- originatingOperationId / bondId  
\- counterparty ActorRef | null  
\- explanationFactIds\[\]

Every nonzero delta between M\_tx\_open and M\_tx\_close must reconcile to these records. Ordinary EconomicTransactions must never be mislabeled as issuance/destruction.

18\. Phase integration

Phase 1: activate due monetary policy changes; execute previously planned OMO and fiscal debt issuance in shared deterministic financial-operation ordering; freeze effective policy rate for tick.  
Phases 2-10: no policy recomputation. FX pools settle ordinary permitted conversions through canonical settleFx. Phase-10 debt service may destroy issuer currency when MonetaryAuthority is holder.  
Phase 11: reconcile per-currency M\_tx; reconcile every FX pool inventory and realized exchange; update FX flow EMAs and spotRateNext; compute current CPI/inflation/activity/depreciation observations for diagnostics.  
Phases 12-14: monetary state is read-only except derived snapshots and ExplanationFacts.  
Phase 15 close: run invariants; on review cadence compute the next policy rate and optional MonetaryOperationPlan for future Phase 1\.

19\. Accounting invariants

M01 every monetary amount has explicit currencyId.  
M02 every actor Wallet balance is finite and \>= 0 in no-credit core v1.  
M03 issuer own-currency received by MonetaryAuthority is never stored as spendable wallet cash.  
M04 M\_tx\_close \= M\_tx\_open \+ recorded issuance \- recorded destruction per currency.  
M05 ordinary same-currency transfers conserve M\_tx.  
M06 FX settlement conserves each currency globally; it only changes owners/pool inventories.  
M07 spot-rate updates never change currency inventories.  
M08 for INDEPENDENT\_FLOAT or MONETARY\_UNION States, effectiveCurrencyRegime.policyAuthorityId equals Currency.issuerAuthorityId and the State is listed in that MonetaryAuthority.memberStateIds; FOREIGN\_LEGAL\_TENDER States have policyAuthorityId=null and are not members.  
M09 FOREIGN\_LEGAL\_TENDER States never receive independent policy/OMO rights.  
M10 monetary-union States share one effective policy rate.  
M11 policy review uses only completed prior-close data and cannot affect current tick.  
M12 OMO purchases change bond holder and issue exactly settled cash; State debt principal unchanged.  
M13 OMO sales change bond holder and destroy exactly settled issuer cash; State debt principal unchanged.  
M14 BondHolding sums continue to equal StateBond.principalOutstanding after every OMO/debt-service operation.  
M15 Authority-held principal repayment reduces State liability and Authority asset equally.  
M16 Authority-held coupon payment does not reduce principal.  
M17 no monetary operation exceeds eligible bond principal, spendable counterparty cash or configured cap.  
M18 one shared financialCommitmentLedger prevents double-use of Phase-1 cash/principal.  
M19 one canonical finite FX pool exists per active currency pair; no subsystem-specific duplicate pool.  
M20 FX reserve inventories never go below configured operational minimum through settlement.  
M21 CPI uses tax-inclusive household prices and lagged weights; missing trade does not imply zero price.  
M22 inflation, activity stress and depreciation stress are diagnostics/policy inputs, never direct real-economy modifiers.  
M23 all policy/FX update ordering is deterministic under identical opening state/config/seed.  
M24 issuance/destruction records reconcile exactly to cumulativeIssued/cumulativeDestroyed deltas.  
M25 currency creation does not create goods, capital, population or State revenue unless a separate explicit transaction also changes those stocks.  
M26 StateBond issuance between ordinary actors conserves money and is not monetary issuance.

20\. Required tests

1 same-currency ordinary transfer conserves M\_tx.  
2 tax/wage/market/fiscal mixed transfers conserve M\_tx absent authority operations.  
3 OMO purchase increases Clan cash and M\_tx exactly by filled purchase amount.  
4 OMO purchase leaves StateBond principalOutstanding unchanged.  
5 OMO sale destroys exactly Clan payment and never makes Clan wallet negative.  
6 OMO partial fill respects seller/buyer capacity and cap.  
7 stable-ID residual allocation makes OMO replay deterministic.  
8 shared financialCommitmentLedger prevents cash reused by debt issuance and OMO in Phase 1\.  
9 Authority-held principal repayment destroys cash and reduces matched asset/liability equally.  
10 Authority-held coupon destroys cash but leaves principal unchanged.  
11 ordinary Clan-held debt service conserves currency globally.  
12 State primary debt issuance is financing only and does not change M\_tx.  
13 independent currency gets own policy rate; monetary-union members share one; foreign-legal-tender State gets none.  
14 newly formed State defaults to FOREIGN\_LEGAL\_TENDER with policyAuthorityId=null, preserves the Currency.issuerAuthorityId, and gains no MonetaryAuthority membership.  
15 CPI weighted log change matches fixture with multiple goods/regions.  
16 zero-trade good uses posted/last-valid price and reports shortage separately.  
17 policy-rate rule obeys bounds, inertia and one-tick causality.  
18 current-tick price shock cannot alter already-executed current-tick OMO/rate.  
19 FX settlement conserves both currencies and respects min reserves.  
20 Phase-11 rate update changes quote only, not pool inventory.  
21 Phase-11 new rate is first usable next tick.  
22 trade and foreign bond purchase compete for same finite FX pool.  
23 FX pool recapitalization from private wallet conserves M\_tx.  
24 FX pool recapitalization from issuer records exact issuance.  
25 cumulativeIssued/destroyed equals sum of supply-change records.  
26 mixed multi-currency tick reconciles M\_tx identities independently per currency.  
27 monetary-union CPI aggregation uses lagged member weights.  
28 activity/depreciation stress cannot mutate real stocks directly.  
29 no implicit foreign-currency spending bypasses settleFx.  
30 serialization/replay produces identical currency/authority/FX sequence.  
31 extreme configured shock/rate inputs remain finite under clamps.  
32 full invariant benchmark combines trade, taxes, foreign debt purchase, OMO, authority-held debt service and FX update.

21\. Golden scenarios

A demand-driven inflation: persistent shortages and rising market prices lift CPI; policy tightens gradually. Nothing directly suppresses demand; effects appear through sovereign/portfolio/FX channels.

B recession easing: weak activity with low inflation produces expansion pressure; Authority buys available Clan-held bonds, issuing cash. If no eligible holdings exist, operation remains partially/unfilled rather than inventing another channel.

C monetary-union divergence: one member overheats while another contracts; one shared policy reacts to area aggregate, exposing asymmetric consequences while fiscal policy remains State-specific.

D foreign-legal-tender State: fiscal choices diverge but monetary stance is imported; no local issuance or policy-rate action is possible.

E FX liquidity squeeze: large imports consume scarce destination currency in the pair pool; foreign bond purchase later in the tick partially fails; next-tick FX quote moves from realized pressure without creating reserves.

F contraction: high inflation causes Authority bond sales where Clan demand/cash exist, explicitly destroying currency; failure to find buyers leaves desired tightening partially unexecuted.

G authority debt-service contraction: a State services Authority-held debt; money supply falls exactly by paid coupon/principal while fiscal cash and debt identities reconcile.

H deterministic mixed world: two independent currencies \+ one monetary-union pair, trade, fiscal flows, OMO and a disaster replay bit-identically from same seed/config.

22\. Browser performance

Let C=currencies, A=MonetaryAuthorities, F=active FX pairs, H=eligible BondHoldings, G=consumer goods, R=regions.

Per tick: M\_tx reconciliation O(number of wallet currency entries); CPI O(active region-good consumer prices); FX reconciliation O(F); policy diagnostics O(C \+ F); OMO execution O(H\_eligible) plus deterministic ordering. Avoid all-pairs State/currency scans; index actors by held currencies and bonds by holder/issuer.

No matrix solver, optimizer, order book, bank balance-sheet network or multi-hop FX pathfinding is required. Browser target remains mesoscopic hundreds of cohorts/units, tens of regions, low-single-digit to low-double-digit currencies.

23\. Repository migration boundary

The existing trade\_simulation code has no first-class multi-currency/MonetaryAuthority layer, so monetary logic should be added as an orthogonal domain package rather than embedded in Market/Deal.

Recommended boundaries:  
\- domain/money: Currency, MonetaryAuthority, CPI/policy pure functions, supply reconciliation, OMO planning/execution  
\- domain/fx: canonical FXLiquidityPool/settleFx already introduced by Markets+Trade spec  
\- domain/fiscal: StateBond/BondHolding and debt-service ownership  
\- simulation/orchestrator: Phase 1 financial operations and Phase 11 reconciliation  
\- statistics/read-model: MonetarySnapshot, CurrencySnapshot, ExplanationFact only

Do not add currency-specific branches throughout production/population. Those systems use Wallet \+ effective local currency and call shared settlement services.

24\. Acceptance criteria

Implementation-ready when Currency/MonetaryAuthority schemas serialize canonically; every M\_tx delta has explicit issuance/destruction provenance; CPI/inflation derive from market facts; policy uses lagged bounded signals and activates prospectively; OMO changes only cash/bond ownership with exact accounting; StateBond/BondHolding remains authoritative; monetary-union/foreign-legal-tender behavior is unambiguous; all cross-currency settlement uses the single finite settleFx pool; Phase-11 updates FX quotes without changing inventories; M01-M26 and tests 1-32 pass; eight golden scenarios show expected directional behavior; UI can explain money-supply changes, inflation basket drivers, policy decision inputs, OMO fills/failures, FX reserve pressure and currency-regime membership from stored facts.

Conclusion

Core v1 monetary policy is intentionally narrow: fiat transaction cash, explicit sovereign-bond operations, endogenous market-price inflation and finite FX. It does not pretend to reproduce bank-credit transmission that the model does not contain. That keeps every monetary effect traceable to an owned stock, an explicit transaction or a next-tick policy rule while preserving meaningful divergence among independent currencies, monetary unions and foreign-legal-tender States.  
