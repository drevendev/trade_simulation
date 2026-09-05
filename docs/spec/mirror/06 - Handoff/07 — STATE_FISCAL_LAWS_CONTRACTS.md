STATE FISCAL \+ LAWS IMPLEMENTATION CONTRACTS — Economic Simulation

Status: implementation-ready v1 contract.  
Authority on conflicts: IMPLEMENTATION\_CONTRACT\_CONSISTENCY\_REVIEW\_01 \> this document \> mature STATE\_FISCAL\_AND\_LAWS design. Compatible with canonical core, markets/trade/FX, production/labor, population/clans and the 16-phase tick.

1\. Boundary

This subsystem owns State treasury accounting, taxes, transfers, grants, procurement envelopes, public-infrastructure funding/conversion inputs, State-owned-unit owner cash flows, sovereign debt, institutional influence aggregation, mutable fiscal/legal policy and next-tick policy activation.

It does not own market clearing, production, cohorts, labor allocation, FX liquidity/pricing, money issuance, migration, territorial control or events. It only supplies parameters, gates and explicit transactions.

Core v1 excludes detailed tax codes, evasion agents, government sublevels, politicians/elections, lobbying, household bond portfolios, tradable debt/yield curves, banks, magical public-service points, generic state-capacity bonuses and treasury overdrafts.

2\. Persistent schema

StateFiscalState:  
\- stateId  
\- treasury: Wallet  
\- publicInventory: Inventory  
\- publicInfrastructure: map\<RegionId, PublicInfrastructureStock\>  
\- fiscalPolicy: FiscalPolicyState  
\- institutionalProfile: InstitutionalProfile  
\- budgetPlan: StateBudgetPlan  
\- fiscalMetrics: FiscalMetricState  
\- fiscalStatus: NORMAL | STRESSED | DISTRESS | DEFAULT  
\- emergencyRule: EmergencyFiscalRuleState | null  
\- nextBudgetReviewTick  
\- nextPolicyReviewTick

Jurisdiction is not stored here. Effective jurisdiction is Region.controllerStateId. Future jurisdiction changes exist only in PendingTransitions.jurisdictionChanges and activate at Phase 1\.

PublicInfrastructureStock has exactly three authoritative stocks: transportCapital, logisticsUtilityCapital, civicBasicCapital, each \>= 0\. Downstream capacity/cost coefficients are derived, not independently mutable.

FiscalPolicyState includes labor-tax base/allowance/progressivity/max rate; businessProfitTaxRate; consumptionTaxRatesByCategory; tariffRatesByCategory; collectionEfficiency; transfer income/need targets and maxTransferPerCapita; reserveMonths; baselineBudgetShares; fiscalRule; mutablePolicy; optional minimumWageFloor; workerMobilityRestriction; unemploymentTransferEligible.

InstitutionalProfile includes franchise weights for population/assets/income, institutionalOfficeWeight, policyInertia, reformStepLimit, policyReviewCadenceTicks, minorityRecognitionRule and propertyAccessDefault.

MutablePolicyVector has exactly six core dimensions: redistribution, tradeOpenness, propertyOpenness, migrationSettlementOpenness, civilianSecurityPriority, reformOpenness. These map deterministically to concrete rates/gates; do not add bespoke named laws when these dimensions suffice.

StateBudgetPlan stores createdAtTick, validFromTick, revenue forecasts, mandatory outflow envelopes, transfer envelope, procurement/grant/State-owner-injection envelopes, plannedDebtIssuanceIds and minimumCashReserveByCurrency. Plans are maxima/commitments, not guarantees.

FiscalMetricState stores revenue/expenditure/debt-service EMAs, fiscalStressEma, recentDebtAuctionFillEma and recentMandatoryFundingGapEma. These are diagnostics/planning inputs only.

3\. Tax transaction record

TaxType \= WAGE\_INCOME | BUSINESS\_PROFIT | CONSUMPTION | TARIFF.  
TaxTransactionRecord stores id, tick, taxType, stateId, payer ActorRef, currencyId, taxBaseAmount, effectiveRate, assessedAmount, collectedAmount, originatingTransactionId, regionId, goodId and collectionEfficiencyApplied.

