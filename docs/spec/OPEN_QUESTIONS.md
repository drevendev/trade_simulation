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

Status:   OPEN
Blocks:   REQ-CONFIG-007 (landed PARTIAL), and the M4 rows that read these controls —
          REQ-POPULATION-001 (household demand), REQ-POPULATION-002 (labor supply),
          REQ-POPULATION-003 (welfare/health signals)

Context:  Section 33 "Configuration surface" of
          `06 - Handoff/06 — POPULATION_DEMOGRAPHY_CLANS_CONTRACTS.md` names the control
          groups `PopulationConfig` must centralize; sections 4, 5, 6, 8, 9, 10 and 11 of
          the same document spell the individual M4 controls. Section 8 "Population
          defaults" of
          `06 - Handoff/03 — CANONICAL_CONFIG_AND_WORLD_GENERATION.md` states the
          baseline values, and `HANDOFF-REPAIR-005` / `HANDOFF-REPAIR-010` establish
          Handoff/03 as the sole owner of `SimulationConfig` baseline numbers.

          The two lists speak different vocabularies. Section 8 of Handoff/03 is largely a
          demography baseline — births, deaths, aging, migration, mobility, cohort-merge
          tolerances — which REQ-CONFIG-007's own `STATEMENT` defers to M8 and which
          `EXECUTION_ORDER.md` puts there too. Of its non-demographic entries,
          `consumptionBudgetShareLower/Middle/Upper`, `precautionaryCashFloorMonths`,
          `needSubstitutionElasticity` and `healthEmaAlpha` have no counterpart among the
          controls sections 4-11 name, and sixteen of the twenty M4 controls have no value
          anywhere. The sixteen left undefaulted are:

          Liquidity floor (section 4) — `minHouseholdCashPerCapita`,
          `liquidityFloorShare`.

          Participation (section 8) — `baseParticipationByStratum`, `minParticipation`,
          `maxParticipation`, `minWeakOpportunityFactor`, `maxWeakOpportunityFactor`.

          Wage signal (section 9) — `maxWageSignalStep`.

          Welfare signals (section 10) — `essentialAlpha`, `incomeAlpha`,
          `employmentAlpha`, `scenarioRealIncomeScale`.

          Health stock (section 11) — `healthRecoveryRate`,
          `healthMaintenanceThreshold`, `serviceHealthRate`, `serviceBaseline`.

          Four controls were valued, and the reasoning for each is recorded so it can be
          overruled cheaply:

          - `minHealthParticipationFactor = 0.75`, `maxHealthParticipationFactor = 1.02`
            from section 8 of Handoff/06 itself, "Recommended healthParticipationFactor
            range [0.75,1.02]".
          - `wageSignalAdjustmentSpeed = 0.20` ← section 8 `wageSignalAlpha`.
          - `prosperityAlpha = 0.15` ← section 8 `prosperityEmaAlpha`.

          Three further divergences were not mapped because doing so would invent a
          semantic rather than resolve a spelling: `liquidityFloorShare` versus
          `precautionaryCashFloorMonths`; per-category `priceSensitivity_c` versus global
          `needSubstitutionElasticity`; and `healthEmaAlpha` versus the non-EMA health
          update.

Options:  1. Section 8 of Handoff/03 gains the missing values under the section 4/8/9/10/11
             spelling. REQ-CONFIG-007 then closes as IMPLEMENTED by adding defaults only.
          2. Section 33's M4 list is reconciled down to what section 8 already values,
             requiring downstream M4 population re-scope.
          3. Values are left for first readers, which would recreate duplicate default
             ownership and is not recommended.

          Two questions also require explicit ownership answers: whether
          `baseParticipationByStratum` supersedes `LaborConfig.baselineParticipationRate`,
          and whether the working-health productivity clamp is distinct from the
          participation health-factor bounds. `workerEpsilon` remains intentionally
          absent because `SimulationConfig.numeric.quantityEpsilon` owns quantity
          tolerance. The section-10 prosperity weights remain formula constants rather
          than scenario-tunable config unless the canonical specification says otherwise.

          Implemented in the meantime: all twenty M4 controls are declared and validated,
          four carry stated values, sixteen remain undefined, and deferred M8 controls
          remain absent.

Answer:   —
