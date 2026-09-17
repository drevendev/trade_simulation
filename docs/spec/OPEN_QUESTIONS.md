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

## Q-001 — REQ-CONFIG-006 — Which document owns the fourteen production/labor controls that section 37 names and section 6/7 does not value?

Status:   ANSWERED
Blocks:   none; HANDOFF-REPAIR-M4-002 resolves REQ-CONFIG-006 default ownership

Context:  Handoff/03 is the sole owner of `SimulationConfig` baseline numbers. The
          implementation originally declared the fourteen section-37 controls but left
          them undefined rather than inventing behavior-affecting values. Drive later
          resolved the gap in HANDOFF-REPAIR-M4-002 by adding exact section-6/7 values.

Answer:   2026-09-16 — Use Handoff/03 sections 6–7 as the canonical owner and land the
          following exact baseline values:

          ProductionConfig:
          - `investmentReviewCadenceTicks = 3`
          - `investmentUtilizationThreshold = 0.75`
          - `minimumInvestmentMargin = 0.05`
          - `investmentPropensity = 0.35`
          - `maxInvestmentShareOfExcessCash = 0.50`
          - `maxCapitalGrowthPerReview = 0.25`
          - `lifecycleReviewCadenceTicks = 3`
          - `mothballMarginThreshold = -0.10`
          - `mothballUtilizationThreshold = 0.25`
          - `reactivateMarginThreshold = 0.05`
          - `closingGraceReviews = 4`

          LaborConfig:
          - `maxLogWageStep = ln(1.05)`
          - `unitVacancyResponse = 0.02`
          - `maxTightnessSignal = 2.0`

          `maxLogWageStep` is the canonical control; do not revive the stale
          `maxWageMoveSharePerTick` alias. Labor quantities continue to use
          `SimulationConfig.numeric.quantityEpsilon`; do not introduce a separate
          `laborEpsilon`. This answer changes defaults only. Production/labor behavior
          remains owned by the later M4 production requirements.

---

## Q-002 — REQ-CONFIG-007 — Which document values the sixteen M4 population controls that section 33 names and section 8 of Handoff/03 states in a different vocabulary?

Status:   ANSWERED
Blocks:   none; HANDOFF-REPAIR-M4-003 resolves REQ-CONFIG-007 default ownership

Context:  Section 33 "Configuration surface" of
          `06 - Handoff/06 — POPULATION_DEMOGRAPHY_CLANS_CONTRACTS.md` names the control
          groups `PopulationConfig` must centralize; sections 4, 5, 6, 8, 9, 10 and 11 of
          the same document spell the individual M4 controls. Section 8 "Population
          defaults" of
          `06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md` states the
          baseline values, and `HANDOFF-REPAIR-005` / `HANDOFF-REPAIR-010` establish
          Handoff/03 as the sole owner of `SimulationConfig` baseline numbers.

          The two lists originally spoke different vocabularies. Before the Drive repair,
          sixteen of the twenty M4 controls were therefore deliberately left undefined
          rather than guessed. HANDOFF-REPAIR-M4-003 has now normalized the ownership and
          supplied the complete M4 baseline without pulling M8 demography/migration or
          later Clan/fiscal behavior forward.

Options:  1. Section 8 of Handoff/03 gains the missing values under the section 4/8/9/10/11
             spelling. Selected by HANDOFF-REPAIR-M4-003.
          2. Reconcile the M4 list down to the old partial baseline. Rejected because the
             required M4 household/labor/welfare formulas would lose required controls.
          3. Spread defaults across later requirements. Rejected because it would recreate
             duplicate default authority.

Answer:   2026-09-16 — HANDOFF-REPAIR-M4-003 makes Handoff/03 section 8 the canonical
          owner of the complete twenty-control M4 PopulationConfig baseline:

          - `minHouseholdCashPerCapita = 2.5`
          - `liquidityFloorShare = 0.10`
          - `baseParticipationByStratum = { VULNERABLE: 0.70, WORKING_MIDDLE: 0.70, AFFLUENT: 0.70 }`
          - `minParticipation = 0.40`
          - `maxParticipation = 0.90`
          - `minHealthParticipationFactor = 0.75`
          - `maxHealthParticipationFactor = 1.02`
          - `minWeakOpportunityFactor = 0.90`
          - `maxWeakOpportunityFactor = 1.05`
          - `wageSignalAdjustmentSpeed = 0.20`
          - `maxWageSignalStep = ln(1.05)`
          - `essentialAlpha = 0.25`
          - `incomeAlpha = 0.15`
          - `employmentAlpha = 0.20`
          - `prosperityAlpha = 0.15`
          - `scenarioRealIncomeScale = 10`
          - `healthRecoveryRate = 0.05`
          - `healthMaintenanceThreshold = 0.85`
          - `serviceHealthRate = 0.02`
          - `serviceBaseline = 0.50`

          `PopulationConfig.baseParticipationByStratum` is the sole active M4
          participation baseline and supersedes `LaborConfig.baselineParticipationRate`
          for M4 labor supply. Health participation bounds remain distinct from the
          LaborConfig health-productivity bounds. Worker-equivalent epsilon remains
          `SimulationConfig.numeric.quantityEpsilon`. The P_raw welfare weights remain
          fixed formula constants. Need-category price sensitivity remains definition-owned.
          Do not revive the superseded `consumptionBudgetShare*`,
          `precautionaryCashFloorMonths`, `needSubstitutionElasticity`, `healthEmaAlpha`,
          or `wageSignalAlpha` aliases as parallel runtime controls. This answer changes
          configuration ownership/defaults only; population behavior and M8 remain out of
          scope for REQ-CONFIG-007.