assessedAmount and collectedAmount are distinct. If collectionEfficiency \< 1, the uncollected amount stays with the payer; core v1 creates no tax-arrears asset.

4\. Jurisdiction

Tax jurisdiction uses only controller state effective at Phase 1\.  
\- wage tax: core default \= work-region controller  
\- profit tax: ProductionUnit.regionId controller  
\- consumption tax: buyer-local-market controller  
\- tariff: destination controller when origin and destination effective States differ

A Phase-14 jurisdiction decision cannot change current-tick taxes, tariffs, property, migration or FX treatment.

5\. Wage tax — Phase 5 atomic withholding

workerEq \= current allocated worker-equivalent count  
exempt \= allowancePerWorker \* workerEq  
taxable \= max(0, grossWage \- exempt)  
effectiveRate \= clamp(baseRate \+ progressivity \* bounded prior-close income signal, 0, maxRate)  
assessedTax \= taxable \* effectiveRate  
collectedTax \= assessedTax \* collectionEfficiency  
netWage \= grossWage \- collectedTax

Atomic identity:  
employer \-= grossWage  
cohort \+= netWage  
State treasury \+= collectedTax

No Phase-10 wage-tax debit is allowed. Phase 10 only aggregates/reconciles the already-settled records.

6\. Business profit tax — Phase 10

Operating results finalize by Phase 9\.  
taxableProfit \= max(0, realizedSalesRevenue \- realizedInputCashCost \- realizedGrossWageCost \- realizedTransportFees \- allowedDepreciationCharge)  
assessed \= taxableProfit \* businessProfitTaxRate  
collected \= min(assessed \* collectionEfficiency, spendable unit cash after protected obligations)

The depreciation allowance derives from the same installedCapital depreciation rule but never mutates capital twice. Core v1 has no loss refund/carry-forward. Dividends cannot reduce the already-finalized tax base. State-owned units may be explicitly exempt, but their dividends remain explicit State receipts.

7\. Consumption tax — Phase 4/8 atomic market settlement

assessedTaxPerUnit \= sellerNetPrice \* rate  
collectedTaxPerUnit \= assessedTaxPerUnit \* collectionEfficiency  
buyerGrossPrice \= sellerNetPrice \+ collectedTaxPerUnit  
For cleared quantity q:  
buyer debit \= q \* buyerGrossPrice  
seller credit \= q \* sellerNetPrice  
State credit \= q \* collectedTaxPerUnit

Affordability uses the collected-tax-inclusive gross price before clearing. assessedTaxPerUnit \- collectedTaxPerUnit remains with the buyer and is telemetry only; core v1 creates no arrears asset. Market price remains seller net price. No second Phase-10 debit. State self-purchases may be configured tax-exempt/netted.

8\. Tariff — Phase 7

Tariff applies only across an effective State border.  
landedCustomsValue \= invoice value \+ configured taxable transport component  
tariff \= landedCustomsValue \* destination tariff rate

Tariff is included before trade profitability/affordability and settles to destination State. Any cross-currency payment uses canonical settleFx exactly once and the same finite pool as trade/Clan flows. Tariff cash is never burned and never debited again in Phase 10\.  
9\. Household transfers — Phase 10

Core v1 has one automatic transfer channel. Eligibility requires population \> 0, current legal recognition/residency eligibility, and either low post-tax income or low essential-satisfaction signal.

incomeGap \= max(0, transferIncomeTargetPerCapita \* population \- postTaxMarketIncome)  
needGap \= max(0, transferNeedWeight \* essentialConsumptionCost \- liquidHouseholdCashBuffer)  
requestedTransfer \= min(maxTransferPerCapita \* population, max(incomeGap, needGap))

All requests for a State/currency are computed before settlement. If cash is insufficient:  
rationFactor \= min(1, availableForTransfers / max(totalRequested, epsilon))  
actualTransfer\_c \= requestedTransfer\_c \* rationFactor

