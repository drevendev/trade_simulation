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
            range [0.75,1.02]". `HANDOFF-REPAIR-M4-002` promoted Handoff/05
            recommendations "where exact", which is the precedent applied here.
          - `wageSignalAdjustmentSpeed = 0.20` ← section 8 `wageSignalAlpha`. The section
            9 update `wageSignal × exp(speed × ln(target/wageSignal))` is a geometric EMA
            whose smoothing factor is that coefficient, and neither section declares a
            second wage-signal smoothing control, so the correspondence is forced.
          - `prosperityAlpha = 0.15` ← section 8 `prosperityEmaAlpha`. Spelling only; no
            other prosperity smoothing control exists in either document.

          Three further divergences were **not** mapped, because mapping them would invent
          a semantic rather than resolve a spelling — the `maxLogWageStep` precedent from
          Q-001:

          - Section 4 `liquidityFloorShare` (a share of opening home cash) versus section
            8 `precautionaryCashFloorMonths = 0.25` (a number of months). Different
            quantities, and section 4's floor is `max(perCapita × population, share ×
            cash)`, which needs both of its own parameters.
          - Section 5 `priceSensitivity_c` (per need category, and section 5 requires
            ESSENTIAL_FOOD to differ from COMFORT) versus section 8
            `needSubstitutionElasticity = 0.60` (one global). A single global value
            contradicts the per-category requirement in the same breath.
          - Section 8 `healthEmaAlpha = 0.20` has no counterpart: section 11's health
            update is not an EMA, and section 10's four alphas are all named.

          Tried: the reading order of `AUTHOR_RUNBOOK.md` section 4 — registry,
          `SPEC_CHANGELOG.md`, `EXECUTION_ORDER.md`, section 33 and the sections of
          Handoff/06 that state each control, then the one dependency document
          (Handoff/03). The mirror was not read recursively. No third document was opened.

Options:  1. Section 8 of Handoff/03 gains the missing values under the section 4/8/9/10/11
             spelling. REQ-CONFIG-007 then closes as IMPLEMENTED by adding defaults only,
             and no economic mechanism moves.
          2. Section 33's M4 list is reconciled down to what section 8 already values, and
             the unvalued controls are withdrawn as not-M4. Cheaper, but
             REQ-POPULATION-001..003 would have to be re-scoped, and section 4's liquidity
             floor and section 11's health stock have no formula left without them.
          3. The values are left for the requirement that first reads each control. This
             spreads default authority across four rows and reopens the duplicate-owner
             problem `HANDOFF-REPAIR-005` and `-010` were written to close. Not
             recommended.

          Two questions need an explicit answer whichever option is chosen:

          - **Does `baseParticipationByStratum` supersede `LaborConfig.baselineParticipationRate`?**
            Section 8 of Handoff/06 needs participation per stratum
            (`baseParticipation[stratum]`, strata VULNERABLE / WORKING_MIDDLE / AFFLUENT);
            section 7 of Handoff/03 states one scalar `baselineParticipationRate = 0.70 of
            WORKING population`, which #528 landed on `LaborConfig` from section 37 of
            Handoff/05 — a section that itself offered "or a Population-owned reference".
            One value under two owners is exactly what `HANDOFF-REPAIR-010` forbids. This
            run declared the stratum map and left it undefined rather than pick; nothing
            reads either control yet, so the choice is still free.
          - **Is `LaborConfig`'s working-health-factor clamp the same thing as section 8's
            `healthParticipationFactor` bound?** This run read them as distinct — section
            11 of Handoff/06 says health "may feed the already bounded Production
            `healthLaborProductivityFactor`", a productivity factor, while section 8's
            factor scales participation, and the two stated ranges differ ([0.5, 1.05]
            versus [0.75, 1.02]). If they are meant to be one control, the second pair
            should be withdrawn.

          Separately, section 9 `workerEpsilon` was deliberately **not** declared, on the
          Q-001 reading: workers are measured in worker-equivalents, a quantity, and
          `SimulationConfig.numeric.quantityEpsilon` already owns that tolerance. The
          section 10 `P_raw` weights (0.35 / 0.25 / 0.15 / 0.20 / 0.05) were read as
          formula constants rather than configuration, because section 33 does not list
          them among what `PopulationConfig` centralizes, they must sum to 1.0, and section
          33's "Scenario files may override values but may not introduce new bespoke
          formulas without schema version change" is what a scenario-tunable weight vector
          would defeat. If either reading is wrong, it needs saying here.

          Implemented in the meantime: every M4-subset control section 33 names is declared
          and validated, the four above carry their value, and the other sixteen are left
          `undefined` rather than guessed. A test asserts each of them is absent, so filling
          one in without answering this question fails the build. A second test asserts the
          deferred M8 demography/migration/mobility controls are absent, so pulling them
          forward fails the build too.

Answer:   —