Settlement is State treasury debit / cohort wallet credit. Allocation never depends directly on clan loyalty or political support. Phase-10 transfers affect market demand only next tick; they never reopen Phase 8\.

10\. Grants/subsidies — Phase 10

One generic explicit cash-transfer mechanism is enough. Allowed purposes: disaster recovery, settlement/startup support, and bounded strategic/public-good support. GrantIntent stores stateId, recipient ActorRef, currencyId, purpose, requested/maxAuthorizedAmount and optional originating event/settlement reference.

actualGrant \= min(requested, authorized envelope, remaining discretionary cash)

A grant changes cash only. It never directly changes output, productivity, capital, settlementLevel or health.

11\. State procurement — Phase 2 intents, Phase 4/8 clearing

Procurement uses the same MarketIntent and clearing as private actors. ProcurementEnvelope stores stateId, regionId, good/category, marketPhase PRE\_PRODUCTION or MAIN, maxSpend, desiredQuantity, purpose and optional projectId.

At planning:  
maxAffordableQty \= maxSpend / current buyer gross price estimate  
requestedQty \= min(desiredQuantity, maxAffordableQty)

State orders have no implicit priority. Unfilled quantity consumes no cash. Cleared goods enter State.publicInventory/project allocation and may be used in Phase 12 only after real ownership/delivery. Phase 10 never pays a procurement transaction that already settled in market clearing.

12\. Public infrastructure — Phase 12

InfrastructureRecipe stores category, requiredGoodsPerUnit, executionCapPerTick and depreciationRatePerTick.  
possibleBuild \= min\_g(projectInventory\[g\] / requiredGoodsPerUnit\[g\])  
actualBuild \= min(possibleBuild, executionCapPerTick)  
Consume required goods exactly once, then add actualBuild to authoritative infrastructure stock.  
capitalNext \= max(0, openingCapitalAfterPhase1EventDamage \+ newBuild \- depreciation)  
openingCapitalAfterPhase1EventDamage is the authoritative infrastructure stock after any Phase-1 event mutation. EventPhysicalLoss records are accounting/telemetry only and must never be subtracted again in Phase 12\.

Infrastructure affects only derived physical/economic coefficients such as TransportLink cost/capacity, ProductionUnit infrastructure factor and settlement capacity. It never creates free goods or cash.

13\. State-owned ProductionUnits

Canonical ownership is ownerRef \= State. State-owned units use the same recipes, labor, inputs, markets, capital and lifecycle as private units. State owner injection is an explicit treasury \-\> ProductionUnit cash transfer and creates no immediate capital/output. Unit dividends are explicit ProductionUnit \-\> State treasury transfers. Any profit-tax exemption is explicit config.

Owner injections execute in Phase 10 after mandatory flows and may fund Phase-12 investment only when the investment was already planned/reserved; otherwise they become next-tick working capital.

14\. Sovereign debt schema

StateBond fields: id, issuerStateId, currencyId (issuer home currency in core v1), principalIssued, principalOutstanding, couponRatePerTick, issueTick, maturityTick, status PLANNED|ACTIVE|MATURED|DEFAULTED|RESTRUCTURED.

BondHolding fields: id, bondId, holder ActorRef, principalShare.

This split is canonical. Do not store holderClanId directly on StateBond: one bond may have multiple Clan holdings and a MonetaryAuthority holding. No secondary trading in core v1; holdings change only through primary issuance, explicit MonetaryAuthority operations, repayment or restructuring.

15\. Debt issuance — review planning, Phase 1 execution

Debt issuance is financing, not revenue.  
fundingNeed \= max(0, minimumCashReserve \+ forecastMandatoryOutflows \- projectedTreasury)  
issuanceCap \= min(fundingNeed, fiscalRuleDebtHeadroom, configuredMaxIssuancePerReview)  
newCoupon \= clamp(referencePolicyRate \+ boundedFiscalRiskSpread, minCoupon, maxCoupon)

Eligible Clan budget \= max(0, clanTreasury \- clanLiquidityReserve \- alreadyCommittedCash) \* bondAllocationShareCap. Demand weight is a bounded deterministic function of coupon versus opportunity-return EMA and perceived fiscal risk. Allocate proportionally, cap by budgets, resolve floating residue by stable ID.

Review creates a planned financial operation for next tick. Phase 1 executes filled issuance:  
buyer wallet \-= paid principal  
State treasury \+= paid principal  
StateBond.principalOutstanding \+= paid principal  
BondHolding.principalShare \+= paid principal

Foreign purchase uses canonical settleFx and finite pairwise liquidity; partial FX fill proportionally reduces purchased principal and creates no receivable.

16\. Debt service/default — Phase 10

interestDue\_h \= holdingPrincipal \* couponRatePerTick  
principalDue\_h \= holdingPrincipal if maturityTick \<= currentTick else 0

Canonical Phase-10 State cash precedence:  
1\) already-atomic taxes/procurement are NOT re-settled  
2\) mandatory household transfers, subject to explicit rationing  
3\) sovereign interest and matured principal/refinancing result  
4\) discretionary grants/subsidies  
5\) State owner injections  
6\) new discretionary future commitments

Global Clan ordering remains: unit dividends \-\> State transfers/subsidies/debt service \-\> compute Clan available cash \-\> member distributions \-\> Clan owner injections. One shared commitment ledger prevents reuse of the same cash.

If debt service exceeds available cash after permitted planned/refinancing operations, State enters DISTRESS. Pay available debt-service cash pro rata across due holders with stable-ID residual allocation. Unpaid principal remains outstanding and bond becomes DEFAULTED unless deterministic restructuring runs. Optional write-down reduces holder asset and State liability by exactly the same principal amount. No silent rollover, overdraft or implicit money creation.

17\. Fiscal cash identities

Per State/currency/tick:  
currentRevenue \= collectedWageTax \+ collectedProfitTax \+ collectedConsumptionTax \+ collectedTariff \+ explicitFees  
currentExpense \= householdTransfers \+ grants \+ debtInterest  
nonFinancialPurchaseOutflow \= clearedProcurementCash  
financingCashFlow \= debtIssuanceProceeds \- principalRepayment  
ownerNetFlow \= StateOwnedUnitDividendsReceived \- StateOwnerInjections

closingTreasury \= openingTreasury \+ currentRevenue \- currentExpense \- nonFinancialPurchaseOutflow \+ financingCashFlow \+ ownerNetFlow

Every term reconciles to transaction records. Debt issuance is not revenue; principal repayment is not current expense; public capital formation is not a second cash outflow after goods procurement.  
18\. Budget planning and fiscal stress

Default budget review cadence is quarterly (3 monthly ticks), configurable. Reviews use prior-close values only.  
forecastRevenue \= EMA(realized revenue)  
minimumCashReserve \= reserveMonths \* EMA(mandatory monthly cash outflow)  
mandatoryForecast \= forecastTransfers \+ forecastDebtInterest \+ scheduledPrincipal  
normalDiscretionaryCapacity \= max(0, treasury \- minimumCashReserve \+ forecastRevenue \- mandatoryForecast)

For spending category k:  
desiredBudget\_k \= baselineShare\_k \* expectedResources \* clamp(1 \+ responseStrength \* pressure\_k, minBudgetFactor, maxBudgetFactor)

Allowed bounded pressures: transfer \<- unemployment/essential stress; infrastructure \<- infrastructure gap/transport congestion; reserves \<- shortage volatility; civilian/security \<- policy/event salience; State-unit injection \<- explicit service/return criteria. If desired budgets exceed resources, fund mandatory items first then scale discretionary envelopes by stable priority. Borrowing is separately constrained.

Fiscal rule:  
targetPrimaryBalance \= baseBalanceTarget \+ debtCorrection \* max(0, debtBurden \- comfortableDebtBurden) \- recessionEscapeAdjustment.  
Use annualized revenue and/or nominal transaction output as denominator; no fragile GDP dependency is required.

fiscalStressTarget \= weighted mean(reserve shortfall, interest/revenue burden, excess debt/revenue burden, 1-recent auction fill, mandatory funding gap)  
fiscalStressEma \= EMA(fiscalStressTarget)

Fiscal stress only changes decision parameters such as risk spread, debt correction, discretionary headroom and emergency-rule eligibility. It never directly reduces production, happiness, population or prices.

19\. Emergency fiscal rule

EmergencyFiscalRuleState stores activatedTick, expiryTick, triggerType, extraDebtHeadroom, discretionarySpendingMultiplierCap and correctionStrengthAfterExpiry. Activation requires an explicit event/economic threshold, duration/headroom are bounded and logged, expiry is automatic. The rule changes planning constraints only and creates no cash.

20\. Institutional/policy update

Clan influence is derived by CLANS using member population, assets/income and InstitutionalProfile weights. Fiscal/Laws only aggregates issue pressure.

politicalPressure\_j \= sum\_c(influence\_cs \* salience\_cj \* (preferredPosition\_cj \- currentPolicy\_j))  
stateResponse\_j \= bounded response to logically related prior-close signals  
proposedDelta\_j \= politicalWeight \* politicalPressure\_j \+ stateCapacityWeight \* stateResponse\_j  
actualDelta\_j \= clamp(proposedDelta\_j, \-maxStep\_j, \+maxStep\_j)  
policyNext\_j \= clampToRange(currentPolicy\_j \+ policyInertia \* actualDelta\_j)

Review runs only after the completed tick. Results are queued in PendingTransitions.policyChanges with activateTick \>= currentTick+1. They cannot alter already-settled current-tick transactions.

Mappings:  
\- hierarchy/egalitarianism \-\> redistribution/labor-rule pressure  
\- localism/expansionism \-\> trade/property/migration openness  
\- militarism/civilianism \-\> civilianSecurityPriority  
\- tradition/innovation \-\> reformOpenness  
A preference axis cannot directly modify unrelated productivity/tax parameters.

21\. Pure law-gate API

Expose side-effect-free functions using Phase-1 effective policy only:  
getLaborTaxPolicy(stateId)  
getBusinessTaxPolicy(stateId)  
getConsumptionTaxRate(stateId, goodCategory)  
getCollectionEfficiency(stateId)  
getTariffRate(originStateId|null, destinationStateId|null, goodCategory)  
canCrossBorderTrade(...)  
canOwnProperty(clanId, regionId)  
canMigrate(cohortId, originRegionId, destinationRegionId)  
canSettle(...)  
getMinimumWageFloor(stateId, laborCategory)  
isTransferEligible(cohortId, stateId)  
getProcurementEnvelopes(stateId, tick)

22\. Tick integration

Phase 1: apply due policy/jurisdiction transitions; execute previously planned sovereign/monetary financial operations; freeze effective law parameters for tick.  
Phase 2: create State procurement and fiscal planning intents; agents observe tax-inclusive prices and legal gates.  
Phase 3: labor allocation with minimum-wage/mobility gates.  
Phase 4: pre-production market clearing with any applicable transaction tax.  
Phase 5: atomic wage payment \+ wage-tax withholding; production.  
Phase 6: one market repricing step.  
Phase 7: trade/FX dispatch with tariff included and settled.  
Phase 8: main local clearing with consumption tax in affordability/settlement.  
Phase 9: consumption/spoilage and operating-result finalization.  
Phase 10: profit tax; transfers; debt service; dividends/grants/State-owner flows under shared commitment ordering. No earlier market/production reopening.  
Phase 11: monetary/FX reconciliation only.  
Phase 12: private/public capital formation from already-owned/reserved goods.  
Phase 13: demography/migration under current law.  
Phase 14: expansion/state/unit lifecycle decisions queued for future activation.  
Phase 15: fiscal EMAs, incidence, stress, diagnostics and explanation facts; then run accounting/invariant checks and, on review cadence, compute future budget, debt and policy plans before deterministic close.  
Phase-15 close is the final tick stage; there is no Phase-15 close.

23\. Clan fiscal-incidence interface

For clan c/state s over an EMA window:  
memberTaxes \= wage taxes paid by member cohorts  
ownedUnitTaxes \= profit taxes paid by clan-owned units  
memberTransfers \= transfers received by member cohorts  
clanOrUnitGrants \= grants received  
netFiscalTransfer \= memberTransfers \+ grants \- memberTaxes \- ownedUnitTaxes  
normalizedFiscalIncidence \= clamp(netFiscalTransfer / max(memberMarketIncome \+ ownedUnitCashFlowScale, floor), \-1, 1\)  
Only the bounded EMA feeds Clan loyalty. Shared infrastructure receives no invented private cash valuation.

24\. Determinism and complexity

All scarce multi-recipient allocations use proportional shares, caps/eligibility, deterministic residual redistribution and stable ActorRef/ID ordering. Ordinary fiscal settlement/policy aggregation requires no RNG.

Let S=states, P=cohorts, U=ProductionUnits, T=taxable market/trade transactions, H=BondHoldings, C\_s=material clans in state s.  
Per tick: wage tax/transfers O(P); profit tax O(U); consumption/tariff O(T) piggybacked on settlement; debt service O(H\_due); fiscal-incidence aggregation O(P+U); reconciliation O(S \+ aggregates).  
Review ticks: policy O(sum C\_s \* 6), procurement budgeting O(S \* bounded regions/categories), debt allocation O(eligible clans). Avoid all-pairs scans where indexed lists exist.

25\. Canonical invariants

F01 treasury never negative in no-overdraft mode.  
F02 each collected tax is equal payer debit and State credit.  
F03 uncollected assessed tax is not credited or stored as arrears in core v1.  
F04 gross wage debit \= cohort net wage credit \+ State wage-tax credit.  
F05 consumption-taxed buyer gross debit \= seller net credit \+ State tax credit.  
F06 tariff has explicit payer/recipient and enters affordability before dispatch.  
F07 wage/consumption/tariff settled earlier are never debited again in Phase 10\.  
F08 profit tax base is positive standardized operating profit, not revenue/dividend.  
F09 transfers/grants conserve cash.  
F10 unfilled procurement consumes no cash and creates no goods.  
F11 public infrastructure increases only by consuming recipe goods or initialization.  
F12 State owner injection changes cash only, not immediate capital/output.  
F13 State-owned units obey ordinary physical constraints.  
F14 StateBond principalOutstanding equals sum BondHolding principal shares within tolerance.  
F15 debt issuance is financing, never revenue.  
F16 principal repayment reduces matched asset/liability equally; interest does not change principal.  
F17 default/write-down creates no cash and reduces holder asset/issuer liability symmetrically.  
F18 every treasury cash unit can be committed to at most one Phase-10 outgoing flow.  
F19 every cross-currency fiscal/debt payment uses the same finite settleFx pool as trade.  
F20 FX liquidity is continuous across phases within a tick.  
F21 policy/jurisdiction changes affect laws only when activated from PendingTransitions at Phase 1\.  
F22 fiscal stress is diagnostic/decision input only.  
F23 treasury delta reconciles exactly to fiscal transaction records.  
F24 identical opening state/config/seed produces identical fiscal/policy sequence.

26\. Required tests

1 wage withholding conservation with allowance/progressivity/cap.  
2 collectionEfficiency leaves uncollected tax with payer.  
3 wage tax cannot be charged again in Phase 10\.  
4 profit tax zero on nonpositive standardized profit and correct on positive profit.  
5 dividend timing cannot reduce finalized profit-tax base.  
6 consumption tax reduces affordability and splits settlement exactly.  
7 State self-procurement tax exemption/netting preserves world cash.  
8 tariff enters landed cost before route choice.  
9 tariff jurisdiction uses effective pre-transition controller.  
10 recession lowers wage-tax revenue and raises transfer request under unchanged law.  
11 underfunded transfers ration deterministically without overdraft.  
12 Phase-10 transfer cannot fund Phase-8 same-tick demand.  
13 procurement receives only cleared quantity.  
14 infrastructure build consumes recipe goods exactly once; Phase-1 event damage is applied exactly once and is not subtracted again during Phase-12 capital formation; depreciation stays nonnegative.  
15 State owner injection conserves cash and does not mutate installedCapital immediately.  
16 identical State/private units with identical inputs produce identically.  
17 primary bond issuance conserves cash and creates matched debt/holdings.  
18 multiple holdings sum to bond principalOutstanding.  
19 MonetaryAuthority and Clan holdings coexist without schema conflict.  
20 foreign bond purchase competes for same finite FX pool as Phase-7 trade.  
21 partial bond auction creates only filled debt/cash.  
22 interest leaves principal unchanged.  
23 maturity repayment reduces matched asset/liability exactly.  
24 insufficient debt-service cash pays pro rata and never overdrafts.  
25 restructuring write-down is symmetric.  
26 budget review cannot change current tick.  
27 policy step obeys cadence/inertia/max-step bounds.  
28 Clan preference affects only mapped dimensions.  
29 queued jurisdiction change leaves current-tick fiscal regime unchanged and changes activated tick.  
30 mixed fiscal cash identity reconciles taxes \+ procurement \+ transfer \+ debt \+ owner flows.  
31 same state/config replays stable fiscal transaction ordering.  
32 full mixed-tick invariant test includes trade/FX/Clan cash and fiscal flows.

27\. Golden scenarios

A automatic recession stabilizer: lower employment/wages \-\> lower wage-tax receipts and higher transfers; demand contracts less than low-transfer comparator while fiscal stress rises through real cash flows.  
B infrastructure push: higher transport procurement competes for capital goods; only purchased goods converted in Phase 12 improve future transport coefficients.  
C debt-stress austerity: weak bond demand partially fills issuance; discretionary procurement/grants fall before protected transfers; no direct GDP penalty.  
D institutional divergence: identical clans/economy under broad vs asset-weighted franchise produce different policy pressure only through influence weights.  
E tariff divergence: high-tariff State earns revenue but raises landed import costs, allowing market shortages/local investment response to emerge.  
F welfare vs low-tax regime: redistribution settings alter disposable-income stability, treasury burden and demand composition without prosperity buff.  
G sovereign funding/FX shock: Phase-7 trade consumes FX liquidity; foreign Clan bond demand only partially settles, shrinking debt issuance and treasury proceeds exactly.  
H jurisdiction transition: Phase-14 decision settles current tick under old regime; activation tick applies new law before planning.

28\. Repository migration boundary

Add fiscal as an orthogonal domain package rather than State-specific branches in market/production.  
\- domain/fiscal: pure tax, budget, debt, policy and invariant functions  
\- shared settlement: generic ActorRef wallet transfer/tax split hooks  
\- market/trade: pure tax/tariff quoting then atomic settlement  
\- production/labor: wage withholding and standardized operating-result records  
\- expansion/population: pure law-gate reads  
\- UI: FiscalSnapshot/ExplanationFact read models only

Do not add a State-only market, State-only ProductionUnit class, fiscal-specific FX engine or second jurisdiction state.

29\. Acceptance criteria

Implementation-ready when schemas serialize canonically; all four taxes settle in defined phases without double debit; procurement uses existing market contracts; transfers/grants/debt service obey shared commitment accounting; StateBond/BondHolding supports multiple Clan/MonetaryAuthority holders; public infrastructure consumes real goods; six policy dimensions activate only through PendingTransitions; F01-F24 and tests 1-32 pass; eight golden scenarios show expected directional behavior and exact accounting; fiscal UI can explain opening cash, every revenue/expense/financing component, closing cash, tax incidence, debt obligations, policy pressure and effective legal gates from stored facts.

Conclusion

State is a normal stock-flow actor plus a slow rule-setting institution. It redistributes/spends existing money, buys scarce goods from ordinary markets, forms public capital from real goods, borrows only when another actor gives up cash or an explicit MonetaryAuthority operation creates/destroys money, and changes incentives prospectively through bounded policies. This preserves emergent fiscal divergence without introducing a second economic engine.

